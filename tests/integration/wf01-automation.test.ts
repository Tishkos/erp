/**
 * Workflow Automation (platform phase, Agent 10) — the outbox, the runner and the
 * four shipped templates, against real documents and real events.
 *
 * One world is built once (an import, a posted sale not paid, people with and
 * without grants). The tests then walk it:
 *
 *   AU1  a rule is data: born off, versioned append-only, the closed vocabulary
 *        held by the database, administered by `automation` alone
 *   AU2  invoice over a threshold: the fact is only RECORDED in the submitting
 *        transaction, the runner then holds the invoice for a review that shows
 *        in My Approvals, and posting waits for it
 *   AU3  container past its ETA: an exception that resolves itself, a notice
 *        and a follow-up task
 *   AU4  task overdue: the assignee and, where permitted, the supervisor
 *   AU5  customer invoice overdue: a follow-up task and a notice to whoever raised it
 *   AU6  idempotency: a double dispatch, a replay, two days of the same
 *        lateness and concurrent runners do each thing once
 *   AU7  a failing action is contained, visible and retried; the business
 *        transaction commits regardless; a rule that keeps failing pauses
 *   AU8  the global switch and a disabled rule do nothing
 *   AU9  the intersection of the owner's reach and the action's own checks
 *   AU10 nothing automation does touches the ledger or the stock
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, rejection, seedBranch } from './setup';
import { BAGHDAD, PANEL, WAREHOUSE, blWith, buildImportWorld, importOf, iqd, q, receive, scope, type ImportWorld } from './logistics-fixture';
import { containerNo } from '../support/container-number';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { addBusinessDays, businessToday } from '@/server/domain/business-date';
import { registerAllRecords } from '@/server/records';
import * as ap from '@/server/services/ap-invoice';
import * as approvalCenter from '@/server/services/approval-center';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import * as automation from '@/server/services/automation';
import { dispatch } from '@/server/services/automation-dispatch';
import * as events from '@/server/services/automation-events';
import { runOnce } from '@/server/services/automation-runner';
import * as exceptions from '@/server/services/exceptions';
import { systemScope } from '@/server/services/notification-runner';
import * as tasks from '@/server/services/tasks';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const today = businessToday();

interface Person extends ActorContext {
  readonly id: string;
  readonly name: string;
}

let employeeSerial = 0;
async function person(name: string, roles: readonly string[], options: { manager?: Person; branch?: string } = {}): Promise<Person> {
  const id = randomUUID();
  const branch = options.branch ?? BAGHDAD;
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, branch]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code, is_manager) values ($1,'FIN',$2) on conflict do nothing`, [id, roles.includes('accounting_manager')]);
  employeeSerial += 1;
  const manager = options.manager
    ? (await ownerPool.query(`select id from employee where app_user_id = $1`, [options.manager.id])).rows[0]?.id ?? null
    : null;
  await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, manager_employee_id, created_by)
     values ($1,$2,$3,'FIN','2024-01-01',$4,$5,$4)`,
    [`E-AU-${employeeSerial}`, name, branch, id, manager],
  );
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch, id, name };
}

const as = <T>(p: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope({ userId: p.principal.userId, branchCode: p.branchCode }, fn);

let world: ImportWorld;
let owner: Person; // the accounting manager who is also the CEO: administers automation, may raise tasks and exceptions, holds submit and approve
let clerk: Person; // keys the invoices; the assignee of tasks; no automation grant
let supervisor: Person; // the clerk's manager (the HR link)
let reviewer: Person; // a second accounting manager: the review step's role
let sysadmin: Person; // administers automation, but opens no purchase invoices
let limited: Person; // administers automation and opens containers, but may not raise a task
let outsider: Person; // no role at all
let elsewhere: Person; // an accounting manager of another branch: holds the grants, may not open this branch's records

const sample = { thresholdIqd: '1000000', notifyRole: 'accounting_manager', note: 'Large invoice' } as const;

const create = (p: Person, templateCode: string, name: string, params: Record<string, string | undefined>) => as(p, (tx) => automation.createFromTemplate(tx, p, { templateCode, name, params }));
const enable = (p: Person, ruleNo: string) => as(p, (tx) => automation.enable(tx, p, ruleNo));
const disable = (p: Person, ruleNo: string, reason = 'Not needed right now') => as(p, (tx) => automation.disable(tx, p, ruleNo, reason));
const ruleRow = async (ruleNo: string) => (await ownerPool.query(`select * from automation_rule where rule_no = $1`, [ruleNo])).rows[0];
const runsOf = async (ruleNo: string) =>
  (
    await ownerPool.query(
      `select x.id::text, x.attempt, x.outcome, x.reason, x.results, x.planned, x.rule_version, x.owner_user_id::text as owner, x.subject_key, x.event_id::text
         from automation_run x join automation_rule r on r.id = x.rule_id where r.rule_no = $1 order by x.id`,
      [ruleNo],
    )
  ).rows as { id: string; attempt: number; outcome: string; reason: string; results: { index: number; kind: string; status: string; detail: string; ref?: string }[]; planned: unknown[]; rule_version: number; owner: string; subject_key: string; event_id: string }[];
const eventsOf = async (key: string) =>
  (await ownerPool.query(`select id::text, subject_key, window_key, episode_key, status, attempts, rules_seen, rules_matched, payload, last_error from automation_event where event_key = $1 order by id`, [key])).rows as {
    id: string;
    subject_key: string;
    window_key: string;
    episode_key: string;
    status: string;
    attempts: number;
    rules_seen: number;
    rules_matched: number;
    payload: Record<string, unknown>;
    last_error: string | null;
  }[];
const noticesOf = async (kind: string) => (await ownerPool.query(`select recipient_user_id::text as who, object_id, subject from notification where event_type = $1 order by id`, [kind])).rows as { who: string; object_id: string; subject: string }[];
const auditOf = async (action: string) => (await ownerPool.query(`select actor_user_id::text as actor, object_id, reason from audit_event where action = $1 order by id`, [action])).rows as { actor: string; object_id: string; reason: string | null }[];
const count = async (table: string, where = 'true') => Number((await ownerPool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n);

/** Business tables automation must never write: row count and digest. */
const LEDGER = ['journal_entry', 'journal_line', 'subledger_entry', 'inventory_movement', 'cost_layer', 'payment_application', 'supplier_payment', 'customer_receipt', 'stock_transfer', 'stock_adjustment'] as const;
async function ledgerDigest(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of LEDGER) {
    const { rows } = await ownerPool.query(`select count(*)::int as n, coalesce(md5(string_agg(t::text, '|' order by t::text)), '') as h from ${table} t`);
    out[table] = `${rows[0].n}:${rows[0].h}`;
  }
  return out;
}

/** Runs the runner and shows it moved nothing in the books, the stock or the payments. */
async function drain(options?: Parameters<typeof runOnce>[0]) {
  const was = await ledgerDigest();
  const summary = await runOnce(options);
  expect(await ledgerDigest(), 'the runner changed the ledger, the stock or the payments').toEqual(was);
  return summary;
}

/** Records one business day's sweep events (for the events named, or all). */
async function sweepDay(day: string, only?: readonly events.ProduceResult['event'][]) {
  const sys = await systemScope();
  return withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), day, only));
}

/** Switches off every rule that is on, so a scenario starts with only its own. (Direct SQL: the guard stamps the rest.) */
const quiesce = () => ownerPool.query(`update automation_rule set enabled = false where enabled`);

/** A purchase invoice keyed by the clerk and submitted; `price` per panel. */
async function submittedInvoice(quantity: string, price: string, reference?: string) {
  const made = await importOf(world, quantity, { reference: reference ?? `AU-${randomUUID().slice(0, 6)}`, post: false, price });
  await as(clerk, (tx) => ap.submit(tx, clerk, made.invoiceId));
  return made;
}
const statusOf = async (invoiceId: string) => (await ownerPool.query(`select status::text as s from ap_invoice where id = $1`, [invoiceId])).rows[0].s as string;
const openReviews = async (invoiceId: string) => count('workflow_instance', `document_type_code = 'ap_invoice' and document_id = '${invoiceId}' and not is_complete`);

let before: Record<string, string>;
let savedLate: { containerId: string; payableId: string };
let overdueSale: { id: string; no: string };

/** A fault injected for AU7 must never outlive a failed run: the next run would start broken. */
const clearFault = () => ownerPool.query(`drop trigger if exists au_boom on workflow_instance; drop trigger if exists au_boom_event on automation_event; drop function if exists au_boom();`);
afterAll(clearFault);

beforeAll(async () => {
  await clearFault();
  world = await buildImportWorld();
  registerAllRecords();
  registerAttachmentRuntime();
  owner = { principal: world.manager.principal, branchCode: BAGHDAD, id: world.manager.principal.userId, name: 'Owner' };
  await ownerPool.query(`insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, created_by) values ('E-AU-0','Owner',$1,'FIN','2024-01-01',$2,$2)`, [BAGHDAD, owner.id]);
  supervisor = await person('Sami Supervisor', ['accounting_manager']);
  clerk = { ...(await person('Clerk Report', ['accounting_officer'], { manager: supervisor })), principal: world.clerk.principal };
  // the fixture's own clerk is the person keying invoices; give them an employee record under the supervisor
  await ownerPool.query(`insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, manager_employee_id, created_by)
                         values ('E-AU-C','Fixture Clerk',$1,'FIN','2024-01-01',$2,(select id from employee where app_user_id = $3),$2)`, [BAGHDAD, world.clerk.principal.userId, supervisor.id]);
  clerk = { principal: world.clerk.principal, branchCode: BAGHDAD, id: world.clerk.principal.userId, name: 'Fixture Clerk' };
  reviewer = await person('Rita Reviewer', ['accounting_manager']);
  sysadmin = await person('Sys Admin', ['system_administrator']);
  outsider = await person('Nobody', []);
  if ((await ownerPool.query(`select 1 from branch where code = 'AUX'`)).rows.length === 0) await seedBranch('AUX', 'Another branch');
  elsewhere = await person('Elsa Elsewhere', ['accounting_manager'], { branch: 'AUX' });
  await ownerPool.query(`insert into role (code, name, is_system) values ('automation_limited','Automation, no tasks',false)`);
  for (const [object, verb] of [['automation', 'view'], ['automation', 'administer'], ['shipment_container', 'view'], ['exception', 'view'], ['exception', 'execute'], ['exception', 'administer'], ['task', 'view']] as const) {
    await ownerPool.query(`insert into role_grant (role_code, object, verb) values ('automation_limited', $1, $2::permission_verb)`, [object, verb]);
  }
  limited = await person('Limited Admin', ['automation_limited']);
  await person('System Operator', ['system_administrator']); // whom the runner runs as (a script has no session)

  // A container due on 25 August and not received; another not due until the end of the year.
  const late = await importOf(world, '10', { reference: 'AU-LATE' });
  const blLate = await blWith(world, late.payableId, [{ no: containerNo('MSCU', 760001), qty: '10' }], { eta: '2026-08-25' });
  savedLate = { containerId: blLate.containerIds[0]!, payableId: late.payableId };
  const early = await importOf(world, '10', { reference: 'AU-NOT-LATE' });
  await blWith(world, early.payableId, [{ no: containerNo('MSCU', 760002), qty: '10' }], { eta: addBusinessDays(today, 120) });

  // Stock received and two panels sold, due on 30 August, never paid.
  const stock = await importOf(world, '10', { reference: 'AU-STOCK' });
  const blStock = await blWith(world, stock.payableId, [{ no: containerNo('MSCU', 760003), qty: '10' }], { eta: '2026-08-25' });
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
  await as(world.manager, (tx) => ar.approve(tx, world.manager, sale.id));
  await as(world.manager, (tx) => ar.post(tx, world.manager, sale.id));
  overdueSale = { id: sale.id, no: (await ownerPool.query(`select invoice_no from ar_invoice where id = $1`, [sale.id])).rows[0].invoice_no };

  // A task given to the clerk, due on 20 September.
  before = await ledgerDigest();
}, 420_000);

// ---------------------------------------------------------------------------
describe('AU1 · a rule is data, built from a template and administered by one permission', () => {
  it('is born off, on its first version, owned by whoever made it, with every parameter kept as typed', async () => {
    const made = await create(owner, 'invoice_over_threshold', 'Invoices over a million', { thresholdIqd: '1,000,000', notifyRole: 'accounting_manager', note: 'Large invoice' });
    expect(made.ruleNo).toMatch(/^AUT-\d{3}$/);
    const row = await ruleRow(made.ruleNo);
    expect(row).toMatchObject({ enabled: false, current_version: 1, owner_user_id: owner.id, consecutive_failures: 0, event_key: 'ap_invoice.submitted', template_code: 'invoice_over_threshold' });
    expect(row.enabled_at).toBeNull();
    const [version] = (await ownerPool.query(`select params, conditions, actions from automation_rule_version where rule_id = $1`, [row.id])).rows;
    expect(version.params).toMatchObject({ thresholdIqd: '1000000.0000', notifyRole: 'accounting_manager' });
    expect(version.conditions).toEqual([{ field: 'amountIqd', op: 'gte', value: '1000000.0000' }]);
    expect(version.actions.map((a: { kind: string }) => a.kind)).toEqual(['request_approval', 'open_workflow']);
    expect((await auditOf('automation.rule_created')).map((a) => a.object_id)).toContain(made.ruleNo);
  });

  it('has no firing default: a template without its numbers is refused, and a made-up value is told what is wrong', async () => {
    await expect(create(owner, 'invoice_over_threshold', 'No threshold', { notifyRole: 'accounting_manager' })).rejects.toThrow(/thresholdIqd: required/);
    await expect(create(owner, 'container_eta_exceeded', 'Zero days', { daysLate: '0', severity: 'high', notifyRole: 'logistics_officer' })).rejects.toThrow(/at least 1/);
    await expect(create(owner, 'task_overdue', 'Nobody told', { daysLate: '2' })).rejects.toThrow(/Choose who is told/);
    await expect(create(owner, 'invoice_over_threshold', 'Bad role', { thresholdIqd: '10', notifyRole: 'no_such_role' })).rejects.toThrow(/no role "no_such_role"/);
    await expect(create(owner, 'does_not_exist', 'Unknown template', {})).rejects.toThrow(/not a rule template/);
  });

  it('is changed by a new version, never in place: the old one stays, the new editor owns the rule, a run names its version', async () => {
    const made = await create(owner, 'invoice_over_threshold', 'To be changed', sample as unknown as Record<string, string>);
    await expect(as(owner, (tx) => automation.change(tx, owner, made.ruleNo, { name: 'To be changed', params: { thresholdIqd: '1000000', notifyRole: 'accounting_manager', note: 'Large invoice' } }))).rejects.toThrow(/Nothing was changed/);
    const changed = await as(owner, (tx) => automation.change(tx, owner, made.ruleNo, { name: 'To be changed', params: { thresholdIqd: '2500000', notifyRole: 'accounting_manager', note: 'Larger' }, note: 'Raised the line' }));
    expect(changed.version).toBe(2);
    const versions = (await ownerPool.query(`select version, params from automation_rule_version v join automation_rule r on r.id = v.rule_id where r.rule_no = $1 order by version`, [made.ruleNo])).rows;
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0].params.thresholdIqd).toBe('1000000.0000');
    expect(versions[1].params.thresholdIqd).toBe('2500000.0000');
    expect((await ruleRow(made.ruleNo)).current_version).toBe(2);
    expect((await auditOf('automation.rule_changed')).length).toBeGreaterThan(0);
  });

  it('holds its vocabulary at the database: an unknown event, action, operator, key or recipient cannot be stored, a version cannot be edited, nothing is deleted', async () => {
    const made = await create(owner, 'task_overdue', 'Vocabulary', { daysLate: '3', notifyAssignee: 'on' });
    const row = await ruleRow(made.ruleNo);
    const insert = (conditions: unknown, actions: unknown) =>
      ownerPool.query(`insert into automation_rule_version (rule_id, version, event_key, name, template_code, params, conditions, actions, changed_by) values ($1, 2, 'task.overdue', 'x', 'task_overdue', '{}'::jsonb, $2::jsonb, $3::jsonb, $4)`, [row.id, JSON.stringify(conditions), JSON.stringify(actions), owner.id]);
    const notify = [{ kind: 'create_notification', recipients: [{ kind: 'record_assignee' }] }];
    expect(await rejection(insert([], [{ kind: 'post_journal' }]))).toMatch(/not something a rule can do/);
    expect(await rejection(insert([], [{ kind: 'create_notification', sql: 'select 1' }]))).toMatch(/an action has no "sql"/);
    expect(await rejection(insert([], [{ kind: 'create_notification', recipients: [{ kind: 'everybody' }] }]))).toMatch(/not a kind of recipient/);
    expect(await rejection(insert([{ field: 'daysLate', op: 'matches', value: 1 }], notify))).toMatch(/not an operator/);
    expect(await rejection(insert([{ field: 'daysLate', op: 'gte', value: 1, expr: '1=1' }], notify))).toMatch(/a condition has no "expr"/);
    expect(await rejection(ownerPool.query(`insert into automation_rule (rule_no, event_key, template_code, name, owner_user_id, created_by) values ('AUT-999','invoice.deleted','task_overdue','x y z',$1,$1)`, [owner.id]))).toMatch(/automation_rule_event_known/);
    expect(await rejection(ownerPool.query(`update automation_rule_version set name = 'edited' where rule_id = $1`, [row.id]))).toMatch(/append-only|cannot be/i);
    expect(await rejection(ownerPool.query(`delete from automation_rule where id = $1`, [row.id]))).toMatch(/never deleted/);
    expect(await rejection(ownerPool.query(`update automation_rule set enabled = true where id = $1`, [row.id]))).toMatch(/automation_rule_enabled_stamped|enabled/);
  });

  it('is administered by `automation` alone: a clerk and an outsider can neither build nor see, and see nothing', async () => {
    await expect(create(clerk, 'task_overdue', 'By a clerk', { daysLate: '1', notifyAssignee: 'on' })).rejects.toThrow(/Permission denied/);
    await expect(enable(outsider, 'AUT-001')).rejects.toThrow(/Permission denied/);
    expect((await as(outsider, (tx) => automation.listRules(tx, outsider.principal))).rows).toEqual([]);
    expect(await as(outsider, (tx) => automation.byNo(tx, outsider.principal, 'AUT-001'))).toBeNull();
    expect((await as(owner, (tx) => automation.listRules(tx, owner.principal))).rows.length).toBeGreaterThan(2);
    // The database says the same for a session that bypasses the service: the clerk reads no row of the automation tables.
    for (const table of ['automation_rule', 'automation_rule_version', 'automation_event', 'automation_run', 'automation_setting']) {
      const seen = await withScope({ userId: clerk.id, branchCode: BAGHDAD }, async (tx) => (await tx.execute(`select count(*)::int as n from ${table}` as never)).rows[0] as { n: number });
      expect(seen.n, table).toBe(0);
    }
  });

  it('refuses to build on what the builder cannot open, and to enable what the builder could not do by hand', async () => {
    await expect(create(sysadmin, 'invoice_over_threshold', 'By an administrator', sample as unknown as Record<string, string>)).rejects.toThrow(/may not open ap invoice/);
    // `limited` may open containers and raise exceptions but not a task: a follow-up still builds, and runs without it (AU9).
    const made = await create(sysadmin, 'task_overdue', 'Sys admin rule', { daysLate: '1', notifyAssignee: 'on' });
    const row = await ruleRow(made.ruleNo);
    expect(row.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('AU2 · an invoice over the threshold waits for a second person, and shows in My Approvals', () => {
  let ruleNo: string;
  let big: { invoiceId: string; invoiceNo: string };
  let small: { invoiceId: string; invoiceNo: string };

  it('records nothing while nobody is listening: a submission with no enabled rule writes no outbox row', async () => {
    const made = await create(owner, 'invoice_over_threshold', 'Over a million', sample as unknown as Record<string, string>);
    ruleNo = made.ruleNo;
    const quiet = await submittedInvoice('5', '10000');
    expect(await statusOf(quiet.invoiceId)).toBe('submitted');
    expect(await eventsOf('ap_invoice.submitted')).toEqual([]);
  });

  it('enabling stamps the moment and makes the enabler the owner; an event before it is not acted on', async () => {
    await enable(owner, ruleNo);
    const row = await ruleRow(ruleNo);
    expect(row).toMatchObject({ enabled: true, owner_user_id: owner.id, enabled_by: owner.id });
    expect(row.enabled_at).not.toBeNull();
    await expect(enable(owner, ruleNo)).rejects.toThrow(/already on/);
  });

  it('a submission only RECORDS the fact in its own transaction: the invoice is submitted, the event waits, nothing else has happened', async () => {
    big = await submittedInvoice('200', '10000', 'AU-BIG-1'); // 2,000,000
    small = await submittedInvoice('10', '10000', 'AU-SMALL-1'); // 100,000
    expect(await statusOf(big.invoiceId)).toBe('submitted');
    const pending = await eventsOf('ap_invoice.submitted');
    expect(pending.map((e) => e.status)).toEqual(['pending', 'pending']);
    expect(pending[0]!.payload).toMatchObject({ reference: big.invoiceNo, amountIqd: '2000000.0000', branchCode: BAGHDAD, raisedBy: world.clerk.principal.userId });
    expect(pending[1]!.payload.amountIqd).toBe('100000.0000');
    expect(await openReviews(big.invoiceId)).toBe(0);
    expect(await noticesOf('automation.ap_invoice_submitted')).toEqual([]);
    expect(await runsOf(ruleNo)).toEqual([]);
  });

  it('the runner holds the big one for review and tells the role, and leaves the small one alone with its reason in the log', async () => {
    const run = await drain();
    expect(run.events).toBe(2);
    expect(run.runs).toMatchObject({ done: 1, skipped: 1, failed: 0 });
    const runs = await runsOf(ruleNo);
    expect(runs).toHaveLength(2);
    const done = runs.find((r) => r.outcome === 'done')!;
    const skipped = runs.find((r) => r.outcome === 'skipped')!;
    expect(done).toMatchObject({ rule_version: 1, owner: owner.id, attempt: 1, subject_key: `ap_invoice:${big.invoiceId}` });
    expect(done.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['request_approval:done', 'open_workflow:done']);
    expect(done.planned).toHaveLength(2);
    expect(skipped.reason).toMatch(/Conditions not met: amountIqd is 100000\.0000; the rule needs at least 1000000\.0000/);
    expect(skipped.subject_key).toBe(`ap_invoice:${small.invoiceId}`);
    expect(await openReviews(big.invoiceId)).toBe(1);
    expect(await openReviews(small.invoiceId)).toBe(0);
    // Told, once each, the people of the role who may open the invoice; the log of the rule itself.
    const told = await noticesOf('automation.ap_invoice_submitted');
    expect(new Set(told.map((n) => n.who))).toEqual(new Set([owner.id, supervisor.id, reviewer.id]));
    // The accounting manager of another branch holds the role and not the record: not told, and the log says so.
    expect(told.map((n) => n.who)).not.toContain(elsewhere.id);
    expect(done.results[1]!.detail).toMatch(/Told 3 people.*1 person left out because they could not open it/);
    expect(told.every((n) => n.object_id === big.invoiceId)).toBe(true);
    const row = await ruleRow(ruleNo);
    expect(row).toMatchObject({ last_outcome: 'skipped', consecutive_failures: 0 });
    expect((await auditOf('automation.ran')).some((a) => a.object_id === ruleNo && a.actor === owner.id)).toBe(true);
    expect((await auditOf('ap_invoice.review_requested')).length).toBe(1);
  });

  it('the review is in My Approvals for the reviewer, with the amount, and not for the person who asked for it', async () => {
    const page = await as(reviewer, (tx) => approvalCenter.list(tx, { principal: reviewer.principal, branchCode: BAGHDAD }));
    const item = page.rows.find((r) => r.documentNo === big.invoiceNo)!;
    expect(item).toMatchObject({ source: 'workflow', documentType: 'ap_invoice', stage: 'role:accounting_manager', inline: { documentType: 'ap_invoice', documentId: big.invoiceId } });
    expect(item.amount).toEqual({ value: '2000000.0000', currency: 'IQD' });
    const mine = await as(owner, (tx) => approvalCenter.list(tx, { principal: owner.principal, branchCode: BAGHDAD }));
    // The owner holds post + approve, so the invoice would otherwise be a "post" row: while it is under review it is only the reviewer's.
    expect(mine.rows.find((r) => r.documentNo === big.invoiceNo)).toBeUndefined();
    const required = await ownerPool.query(`select recipient_user_id::text as who from notification where event_type = 'approval.required' and object_id = $1`, [big.invoiceId]);
    expect(required.rows.map((r) => r.who)).toEqual(expect.arrayContaining([reviewer.id, supervisor.id]));
    expect(required.rows.map((r) => r.who)).not.toContain(owner.id);
  });

  it('the invoice cannot be posted while the review is open, and the small one posts as ever', async () => {
    await expect(as(world.manager, (tx) => ap.post(tx, world.manager, big.invoiceId))).rejects.toThrow(/waiting for the review an automation rule asked for/);
    expect(await statusOf(big.invoiceId)).toBe('submitted');
    await as(world.manager, (tx) => ap.post(tx, world.manager, small.invoiceId));
    expect(await statusOf(small.invoiceId)).toBe('posted');
  });

  it('four eyes: neither the person who asked for the review nor the person who keyed the invoice can decide it', async () => {
    await expect(as(owner, (tx) => approvalCenter.decide(tx, { principal: owner.principal, branchCode: BAGHDAD }, { documentType: 'ap_invoice', documentId: big.invoiceId, decision: 'approve' }))).rejects.toThrow();
    await expect(as(clerk, (tx) => approvalCenter.decide(tx, { principal: clerk.principal, branchCode: BAGHDAD }, { documentType: 'ap_invoice', documentId: big.invoiceId, decision: 'approve' }))).rejects.toThrow();
    expect(await openReviews(big.invoiceId)).toBe(1);
  });

  it('the reviewer approves from the list; posting is then open, and it is the CEO’s act, not the review’s', async () => {
    await as(reviewer, (tx) => approvalCenter.decide(tx, { principal: reviewer.principal, branchCode: BAGHDAD }, { documentType: 'ap_invoice', documentId: big.invoiceId, decision: 'approve' }));
    expect(await openReviews(big.invoiceId)).toBe(0);
    expect(await statusOf(big.invoiceId)).toBe('submitted');
    expect((await auditOf('ap_invoice.review_approved')).map((a) => a.actor)).toEqual([reviewer.id]);
    await as(world.manager, (tx) => ap.post(tx, world.manager, big.invoiceId));
    expect(await statusOf(big.invoiceId)).toBe('posted');
  });

  it('a review that is refused sends the invoice back to draft with the reason, and tells whoever keyed it', async () => {
    const another = await submittedInvoice('150', '10000', 'AU-BIG-2');
    await drain();
    expect(await openReviews(another.invoiceId)).toBe(1);
    await expect(as(reviewer, (tx) => approvalCenter.decide(tx, { principal: reviewer.principal, branchCode: BAGHDAD }, { documentType: 'ap_invoice', documentId: another.invoiceId, decision: 'reject' }))).rejects.toThrow(/Say why/);
    await as(reviewer, (tx) => approvalCenter.decide(tx, { principal: reviewer.principal, branchCode: BAGHDAD }, { documentType: 'ap_invoice', documentId: another.invoiceId, decision: 'reject', reason: 'The quantity is not what was ordered' }));
    expect(await statusOf(another.invoiceId)).toBe('draft');
    expect(await openReviews(another.invoiceId)).toBe(0);
    const told = await ownerPool.query(`select recipient_user_id::text as who, body from notification where event_type = 'approval.rejected' and object_id = $1`, [another.invoiceId]);
    expect(told.rows.map((r) => r.who)).toContain(world.clerk.principal.userId);
    expect(told.rows[0].body).toBe('The quantity is not what was ordered');
  });

  it('a purchase invoice posted raises its own event for a rule that listens to it, with the amount posted, and only then', async () => {
    await quiesce(); // the review rule of the scenarios above is done with
    // No rule listens to ap_invoice.posted yet, so posting an invoice records nothing for it.
    const quietInvoice = await importOf(world, '3', { post: false, price: '10000' });
    await as(clerk, (tx) => ap.submit(tx, clerk, quietInvoice.invoiceId));
    await as(world.manager, (tx) => ap.post(tx, world.manager, quietInvoice.invoiceId));
    expect(await eventsOf('ap_invoice.posted')).toEqual([]);

    const made = await create(owner, 'invoice_posted_notice', 'Large invoices posted', { thresholdIqd: '1500000', notifyRole: 'accounting_manager', note: 'In the books' });
    await enable(owner, made.ruleNo);
    const large = await importOf(world, '200', { post: false, price: '10000' }); // 2,000,000
    const little = await importOf(world, '5', { post: false, price: '10000' }); // 50,000
    for (const doc of [large, little]) {
      await as(clerk, (tx) => ap.submit(tx, clerk, doc.invoiceId));
      await as(world.manager, (tx) => ap.post(tx, world.manager, doc.invoiceId));
    }
    const posted = await eventsOf('ap_invoice.posted');
    expect(posted).toHaveLength(2);
    expect(posted.find((e) => e.subject_key === `ap_invoice:${large.invoiceId}`)!.payload).toMatchObject({ amountIqd: '2000000.0000', reference: large.invoiceNo });
    await drain();
    const runs = await runsOf(made.ruleNo);
    expect(runs.map((r) => r.outcome).sort()).toEqual(['done', 'skipped']);
    expect(runs.find((r) => r.outcome === 'done')!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['create_notification:done']);
    const told = await noticesOf('automation.ap_invoice_posted');
    expect(new Set(told.map((n) => n.who))).toEqual(new Set([owner.id, supervisor.id, reviewer.id]));
    // A notice about a posting posts, holds and changes nothing: the invoice is exactly as it was.
    expect(await statusOf(large.invoiceId)).toBe('posted');
    expect(await openReviews(large.invoiceId)).toBe(0);
    await quiesce();
  });
});

// ---------------------------------------------------------------------------
describe('AU3 · a container past its ETA: an exception that keeps itself true, a notice, and a follow-up task', () => {
  let ruleNo: string;
  let exceptionNo: string;

  it('the morning sweep records the late container once; the container that is not late is not an event', async () => {
    const made = await create(owner, 'container_eta_exceeded', 'Containers late', {
      daysLate: '3',
      severity: 'high',
      notifyRole: 'accounting_manager',
      followUp: 'on',
      taskAssignee: clerk.id,
      taskDepartment: 'FIN',
      taskTitle: 'Chase the forwarder',
      taskPriority: 'high',
      taskDueInDays: '2',
      note: 'Ask for a new date',
    });
    ruleNo = made.ruleNo;
    await enable(owner, ruleNo);
    const sys = await systemScope();
    const first = await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today, ['container.eta_exceeded']));
    expect(first).toEqual([expect.objectContaining({ event: 'container.eta_exceeded', listening: true, read: 1, recorded: 1, problems: [] })]);
    const again = await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today, ['container.eta_exceeded']));
    expect(again[0]).toMatchObject({ read: 1, recorded: 0 });
    const [event] = await eventsOf('container.eta_exceeded');
    expect(event).toMatchObject({ subject_key: `shipment_container:${savedLate.containerId}`, window_key: `on:${today}`, episode_key: '2026-08-25', status: 'pending' });
    expect(event!.payload).toMatchObject({ reference: containerNo('MSCU', 760001), etaDate: '2026-08-25', branchCode: BAGHDAD });
    expect(Number(event!.payload.daysLate)).toBeGreaterThan(30);
  });

  it('the runner raises one exception, tells the role, and gives the clerk a task due in two days, linked to the container', async () => {
    const run = await drain();
    expect(run.runs).toMatchObject({ done: 1, failed: 0 });
    const [log] = await runsOf(ruleNo);
    expect(log!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['create_exception:done', 'create_notification:done', 'create_task:done']);
    exceptionNo = log!.results[0]!.ref!;
    const taskNo = log!.results[2]!.ref!;
    const [ex] = (await ownerPool.query(`select detector, status, severity, record_type, record_label, facts, title, explanation, domain from exception where exception_no = $1`, [exceptionNo])).rows;
    expect(ex).toMatchObject({ detector: 'logistics.automation_container_eta', status: 'open', severity: 'high', record_type: 'shipment_container', record_label: containerNo('MSCU', 760001), domain: 'logistics' });
    expect(ex.facts).toMatchObject({ rule: ruleNo, note: 'Ask for a new date', supplier: 'Jinko Solar' });
    expect(ex.title).toMatch(/is \d+ days past its expected arrival/);
    const [task] = (await ownerPool.query(`select title, status, priority, department_code, assignee_id::text, created_by::text, due_date::text, related_type, related_label from task where task_no = $1`, [taskNo])).rows;
    expect(task).toMatchObject({ status: 'assigned', priority: 'high', department_code: 'FIN', assignee_id: clerk.id, created_by: owner.id, related_type: 'shipment_container' });
    expect(task.title).toBe(`Chase the forwarder — ${containerNo('MSCU', 760001)}`);
    const due = new Date(`${today}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 2);
    expect(task.due_date).toBe(due.toISOString().slice(0, 10));
    expect((await noticesOf('automation.container_eta_exceeded')).length).toBeGreaterThan(0);
    expect((await auditOf('exception.raised_by_automation')).map((a) => a.object_id)).toEqual([exceptionNo]);
  });

  it('the Exception Center keeps the finding while the container is late, and resolves it by itself once it is received', async () => {
    const sweep = () => exceptions.sweep({ trigger: 'schedule', only: ['logistics.automation_container_eta'] });
    const kept = await sweep();
    expect(kept.detectors[0]).toMatchObject({ code: 'logistics.automation_container_eta', error: null, found: 1 });
    expect((await ownerPool.query(`select status from exception where exception_no = $1`, [exceptionNo])).rows[0].status).toBe('open');
    await receive(world, savedLate.containerId, { on: '2026-09-01' });
    const gone = await sweep();
    expect(gone.resolved).toBe(1);
    expect((await ownerPool.query(`select status from exception where exception_no = $1`, [exceptionNo])).rows[0].status).toBe('resolved');
  });
});

// ---------------------------------------------------------------------------
describe('AU4 · a task is overdue: the assignee, and the supervisor where the supervisor may open it', () => {
  let ruleNo: string;
  let taskNo: string;

  it('notifies the assignee and the supervisor once, and not an assignee with no supervisor on record', async () => {
    const made = await tasks_(owner, 'Send the August statements');
    taskNo = made;
    const rule = await create(sysadmin, 'task_overdue', 'Tasks late', { daysLate: '2', notifyAssignee: 'on', notifySupervisor: 'on', note: 'Please clear it' });
    ruleNo = rule.ruleNo;
    await enable(sysadmin, ruleNo);
    const produced = await sweepDay(today, ['task.overdue']);
    expect(produced[0]).toMatchObject({ read: 1, recorded: 1 });
    await drain();
    const [log] = await runsOf(ruleNo);
    expect(log).toMatchObject({ outcome: 'done', owner: sysadmin.id });
    const told = await noticesOf('automation.task_overdue');
    expect(told.map((n) => n.who).sort()).toEqual([clerk.id, supervisor.id].sort());
    expect(log!.results[0]!.detail).toMatch(/Told 2 people/);
    // The notice names the task by its title beside its number (a task has no supplier or customer), and says which rule told them.
    const context = (await ownerPool.query(`select context from notification where event_type = 'automation.task_overdue' and context->>'rule' = $1 limit 1`, [ruleNo])).rows[0].context as Record<string, string>;
    expect(context).toMatchObject({ reference: taskNo, party: 'Send the August statements', name: 'Tasks late', rule: ruleNo });
  });

  it('a task that is not late, or not owed any more, is not an event', async () => {
    // Not late yet: asked on a day before its due date, the task is not overdue.
    const early = await sweepDay('2026-09-01', ['task.overdue']);
    expect(early[0]).toMatchObject({ read: 0, recorded: 0 });
    // Not owed any more: its raiser withdraws it.
    const taskId = (await ownerPool.query(`select id::text from task where task_no = $1`, [taskNo])).rows[0].id as string;
    const eventsFor = async () => (await eventsOf('task.overdue')).filter((e) => e.subject_key === `task:${taskId}`).length;
    expect(await eventsFor()).toBe(1);
    await as(owner, (tx) => tasks.act(tx, owner, taskNo, 'cancel', { reason: 'No longer needed' }));
    // Other tasks of the file are late by then (the clerk's follow-up of AU3); this one is not owed, so it adds nothing.
    await sweepDay(addBusinessDays(today, 4), ['task.overdue']);
    expect(await eventsFor()).toBe(1);
  });
});

async function tasks_(creator: Person, title: string): Promise<string> {
  const made = await as(creator, (tx) => tasks.create(tx, creator, { title, departmentCode: 'FIN', assigneeId: clerk.id }));
  await ownerPool.query(`update task set due_date = $2 where task_no = $1`, [made.taskNo, addBusinessDays(today, -15)]);
  return made.taskNo;
}

// ---------------------------------------------------------------------------
describe('AU5 · a customer invoice is overdue: a follow-up task for, and a notice to, whoever raised it', () => {
  let ruleNo: string;

  it('acts on the invoice past its due date by at least the days, once, and says who raised it', async () => {
    const rule = await create(owner, 'invoice_overdue_follow_up', 'Collect', {
      daysLate: '5',
      minimumAmountIqd: '10000',
      taskDepartment: 'FIN',
      taskTitle: 'Call the customer',
      taskPriority: 'normal',
      taskDueInDays: '3',
      note: 'Ask for a payment date',
    });
    ruleNo = rule.ruleNo;
    await enable(owner, ruleNo);
    const sys = await systemScope();
    const produced = await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today, ['ar_invoice.overdue']));
    expect(produced[0]).toMatchObject({ listening: true, read: 1, recorded: 1, problems: [] });
    const [event] = await eventsOf('ar_invoice.overdue');
    expect(event!.payload).toMatchObject({ reference: overdueSale.no, customerCode: expect.any(String), amountIqd: '30000.0000', dueDate: '2026-08-30', raisedBy: world.clerk.principal.userId });
    await drain();
    const [log] = await runsOf(ruleNo);
    expect(log!.outcome).toBe('done');
    expect(log!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['create_task:done', 'create_notification:done']);
    const [task] = (await ownerPool.query(`select title, assignee_id::text, related_type, related_label from task where task_no = $1`, [log!.results[0]!.ref])).rows;
    expect(task).toMatchObject({ assignee_id: world.clerk.principal.userId, related_type: 'ar_invoice' });
    expect(task.title).toBe(`Call the customer — ${overdueSale.no}`);
    expect((await noticesOf('automation.ar_invoice_overdue')).map((n) => n.who)).toEqual([world.clerk.principal.userId]);
  });

  it('a payment ends it: the invoice no longer produces the event', async () => {
    await ownerPool.query(`update ar_invoice set due_date = $2 where id = $1`, [overdueSale.id, addBusinessDays(today, 90)]);
    const produced = await sweepDay(today, ['ar_invoice.overdue']);
    expect(produced[0]).toMatchObject({ read: 0 });
    await ownerPool.query(`update ar_invoice set due_date = '2026-08-30' where id = $1`, [overdueSale.id]);
  });
});

// ---------------------------------------------------------------------------
describe('AU6 · each thing is done once: a double dispatch, a replay, the same lateness on another day, concurrent runners', () => {
  beforeAll(async () => {
    // Somebody must be listening for invoices to be recorded; a threshold nothing reaches keeps it from acting on them.
    const listener = await create(owner, 'invoice_over_threshold', 'Listening, never reached', { thresholdIqd: '900,000,000', notifyRole: 'accounting_manager', note: 'Never' });
    await enable(owner, listener.ruleNo);
  });

  it('a double dispatch of one fact writes one event; a later one is a second event', async () => {
    const invoice = await submittedInvoice('1', '10000');
    const payload = (await eventsOf('ap_invoice.submitted')).find((e) => e.subject_key === `ap_invoice:${invoice.invoiceId}`)!.payload;
    const window = `at:2099-01-01T00:00:00.000Z`;
    const first = await as(owner, (tx) => dispatch(tx, 'ap_invoice.submitted', payload, { window }));
    const second = await as(owner, (tx) => dispatch(tx, 'ap_invoice.submitted', payload, { window }));
    expect(first.recorded).toBe(true);
    expect(second).toEqual({ id: null, recorded: false });
    const third = await as(owner, (tx) => dispatch(tx, 'ap_invoice.submitted', payload, { window: `at:2099-01-02T00:00:00.000Z` }));
    expect(third.recorded).toBe(true);
  });

  it('five dispatches of one fact at the same moment, each in its own transaction, write one event', async () => {
    const invoice = await submittedInvoice('2', '10000');
    const payload = (await eventsOf('ap_invoice.submitted')).find((e) => e.subject_key === `ap_invoice:${invoice.invoiceId}`)!.payload;
    const window = `at:2098-06-01T00:00:00.000Z`;
    const results = await Promise.all(Array.from({ length: 5 }, () => as(owner, (tx) => dispatch(tx, 'ap_invoice.submitted', payload, { window }))));
    expect(results.filter((r) => r.recorded)).toHaveLength(1);
    expect((await eventsOf('ap_invoice.submitted')).filter((e) => e.window_key === window)).toHaveLength(1);
  });

  it('a payload that does not fit its event is refused out loud, never recorded', async () => {
    const bad = await as(owner, (tx) => dispatch(tx, 'ap_invoice.submitted', { subjectId: randomUUID(), reference: 'X', amountIqd: 'lots' }));
    expect(bad.recorded).toBe(false);
    expect(bad.problem).toMatch(/amountIqd must be an amount/);
    const extra = await as(owner, (tx) => dispatch(tx, 'task.overdue', { subjectId: randomUUID(), reference: 'T', surprise: 1 }));
    expect(extra.problem).toMatch(/does not carry "surprise"/);
  });

  it('drains the outbox, and a second run finds nothing to repeat', async () => {
    await drain();
    const second = await drain();
    expect(second.events).toBe(0);
    expect(await count('automation_event', `status in ('pending','retry')`)).toBe(0);
  });

  it('the same lateness the next morning is a new event, and the rule that has acted does not act again on it', async () => {
    const tasksBefore = await count('task');
    const runsBefore = await count('automation_run');
    const sys = await systemScope();
    const nextDay = addBusinessDays(today, 1);
    const produced = await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), nextDay, ['ar_invoice.overdue']));
    expect(produced[0]).toMatchObject({ read: 1, recorded: 1 });
    const run = await drain();
    expect(run.events).toBe(1);
    expect(await count('task')).toBe(tasksBefore);
    expect(await count('automation_run')).toBe(runsBefore);
    const rows = await eventsOf('ar_invoice.overdue');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ status: 'done', rules_seen: 1, rules_matched: 1 });
    // the unique key behind it: a rule has one "done" per record per stretch of lateness.
    expect(await rejection(ownerPool.query(`insert into automation_run (rule_id, rule_version, event_id, event_key, subject_key, window_key, episode_key, run_key, attempt, owner_user_id, outcome, reason)
      select rule_id, rule_version, event_id, event_key, subject_key, window_key, episode_key, run_key, 9, owner_user_id, 'done', 'again' from automation_run where outcome = 'done' limit 1`))).toMatch(/automation_run_done_once/);
  });

  it('three runners at once take different events and do each thing exactly once', async () => {
    await quiesce();
    const rule = await create(sysadmin, 'task_overdue', 'Concurrent tasks', { daysLate: '1', notifyAssignee: 'on' });
    await enable(sysadmin, rule.ruleNo);
    const numbers: string[] = [];
    for (let i = 0; i < 6; i += 1) numbers.push(await tasks_(owner, `Concurrent task ${i}`));
    const sys = await systemScope();
    const produced = await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today, ['task.overdue']));
    expect(produced[0]!.recorded).toBeGreaterThanOrEqual(6);
    const waiting = await count('automation_event', `status in ('pending','retry')`);
    expect(waiting).toBeGreaterThanOrEqual(6);
    const results = await Promise.all([drain(), drain(), drain()]);
    // Every waiting event was taken by exactly one runner: no event twice, none left.
    expect(results.reduce((n, r) => n + r.events, 0)).toBe(waiting);
    const runs = (await runsOf(rule.ruleNo)).filter((r) => r.outcome === 'done');
    expect(new Set(runs.map((r) => r.subject_key)).size).toBe(runs.length);
    expect(runs.length).toBeGreaterThanOrEqual(6);
    const told = await ownerPool.query(`select count(*)::int as n, count(distinct object_id)::int as distinct_objects from notification where event_type = 'automation.task_overdue' and context->>'rule' = $1`, [rule.ruleNo]);
    expect(told.rows[0].n).toBe(told.rows[0].distinct_objects);
    expect(await count('automation_event', `status in ('pending','retry')`)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('AU7 · a failing action is contained, visible, retried, and finally pauses the rule', () => {
  let ruleNo: string;
  let invoice: { invoiceId: string; invoiceNo: string };

  it('the business transaction commits whatever the engine does: with the outbox itself broken, the invoice is still submitted and nothing is recorded', async () => {
    await quiesce();
    const rule = await create(owner, 'invoice_over_threshold', 'Outbox down', { thresholdIqd: '1', notifyRole: 'accounting_manager' });
    await enable(owner, rule.ruleNo);
    await ownerPool.query(`create or replace function au_boom() returns trigger language plpgsql as $$ begin raise exception 'the outbox is down'; end $$`);
    await ownerPool.query(`create trigger au_boom_event before insert on automation_event for each row execute function au_boom()`);
    try {
      const survived = await submittedInvoice('7', '10000');
      expect(await statusOf(survived.invoiceId)).toBe('submitted');
      expect((await eventsOf('ap_invoice.submitted')).some((e) => e.subject_key === `ap_invoice:${survived.invoiceId}`)).toBe(false);
      // And the posting after it, in a transaction of its own, goes through as ever.
      await as(world.manager, (tx) => ap.post(tx, world.manager, survived.invoiceId));
      expect(await statusOf(survived.invoiceId)).toBe('posted');
    } finally {
      await ownerPool.query(`drop trigger if exists au_boom_event on automation_event`);
    }
    await disable(owner, rule.ruleNo, 'Done with the outbox fault');
  });

  it('the business transaction commits whatever a rule does: with the review route broken, the invoice is still submitted and recorded', async () => {
    const made = await create(owner, 'invoice_over_threshold', 'Fails first', { thresholdIqd: '500000', notifyRole: 'accounting_manager', note: 'x' });
    ruleNo = made.ruleNo;
    await enable(owner, ruleNo);
    // A fault in the review table: not a refusal of the owner's reach, a broken thing.
    await ownerPool.query(`create or replace function au_boom() returns trigger language plpgsql as $$ begin raise exception 'the review table is down'; end $$`);
    await ownerPool.query(`create trigger au_boom before insert on workflow_instance for each row execute function au_boom()`);
    invoice = await submittedInvoice('100', '10000'); // 1,000,000
    expect(await statusOf(invoice.invoiceId)).toBe('submitted');
    expect((await eventsOf('ap_invoice.submitted')).filter((e) => e.subject_key === `ap_invoice:${invoice.invoiceId}`)).toHaveLength(1);
  });

  it('is logged as failed with the reason, the step that worked is kept, and the event waits for its retry', async () => {
    const now = new Date();
    const run = await drain({ now });
    expect(run.runs.failed).toBe(1);
    expect(run.retrying).toBe(1);
    const [first] = (await runsOf(ruleNo)).filter((r) => r.subject_key === `ap_invoice:${invoice.invoiceId}`);
    expect(first).toMatchObject({ outcome: 'failed', attempt: 1 });
    expect(first!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['request_approval:failed', 'open_workflow:done']);
    expect(first!.reason).toMatch(/Failed: .*the review table is down.*tried again at .* \(attempt 1 of 3\)/);
    const event = (await eventsOf('ap_invoice.submitted')).find((e) => e.subject_key === `ap_invoice:${invoice.invoiceId}`)!;
    expect(event).toMatchObject({ status: 'retry', attempts: 1 });
    expect(await openReviews(invoice.invoiceId)).toBe(0);
    // Nothing is due yet: the retry waits a minute.
    expect((await drain({ now })).events).toBe(0);
    expect((await ruleRow(ruleNo)).consecutive_failures).toBe(0);
  });

  it('retries after the fault is gone: the step that failed now works, the one that worked is carried and not sent twice', async () => {
    await ownerPool.query(`drop trigger au_boom on workflow_instance`);
    const toldBefore = (await noticesOf('automation.ap_invoice_submitted')).length;
    const later = new Date(Date.now() + 2 * 60_000);
    const run = await drain({ now: later });
    expect(run.runs.done).toBe(1);
    const runs = (await runsOf(ruleNo)).filter((r) => r.subject_key === `ap_invoice:${invoice.invoiceId}`);
    expect(runs.map((r) => `${r.attempt}:${r.outcome}`)).toEqual(['1:failed', '2:done']);
    expect(runs[1]!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['request_approval:done', 'open_workflow:carried']);
    expect(await openReviews(invoice.invoiceId)).toBe(1);
    expect((await noticesOf('automation.ap_invoice_submitted')).length).toBe(toldBefore);
    expect(await ruleRow(ruleNo)).toMatchObject({ consecutive_failures: 0, last_outcome: 'done' });
  });

  it('keeps failing: three attempts, then the rule pauses itself, says why, and tells the administrators', async () => {
    await as(owner, (tx) => automation.setPauseThreshold(tx, owner, 1));
    await ownerPool.query(`create trigger au_boom before insert on workflow_instance for each row execute function au_boom()`);
    const broken = await submittedInvoice('120', '10000');
    const t0 = new Date();
    await drain({ now: t0 });
    await drain({ now: new Date(t0.getTime() + 2 * 60_000) });
    expect((await ruleRow(ruleNo)).enabled).toBe(true);
    const last = await drain({ now: new Date(t0.getTime() + 20 * 60_000) });
    expect(last.paused).toEqual([ruleNo]);
    const runs = (await runsOf(ruleNo)).filter((r) => r.subject_key === `ap_invoice:${broken.invoiceId}`);
    expect(runs.map((r) => `${r.attempt}:${r.outcome}`)).toEqual(['1:failed', '2:failed', '3:failed']);
    expect(runs[2]!.reason).toMatch(/gives up on this one/);
    const row = await ruleRow(ruleNo);
    expect(row).toMatchObject({ enabled: false, consecutive_failures: 1 });
    expect(row.paused_at).not.toBeNull();
    expect(row.paused_reason).toMatch(/failed 1 events in a row/);
    const event = (await eventsOf('ap_invoice.submitted')).find((e) => e.subject_key === `ap_invoice:${broken.invoiceId}`)!;
    expect(event).toMatchObject({ status: 'failed', attempts: 3 });
    expect(event.last_error).toMatch(/the review table is down/);
    const told = await noticesOf('automation.paused');
    expect(new Set(told.map((n) => n.who))).toEqual(expect.objectContaining(new Set([owner.id, sysadmin.id])));
    expect((await auditOf('automation.rule_paused')).map((a) => a.object_id)).toContain(ruleNo);
    await ownerPool.query(`drop trigger au_boom on workflow_instance`);
    await as(owner, (tx) => automation.setPauseThreshold(tx, owner, 3));
    // A paused rule listens to nothing; switching it on again clears the pause and makes the person who does it the owner.
    expect(await as(owner, (tx) => automation.listRules(tx, owner.principal, { state: 'paused' }))).toMatchObject({ total: 1 });
    await enable(owner, ruleNo);
    expect(await ruleRow(ruleNo)).toMatchObject({ enabled: true, paused_at: null, consecutive_failures: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('AU8 · the global switch and a disabled rule do nothing', () => {
  it('a disabled rule listens to nothing: nothing is recorded, and what it did before stays in the log', async () => {
    const rule = await create(owner, 'invoice_over_threshold', 'To be switched off', { thresholdIqd: '1', notifyRole: 'accounting_manager' });
    await enable(owner, rule.ruleNo);
    await disable(owner, rule.ruleNo, 'Trying it');
    expect(await ruleRow(rule.ruleNo)).toMatchObject({ enabled: false, paused_at: null });
    await expect(disable(owner, rule.ruleNo, 'again')).rejects.toThrow(/already off/);
    await expect(disable(owner, rule.ruleNo, '')).rejects.toThrow(/Say why/);
    expect((await auditOf('automation.rule_disabled')).length).toBeGreaterThan(0);
  });

  it('with the switch off nothing is recorded or produced, what was waiting is closed without running, and switching it on restores everything', async () => {
    const waiting = await submittedInvoice('300', '10000'); // recorded while AUT of AU7 is listening
    expect(await count('automation_event', `status = 'pending'`)).toBeGreaterThan(0);
    await expect(as(clerk, (tx) => automation.setSwitch(tx, clerk, false, 'no'))).rejects.toThrow(/Permission denied/);
    await expect(as(owner, (tx) => automation.setSwitch(tx, owner, false, ''))).rejects.toThrow(/Say why/);
    await as(owner, (tx) => automation.setSwitch(tx, owner, false, 'Maintenance on the review route'));
    const tasksBefore = await count('task');
    const runsBefore = await count('automation_run');
    const run = await drain();
    expect(run.switchedOff).toBe(true);
    expect(await count('automation_run')).toBe(runsBefore);
    expect(await count('task')).toBe(tasksBefore);
    expect(await openReviews(waiting.invoiceId)).toBe(0);
    const closed = (await eventsOf('ap_invoice.submitted')).find((e) => e.subject_key === `ap_invoice:${waiting.invoiceId}`)!;
    expect(closed.status).toBe('done');
    expect(closed.last_error).toMatch(/switched off/);
    // While it is off, a new submission is not recorded and the sweep reads nothing.
    const quiet = await submittedInvoice('300', '10000');
    expect((await eventsOf('ap_invoice.submitted')).some((e) => e.subject_key === `ap_invoice:${quiet.invoiceId}`)).toBe(false);
    const sys = await systemScope();
    const produced = await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today));
    expect(produced.every((r) => !r.listening && r.recorded === 0)).toBe(true);
    await as(owner, (tx) => automation.setSwitch(tx, owner, true, 'Maintenance is over'));
    expect((await auditOf('automation.switched_off')).length).toBe(1);
    expect((await auditOf('automation.switched_on')).length).toBe(1);
    const after = await submittedInvoice('300', '10000');
    expect((await eventsOf('ap_invoice.submitted')).some((e) => e.subject_key === `ap_invoice:${after.invoiceId}`)).toBe(true);
    await drain();
  });
});

// ---------------------------------------------------------------------------
describe('AU9 · a rule does only what its owner could do by hand', () => {
  it('an action the owner could not do is skipped with the reason while the ones they can do are done', async () => {
    const made = await create(limited, 'container_eta_exceeded', 'No tasks for me', {
      daysLate: '1',
      severity: 'medium',
      notifyRole: 'accounting_manager',
      followUp: 'on',
      taskAssignee: clerk.id,
      taskDepartment: 'FIN',
      taskTitle: 'Chase them',
      taskPriority: 'normal',
      taskDueInDays: '1',
    });
    await enable(limited, made.ruleNo);
    // The earlier container was received; a new one is late.
    const another = await importOf(world, '10', { reference: 'AU-LATE-2' });
    const bl = await blWith(world, another.payableId, [{ no: containerNo('MSCU', 760004), qty: '10' }], { eta: '2026-09-10' });
    const sys = await systemScope();
    await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today, ['container.eta_exceeded']));
    const tasksBefore = await count('task');
    await drain();
    const runs = (await runsOf(made.ruleNo)).filter((r) => r.subject_key === `shipment_container:${bl.containerIds[0]}`);
    expect(runs).toHaveLength(1);
    expect(runs[0], runs[0]!.reason).toMatchObject({ outcome: 'done', owner: limited.id });
    expect(runs[0]!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['create_exception:done', 'create_notification:done', 'create_task:skipped']);
    expect(runs[0]!.results[2]!.detail).toMatch(/owner could not do this by hand \(create on task, submit on task missing\)/);
    expect(await count('task')).toBe(tasksBefore);
  });

  it('a rule none of whose actions the enabler could do is refused at enabling', async () => {
    const made = await create(limited, 'task_overdue', 'Nothing I can see', { daysLate: '1', notifyAssignee: 'on' });
    await enable(limited, made.ruleNo); // may open a task, so the notice is theirs to send
    await ownerPool.query(`delete from role_grant where role_code = 'automation_limited' and object = 'task'`);
    await disable(limited, made.ruleNo, 'Testing the refusal');
    const stale = await withScope({ userId: limited.id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, limited.id));
    await expect(as({ principal: stale, branchCode: BAGHDAD }, (tx) => automation.enable(tx, { principal: stale, branchCode: BAGHDAD }, made.ruleNo))).rejects.toThrow(/may not open task records/);
    await ownerPool.query(`insert into role_grant (role_code, object, verb) values ('automation_limited','task','view')`);
  });

  it('an owner who loses the grant to administer automation pauses the rule: it is logged as skipped, nothing is done, and it stays off until a person turns it on', async () => {
    const rule = await create(owner, 'task_overdue', 'Owner loses the grant', { daysLate: '1', notifyAssignee: 'on' });
    const lone = await person('Temporary Admin', ['system_administrator']);
    await enable(lone, rule.ruleNo);
    expect((await ruleRow(rule.ruleNo)).owner_user_id).toBe(lone.id);
    const taskNo = await tasks_(owner, 'A task for the revoked owner');
    await ownerPool.query(`delete from user_role where user_id = $1`, [lone.id]);
    const sys = await systemScope();
    await withScope(sys, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, sys.userId), today, ['task.overdue']));
    const told = await count('notification', `event_type = 'automation.task_overdue' and context->>'rule' = '${rule.ruleNo}'`);
    await drain();
    const taskId = (await ownerPool.query(`select id from task where task_no = $1`, [taskNo])).rows[0].id;
    const runs = (await runsOf(rule.ruleNo)).filter((r) => r.subject_key.endsWith(`:${taskId}`));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'skipped' });
    expect(runs[0]!.reason).toMatch(/its owner no longer holds administer on automation/);
    expect(await count('notification', `event_type = 'automation.task_overdue' and context->>'rule' = '${rule.ruleNo}'`)).toBe(told);
    const row = await ruleRow(rule.ruleNo);
    expect(row.enabled).toBe(false);
    expect(row.paused_reason).toMatch(/no longer holds administer/);
  });
});

// ---------------------------------------------------------------------------
describe('AU11 · no storm: a rule never acts on what it made, and a chain stops after two steps', () => {
  /** A rule the templates do not offer, written straight into the versions table (the database's own guard still holds the vocabulary): a late task makes a follow-up task. */
  async function followUpRule(name: string): Promise<string> {
    const made = await create(owner, 'task_overdue', name, { daysLate: '1', notifyAssignee: 'on' });
    const actions = [{ kind: 'create_task', assignee: { kind: 'user', userId: clerk.id }, departmentCode: 'FIN', title: `Follow up (${name})`, priority: 'normal', dueInDays: 0 }];
    await ownerPool.query(
      `insert into automation_rule_version (rule_id, version, event_key, name, template_code, params, conditions, actions, changed_by)
       select rule_id, 2, event_key, name, template_code, params, conditions, $2::jsonb, changed_by from automation_rule_version where rule_id = (select id from automation_rule where rule_no = $1) and version = 1`,
      [made.ruleNo, JSON.stringify(actions)],
    );
    await ownerPool.query(`update automation_rule set current_version = 2 where rule_no = $1`, [made.ruleNo]);
    await enable(owner, made.ruleNo);
    return made.ruleNo;
  }
  const madeBy = async (ruleNo: string) =>
    (await ownerPool.query(`select m.record_label, m.record_id, m.depth from automation_made m join automation_rule r on r.id = m.rule_id where r.rule_no = $1 and m.record_type = 'task' order by m.made_at, m.record_label`, [ruleNo])).rows as { record_label: string; record_id: string; depth: number }[];
  const day = (n: number) => addBusinessDays(today, n);

  it('two rules that each make a task when a task is late stop where the guard says, whatever the number of mornings', async () => {
    await quiesce();
    // Nothing else of the file is late, so the only thing in play is the chain below.
    await ownerPool.query(`update task set due_date = $1 where status in ('assigned','accepted','in_progress','blocked')`, [day(400)]);
    const rootNo = await tasks_(owner, 'The task the chain starts from');
    const rootId = (await ownerPool.query(`select id::text from task where task_no = $1`, [rootNo])).rows[0].id as string;
    const first = await followUpRule('Follow-up L');
    const second = await followUpRule('Follow-up M');

    // Morning 1: the root is late. Each rule makes one task, one step from a person's.
    await sweepDay(day(1), ['task.overdue']);
    await drain();
    const l1 = await madeBy(first);
    const m1 = await madeBy(second);
    expect([l1.length, m1.length]).toEqual([1, 1]);
    expect([l1[0]!.depth, m1[0]!.depth]).toEqual([1, 1]);

    // Morning 2: both follow-ups are late. Each rule skips the one it made, and acts on the other's: a second step.
    await sweepDay(day(2), ['task.overdue']);
    await drain();
    const l2 = await madeBy(first);
    const m2 = await madeBy(second);
    expect([l2.length, m2.length]).toEqual([2, 2]);
    expect([l2.map((r) => r.depth), m2.map((r) => r.depth)]).toEqual([[1, 2], [1, 2]]);
    const ownOnes = (await runsOf(first)).filter((r) => r.subject_key === `task:${l1[0]!.record_id}`);
    expect(ownOnes).toHaveLength(1);
    expect(ownOnes[0]).toMatchObject({ outcome: 'skipped' });
    expect(ownOnes[0]!.reason).toMatch(/made by this rule itself \(AUT-\d+\)/);
    expect(ownOnes[0]!.results).toEqual([]);

    // Mornings 3 and 4: the second-step tasks are late too. The chain has used its two steps; nothing more is made, however often it is looked at.
    const tasksNow = await count('task');
    await sweepDay(day(3), ['task.overdue']);
    await drain();
    const logged = await count('automation_run');
    const ended = (await runsOf(first)).filter((r) => r.reason.includes('stops after 2 steps'));
    expect(ended.length).toBeGreaterThan(0);
    await sweepDay(day(4), ['task.overdue']);
    await drain();
    expect(await count('task')).toBe(tasksNow);
    expect((await madeBy(first)).length + (await madeBy(second)).length).toBe(4);
    // Looked at again, a skip that says what it said before adds nothing to the log.
    expect(await count('automation_run')).toBe(logged);
    // The root was never made by a rule, and a rule's own run on it was done once.
    expect(await count('automation_made', `record_id = '${rootId}'`)).toBe(0);
    expect((await runsOf(first)).filter((r) => r.subject_key === `task:${rootId}` && r.outcome === 'done')).toHaveLength(1);
    await quiesce();
  });
});

// ---------------------------------------------------------------------------
describe('AU12 · a step refused for good is recorded once and is not tried again', () => {
  it('a follow-up task for somebody the owner may not assign to fails with the Task Center\'s reason, keeps the steps that worked, makes no task and counts toward pausing', async () => {
    await quiesce();
    const late = await importOf(world, '10', { reference: 'AU-LATE-3' });
    const bl = await blWith(world, late.payableId, [{ no: containerNo('MSCU', 760007), qty: '10' }], { eta: '2026-09-12' });
    const made = await create(owner, 'container_eta_exceeded', 'Task for another branch', {
      daysLate: '1',
      severity: 'low',
      notifyRole: 'accounting_manager',
      followUp: 'on',
      taskAssignee: elsewhere.id,
      taskDepartment: 'FIN',
      taskTitle: 'Never made',
      taskPriority: 'low',
      taskDueInDays: '1',
    });
    await enable(owner, made.ruleNo);
    await sweepDay(today, ['container.eta_exceeded']);
    const tasksBefore = await count('task');
    const run = await drain();
    expect(run.retrying).toBe(0);
    const runs = (await runsOf(made.ruleNo)).filter((r) => r.subject_key === `shipment_container:${bl.containerIds[0]}`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: 'failed', attempt: 1 });
    expect(runs[0]!.results.map((r) => `${r.kind}:${r.status}`)).toEqual(['create_exception:done', 'create_notification:done', 'create_task:failed']);
    expect(runs[0]!.results[2]).toMatchObject({ permanent: true });
    expect(runs[0]!.reason).toMatch(/The Task Center refused the task: .*outside the people you may assign to.*trying again would change nothing/);
    expect(await count('task')).toBe(tasksBefore);
    const [event] = (await eventsOf('container.eta_exceeded')).filter((e) => e.subject_key === `shipment_container:${bl.containerIds[0]}`);
    expect(event).toMatchObject({ status: 'failed', attempts: 1 });
    expect(event!.last_error).toMatch(/The Task Center refused the task/);
    expect((await ruleRow(made.ruleNo)).consecutive_failures).toBeGreaterThanOrEqual(1);
    // Nothing is waiting for a retry, and a second pass finds nothing to do.
    expect((await drain()).events).toBe(0);
    await quiesce();
  });
});

// ---------------------------------------------------------------------------
describe('AU10 · nothing automation does touches the ledger or the stock', () => {
  it('after every scenario above, the books, the stock and the payments are exactly what the documents themselves made, and every step a rule took is one of the five', async () => {
    // `drain` showed, run by run, that the runner moved nothing in the books; here the whole file is looked at once.
    const steps = await ownerPool.query(`select distinct split_part(s, ':', 1) as kind from audit_event e, jsonb_array_elements_text(e.after_value->'steps') s where e.action = 'automation.ran'`);
    expect(steps.rows.map((r) => r.kind).sort()).toEqual(['create_exception', 'create_notification', 'create_task', 'open_workflow', 'request_approval']);
    // The rule ran many times, and none of it is a posting: no journal, stock movement or payment names a rule as its reason.
    expect((await auditOf('automation.ran')).length).toBeGreaterThan(20);
    const byRule = await ownerPool.query(`select count(*)::int as n from audit_event where reason like 'Automation %' and action not in ('ap_invoice.review_requested')`);
    expect(byRule.rows[0].n).toBe(0);
    // The tables a rule may write are the ones its actions declare; the ledger tables are the ones the documents wrote.
    const after = await ledgerDigest();
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(after.journal_entry).not.toBe(before.journal_entry); // the file's own invoices and sale did post: the guard is not a blind spot
    expect(await count('journal_entry', `source_module like 'automation%'`)).toBe(0);
  });
});
