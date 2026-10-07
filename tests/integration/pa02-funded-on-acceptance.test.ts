/**
 * The import's stage and the payment application's road — by direction
 * 2026-10-07: "approved … by the super user doesn't mean the payment
 * application is done and funded, until we get accepted" and "linked
 * purchases cannot go back to steps in status".
 *
 *   PA1  Invoiced + funded lights only once the bank has the application —
 *        the Sent to the bank paper (or Paid) — never when it is submitted or
 *        approved; the approved label says it waits for the bank.
 *   PA2  A second purchase invoice linked to the import, as a draft and then
 *        posted, never moves the import's stage backwards — whatever the
 *        first application's status — and once the import's advance is Paid
 *        its goods go to In Process, never back to On Process (Without SWIFT).
 *   PA3  The PD check is shown on the application and never refuses a paper:
 *        Sent to the bank passes with no PD registered.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as advanceHold from '@/server/services/advance-hold';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-PA2-INPROC';
const HOLD = 'WH-PA2-NOSWIFT';
const SWIFT = 'PA2-SWIFT';
let world: TradingWorld;
let approver: ActorContext;
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
      [`FUND-PA2-${(serial += 1)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
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

/** The super user: approves alone, as on the sponsor's screen. */
async function superUser(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,'Super user',true)`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD, isSuperUser: true }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

async function importInvoice(reference: string, extra: Partial<ap.CreateApInvoiceInput> = {}) {
  const made = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: reference,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-01',
      dueDate: '2026-11-01',
      isImport: true,
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
      ...extra,
    } as ap.CreateApInvoiceInput),
  );
  const { rows } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [made.id]);
  return { invoiceId: made.id, payableId: rows[0].payable_id as string };
}

const withAdvance = { advancePercent: '20', advancePaymentMethodCode: SWIFT } as const;

async function post(invoiceId: string) {
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoiceId));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, invoiceId));
}

const held = async (warehouseCode: string) =>
  (await ownerPool.query(`select coalesce(sum(held), 0)::numeric(19,6)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [PANEL, warehouseCode])).rows[0].n as string;
const stageOf = async (payableId: string) => (await ownerPool.query(`select stage_code from payable where id = $1`, [payableId])).rows[0].stage_code as string;
const statusOf = async (id: string) => (await ownerPool.query(`select status::text from payment_application where id = $1`, [id])).rows[0].status as string;
const applicationOf = async (invoiceId: string) =>
  (await ownerPool.query(`select a.id from ap_invoice i join payment_application a on a.id = i.advance_application_id where i.id = $1`, [invoiceId])).rows[0] as { id: string } | undefined;
const stageLog = async (payableId: string) =>
  (await ownerPool.query(`select summary from payable_event where payable_id = $1 and event_code = 'STAGE_CHANGED' order by recorded_at`, [payableId])).rows.map((row) => row.summary as string);

const addPaper = (actor: ActorContext, id: string, input: Omit<applications.PaperInput, 'fileName' | 'content'>) =>
  withScope(scope(actor), (tx) => applications.addPaper(tx, actor, id, { ...input, fileName: `${input.kind}.pdf`, content: paper }));

const submit = (id: string) => withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, id));
const approve = (id: string) => withScope(scope(approver), (tx) => applications.approve(tx, approver, id));

beforeEach(async () => {
  registerAllRecords();
  world = await buildTradingWorld();
  approver = await superUser();
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

describe('PA1 · approved is not funded', () => {
  it('the stage waits at Order confirmed through submit and approve, and is funded once the bank has the application', async () => {
    const { invoiceId, payableId } = await importInvoice('PA1-0001', { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
    await post(invoiceId);
    expect(await stageOf(payableId)).toBe('order_confirmed');

    const app = (await applicationOf(invoiceId))!;
    await submit(app.id);
    expect(await statusOf(app.id)).toBe('submitted');
    expect(await stageOf(payableId)).toBe('order_confirmed');

    // The super user approves alone — and the import is still not funded.
    await approve(app.id);
    expect(await statusOf(app.id)).toBe('approved');
    expect(await stageOf(payableId)).toBe('order_confirmed');

    // The bank has it: funded, and the payment is in progress.
    await addPaper(world.manager, app.id, { kind: 'sent_to_bank', date: '2026-09-10', reference: 'BNK-1' });
    expect(await statusOf(app.id)).toBe('sent');
    expect(await stageOf(payableId)).toBe('payment_in_progress');
    const reached = await withScope(scope(world.clerk), async (tx) => {
      const payables = await import('@/server/services/payables');
      const { deriveStage, STAGE_RULES } = await import('@/server/domain/payables');
      const facts = await payables.gatherFacts(tx, payableId);
      return { facts, funded: STAGE_RULES.import_invoiced_funded!(facts), stage: deriveStage(await payables.railFor(tx, 'import'), facts) };
    });
    expect(reached.funded).toBe(true);
    expect(reached.stage).toBe('payment_in_progress');
  });
});

describe('PA2 · a second invoice never steps the import back', () => {
  for (const firstAt of ['approved', 'sent', 'paid'] as const) {
    it(`first application ${firstAt}: the second invoice linked, then posted, keeps the stage`, async () => {
      const { invoiceId, payableId } = await importInvoice(`PA2-${firstAt}-A`, { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
      await post(invoiceId);
      const app = (await applicationOf(invoiceId))!;
      await submit(app.id);
      await approve(app.id);
      if (firstAt !== 'approved') await addPaper(world.manager, app.id, { kind: 'sent_to_bank', date: '2026-09-10', reference: 'BNK-2' });
      if (firstAt === 'paid') await addPaper(world.manager, app.id, { kind: 'paid', date: '2026-09-12', reference: 'MT103-2' });
      const before = await stageOf(payableId);
      const sequenceOf = async (code: string) => (await ownerPool.query(`select sequence from payable_stage where payable_type_code = 'import' and code = $1`, [code])).rows[0].sequence as number;

      // The second invoice joins the same import, as a draft.
      const second = await importInvoice(`PA2-${firstAt}-B`, { ...withAdvance, advancePaidFromAccountId: world.bankAccountId, payableId });
      expect(second.payableId).toBe(payableId);
      expect(await sequenceOf(await stageOf(payableId))).toBeGreaterThanOrEqual(await sequenceOf(before));

      // …and posted: its own advance is drafted, and the stage does not move back.
      await post(second.invoiceId);
      const after = await stageOf(payableId);
      expect(await sequenceOf(after)).toBeGreaterThanOrEqual(await sequenceOf(before));
      const { rows: invoices } = await ownerPool.query(`select count(*)::int as n from ap_invoice where payable_id = $1 and status in ('posted','partially_executed','settled')`, [payableId]);
      expect(invoices[0].n).toBe(2);
      // No STAGE_CHANGED line reads as a step back.
      const log = await stageLog(payableId);
      expect(log.filter((line) => /→ Order confirmed/.test(line))).toEqual([]);

      // Nor do the goods: once the import's advance is Paid the second invoice's
      // goods join the released ones in In Process — never back in the hold.
      if (firstAt === 'paid') {
        expect(await held(HOLD)).toBe('0.000000');
        expect(await held(IN_PROCESS)).toBe('200.000000');
        expect(await withScope(scope(world.clerk), (tx) => advanceHold.heldOf(tx, payableId))).toEqual([]);
        const told = (await ownerPool.query(`select summary from payable_event where payable_id = $1 and source_no = (select invoice_no from ap_invoice where id = $2) and event_code = 'FIELD_CHANGED'`, [payableId, second.invoiceId])).rows;
        expect(told.some((row) => /advance is already paid/.test(row.summary))).toBe(true);
      } else {
        // The advance is not paid yet: both invoices' goods wait together.
        expect(await held(HOLD)).toBe('200.000000');
        expect(await held(IN_PROCESS)).toBe('0.000000');
      }
    });
  }
});

describe('PA3 · the PD check is shown, never a stop', () => {
  it('Sent to the bank passes with no PD registered; the check reads as a warning on the record', async () => {
    const { invoiceId, payableId } = await importInvoice('PA3-0001', { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
    await post(invoiceId);
    const app = (await applicationOf(invoiceId))!;
    await submit(app.id);
    await approve(app.id);
    const checks = await withScope(scope(world.clerk), async (tx) => applications.checksFor(tx, await applications.loadByNo(tx, (await ownerPool.query(`select application_no from payment_application where id = $1`, [app.id])).rows[0].application_no)));
    expect(checks.find((check) => check.code === 'pd_validated')).toMatchObject({ outcome: 'warning', detail: expect.stringMatching(/No PD is registered/) });
    // A clerk, no override reason: the paper is taken.
    await addPaper(world.clerk, app.id, { kind: 'sent_to_bank', date: '2026-09-10', reference: 'BNK-3' });
    expect(await statusOf(app.id)).toBe('sent');
    expect(await stageOf(payableId)).toBe('payment_in_progress');
  });
});
