/**
 * Task Center — the rules, with no database (platform phase, Agent 3).
 *
 * A task is a piece of work one person asks another to do, with a due date,
 * a section (a department), and — when it concerns an ERP record — that
 * record. It moves along one road and no other:
 *
 *     draft ──assign──▶ assigned ──accept──▶ accepted ──start──▶ in_progress
 *                          │ reject (reason)                       │  ▲
 *                          ▼                                block │  │ resume
 *                       rejected ──reassign──▶ assigned           ▼  │
 *                                                              blocked
 *     in_progress ──submit──▶ submitted ──complete──▶ completed
 *                                 └──return (reason)──▶ in_progress
 *     any live status but `completed` ──cancel (reason)──▶ cancelled
 *     assigned … blocked, rejected ──reassign (reason)──▶ assigned (someone else)
 *
 * `completed` and `cancelled` are final. The table below is the only place
 * the road is written; the service asks it, and migration 0340's trigger
 * (`task_lifecycle_guard`) holds the same pairs at the database —
 * `tests/unit/task-center.test.ts` reads the migration and fails when the
 * two disagree.
 *
 * Who may take each step is part of the road: the assignee accepts, rejects,
 * starts, blocks, resumes and submits; the person who assigned the work
 * reviews it (complete / return), reassigns and cancels. Whether the
 * assigner may give the work to *that* person is a different question —
 * assignment scope — and it is asked of the database
 * (`app_task_may_assign`, migration 0341), not here.
 *
 * Nothing in this file reads a clock: "today" is passed in, and callers take
 * it from `businessToday()` (Asia/Baghdad), never from a UTC slice.
 */

export const TASK_STATUSES = ['draft', 'assigned', 'accepted', 'in_progress', 'blocked', 'submitted', 'completed', 'rejected', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_ACTIONS = ['assign', 'accept', 'reject', 'start', 'block', 'resume', 'submit', 'complete', 'return', 'reassign', 'cancel'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** The document series a task is numbered from: `TASK-001`, `TASK-104`. */
export const TASK_SERIES = 'TASK';

/** A due date this many days away or fewer (and not yet today) is "due soon". */
export const DUE_SOON_DAYS = 3;

export const TITLE_MIN = 3;
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 4000;
export const REASON_MAX = 1000;
export const TAGS_MAX = 8;
export const TAG_MAX = 30;
export const WATCHERS_MAX = 10;

export class TaskError extends Error {
  readonly code = 'TASK';
  constructor(message: string) {
    super(message);
    this.name = 'TaskError';
  }
}

export const isTaskStatus = (value: string): value is TaskStatus => (TASK_STATUSES as readonly string[]).includes(value);
export const isTaskPriority = (value: string): value is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(value);
export const isTaskAction = (value: string): value is TaskAction => (TASK_ACTIONS as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// The road
// ---------------------------------------------------------------------------

/**
 * The part a person plays on one task. `assignee` is who the work is for;
 * `assigner` is who last assigned it and who reviews it; `creator` raised the
 * draft. They are often the same person (a task assigned to oneself).
 */
export type TaskParty = 'assignee' | 'assigner' | 'creator';

export interface TransitionRule {
  readonly from: readonly TaskStatus[];
  readonly to: TaskStatus;
  /** Who may take the step. Someone holding `administer` stands in for the assigner, never for the assignee. */
  readonly by: readonly TaskParty[];
  /** Whether the step says why: `required` refuses an empty reason. */
  readonly reason: 'none' | 'optional' | 'required';
}

const LIVE: readonly TaskStatus[] = ['draft', 'assigned', 'accepted', 'in_progress', 'blocked', 'submitted', 'rejected'];

export const TRANSITIONS: Readonly<Record<TaskAction, TransitionRule>> = {
  assign: { from: ['draft'], to: 'assigned', by: ['creator'], reason: 'none' },
  accept: { from: ['assigned'], to: 'accepted', by: ['assignee'], reason: 'none' },
  reject: { from: ['assigned'], to: 'rejected', by: ['assignee'], reason: 'required' },
  start: { from: ['accepted'], to: 'in_progress', by: ['assignee'], reason: 'none' },
  block: { from: ['in_progress'], to: 'blocked', by: ['assignee'], reason: 'required' },
  resume: { from: ['blocked'], to: 'in_progress', by: ['assignee'], reason: 'none' },
  submit: { from: ['in_progress'], to: 'submitted', by: ['assignee'], reason: 'optional' },
  complete: { from: ['submitted'], to: 'completed', by: ['assigner'], reason: 'optional' },
  return: { from: ['submitted'], to: 'in_progress', by: ['assigner'], reason: 'required' },
  reassign: { from: ['assigned', 'accepted', 'in_progress', 'blocked', 'rejected'], to: 'assigned', by: ['assigner'], reason: 'required' },
  cancel: { from: LIVE, to: 'cancelled', by: ['assigner', 'creator'], reason: 'required' },
};

/** The audit action an action is recorded as: `task.assigned`, `task.accepted`, … */
export const AUDIT_ACTION: Readonly<Record<TaskAction, string>> = {
  assign: 'task.assigned',
  accept: 'task.accepted',
  reject: 'task.rejected',
  start: 'task.started',
  block: 'task.blocked',
  resume: 'task.resumed',
  submit: 'task.submitted',
  complete: 'task.completed',
  return: 'task.returned',
  reassign: 'task.reassigned',
  cancel: 'task.cancelled',
};

/** Every (from, to) pair the road allows — what the database trigger must allow, no more. */
export function allowedPairs(): readonly (readonly [TaskStatus, TaskStatus])[] {
  const pairs = new Map<string, readonly [TaskStatus, TaskStatus]>();
  for (const rule of Object.values(TRANSITIONS)) {
    for (const from of rule.from) pairs.set(`${from}>${rule.to}`, [from, rule.to]);
  }
  return [...pairs.values()].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
}

export const isFinal = (status: TaskStatus): boolean => status === 'completed' || status === 'cancelled';

/**
 * The tone a task's status chip wears. The words are the task's own
 * (`admin.tasks.status_<code>`); the colour borrows the document status it
 * most resembles, so no new chip class is drawn.
 */
export const TASK_STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  assigned: 'submitted',
  accepted: 'approved',
  in_progress: 'executed',
  blocked: 'rejected',
  submitted: 'partially_executed',
  completed: 'posted',
  rejected: 'reversed',
  cancelled: 'cancelled',
};

/** Where this action leads, or a refusal in the sentence the screen shows. */
export function assertTransition(taskNo: string, from: string, action: TaskAction): TaskStatus {
  const rule = TRANSITIONS[action];
  if (!rule || !(rule.from as readonly string[]).includes(from)) {
    throw new TaskError(`${taskNo} is ${from}; it cannot be ${PAST[action]}.`);
  }
  return rule.to;
}

const PAST: Readonly<Record<TaskAction, string>> = {
  assign: 'assigned',
  accept: 'accepted',
  reject: 'rejected',
  start: 'started',
  block: 'blocked',
  resume: 'resumed',
  submit: 'submitted',
  complete: 'completed',
  return: 'returned',
  reassign: 'reassigned',
  cancel: 'cancelled',
};

/** What the person doing it must say, trimmed, or a refusal naming the step. */
export function reasonFor(action: TaskAction, text: string | null | undefined): string | null {
  const rule = TRANSITIONS[action];
  const reason = (text ?? '').trim();
  if (reason.length > REASON_MAX) throw new TaskError(`Keep the reason to ${REASON_MAX} characters.`);
  if (rule.reason === 'required' && reason === '') throw new TaskError(`Say why before the task is ${PAST[action]}.`);
  return reason === '' ? null : reason;
}

export interface TaskStanding {
  readonly status: TaskStatus;
  readonly isAssignee: boolean;
  readonly isAssigner: boolean;
  readonly isCreator: boolean;
  /** Holds `administer` on tasks (or is a super user): may stand in for the assigner. */
  readonly isAdmin: boolean;
}

/** May somebody in this standing take this action on a task in this status? */
export function mayTake(action: TaskAction, standing: TaskStanding): boolean {
  const rule = TRANSITIONS[action];
  if (!(rule.from as readonly string[]).includes(standing.status)) return false;
  return rule.by.some((party) => {
    if (party === 'assignee') return standing.isAssignee;
    if (party === 'creator') return standing.isCreator;
    return standing.isAssigner || standing.isAdmin;
  });
}

/** The actions to show — and only these — for a task in this standing, in the order of the road. */
export function actionsFor(standing: TaskStanding): TaskAction[] {
  return TASK_ACTIONS.filter((action) => mayTake(action, standing));
}

/** The person the next step waits on, for "waiting for me". */
export function waitingOn(status: TaskStatus): TaskParty | null {
  switch (status) {
    case 'draft':
      return 'creator';
    case 'assigned':
    case 'accepted':
    case 'in_progress':
    case 'blocked':
      return 'assignee';
    case 'submitted':
    case 'rejected':
      return 'assigner';
    default:
      return null;
  }
}

/**
 * Where the work stands along the road, 0–100 — the workflow stage, not a
 * measurement of the work: a task is never "62% done", it is accepted, under
 * way, blocked or handed in. Blocked stays where it was (under way).
 */
export function progressOf(status: TaskStatus): number {
  switch (status) {
    case 'draft':
      return 0;
    case 'assigned':
    case 'rejected':
      return 10;
    case 'accepted':
      return 25;
    case 'in_progress':
    case 'blocked':
      return 50;
    case 'submitted':
      return 90;
    case 'completed':
      return 100;
    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Due dates (business dates: "today" is passed in)
// ---------------------------------------------------------------------------

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** Whole days from `today` to `due` — negative once it has passed. */
export function daysUntil(due: string, today: string): number {
  return Math.round(dayNumber(due) - dayNumber(today));
}

/** The statuses the assignee still owes work in: the due date is theirs to meet. */
export const OWED: readonly TaskStatus[] = ['assigned', 'accepted', 'in_progress', 'blocked'];
export const isOwed = (status: TaskStatus): boolean => OWED.includes(status);

export type DueState = 'none' | 'overdue' | 'today' | 'soon' | 'later';

/**
 * Where a due date stands. Only work still owed has one: a task handed in,
 * completed, cancelled, rejected or still a draft is `none` — it is not late,
 * and nobody is asked about it by date.
 */
export function dueState(status: TaskStatus, due: string | null, today: string, soonDays = DUE_SOON_DAYS): DueState {
  if (!due || !isOwed(status)) return 'none';
  const days = daysUntil(due, today);
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= soonDays ? 'soon' : 'later';
}

// ---------------------------------------------------------------------------
// What a person types
// ---------------------------------------------------------------------------

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

export function assertTitle(text: string | null | undefined): string {
  const title = collapse(text ?? '');
  if (title.length < TITLE_MIN) throw new TaskError(`Give the task a title of at least ${TITLE_MIN} characters.`);
  if (title.length > TITLE_MAX) throw new TaskError(`A title is at most ${TITLE_MAX} characters.`);
  return title;
}

export function assertDescription(text: string | null | undefined): string | null {
  const description = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (description === '') return null;
  if (description.length > DESCRIPTION_MAX) throw new TaskError(`A description is at most ${DESCRIPTION_MAX} characters.`);
  return description;
}

export function assertPriority(value: string | null | undefined): TaskPriority {
  const priority = (value ?? '').trim() || 'normal';
  if (!isTaskPriority(priority)) throw new TaskError(`Priority is one of ${TASK_PRIORITIES.join(', ')}.`);
  return priority;
}

/** A due date is a business date, and not one that has already gone when it is set. */
export function assertDueDate(value: string | null | undefined, today: string): string | null {
  const due = (value ?? '').trim();
  if (due === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(dayNumber(due)) || new Date(`${due}T00:00:00Z`).toISOString().slice(0, 10) !== due) {
    throw new TaskError(`'${due}' is not a date. Use YYYY-MM-DD.`);
  }
  if (due < today) throw new TaskError(`The deadline ${due} has already passed; choose today or a later day.`);
  return due;
}

/** Comma- or line-separated tags, trimmed, de-duplicated without regard to case, at most eight. */
export function normaliseTags(input: string | readonly string[] | null | undefined): string[] {
  const pieces = typeof input === 'string' ? input.split(/[,\n؛;،]/) : [...(input ?? [])];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of pieces) {
    const tag = collapse(piece);
    if (tag === '') continue;
    if (tag.length > TAG_MAX) throw new TaskError(`A tag is at most ${TAG_MAX} characters.`);
    const key = tag.toLocaleLowerCase('en');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  if (tags.length > TAGS_MAX) throw new TaskError(`A task carries at most ${TAGS_MAX} tags.`);
  return tags;
}

// ---------------------------------------------------------------------------
// Notifications: who is told what
// ---------------------------------------------------------------------------

/**
 * The kinds the Task Center emits through `notifications.insertNotification`
 * (it builds no bell and no delivery path of its own). The first nine are the
 * brief's; `rejected`, `returned`, `cancelled` and `resumed` tell the people
 * a refusal, a return, a cancellation or a restart concerns; `updated` tells
 * the assignee that what the task says has changed (the deadline moved).
 */
export const TASK_NOTIFICATION_KINDS = [
  'task.assigned',
  'task.accepted',
  'task.rejected',
  'task.started',
  'task.blocked',
  'task.resumed',
  'task.submitted',
  'task.returned',
  'task.completed',
  'task.reassigned',
  'task.cancelled',
  'task.updated',
  'task.due_soon',
  'task.overdue',
] as const;
export type TaskNotificationKind = (typeof TASK_NOTIFICATION_KINDS)[number];

export interface TaskPeople {
  readonly creator: string;
  readonly assigner: string | null;
  readonly assignee: string | null;
  readonly watchers: readonly string[];
}

/**
 * The people a kind of notice is for, before the actor and anyone who cannot
 * open the task are taken out (the service does that against the database).
 *
 *   assigned / reassigned  the assignee (reassigned: the one it was taken from too — if they can still open it)
 *   accepted … submitted   the assigner and the creator, and the watchers
 *   returned               the assignee
 *   completed / cancelled  the assignee, and the watchers
 *   updated                the assignee, and the watchers
 *   due_soon               the assignee
 *   overdue                the assignee and the assigner
 */
export function recipientsOf(kind: TaskNotificationKind, people: TaskPeople, previousAssignee: string | null = null): string[] {
  const out = new Set<string>();
  const add = (id: string | null | undefined) => id && out.add(id);
  switch (kind) {
    case 'task.assigned':
      add(people.assignee);
      people.watchers.forEach(add);
      break;
    case 'task.reassigned':
      add(people.assignee);
      add(previousAssignee);
      people.watchers.forEach(add);
      break;
    case 'task.accepted':
    case 'task.rejected':
    case 'task.started':
    case 'task.blocked':
    case 'task.resumed':
    case 'task.submitted':
      add(people.assigner);
      add(people.creator);
      people.watchers.forEach(add);
      break;
    case 'task.returned':
      add(people.assignee);
      break;
    case 'task.completed':
    case 'task.cancelled':
      add(people.assignee);
      people.watchers.forEach(add);
      break;
    case 'task.updated':
      add(people.assignee);
      people.watchers.forEach(add);
      break;
    case 'task.due_soon':
      add(people.assignee);
      break;
    case 'task.overdue':
      add(people.assignee);
      add(people.assigner);
      break;
  }
  return [...out];
}

/** The notice an action raises, if it raises one. */
export const NOTICE_FOR_ACTION: Readonly<Record<TaskAction, TaskNotificationKind>> = {
  assign: 'task.assigned',
  accept: 'task.accepted',
  reject: 'task.rejected',
  start: 'task.started',
  block: 'task.blocked',
  resume: 'task.resumed',
  submit: 'task.submitted',
  complete: 'task.completed',
  return: 'task.returned',
  reassign: 'task.reassigned',
  cancel: 'task.cancelled',
};

export interface NoticeFacts {
  readonly taskNo: string;
  readonly title: string;
  /** Who did it (display name); the sweep has nobody. */
  readonly actor?: string | null;
  /** The person it is now with, where that is news (assigned, reassigned). */
  readonly assignee?: string | null;
  readonly reason?: string | null;
  readonly dueDate?: string | null;
  /** Days late (overdue) or days left (due soon). */
  readonly days?: number | null;
}

/**
 * What a notice says, in English — the notification row carries `context` for
 * a screen that wants to say it in the reader's own language. One line each
 * for the subject and the body; no markup.
 */
export function noticeText(kind: TaskNotificationKind, facts: NoticeFacts): { subject: string; body: string } {
  const { taskNo, title } = facts;
  const by = facts.actor ? `${facts.actor} ` : '';
  const why = facts.reason ? facts.reason : '';
  const due = facts.dueDate ? ` Due ${facts.dueDate}.` : '';
  switch (kind) {
    case 'task.assigned':
      return { subject: `${taskNo}: ${by}assigned you a task`, body: `${title}.${due}` };
    case 'task.reassigned':
      return { subject: `${taskNo}: ${by}reassigned a task`, body: `${title}${facts.assignee ? ` is now with ${facts.assignee}` : ''}.${why ? ` ${why}` : ''}` };
    case 'task.accepted':
      return { subject: `${taskNo}: ${by}accepted the task`, body: title };
    case 'task.rejected':
      return { subject: `${taskNo}: ${by}declined the task`, body: `${title}. ${why}`.trim() };
    case 'task.started':
      return { subject: `${taskNo}: ${by}started work`, body: title };
    case 'task.blocked':
      return { subject: `${taskNo}: ${by}is blocked`, body: `${title}. ${why}`.trim() };
    case 'task.resumed':
      return { subject: `${taskNo}: ${by}resumed work`, body: title };
    case 'task.submitted':
      return { subject: `${taskNo}: ${by}handed the task in for review`, body: `${title}.${why ? ` ${why}` : ''}` };
    case 'task.returned':
      return { subject: `${taskNo}: ${by}returned the task to you`, body: `${title}. ${why}`.trim() };
    case 'task.completed':
      return { subject: `${taskNo}: ${by}completed the task`, body: title };
    case 'task.cancelled':
      return { subject: `${taskNo}: ${by}cancelled the task`, body: `${title}. ${why}`.trim() };
    case 'task.updated':
      return { subject: `${taskNo}: ${by}changed the task`, body: `${title}.${due}${why ? ` ${why}` : ''}` };
    case 'task.due_soon': {
      const days = facts.days ?? 0;
      return { subject: `${taskNo} is due ${days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`, body: `${title}.${due}` };
    }
    case 'task.overdue': {
      const days = facts.days ?? 0;
      return { subject: `${taskNo} is ${days} day${days === 1 ? '' : 's'} overdue`, body: `${title}.${due}` };
    }
  }
}

// ---------------------------------------------------------------------------
// The assignment scope, named
// ---------------------------------------------------------------------------

/**
 * Why a person is in the assigner's scope, most specific first. The database
 * decides (`app_task_scope`); this names the answer for the screen.
 *
 *   self          oneself
 *   report        somebody who reports to the assigner, directly or through others
 *                 (the employee record's manager link)
 *   department    a member of a section the assigner manages (or a section under it)
 *   organisation  anyone in the section, for a holder of `administer` on tasks
 */
export const SCOPE_VIAS = ['self', 'report', 'department', 'organisation'] as const;
export type ScopeVia = (typeof SCOPE_VIAS)[number];
export const isScopeVia = (value: string): value is ScopeVia => (SCOPE_VIAS as readonly string[]).includes(value);

/** The kinds of ERP record a task may name come from the Document Center's registry; none is invented here. */
export const RELATED_LABEL_MAX = 120;
