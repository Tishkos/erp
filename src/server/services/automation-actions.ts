/**
 * What a rule can DO — platform phase, Agent 10. The closed list of five.
 *
 *   create_notification   `notifications.emit`, to people named by role or by their
 *                         relationship to the record; each is asked, as themselves,
 *                         whether they may open it.
 *   open_workflow         the same, pointing at My Approvals. A link and a notice;
 *                         nothing is executed.
 *   create_task           `tasks.create` as the rule's owner: only in a section the
 *                         owner may raise one in, only for a person the owner may
 *                         give one to (`app_task_scope`).
 *   request_approval      `workflow.submit` on a submitted purchase invoice: the
 *                         invoice then cannot be posted until a second person has
 *                         reviewed it (`ap-invoice.approveReview`). It does not
 *                         approve, post, pay or edit anything.
 *   create_exception      `exceptions.raiseFromAutomation`, under the `automation`
 *                         detector family.
 *
 * Every action runs AS THE RULE'S OWNER (their scope is applied by the runner),
 * so row security, the branch rule and each owning service's own checks all
 * answer for the owner, not for the system: an action the owner could not do by
 * hand is refused here (`ActionRefused`, or the owning service's own refusal) and
 * logged as skipped. None of them reaches the ledger or the stock: this file
 * imports no posting, journal, payment or inventory service
 * (`wf01-automation.test.ts` scans it).
 */
import { and, eq, sql } from 'drizzle-orm';
import { applyScope, type RequestScope, type Tx } from '../db/client';
import { workflowInstance } from '../db/schema';
import { findingFor } from '../domain/automation-exceptions';
import { reachOf, type Action, type ApprovalAction, type ExceptionAction, type NotifyAction, type Recipient, type TaskAction, type ActionResult } from '../domain/automation';
import { EVENTS, noticeKind, type EventKey } from '../domain/automation-events';
import { addBusinessDays, businessToday } from '../domain/business-date';
import { say } from '../domain/money';
import * as audit from './audit';
import type { ActorContext } from './chart-of-accounts';
import * as links from './cloud-link-targets';
import * as exceptions from './exceptions';
import * as notifications from './notifications';
import * as tasks from './tasks';
import * as workflow from './workflow';

/** The action was refused for a reason that is the rule's or the owner's, not a fault: logged as skipped, never retried. */
export class ActionRefused extends Error {
  readonly code = 'ACTION_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'ActionRefused';
  }
}

export interface RuleRef {
  readonly id: string;
  readonly ruleNo: string;
  readonly name: string;
  readonly version: number;
  readonly ownerUserId: string;
}

export interface EventRef {
  readonly id: string;
  readonly key: EventKey;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly subjectId: string;
  readonly episode: string;
  readonly branchCode: string | null;
}

export interface Doing {
  /** The action's own savepoint. */
  readonly tx: Tx;
  /** The rule owner's context: their principal, their branch. */
  readonly ctx: ActorContext;
  readonly scopes: { readonly owner: RequestScope; readonly system: RequestScope };
  readonly rule: RuleRef;
  readonly event: EventRef;
}

type Rows<T> = { rows: T[] };
type Outcome = Omit<ActionResult, 'index'>;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Reads as the system (a person's relationships are HR's, not the owner's to see), then goes back to the owner. */
async function asSystem<T>(d: Doing, read: (tx: Tx) => Promise<T>): Promise<T> {
  await applyScope(d.tx, d.scopes.system);
  const value = await read(d.tx);
  await applyScope(d.tx, d.scopes.owner);
  return value;
}

async function supervisorOf(tx: Tx, userId: string): Promise<string | null> {
  const found = (await tx.execute(sql`
    select m.app_user_id::text as id
      from employee e
      join employee m on m.id = e.manager_employee_id
      join app_user u on u.id = m.app_user_id and u.is_active
     where e.app_user_id = ${userId}::uuid`)) as unknown as Rows<{ id: string }>;
  return found.rows[0]?.id ?? null;
}

/** Who a recipient is, for this event and rule. Nobody is a gap, said in words — never a guess. */
async function resolve(d: Doing, recipients: readonly Recipient[]): Promise<{ ids: string[]; gaps: string[] }> {
  const ids = new Set<string>();
  const gaps: string[] = [];
  const { payload } = d.event;
  for (const r of recipients) {
    switch (r.kind) {
      case 'role': {
        const found = await asSystem(
          d,
          async (tx) =>
            (await tx.execute(sql`
              select ur.user_id::text as id from user_role ur join app_user u on u.id = ur.user_id
               where ur.role_code = ${r.roleCode} and u.is_active`)) as unknown as Rows<{ id: string }>,
        );
        if (found.rows.length === 0) gaps.push(`nobody holds the role ${r.roleCode}`);
        for (const row of found.rows) ids.add(row.id);
        break;
      }
      case 'user':
        ids.add(r.userId);
        break;
      case 'rule_owner':
        ids.add(d.rule.ownerUserId);
        break;
      case 'record_raiser':
      case 'record_assignee': {
        const who = text(r.kind === 'record_raiser' ? payload.raisedBy : payload.assigneeId);
        if (who) ids.add(who);
        else gaps.push(r.kind === 'record_raiser' ? 'the record names nobody who raised it' : 'the record is with nobody');
        break;
      }
      case 'raiser_supervisor':
      case 'assignee_supervisor': {
        const person = text(r.kind === 'raiser_supervisor' ? payload.raisedBy : payload.assigneeId);
        const boss = person ? await asSystem(d, (tx) => supervisorOf(tx, person)) : null;
        if (boss) ids.add(boss);
        else gaps.push('no supervisor is on record for that person');
        break;
      }
    }
  }
  return { ids: [...ids], gaps };
}

// ---------------------------------------------------------------------------
// create_notification / open_workflow
// ---------------------------------------------------------------------------

function contextOf(d: Doing, note: string, href: string): Record<string, unknown> {
  const p = d.event.payload;
  return {
    reference: text(p.reference),
    name: d.rule.name,
    reason: note,
    href,
    ...(typeof p.daysLate === 'number' ? { days: p.daysLate } : {}),
    party: text(p.supplierName) || text(p.customerName),
    ...(text(p.amountIqd) ? { amount: say(text(p.amountIqd)) } : {}),
    ...(text(p.dueDate) ? { due_date: text(p.dueDate) } : {}),
    ...(text(p.etaDate) ? { eta: text(p.etaDate) } : {}),
    rule: d.rule.ruleNo,
  };
}

async function notify(d: Doing, action: NotifyAction): Promise<Outcome> {
  const def = EVENTS[d.event.key];
  const { ids, gaps } = await resolve(d, action.recipients);
  if (ids.length === 0) {
    return { kind: action.kind, status: 'skipped', detail: `Nobody to tell: ${gaps.join('; ') || 'no recipient'}.` };
  }
  const href = action.kind === 'open_workflow' ? '/approvals' : def.href(d.event.payload);
  const reference = text(d.event.payload.reference);
  const result = await notifications.emit(d.tx, {
    kind: noticeKind(d.event.key),
    objectType: def.subjectType,
    objectId: d.event.subjectId,
    recipients: ids,
    subject: `${d.rule.name}: ${reference}`,
    body: action.note,
    context: contextOf(d, action.note, href),
    // Once per rule, per record, per stretch of lateness; a pending approval is its own notice.
    occurrence: `${d.rule.id}:${d.event.episode}${action.kind === 'open_workflow' ? ':approvals' : ''}`,
    branchCode: d.event.branchCode,
    recordAccess: true,
    actorUserId: d.rule.ownerUserId,
  });
  if (result.created === 0 && result.suppressed === 0) {
    return { kind: action.kind, status: 'skipped', detail: `None of the ${count(ids.length, 'person', 'people')} named could open ${reference}, so nobody was told.` };
  }
  const parts = [`Told ${count(result.created, 'person', 'people')}`];
  if (result.suppressed > 0) parts.push(`${result.suppressed} already told`);
  if (result.skipped > 0) parts.push(`${count(result.skipped, 'person', 'people')} left out because they could not open it`);
  if (gaps.length > 0) parts.push(gaps.join('; '));
  return { kind: action.kind, status: 'done', detail: `${parts.join(', ')}.`, ref: String(result.created) };
}

// ---------------------------------------------------------------------------
// create_task
// ---------------------------------------------------------------------------

async function createTask(d: Doing, action: TaskAction): Promise<Outcome> {
  const def = EVENTS[d.event.key];
  const { ids, gaps } = await resolve(d, [action.assignee]);
  const assigneeId = ids[0];
  if (!assigneeId) return { kind: 'create_task', status: 'skipped', detail: `Nobody to give the task to: ${gaps.join('; ') || 'no person'}.` };

  const principal = d.ctx.principal;
  const branchCode = d.event.branchCode ?? d.ctx.branchCode;
  if (!principal.isSuperUser && !principal.branchCodes.includes(branchCode)) {
    throw new ActionRefused(`The rule's owner has no access to branch ${branchCode}, so a task cannot be raised there.`);
  }
  const reference = text(d.event.payload.reference);
  const href = def.href(d.event.payload);
  const related = await links.findRecord(d.tx, principal, def.subjectType, reference);
  const title = `${action.title} — ${reference}`.slice(0, 120);
  const description = [`Raised by automation rule ${d.rule.ruleNo} (${d.rule.name}), version ${d.rule.version}.`, action.note, `Record: ${reference} (${href})`].filter((line) => line !== '').join('\n');
  const made = await tasks.create(d.tx, { ...d.ctx, branchCode }, {
    title,
    description,
    priority: action.priority,
    dueDate: addBusinessDays(businessToday(), action.dueInDays),
    departmentCode: action.departmentCode,
    assigneeId,
    relatedType: related ? def.subjectType : null,
    relatedNo: related ? reference : null,
  });
  return { kind: 'create_task', status: 'done', detail: `Task ${made.taskNo} raised${made.assigned ? ' and given out' : ''}${related ? '' : ' (the record has no link a task can hold, so none was made)'}.`, ref: made.taskNo };
}

// ---------------------------------------------------------------------------
// request_approval
// ---------------------------------------------------------------------------

async function requestApproval(d: Doing, _action: ApprovalAction): Promise<Outcome> {
  if (d.event.key !== 'ap_invoice.submitted') throw new ActionRefused('A review can only be asked for on a submitted purchase invoice.');
  const found = (await d.tx.execute(sql`
    select id::text, invoice_no as "invoiceNo", status::text as status, branch_code as "branchCode"
      from ap_invoice where id = ${d.event.subjectId}::uuid for update`)) as unknown as Rows<{ id: string; invoiceNo: string; status: string; branchCode: string }>;
  const invoice = found.rows[0];
  if (!invoice) throw new ActionRefused('The invoice cannot be opened by the rule\'s owner.');
  if (invoice.status !== 'submitted') {
    return { kind: 'request_approval', status: 'skipped', detail: `${invoice.invoiceNo} is already ${invoice.status.replace(/_/g, ' ')}; there is nothing left to hold for review.` };
  }
  const open = await d.tx
    .select({ id: workflowInstance.id })
    .from(workflowInstance)
    .where(and(eq(workflowInstance.documentTypeCode, 'ap_invoice'), eq(workflowInstance.documentId, invoice.id), eq(workflowInstance.isComplete, false)))
    .limit(1);
  if (open.length > 0) return { kind: 'request_approval', status: 'skipped', detail: `${invoice.invoiceNo} is already waiting for a review.` };

  let submitted: { instanceId: string; revision: number };
  try {
    submitted = await workflow.submit(d.tx, d.ctx, { documentTypeCode: 'ap_invoice', documentId: invoice.id, branchCode: invoice.branchCode });
  } catch (error) {
    if (error instanceof workflow.NoWorkflowDefinedError) throw new ActionRefused('No review route is set up for purchase invoices.');
    throw error;
  }
  await audit.record(d.tx, {
    actorUserId: d.rule.ownerUserId,
    action: 'ap_invoice.review_requested',
    objectType: 'ap_invoice',
    objectId: invoice.id,
    branchCode: invoice.branchCode,
    before: { status: 'submitted', review: null },
    after: { status: 'submitted', review: 'requested', revision: submitted.revision },
    reason: `Automation ${d.rule.ruleNo} (${d.rule.name}), version ${d.rule.version}`,
    outcome: 'success',
  });
  return { kind: 'request_approval', status: 'done', detail: `${invoice.invoiceNo} now waits for a review before it can be posted (it shows in My Approvals).`, ref: invoice.invoiceNo };
}

// ---------------------------------------------------------------------------
// create_exception
// ---------------------------------------------------------------------------

async function createException(d: Doing, action: ExceptionAction): Promise<Outcome> {
  const payload = d.event.payload;
  const assigneeId = text(payload.assigneeId);
  const assigneeName = assigneeId
    ? await asSystem(d, async (tx) => ((await tx.execute(sql`select display_name as name from app_user where id = ${assigneeId}::uuid`)) as unknown as Rows<{ name: string }>).rows[0]?.name ?? '')
    : '';
  const finding = findingFor(d.event.key, payload, {
    severity: action.severity,
    ruleNo: d.rule.ruleNo,
    note: action.note,
    assignee: assigneeId && assigneeName ? { userId: assigneeId, name: assigneeName } : null,
  });
  if (!finding) throw new ActionRefused(`${d.event.key} raises no exceptions.`);
  const branchCode = d.event.branchCode ?? d.ctx.branchCode;
  const raised = await exceptions.raiseFromAutomation(d.tx, { ...d.ctx, branchCode }, finding, d.rule.ruleNo);
  const detail =
    raised.outcome === 'created'
      ? `Exception ${raised.exceptionNo} raised (${action.severity}).`
      : raised.outcome === 'reopened'
        ? `Exception ${raised.exceptionNo} came back (${action.severity}).`
        : `Exception ${raised.exceptionNo} was already open for this record.`;
  return { kind: 'create_exception', status: 'done', detail, ref: raised.exceptionNo };
}

// ---------------------------------------------------------------------------
// One action
// ---------------------------------------------------------------------------

/**
 * Does one action as the owner, or says why it could not. The caller runs this
 * in a savepoint and turns a thrown error into a skipped (a refusal) or a failed
 * (a fault) result; here only the first half of the intersection is asked — the
 * owner's grants against `reachOf` — and the owning services ask the rest.
 */
export async function perform(d: Doing, action: Action, index: number): Promise<ActionResult> {
  const reach = reachOf(d.ctx.principal, d.event.key, action);
  if (!reach.ok) {
    const missing = reach.missing.map((m) => `${m.verb} on ${m.object.replace(/_/g, ' ')}`).join(', ');
    throw new ActionRefused(`The rule's owner could not do this by hand (${missing} missing), so it is not done for them.`);
  }
  let result: Outcome;
  switch (action.kind) {
    case 'create_notification':
    case 'open_workflow':
      result = await notify(d, action);
      break;
    case 'create_task':
      result = await createTask(d, action);
      break;
    case 'request_approval':
      result = await requestApproval(d, action);
      break;
    case 'create_exception':
      result = await createException(d, action);
      break;
  }
  return { ...result, index };
}
