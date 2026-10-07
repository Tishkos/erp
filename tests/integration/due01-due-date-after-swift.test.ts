/**
 * The balance's due date, once the SWIFT is in — by direction 2026-10-07:
 *
 *   "Don't show the due date until we get the SWIFT … for an advance payment,
 *    the rest of the payment should be completed and the SWIFT received, and
 *    then we can decide the due date. Once the payment application is done,
 *    clicking the import application, a dialog comes up: enter the due date,
 *    and it marks it."
 *
 *   DUE1  an import invoice posted with an advance has no due date: the
 *         register, the import's register, the ageing and Home do not show one
 *         or age it as late, and the overdue sweep says nothing of it.
 *   DUE2  the paid paper (the SWIFT) confirms the advance's application, and
 *         the import's question becomes due — for whoever may set the date.
 *   DUE3  a date before the invoice's own date is refused and nothing is
 *         written; a good date is set on the invoice and the import, audited
 *         and logged, with who set it; the question is gone; the date now ages
 *         and the overdue sweep tells it.
 *   DUE4  a date written on the document as it is raised counts as set.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as authz from '@/server/services/authorization';
import * as balanceDue from '@/server/services/balance-due';
import * as customs from '@/server/services/customs-pd';
import * as dashboard from '@/server/services/dashboard';
import * as dueNotices from '@/server/services/due-notices';
import * as openItems from '@/server/services/open-items';
import * as payables from '@/server/services/payables';
import { invoiceRegister } from '@/server/services/screen-registers';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import type { Principal } from '@/server/domain/permissions';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-DUE-INPROC';
const HOLD = 'WH-DUE-NOSWIFT';
const SWIFT = 'DUE-SWIFT';
/** Long after the invoice's own date: the column's default would read as months overdue. */
const LATER = '2026-12-20';

let world: TradingWorld;
let approver: ActorContext;
let sweeper: Principal;
let serial = 0;

const iqd = (value: string) => parseDecimal(value, 4n);
const q = (value: string) => parseQuantity(value);
const paper = Buffer.from('%PDF-1.4\n% a bank paper\n');

async function fund(glAccountId: string, amount: string, on = '2026-09-01') {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1,$2,$2,$3,$4,'Owner deposit','draft',$5,$5,$6) returning id`,
      [`FUND-DUE-${(serial += 1)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
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

async function person(roles: readonly string[], name: string, superUser = false): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [id, `${id}@example.com`, name, superUser]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

/** An import invoice with a 20% advance and — as the form sends it — no due date of its own. */
async function importWithAdvance(reference: string, extra: Partial<ap.CreateApInvoiceInput> = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      isImport: true,
      advancePercent: '20',
      advancePaymentMethodCode: SWIFT,
      advancePaidFromAccountId: world.bankAccountId,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
      ...extra,
    } as ap.CreateApInvoiceInput),
  );
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
  const { rows } = await ownerPool.query(`select payable_id, invoice_no, advance_application_id from ap_invoice where id = $1`, [made.id]);
  return { invoiceId: made.id, invoiceNo: rows[0].invoice_no as string, payableId: rows[0].payable_id as string, applicationId: rows[0].advance_application_id as string };
}

const invoiceRow = async (id: string) =>
  (await ownerPool.query(`select due_date::text as due_date, due_date_set_at from ap_invoice where id = $1`, [id])).rows[0] as { due_date: string; due_date_set_at: Date | null };
const payableDue = async (id: string) => (await ownerPool.query(`select due_date::text as due_date from payable where id = $1`, [id])).rows[0].due_date as string | null;

const asManager = <T>(work: (tx: Tx) => Promise<T>) => withScope(scope(world.manager), work);
const supplierItem = (invoiceNo: string, asOf = LATER) =>
  asManager(async (tx) => (await openItems.openItems(tx, world.manager.principal, 'supplier', asOf, { branchCode: BAGHDAD })).find((item) => item.invoiceNo === invoiceNo));
const sweep = (asOf = LATER) =>
  withScope({ userId: sweeper.userId, branchCode: BAGHDAD, isSuperUser: true }, (tx) => dueNotices.raiseDueNotices(tx, sweeper, asOf, { branchCode: BAGHDAD }));

/** Draft → submitted → approved by another → sent paper → paid paper (the SWIFT). */
async function payTheAdvance(payableId: string, applicationId: string, pdNo: string) {
  await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, applicationId));
  await withScope(scope(approver), (tx) => applications.approve(tx, approver, applicationId));
  const pd = await withScope(scope(world.clerk), (tx) => customs.register(tx, world.clerk, { payableId, pdNo, registrationDate: '2026-09-02', expiryDate: '2027-03-01' }));
  await withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pd.id, { statusCode: 'validated', effectiveDate: '2026-09-05' }));
  const add = (input: Omit<applications.PaperInput, 'fileName' | 'content'>) =>
    withScope(scope(world.manager), (tx) => applications.addPaper(tx, world.manager, applicationId, { ...input, fileName: `${input.kind}.pdf`, content: paper }));
  await add({ kind: 'sent_to_bank', date: '2026-09-10', reference: 'BNK-DUE' });
  await add({ kind: 'paid', date: '2026-09-12', reference: `MT103-${pdNo}` });
}

beforeEach(async () => {
  registerAllRecords();
  world = await buildTradingWorld();
  approver = await person(['accounting_manager'], 'Second approver');
  sweeper = (await person([], 'Morning sweep', true)).principal;
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage) values
       ($1,'In Process',$3,'transit',true,'in_process'),
       ($2,'On Process (Without SWIFT)',$3,'transit',true,'without_swift')`,
    [IN_PROCESS, HOLD, BAGHDAD],
  );
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ($1,'SWIFT transfer','bank','swift')`, [SWIFT]);
  await ownerPool.query(
    `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active, is_default)
     values ($1,'Bank of China',$2,'BKCHCNBJ','IQD','approved',true,true)`,
    [world.supplierId, `CN-${randomUUID().slice(0, 8)}`],
  );
  await fund(world.accounts.bank!, '9000000');
});

describe('DUE1–DUE3 · the due date waits for the SWIFT, then the import asks for it', () => {
  it('no due date before; the paid paper makes the question; the date is set on invoice and import, audited, and then ages', async () => {
    const imp = await importWithAdvance('DUE1-0001');

    // ── DUE1 · posted with an advance: no due date anywhere, nothing late ──
    expect(await invoiceRow(imp.invoiceId)).toMatchObject({ due_date: '2026-09-01', due_date_set_at: null });
    const before = await supplierItem(imp.invoiceNo);
    // Months after the entry day, yet not overdue: "Not yet due".
    expect(before).toMatchObject({ dueDateSet: false, daysOverdue: 0, bucket: 'current', daysLateAtLastPayment: null });
    const numbers = (items: readonly openItems.OpenItem[]) => items.map((item) => item.invoiceNo);
    // Not in the overdue, and not "due today" on its entry day either.
    expect(numbers(await asManager((tx) => openItems.openItems(tx, world.manager.principal, 'supplier', LATER, { branchCode: BAGHDAD, overdueOnly: true })))).not.toContain(imp.invoiceNo);
    expect(numbers(await asManager((tx) => openItems.openItems(tx, world.manager.principal, 'supplier', '2026-09-01', { branchCode: BAGHDAD, dueWithinDays: 7 })))).not.toContain(imp.invoiceNo);
    // The register says the payment state without "Overdue", and the import's register has no due date, waiting.
    const register = await asManager((tx) => invoiceRegister(tx, {}, LATER));
    expect(register.shown.find((row) => row.invoiceNo === imp.invoiceNo)).toMatchObject({ state: 'unpaid', dueDateSetAt: null });
    const bench = await asManager((tx) => payables.workbench(tx, { pageSize: 100 }));
    expect(bench.rows.find((row) => row.id === imp.payableId)).toMatchObject({ dueDate: null, dueDateWaiting: true });
    // Home's payables ageing: owed, and none of it overdue.
    const home = await asManager((tx) => dashboard.payableAgeing(tx, BAGHDAD, LATER));
    expect(home.overdueIqd).toBe('0.0000');
    expect(home.buckets.map((bucket) => bucket.bucket)).toEqual(['current']);
    // The overdue sweep tells nobody of it.
    expect((await sweep()).overdue).toBe(0);

    // ── DUE2 · before the SWIFT nothing is asked; the paid paper confirms the application ──
    expect(await asManager((tx) => balanceDue.promptFor(tx, world.clerk.principal, imp.payableId))).toMatchObject({ due: false, ask: false, paid: null });
    await payTheAdvance(imp.payableId, imp.applicationId, 'DUE1-PD');
    expect((await ownerPool.query(`select status::text as status, confirmed_on::text as confirmed_on, application_no from payment_application where id = $1`, [imp.applicationId])).rows[0]).toMatchObject({
      status: 'confirmed',
      confirmed_on: '2026-09-12',
    });
    const asked = await withScope(scope(world.clerk), (tx) => balanceDue.promptFor(tx, world.clerk.principal, imp.payableId));
    expect(asked).toMatchObject({ due: true, ask: true, payableId: imp.payableId, earliest: '2026-09-01', mark: null });
    expect(asked.paid).toMatchObject({ status: 'confirmed', confirmedOn: '2026-09-12' });
    expect(asked.waiting.map((invoice) => invoice.invoiceNo)).toEqual([imp.invoiceNo]);
    // 1,000,000 less the 200,000 the SWIFT paid.
    expect(asked.owedIqd).toBe(iqd('800000'));

    // ── DUE3 · a date before the invoice's own: refused in words, nothing written ──
    const early = await rejection(withScope(scope(world.clerk), (tx) => balanceDue.setForImport(tx, world.clerk, imp.payableId, '2026-08-15')));
    expect(early).toMatch(new RegExp(`2026-08-15 is before invoice ${imp.invoiceNo}'s own date \\(2026-09-01\\)`));
    expect(await rejection(withScope(scope(world.clerk), (tx) => balanceDue.setForImport(tx, world.clerk, imp.payableId, 'next week')))).toMatch(/A due date is a date/);
    expect(await invoiceRow(imp.invoiceId)).toMatchObject({ due_date_set_at: null });

    // …and a good one: on the invoice and the import, audited, logged, marked with who set it.
    await ownerPool.query(`update app_user set display_name = 'Due Setter' where id = $1`, [world.clerk.principal.userId]);
    const set = await withScope(scope(world.clerk), (tx) => balanceDue.setForImport(tx, world.clerk, imp.payableId, '2026-11-15'));
    expect(set.invoiceNos).toEqual([imp.invoiceNo]);
    const after = await invoiceRow(imp.invoiceId);
    expect(after.due_date).toBe('2026-11-15');
    expect(after.due_date_set_at).toBeInstanceOf(Date);
    expect(await payableDue(imp.payableId)).toBe('2026-11-15');
    const { rows: audits } = await ownerPool.query(
      `select actor_user_id, before_value, after_value from audit_event where action = 'ap_invoice.due_date_set' and object_id = $1`,
      [imp.invoiceId],
    );
    expect(audits).toEqual([expect.objectContaining({ actor_user_id: world.clerk.principal.userId, before_value: { dueDate: '2026-09-01' }, after_value: { dueDate: '2026-11-15' } })]);
    const { rows: logged } = await ownerPool.query(`select event_code, summary from payable_event where payable_id = $1 and event_code = 'FIELD_CHANGED'`, [imp.payableId]);
    expect(logged.map((row) => row.summary)).toContain(`Due date of ${imp.invoiceNo}: 2026-09-01 → 2026-11-15`);

    // The question is gone, and the mark says who and when.
    const done = await withScope(scope(world.clerk), (tx) => balanceDue.promptFor(tx, world.clerk.principal, imp.payableId));
    expect(done).toMatchObject({ due: false, ask: false, waiting: [] });
    expect(done.mark).toMatchObject({ invoiceId: imp.invoiceId, dueDate: '2026-11-15', byName: 'Due Setter' });
    // Nothing left to set: asked again, refused.
    expect(await rejection(withScope(scope(world.clerk), (tx) => balanceDue.setForImport(tx, world.clerk, imp.payableId, '2026-11-30')))).toMatch(/already has its due date/);

    // From now on it is a due date like any other: shown, aged, and told when late.
    const bench2 = await asManager((tx) => payables.workbench(tx, { pageSize: 100 }));
    expect(bench2.rows.find((row) => row.id === imp.payableId)).toMatchObject({ dueDate: '2026-11-15', dueDateWaiting: false });
    expect(await supplierItem(imp.invoiceNo)).toMatchObject({ dueDateSet: true, dueDate: '2026-11-15', daysOverdue: 35, bucket: '31-60' });
    expect(await supplierItem(imp.invoiceNo, '2026-11-10')).toMatchObject({ daysOverdue: 0, daysUntilDue: 5, bucket: 'current' });
    const register2 = await asManager((tx) => invoiceRegister(tx, {}, LATER));
    expect(register2.shown.find((row) => row.invoiceNo === imp.invoiceNo)).toMatchObject({ state: 'overdue' });
    expect((await asManager((tx) => dashboard.payableAgeing(tx, BAGHDAD, LATER))).overdueIqd).toBe('800000.0000');
    expect((await sweep()).overdue).toBe(1);
  });

  it('the question is not the business of an import with nothing paid yet, nor of one whose invoice is settled', async () => {
    const imp = await importWithAdvance('DUE2-0001');
    // The application sent to the bank but not paid: still no question.
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, imp.applicationId));
    await withScope(scope(approver), (tx) => applications.approve(tx, approver, imp.applicationId));
    expect(await rejection(withScope(scope(world.clerk), (tx) => balanceDue.setForImport(tx, world.clerk, imp.payableId, '2026-11-15')))).toMatch(/No payment application of this import has been paid yet/);
    expect(await withScope(scope(world.clerk), (tx) => balanceDue.promptFor(tx, world.clerk.principal, imp.payableId))).toMatchObject({ due: false });
  });
});

describe('DUE4 · a date written on the document as it is raised counts as set', () => {
  it('stamped at entry, shown and aged at once', async () => {
    const imp = await importWithAdvance('DUE4-0001', { dueDate: '2026-10-01' });
    const row = await invoiceRow(imp.invoiceId);
    expect(row.due_date).toBe('2026-10-01');
    expect(row.due_date_set_at).toBeInstanceOf(Date);
    expect(await supplierItem(imp.invoiceNo)).toMatchObject({ dueDateSet: true, bucket: '61-90' });
    expect(await withScope(scope(world.clerk), (tx) => balanceDue.promptFor(tx, world.clerk.principal, imp.payableId))).toMatchObject({ due: false, waiting: [] });
  });
});
