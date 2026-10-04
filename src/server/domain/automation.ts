/**
 * Automation rules — the closed vocabulary and the evaluator.
 * Platform phase, Agent 10.
 *
 * A rule is an event key, a short list of CONDITIONS and a short list of
 * ACTIONS, and nothing more. Everything a rule can say is validated here
 * against the declared shape of its event (`domain/automation-events.ts`):
 *
 *   conditions   a field the event declares as testable, an operator its type
 *                allows, a value of that type. Money is compared as a scaled
 *                bigint; there is no expression, no script, no SQL, no
 *                free-form code anywhere in a rule, and an unknown field,
 *                operator or key is REFUSED, never ignored.
 *   actions      one of five kinds (`ACTION_KINDS`), each with its own closed
 *                parameters. None of them posts, pays, receives or moves stock:
 *                `tests/unit/wf01-automation.test.ts` scans this catalogue and the
 *                services' imports for it.
 *
 * `evaluate` is deterministic: the same rule version and the same payload give
 * the same answer, whatever the order of the payload's keys and whatever the
 * time. The runner (`services/automation-runner.ts`) is the only thing that
 * does anything with the answer.
 */
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';
import {
  ACTION_KINDS,
  EVENTS,
  RECIPIENT_KINDS,
  eventOf,
  isUuid,
  type ActionKind,
  type EventDef,
  type EventKey,
  type FieldDef,
  type RecipientKind,
} from './automation-events';
import { SEVERITIES, type Severity } from './exceptions';
import { TASK_PRIORITIES, type TaskPriority } from './tasks';

export class AutomationError extends Error {
  readonly code = 'AUTOMATION';
  constructor(message: string) {
    super(message);
    this.name = 'AutomationError';
  }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const NAME_MIN = 3;
export const NAME_MAX = 80;
export const NOTE_MAX = 300;
export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const CONDITIONS_MAX = 8;
export const ACTIONS_MAX = 6;
export const RECIPIENTS_MAX = 6;
export const IN_LIST_MAX = 10;
export const DUE_IN_DAYS_MAX = 60;
export const REASON_MAX = 1000;

/** The series a rule is numbered from: `AUT-001`. */
export const RULE_SERIES = 'AUTOMATION_RULE';

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const CONDITION_OPS = ['gte', 'gt', 'lte', 'lt', 'eq', 'ne', 'in'] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

const ORDERED: readonly ConditionOp[] = ['gte', 'gt', 'lte', 'lt', 'eq'];
const OPS_BY_TYPE: Readonly<Record<string, readonly ConditionOp[]>> = {
  money: ORDERED,
  int: ORDERED,
  code: ['eq', 'ne', 'in'],
};

export interface Condition {
  readonly field: string;
  readonly op: ConditionOp;
  /** Money: a decimal string (four places). Days: a whole number. A code: text, or a list for `in`. */
  readonly value: string | number | readonly string[];
}

export const opsFor = (def: FieldDef): readonly ConditionOp[] => OPS_BY_TYPE[def.type] ?? [];

const CODE = /^[A-Za-z0-9_.\- ]{1,60}$/;

const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(what: string, value: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new AutomationError(`${what} has no "${key}".`);
}

function conditionOf(event: EventDef, raw: unknown, position: number): Condition {
  const at = `Condition ${position + 1}`;
  if (!plain(raw)) throw new AutomationError(`${at} must be a field, an operator and a value.`);
  onlyKeys(at, raw, ['field', 'op', 'value']);
  const field = typeof raw.field === 'string' ? raw.field : '';
  const def = event.fields[field];
  if (!def || !def.conditionable) throw new AutomationError(`${at}: ${event.key} has no field "${field}" a condition may test.`);
  const op = raw.op;
  if (typeof op !== 'string' || !(CONDITION_OPS as readonly string[]).includes(op)) throw new AutomationError(`${at}: "${String(op)}" is not an operator.`);
  if (!opsFor(def).includes(op as ConditionOp)) throw new AutomationError(`${at}: ${field} is ${def.type === 'int' ? 'a number of days' : `a ${def.type}`}; it cannot be tested with "${op}".`);

  if (def.type === 'money') {
    if (typeof raw.value !== 'string' && typeof raw.value !== 'number') throw new AutomationError(`${at}: ${field} is compared with an amount.`);
    let scaled: bigint;
    try {
      scaled = parseDecimal(String(raw.value), MONEY_SCALE);
    } catch {
      throw new AutomationError(`${at}: "${String(raw.value)}" is not an amount (digits, at most four decimals).`);
    }
    if (scaled < 0n) throw new AutomationError(`${at}: an amount cannot be negative.`);
    return { field, op: op as ConditionOp, value: toDecimalString(scaled, MONEY_SCALE) };
  }
  if (def.type === 'int') {
    const n = typeof raw.value === 'string' && /^\d{1,7}$/.test(raw.value.trim()) ? Number(raw.value.trim()) : raw.value;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) throw new AutomationError(`${at}: ${field} is compared with a whole number of days.`);
    return { field, op: op as ConditionOp, value: n };
  }
  // A code.
  if (op === 'in') {
    if (!Array.isArray(raw.value) || raw.value.length === 0 || raw.value.length > IN_LIST_MAX) throw new AutomationError(`${at}: "in" takes a list of one to ${IN_LIST_MAX} codes.`);
    const list = [...new Set(raw.value.map((v) => (typeof v === 'string' ? v.trim() : '')))];
    if (list.some((v) => !CODE.test(v))) throw new AutomationError(`${at}: each code is short text without symbols.`);
    return { field, op: 'in', value: list };
  }
  const code = typeof raw.value === 'string' ? raw.value.trim() : '';
  if (!CODE.test(code)) throw new AutomationError(`${at}: ${field} is compared with a short code.`);
  return { field, op: op as ConditionOp, value: code };
}

/** Checks a rule's conditions against its event; returns them in canonical form. */
export function validateConditions(eventKey: string, input: unknown): Condition[] {
  const event = eventOf(eventKey);
  if (!event) throw new AutomationError(`"${eventKey}" is not an event automation knows.`);
  if (!Array.isArray(input)) throw new AutomationError('Conditions are a list.');
  if (input.length > CONDITIONS_MAX) throw new AutomationError(`A rule has at most ${CONDITIONS_MAX} conditions.`);
  return input.map((raw, i) => conditionOf(event, raw, i));
}

// ---------------------------------------------------------------------------
// Recipients and actions
// ---------------------------------------------------------------------------

export type Recipient =
  | { readonly kind: 'role'; readonly roleCode: string }
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: Exclude<RecipientKind, 'role' | 'user'> };

const ROLE = /^[a-z][a-z0-9_]{1,40}$/;

function recipientOf(event: EventDef, raw: unknown, at: string): Recipient {
  if (!plain(raw)) throw new AutomationError(`${at}: a recipient is a role, a person or a relationship to the record.`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(RECIPIENT_KINDS as readonly string[]).includes(kind)) throw new AutomationError(`${at}: "${String(kind)}" is not a kind of recipient.`);
  if (!event.recipients.includes(kind as RecipientKind)) throw new AutomationError(`${at}: ${event.key} has no "${kind}" to tell.`);
  if (kind === 'role') {
    onlyKeys(at, raw, ['kind', 'roleCode']);
    const roleCode = typeof raw.roleCode === 'string' ? raw.roleCode.trim() : '';
    if (!ROLE.test(roleCode)) throw new AutomationError(`${at}: name the role.`);
    return { kind: 'role', roleCode };
  }
  if (kind === 'user') {
    onlyKeys(at, raw, ['kind', 'userId']);
    if (!isUuid(raw.userId)) throw new AutomationError(`${at}: name the person.`);
    return { kind: 'user', userId: raw.userId };
  }
  onlyKeys(at, raw, ['kind']);
  return { kind: kind as Exclude<RecipientKind, 'role' | 'user'> };
}

export interface NotifyAction {
  readonly kind: 'create_notification' | 'open_workflow';
  readonly recipients: readonly Recipient[];
  readonly note: string;
}
export interface TaskAction {
  readonly kind: 'create_task';
  readonly assignee: Recipient;
  readonly departmentCode: string;
  readonly title: string;
  readonly priority: TaskPriority;
  readonly dueInDays: number;
  readonly note: string;
}
export interface ApprovalAction {
  readonly kind: 'request_approval';
  readonly note: string;
}
export interface ExceptionAction {
  readonly kind: 'create_exception';
  readonly severity: Severity;
  readonly note: string;
}
export type Action = NotifyAction | TaskAction | ApprovalAction | ExceptionAction;

function noteOf(raw: Record<string, unknown>, at: string): string {
  const note = raw.note === undefined || raw.note === null ? '' : typeof raw.note === 'string' ? raw.note.trim() : null;
  if (note === null) throw new AutomationError(`${at}: the note is text.`);
  if (note.length > NOTE_MAX) throw new AutomationError(`${at}: the note is at most ${NOTE_MAX} characters.`);
  return note;
}

function actionOf(event: EventDef, raw: unknown, position: number): Action {
  const at = `Action ${position + 1}`;
  if (!plain(raw)) throw new AutomationError(`${at} must name what to do.`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(ACTION_KINDS as readonly string[]).includes(kind)) throw new AutomationError(`${at}: "${String(kind)}" is not something a rule can do.`);
  if (!event.actions.includes(kind as ActionKind)) throw new AutomationError(`${at}: a rule on ${event.key} cannot ${kind.replace(/_/g, ' ')}.`);

  if (kind === 'create_notification' || kind === 'open_workflow') {
    onlyKeys(at, raw, ['kind', 'recipients', 'note']);
    if (!Array.isArray(raw.recipients) || raw.recipients.length === 0 || raw.recipients.length > RECIPIENTS_MAX) throw new AutomationError(`${at}: name one to ${RECIPIENTS_MAX} people to tell.`);
    return { kind, recipients: raw.recipients.map((r) => recipientOf(event, r, at)), note: noteOf(raw, at) };
  }
  if (kind === 'create_task') {
    onlyKeys(at, raw, ['kind', 'assignee', 'departmentCode', 'title', 'priority', 'dueInDays', 'note']);
    const assignee = recipientOf(event, raw.assignee, at);
    if (assignee.kind === 'role') throw new AutomationError(`${at}: a task is given to a person, not to a role.`);
    const departmentCode = typeof raw.departmentCode === 'string' ? raw.departmentCode.trim() : '';
    if (!CODE.test(departmentCode)) throw new AutomationError(`${at}: name the section the task is raised in.`);
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (title.length < TITLE_MIN || title.length > TITLE_MAX) throw new AutomationError(`${at}: the task's title is ${TITLE_MIN} to ${TITLE_MAX} characters.`);
    const priority = raw.priority;
    if (typeof priority !== 'string' || !(TASK_PRIORITIES as readonly string[]).includes(priority)) throw new AutomationError(`${at}: the priority is one of ${TASK_PRIORITIES.join(', ')}.`);
    const due = typeof raw.dueInDays === 'string' && /^\d{1,3}$/.test(raw.dueInDays.trim()) ? Number(raw.dueInDays.trim()) : raw.dueInDays;
    if (typeof due !== 'number' || !Number.isInteger(due) || due < 0 || due > DUE_IN_DAYS_MAX) throw new AutomationError(`${at}: the task is due in 0 to ${DUE_IN_DAYS_MAX} days.`);
    return { kind, assignee, departmentCode, title, priority: priority as TaskPriority, dueInDays: due, note: noteOf(raw, at) };
  }
  if (kind === 'request_approval') {
    onlyKeys(at, raw, ['kind', 'note']);
    return { kind, note: noteOf(raw, at) };
  }
  // create_exception
  onlyKeys(at, raw, ['kind', 'severity', 'note']);
  if (!event.exceptionDetector) throw new AutomationError(`${at}: ${event.key} raises no exceptions.`);
  const severity = raw.severity;
  if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity)) throw new AutomationError(`${at}: the severity is one of ${SEVERITIES.join(', ')}.`);
  return { kind: 'create_exception', severity: severity as Severity, note: noteOf(raw, at) };
}

/** Checks a rule's actions against its event; returns them in canonical form. */
export function validateActions(eventKey: string, input: unknown): Action[] {
  const event = eventOf(eventKey);
  if (!event) throw new AutomationError(`"${eventKey}" is not an event automation knows.`);
  if (!Array.isArray(input) || input.length === 0) throw new AutomationError('A rule does at least one thing.');
  if (input.length > ACTIONS_MAX) throw new AutomationError(`A rule does at most ${ACTIONS_MAX} things.`);
  const actions = input.map((raw, i) => actionOf(event, raw, i));
  if (actions.filter((a) => a.kind === 'request_approval').length > 1) throw new AutomationError('A rule asks for a review once.');
  return actions;
}

export interface Definition {
  readonly eventKey: EventKey;
  readonly conditions: readonly Condition[];
  readonly actions: readonly Action[];
}

export function validateDefinition(eventKey: string, conditions: unknown, actions: unknown): Definition {
  const event = eventOf(eventKey);
  if (!event) throw new AutomationError(`"${eventKey}" is not an event automation knows.`);
  return { eventKey: event.key, conditions: validateConditions(eventKey, conditions), actions: validateActions(eventKey, actions) };
}

export function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < NAME_MIN || name.length > NAME_MAX) throw new AutomationError(`A rule's name is ${NAME_MIN} to ${NAME_MAX} characters.`);
  return name;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface Unmet {
  readonly field: string;
  readonly op: ConditionOp;
  readonly expected: string | number | readonly string[];
  readonly actual: string | number | null;
}

export interface Evaluation {
  readonly matched: boolean;
  /** Every condition that did not hold (empty when matched), in the rule's order. */
  readonly unmet: readonly Unmet[];
  /** The actions that would be taken, in order; empty when nothing matched. */
  readonly planned: readonly Action[];
}

function compare(op: ConditionOp, actual: bigint | number, expected: bigint | number): boolean {
  switch (op) {
    case 'gte':
      return actual >= expected;
    case 'gt':
      return actual > expected;
    case 'lte':
      return actual <= expected;
    case 'lt':
      return actual < expected;
    case 'eq':
      return actual === expected;
    default:
      return false;
  }
}

function holds(event: EventDef, condition: Condition, payload: Readonly<Record<string, unknown>>): { ok: boolean; actual: string | number | null } {
  const def = event.fields[condition.field]!;
  const value = payload[condition.field];
  if (value === undefined || value === null) return { ok: false, actual: null };
  if (def.type === 'money') {
    const actual = parseDecimal(String(value), MONEY_SCALE);
    return { ok: compare(condition.op, actual, parseDecimal(String(condition.value), MONEY_SCALE)), actual: toDecimalString(actual, MONEY_SCALE) };
  }
  if (def.type === 'int') return { ok: compare(condition.op, Number(value), Number(condition.value)), actual: Number(value) };
  const actual = String(value);
  if (condition.op === 'in') return { ok: (condition.value as readonly string[]).includes(actual), actual };
  if (condition.op === 'ne') return { ok: actual !== condition.value, actual };
  return { ok: actual === condition.value, actual };
}

/**
 * Does this rule version act on this payload, and what would it do?
 * Pure; the same inputs give the same answer.
 */
export function evaluate(definition: Definition, payload: Readonly<Record<string, unknown>>): Evaluation {
  const event = EVENTS[definition.eventKey];
  const unmet: Unmet[] = [];
  for (const condition of definition.conditions) {
    const result = holds(event, condition, payload);
    if (!result.ok) unmet.push({ field: condition.field, op: condition.op, expected: condition.value, actual: result.actual });
  }
  const matched = unmet.length === 0;
  return { matched, unmet, planned: matched ? definition.actions : [] };
}

// ---------------------------------------------------------------------------
// Runs: keys, retries, outcomes, pausing
// ---------------------------------------------------------------------------

/** What makes a run the same run: the rule, the event, the record and the stretch of lateness. A rule acts once on it. */
export const runKeyOf = (ruleId: string, eventKey: string, subjectKey: string, episode: string): string => `${ruleId}|${eventKey}|${subjectKey}|${episode}`;

/** Three attempts, a minute, ten minutes, an hour apart — the notification runner's own backoff. */
export const MAX_ATTEMPTS = 3;
export const BACKOFF_MINUTES: readonly number[] = [1, 10, 60];

/** When the next attempt is due after `attemptsMade` have failed; null once they are used up. */
export function nextAttemptAt(attemptsMade: number, now: Date): Date | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  const minutes = BACKOFF_MINUTES[Math.max(0, attemptsMade - 1)] ?? 60;
  return new Date(now.getTime() + minutes * 60_000);
}

/** The default number of events in a row that end in failure before a rule pauses itself. */
export const PAUSE_AFTER_DEFAULT = 3;
export const PAUSE_AFTER_MAX = 20;

export const shouldPause = (consecutiveFailures: number, threshold: number): boolean => threshold > 0 && consecutiveFailures >= threshold;

export const ACTION_STATUSES = ['done', 'skipped', 'failed', 'carried'] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];
export const OUTCOMES = ['done', 'skipped', 'failed'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export interface ActionResult {
  readonly index: number;
  readonly kind: ActionKind;
  readonly status: ActionStatus;
  /** A plain sentence: what was done, or why it was not. */
  readonly detail: string;
  /** What was made (a task number, an exception number, how many were told). */
  readonly ref?: string | undefined;
}

/** Failed if any step failed; done if any step did something; otherwise skipped. */
export function outcomeOf(results: readonly ActionResult[]): Outcome {
  if (results.some((r) => r.status === 'failed')) return 'failed';
  if (results.some((r) => r.status === 'done' || r.status === 'carried')) return 'done';
  return 'skipped';
}

export const isOutcome = (value: unknown): value is Outcome => typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
