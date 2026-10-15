/**
 * 0422 — the imports brought in from the sheet, on the supplier's account
 * (2026-10-15, by direction: "post them to the ledger").
 *
 *   IOB1  The plan opens what each import still owes (agreed less paid) and
 *         nothing for one paid in full; it stops while the goods' side is not
 *         mapped. Applied: a posted purchase invoice marked as the import's
 *         opening, Cr the supplier / Dr the goods in transit, dated the day the
 *         import was brought in at that day's rate — on the ageing and on the
 *         statement in exact dollars. The import's own figures, stage and goods
 *         journey are untouched. Run again, nothing is opened twice.
 *   IOB2  A payment confirmed after the cut-over pays the opening (it used to
 *         be refused: no invoice, no purchase order); paid in full at a dearer
 *         dollar, the exchange difference closes the supplier to nought.
 *   IOB3  Money the bank's copy shows left before the cut-over comes off the
 *         opening, at its own rate, and posts no payment.
 *   IOB4  The supplier's own invoice, entered later, is absorbed: the supplier
 *         is owed what the opening says, not that plus the invoice. The opening
 *         cannot be reversed while the invoice rests on it; reversing the
 *         invoice undoes the absorption.
 *
 * The world is ap08's: the sheet's own workbook shape, applied through the
 * migration, so the imports are exactly what the live cut-over made.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { ownerPool, rejection } from './setup';
import { linkItemToSupplier } from './item-supplier';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as coa from '@/server/services/chart-of-accounts';
import * as applications from '@/server/services/payment-applications';
import * as journey from '@/server/services/import-goods-journey';
import * as migration from '@/server/services/payables-migration';
import * as opening from '@/server/services/import-opening-balance';
import * as openItems from '@/server/services/open-items';
import * as statement from '@/server/services/partner-statement';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let goodsInTransit = '';
let mansourGl = '';
let aik1 = '';
let aik2 = '';

const serial = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;

/** ap08's workbook: AIK-001 (100,000, paid in full) and AIK-002 (50,000; 20,000 paid, 30,000 at the bank). */
async function workbook(): Promise<Buffer> {
  const rows = (data: unknown[][]) => data.map((row) => row.map((value) => (value === null ? null : { value })));
  const sheets = [
    {
      sheet: 'dashboard',
      data: rows([
        ['CHINA NATIONAL BUILDING MATERIAL GROUP FZE'],
        ['PO no./ INV.', 'INV. Date', 'Supplier', 'INV. Amount', 'INV. Qty', 'Pmt Terms', 'Products', 'PD. No.', 'Registration Date', 'Expire Date', 'PD. Status', 'Paid Amount (SWIFT)', 'Pmt Remaining', 'Applied Amount', 'BL No.', 'Inbounded Qty', 'Clear?'],
        [null],
        ['AIK-001', serial('2026-03-01'), 'AIKO ENERGY SINGAPORE PTE.LTD.', 100000, 1000, 'CFR', 'panel', 1001, null, null, 'Totally written off', 100000, null, 100000, 'MEDUAIK00001', 1000, 'cleared'],
        ['AIK-002', serial('2026-04-01'), 'AIKO ENERGY SINGAPORE PTE.LTD.', 50000, 500, 'TT 40% / 60%', 'battery', 1002, null, null, 'Totally written off', 20000, 30000, 50000, 'MEDUAIK00002', null, null],
      ]),
    },
    {
      sheet: 'PMT',
      data: rows([
        ['PO/INV. no.', 'Supplier', 'INV. Date', 'Bank', 'Application AMT.', 'Application date', 'Swift date', 'Payment Status'],
        [null],
        ['AIK-001', 'AIKO', null, 'MANSOUR', 100000, serial('2026-03-05'), serial('2026-03-10'), 'PAID'],
        ['AIK-002', 'AIKO', null, 'MANSOUR', 20000, serial('2026-04-05'), serial('2026-04-08'), 'PAID'],
        ['AIK-002', 'AIKO', null, 'MANSOUR', 30000, serial('2026-05-01'), null, 'NOT PAID'],
      ]),
    },
    {
      sheet: 'PD',
      data: rows([
        ['PD SETTLEMENT'],
        ['Source: ASYCUDA Document List'],
        ['Total PD', 2],
        ['Totally written off', 2],
        ['PO no./ INV.', 'INV. Date', 'Supplier', 'PD No.', 'Registration Date', 'Expire Date', 'Status', 'Bank Code', 'SWIFT', 'Dashboard PD No.', 'Dashboard PD Status', 'Check', 'Notes'],
        ['AIK-001', null, null, 1001, serial('2026-03-02'), serial('2026-09-01'), 'Totally written off', 32, 'MBIVIQBAXXX', 1001, null, 'MATCH', null],
        ['AIK-002', null, null, 1002, serial('2026-04-02'), serial('2026-10-01'), 'Totally written off', 32, 'MBIVIQBAXXX', 1002, null, 'MATCH', null],
      ]),
    },
    { sheet: 'Pending', data: rows([[null], ['PD No.', 'Invoice / PO', 'Status', 'Notes']]) },
    {
      sheet: 'BL',
      data: rows([
        ['Po/INV. NO.', 'Supplier', 'INV. Date', 'PD. No.', 'PD. Status', 'BL No.', 'Product Category', 'POD', 'BL Total Qty', 'ETA', 'Shipping Status ', 'Inbounded Qty', 'PORT File Sent?', 'BL Date', 'CTN No.', 'Product Detail', 'Detail Qty Check'],
        [null],
        ['AIK-001', null, null, 1001, null, 'MEDUAIK00001', 'panel', 'UMM', 1000, serial('2026-05-01'), 'Inbounded', 1000, null, serial('2026-04-01'), 'MSCU1234565\nTGHU7654321', null, null],
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

async function account(code: string, parent: string, name: string): Promise<string> {
  const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
  const { rows } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
    [code, name, parents[0].account_type, parents[0].id],
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

async function fund(glAccountId: string, amount: string, on = '2026-09-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Owner deposit','draft',$5,$5,$6) returning id`,
      [`FUND-IOB-${randomUUID().slice(0, 8)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
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

const plan = () => withScope(scope(world.manager), (tx) => opening.plan(tx, world.manager));
const apply = () => withScope(scope(world.manager), (tx) => opening.apply(tx, world.manager));
const openingRow = async (payableId: string) =>
  (
    await ownerPool.query(
      `select id, invoice_no, status::text, total_iqd, settled_amount_iqd, agreed_currency, agreed_rate::text, invoice_date::text, is_import, is_import_opening
         from ap_invoice where payable_id = $1 and is_import_opening and reversed_at is null`,
      [payableId],
    )
  ).rows[0];
/** The supplier's sub-ledger, net credit: what the company owes, in dinars and in dollars. */
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
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ('SUP-AIKO','Aiko Energy Singapore Pte. Ltd.',false,true,'active',true)`,
  );
  await linkItemToSupplier(PANEL, 'SUP-AIKO');

  // A USD account at Mansour Bank, where the sheet's SWIFTs left from, with money in it.
  mansourGl = await account('A980001', 'A000001', 'Mansour USD');
  await ownerPool.query(
    `insert into bank_cash_account (code, name, account_type, currency, gl_account_id, bank_code, bank_name, account_number)
     values ('BNK-MAN-USD','Mansour USD','bank','USD',$1,'BNK-0001','Mansour Bank','MB-USD-1')`,
    [mansourGl],
  );
  await fund(mansourGl, '200000000');
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ('PM-T001','SWIFT transfer','bank','swift')`);

  // The opening's two lines, and the exchange difference's four, as Finance maps them.
  goodsInTransit = await account('A980018', 'A000001', 'Goods in transit');
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

  // The cut-over: the sheet applied, the imports brought in on 13 October at 1,310; the dollar dearer from the 14th.
  const content = await workbook();
  await withScope(scope(world.manager), (tx) => migration.dryRun(tx, world.manager, { fileName: 'QS_DASHBOARD.xlsx', content }));
  await withScope(scope(world.manager), (tx) => migration.apply(tx, world.manager, { fileName: 'QS_DASHBOARD.xlsx', content, runDate: '2026-10-13' }));
  await ownerPool.query(`update payable set created_at = '2026-10-13T06:00:00Z' where source = 'sheet_import'`);
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by) values ('USD','accounting',1520,'2026-10-14',$1)`,
    [world.manager.principal.userId],
  );
  aik1 = (await ownerPool.query(`select id from payable where supplier_reference = 'AIK-001'`)).rows[0].id as string;
  aik2 = (await ownerPool.query(`select id from payable where supplier_reference = 'AIK-002'`)).rows[0].id as string;
});

describe('IOB1 · the opening is what each import still owes', () => {
  it('plans, stops while unmapped, posts once, and leaves the import as it was', async () => {
    const before = (await ownerPool.query(`select amount_txn::text, amount_iqd::text, stage_code from payable where id = $1`, [aik2])).rows[0];

    // Unmapped goods side: the plan says so and nothing is written.
    await ownerPool.query(`update posting_rule set is_active = false where event_type = $1 and line_role = $2`, [opening.EVENT_TYPE, opening.OFFSET_ROLE]);
    const unmapped = await plan();
    expect(unmapped.stops.join(' ')).toMatch(/goods_in_transit/);
    expect(await rejection(apply())).toMatch(/Nothing was opened/);
    expect(await openingRow(aik2)).toBeUndefined();
    await ownerPool.query(`update posting_rule set is_active = true where event_type = $1 and line_role = $2`, [opening.EVENT_TYPE, opening.OFFSET_ROLE]);

    const planned = await plan();
    expect(planned.stops).toEqual([]);
    expect(planned.openings.map((line) => [line.payableNo.length > 0, line.reference, line.leftTxn, line.rate, line.leftIqd, line.openedOn])).toEqual([
      [true, 'AIK-002', '30000.0000', '1310.00000000', '39300000.0000', '2026-10-13'],
    ]);
    expect(planned.skipped).toEqual([expect.objectContaining({ supplierCode: 'SUP-AIKO', reason: 'paid' })]);
    expect(planned.totals).toEqual([{ currency: 'USD', count: 1, leftTxn: '30000.0000', leftIqd: '39300000.0000' }]);

    const { applied } = await apply();
    expect(applied).toHaveLength(1);
    expect(await openingRow(aik2)).toMatchObject({
      status: 'posted',
      total_iqd: '39300000.0000',
      settled_amount_iqd: '0.0000',
      agreed_currency: 'USD',
      agreed_rate: '1310.00000000',
      invoice_date: '2026-10-13',
      is_import: true,
      is_import_opening: true,
    });
    expect(await openingRow(aik1)).toBeUndefined();

    // Cr the supplier, Dr the goods: on the supplier's account in exact dollars.
    expect(await owed()).toEqual({ iqd: '39300000.0000', usd: '30000.0000' });
    const { rows: goods } = await ownerPool.query(`select coalesce(sum(debit_iqd - credit_iqd), 0)::text as net from journal_line where account_id = $1`, [goodsInTransit]);
    expect(goods[0].net).toBe('39300000.0000');

    // The ageing lists it as owed; the statement's closing balance is it.
    const items = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-10-15', { partyCode: 'SUP-AIKO', outstandingOnly: true }),
    );
    expect(items.map((item) => [item.invoiceNo, item.outstandingIqd])).toEqual([[applied[0]!.invoiceNo, '39300000.0000']]);
    const usd = await withScope(scope(world.manager), (tx) => statement.statementFor(tx, 'supplier', 'SUP-AIKO', { to: '2026-12-31', currency: 'USD' }));
    expect(parseDecimal(usd.closing, 4n) === parseDecimal('30000', 4n) || parseDecimal(usd.closing, 4n) === parseDecimal('-30000', 4n)).toBe(true);
    expect(usd.lines.map((line) => line.document?.number)).toContain(applied[0]!.invoiceNo);

    // The import is as it was: its figures, its stage, its goods journey.
    expect((await ownerPool.query(`select amount_txn::text, amount_iqd::text, stage_code from payable where id = $1`, [aik2])).rows[0]).toEqual(before);
    const facts = await withScope(scope(world.manager), (tx) => journey.factsFor(tx, world.manager.principal, aik2));
    expect(facts.legacy).not.toBeNull();
    const { rows: log } = await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'OPENING_BALANCE'`, [aik2]);
    expect(log[0].summary).toMatch(/USD 30000\.0000 owed to SUP-AIKO/);

    // Once.
    const again = await apply();
    expect(again.applied).toEqual([]);
    expect(again.plan.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'opened', documentNo: applied[0]!.invoiceNo })]));
    expect((await ownerPool.query(`select count(*)::int as n from ap_invoice where is_import_opening`)).rows[0].n).toBe(1);
  });
});

describe('IOB2 · a payment confirmed after the cut-over pays the opening', () => {
  it('posts a supplier payment against it; paid in full at 1,520 the exchange difference closes the supplier', async () => {
    await apply();
    const sent = await sentApplication();
    const done = await withScope(scope(world.manager), (tx) =>
      applications.confirm(tx, world.manager, sent.id, { confirmedOn: '2026-10-15', reference: 'MT103-AIK2' }),
    );
    expect(done.supplierPaymentId).toBeTruthy();
    expect(done.supplierAdvanceId).toBeNull();
    // 30,000 at 1,520 = 45,600,000; the opening owed 39,300,000 — 6,300,000 over, a loss.
    expect(await openingRow(aik2)).toMatchObject({ status: 'settled', settled_amount_iqd: '39300000.0000' });
    const { rows: differences } = await ownerPool.query(`select kind, amount_iqd from payable_exchange_difference where payable_id = $1`, [aik2]);
    expect(differences).toEqual([{ kind: 'loss', amount_iqd: '6300000.0000' }]);
    expect((await owed()).iqd).toBe('0.0000');
  });
});

describe('IOB3 · money that left before the cut-over comes off the opening', () => {
  it('confirmed from the bank’s copy: a settlement at the opening’s own rate, no payment posted', async () => {
    await apply();
    const sent = await sentApplication();
    await withScope(scope(world.manager), (tx) =>
      applications.confirmBeforeCutOver(tx, world.manager, sent.id, { confirmedOn: '2026-05-10', reference: 'MT103-AIK2' }),
    );
    const row = await openingRow(aik2);
    expect(row).toMatchObject({ status: 'settled', settled_amount_iqd: '39300000.0000' });
    const { rows: settled } = await ownerPool.query(
      `select kind, amount_txn::text, amount_iqd::text from import_opening_settlement where ap_invoice_id = $1`,
      [row.id],
    );
    expect(settled).toEqual([{ kind: 'paid_before_cut_over', amount_txn: '30000.0000', amount_iqd: '39300000.0000' }]);
    expect(await owed()).toEqual({ iqd: '0.0000', usd: '0.0000' });
    expect((await ownerPool.query(`select supplier_payment_id from payment_application where id = $1`, [sent.id])).rows[0].supplier_payment_id).toBeNull();
    // A settlement is final.
    expect(await rejection(ownerPool.query(`delete from import_opening_settlement`))).toMatch(/final/);
  });
});

describe('IOB4 · the supplier’s own invoice is absorbed by the opening', () => {
  it('owed once; the opening is held by it; reversing the invoice undoes the absorption', async () => {
    const { applied } = await apply();
    const openingNo = applied[0]!.invoiceNo;
    const aiko = (await ownerPool.query(`select id from business_partner where code = 'SUP-AIKO'`)).rows[0].id as string;
    // 500 panels at 131,000 IQD = 65,500,000 IQD = USD 50,000 at the agreed 1,310 — the whole import.
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: aiko,
        supplierInvoiceNo: 'AIK-002-INV',
        branchCode: BAGHDAD,
        invoiceDate: '2026-10-15',
        dueDate: '2026-10-31',
        isImport: true,
        payableId: aik2,
        agreedCurrency: 'USD',
        agreedRate: '1310',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: parseQuantity('500'),
            unitPriceIqd: parseDecimal('131000', 4n),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));

    const real = async () =>
      (await ownerPool.query(`select status::text, total_iqd, settled_amount_iqd from ap_invoice where id = $1`, [made.id])).rows[0];
    expect(await real()).toMatchObject({ status: 'settled', total_iqd: '65500000.0000', settled_amount_iqd: '65500000.0000' });
    // The supplier is owed what the opening says — not that and the invoice too.
    expect((await owed()).iqd).toBe('39300000.0000');
    const items = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-10-15', { partyCode: 'SUP-AIKO', outstandingOnly: true }),
    );
    expect(items.map((item) => item.invoiceNo)).toEqual([openingNo]);

    // The opening is not reversed from under the invoice.
    const openingId = (await openingRow(aik2)).id as string;
    expect(await rejection(withScope(scope(world.manager), (tx) => ap.reverse(tx, world.manager, openingId, { reason: 'wrong' })))).toMatch(
      /settled against this opening balance/,
    );

    // Reversing the invoice undoes the absorption first, then reverses as any invoice.
    await withScope(scope(world.manager), (tx) => ap.reverse(tx, world.manager, made.id, { reason: 'entered against the wrong import' }));
    expect(await real()).toMatchObject({ status: 'reversed', settled_amount_iqd: '0.0000' });
    expect((await owed()).iqd).toBe('39300000.0000');
    const { rows: absorption } = await ownerPool.query(
      `select reversed_at is not null as undone from import_opening_settlement where absorbed_invoice_id = $1`,
      [made.id],
    );
    expect(absorption).toEqual([{ undone: true }]);
    const { rows: log } = await ownerPool.query(
      `select event_code from payable_event where payable_id = $1 and event_code like 'OPENING_%' order by recorded_at, id`,
      [aik2],
    );
    expect(log.map((row) => row.event_code)).toEqual(['OPENING_BALANCE', 'OPENING_ABSORBED', 'OPENING_ABSORPTION_UNDONE']);
  });
});
