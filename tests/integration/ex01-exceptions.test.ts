/**
 * Exception Center (platform phase, Agent 7) — the detectors, the sweep and
 * who may see what, against real documents.
 *
 * One world is built once: an import posted and overdue, a container past its
 * ETA, an import received and sold to a customer who has not paid, a bank
 * statement that nothing yet matches, a manual journal on the suppliers'
 * control account, stock below zero, a task past its date, an approval nobody
 * has answered, a PD about to expire. The tests then walk it in order:
 *
 *   EX1  every detector finds its own real thing — one finding each — a
 *        concurrent first sweep and a repeat make no duplicate, and the sweep
 *        writes nothing outside its own tables
 *   EX2  who sees what: the grant on the centre and on the thing it is about,
 *        the branch, the right to open the record (a task is its parties')
 *   EX3  critical and high findings are told once, to people who can open them
 *   EX4  acknowledging: a person, a note, audited; the database refuses every
 *        other way of changing the lifecycle
 *   EX5  the reads other screens use: `openFor`, `countsFor`, `byRecord`
 *   EX6  taking the cause away resolves the finding by itself, a detector that
 *        could not run resolves nothing, and bringing the cause back reopens
 *        the same finding with its road kept
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, rejection, seedBranch } from './setup';
import { BAGHDAD, PANEL, SECOND, WAREHOUSE, blWith, buildImportWorld, importOf, iqd, journal, q, receive, scope, type ImportWorld } from './logistics-fixture';
import { containerNo } from '../support/container-number';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { DETECTORS } from '@/server/domain/exceptions';
import { parseDecimal } from '@/server/domain/money';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import * as statements from '@/server/services/bank-statement';
import * as rec from '@/server/services/bank-reconciliation';
import * as coa from '@/server/services/chart-of-accounts';
import * as customs from '@/server/services/customs-pd';
import * as exceptions from '@/server/services/exceptions';
import * as tasks from '@/server/services/tasks';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const ERBIL = 'ERB';

interface Person extends ActorContext {
  readonly id: string;
  readonly name: string;
}

async function person(name: string, roles: readonly string[], branch = BAGHDAD): Promise<Person> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, branch]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  if (branch === BAGHDAD) await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch, id, name };
}

const as = <T>(p: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) =>
  withScope({ userId: p.principal.userId, branchCode: p.branchCode ?? BAGHDAD }, fn);

/** Every detector but the one that looks at the machine the test happens to run on. */
const ALL = DETECTORS.map((d) => d.code).filter((code) => code !== 'platform.system_health');
const sweep = (only: readonly string[] = ALL) => exceptions.sweep({ trigger: 'schedule', only });

interface Stored {
  readonly id: string;
  readonly no: string;
  readonly status: string;
  readonly severity: string;
  readonly subject: string;
  readonly title: string;
  readonly explanation: string;
  readonly record_type: string;
  readonly record_id: string;
  readonly record_label: string;
  readonly href: string;
  readonly branch_code: string | null;
  readonly owner_user_id: string | null;
  readonly occurrence: number;
  readonly facts: Record<string, unknown>;
  readonly evidence: { ref: string }[];
}
const stored = async (detector: string): Promise<Stored[]> =>
  (
    await ownerPool.query(
      `select id::text, exception_no as no, status, severity, subject, title, explanation, record_type, record_id, record_label, href, branch_code,
              owner_user_id::text, occurrence, facts, evidence
         from exception where detector = $1 order by exception_no`,
      [detector],
    )
  ).rows as Stored[];
const one = async (detector: string): Promise<Stored> => {
  const rows = await stored(detector);
  expect(rows, detector).toHaveLength(1);
  return rows[0]!;
};
const bySubject = async (detector: string, subject: string): Promise<Stored> => {
  const found = (await stored(detector)).filter((row) => row.subject === subject);
  expect(found, `${detector} ${subject}`).toHaveLength(1);
  return found[0]!;
};
const historyOf = async (id: string) =>
  (await ownerPool.query(`select event, from_status, to_status, actor_user_id::text as actor, note from exception_history where exception_id = $1 order by id`, [id])).rows as {
    event: string;
    from_status: string | null;
    to_status: string;
    actor: string | null;
    note: string | null;
  }[];
const statusOf = async (id: string) => (await ownerPool.query(`select status from exception where id = $1`, [id])).rows[0].status as string;
/** The exception numbers a person is shown, open and acknowledged. */
const seen = async (p: ActorContext) => new Set((await as(p, (tx) => exceptions.openFor(tx, p.principal, { limit: 200, includeAcknowledged: true }))).map((b) => b.no));

let world: ImportWorld;
let clerk: ActorContext; // raises things; the task's assignee
let other: Person; // an accountant with no part in the task
let shipper: Person; // logistics officer: the containers, not the books
let erbil: Person; // an accountant in another branch
let nobody: Person; // holds no role at all

let importA: { invoiceId: string; invoiceNo: string; payableId: string }; // overdue, nothing shipped
let delayedContainerId: string;
let saleId: string;
let taskNo: string;
let taskId: string;
let recNo: string;
let recId: string;
let statementLineIds: string[];
let bankLineIds: string[];
let approvalAccountId: string;
let pdId: string;
let before: Record<string, string>;
let auditMark = 0n;

/** An import posted, but not due until the end of the year — it is stock, not a debt that has been left. */
async function importDue(reference: string, dueDate: string) {
  const made = await importOf(world, '10', { reference, post: false });
  await ownerPool.query(`update ap_invoice set due_date = $2 where id = $1`, [made.invoiceId, dueDate]);
  await as(world.clerk, (tx) => ap.submit(tx, world.clerk, made.invoiceId));
  await as(world.manager, (tx) => ap.post(tx, world.manager, made.invoiceId));
  return made;
}

/** The business tables the sweep must never touch: row count and a digest of every row. */
const BUSINESS = [
  'ap_invoice',
  'ar_invoice',
  'payable',
  'journal_entry',
  'journal_line',
  'subledger_entry',
  'inventory_movement',
  'cost_layer',
  'shipment_container',
  'bank_reconciliation',
  'bank_statement',
  'task',
  'posting_rule',
  'workflow_instance',
  'customs_pd',
  'business_partner',
  'chart_of_account',
] as const;
async function snapshot(): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of BUSINESS) {
    const { rows } = await ownerPool.query(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${table} t`);
    result[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return result;
}

beforeAll(async () => {
  world = await buildImportWorld();
  registerAllRecords();
  registerAttachmentRuntime();
  await seedBranch(ERBIL, 'Erbil');
  clerk = world.clerk;
  other = await person('Other Accountant', ['accounting_officer']);
  shipper = await person('Logistics Officer', ['logistics_officer']);
  erbil = await person('Erbil Accountant', ['accounting_officer'], ERBIL);
  nobody = await person('Nobody', []);
  await person('System Operator', ['system_administrator']); // whom the sweep runs as (a script has no session)

  // 1. An import posted on 1 July, due on 1 September, nothing paid: a supplier's invoice left unpaid.
  importA = await importOf(world, '10', { reference: 'SI-EX-OVERDUE' });
  await as(world.clerk, (tx) => customs.register(tx, world.clerk, { payableId: importA.payableId, pdNo: 'PD-EX-1', registrationDate: '2026-07-02', expiryDate: '2026-10-10' }));
  pdId = (await ownerPool.query(`select id::text from customs_pd where pd_no = 'PD-EX-1'`)).rows[0].id;

  // 2. An import whose one container was due on 25 August and has not been received.
  const late = await importDue('SI-EX-LATE', '2026-12-31');
  const blLate = await blWith(world, late.payableId, [{ no: containerNo('MSCU', 740001), qty: '10' }], { eta: '2026-08-25' });
  delayedContainerId = blLate.containerIds[0]!;

  // 3. An import received on 28 August, two of its panels sold on the 29th to a customer who has not paid (due the 30th).
  const stock = await importDue('SI-EX-STOCK', '2026-12-31');
  const blStock = await blWith(world, stock.payableId, [{ no: containerNo('MSCU', 740002), qty: '10' }], { eta: '2026-08-25' });
  await receive(world, blStock.containerIds[0]!, { on: '2026-08-28' });
  const sale = await as(world.clerk, (tx) =>
    ar.createDirect(tx, world.clerk, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      invoiceDate: '2026-08-29',
      dueDate: '2026-08-30',
      lines: [{ itemCode: PANEL, quantity: q('2'), unitPriceIqd: iqd('15000'), warehouseCode: WAREHOUSE }],
    }),
  );
  saleId = sale.id;
  await as(world.manager, (tx) => ar.approve(tx, world.manager, saleId));
  await as(world.manager, (tx) => ar.post(tx, world.manager, saleId));

  // 4. A bank: 5,000,000 funded in January and 1,000 deposited in August; the statement shows both, nothing is matched.
  await journal(world, world.accounts.bank!, world.accounts.sales_revenue!, '1000.0000', '2026-08-20');
  const statement = await as(world.manager, (tx) =>
    statements.importStatement(tx, world.manager, {
      bankCashAccountId: world.bankAccountId,
      branchCode: BAGHDAD,
      periodFrom: '2026-08-01',
      periodTo: '2026-08-31',
      openingBalanceIqd: iqd('0'),
      closingBalanceIqd: iqd('5001000'),
      lines: [
        { lineNo: 1, bookingDate: '2026-08-05', valueDate: '2026-08-05', amountIqd: iqd('5000000'), reference: 'FUNDING', counterparty: null, description: 'Funding' },
        { lineNo: 2, bookingDate: '2026-08-20', valueDate: '2026-08-20', amountIqd: iqd('1000'), reference: 'DEP-1', counterparty: null, description: 'Deposit' },
      ],
    }),
  );
  const opened = await as(world.manager, (tx) => rec.open(tx, world.manager, statement.id));
  recId = opened.id;
  recNo = opened.reconciliationNo;
  statementLineIds = (await ownerPool.query(`select id::text from bank_statement_line where statement_id = $1 order by line_no`, [statement.id])).rows.map((r) => r.id as string);
  bankLineIds = (
    await ownerPool.query(
      `select l.id::text from journal_line l join journal_entry e on e.id = l.journal_entry_id where l.account_id = $1 and e.status = 'posted' order by e.posting_date, l.line_no`,
      [world.accounts.bank],
    )
  ).rows.map((r) => r.id as string);

  // 5. A manual journal on the suppliers' control account that names no supplier.
  await journal(world, world.accounts.supplier_payable!, world.accounts.expense!, '250000.0000', '2026-09-10');

  // 6. Stock below nothing: three panels written off a warehouse that never held any. The database refuses this through the
  //    application's door; it can only be damage left by a maintenance script with the triggers off, which is what is simulated.
  const maintenance = await ownerPool.connect();
  try {
    await maintenance.query(`set session_replication_role = replica`);
    await maintenance.query(
      `insert into inventory_movement (item_code, warehouse_code, branch_code, kind, quantity, movement_date, source_document_type, source_document_id, created_by)
       values ($1, $2, $3, 'write_off', -3, '2026-09-15', 'test', 'EX-NEG-1', $4)`,
      [PANEL, SECOND, BAGHDAD, world.manager.principal.userId],
    );
  } finally {
    await maintenance.query(`reset session_replication_role`);
    maintenance.release();
  }

  // 7. A task given to the clerk, due on the 20th of September.
  const made = await as(world.manager, (tx) => tasks.create(tx, world.manager, { title: 'Send the August statements', departmentCode: 'FIN', assigneeId: world.clerk.principal.userId }));
  taskNo = made.taskNo;
  taskId = made.id;
  await ownerPool.query(`update task set due_date = '2026-09-20' where id = $1`, [taskId]);

  // 8. An account raised for approval fifteen days ago and never answered.
  const parent = (await ownerPool.query(`select id from chart_of_account where code = 'A000001'`)).rows[0].id as string;
  const account = await as(world.clerk, (tx) => coa.createAccount(tx, world.clerk, { name: 'Exception centre test account', parentId: parent, currencyRestriction: 'IQD' }));
  approvalAccountId = account.id;
  await as(world.clerk, (tx) => coa.submitForApproval(tx, world.clerk, approvalAccountId));
  await ownerPool.query(`update workflow_instance set submitted_at = now() - interval '15 days' where document_id = $1`, [approvalAccountId]);

  before = await snapshot();
  auditMark = BigInt((await ownerPool.query(`select coalesce(max(id), 0)::text as id from audit_event`)).rows[0].id);
}, 420_000);

// ---------------------------------------------------------------------------
describe('EX1 · every detector finds its own real thing, once', () => {
  let first: [exceptions.SweepResult, exceptions.SweepResult];

  it('two sweeps at the same moment make one finding of each thing, and every detector runs', async () => {
    first = await Promise.all([sweep(), sweep()]);
    for (const result of first) expect(result.detectors.filter((d) => d.error), 'detector errors').toEqual([]);
    expect(first[0].created + first[1].created).toBeGreaterThan(8);
    const { rows } = await ownerPool.query(`select count(*)::int as n, count(distinct finding_key)::int as keys, count(distinct exception_no)::int as nos from exception`);
    expect(rows[0].n).toBe(rows[0].keys);
    expect(rows[0].n).toBe(rows[0].nos);
    expect(rows[0].n).toBe(first[0].created + first[1].created);
  });

  it('a bank reconciliation left open with a difference: the figures, the record and the way to it', async () => {
    const row = await one('accounting.bank_reconciliation_difference');
    expect(row).toMatchObject({ status: 'open', severity: 'high', subject: recNo, record_type: 'bank_reconciliation', record_id: recId, record_label: recNo, branch_code: BAGHDAD });
    expect(row.no).toMatch(/^EXC-\d+$/);
    expect(row.explanation).toContain(recNo);
    expect(parseDecimal(String(row.facts.differenceIqd), 4n)).toBe(parseDecimal('5001000', 4n));
    expect(row.facts.unmatchedStatementLines).toBe(2);
    expect(row.href).toMatch(/^\/treasury\/bank-reconciliation\//);
    expect(row.owner_user_id).toBe(world.manager.principal.userId);
    expect(row.evidence.length).toBe(4);
  });

  it('a control account that is not its sub-ledger: the suppliers, by the exact difference', async () => {
    const row = await one('accounting.control_account_difference');
    expect(row).toMatchObject({ severity: 'critical', record_type: 'chart_of_account', branch_code: null });
    expect(row.facts.side).toBe('supplier');
    expect(parseDecimal(String(row.facts.differenceIqd).replace('-', ''), 4n)).toBe(parseDecimal('250000', 4n));
    expect(row.evidence).toHaveLength(1);
  });

  it('a journal line on a control account that names nobody: found on the supplier side', async () => {
    const row = await one('payables.ledger_inconsistency');
    expect(row).toMatchObject({ severity: 'high', record_type: 'journal_entry' });
    expect(row.subject).toMatch(/\|no_subledger$/);
    expect((await stored('receivables.ledger_inconsistency')).length).toBe(0);
  });

  it('a posting role with no account: every unmapped line of a document is named once', async () => {
    const rows = await stored('accounting.posting_role_unmapped');
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.subject)).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.subject).toMatch(/^[a-z_]+\.[a-z_]+\|[a-z_]+$/);
      expect(row).toMatchObject({ record_type: 'posting_rule', href: '/finance/posting-mappings' });
      // The record is called by the document it belongs to, in words — not by its event code.
      expect(row.record_label, row.subject).not.toMatch(/[a-z]+_[a-z]+|[a-z]\.[a-z]/);
    }
    // The ones the fixture maps are not among them.
    expect(rows.map((r) => r.subject)).not.toContain('sales.ar_invoice|customer_receivable');
  });

  it('a customer who has not paid: one finding for the account, with the invoice as its evidence', async () => {
    const row = await one('receivables.overdue_exposure');
    expect(row).toMatchObject({ severity: 'low', subject: 'CUST-ALNOOR|BGW', record_type: 'business_partner', branch_code: BAGHDAD });
    expect(row.facts).toMatchObject({ partyCode: 'CUST-ALNOOR', invoices: 1, days: 35 });
    expect(row.evidence).toHaveLength(1);
  });

  it('a supplier left unpaid: the one import that is overdue, not the ones that are not', async () => {
    const row = await one('payables.overdue_exposure');
    expect(row).toMatchObject({ severity: 'medium', subject: 'SUP-JINKO|BGW', record_type: 'business_partner' });
    expect(row.facts).toMatchObject({ invoices: 1, days: 33 });
    expect(row.evidence.map((e) => e.ref)).toEqual([importA.invoiceNo]);
  });

  it('stock below zero: the warehouse and the item', async () => {
    const row = await one('inventory.negative_stock');
    expect(row).toMatchObject({ severity: 'high', subject: `${SECOND}|${PANEL}`, record_type: 'warehouse', record_id: SECOND, branch_code: BAGHDAD });
    expect(String(row.facts.quantityQty)).toMatch(/^-3/);
    expect(row.explanation).toContain(PANEL);
  });

  it('a container past its ETA and not received', async () => {
    const row = await one('logistics.container_delayed');
    expect(row).toMatchObject({ severity: 'critical', subject: delayedContainerId, record_type: 'shipment_container', record_id: delayedContainerId, branch_code: BAGHDAD });
    expect(row.facts).toMatchObject({ days: 40, etaDate: '2026-08-25' });
    expect(row.explanation).toContain('40');
  });

  it('a PD about to expire', async () => {
    const row = await one('logistics.customs_issue');
    expect(row).toMatchObject({ severity: 'medium', subject: pdId, record_type: 'customs_pd', record_id: pdId });
    expect(row.facts).toMatchObject({ pd: 'PD-EX-1', issue: 'expiring' });
  });

  it('a task past its date: the assignee owns it, and it is the task’s own record', async () => {
    const row = await one('tasks.overdue');
    expect(row).toMatchObject({ severity: 'high', subject: taskId, record_type: 'task', record_id: taskId, record_label: taskNo, owner_user_id: world.clerk.principal.userId });
    expect(row.facts).toMatchObject({ days: 14, task: taskNo });
  });

  it('an approval that has waited a fortnight', async () => {
    const row = await one('approvals.waiting_too_long');
    expect(row).toMatchObject({ severity: 'high', record_type: 'workflow_instance' });
    expect(row.facts.days).toBe(15);
  });

  it('the finding is worded for a reader: no raw codes, the figures in it', async () => {
    const { rows } = await ownerPool.query(`select exception_no, title, explanation from exception`);
    expect(rows.length).toBeGreaterThan(8);
    for (const row of rows) {
      expect(row.title.length, row.exception_no).toBeGreaterThan(8);
      expect(`${row.title} ${row.explanation}`, row.exception_no).not.toMatch(/\{|\}|undefined|\[object|NaN|[a-z]+_[a-z]+_[a-z]+/);
    }
  });

  it('a second sweep makes nothing new, keeps the first moment, and moves the last', async () => {
    const { rows: beforeRows } = await ownerPool.query(`select exception_no, first_detected_at, last_seen_at from exception order by exception_no`);
    const again = await sweep();
    expect(again.detectors.filter((d) => d.error)).toEqual([]);
    expect(again).toMatchObject({ created: 0, reopened: 0, resolved: 0, notified: 0 });
    const { rows: afterRows } = await ownerPool.query(`select exception_no, first_detected_at, last_seen_at from exception order by exception_no`);
    expect(afterRows.map((r) => r.exception_no)).toEqual(beforeRows.map((r) => r.exception_no));
    afterRows.forEach((row, i) => {
      expect(row.first_detected_at.getTime()).toBe(beforeRows[i].first_detected_at.getTime());
      expect(row.last_seen_at.getTime()).toBeGreaterThanOrEqual(beforeRows[i].last_seen_at.getTime());
    });
    // The first sweep's only entries in the history are the detections.
    const { rows: history } = await ownerPool.query(`select distinct event from exception_history`);
    expect(history.map((r) => r.event)).toEqual(['detected']);
  });

  it('wrote nothing to the business: no row of the ledgers, the stock, the shipments or the settings moved', async () => {
    expect(await snapshot()).toEqual(before);
    const { rows } = await ownerPool.query(`select distinct action from audit_event where id > $1 order by action`, [auditMark.toString()]);
    expect(rows.map((r) => r.action).filter((action: string) => !action.startsWith('exception.'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('EX2 · who sees what', () => {
  it('an accounting manager who is also the CEO sees the books, the containers and the tasks', async () => {
    const mine = await seen(world.manager);
    for (const detector of ['accounting.bank_reconciliation_difference', 'accounting.control_account_difference', 'logistics.container_delayed', 'payables.overdue_exposure', 'inventory.negative_stock', 'tasks.overdue']) {
      expect(mine.has((await one(detector)).no), detector).toBe(true);
    }
  });

  it('a task is its parties’: the assignee sees the finding, another accountant who may view tasks does not', async () => {
    const task = await one('tasks.overdue');
    expect((await seen(clerk)).has(task.no)).toBe(true);
    expect((await seen(other)).has(task.no)).toBe(false);
    // …but the other accountant sees what the books say.
    expect((await seen(other)).has((await one('accounting.bank_reconciliation_difference')).no)).toBe(true);
  });

  it('a logistics officer sees the containers and not the books', async () => {
    const mine = await seen(shipper);
    expect(mine.has((await one('logistics.container_delayed')).no)).toBe(true);
    for (const detector of ['accounting.bank_reconciliation_difference', 'receivables.overdue_exposure', 'payables.overdue_exposure', 'accounting.posting_role_unmapped', 'tasks.overdue']) {
      for (const row of await stored(detector)) expect(mine.has(row.no), `${detector} ${row.subject}`).toBe(false);
    }
  });

  it('another branch sees nothing of this one: only what belongs to the company as a whole', async () => {
    const mine = await seen(erbil);
    const { rows } = await ownerPool.query(`select exception_no, branch_code, detector from exception`);
    for (const row of rows) {
      if (row.branch_code === BAGHDAD) expect(mine.has(row.exception_no), row.detector).toBe(false);
    }
    // What the database lets the Erbil accountant read agrees with what the service shows.
    const direct = await as(erbil, (tx) => tx.execute(sql`select exception_no, branch_code from exception`));
    for (const row of (direct as unknown as { rows: { branch_code: string | null }[] }).rows) expect(row.branch_code).toBeNull();
  });

  it('a person with no role sees nothing, in the service and in the table', async () => {
    expect(await seen(nobody)).toEqual(new Set());
    expect(await as(nobody, (tx) => exceptions.countsFor(tx, nobody.principal))).toMatchObject({ total: 0 });
    const direct = await as(nobody, (tx) => tx.execute(sql`select count(*)::int as n from exception`));
    expect((direct as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(0);
    const { rows } = await ownerPool.query(`select exception_no from exception limit 1`);
    expect(await as(nobody, (tx) => exceptions.byNo(tx, nobody.principal, rows[0].exception_no))).toBeNull();
  });

  it('what one may not see one may not open, acknowledge or find by its number', async () => {
    const bank = await one('accounting.bank_reconciliation_difference');
    expect(await as(shipper, (tx) => exceptions.byNo(tx, shipper.principal, bank.no))).toBeNull();
    expect((await rejection(as(shipper, (tx) => exceptions.acknowledge(tx, shipper, bank.no, 'Looked at it')))).toLowerCase()).toContain('no exception');
    expect(await statusOf(bank.id)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
describe('EX3 · told once, to those who can open it', () => {
  const told = async (userId: string) =>
    (await ownerPool.query(`select n.event_type as kind, n.object_id as id from notification n where n.object_type = 'exception' and n.recipient_user_id = $1`, [userId])).rows as { kind: string; id: string }[];

  it('each critical and high finding is told once to each person who can open it, and nothing quieter is told at all', async () => {
    const { rows: dupes } = await ownerPool.query(
      `select recipient_user_id, object_id, count(*)::int as n from notification where object_type = 'exception' group by 1, 2 having count(*) > 1`,
    );
    expect(dupes).toEqual([]);
    const container = await one('logistics.container_delayed');
    const bank = await one('accounting.bank_reconciliation_difference');
    const manager = await told(world.manager.principal.userId);
    expect(manager.filter((n) => n.id === container.id)).toEqual([{ kind: 'exception.logistics', id: container.id }]);
    expect(manager.filter((n) => n.id === bank.id)).toEqual([{ kind: 'exception.accounting', id: bank.id }]);
    // Low and medium wait on the screen.
    const quiet = [(await one('receivables.overdue_exposure')).id, (await one('payables.overdue_exposure')).id, (await one('logistics.customs_issue')).id];
    const { rows } = await ownerPool.query(`select count(*)::int as n from notification where object_type = 'exception' and object_id = any($1::text[])`, [quiet]);
    expect(rows[0].n).toBe(0);
  });

  it('nobody is told of what they could not open', async () => {
    const container = await one('logistics.container_delayed');
    const bank = await one('accounting.bank_reconciliation_difference');
    const task = await one('tasks.overdue');
    const theirs = await told(shipper.id);
    expect(theirs.map((n) => n.id)).toContain(container.id);
    expect(theirs.map((n) => n.id)).not.toContain(bank.id);
    expect(theirs.map((n) => n.id)).not.toContain(task.id);
    expect((await told(other.id)).map((n) => n.id)).not.toContain(task.id);
    expect((await told(clerk.principal.userId)).map((n) => n.id)).toContain(task.id);
    expect(await told(erbil.id).then((rows) => rows.map((n) => n.id))).not.toContain(bank.id);
    expect(await told(nobody.id)).toEqual([]);
  });

  it('a repeated sweep tells no one again', async () => {
    const { rows: count } = await ownerPool.query(`select count(*)::int as n from notification where object_type = 'exception'`);
    const again = await sweep();
    expect(again.notified).toBe(0);
    const { rows: after } = await ownerPool.query(`select count(*)::int as n from notification where object_type = 'exception'`);
    expect(after[0].n).toBe(count[0].n);
  });

  it('the notice opens the exception, for whoever it was sent to', async () => {
    const container = await one('logistics.container_delayed');
    const { rows } = await ownerPool.query(`select context from notification where object_type = 'exception' and object_id = $1 limit 1`, [container.id]);
    expect(rows[0].context).toMatchObject({ reference: container.no, href: `/exceptions/${container.no}`, severity: 'critical', domain: 'logistics' });
  });
});

// ---------------------------------------------------------------------------
describe('EX4 · acknowledging', () => {
  it('needs a note, takes a person, and leaves the finding where it was', async () => {
    const container = await one('logistics.container_delayed');
    expect((await rejection(as(world.manager, (tx) => exceptions.acknowledge(tx, world.manager, container.no, '   ')))).toLowerCase()).toContain('note');
    await as(world.manager, (tx) => exceptions.acknowledge(tx, world.manager, container.no, 'The shipping line confirms arrival on 8 October.'));

    const { rows } = await ownerPool.query(`select status, acknowledged_by::text, acknowledgement_note, acknowledged_at, severity from exception where id = $1`, [container.id]);
    expect(rows[0]).toMatchObject({ status: 'acknowledged', acknowledged_by: world.manager.principal.userId, acknowledgement_note: 'The shipping line confirms arrival on 8 October.', severity: 'critical' });
    expect(rows[0].acknowledged_at).toBeInstanceOf(Date);
    const road = await historyOf(container.id);
    expect(road.map((h) => h.event)).toEqual(['detected', 'acknowledged']);
    expect(road[1]).toMatchObject({ from_status: 'open', to_status: 'acknowledged', actor: world.manager.principal.userId, note: 'The shipping line confirms arrival on 8 October.' });
    const { rows: audit } = await ownerPool.query(`select action, actor_user_id::text as actor from audit_event where object_type = 'exception' and object_id = $1 order by id`, [container.no]);
    expect(audit.map((a) => a.action)).toContain('exception.acknowledged');
  });

  it('a second acknowledgement, and one of a resolved finding, are refused', async () => {
    const container = await one('logistics.container_delayed');
    expect((await rejection(as(world.manager, (tx) => exceptions.acknowledge(tx, world.manager, container.no, 'Again')))).toLowerCase()).toContain('acknowledged already');
  });

  it('does not take it off the screen, only out of "needs attention"', async () => {
    const container = await one('logistics.container_delayed');
    const attention = await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { limit: 200 }));
    expect(attention.map((b) => b.no)).not.toContain(container.no);
    expect((await seen(world.manager)).has(container.no)).toBe(true);
    const counts = await as(world.manager, (tx) => exceptions.countsFor(tx, world.manager.principal));
    expect(counts.bySeverity.critical).toBe(attention.filter((b) => b.severity === 'critical').length);
    const listed = await as(world.manager, (tx) => exceptions.listForScreen(tx, world.manager.principal, { status: 'live' }));
    expect(listed.rows.map((r) => r.no)).toContain(container.no);
    const onlyOpen = await as(world.manager, (tx) => exceptions.listForScreen(tx, world.manager.principal, { status: 'open' }));
    expect(onlyOpen.rows.map((r) => r.no)).not.toContain(container.no);
  });

  it('a sweep that finds it again leaves it acknowledged and says nothing', async () => {
    const container = await one('logistics.container_delayed');
    const result = await sweep(['logistics.container_delayed']);
    expect(result).toMatchObject({ created: 0, reopened: 0, resolved: 0, notified: 0 });
    expect(await statusOf(container.id)).toBe('acknowledged');
  });

  it('the database lets no person resolve, re-grade, delete or rewrite what the sweep owns', async () => {
    const bank = await one('accounting.bank_reconciliation_difference');
    const attempt = (statement: ReturnType<typeof sql>) => rejection(as(world.manager, (tx) => tx.execute(statement)));
    expect(await attempt(sql`update exception set status = 'resolved', resolved_at = now() where id = ${bank.id}::uuid`)).toMatch(/./);
    expect(await attempt(sql`update exception set severity = 'low' where id = ${bank.id}::uuid`)).toMatch(/./);
    expect(await attempt(sql`update exception set explanation = 'It is fine.' where id = ${bank.id}::uuid`)).toMatch(/./);
    expect(await attempt(sql`delete from exception where id = ${bank.id}::uuid`)).toMatch(/./);
    expect(await attempt(sql`delete from exception_history where exception_id = ${bank.id}::uuid`)).toMatch(/./);
    expect(await attempt(sql`insert into exception_history (exception_id, event, to_status, to_severity) values (${bank.id}::uuid, 'detected', 'open', 'high')`)).toMatch(/./);
    expect(await statusOf(bank.id)).toBe('open');
    expect((await one('accounting.bank_reconciliation_difference')).explanation).toBe(bank.explanation);
  });

  it('a person acknowledges only through the door that asks for a note: the table refuses a bare status change', async () => {
    const control = await one('accounting.control_account_difference');
    const bare = await rejection(as(world.manager, (tx) => tx.execute(sql`update exception set status = 'acknowledged' where id = ${control.id}::uuid`)));
    expect(bare).toMatch(/./);
    expect(await statusOf(control.id)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
describe('EX5 · the reads other screens use', () => {
  it('openFor: the most severe first, filtered, and the brief the Dashboard draws', async () => {
    const list = await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { limit: 200 }));
    expect(list.length).toBeGreaterThan(8);
    const rank: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
    for (let i = 1; i < list.length; i++) expect(rank[list[i - 1]!.severity]).toBeGreaterThanOrEqual(rank[list[i]!.severity]!);
    const brief = list.find((b) => b.severity === 'critical')!;
    expect(Object.keys(brief).sort()).toEqual(expect.arrayContaining(['id', 'no', 'severity', 'domain', 'title', 'explanation', 'recordType', 'recordId', 'href', 'createdAt', 'ownerName']));
    expect(brief.href).toBe(`/exceptions/${brief.no}`);
    expect(new Date(brief.createdAt).toString()).not.toBe('Invalid Date');

    const critical = await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { minSeverity: 'critical', limit: 200 }));
    expect(critical.length).toBeGreaterThan(0);
    expect(critical.every((b) => b.severity === 'critical')).toBe(true);
    const logistics = await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { domain: 'logistics', limit: 200 }));
    expect(logistics.length).toBeGreaterThan(0);
    expect(logistics.every((b) => b.domain === 'logistics')).toBe(true);
    expect((await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { limit: 3 }))).length).toBe(3);
  });

  it('openFor words it in the reader’s language', async () => {
    const arabic = await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { limit: 5, locale: 'ar' }));
    expect(arabic.length).toBe(5);
    for (const brief of arabic) expect(brief.title, brief.no).toMatch(/[؀-ۿ]/);
  });

  it('countsFor agrees with what openFor lists', async () => {
    const counts = await as(world.manager, (tx) => exceptions.countsFor(tx, world.manager.principal));
    const list = await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { limit: 200 }));
    expect(counts.total).toBe(list.length);
    expect(Object.values(counts.bySeverity).reduce((a, b) => a + b, 0)).toBe(counts.total);
    expect(Object.values(counts.byDomain).reduce((a, b) => a + b, 0)).toBe(counts.total);
    for (const domain of ['accounting', 'receivables', 'payables', 'inventory', 'logistics', 'tasks', 'approvals']) {
      expect(counts.byDomain[domain as keyof typeof counts.byDomain], domain).toBe(list.filter((b) => b.domain === domain).length);
    }
  });

  it('byRecord: what is wrong with one record, for those who may open it', async () => {
    const forContainer = await as(world.manager, (tx) => exceptions.byRecord(tx, world.manager.principal, 'shipment_container', delayedContainerId));
    expect(forContainer).toHaveLength(1);
    expect(forContainer[0]).toMatchObject({ severity: 'critical', status: 'acknowledged', recordId: delayedContainerId });
    expect(await as(clerk, (tx) => exceptions.byRecord(tx, clerk.principal, 'task', taskId))).toHaveLength(1);
    expect(await as(other, (tx) => exceptions.byRecord(tx, other.principal, 'task', taskId))).toEqual([]);
    expect(await as(shipper, (tx) => exceptions.byRecord(tx, shipper.principal, 'bank_reconciliation', recId))).toEqual([]);
    expect(await as(nobody, (tx) => exceptions.byRecord(tx, nobody.principal, 'shipment_container', delayedContainerId))).toEqual([]);
  });

  it('the register reads the same rows, filtered, with the counts beside it', async () => {
    const page = await as(world.manager, (tx) => exceptions.listForScreen(tx, world.manager.principal, { domain: 'inventory', status: 'open' }));
    expect(page.rows.length).toBeGreaterThan(0);
    expect(page.rows.every((r) => r.domain === 'inventory' && r.status === 'open')).toBe(true);
    expect(page.total).toBe(page.rows.length);
    const mine = await as(clerk, (tx) => exceptions.listForScreen(tx, clerk.principal, { owner: 'me', status: 'all' }));
    expect(mine.rows.map((r) => r.recordType)).toEqual(['task']);
    const found = await as(world.manager, (tx) => exceptions.listForScreen(tx, world.manager.principal, { q: taskNo, status: 'all' }));
    expect(found.rows.map((r) => r.recordLabel)).toContain(taskNo);
  });

  it('the record page: the evidence, the road, the party and the way to the place where it is dealt with', async () => {
    const overdue = await one('payables.overdue_exposure');
    const detail = await as(world.manager, (tx) => exceptions.byNo(tx, world.manager.principal, overdue.no, { locale: 'en' }));
    expect(detail).toMatchObject({ no: overdue.no, status: 'open', partyCode: 'SUP-JINKO', partyName: 'Jinko Solar', branchCode: BAGHDAD });
    expect(detail!.evidence.map((e) => e.ref)).toEqual([importA.invoiceNo]);
    expect(detail!.evidence[0]).toMatchObject({ amount: '100000.0000', noteText: expect.stringContaining('33') });
    expect(detail!.actionHref).toMatch(/^\/payables\/open-items/);
    expect(detail!.history.map((h) => h.event)).toEqual(['detected']);
    const arabic = await as(world.manager, (tx) => exceptions.byNo(tx, world.manager.principal, overdue.no, { locale: 'ar' }));
    expect(arabic!.title).toMatch(/[؀-ۿ]/);
    expect(arabic!.evidence[0]!.noteText).toMatch(/[؀-ۿ]/);
  });
});

// ---------------------------------------------------------------------------
describe('EX6 · the cause goes away, and comes back', () => {
  const resolvedBy = async (detector: string) => (await stored(detector)).map((r) => r.status);

  it('a detector that could not run resolves nothing', async () => {
    const approval = await one('approvals.waiting_too_long');
    await ownerPool.query(`alter table workflow_step rename to workflow_step_away`);
    let result: exceptions.SweepResult;
    try {
      result = await sweep(['approvals.waiting_too_long']);
    } finally {
      await ownerPool.query(`alter table workflow_step_away rename to workflow_step`);
    }
    expect(result.detectors[0]).toMatchObject({ code: 'approvals.waiting_too_long', found: 0 });
    expect(result.detectors[0]!.error).toBeTruthy();
    expect(result.resolved).toBe(0);
    expect(await statusOf(approval.id)).toBe('open');
    // The next sweep answers the question again and keeps it.
    expect((await sweep(['approvals.waiting_too_long'])).resolved).toBe(0);
  });

  it('a container received: the acknowledged finding is resolved by itself, and the road says who', async () => {
    const container = await one('logistics.container_delayed');
    await receive(world, delayedContainerId, { on: '2026-10-02' });
    const result = await sweep(['logistics.container_delayed']);
    expect(result.resolved).toBe(1);
    expect(await resolvedBy('logistics.container_delayed')).toEqual(['resolved']);
    const road = await historyOf(container.id);
    expect(road.map((h) => h.event)).toEqual(['detected', 'acknowledged', 'resolved']);
    expect(road[2]).toMatchObject({ from_status: 'acknowledged', to_status: 'resolved', actor: null });
    const { rows } = await ownerPool.query(`select resolved_at from exception where id = $1`, [container.id]);
    expect(rows[0].resolved_at).toBeInstanceOf(Date);
    // A resolved finding is nobody's to act on.
    expect((await rejection(as(world.manager, (tx) => exceptions.acknowledge(tx, world.manager, container.no, 'Too late')))).toLowerCase()).toContain('resolved');
    expect((await as(world.manager, (tx) => exceptions.openFor(tx, world.manager.principal, { limit: 200 }))).map((b) => b.no)).not.toContain(container.no);
    expect((await as(world.manager, (tx) => exceptions.byRecord(tx, world.manager.principal, 'shipment_container', delayedContainerId)))).toEqual([]);
    // It stays on the register for the record.
    const all = await as(world.manager, (tx) => exceptions.listForScreen(tx, world.manager.principal, { status: 'resolved' }));
    expect(all.rows.map((r) => r.no)).toContain(container.no);
  });

  it('a bank reconciliation matched: the difference is gone and so is the finding', async () => {
    const row = await one('accounting.bank_reconciliation_difference');
    await as(world.manager, (tx) => rec.matchManually(tx, world.manager, recId, { statementLineIds: [statementLineIds[0]!], journalLineIds: [bankLineIds[0]!] }));
    await as(world.manager, (tx) => rec.matchManually(tx, world.manager, recId, { statementLineIds: [statementLineIds[1]!], journalLineIds: [bankLineIds[1]!] }));
    expect((await sweep(['accounting.bank_reconciliation_difference'])).resolved).toBe(1);
    expect(await statusOf(row.id)).toBe('resolved');
  });

  it('a task cancelled: gone from the overdue', async () => {
    const row = await one('tasks.overdue');
    await as(world.manager, (tx) => tasks.act(tx, world.manager, taskNo, 'cancel', { reason: 'The statements went out by post.' }));
    expect((await sweep(['tasks.overdue'])).resolved).toBe(1);
    expect(await statusOf(row.id)).toBe('resolved');
  });

  it('stock brought back to zero: negative stock and its layer mismatch are both gone', async () => {
    await ownerPool.query(
      `insert into inventory_movement (item_code, warehouse_code, branch_code, kind, quantity, movement_date, source_document_type, source_document_id, created_by)
       values ($1, $2, $3, 'count_adjustment', 3, '2026-09-16', 'test', 'EX-NEG-2', $4)`,
      [PANEL, SECOND, BAGHDAD, world.manager.principal.userId],
    );
    // The layer is not repaired by the centre, only seen: with the ledger at nothing and no layer, nothing is adrift.
    const result = await sweep(['inventory.negative_stock', 'inventory.layer_mismatch']);
    expect(result.resolved).toBe(2);
    expect(await resolvedBy('inventory.negative_stock')).toEqual(['resolved']);
  });

  it('a control account put right: resolved; the journal that named nobody stays a finding of its own', async () => {
    await journal(world, world.accounts.expense!, world.accounts.supplier_payable!, '250000.0000', '2026-09-11');
    const result = await sweep(['accounting.control_account_difference', 'payables.ledger_inconsistency']);
    expect(await resolvedBy('accounting.control_account_difference')).toEqual(['resolved']);
    expect(result.resolved).toBe(1);
    // The mirror journal is a second line without its sub-ledger entry: now there are two to look at, and none is hidden.
    expect((await stored('payables.ledger_inconsistency')).filter((r) => r.status === 'open')).toHaveLength(2);
  });

  it('a sale reversed: the customer’s overdue invoice is gone', async () => {
    const row = await one('receivables.overdue_exposure');
    await as(world.manager, (tx) => ar.reverse(tx, world.manager, saleId, { reason: 'Raised on the wrong customer.' }));
    expect((await sweep(['receivables.overdue_exposure'])).resolved).toBe(1);
    expect(await statusOf(row.id)).toBe('resolved');
  });

  it('a supplier invoice reversed: the supplier is no longer overdue', async () => {
    const row = await one('payables.overdue_exposure');
    await as(world.manager, (tx) => ap.reverse(tx, world.manager, importA.invoiceId, { reason: 'Billed twice.' }));
    expect((await sweep(['payables.overdue_exposure'])).resolved).toBe(1);
    expect(await statusOf(row.id)).toBe('resolved');
  });

  it('an approval answered: no longer waiting', async () => {
    const row = await one('approvals.waiting_too_long');
    await as(world.manager, (tx) => coa.approve(tx, world.manager, approvalAccountId));
    expect((await sweep(['approvals.waiting_too_long'])).resolved).toBe(1);
    expect(await statusOf(row.id)).toBe('resolved');
  });

  it('a posting role lost, found, mended, lost again: one finding, reopened, with the whole road', async () => {
    const subject = 'sales.ar_invoice|customer_receivable';
    expect((await stored('accounting.posting_role_unmapped')).map((r) => r.subject)).not.toContain(subject);

    await ownerPool.query(`update posting_rule set is_active = false where event_type = 'sales.ar_invoice' and line_role = 'customer_receivable'`);
    const created = await sweep(['accounting.posting_role_unmapped']);
    expect(created.created).toBe(1);
    const row = await bySubject('accounting.posting_role_unmapped', subject);
    expect(row).toMatchObject({ status: 'open', severity: 'high', occurrence: 1 });
    expect(row.facts).toMatchObject({ postingEvent: 'sales.ar_invoice', postingRole: 'customer_receivable', reason: 'missing' });

    await ownerPool.query(`update posting_rule set is_active = true where event_type = 'sales.ar_invoice' and line_role = 'customer_receivable'`);
    expect((await sweep(['accounting.posting_role_unmapped'])).resolved).toBe(1);
    expect(await statusOf(row.id)).toBe('resolved');

    await ownerPool.query(`update posting_rule set is_active = false where event_type = 'sales.ar_invoice' and line_role = 'customer_receivable'`);
    const again = await sweep(['accounting.posting_role_unmapped']);
    expect(again).toMatchObject({ created: 0, reopened: 1 });
    const reopened = await bySubject('accounting.posting_role_unmapped', subject);
    expect(reopened).toMatchObject({ id: row.id, no: row.no, status: 'open', occurrence: 2 });
    expect((await historyOf(row.id)).map((h) => h.event)).toEqual(['detected', 'resolved', 'reopened']);
    // A reopened finding is told again: it is a new occurrence of the trouble.
    const { rows } = await ownerPool.query(`select count(*)::int as n from notification where object_type = 'exception' and object_id = $1 and recipient_user_id = $2`, [row.id, world.manager.principal.userId]);
    expect(rows[0].n).toBe(2);

    await ownerPool.query(`update posting_rule set is_active = true where event_type = 'sales.ar_invoice' and line_role = 'customer_receivable'`);
  });

  it('the register keeps every number it ever gave: nothing resolved is deleted', async () => {
    const { rows } = await ownerPool.query(`select count(*)::int as n, count(*) filter (where status = 'resolved')::int as resolved from exception`);
    expect(rows[0].resolved).toBeGreaterThanOrEqual(8);
    expect(await rejection(ownerPool.query(`delete from exception where status = 'resolved'`))).toMatch(/./);
  });
});
