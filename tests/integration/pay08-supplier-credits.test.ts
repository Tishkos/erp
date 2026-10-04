/**
 * REQ-PAY-001 PAY8–PAY12 — supplier credit and debit notes, the supplier's
 * credits, the reconciliation, and the payment chain.
 *
 *   PAY8   Invoice 100,000 → credit note 10,000 (draft → approved by another →
 *          posted) → outstanding 90,000; on the statement and in the ageing; a
 *          credit larger than what is owed leaves an unapplied supplier credit,
 *          applied later. The return route's memo now records its application,
 *          so the supplier's account no longer counts it twice.
 *   PAY9   A debit note is a purchase invoice linked to the invoice it adjusts;
 *          it ages, states and is paid like a bill.
 *   PAY10  Overpayment 120,000 on 100,000 → invoice 0, supplier credit 20,000;
 *          an advance with no invoice is a credit of its full amount.
 *   PAY11  Subledger = AP control; a manual journal on the control account with
 *          no supplier shows as its own investigation line; nothing repaired.
 *   PAY12  Invoice 100,000 → pay 40,000 → owed 60,000 (part paid) → pay 60,000
 *          → 0, settled; the ageing bucket moves with the due date.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as authz from '@/server/services/authorization';
import * as notes from '@/server/services/supplier-notes';
import * as balances from '@/server/services/supplier-balances';
import * as pay from '@/server/services/supplier-payment';
import * as openItems from '@/server/services/open-items';
import * as statement from '@/server/services/partner-statement';
import * as po from '@/server/services/purchase-order';
import * as advances from '@/server/services/supplier-advance';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { fundBank } from './hr-funds';
import { BAGHDAD, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const iqd = (value: string) => parseDecimal(value, 4n);
const num = (value: string | bigint) => Number(typeof value === 'bigint' ? value / 10_000n : value);
const ON = '2026-05-01';

let world: TradingWorld;
let approver: ActorContext;

beforeEach(async () => {
  world = await buildTradingWorld();
  await fundBank(world);
  // A second manager: the credit note is approved by somebody other than its raiser.
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Second Manager')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager'),($1,'ceo')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  approver = { principal: await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id)), branchCode: BAGHDAD };
});

/** A posted service invoice for `amount`, due on `due`. */
async function postedInvoice(amount: string, due = '2026-05-31', number = `JNK-${randomUUID().slice(0, 6)}`) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: number,
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: due,
      expenseAccountId: world.accounts.expense!,
      nonPoJustification: 'Installation service',
      nonPoApprovedBy: world.manager.principal.userId,
      lines: [{ description: 'Installation', quantity: parseQuantity('1'), unitPriceIqd: iqd(amount), isInventory: false }],
    }),
  );
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
  return made;
}

async function invoiceRow(id: string) {
  const { rows } = await ownerPool.query(`select total_iqd, settled_amount_iqd, status::text as status from ap_invoice where id = $1`, [id]);
  return rows[0] as { total_iqd: string; settled_amount_iqd: string; status: string };
}

async function paySupplier(amount: string, invoiceId?: string, on = ON) {
  return withScope(scope(world.manager), async (tx) => {
    const made = await pay.create(tx, world.manager, {
      supplierId: world.supplierId,
      bankCashAccountId: world.bankAccountId,
      branchCode: BAGHDAD,
      paymentDate: on,
      amountIqd: iqd(amount),
    });
    if (invoiceId) {
      const owed = pay.outstandingOn((await ap.view(tx, invoiceId)).invoice);
      const toApply = owed < iqd(amount) ? owed : iqd(amount);
      await pay.allocate(tx, world.manager, { supplierPaymentId: made.id, apInvoiceId: invoiceId, amountIqd: toApply });
    }
    await pay.post(tx, world.manager, made.id);
    return made;
  });
}

async function supplierCode(): Promise<string> {
  const { rows } = await ownerPool.query(`select code from business_partner where id = $1`, [world.supplierId]);
  return rows[0].code as string;
}

describe('PAY8 · a supplier credit note without a return', () => {
  it('Invoice 100,000 → credit 10,000 → outstanding 90,000, on the statement and in the ageing', async () => {
    const invoice = await postedInvoice('100000');
    const note = await withScope(scope(world.manager), (tx) =>
      notes.createCreditNote(tx, world.manager, {
        apInvoiceId: invoice.id,
        supplierMemoNo: 'JNK-CN-1',
        memoDate: '2026-05-10',
        amountIqd: iqd('10000'),
        reason: 'Price agreed down after delivery',
      }),
    );
    expect(note.memoNo).toMatch(/^SCM-/);

    // Raised by one manager, approved by another: the raiser cannot.
    expect(await rejection(withScope(scope(world.manager), (tx) => notes.approveCreditNote(tx, world.manager, note.id)))).toMatch(
      /somebody else approves it/,
    );
    // Not posted before it is approved.
    expect(await rejection(withScope(scope(approver), (tx) => notes.postCreditNote(tx, approver, note.id)))).toMatch(/once somebody has approved it/);
    await withScope(scope(approver), (tx) => notes.approveCreditNote(tx, approver, note.id));
    const posted = await withScope(scope(approver), (tx) => notes.postCreditNote(tx, approver, note.id));
    expect(num(posted.appliedIqd)).toBe(10000);
    expect(num(posted.unappliedIqd)).toBe(0);

    expect(await invoiceRow(invoice.id)).toMatchObject({ settled_amount_iqd: '10000.0000', status: 'partially_executed' });

    // The journal: Dr Supplier A/P / Cr purchase variance.
    const { rows: lines } = await ownerPool.query(
      `select account_id, debit_iqd::float as dr, credit_iqd::float as cr from journal_line where journal_entry_id = $1`,
      [posted.journalEntryId],
    );
    expect(lines.find((l) => l.account_id === world.accounts.supplier_payable)).toMatchObject({ dr: 10000, cr: 0 });
    expect(lines.find((l) => l.account_id === world.accounts.purchase_variance)).toMatchObject({ dr: 0, cr: 10000 });

    // The ageing: 90,000 owed on the invoice.
    const [item] = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-05-15', { outstandingOnly: true }),
    );
    expect(num(item!.outstandingIqd)).toBe(90000);

    // The statement: the invoice credited 100,000, the note debited 10,000, closing 90,000.
    const code = await supplierCode();
    const account = await withScope(scope(world.manager), (tx) => statement.statementFor(tx, 'supplier', code, { to: '2026-12-31' }));
    expect(num(account.closing)).toBe(90000);

    // The supplier's account holds no unapplied credit: it was applied, once.
    const held = await withScope(scope(world.manager), (tx) => pay.supplierAccount(tx, world.supplierId, '2026-05-15'));
    expect(held.unappliedCreditIqd).toBe(0n);
    expect(held.outstandingIqd).toBe(iqd('90000'));
  });

  it('a credit over what is owed leaves an unapplied supplier credit, applied later to another invoice', async () => {
    const first = await postedInvoice('100000');
    await paySupplier('95000', first.id);
    const note = await withScope(scope(world.manager), (tx) =>
      notes.createCreditNote(tx, world.manager, { apInvoiceId: first.id, memoDate: '2026-05-10', amountIqd: iqd('20000'), reason: 'Rebate' }),
    );
    await withScope(scope(approver), (tx) => notes.approveCreditNote(tx, approver, note.id));
    const posted = await withScope(scope(approver), (tx) => notes.postCreditNote(tx, approver, note.id));
    expect(num(posted.appliedIqd)).toBe(5000);
    expect(num(posted.unappliedIqd)).toBe(15000);
    expect(await invoiceRow(first.id)).toMatchObject({ status: 'settled' });

    const credits = await withScope(scope(world.manager), (tx) => balances.credits(tx, world.manager.principal, { kind: 'credit_note' }));
    expect(credits).toHaveLength(1);
    expect(num(credits[0]!.unappliedIqd)).toBe(15000);

    const second = await postedInvoice('40000');
    const applied = await withScope(scope(approver), (tx) =>
      notes.applyCredit(tx, approver, { memoId: note.id, apInvoiceId: second.id, amountIqd: iqd('15000') }),
    );
    expect(applied.memoUnapplied).toBe(0n);
    expect(num(applied.invoiceOutstanding)).toBe(25000);
    // Never past what the credit holds.
    expect(
      await rejection(withScope(scope(approver), (tx) => notes.applyCredit(tx, approver, { memoId: note.id, apInvoiceId: second.id, amountIqd: iqd('1') }))),
    ).toMatch(/left to apply/);
  });

  it('a posted note is reversed, never edited, and its invoice owes again', async () => {
    const invoice = await postedInvoice('100000');
    const note = await withScope(scope(world.manager), (tx) =>
      notes.createCreditNote(tx, world.manager, { apInvoiceId: invoice.id, memoDate: '2026-05-10', amountIqd: iqd('10000'), reason: 'Price' }),
    );
    await withScope(scope(approver), (tx) => notes.approveCreditNote(tx, approver, note.id));
    await withScope(scope(approver), (tx) => notes.postCreditNote(tx, approver, note.id));

    const edited = await ownerPool
      .query(`update supplier_credit_memo set amount_iqd = 5000 where id = $1`, [note.id])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(edited).toMatch(/Reverse it; it is not edited/);

    await withScope(scope(world.manager), (tx) => notes.reverseCreditNote(tx, world.manager, note.id, { reason: 'Supplier withdrew it' }));
    expect(await invoiceRow(invoice.id)).toMatchObject({ settled_amount_iqd: '0.0000', status: 'posted' });
    const { rows } = await ownerPool.query(`select status::text as status, allocated_amount_iqd from supplier_credit_memo where id = $1`, [note.id]);
    expect(rows[0]).toMatchObject({ status: 'reversed', allocated_amount_iqd: '0.0000' });
    // The applications are records: never deleted.
    const deleted = await ownerPool
      .query(`delete from supplier_credit_application where supplier_credit_memo_id = $1`, [note.id])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(deleted).toMatch(/undone by reversing it/);
  });

  it('a credit note says why, and is never for more than its invoice', async () => {
    const invoice = await postedInvoice('100000');
    expect(
      await rejection(
        withScope(scope(world.manager), (tx) =>
          notes.createCreditNote(tx, world.manager, { apInvoiceId: invoice.id, memoDate: '2026-05-10', amountIqd: iqd('10'), reason: ' ' }),
        ),
      ),
    ).toMatch(/Give a reason/);
    expect(
      await rejection(
        withScope(scope(world.manager), (tx) =>
          notes.createCreditNote(tx, world.manager, { apInvoiceId: invoice.id, memoDate: '2026-05-10', amountIqd: iqd('100001'), reason: 'Too much' }),
        ),
      ),
    ).toMatch(/cannot be for more than the invoice/);
  });
});

describe('PAY9 · a supplier debit note is a purchase invoice', () => {
  it('links to the invoice it adjusts, posts, ages, states and is paid like a bill', async () => {
    const invoice = await postedInvoice('100000');
    const debit = await withScope(scope(world.clerk), (tx) =>
      notes.createDebitNote(tx, world.clerk, {
        adjustsInvoiceId: invoice.id,
        noteDate: '2026-05-12',
        amountIqd: iqd('7500'),
        reason: 'Freight surcharge the supplier passed on',
        dueDate: '2026-06-12',
      }),
    );
    const { rows } = await ownerPool.query(`select adjusts_invoice_id, non_po_justification from ap_invoice where id = $1`, [debit.id]);
    expect(rows[0].adjusts_invoice_id).toBe(invoice.id);

    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, debit.id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, debit.id));
    expect(await invoiceRow(debit.id)).toMatchObject({ total_iqd: '7500.0000', status: 'posted' });

    const items = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-07-01', { outstandingOnly: true }),
    );
    const aged = items.find((row) => row.invoiceNo === debit.invoiceNo);
    expect(aged).toMatchObject({ bucket: '1-30' });

    const code = await supplierCode();
    const account = await withScope(scope(world.manager), (tx) => statement.statementFor(tx, 'supplier', code, { to: '2026-12-31' }));
    expect(num(account.closing)).toBe(107500);

    await paySupplier('7500', debit.id, '2026-06-01');
    expect(await invoiceRow(debit.id)).toMatchObject({ status: 'settled' });

    // The register lists it beside the credit notes.
    const listed = await withScope(scope(world.manager), (tx) => notes.list(tx));
    expect(listed.find((row) => row.number === debit.invoiceNo)).toMatchObject({ kind: 'debit', invoiceNo: invoice.invoiceNo });
  });

  it('adjusts only a posted invoice of the same supplier', async () => {
    const draft = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'DRAFT-1',
        branchCode: BAGHDAD,
        invoiceDate: ON,
        nonPoJustification: 'x',
        nonPoApprovedBy: world.manager.principal.userId,
        lines: [{ description: 'x', quantity: parseQuantity('1'), unitPriceIqd: iqd('10'), isInventory: false }],
      }),
    );
    expect(
      await rejection(
        withScope(scope(world.clerk), (tx) =>
          notes.createDebitNote(tx, world.clerk, { adjustsInvoiceId: draft.id, noteDate: ON, amountIqd: iqd('5'), reason: 'x' }),
        ),
      ),
    ).toMatch(/adjusts a posted invoice/);
  });
});

describe('PAY10 · Supplier Credits', () => {
  it('overpayment 120,000 on 100,000 → invoice 0, supplier credit 20,000', async () => {
    const invoice = await postedInvoice('100000');
    await paySupplier('120000', invoice.id);
    expect(await invoiceRow(invoice.id)).toMatchObject({ settled_amount_iqd: '100000.0000', status: 'settled' });
    const rows = await withScope(scope(world.manager), (tx) => balances.credits(tx, world.manager.principal));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'payment', amountIqd: '120000.0000', appliedIqd: '100000.0000', unappliedIqd: '20000.0000' });
    expect(balances.creditTotals(rows)[0]!.totalIqd).toBe(iqd('20000'));
  });

  it('an advance of 5,000,000 with no invoice is a credit of 5,000,000', async () => {
    const order = await withScope(scope(world.clerk), (tx) =>
      po.create(tx, world.clerk, {
        supplierId: world.supplierId,
        branchCode: BAGHDAD,
        orderDate: ON,
        lines: [{ lineType: 'service', description: 'Install', quantity: parseQuantity('1'), uomCode: 'EA', unitPriceIqd: iqd('9000000'), branchCode: BAGHDAD }],
      }),
    );
    await withScope(scope(world.clerk), (tx) => po.submit(tx, world.clerk, order.id));
    await withScope(scope(world.manager), (tx) => po.approve(tx, world.manager, order.id));
    const advance = await withScope(scope(world.clerk), (tx) =>
      advances.request(tx, world.clerk, { purchaseOrderId: order.id, branchCode: BAGHDAD, requestDate: ON, amountIqd: iqd('5000000') }),
    );
    await withScope(scope(world.manager), (tx) => advances.approve(tx, world.manager, advance.id));
    await withScope(scope(world.manager), (tx) => advances.pay(tx, world.manager, advance.id, ON, world.bankAccountId));
    const rows = await withScope(scope(world.manager), (tx) => balances.credits(tx, world.manager.principal));
    expect(rows).toEqual([expect.objectContaining({ kind: 'advance', unappliedIqd: '5000000.0000' })]);
  });

  it('is read under the supplier payment grant', async () => {
    const id = randomUUID();
    await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'HR')`, [id, `${id}@example.com`]);
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'hr_officer')`, [id]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
    const hr = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
    expect(await rejection(withScope({ userId: id, branchCode: BAGHDAD }, (tx) => balances.credits(tx, hr)))).toMatch(/not permitted|denied|may not/i);
  });
});

describe('PAY11 · Supplier Reconciliation', () => {
  it('the subledger equals the AP control account; a journal with no supplier is its own investigation line, and nothing is repaired', async () => {
    await postedInvoice('100000');
    const before = await withScope(scope(world.manager), (tx) => balances.controlAccounts(tx, world.manager.principal, '2026-12-31'));
    const control = before.find((row) => row.accountCode.length > 0)!;
    expect(control.subledgerIqd).toBe(iqd('100000'));
    expect(control.generalLedgerIqd).toBe(iqd('100000'));
    expect(control.differenceIqd).toBe(0n);
    expect(await withScope(scope(world.manager), (tx) => balances.exceptions(tx, world.manager.principal, '2026-12-31'))).toEqual([]);

    // A journal straight onto the control account, naming no supplier.
    const { rows: periods } = await ownerPool.query(`select id from fiscal_period where starts_on <= '2026-05-20' and ends_on >= '2026-05-20'`);
    const { rows: entry } = await ownerPool.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ('JE-MANUAL-1','2026-05-20','2026-05-20',$1,$2,'Manual correction','draft',2500,2500,$3) returning id`,
      [periods[0].id, BAGHDAD, world.manager.principal.userId],
    );
    await ownerPool.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1,1,$2,0,2500,0,2500,0,0,'IQD',$4), ($1,2,$3,2500,0,2500,0,0,0,'IQD',$4)`,
      [entry[0].id, world.accounts.supplier_payable, world.accounts.expense, BAGHDAD],
    );
    await ownerPool.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, world.manager.principal.userId]);

    const after = await withScope(scope(world.manager), (tx) => balances.controlAccounts(tx, world.manager.principal, '2026-12-31'));
    const differing = after.find((row) => row.differenceIqd !== 0n)!;
    expect(differing.generalLedgerIqd).toBe(iqd('102500'));
    expect(differing.subledgerIqd).toBe(iqd('100000'));
    expect(differing.differenceIqd).toBe(iqd('-2500'));
    const found = await withScope(scope(world.manager), (tx) => balances.exceptions(tx, world.manager.principal, '2026-12-31'));
    expect(found).toEqual([expect.objectContaining({ reason: 'no_subledger', entryNo: 'JE-MANUAL-1', lineCreditIqd: '2500.0000' })]);

    // Reading it changed nothing.
    const { rows: subledger } = await ownerPool.query(`select count(*)::int as n from subledger_entry where journal_entry_id = $1`, [entry[0].id]);
    expect(subledger[0].n).toBe(0);
  });
});

describe('PAY12 · the payment chain', () => {
  it('100,000 → pay 40,000 → 60,000 part paid → pay 60,000 → 0 settled, the ageing bucket moving with the due date', async () => {
    const invoice = await postedInvoice('100000', '2026-05-31');

    const current = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-05-20', { outstandingOnly: true }),
    );
    expect(current[0]).toMatchObject({ bucket: 'current', outstandingIqd: '100000.0000', status: 'posted' });

    await paySupplier('40000', invoice.id, '2026-05-25');
    expect(await invoiceRow(invoice.id)).toMatchObject({ settled_amount_iqd: '40000.0000', status: 'partially_executed' });

    const partPaid = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-07-15', openItems.viewFilter('part_paid')),
    );
    expect(partPaid).toHaveLength(1);
    expect(partPaid[0]).toMatchObject({ outstandingIqd: '60000.0000', bucket: '31-60', daysOverdue: 45 });
    const buckets = openItems.ageing(partPaid);
    expect(buckets.find((b) => b.bucket === '31-60')).toMatchObject({ invoices: 1 });
    expect(num(buckets.find((b) => b.bucket === '31-60')!.amountIqd)).toBe(60000);

    const ninety = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-09-15', { outstandingOnly: true }),
    );
    expect(ninety[0]).toMatchObject({ bucket: '90+' });

    await paySupplier('60000', invoice.id, '2026-07-20');
    expect(await invoiceRow(invoice.id)).toMatchObject({ settled_amount_iqd: '100000.0000', status: 'settled' });
    const open = await withScope(scope(world.manager), (tx) =>
      openItems.openItems(tx, world.manager.principal, 'supplier', '2026-07-20', { outstandingOnly: true }),
    );
    expect(open).toEqual([]);

    const code = await supplierCode();
    const account = await withScope(scope(world.manager), (tx) => statement.statementFor(tx, 'supplier', code, { to: '2026-12-31' }));
    expect(num(account.closing)).toBe(0);
  });
});
