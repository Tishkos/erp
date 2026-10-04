/**
 * The Task Center — platform phase, Agent 3.
 *
 * A task is a piece of work one person asks another to do (`domain/tasks.ts`
 * is the road and the arithmetic; migrations 0340–0343 hold the same rules at
 * the database). This is the only writer of `task`.
 *
 *     create (a draft)  ──assign──▶  accept / reject  ──▶  start ⇄ block  ──▶  submit
 *     ──▶ the assigner completes it or returns it;  reassign and cancel along the way
 *
 * Who may give a task to whom is the one question that is not this file's to
 * answer: `app_task_scope` (0341) is asked — by this service for a sentence a
 * person can act on, by the dropdown for the list it offers, and by a trigger
 * for whoever writes anyway. Seeing a task is row-level security
 * (`app_task_visible_to`), so every read here is the caller's own and an
 * unreachable task is simply not found.
 *
 * Notifications are emitted through `notifications.insertNotification` only,
 * to people who may open the task (asked of the database with the values just
 * written), and never to the person who did it. The daily sweep is
 * `task-sweep.ts`.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { task } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { can, type PermissionVerb, type Principal } from '../domain/permissions';
import {
  AUDIT_ACTION,
  DUE_SOON_DAYS,
  NOTICE_FOR_ACTION,
  OWED,
  TASK_SERIES,
  TaskError,
  WATCHERS_MAX,
  actionsFor,
  assertDescription,
  assertDueDate,
  assertPriority,
  assertTitle,
  assertTransition,
  dueState,
  mayTake,
  noticeText,
  normaliseTags,
  progressOf,
  reasonFor,
  recipientsOf,
  RELATED_LABEL_MAX,
  type DueState,
  type ScopeVia,
  type TaskAction,
  type TaskNotificationKind,
  type TaskPriority,
  type TaskStanding,
  type TaskStatus,
} from '../domain/tasks';
import { AdminNotFoundError, recordChange } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as chat from './chat';
import * as links from './cloud-link-targets';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'task';
export { TaskError };

type TaskRow = typeof task.$inferSelect;
type Reader = { principal: Principal };

const OWED_SQL = sql`('assigned', 'accepted', 'in_progress', 'blocked')`;
const uuidOf = (value: string | null | undefined): string | null => {
  const id = (value ?? '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
};

async function load(tx: Tx, taskNo: string, options: { lock?: boolean } = {}): Promise<TaskRow> {
  const query = tx.select().from(task).where(eq(task.taskNo, taskNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('task', taskNo);
  return row;
}

// ---------------------------------------------------------------------------
// Standing: what this person may do with this task
// ---------------------------------------------------------------------------

export function standingOf(reader: Reader, row: Pick<TaskRow, 'status' | 'assigneeId' | 'assignedBy' | 'createdBy'>): TaskStanding {
  const me = reader.principal.userId;
  return {
    status: row.status as TaskStatus,
    isAssignee: row.assigneeId === me,
    isAssigner: row.assignedBy === me,
    isCreator: row.createdBy === me,
    isAdmin: can(reader.principal, 'administer', PERMISSION_OBJECT),
  };
}

/** The permission an action asks, on top of the part the person plays on the task. */
function holdsFor(principal: Principal, action: TaskAction, standing: TaskStanding): boolean {
  switch (action) {
    case 'assign':
      return can(principal, 'submit', PERMISSION_OBJECT);
    case 'accept':
    case 'reject':
    case 'start':
    case 'block':
    case 'resume':
    case 'submit':
      return can(principal, 'execute', PERMISSION_OBJECT);
    case 'complete':
    case 'return':
    case 'reassign':
      return can(principal, 'submit', PERMISSION_OBJECT) || can(principal, 'administer', PERMISSION_OBJECT);
    case 'cancel':
      return (standing.isCreator && can(principal, 'create', PERMISSION_OBJECT)) || can(principal, 'submit', PERMISSION_OBJECT) || can(principal, 'administer', PERMISSION_OBJECT);
  }
}

/** The actions to offer — only the ones this person may take, in the road's order. */
export function actionsAvailable(reader: Reader, row: Pick<TaskRow, 'status' | 'assigneeId' | 'assignedBy' | 'createdBy'>): TaskAction[] {
  const standing = standingOf(reader, row);
  return actionsFor(standing).filter((action) => holdsFor(reader.principal, action, standing));
}

const WHO: Readonly<Record<TaskAction, string>> = {
  assign: 'the person who raised the draft',
  accept: 'the person it is assigned to',
  reject: 'the person it is assigned to',
  start: 'the person it is assigned to',
  block: 'the person it is assigned to',
  resume: 'the person it is assigned to',
  submit: 'the person it is assigned to',
  complete: 'the person who assigned it (or an administrator)',
  return: 'the person who assigned it (or an administrator)',
  reassign: 'the person who assigned it (or an administrator)',
  cancel: 'the person who raised or assigned it (or an administrator)',
};

// ---------------------------------------------------------------------------
// The assignment scope, asked of the database
// ---------------------------------------------------------------------------

export interface Assignee {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly via: ScopeVia;
  readonly employeeNo: string | null;
}

/** Why `actor` may give `departmentCode`'s work to `assignee` in the branch — or null when they may not. */
export async function scopeOf(tx: Tx, actorId: string, assigneeId: string, departmentCode: string, branchCode: string): Promise<ScopeVia | null> {
  const result = await tx.execute(sql`select app_task_scope(${actorId}::uuid, ${assigneeId}::uuid, ${departmentCode}, ${branchCode}) as via`);
  return ((result.rows[0] as { via: ScopeVia | null } | undefined)?.via ?? null) as ScopeVia | null;
}

/** The sections this person may raise a task in. */
export async function sectionsFor(tx: Tx, ctx: Reader): Promise<{ code: string; name: string }[]> {
  const result = await tx.execute(sql`
    select d.code, d.name
      from department d
     where d.code in (select app_task_sections(${ctx.principal.userId}::uuid))
     order by d.name`);
  return result.rows as { code: string; name: string }[];
}

/** The people this person may assign to in a section — exactly what the dropdown offers. */
export async function assigneesFor(tx: Tx, ctx: Reader, departmentCode: string, branchCode: string): Promise<Assignee[]> {
  const result = await tx.execute(sql`
    select u.id, u.display_name as name, u.email, e.via,
           (select m.employee_no from employee m where m.app_user_id = u.id limit 1) as "employeeNo"
      from app_task_eligible(${ctx.principal.userId}::uuid, ${departmentCode}, ${branchCode}) e
      join app_user u on u.id = e.user_id
     order by case e.via when 'self' then 0 else 1 end, u.display_name`);
  return result.rows as unknown as Assignee[];
}

/** Everything the create dialog needs in one read: sections, each with its people. */
export async function assignmentChoices(tx: Tx, ctx: Reader, branchCode: string) {
  const sections = await sectionsFor(tx, ctx);
  const withPeople = [];
  for (const section of sections) withPeople.push({ ...section, assignees: await assigneesFor(tx, ctx, section.code, branchCode) });
  return withPeople;
}

/** People who could be named a watcher: they can open a task in this branch. */
export async function watcherChoices(tx: Tx, branchCode: string): Promise<{ id: string; name: string }[]> {
  const result = await tx.execute(sql`
    select u.id, u.display_name as name
      from app_user u
     where u.is_active and app_task_may_watch(u.id, ${branchCode})
     order by u.display_name`);
  return result.rows as { id: string; name: string }[];
}

/** Does this person lead anybody (administer, manage a section, or manage an employee)? Shows the Team view. */
export async function leadsAnyone(tx: Tx, ctx: Reader): Promise<boolean> {
  if (!can(ctx.principal, 'view', PERMISSION_OBJECT)) return false;
  const result = await tx.execute(sql`select app_task_leads(${ctx.principal.userId}::uuid) as yes`);
  return Boolean((result.rows[0] as { yes: boolean } | undefined)?.yes);
}

async function nameOf(tx: Tx, userId: string): Promise<string> {
  const result = await tx.execute(sql`select display_name as name from app_user where id = ${userId}::uuid`);
  return (result.rows[0] as { name: string } | undefined)?.name ?? 'Someone';
}

// ---------------------------------------------------------------------------
// Notifications: told once, to people who may open the task, never to the doer
// ---------------------------------------------------------------------------

/** Of these people, the ones who may open this task — asked with the values just written. */
async function whoMaySee(tx: Tx, ids: readonly string[], row: TaskRow): Promise<string[]> {
  if (ids.length === 0) return [];
  const result = await tx.execute(sql`
    select c.id::text as id
      from unnest(${ids as string[]}::uuid[]) as c(id)
     where app_task_visible_to(c.id, ${row.status}, ${row.createdBy}::uuid, ${row.assignedBy}::uuid, ${row.assigneeId}::uuid,
                               ${row.watcherIds as string[]}::uuid[], ${row.departmentCode}, ${row.branchCode})`);
  return (result.rows as { id: string }[]).map((r) => r.id);
}

async function announce(
  tx: Tx,
  row: TaskRow,
  kind: TaskNotificationKind,
  options: { actorId: string | null; actorName?: string | null; previousAssignee?: string | null; reason?: string | null; occurrence: string; days?: number | null },
): Promise<number> {
  const wanted = recipientsOf(
    kind,
    { creator: row.createdBy, assigner: row.assignedBy, assignee: row.assigneeId, watchers: row.watcherIds },
    options.previousAssignee ?? null,
  ).filter((id) => id !== options.actorId);
  const people = await whoMaySee(tx, wanted, row);
  const assigneeName = row.assigneeId && (kind === 'task.assigned' || kind === 'task.reassigned') ? await nameOf(tx, row.assigneeId) : null;
  const text = noticeText(kind, { taskNo: row.taskNo, title: row.title, actor: options.actorName ?? null, assignee: assigneeName, reason: options.reason ?? null, dueDate: row.dueDate, days: options.days ?? null });
  let created = 0;
  for (const recipientUserId of people) {
    const id = await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: kind,
      objectType: PERMISSION_OBJECT,
      objectId: row.taskNo,
      recipientUserId,
      subject: text.subject,
      body: text.body,
      context: { taskNo: row.taskNo, title: row.title, status: row.status, priority: row.priority, dueDate: row.dueDate, href: `/tasks/${encodeURIComponent(row.taskNo)}` },
      dedupeKey: `${kind}:${row.taskNo}:${options.occurrence}:${recipientUserId}`,
      branchCode: row.branchCode,
    });
    if (id !== null) created += 1;
  }
  return created;
}

/** The sweep's entry: due-soon and overdue notices are raised through the same filter as every other. */
export const announceFromSweep = (tx: Tx, row: TaskRow, kind: 'task.due_soon' | 'task.overdue', occurrence: string, days: number) =>
  announce(tx, row, kind, { actorId: null, occurrence, days });

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface TaskInput {
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: string | null;
  /** YYYY-MM-DD; today or later. */
  readonly dueDate?: string | null;
  readonly departmentCode: string;
  /** Given: the task is assigned as it is made. Empty: it stays a draft. */
  readonly assigneeId?: string | null;
  readonly relatedType?: string | null;
  /** The number a person knows the record by. */
  readonly relatedNo?: string | null;
  readonly tags?: string | readonly string[] | null;
  readonly watcherIds?: readonly string[] | null;
}

async function relatedOf(tx: Tx, ctx: Reader, type: string | null | undefined, no: string | null | undefined, selfId?: string) {
  const kind = (type ?? '').trim();
  const number = (no ?? '').trim();
  if (!kind && !number) return { relatedType: null, relatedId: null, relatedLabel: null };
  if (!kind || !number) throw new TaskError('Name the kind of record and its number, or neither.');
  const found = await links.findRecord(tx, ctx.principal, kind, number);
  if (!found) throw new TaskError(`There is no ${kind.replace(/_/g, ' ')} '${number}' that you may open.`);
  if (selfId && found.type === PERMISSION_OBJECT && found.id === selfId) throw new TaskError('A task cannot be related to itself.');
  return { relatedType: found.type, relatedId: found.id, relatedLabel: found.label.slice(0, RELATED_LABEL_MAX) };
}

function watchersOf(ids: readonly string[] | null | undefined, exclude: readonly (string | null)[] = []): string[] {
  const skip = new Set(exclude.filter(Boolean));
  const kept = [...new Set((ids ?? []).map((id) => uuidOf(id)).filter((id): id is string => id !== null && !skip.has(id)))];
  if (kept.length > WATCHERS_MAX) throw new TaskError(`A task has at most ${WATCHERS_MAX} watchers.`);
  return kept;
}

/** Raise a task: a draft, or — when an assignee is named — assigned at once. */
export async function create(tx: Tx, ctx: ActorContext, input: TaskInput): Promise<{ id: string; taskNo: string; assigned: boolean }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode, requestId: ctx.requestId ?? null });
  const me = ctx.principal.userId;
  const title = assertTitle(input.title);
  const description = assertDescription(input.description);
  const priority = assertPriority(input.priority);
  const dueDate = assertDueDate(input.dueDate, businessToday());
  const tags = normaliseTags(input.tags);
  const departmentCode = (input.departmentCode ?? '').trim();
  const sections = await sectionsFor(tx, ctx);
  if (!sections.some((s) => s.code === departmentCode)) throw new TaskError('Choose one of your own sections for the task.');
  const watcherIds = watchersOf(input.watcherIds, [me]);
  const related = await relatedOf(tx, ctx, input.relatedType, input.relatedNo);

  const allocated = await allocateDocumentNumber(tx, TASK_SERIES, { branchCode: ctx.branchCode }, me);
  const [made] = await tx
    .insert(task)
    .values({ taskNo: allocated.documentNo, title, description, priority, dueDate, departmentCode, branchCode: ctx.branchCode, createdBy: me, tags, watcherIds, ...related })
    .returning({ id: task.id });
  await recordChange(tx, ctx, {
    action: 'task.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode: ctx.branchCode,
    after: { title, priority, dueDate, departmentCode, related: related.relatedLabel, tags },
  });

  const assigneeId = uuidOf(input.assigneeId);
  if (assigneeId) {
    await act(tx, ctx, allocated.documentNo, 'assign', { assigneeId });
    return { id: made!.id, taskNo: allocated.documentNo, assigned: true };
  }
  return { id: made!.id, taskNo: allocated.documentNo, assigned: false };
}

export interface AmendInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly priority?: string | null;
  readonly dueDate?: string | null;
  readonly tags?: string | readonly string[] | null;
  readonly relatedType?: string | null;
  readonly relatedNo?: string | null;
}

/** Change what a task says: its raiser while it is a draft; its raiser, assigner or an administrator afterwards. */
export async function amend(tx: Tx, ctx: ActorContext, taskNo: string, input: AmendInput): Promise<void> {
  const row = await load(tx, taskNo, { lock: true });
  const standing = standingOf(ctx, row);
  if (row.status === 'completed' || row.status === 'cancelled') throw new TaskError(`${taskNo} is ${row.status} and is final.`);
  if (row.status === 'draft') {
    if (!standing.isCreator) throw new TaskError('Only the person who raised a draft changes it.');
    await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: taskNo, requestId: ctx.requestId ?? null });
  } else {
    if (!(standing.isCreator || standing.isAssigner || standing.isAdmin)) throw new TaskError(`Only the person who raised or assigned ${taskNo} (or an administrator) changes what it says.`);
    if (!(can(ctx.principal, 'submit', PERMISSION_OBJECT) || can(ctx.principal, 'create', PERMISSION_OBJECT) || standing.isAdmin)) {
      await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: taskNo, requestId: ctx.requestId ?? null });
    }
  }

  const patch: Partial<typeof task.$inferInsert> = {};
  if (input.title !== undefined) patch.title = assertTitle(input.title);
  if (input.description !== undefined) patch.description = assertDescription(input.description);
  if (input.priority !== undefined) patch.priority = assertPriority(input.priority);
  if (input.dueDate !== undefined) {
    // A deadline already in the past may be left as it is; a new one is not set in the past.
    const wanted = (input.dueDate ?? '').trim() || null;
    if (wanted !== row.dueDate) patch.dueDate = assertDueDate(wanted, businessToday());
  }
  if (input.tags !== undefined) patch.tags = normaliseTags(input.tags);
  if (input.relatedType !== undefined || input.relatedNo !== undefined) {
    // The record already named stays as it is (its raiser may since have lost the right to open it); only a change is looked up.
    const same = (input.relatedType ?? '').trim() === (row.relatedType ?? '') && (input.relatedNo ?? '').trim() === (row.relatedLabel ?? '');
    if (!same) Object.assign(patch, await relatedOf(tx, ctx, input.relatedType, input.relatedNo, row.id));
  }

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const was = (row as Record<string, unknown>)[key];
    if (JSON.stringify(was ?? null) === JSON.stringify(value ?? null)) continue;
    before[key] = was ?? null;
    after[key] = value ?? null;
  }
  if (Object.keys(after).length === 0) return;
  const changed = Object.keys(after);
  await tx.update(task).set({ ...patch, updatedAt: new Date() }).where(eq(task.id, row.id));
  await recordChange(tx, ctx, { action: 'task.updated', objectType: PERMISSION_OBJECT, objectId: taskNo, branchCode: row.branchCode, before, after });

  // The assignee hears when the work they owe has changed — not for a tag.
  if (row.status !== 'draft' && changed.some((k) => ['title', 'description', 'priority', 'dueDate'].includes(k))) {
    const [fresh] = await tx.select().from(task).where(eq(task.id, row.id)).limit(1);
    if (fresh) await announce(tx, fresh, 'task.updated', { actorId: ctx.principal.userId, actorName: await nameOf(tx, ctx.principal.userId), occurrence: new Date().toISOString() });
  }
}

export interface ActInput {
  /** Why — required for reject, block, return, reassign and cancel. */
  readonly reason?: string | null;
  /** Assign and reassign: who it goes to. */
  readonly assigneeId?: string | null;
  /** Assign and reassign: the section, where it is not the task's own. */
  readonly departmentCode?: string | null;
}

/**
 * One step along the road. The row is locked before its status is read, so a
 * double submit moves it once; the road, the person and the reason are checked
 * here for a sentence, and again by the trigger for anybody else.
 */
export async function act(tx: Tx, ctx: ActorContext, taskNo: string, action: TaskAction, input: ActInput = {}): Promise<void> {
  const row = await load(tx, taskNo, { lock: true });
  const standing = standingOf(ctx, row);
  const to = assertTransition(taskNo, row.status, action);
  if (!mayTake(action, standing)) throw new TaskError(`Only ${WHO[action]} can ${action} ${taskNo}.`);
  const verbs: Record<TaskAction, PermissionVerb> = { assign: 'submit', accept: 'execute', reject: 'execute', start: 'execute', block: 'execute', resume: 'execute', submit: 'execute', complete: 'submit', return: 'submit', reassign: 'submit', cancel: 'submit' };
  if (!holdsFor(ctx.principal, action, standing)) {
    await authz.authorize(ctx.principal, verbs[action], PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: taskNo, requestId: ctx.requestId ?? null });
  }
  const me = ctx.principal.userId;
  const reason = reasonFor(action, input.reason);

  const set: Partial<typeof task.$inferInsert> = { status: to, statusNote: reason, updatedAt: new Date() };
  if (action === 'assign' || action === 'reassign') {
    const assigneeId = uuidOf(input.assigneeId);
    if (!assigneeId) throw new TaskError(`Choose who ${taskNo} is for.`);
    const departmentCode = (input.departmentCode ?? '').trim() || row.departmentCode;
    if (action === 'reassign' && assigneeId === row.assigneeId && departmentCode === row.departmentCode && row.status !== 'rejected') {
      throw new TaskError(`${taskNo} is already with that person; choose somebody else.`);
    }
    const sections = await sectionsFor(tx, ctx);
    if (!sections.some((s) => s.code === departmentCode)) throw new TaskError('Choose one of your own sections for the task.');
    const via = await scopeOf(tx, me, assigneeId, departmentCode, row.branchCode);
    if (!via) {
      throw new TaskError(`${await nameOf(tx, assigneeId)} is outside the people you may assign to in this section. Choose someone from the list.`);
    }
    set.assigneeId = assigneeId;
    set.assignedBy = me;
    set.departmentCode = departmentCode;
  }

  const [after] = await tx.update(task).set(set).where(eq(task.id, row.id)).returning();
  if (!after) throw new TaskError(`${taskNo} could not be changed.`);
  await recordChange(tx, ctx, {
    action: AUDIT_ACTION[action],
    objectType: PERMISSION_OBJECT,
    objectId: taskNo,
    branchCode: row.branchCode,
    before: { status: row.status, assigneeId: row.assigneeId, departmentCode: row.departmentCode },
    after: { status: after.status, assigneeId: after.assigneeId, departmentCode: after.departmentCode },
    reason,
  });
  await announce(tx, after, NOTICE_FOR_ACTION[action], {
    actorId: me,
    actorName: await nameOf(tx, me),
    previousAssignee: row.assigneeId,
    reason,
    occurrence: after.updatedAt.toISOString(),
  });
}

export const assign = (tx: Tx, ctx: ActorContext, taskNo: string, assigneeId: string, departmentCode?: string | null) => act(tx, ctx, taskNo, 'assign', { assigneeId, departmentCode: departmentCode ?? null });

/** Add or take away a watcher: by the task's people; the database holds that each can open it. */
export async function setWatchers(tx: Tx, ctx: ActorContext, taskNo: string, watcherIds: readonly string[]): Promise<void> {
  const row = await load(tx, taskNo, { lock: true });
  const standing = standingOf(ctx, row);
  if (row.status === 'completed' || row.status === 'cancelled') throw new TaskError(`${taskNo} is ${row.status} and is final.`);
  if (!(standing.isCreator || standing.isAssigner || standing.isAssignee || standing.isAdmin)) throw new TaskError(`Only the people on ${taskNo} choose who watches it.`);
  const next = watchersOf(watcherIds, [row.createdBy, row.assigneeId]);
  const before = [...row.watcherIds].sort();
  if (JSON.stringify(before) === JSON.stringify([...next].sort())) return;
  await tx.update(task).set({ watcherIds: next, updatedAt: new Date() }).where(eq(task.id, row.id));
  await recordChange(tx, ctx, { action: 'task.watchers_changed', objectType: PERMISSION_OBJECT, objectId: taskNo, branchCode: row.branchCode, before: { watcherIds: before }, after: { watcherIds: next } });
}

// ---------------------------------------------------------------------------
// Reply in Chat
// ---------------------------------------------------------------------------

/**
 * The conversation about this task with the other person on it — the assignee
 * when the asker assigned it, the assigner when the asker has it — opened in
 * the asker's own transaction, so a task that cannot be opened cannot be talked
 * about. Returns the conversation to open; nothing is sent.
 */
export async function openChat(tx: Tx, ctx: ActorContext, taskNo: string): Promise<{ conversationId: string; counterpartId: string }> {
  const row = await load(tx, taskNo);
  const me = ctx.principal.userId;
  const others = [row.assigneeId, row.assignedBy, row.createdBy].filter((id): id is string => Boolean(id) && id !== me);
  const counterpartId = others[0];
  if (!counterpartId) throw new TaskError(`${taskNo} has nobody else on it to talk to yet.`);
  const outcome = await chat.openRecordConversation(tx, ctx, {
    recordType: PERMISSION_OBJECT,
    recordId: row.id,
    label: row.taskNo,
    href: `/tasks/${encodeURIComponent(row.taskNo)}`,
    memberIds: [counterpartId],
  });
  return { conversationId: outcome.conversationId, counterpartId };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const VIEWS = ['mine', 'assigned', 'team'] as const;
export type TaskView = (typeof VIEWS)[number];
export const BUCKETS = ['all', 'open', 'today', 'soon', 'overdue', 'blocked', 'review', 'completed'] as const;
export type TaskBucket = (typeof BUCKETS)[number];

export const isView = (value: string | null | undefined): value is TaskView => (VIEWS as readonly string[]).includes(value ?? '');
export const isBucket = (value: string | null | undefined): value is TaskBucket => (BUCKETS as readonly string[]).includes(value ?? '');

const viewSql = (view: TaskView, me: string) => {
  switch (view) {
    case 'mine':
      return sql`t.assignee_id = ${me}::uuid and t.status <> 'draft'`;
    case 'assigned':
      return sql`(t.created_by = ${me}::uuid or t.assigned_by = ${me}::uuid) and (t.status = 'draft' or t.assignee_id is distinct from ${me}::uuid)`;
    case 'team':
      return sql`t.status <> 'draft' and t.assignee_id is distinct from ${me}::uuid
                 and (app_task_holds(${me}::uuid, 'administer') or app_task_manages(${me}::uuid, t.department_code) or app_task_reports_to(${me}::uuid, t.assignee_id))`;
  }
};

const bucketSql = (bucket: TaskBucket, today: string) => {
  const day = sql`${today}::date`;
  switch (bucket) {
    case 'all':
      return sql`true`;
    case 'open':
      return sql`t.status in ${OWED_SQL}`;
    case 'today':
      return sql`t.status in ${OWED_SQL} and t.due_date = ${day}`;
    case 'soon':
      return sql`t.status in ${OWED_SQL} and t.due_date > ${day} and t.due_date <= ${day} + ${DUE_SOON_DAYS}::int`;
    case 'overdue':
      return sql`t.status in ${OWED_SQL} and t.due_date < ${day}`;
    case 'blocked':
      return sql`t.status = 'blocked'`;
    case 'review':
      return sql`t.status = 'submitted'`;
    case 'completed':
      return sql`t.status = 'completed'`;
  }
};

export interface TaskListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly bucket?: string | null;
  readonly search?: string | null;
}

export interface TaskListRow {
  readonly id: string;
  readonly taskNo: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueDate: string | null;
  readonly dueState: DueState;
  readonly progress: number;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly assignedById: string | null;
  readonly assignedByName: string | null;
  readonly createdOn: string;
}

const FROM = sql`from task t
  join department d on d.code = t.department_code
  left join app_user a on a.id = t.assignee_id
  left join app_user ab on ab.id = t.assigned_by`;

export async function listForScreen(tx: Tx, ctx: Reader, filter: TaskListFilter, today = businessToday()) {
  const me = ctx.principal.userId;
  const view: TaskView = isView(filter.view) ? filter.view : 'mine';
  const bucket: TaskBucket = isBucket(filter.bucket) ? filter.bucket : 'all';
  const where = whereOf([viewSql(view, me), bucketSql(bucket, today), searchOf([sql`t.task_no`, sql`t.title`, sql`a.display_name`, sql`ab.display_name`, sql`t.related_label`, sql`d.name`], filter.search)]);
  const from = sql`${FROM} ${where}`;
  const page = await registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select t.id, t.task_no as "taskNo", t.title, t.status, t.priority, t.due_date::text as "dueDate",
                 t.department_code as "departmentCode", d.name as "departmentName",
                 t.assignee_id as "assigneeId", a.display_name as "assigneeName",
                 t.assigned_by as "assignedById", ab.display_name as "assignedByName",
                 to_char(t.created_at at time zone 'Asia/Baghdad', 'YYYY-MM-DD') as "createdOn"
            ${from}
           order by case when t.status in ${OWED_SQL} then 0 when t.status = 'submitted' then 1 when t.status = 'draft' then 2 else 3 end,
                    t.due_date nulls last,
                    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
                    t.created_at desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as Omit<TaskListRow, 'dueState' | 'progress'>[],
  });
  return {
    ...page,
    view,
    bucket,
    rows: page.rows.map((r): TaskListRow => ({ ...r, dueState: dueState(r.status, r.dueDate, today), progress: progressOf(r.status) })),
  };
}

export type BucketCounts = Readonly<Record<TaskBucket, number>>;

/** How many tasks each bucket holds in a view — the numbers the filter's choices carry. */
export async function countsFor(tx: Tx, ctx: Reader, view: TaskView, today = businessToday()): Promise<BucketCounts> {
  const me = ctx.principal.userId;
  const parts = BUCKETS.map((b) => sql`count(*) filter (where ${bucketSql(b, today)})::int as ${sql.identifier(b)}`);
  const result = await tx.execute(sql`select ${sql.join(parts, sql`, `)} ${FROM} where ${viewSql(view, me)}`);
  const row = (result.rows[0] ?? {}) as Partial<Record<TaskBucket, number>>;
  return Object.fromEntries(BUCKETS.map((b) => [b, Number(row[b] ?? 0)])) as BucketCounts;
}

export interface WorkloadRow {
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly assigneeId: string;
  readonly assigneeName: string;
  readonly employeeNo: string | null;
  readonly open: number;
  readonly overdue: number;
  readonly blocked: number;
  readonly review: number;
  readonly completed: number;
}

/** The team's load, a person at a time within a section, over the tasks this person may see by authority. */
export async function teamWorkload(tx: Tx, ctx: Reader, today = businessToday()): Promise<WorkloadRow[]> {
  const me = ctx.principal.userId;
  const result = await tx.execute(sql`
    select t.department_code as "departmentCode", d.name as "departmentName", t.assignee_id as "assigneeId", a.display_name as "assigneeName",
           (select m.employee_no from employee m where m.app_user_id = t.assignee_id limit 1) as "employeeNo",
           (count(*) filter (where ${bucketSql('open', today)}))::int as open,
           (count(*) filter (where ${bucketSql('overdue', today)}))::int as overdue,
           (count(*) filter (where ${bucketSql('blocked', today)}))::int as blocked,
           (count(*) filter (where ${bucketSql('review', today)}))::int as review,
           (count(*) filter (where ${bucketSql('completed', today)}))::int as completed
      ${FROM}
     where ${viewSql('team', me)} and t.assignee_id is not null
     group by t.department_code, d.name, t.assignee_id, a.display_name
     order by d.name, a.display_name`);
  return result.rows as unknown as WorkloadRow[];
}

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly employeeNo: string | null;
}

export interface TaskRecord {
  readonly row: TaskRow;
  readonly departmentName: string;
  readonly createdBy: Person;
  readonly assignedBy: Person | null;
  readonly assignee: Person | null;
  readonly watchers: Person[];
  readonly standing: TaskStanding;
  readonly actions: TaskAction[];
  readonly dueState: DueState;
  readonly daysLeft: number | null;
  readonly progress: number;
  /** The related record, with the link only when this reader may open it. */
  readonly related: { type: string; id: string; label: string; href: string | null } | null;
  readonly mayEdit: boolean;
  readonly mayWatch: boolean;
}

async function peopleByIds(tx: Tx, ids: readonly string[]): Promise<Map<string, Person>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const result = await tx.execute(sql`
    select u.id, u.display_name as name, (select m.employee_no from employee m where m.app_user_id = u.id limit 1) as "employeeNo"
      from app_user u where u.id = any(${unique}::uuid[])`);
  return new Map((result.rows as unknown as Person[]).map((p) => [p.id, p]));
}

/** The task as this reader may see it, or null — a task one cannot open is not found. */
export async function byNo(tx: Tx, ctx: Reader, taskNo: string, today = businessToday()): Promise<TaskRecord | null> {
  const [row] = await tx.select().from(task).where(eq(task.taskNo, taskNo)).limit(1);
  if (!row) return null;
  const [department] = (await tx.execute(sql`select name from department where code = ${row.departmentCode}`)).rows as { name: string }[];
  const people = await peopleByIds(tx, [row.createdBy, row.assignedBy ?? '', row.assigneeId ?? '', ...row.watcherIds]);
  const person = (id: string | null): Person | null => (id ? (people.get(id) ?? { id, name: '—', employeeNo: null }) : null);
  const standing = standingOf(ctx, row);
  const related = row.relatedType && row.relatedId && row.relatedLabel ? await relatedView(tx, ctx, row.relatedType, row.relatedId, row.relatedLabel) : null;
  const status = row.status as TaskStatus;
  const live = status !== 'completed' && status !== 'cancelled';
  const state = dueState(status, row.dueDate, today);
  const days = row.dueDate && OWED.includes(status) ? Math.round((Date.parse(`${row.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return {
    row,
    departmentName: department?.name ?? row.departmentCode,
    createdBy: person(row.createdBy)!,
    assignedBy: person(row.assignedBy),
    assignee: person(row.assigneeId),
    watchers: row.watcherIds.map((id) => person(id)!).filter(Boolean),
    standing,
    actions: actionsAvailable(ctx, row),
    dueState: state,
    daysLeft: days,
    progress: progressOf(status),
    related,
    mayEdit: live && (status === 'draft' ? standing.isCreator : standing.isCreator || standing.isAssigner || standing.isAdmin),
    mayWatch: live && (standing.isCreator || standing.isAssigner || standing.isAssignee || standing.isAdmin),
  };
}

async function relatedView(tx: Tx, ctx: Reader, type: string, id: string, label: string) {
  const opened = await links.openRecord(tx, ctx.principal, type, id);
  return { type, id, label, href: opened?.href ?? null };
}

/** The kinds of record a task may be about, for the reader — what the dialog's "Related to" offers. */
export function relatedKinds(ctx: Reader): { type: string; folderName: string }[] {
  return links
    .targetsFor(ctx.principal)
    .filter((t) => t.type !== 'customer' && t.type !== 'supplier')
    .map((t) => ({ type: t.type, folderName: t.folderName }))
    .sort((a, b) => a.folderName.localeCompare(b.folderName));
}

// ---------------------------------------------------------------------------
// For the Dashboard and the Exceptions Center
// ---------------------------------------------------------------------------

export interface TaskBrief {
  readonly taskNo: string;
  readonly title: string;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly dueDate: string | null;
  /** Days past the due date (positive), or 0. */
  readonly daysLate: number;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly departmentCode: string;
  readonly branchCode: string;
  readonly href: string;
}

export interface TaskSummary {
  /** False when the reader holds no `view` on tasks: every number is then zero and every list empty. */
  readonly available: boolean;
  readonly asOf: string;
  readonly mine: { open: number; dueToday: number; dueSoon: number; overdue: number; blocked: number };
  readonly assignedByMe: { open: number; overdue: number; blocked: number; waitingForMe: number };
  readonly team: { open: number; overdue: number; blocked: number } | null;
  readonly next: TaskBrief[];
}

const EMPTY_SUMMARY = (asOf: string): TaskSummary => ({
  available: false,
  asOf,
  mine: { open: 0, dueToday: 0, dueSoon: 0, overdue: 0, blocked: 0 },
  assignedByMe: { open: 0, overdue: 0, blocked: 0, waitingForMe: 0 },
  team: null,
  next: [],
});

const briefSelect = (today: string) => sql`
  select t.task_no as "taskNo", t.title, t.status, t.priority, t.due_date::text as "dueDate",
         greatest(0, (${today}::date - t.due_date))::int as "daysLate",
         t.assignee_id as "assigneeId", a.display_name as "assigneeName",
         t.department_code as "departmentCode", t.branch_code as "branchCode"
    ${FROM}`;

const toBrief = (r: Omit<TaskBrief, 'href'>): TaskBrief => ({ ...r, href: `/tasks/${encodeURIComponent(r.taskNo)}` });

/**
 * What the Dashboard shows for the reader: their own queue, what they gave
 * out, and — when they lead anyone — their team's. Read under the reader's
 * own row-level scope; empty when they hold no `view` on tasks.
 */
export async function dashboardSummary(tx: Tx, ctx: Reader, today = businessToday()): Promise<TaskSummary> {
  if (!can(ctx.principal, 'view', PERMISSION_OBJECT)) return EMPTY_SUMMARY(today);
  const me = ctx.principal.userId;
  const [mine, assigned] = await Promise.all([countsFor(tx, ctx, 'mine', today), countsFor(tx, ctx, 'assigned', today)]);
  const team = (await leadsAnyone(tx, ctx)) ? await countsFor(tx, ctx, 'team', today) : null;
  const waiting = await tx.execute(sql`select count(*)::int as n from task t where t.assigned_by = ${me}::uuid and t.status = 'submitted'`);
  const next = await tx.execute(sql`
    ${briefSelect(today)}
    where ${viewSql('mine', me)} and t.status in ${OWED_SQL}
    order by t.due_date nulls last, case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at
    limit 5`);
  return {
    available: true,
    asOf: today,
    mine: { open: mine.open, dueToday: mine.today, dueSoon: mine.soon, overdue: mine.overdue, blocked: mine.blocked },
    assignedByMe: { open: assigned.open, overdue: assigned.overdue, blocked: assigned.blocked, waitingForMe: Number((waiting.rows[0] as { n: number } | undefined)?.n ?? 0) },
    team: team ? { open: team.open, overdue: team.overdue, blocked: team.blocked } : null,
    next: (next.rows as unknown as Omit<TaskBrief, 'href'>[]).map(toBrief),
  };
}

/** Tasks past their due date and still owed, among those the reader may see (any view). The Exceptions Center's feed. */
export async function overdueTasks(tx: Tx, ctx: Reader, limit = 50, today = businessToday()): Promise<TaskBrief[]> {
  if (!can(ctx.principal, 'view', PERMISSION_OBJECT)) return [];
  const result = await tx.execute(sql`
    ${briefSelect(today)}
    where t.status in ${OWED_SQL} and t.due_date < ${today}::date
    order by t.due_date, t.created_at
    limit ${Math.max(1, Math.min(200, Math.floor(limit)))}`);
  return (result.rows as unknown as Omit<TaskBrief, 'href'>[]).map(toBrief);
}

/** Blocked tasks, among those the reader may see. The Exceptions Center's second feed. */
export async function blockedTasks(tx: Tx, ctx: Reader, limit = 50, today = businessToday()): Promise<TaskBrief[]> {
  if (!can(ctx.principal, 'view', PERMISSION_OBJECT)) return [];
  const result = await tx.execute(sql`
    ${briefSelect(today)}
    where t.status = 'blocked'
    order by t.blocked_at, t.created_at
    limit ${Math.max(1, Math.min(200, Math.floor(limit)))}`);
  return (result.rows as unknown as Omit<TaskBrief, 'href'>[]).map(toBrief);
}

/** For the nightly sweep: every owed task with a due date, as the sweep's (system) scope sees it. */
export async function owedWithDueDate(tx: Tx): Promise<TaskRow[]> {
  return tx
    .select()
    .from(task)
    .where(and(sql`${task.status} in ${OWED_SQL}`, sql`${task.dueDate} is not null`));
}
