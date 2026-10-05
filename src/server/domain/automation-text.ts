/**
 * Automation, in words — platform phase, Agent 10.
 *
 * A rule is stored as data (a condition is a field, an operator and a value;
 * an action is one of five kinds). A person reads it as sentences, in their
 * own language, so the screen, the run page and the print model all say the
 * same thing from one place. Pure: the translator and the name lookups are
 * handed in, so the page (`getTranslations`) and the print model (`m.admin`)
 * share it and a unit test can hold every code to a label in both locales.
 *
 * Never a raw code on a screen: every event, field, operator, action kind and
 * kind of recipient has a message under `admin.automation.*`.
 */
import { CONDITION_OPS, type Action, type Condition, type Recipient } from './automation';
import { ACTION_KINDS, EVENTS, EVENT_KEYS, RECIPIENT_KINDS, eventLabelKey, type EventKey } from './automation-events';
import { TEMPLATE_CODES, TEMPLATES } from './automation-templates';

/** `say('act_notify', { who })` — a message under `admin.automation`. */
export type Say = (key: string, values?: Readonly<Record<string, string | number>>) => string;

export interface Names {
  /** A role's name, from the roles table; the code itself when it has gone. */
  readonly role: (code: string) => string;
  /** A person's name; `null` when they are no longer listed. */
  readonly user: (id: string) => string | null;
  /** A section's name. */
  readonly section: (code: string) => string;
}

export interface Words {
  readonly say: Say;
  readonly names: Names;
  /** An amount in dinars as the reader's locale writes it. */
  readonly money: (decimal: string) => string;
  /** A date as the reader's locale writes it. */
  readonly date: (iso: string) => string;
  /** The words of a priority and of a severity (the Task and Exception Centers own them). */
  readonly priority: (code: string) => string;
  readonly severity: (code: string) => string;
}

/** The words for one reader: a name book (`services/automation.nameBook`) and the reader's own formatters, put together once. */
export function wordsOf(input: {
  readonly say: Say;
  readonly book: { readonly roles: Readonly<Record<string, string>>; readonly sections: Readonly<Record<string, string>>; readonly users: Readonly<Record<string, string>> };
  readonly money: (decimal: string) => string;
  readonly date: (iso: string) => string;
  readonly priority: (code: string) => string;
  readonly severity: (code: string) => string;
}): Words {
  const { book } = input;
  return {
    say: input.say,
    names: { role: (code) => book.roles[code] ?? code, user: (id) => book.users[id] ?? null, section: (code) => book.sections[code] ?? code },
    money: input.money,
    date: input.date,
    priority: input.priority,
    severity: input.severity,
  };
}

export const eventName = (say: Say, key: string): string => say(`event_${eventLabelKey(key)}`);

export function who(recipient: Recipient, words: Words): string {
  switch (recipient.kind) {
    case 'role':
      return words.say('who_role', { role: words.names.role(recipient.roleCode) });
    case 'user':
      return words.say('who_user', { name: words.names.user(recipient.userId) ?? words.say('who_unknown') });
    default:
      return words.say(`who_${recipient.kind}`);
  }
}

const whoAll = (recipients: readonly Recipient[], words: Words): string => recipients.map((r) => who(r, words)).join(words.say('who_join'));

/** One value of a condition, in the field's own kind: an amount as money, a date as a date, a count as it is. */
function valueText(eventKey: EventKey, condition: Condition, words: Words): string {
  const type = EVENTS[eventKey].fields[condition.field]?.type;
  const one = (value: unknown): string => {
    const raw = String(value);
    if (type === 'money') return words.money(raw);
    if (type === 'date') return words.date(raw);
    return raw;
  };
  return Array.isArray(condition.value) ? condition.value.map(one).join(', ') : one(condition.value);
}

/** "Invoice amount (IQD) is at least 1,000,000". */
export function conditionText(eventKey: EventKey, condition: Condition, words: Words): string {
  return words.say('condition_sentence', {
    field: words.say(`field_${condition.field}`),
    op: words.say(`op_${condition.op}`),
    value: valueText(eventKey, condition, words),
  });
}

/** What an action does, in one sentence (its note, when it has one, is the line after). */
export function actionText(action: Action, words: Words): string {
  switch (action.kind) {
    case 'create_notification':
      return words.say('act_notify', { who: whoAll(action.recipients, words) });
    case 'open_workflow':
      return words.say('act_open_workflow', { who: whoAll(action.recipients, words) });
    case 'create_task':
      return words.say('act_task', {
        priority: words.priority(action.priority),
        title: action.title,
        assignee: who(action.assignee, words),
        section: words.names.section(action.departmentCode),
        days: action.dueInDays,
      });
    case 'request_approval':
      return words.say('act_approval');
    case 'create_exception':
      return words.say('act_exception', { severity: words.severity(action.severity) });
  }
}

/** Every key the words above can ask for: the unit test holds each to a message in both locales. */
export function labelKeys(): string[] {
  const keys = new Set<string>();
  for (const key of EVENT_KEYS) {
    keys.add(`event_${eventLabelKey(key)}`);
    for (const [field, def] of Object.entries(EVENTS[key].fields)) {
      keys.add(`payload_${field}`);
      if (def.conditionable) keys.add(`field_${field}`);
    }
  }
  for (const op of CONDITION_OPS) keys.add(`op_${op}`);
  for (const kind of ACTION_KINDS) keys.add(`action_${kind}`);
  for (const kind of RECIPIENT_KINDS) if (kind !== 'role' && kind !== 'user') keys.add(`who_${kind}`);
  for (const code of TEMPLATE_CODES) {
    keys.add(`template_${code}`);
    keys.add(`template_${code}_what`);
    for (const param of TEMPLATES[code].params) keys.add(`p_${param.name}`);
  }
  for (const state of ['done', 'skipped', 'failed']) keys.add(`outcome_${state}`);
  for (const state of ['done', 'skipped', 'failed', 'carried']) keys.add(`step_${state}`);
  return [...keys].sort();
}
