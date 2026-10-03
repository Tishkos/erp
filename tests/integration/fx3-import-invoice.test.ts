/**
 * REQ-FIX-001 FIX-3 — the import and its invoices agree (the sponsor:
 * "invoice status tracking actually works with import allocation — does it
 * track it as is?").
 *
 *   FX6  deposit → invoice → balance: the deposit is applied to the invoice
 *        when it posts; the invoice ends settled, the advance consumed, the
 *        import fully paid, and the supplier's account holds nothing open.
 *   FX7  two invoices on one import, one discounted: the import's agreed
 *        amount is their sum, so the cap and *Fully paid* follow both.
 *   FX8  an import agreed in dollars, invoiced in dinars, paid at two rates:
 *        fully paid in dollars, the dinar residual is the exchange
 *        difference — a loss when paid over, a gain when paid under; the
 *        invoice settled; nothing left unallocated.
 *   FX9  Invoice Status Tracking does not list an import, nor moves one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as customs from '@/server/services/customs-pd';
import * as banks from '@/server/services/bank-cash-accounts';
import * as coa from '@/server/services/chart-of-accounts';
import * as shipments from '@/server/services/supplier-shipment';
import * as expenses from '@/server/services/expenses';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let serial = 0;
const SWIFT = 'FX-SWIFT';
const iqd = (value: string) => parseDecimal(value, 4n);

async function fund(glAccountId: string, amount: string, on = '2026-09-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Owner deposit','draft',$5,$5,$6) returning id`,
      [`FUND-FX3-${(serial += 1)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
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

async function importInvoice(reference: string, unitPrice: string, extra: Partial<ap.CreateApInvoiceInput> = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: parseQuantity('100'), unitPriceIqd: iqd(unitPrice), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
      ...extra,
    } as ap.CreateApInvoiceInput),
  );
  const { rows } = await ownerPool.query(`select p.id from payable p join ap_invoice i on i.payable_id = p.id where i.id = $1`, [made.id]);
  return { invoiceId: made.id, payableId: rows[0].id as string };
}

const post = async (invoiceId: string) => {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
};

async function validatePd(payableId: string, pdNo: string) {
  const pd = await withScope(scope(world.clerk), (tx) => customs.register(tx, world.clerk, { payableId, pdNo, registrationDate: '2026-09-02', expiryDate: '2027-03-01' }));
  await withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pd.id, { statusCode: 'validated', effectiveDate: '2026-09-05' }));
}

async function pay(payableId: string, input: { amountTxn: string; on: string; bankAccountId?: string; payeeId: string; reference: string; instalmentId?: string; overrideReason?: string }) {
  const made = await withScope(scope(world.clerk), (tx) =>
    applications.create(tx, world.clerk, {
      payableId,
      paymentMethodCode: SWIFT,
      bankCashAccountId: input.bankAccountId ?? world.bankAccountId,
      payeeBankAccountId: input.payeeId,
      amountTxn: input.instalmentId ? null : iqd(input.amountTxn),
      onDate: input.on,
      ...(input.instalmentId ? { instalmentId: input.instalmentId } : {}),
    }),
  );
  await withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, made.id));
  // A manager may send ahead of a missing document with a reason (A11).
  const sender = input.overrideReason ? world.manager : world.clerk;
  await withScope(scope(sender), (tx) => applications.send(tx, sender, made.id, { applicationDate: input.on, bankReference: `B-${input.reference}`, overrideReason: input.overrideReason ?? null }));
  return withScope(scope(world.manager), (tx) => applications.confirm(tx, world.manager, made.id, { confirmedOn: input.on, reference: input.reference }));
}

const invoice = async (id: string) => (await ownerPool.query(`select status::text, total_iqd, settled_amount_iqd from ap_invoice where id = $1`, [id])).rows[0];
const payableRow = async (id: string) => (await ownerPool.query(`select amount_txn, amount_iqd, currency from payable where id = $1`, [id])).rows[0];

async function payee(currency: string) {
  const { rows } = await ownerPool.query(
    `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active)
     values ($1,'Bank of China',$2,'BKCHCNBJ',$3,'approved',true) returning id`,
    [world.supplierId, `CN-${randomUUID().slice(0, 8)}`, currency],
  );
  return rows[0].id as string;
}

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
  await fund(world.accounts.bank!, '9000000');
});

describe('FX6 · a deposit is applied to the invoice it was paid ahead of', () => {
  it('deposit → invoice → balance: the invoice settles, the advance is consumed, nothing is left open', async () => {
    const { invoiceId, payableId } = await importInvoice('FX6-0001', '10000');
    await validatePd(payableId, 'FX6-PD');
    const payeeId = await payee('IQD');
    await withScope(scope(world.clerk), (tx) =>
      applications.planInstalments(tx, world.clerk, {
        payableId,
        rows: [
          { label: 'Deposit', basis: 'percent', percent: '30', triggerCode: 'on_order' },
          { label: 'Balance', basis: 'percent', percent: '70', triggerCode: 'against_bl_copy' },
        ],
      }),
    );
    const plan = await withScope(scope(world.clerk), (tx) => applications.instalmentsFor(tx, payableId));

    const deposit = await pay(payableId, { amountTxn: '0', on: '2026-09-10', payeeId, reference: 'MT-DEP', instalmentId: plan[0]!.id });
    expect(deposit.supplierAdvanceId).toBeTruthy();

    // The invoice posts: the 300,000 deposit is applied to it at once.
    await post(invoiceId);
    expect(await invoice(invoiceId)).toMatchObject({ status: 'partially_executed', settled_amount_iqd: '300000.0000' });
    const { rows: advance } = await ownerPool.query(`select status::text, settled_amount_iqd from supplier_advance where id = $1`, [deposit.supplierAdvanceId]);
    expect(advance[0]).toMatchObject({ status: 'settled', settled_amount_iqd: '300000.0000' });
    const { rows: settlement } = await ownerPool.query(`select automatic::text, amount_iqd, journal_entry_id from supplier_advance_settlement where supplier_advance_id = $1`, [
      deposit.supplierAdvanceId,
    ]);
    expect(settlement[0]).toMatchObject({ automatic: 'automatic', amount_iqd: '300000.0000' });
    expect(settlement[0].journal_entry_id).toBeTruthy();

    // Part paid on the register, not "Unpaid".
    expect(expenses.paymentState({ status: 'partially_executed', dueDate: '2026-11-01', totalIqd: '1000000.0000', settledAmountIqd: '300000.0000' }, '2026-09-20')).toBe('part_paid');

    await pay(payableId, { amountTxn: '0', on: '2026-09-20', payeeId, reference: 'MT-BAL', instalmentId: plan[1]!.id, overrideReason: 'B/L copy received by e-mail; the original follows' });
    expect(await invoice(invoiceId)).toMatchObject({ status: 'settled', settled_amount_iqd: '1000000.0000' });
    const totals = await withScope(scope(world.clerk), (tx) => applications.totalsFor(tx, payableId));
    expect(totals.fullyPaid).toBe(true);
    // The supplier's account: no open invoice, no unapplied advance, no unallocated payment.
    const { rows: open } = await ownerPool.query(
      `select (select coalesce(sum(total_iqd - settled_amount_iqd), 0) from ap_invoice where payable_id = $1) as owed,
              (select coalesce(sum(amount_iqd - settled_amount_iqd - refunded_amount_iqd), 0) from supplier_advance where payable_id = $1) as unapplied,
              (select coalesce(sum(p.amount_iqd - p.allocated_amount_iqd), 0) from supplier_payment p join payment_application a on a.supplier_payment_id = p.id where a.payable_id = $1) as unallocated`,
      [payableId],
    );
    expect(open[0]).toEqual({ owed: '0.0000', unapplied: '0.0000', unallocated: '0.0000' });
  });
});

describe('FX7 · the import is agreed at its invoices', () => {
  it('two invoices, one discounted: the agreed amount is their sum, and the second can be paid', async () => {
    const first = await importInvoice('FX7-0001', '10000');
    await post(first.invoiceId);
    expect(await payableRow(first.payableId)).toMatchObject({ amount_txn: '1000000.0000', amount_iqd: '1000000.0000' });

    const second = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'FX7-0001-B',
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-03',
        dueDate: '2026-11-03',
        isImport: true,
        payableId: first.payableId,
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: parseQuantity('10'),
            unitPriceIqd: iqd('10000'),
            discountIqd: iqd('5000'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      } as ap.CreateApInvoiceInput),
    );
    await post(second.id);
    const { rows: totals } = await ownerPool.query(`select sum(total_iqd)::text as total from ap_invoice where payable_id = $1`, [first.payableId]);
    expect(await payableRow(first.payableId)).toMatchObject({ amount_txn: totals[0].total, amount_iqd: totals[0].total });
    expect(totals[0].total).toBe('1095000.0000');

    // Paying the whole of it is accepted; a dinar over is not.
    await validatePd(first.payableId, 'FX7-PD');
    const payeeId = await payee('IQD');
    await pay(first.payableId, { amountTxn: '1095000', on: '2026-09-12', payeeId, reference: 'MT-FX7' });
    expect(await invoice(second.id)).toMatchObject({ status: 'settled' });
    const over = await rejection(
      withScope(scope(world.clerk), (tx) =>
        applications.create(tx, world.clerk, {
          payableId: first.payableId,
          paymentMethodCode: SWIFT,
          bankCashAccountId: world.bankAccountId,
          payeeBankAccountId: payeeId,
          amountTxn: iqd('1'),
          onDate: '2026-09-13',
        }),
      ),
    );
    expect(over).toBeTruthy();
  });
});

describe('FX8 · an import agreed in dollars closes on its exchange difference', () => {
  let usdBankId = '';
  let usdPayee = '';
  let gainId = '';
  let lossId = '';

  beforeEach(async () => {
    // The gain and the loss are Finance's to map; mapped here.
    for (const [role, parent, name] of [
      ['exchange_gain', 'R000001', 'Realised exchange gain'],
      ['exchange_loss', 'X000001', 'Realised exchange loss'],
    ] as const) {
      const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
      const { rows } = await ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
         values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
        [`${parent.slice(0, 1)}8${role === 'exchange_gain' ? '00001' : '00002'}`, name, parents[0].account_type, parents[0].id],
      );
      // As the trading fixture does for its own accounts: no department asked of them here.
      await withScope(scope(world.manager), (tx) => coa.setRequiredDimensions(tx, world.manager, rows[0].id, []));
      if (role === 'exchange_gain') gainId = rows[0].id;
      else lossId = rows[0].id;
      await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ('payables.exchange_difference',$1,$2,true,$3)`, [
        role,
        rows[0].id,
        world.manager.principal.userId,
      ]);
    }
    for (const role of ['supplier_payable', 'supplier_advance']) {
      await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ('payables.exchange_difference',$1,$2,true,$3)`, [
        role,
        world.accounts[role],
        world.manager.principal.userId,
      ]);
    }
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement) values ('payable_exchange_difference','business_line','optional') on conflict (document_type_code, dimension) do update set requirement='optional'`,
    );
    const { rows: asset } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
    const { rows: gl } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ('A800003','Bank — USD account','asset',$1,false,true,'approved',1,'IQD') returning id`,
      [asset[0].id],
    );
    const usd = await withScope(scope(world.manager), (tx) =>
      banks.create(tx, world.manager, 'bank', { name: 'USD account', glAccountId: gl[0].id, currency: 'USD', bankName: 'Rafidain', accountNumber: 'USD-0001' }),
    );
    await fund(gl[0].id, '9000000');
    usdBankId = usd.id;
    usdPayee = await payee('USD');
    // The dollar's rate moves between the two payments.
    for (const [rate, from] of [['1320.00000000', '2026-09-20']] as const) {
      await ownerPool.query(`insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by) values ('USD','accounting',$1,$2,$3)`, [
        rate,
        from,
        world.manager.principal.userId,
      ]);
    }
  });

  async function dollarImport(reference: string) {
    // 100 panels at 13,100 IQD = 1,310,000 IQD, agreed as USD 1,000 (the sheet's own currency).
    const made = await importInvoice(reference, '13100');
    await ownerPool.query(`update payable set currency = 'USD', amount_txn = 1000 where id = $1`, [made.payableId]);
    await post(made.invoiceId);
    await validatePd(made.payableId, `${reference}-PD`);
    return made;
  }

  const differences = async (payableId: string) =>
    (await ownerPool.query(`select kind, source_type, amount_iqd from payable_exchange_difference where payable_id = $1 order by kind, source_type`, [payableId])).rows;
  const balanceOf = async (accountId: string) =>
    (await ownerPool.query(`select coalesce(sum(debit_iqd - credit_iqd), 0)::text as balance from journal_line where account_id = $1`, [accountId])).rows[0].balance;

  it('paid over the invoice at the second rate: a loss, the payment fully allocated', async () => {
    const made = await dollarImport('FX8-LOSS');
    await pay(made.payableId, { amountTxn: '400', on: '2026-09-14', bankAccountId: usdBankId, payeeId: usdPayee, reference: 'MT-L1' });
    expect(await invoice(made.invoiceId)).toMatchObject({ status: 'partially_executed', settled_amount_iqd: '524000.0000' });
    // 600 at 1,320 = 792,000; the invoice owes 786,000 — 6,000 over.
    await pay(made.payableId, { amountTxn: '600', on: '2026-09-25', bankAccountId: usdBankId, payeeId: usdPayee, reference: 'MT-L2' });
    expect(await invoice(made.invoiceId)).toMatchObject({ status: 'settled', settled_amount_iqd: '1310000.0000' });
    expect(await differences(made.payableId)).toEqual([{ kind: 'loss', source_type: 'supplier_payment', amount_iqd: '6000.0000' }]);
    expect(await balanceOf(lossId)).toBe('6000.0000');
    const { rows } = await ownerPool.query(
      `select coalesce(sum(p.amount_iqd - p.allocated_amount_iqd), 0) as unallocated from supplier_payment p join payment_application a on a.supplier_payment_id = p.id where a.payable_id = $1`,
      [made.payableId],
    );
    expect(rows[0].unallocated).toBe('0.0000');
    const { rows: events } = await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'EXCHANGE_DIFFERENCE'`, [made.payableId]);
    expect(events[0].summary).toMatch(/loss 6000\.0000 IQD/);
  });

  it('paid under the invoice at a lower rate: a gain, the invoice closed', async () => {
    // The dollar falls instead: a later rate supersedes the rise (rates are never edited).
    await ownerPool.query(`insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by) values ('USD','accounting',1300,'2026-09-22',$1)`, [
      world.manager.principal.userId,
    ]);
    const made = await dollarImport('FX8-GAIN');
    await pay(made.payableId, { amountTxn: '400', on: '2026-09-14', bankAccountId: usdBankId, payeeId: usdPayee, reference: 'MT-G1' });
    // 600 at 1,300 = 780,000; the invoice owes 786,000 — 6,000 under.
    await pay(made.payableId, { amountTxn: '600', on: '2026-09-25', bankAccountId: usdBankId, payeeId: usdPayee, reference: 'MT-G2' });
    expect(await invoice(made.invoiceId)).toMatchObject({ status: 'settled', settled_amount_iqd: '1310000.0000' });
    expect(await differences(made.payableId)).toEqual([{ kind: 'gain', source_type: 'ap_invoice', amount_iqd: '6000.0000' }]);
    expect(await balanceOf(gainId)).toBe('-6000.0000');
  });

  it('unmapped, the payment still confirms and the difference waits; mapped, it is booked from the import', async () => {
    await ownerPool.query(`update posting_rule set is_active = false where event_type = 'payables.exchange_difference' and line_role = 'exchange_loss'`);
    const made = await dollarImport('FX8-WAIT');
    await pay(made.payableId, { amountTxn: '400', on: '2026-09-14', bankAccountId: usdBankId, payeeId: usdPayee, reference: 'MT-W1' });
    const confirmed = await pay(made.payableId, { amountTxn: '600', on: '2026-09-25', bankAccountId: usdBankId, payeeId: usdPayee, reference: 'MT-W2' });
    expect(confirmed.supplierPaymentId).toBeTruthy();
    expect(await differences(made.payableId)).toEqual([]);
    const { rows: waiting } = await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'EXCHANGE_DIFFERENCE'`, [made.payableId]);
    expect(waiting[0].summary).toMatch(/waits/);

    await ownerPool.query(`update posting_rule set is_active = true where event_type = 'payables.exchange_difference' and line_role = 'exchange_loss'`);
    const done = await withScope(scope(world.manager), (tx) => applications.settleExchangeDifference(tx, world.manager, made.payableId, '2026-09-26'));
    expect(done.lossIqd).toBe(iqd('6000'));
    expect(await differences(made.payableId)).toEqual([{ kind: 'loss', source_type: 'supplier_payment', amount_iqd: '6000.0000' }]);
    // Once is all there is.
    expect(await rejection(withScope(scope(world.manager), (tx) => applications.settleExchangeDifference(tx, world.manager, made.payableId, '2026-09-26')))).toMatch(/no exchange difference/);
  });
});

describe('FX9 · Invoice Status Tracking is not where an import is followed', () => {
  it('lists no import, and refuses to move one', async () => {
    const { invoiceId } = await importInvoice('FX9-0001', '10000');
    await post(invoiceId);
    // A tracker the sheet migration left behind (it marks the invoice an import).
    const { rows } = await ownerPool.query(`insert into supplier_shipment (ap_invoice_id, status, warehouse_code, branch_code, created_by) values ($1,'in_process',$2,$3,$4) returning id`, [
      invoiceId,
      WAREHOUSE,
      BAGHDAD,
      world.manager.principal.userId,
    ]);
    const listed = await withScope(scope(world.manager), (tx) => shipments.list(tx));
    expect(listed.map((row) => row.id)).not.toContain(rows[0].id);
    expect(await rejection(withScope(scope(world.manager), (tx) => shipments.advance(tx, world.manager, rows[0].id, 'on_board')))).toMatch(/is an import/);
  });
});
