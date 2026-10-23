/**
 * 0427 — a paid payment application is reversed (2026-10-24, by direction:
 * "in payment application please even settled have to [be] reversed").
 *
 *   PAR1  Paid → reversed: the supplier payment it posted is reversed, the
 *         invoice owes again, the import is no longer fully paid, the bank
 *         holds the money again, and the application frees its instalment.
 *   PAR2  Debit final → reversed.
 *   PAR3  A deposit (supplier advance) is reversed while it pays nothing; once
 *         the invoice posts and the deposit is applied to it, the reversal is
 *         refused naming the invoice.
 *   PAR4  Refusals: no reason, an application not paid, no right to reverse.
 *   PAR5  The sheet's import in dollars, paid from a USD-only account: the
 *         exchange difference is undone, the payment's dollar line comes back
 *         in dollars, and the opening balance owes again.
 *   PAR6  A sheet application confirmed before the cut-over: reversed, the
 *         opening balance owes it again.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { ownerPool, rejection } from './setup';
import { linkItemToSupplier } from './item-supplier';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as coa from '@/server/services/chart-of-accounts';
import * as migration from '@/server/services/payables-migration';
import * as opening from '@/server/services/import-opening-balance';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
const SWIFT = 'PAR-SWIFT';
const iqd = (value: string) => parseDecimal(value, 4n);

async function fund(glAccountId: string, amount: string, on = '2026-09-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Owner deposit','draft',$5,$5,$6) returning id`,
      [`FUND-PAR-${randomUUID().slice(0, 8)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5), ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, glAccountId, amount, world.accounts.grni, BAGHDAD],
    );
    await client.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, world.manager.principal.userId]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

const reverse = (actor: ActorContext, id: string, reason: string) =>
  withScope(scope(actor), (tx) => applications.reverse(tx, actor, id, { reason }));
const application = async (id: string) =>
  (await ownerPool.query(`select status::text, reversed_by, reversed_at, reversal_reason, supplier_payment_id, supplier_advance_id from payment_application where id = $1`, [id])).rows[0];
const glBalance = async (accountId: string) =>
  (await ownerPool.query(`select coalesce(sum(debit_iqd - credit_iqd), 0)::text as net from journal_line l join journal_entry e on e.id = l.journal_entry_id where l.account_id = $1 and e.status in ('posted','reversed')`, [accountId])).rows[0].net as string;

describe('the trading world, in dinars', () => {
  async function importInvoice(reference: string) {
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: reference,
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-01',
        dueDate: '2026-11-01',
        isImport: true,
        lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: parseQuantity('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
      } as ap.CreateApInvoiceInput),
    );
    const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
    return { invoiceId: made.id, payableId: rows[0].payable_id as string };
  }
  const post = async (invoiceId: string) => {
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
  };
  let payeeId = '';

  /** Raised by the clerk, approved by the manager, sent by the clerk; paid by the manager unless `until` stops it. */
  async function pay(payableId: string, amount: string, reference: string, until: 'sent' | 'paid' = 'paid') {
    const made = await withScope(scope(world.clerk), (tx) =>
      applications.create(tx, world.clerk, { payableId, paymentMethodCode: SWIFT, bankCashAccountId: world.bankAccountId, payeeBankAccountId: payeeId, amountTxn: iqd(amount), onDate: '2026-09-10' }),
    );
    await withScope(scope(world.manager), async (tx) => {
      await applications.submit(tx, world.manager, made.id);
      return applications.approve(tx, world.manager, made.id);
    });
    await withScope(scope(world.clerk), (tx) => applications.send(tx, world.clerk, made.id, { applicationDate: '2026-09-10', bankReference: `B-${reference}` }));
    if (until === 'paid') {
      await withScope(scope(world.manager), (tx) => applications.confirm(tx, world.manager, made.id, { confirmedOn: '2026-09-12', reference }));
    }
    return made.id;
  }

  beforeEach(async () => {
    registerAllRecords();
    world = await buildTradingWorld();
    await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
    const { rows } = await ownerPool.query(
      `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active, is_default)
       values ($1,'Bank of China',$2,'BKCHCNBJ','IQD','approved',true,true) returning id`,
      [world.supplierId, `CN-${randomUUID().slice(0, 8)}`],
    );
    payeeId = rows[0].id as string;
    await fund(world.accounts.bank!, '9000000');
  });

  describe('PAR1 · paid → reversed', () => {
    it('the payment is reversed, the invoice owes again, the import is not paid, the bank holds the money again', async () => {
      const { invoiceId, payableId } = await importInvoice('PAR1-0001');
      await post(invoiceId);
      const bankBefore = await glBalance(world.accounts.bank!);
      const id = await pay(payableId, '1000000', 'MT103-PAR1');
      expect((await ownerPool.query(`select status::text, settled_amount_iqd from ap_invoice where id = $1`, [invoiceId])).rows[0]).toEqual({ status: 'settled', settled_amount_iqd: '1000000.0000' });
      expect((await withScope(scope(world.clerk), (tx) => applications.totalsFor(tx, payableId))).fullyPaid).toBe(true);
      const paymentId = (await application(id)).supplier_payment_id as string;

      // What the window says before anything moves.
      const seen = await withScope(scope(world.manager), async (tx) => applications.view(tx, (await applications.loadByNo(tx, (await ownerPool.query(`select application_no from payment_application where id = $1`, [id])).rows[0].application_no)).applicationNo));
      expect(seen.reversal).toMatchObject({ document: { kind: 'payment', status: 'posted' }, advanceAppliedTo: [], exchangeDifference: false, openingInvoiceNo: null });

      const done = await reverse(world.manager, id, 'The bank returned the transfer: wrong beneficiary account');
      expect(done.reversalEntryNo).toBeTruthy();

      expect(await application(id)).toMatchObject({ status: 'reversed', reversed_by: world.manager.principal.userId, reversal_reason: 'The bank returned the transfer: wrong beneficiary account' });
      expect((await ownerPool.query(`select status::text, allocated_amount_iqd from supplier_payment where id = $1`, [paymentId])).rows[0]).toEqual({ status: 'reversed', allocated_amount_iqd: '0.0000' });
      expect((await ownerPool.query(`select status::text, settled_amount_iqd from ap_invoice where id = $1`, [invoiceId])).rows[0]).toEqual({ status: 'posted', settled_amount_iqd: '0.0000' });
      const totals = await withScope(scope(world.clerk), (tx) => applications.totalsFor(tx, payableId));
      expect(totals.fullyPaid).toBe(false);
      expect(totals.paidTxn).toBe(0n);
      expect(await glBalance(world.accounts.bank!)).toBe(bankBefore);
      expect((await ownerPool.query(`select stage_code from payable where id = $1`, [payableId])).rows[0].stage_code).not.toBe('fully_paid');

      // The import's log and the audit trail say so.
      const { rows: log } = await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'PAYMENT_REVERSED'`, [payableId]);
      expect(log).toHaveLength(1);
      expect(log[0].summary).toMatch(/reversed — IQD 1,000,000\.00 is no longer paid: The bank returned/);
      const { rows: audit } = await ownerPool.query(`select before_value as before, after_value as after, reason from audit_event where action = 'payment_application.reversed' and object_id = $1`, [id]);
      expect(audit[0]).toMatchObject({ before: { status: 'confirmed' }, after: { status: 'reversed' }, reason: expect.stringMatching(/bank returned/) });

      // Final, and it frees the import: a new application can be raised and paid again.
      expect(await rejection(reverse(world.manager, id, 'again'))).toMatch(/only a paid application is reversed/);
      const again = await pay(payableId, '1000000', 'MT103-PAR1-B');
      expect((await application(again)).status).toBe('confirmed');
      expect((await withScope(scope(world.clerk), (tx) => applications.totalsFor(tx, payableId))).fullyPaid).toBe(true);
    });
  });

  describe('PAR2 · debit final → reversed', () => {
    it('a debited application is reversed the same way', async () => {
      const { invoiceId, payableId } = await importInvoice('PAR2-0001');
      await post(invoiceId);
      const id = await pay(payableId, '400000', 'MT103-PAR2');
      await withScope(scope(world.manager), (tx) => applications.recordDebit(tx, world.manager, id, { debitDate: '2026-09-14' }));
      expect((await application(id)).status).toBe('debited');
      await reverse(world.manager, id, 'Debited twice by the bank; the second debit refunded');
      expect((await application(id)).status).toBe('reversed');
      expect((await ownerPool.query(`select settled_amount_iqd from ap_invoice where id = $1`, [invoiceId])).rows[0].settled_amount_iqd).toBe('0.0000');
    });
  });

  describe('PAR3 · a deposit', () => {
    it('is reversed while it pays nothing; refused once it is applied to the invoice, naming it', async () => {
      // The invoice is a draft: confirming pays a deposit (a supplier advance) against the import's order.
      const first = await importInvoice('PAR3-0001');
      const depositApp = await pay(first.payableId, '300000', 'MT103-PAR3-A');
      const advanceId = (await application(depositApp)).supplier_advance_id as string;
      expect(advanceId).toBeTruthy();
      await reverse(world.manager, depositApp, 'Paid to the wrong supplier account');
      expect((await ownerPool.query(`select status::text, reversal_reason from supplier_advance where id = $1`, [advanceId])).rows[0]).toEqual({
        status: 'reversed',
        reversal_reason: expect.stringMatching(/Paid to the wrong supplier account/),
      });
      const { rows: mirrored } = await ownerPool.query(`select count(*)::int as n from journal_entry where reverses_id = (select journal_entry_id from supplier_advance where id = $1)`, [advanceId]);
      expect(mirrored[0].n).toBe(1);

      // Another deposit, then the invoice posts and the deposit is applied to it.
      const second = await pay(first.payableId, '300000', 'MT103-PAR3-B');
      await post(first.invoiceId);
      const invoiceNo = (await ownerPool.query(`select invoice_no from ap_invoice where id = $1`, [first.invoiceId])).rows[0].invoice_no as string;
      expect(await rejection(reverse(world.manager, second, 'too late'))).toMatch(new RegExp(`applied to ${invoiceNo}`));
      expect((await application(second)).status).toBe('confirmed');
    });
  });

  describe('PAR4 · refusals', () => {
    it('no reason, not paid, no right to reverse', async () => {
      const { invoiceId, payableId } = await importInvoice('PAR4-0001');
      await post(invoiceId);
      const sent = await pay(payableId, '100000', 'MT103-PAR4-A', 'sent');
      expect(await rejection(reverse(world.manager, sent, 'not paid'))).toMatch(/only a paid application is reversed/);

      const paid = await pay(payableId, '100000', 'MT103-PAR4-B');
      expect(await rejection(reverse(world.manager, paid, '   '))).toMatch(/Say why/);
      // The officer prepares and sends; reversing is the manager's.
      expect(await rejection(reverse(world.clerk, paid, 'mine'))).toMatch(/reverse_cancel|not permitted|permission/i);
      expect((await application(paid)).status).toBe('confirmed');
    });
  });
});

// ---------------------------------------------------------------------------
// The sheet's import in dollars (iob01's world)
// ---------------------------------------------------------------------------

describe('the sheet world, in dollars', () => {
  let mansourGl = '';
  let aik2 = '';
  const serial = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;

  async function workbook(): Promise<Buffer> {
    const rows = (data: unknown[][]) => data.map((row) => row.map((value) => (value === null ? null : { value })));
    const sheets = [
      {
        sheet: 'dashboard',
        data: rows([
          ['CHINA NATIONAL BUILDING MATERIAL GROUP FZE'],
          ['PO no./ INV.', 'INV. Date', 'Supplier', 'INV. Amount', 'INV. Qty', 'Pmt Terms', 'Products', 'PD. No.', 'Registration Date', 'Expire Date', 'PD. Status', 'Paid Amount (SWIFT)', 'Pmt Remaining', 'Applied Amount', 'BL No.', 'Inbounded Qty', 'Clear?'],
          [null],
          ['AIK-002', serial('2026-04-01'), 'AIKO ENERGY SINGAPORE PTE.LTD.', 50000, 500, 'TT 40% / 60%', 'battery', 1002, null, null, 'Totally written off', 20000, 30000, 50000, 'MEDUAIK00002', null, null],
        ]),
      },
      {
        sheet: 'PMT',
        data: rows([
          ['PO/INV. no.', 'Supplier', 'INV. Date', 'Bank', 'Application AMT.', 'Application date', 'Swift date', 'Payment Status'],
          [null],
          ['AIK-002', 'AIKO', null, 'MANSOUR', 20000, serial('2026-04-05'), serial('2026-04-08'), 'PAID'],
          ['AIK-002', 'AIKO', null, 'MANSOUR', 30000, serial('2026-05-01'), null, 'NOT PAID'],
        ]),
      },
      {
        sheet: 'PD',
        data: rows([
          ['PD SETTLEMENT'],
          ['Source: ASYCUDA Document List'],
          ['Total PD', 1],
          ['Totally written off', 1],
          ['PO no./ INV.', 'INV. Date', 'Supplier', 'PD No.', 'Registration Date', 'Expire Date', 'Status', 'Bank Code', 'SWIFT', 'Dashboard PD No.', 'Dashboard PD Status', 'Check', 'Notes'],
          ['AIK-002', null, null, 1002, serial('2026-04-02'), serial('2026-10-01'), 'Totally written off', 32, 'MBIVIQBAXXX', 1002, null, 'MATCH', null],
        ]),
      },
      { sheet: 'Pending', data: rows([[null], ['PD No.', 'Invoice / PO', 'Status', 'Notes']]) },
      {
        sheet: 'BL',
        data: rows([
          ['Po/INV. NO.', 'Supplier', 'INV. Date', 'PD. No.', 'PD. Status', 'BL No.', 'Product Category', 'POD', 'BL Total Qty', 'ETA', 'Shipping Status ', 'Inbounded Qty', 'PORT File Sent?', 'BL Date', 'CTN No.', 'Product Detail', 'Detail Qty Check'],
          [null],
          ['AIK-002', null, null, 1002, null, 'MEDUAIK00002', 'battery', 'AQABA', 500, serial('2026-10-20'), 'On the sea', null, null, serial('2026-09-01'), 'CAIU2345678', null, null],
        ]),
      },
      {
        sheet: 'BL Product Detail',
        data: rows([
          ['BL PRODUCT DETAIL'],
          ['One row = one BL × model × warehouse allocation.'],
          ['White = manual input'],
          ['BL No.', 'PO/INV No.', 'Supplier', 'PD No.', 'BL Date', 'CTN No.', 'Product Category', 'Brand', 'Model', 'Specification', 'Planned Inbound Qty', 'Unit', 'Warehouse', 'Inbound Date', 'SKU Inbound Qty'],
        ]),
      },
      {
        sheet: 'Pending Order',
        data: rows([
          ['PENDING ORDER / PRE-SALE'],
          ['For pre-sale management'],
          ['Pending SKU Lines', 0],
          ['PO/INV No.', 'Supplier', 'INV Date', 'Product Category', 'Brand', 'Model / SKU', 'Specification', 'Order Qty', 'Pre-sold Qty', 'Available Presale Qty', 'Expected Ship Date', 'Expected Arrival Date', 'Days to Arrival', 'Order Ship Progress', 'Presale Status', 'Remarks'],
        ]),
      },
      { sheet: 'Warehouse Master', data: rows([['Warehouse'], ['W01']]) },
    ];
    return (await writeXlsxFile(sheets as never).toBuffer()) as Buffer;
  }

  async function account(code: string, parent: string, name: string, restriction = 'IQD'): Promise<string> {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,$5) returning id`,
      [code, name, parents[0].account_type, parents[0].id, restriction],
    );
    await withScope(scope(world.manager), (tx) => coa.setRequiredDimensions(tx, world.manager, rows[0].id, []));
    return rows[0].id as string;
  }

  async function rule(event: string, role: string, accountId: string) {
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4) on conflict do nothing`,
      [event, role, accountId, world.manager.principal.userId],
    );
  }

  const openingRow = async () =>
    (await ownerPool.query(`select id, status::text, settled_amount_iqd from ap_invoice where payable_id = $1 and is_import_opening and reversed_at is null`, [aik2])).rows[0];
  const owed = async () =>
    (
      await ownerPool.query(
        `select coalesce(sum(credit_iqd - debit_iqd), 0)::text as iqd, coalesce(sum(credit_usd - debit_usd), 0)::text as usd
           from subledger_entry where subledger_type = 'supplier' and party_code = 'SUP-AIKO'`,
      )
    ).rows[0] as { iqd: string; usd: string };
  const sentApplication = async () =>
    (await ownerPool.query(`select id, application_no from payment_application where status = 'sent'`)).rows[0] as { id: string; application_no: string };

  beforeEach(async () => {
    registerAllRecords();
    world = await buildTradingWorld();
    await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
       values ('SUP-AIKO','Aiko Energy Singapore Pte. Ltd.',false,true,'active',true)`,
    );
    await linkItemToSupplier(PANEL, 'SUP-AIKO');
    // As on live: the bank's ledger account takes dollars only.
    mansourGl = await account('A980001', 'A000001', 'Mansour USD', 'USD');
    await ownerPool.query(
      `insert into bank_cash_account (code, name, account_type, currency, gl_account_id, bank_code, bank_name, account_number)
       values ('BNK-MAN-USD','Mansour USD','bank','USD',$1,'BNK-0001','Mansour Bank','MB-USD-1')`,
      [mansourGl],
    );
    await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ('PM-T001','SWIFT transfer','bank','swift')`);

    const goodsInTransit = await account('A980018', 'A000001', 'Goods in transit');
    await rule(opening.EVENT_TYPE, 'supplier_payable', world.accounts.supplier_payable!);
    await rule(opening.EVENT_TYPE, opening.OFFSET_ROLE, goodsInTransit);
    const gain = await account('R980001', 'R000001', 'Realised exchange gain');
    const loss = await account('X980001', 'X000001', 'Realised exchange loss');
    await rule('payables.exchange_difference', 'supplier_payable', world.accounts.supplier_payable!);
    await rule('payables.exchange_difference', 'supplier_advance', world.accounts.supplier_advance!);
    await rule('payables.exchange_difference', 'exchange_gain', gain);
    await rule('payables.exchange_difference', 'exchange_loss', loss);
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement) values ('payable_exchange_difference','business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
    );

    const content = await workbook();
    await withScope(scope(world.manager), (tx) => migration.dryRun(tx, world.manager, { fileName: 'QS_DASHBOARD.xlsx', content }));
    await withScope(scope(world.manager), (tx) => migration.apply(tx, world.manager, { fileName: 'QS_DASHBOARD.xlsx', content, runDate: '2026-10-13' }));
    await ownerPool.query(`update payable set created_at = '2026-10-13T06:00:00Z' where source = 'sheet_import'`);
    await ownerPool.query(
      `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by) values ('USD','accounting',1520,'2026-10-14',$1)`,
      [world.manager.principal.userId],
    );
    aik2 = (await ownerPool.query(`select id from payable where supplier_reference = 'AIK-002'`)).rows[0].id as string;
    await withScope(scope(world.manager), (tx) => opening.apply(tx, world.manager));
  });

  describe('PAR5 · paid in dollars from a USD-only account, the import fully paid', () => {
    it('the exchange difference is undone, the dollar line comes back in dollars, the opening owes again', async () => {
      const sent = await sentApplication();
      const rate = await withScope(scope(world.manager), async (tx) =>
        applications.paidRateFor(tx, await applications.loadByNo(tx, sent.application_no), '2026-10-15'),
      );
      await withScope(scope(world.manager), (tx) =>
        applications.addPaper(tx, world.manager, sent.id, {
          kind: 'paid',
          date: '2026-10-15',
          reference: 'MT103-AIK2',
          fileName: 'swift.pdf',
          content: Buffer.from('%PDF-1.4'),
          rateConfirmed: rate!.rateId,
        }),
      );
      expect(await openingRow()).toMatchObject({ status: 'settled', settled_amount_iqd: '39300000.0000' });
      expect((await ownerPool.query(`select count(*)::int as n from payable_exchange_difference where payable_id = $1`, [aik2])).rows[0].n).toBe(1);
      expect((await owed()).iqd).toBe('0.0000');

      await reverse(world.manager, sent.id, 'The SWIFT was recalled by the bank');

      // The difference undone, once, with its journal mirrored.
      const { rows: differences } = await ownerPool.query(`select reversed_at is not null as undone, reversal_journal_entry_id is not null as mirrored from payable_exchange_difference where payable_id = $1`, [aik2]);
      expect(differences).toEqual([{ undone: true, mirrored: true }]);
      // The payment's dollar line comes back in dollars, at the rate it left at.
      const { rows: back } = await ownerPool.query(
        `select l.currency::text as currency, l.debit_txn::text as debit_txn, l.debit_iqd::text as debit_iqd
           from supplier_payment p
           join journal_entry r on r.reverses_id = p.journal_entry_id
           join journal_line l on l.journal_entry_id = r.id and l.account_id = $1`,
        [mansourGl],
      );
      expect(back).toEqual([{ currency: 'USD', debit_txn: '30000.0000', debit_iqd: '45600000.0000' }]);
      // The supplier is owed what the opening said, in dinars and in dollars.
      expect(await openingRow()).toMatchObject({ status: 'posted', settled_amount_iqd: '0.0000' });
      expect(await owed()).toEqual({ iqd: '39300000.0000', usd: '30000.0000' });
      expect((await application(sent.id)).status).toBe('reversed');
      const { rows: log } = await ownerPool.query(`select event_code from payable_event where payable_id = $1 and event_code in ('EXCHANGE_DIFFERENCE_UNDONE','PAYMENT_REVERSED') order by recorded_at, id`, [aik2]);
      expect(log.map((row) => row.event_code)).toEqual(['EXCHANGE_DIFFERENCE_UNDONE', 'PAYMENT_REVERSED']);
      // The undone row is final.
      expect(await rejection(ownerPool.query(`update payable_exchange_difference set reversed_at = null where payable_id = $1`, [aik2]))).toMatch(/final/);
    });
  });

  describe('PAR6 · confirmed before the cut-over', () => {
    it('reversed: the opening balance owes it again, and nothing else was posted to take back', async () => {
      const sent = await sentApplication();
      await withScope(scope(world.manager), (tx) =>
        applications.confirmBeforeCutOver(tx, world.manager, sent.id, { confirmedOn: '2026-05-10', reference: 'MT103-AIK2' }),
      );
      expect(await openingRow()).toMatchObject({ status: 'settled', settled_amount_iqd: '39300000.0000' });
      expect(await owed()).toEqual({ iqd: '0.0000', usd: '0.0000' });

      await reverse(world.manager, sent.id, 'The bank copy belonged to another import');
      expect((await application(sent.id)).status).toBe('reversed');
      expect(await openingRow()).toMatchObject({ status: 'posted', settled_amount_iqd: '0.0000' });
      expect(await owed()).toEqual({ iqd: '39300000.0000', usd: '30000.0000' });
      const { rows: settled } = await ownerPool.query(`select reversed_at is not null as undone from import_opening_settlement where payment_application_id = $1`, [sent.id]);
      expect(settled).toEqual([{ undone: true }]);
      // A settlement not of a reversed application is still final.
      expect(await rejection(ownerPool.query(`delete from import_opening_settlement`))).toMatch(/final/);
    });
  });
});
