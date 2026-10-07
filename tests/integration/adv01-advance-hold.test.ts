/**
 * The advance, end to end — by direction 2026-10-06:
 *
 *   "when the advance option is on and a percentage is entered … the advanced
 *    option has one extra warehouse, On Process (Without SWIFT). Once its own
 *    payment application is done it goes In Process and continues like other
 *    applications. A payment application is drafted, sent for approval,
 *    approved; then whenever someone adds an attachment it has to be pointed out
 *    what it is: sent to the bank → waiting for the bank; rejected / cancelled
 *    → the import knows, the goods stay in On Process (Without SWIFT); paid →
 *    the goods move to In Process; or other."
 *
 *   ADV1  posted with 20%: the goods wait in the hold, the application is a
 *         draft; a container cannot be received from the hold (a B/L can be
 *         recorded); draft → submitted → approved by another person; a paid
 *         paper before the sent one is refused; sent paper → sent; paid paper
 *         → confirmed, the goods move to In Process, and then the container is
 *         received into the warehouse.
 *   ADV2  approved, then a rejected / cancelled paper: cancelled, the goods stay
 *         held and the import's log says so; a second application raised by
 *         hand and paid releases them.
 *   ADV3  an "other" paper moves nothing; the preparer cannot approve; an
 *         import with no advance goes straight to In Process, as before.
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as applications from '@/server/services/payment-applications';
import * as authz from '@/server/services/authorization';
import * as customs from '@/server/services/customs-pd';
import * as shipments from '@/server/services/shipments';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const IN_PROCESS = 'WH-ADV-INPROC';
const HOLD = 'WH-ADV-NOSWIFT';
const SWIFT = 'ADV-SWIFT';
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
      [`FUND-ADV-${(serial += 1)}`, on, periods[0].id, BAGHDAD, amount, world.manager.principal.userId],
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

/** A second approver: the auto-raised draft is the poster's, and the poster cannot approve it. */
async function secondApprover(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Second approver')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
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

async function validatePd(payableId: string, pdNo: string) {
  const pd = await withScope(scope(world.clerk), (tx) => customs.register(tx, world.clerk, { payableId, pdNo, registrationDate: '2026-09-02', expiryDate: '2027-03-01' }));
  await withScope(scope(world.clerk), (tx) => customs.changeStatus(tx, world.clerk, pd.id, { statusCode: 'validated', effectiveDate: '2026-09-05' }));
}

const held = async (warehouseCode: string) =>
  (await ownerPool.query(`select coalesce(sum(held), 0)::numeric(19,6)::text as n from stock_position where item_code = $1 and warehouse_code = $2`, [PANEL, warehouseCode])).rows[0].n as string;

const applicationOf = async (invoiceId: string) =>
  (
    await ownerPool.query(
      `select a.id, a.application_no, a.status::text, a.amount_txn, a.payee_bank_account_id from ap_invoice i join payment_application a on a.id = i.advance_application_id where i.id = $1`,
      [invoiceId],
    )
  ).rows[0] as { id: string; application_no: string; status: string; amount_txn: string; payee_bank_account_id: string | null } | undefined;

const statusOf = async (id: string) => (await ownerPool.query(`select status::text from payment_application where id = $1`, [id])).rows[0].status as string;
const papers = async (id: string) =>
  (await ownerPool.query(`select kind from payment_application_paper where payment_application_id = $1 order by created_at`, [id])).rows.map((row) => row.kind as string);
const log = async (payableId: string) =>
  (await ownerPool.query(`select event_code, summary from payable_event where payable_id = $1 order by recorded_at`, [payableId])).rows as { event_code: string; summary: string }[];

const addPaper = (actor: ActorContext, id: string, input: Omit<applications.PaperInput, 'fileName' | 'content'>) =>
  withScope(scope(actor), (tx) => applications.addPaper(tx, actor, id, { ...input, fileName: `${input.kind}.pdf`, content: paper }));

async function blAndContainer(payableId: string) {
  await withScope(scope(world.clerk), (tx) =>
    shipments.createBl(tx, world.clerk, {
      payableId,
      blNo: `MEDU${randomUUID().slice(0, 6)}`,
      blDate: '2026-09-20',
      eta: '2026-10-25',
      portOfDischargeCode: 'PRT-0001',
      containers: 'MSCU1234566',
      spreadLines: true,
    }),
  );
  const { rows } = await ownerPool.query(
    `select c.id, l.id as line_id from shipment_container c join shipment_container_line l on l.container_id = c.id and l.superseded_at is null where c.payable_id = $1`,
    [payableId],
  );
  return { containerId: rows[0].id as string, lineId: rows[0].line_id as string };
}

const receive = (containerId: string, lineId: string) =>
  withScope(scope(world.clerk), (tx) =>
    shipments.receive(tx, world.clerk, {
      documentId: randomUUID(),
      containerId,
      warehouseCode: WAREHOUSE,
      receiptDate: '2026-10-28',
      lines: [{ containerLineId: lineId, receivedQty: q('100'), damagedQty: q('0') }],
      varianceReason: null,
    }),
  );

beforeEach(async () => {
  // Who may read an application's files is registered on first use, as the screen's action does.
  registerAllRecords();
  world = await buildTradingWorld();
  approver = await secondApprover();
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

describe('ADV1 · an advance holds the goods until its application is paid', () => {
  it('held at posting; draft → sent for approval → approved → sent paper → paid paper; then In Process and received', async () => {
    const { invoiceId, payableId } = await importInvoice('ADV1-0001', { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
    await post(invoiceId);

    // The goods wait in On Process (Without SWIFT), nothing in In Process.
    expect(await held(HOLD)).toBe('100.000000');
    expect(await held(IN_PROCESS)).toBe('0.000000');
    // The application is a draft of 20% — 200,000 — with the supplier's verified account.
    const app = (await applicationOf(invoiceId))!;
    expect(app).toMatchObject({ status: 'draft', amount_txn: '200000.0000' });
    expect(app.payee_bank_account_id).toBeTruthy();
    const codes = (await log(payableId)).map((row) => row.event_code);
    expect(codes).toEqual(expect.arrayContaining(['ADVANCE_HELD', 'ADVANCE_RAISED']));

    // A B/L may be recorded; a container may not be received out of the hold.
    const { containerId, lineId } = await blAndContainer(payableId);
    expect(await rejection(receive(containerId, lineId))).toMatch(/still wait in On Process \(Without SWIFT\)/);

    // Draft → Send for approval → Approved, by somebody other than the poster.
    expect(await rejection(withScope(scope(approver), (tx) => applications.approve(tx, approver, app.id)))).toBeTruthy();
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, app.id));
    expect(await statusOf(app.id)).toBe('submitted');
    expect(await rejection(withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, app.id)))).toMatch(/cannot approve it/);
    await withScope(scope(approver), (tx) => applications.approve(tx, approver, app.id));
    expect(await statusOf(app.id)).toBe('approved');

    // A paid paper is not the next step of an approved application.
    expect(await rejection(addPaper(world.manager, app.id, { kind: 'paid', date: '2026-09-12', reference: 'MT103-1' }))).toMatch(/not its next step/);
    expect(await papers(app.id)).toEqual([]);

    // The bank's paper: waiting for the bank.
    await validatePd(payableId, 'ADV1-PD');
    await addPaper(world.manager, app.id, { kind: 'sent_to_bank', date: '2026-09-10', reference: 'BNK-77' });
    expect(await statusOf(app.id)).toBe('sent');
    expect(await held(HOLD)).toBe('100.000000');

    // Paid needs its reference; then the SWIFT copy: posted, and the goods move on.
    expect(await rejection(addPaper(world.manager, app.id, { kind: 'paid', date: '2026-09-12' }))).toMatch(/reference/);
    await addPaper(world.manager, app.id, { kind: 'paid', date: '2026-09-12', reference: 'MT103-0001' });
    expect(await statusOf(app.id)).toBe('confirmed');
    expect(await papers(app.id)).toEqual(['sent_to_bank', 'paid']);
    expect(await held(HOLD)).toBe('0.000000');
    expect(await held(IN_PROCESS)).toBe('100.000000');
    expect((await log(payableId)).map((row) => row.event_code)).toContain('ADVANCE_RELEASED');

    // And the import goes on as any other: the container is received into the warehouse.
    await receive(containerId, lineId);
    expect(await held(IN_PROCESS)).toBe('0.000000');
    expect(await held(WAREHOUSE)).toBe('100.000000');
  });
});

describe('ADV2 · a cancelled advance keeps the goods held; another paid one releases them', () => {
  it('cancelled: held, and the import is told; a second application paid: released', async () => {
    const { invoiceId, payableId } = await importInvoice('ADV2-0001', { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
    await post(invoiceId);
    const app = (await applicationOf(invoiceId))!;
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, app.id));
    await withScope(scope(approver), (tx) => applications.approve(tx, approver, app.id));

    expect(await rejection(addPaper(world.manager, app.id, { kind: 'rejected_cancelled' }))).toMatch(/Say why/);
    await addPaper(world.manager, app.id, { kind: 'rejected_cancelled', reason: 'The bank refused the beneficiary name' });
    expect(await statusOf(app.id)).toBe('cancelled');
    expect(await held(HOLD)).toBe('100.000000');
    const told = (await log(payableId)).filter((row) => row.event_code === 'ADVANCE_HELD').map((row) => row.summary);
    expect(told.some((summary) => /stay in .*On Process \(Without SWIFT\)/.test(summary))).toBe(true);

    // A second application, raised by hand on the import, paid: the goods move.
    const payee = (await ownerPool.query(`select id from partner_bank_account where partner_id = $1`, [world.supplierId])).rows[0].id as string;
    const second = await withScope(scope(world.clerk), (tx) =>
      applications.create(tx, world.clerk, { payableId, paymentMethodCode: SWIFT, bankCashAccountId: world.bankAccountId, payeeBankAccountId: payee, amountTxn: iqd('200000') }),
    );
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, second.id));
    await withScope(scope(world.manager), (tx) => applications.approve(tx, world.manager, second.id));
    await validatePd(payableId, 'ADV2-PD');
    await addPaper(world.manager, second.id, { kind: 'sent_to_bank', date: '2026-09-10' });
    await addPaper(world.manager, second.id, { kind: 'paid', date: '2026-09-12', reference: 'MT103-0002' });
    expect(await held(HOLD)).toBe('0.000000');
    expect(await held(IN_PROCESS)).toBe('100.000000');
  });
});

describe('ADV3 · what moves nothing, and an import with no advance', () => {
  it('an "other" paper keeps the status; no advance goes straight to In Process', async () => {
    const { invoiceId } = await importInvoice('ADV3-0001', { ...withAdvance, advancePaidFromAccountId: world.bankAccountId });
    await post(invoiceId);
    const app = (await applicationOf(invoiceId))!;
    await addPaper(world.manager, app.id, { kind: 'other' });
    expect(await statusOf(app.id)).toBe('draft');
    expect(await papers(app.id)).toEqual(['other']);
    expect(await rejection(addPaper(world.manager, app.id, { kind: 'nonsense' }))).toMatch(/Say what this paper is/);

    const plain = await importInvoice('ADV3-0002');
    await post(plain.invoiceId);
    expect(await held(HOLD)).toBe('100.000000'); // only ADV3-0001's
    expect(await held(IN_PROCESS)).toBe('100.000000'); // ADV3-0002 went straight there
  });
});

/*
 * 0411 (2026-10-06, by direction): "choose percentage select or amount …
 * automatically it should make the payment application; when that payment
 * application is completed, automatically from On Process it goes into In
 * Process". Both ways of agreeing the advance, end to end: the application is
 * raised for exactly the payable amount, and the paid paper releases the goods.
 */
describe('ADV4 · by percentage or by amount, the application is the payable amount and paid releases the goods', () => {
  const settle = async (payableId: string, appId: string, ref: string) => {
    await withScope(scope(world.clerk), (tx) => applications.submit(tx, world.clerk, appId));
    await withScope(scope(approver), (tx) => applications.approve(tx, approver, appId));
    await validatePd(payableId, `${ref}-PD`);
    await addPaper(world.manager, appId, { kind: 'sent_to_bank', date: '2026-09-10' });
    await addPaper(world.manager, appId, { kind: 'paid', date: '2026-09-12', reference: `MT103-${ref}` });
  };

  it('by percentage: 35% of IQD 1,000,000 is IQD 350,000; held, then In Process on paid', async () => {
    const { invoiceId, payableId } = await importInvoice('ADV4-PCT', {
      advanceBasis: 'percent',
      advancePercent: '35',
      advancePaymentMethodCode: SWIFT,
      advancePaidFromAccountId: world.bankAccountId,
    });
    expect((await ownerPool.query(`select advance_basis, advance_percent, advance_amount from ap_invoice where id = $1`, [invoiceId])).rows[0]).toEqual({
      advance_basis: 'percent',
      advance_percent: '35.0000',
      advance_amount: null,
    });
    await post(invoiceId);
    expect(await held(HOLD)).toBe('100.000000');
    const app = (await applicationOf(invoiceId))!;
    expect(app).toMatchObject({ status: 'draft', amount_txn: '350000.0000' });
    await settle(payableId, app.id, 'ADV4P');
    expect(await statusOf(app.id)).toBe('confirmed');
    expect(await held(HOLD)).toBe('0.000000');
    expect(await held(IN_PROCESS)).toBe('100.000000');
  });

  it('by amount: exactly IQD 250,000 asked of the bank; held, then In Process on paid', async () => {
    const { invoiceId, payableId } = await importInvoice('ADV4-AMT', {
      advanceBasis: 'amount',
      advanceAmount: '250000',
      advancePaymentMethodCode: SWIFT,
      advancePaidFromAccountId: world.bankAccountId,
    });
    expect((await ownerPool.query(`select advance_basis, advance_percent, advance_amount from ap_invoice where id = $1`, [invoiceId])).rows[0]).toEqual({
      advance_basis: 'amount',
      advance_percent: null,
      advance_amount: '250000.0000',
    });
    await post(invoiceId);
    expect(await held(HOLD)).toBe('100.000000');
    const app = (await applicationOf(invoiceId))!;
    expect(app).toMatchObject({ status: 'draft', amount_txn: '250000.0000' });
    expect((await log(payableId)).find((row) => row.event_code === 'ADVANCE_RAISED')!.summary).toMatch(/drafted for 250,000 IQD on /);
    await settle(payableId, app.id, 'ADV4A');
    expect(await statusOf(app.id)).toBe('confirmed');
    expect(await held(HOLD)).toBe('0.000000');
    expect(await held(IN_PROCESS)).toBe('100.000000');
  });

  it('never more than the invoice: above 100%, above the total, or nought is refused at entry; a draft line cannot shrink the total under the amount', async () => {
    expect(await rejection(importInvoice('ADV4-OVER-P', { advanceBasis: 'percent', advancePercent: '100.5' }))).toMatch(/more than 100% of the invoice/);
    expect(await rejection(importInvoice('ADV4-OVER-A', { advanceBasis: 'amount', advanceAmount: '1000000.0001' }))).toMatch(/cannot be more than the invoice/);
    expect(await rejection(importInvoice('ADV4-ZERO', { advanceBasis: 'amount', advanceAmount: '0' }))).toMatch(/more than nought/);
    expect(await rejection(importInvoice('ADV4-BAD', { advanceBasis: 'sometimes', advancePercent: '10' }))).toMatch(/not a way to agree an advance/);
    // The whole invoice is allowed.
    const all = await importInvoice('ADV4-ALL', { advanceBasis: 'amount', advanceAmount: '1000000' });
    expect((await ownerPool.query(`select advance_amount from ap_invoice where id = $1`, [all.invoiceId])).rows[0].advance_amount).toBe('1000000.0000');
    // No upfront payment: nothing kept.
    const none = await importInvoice('ADV4-NONE', { advanceBasis: 'none', advancePercent: '25', advancePaidFromAccountId: world.bankAccountId });
    expect((await ownerPool.query(`select advance_basis, advance_percent, advance_paid_from_account_id from ap_invoice where id = $1`, [none.invoiceId])).rows[0]).toEqual({
      advance_basis: null,
      advance_percent: null,
      advance_paid_from_account_id: null,
    });
  });
});
