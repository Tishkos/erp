/**
 * The rule templates automation ships (the brief's four, and a notice when a large purchase invoice is posted) — platform phase, Agent 10.
 *
 * A template is a rule with its shape fixed and its numbers left blank. The
 * administrator fills the parameters on screen (a threshold, a number of days, a
 * role to tell) and the template builds the conditions and actions, which then
 * go through the same validation as anything else (`domain/automation.ts`). No
 * template carries a firing default: an amount, a number of days, a person or a
 * role is never pre-filled, and a rule built from one is OFF until an
 * administrator turns it on.
 *
 * Pure: parameters in (text, as a form sends them), a validated definition out.
 */
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';
import { AutomationError, DUE_IN_DAYS_MAX, NOTE_MAX, TITLE_MAX, TITLE_MIN, validateDefinition, type Definition } from './automation';
import type { EventKey } from './automation-events';
import { SEVERITIES } from './exceptions';
import { TASK_PRIORITIES } from './tasks';

export const TEMPLATE_CODES = ['invoice_over_threshold', 'container_eta_exceeded', 'task_overdue', 'invoice_overdue_follow_up', 'invoice_posted_notice'] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];

export const isTemplateCode = (value: unknown): value is TemplateCode => typeof value === 'string' && (TEMPLATE_CODES as readonly string[]).includes(value);

export type ParamType = 'money' | 'int' | 'role' | 'user' | 'department' | 'priority' | 'severity' | 'text' | 'flag';

export interface ParamDef {
  readonly name: string;
  readonly type: ParamType;
  readonly required: boolean;
  /** Needed (and kept) only while this flag parameter is on. */
  readonly whenFlag?: string;
  readonly min?: number;
  readonly max?: number;
}

export type Params = Readonly<Record<string, string | number | boolean>>;

export interface TemplateDef {
  readonly code: TemplateCode;
  readonly eventKey: EventKey;
  readonly params: readonly ParamDef[];
  build(params: Params): { conditions: unknown[]; actions: unknown[] };
}

const NOTE: ParamDef = { name: 'note', type: 'text', required: false };

const str = (params: Params, name: string): string => String(params[name] ?? '');
const noteOf = (params: Params): string => str(params, 'note');

export const TEMPLATES: Readonly<Record<TemplateCode, TemplateDef>> = Object.freeze({
  // A purchase invoice over a configured amount cannot be posted until it has been reviewed.
  invoice_over_threshold: {
    code: 'invoice_over_threshold',
    eventKey: 'ap_invoice.submitted',
    params: [
      { name: 'thresholdIqd', type: 'money', required: true },
      { name: 'notifyRole', type: 'role', required: true },
      NOTE,
    ],
    build: (p) => ({
      conditions: [{ field: 'amountIqd', op: 'gte', value: str(p, 'thresholdIqd') }],
      actions: [
        { kind: 'request_approval', note: noteOf(p) },
        { kind: 'open_workflow', recipients: [{ kind: 'role', roleCode: str(p, 'notifyRole') }], note: noteOf(p) },
      ],
    }),
  },

  // A purchase invoice posted over a configured amount: a notice to a role, once it is in the books. Nothing is held; nothing is posted by it.
  invoice_posted_notice: {
    code: 'invoice_posted_notice',
    eventKey: 'ap_invoice.posted',
    params: [
      { name: 'thresholdIqd', type: 'money', required: true },
      { name: 'notifyRole', type: 'role', required: true },
      NOTE,
    ],
    build: (p) => ({
      conditions: [{ field: 'amountIqd', op: 'gte', value: str(p, 'thresholdIqd') }],
      actions: [{ kind: 'create_notification', recipients: [{ kind: 'role', roleCode: str(p, 'notifyRole') }], note: noteOf(p) }],
    }),
  },

  // A container that is past its ETA and not received: an exception, a notice, and perhaps a task.
  container_eta_exceeded: {
    code: 'container_eta_exceeded',
    eventKey: 'container.eta_exceeded',
    params: [
      { name: 'daysLate', type: 'int', required: true, min: 1, max: 365 },
      { name: 'severity', type: 'severity', required: true },
      { name: 'notifyRole', type: 'role', required: true },
      { name: 'followUp', type: 'flag', required: false },
      { name: 'taskAssignee', type: 'user', required: true, whenFlag: 'followUp' },
      { name: 'taskDepartment', type: 'department', required: true, whenFlag: 'followUp' },
      { name: 'taskTitle', type: 'text', required: true, whenFlag: 'followUp' },
      { name: 'taskPriority', type: 'priority', required: true, whenFlag: 'followUp' },
      { name: 'taskDueInDays', type: 'int', required: true, whenFlag: 'followUp', min: 0, max: DUE_IN_DAYS_MAX },
      NOTE,
    ],
    build: (p) => ({
      conditions: [{ field: 'daysLate', op: 'gte', value: p.daysLate }],
      actions: [
        { kind: 'create_exception', severity: str(p, 'severity'), note: noteOf(p) },
        { kind: 'create_notification', recipients: [{ kind: 'role', roleCode: str(p, 'notifyRole') }], note: noteOf(p) },
        ...(p.followUp === true
          ? [
              {
                kind: 'create_task',
                assignee: { kind: 'user', userId: str(p, 'taskAssignee') },
                departmentCode: str(p, 'taskDepartment'),
                title: str(p, 'taskTitle'),
                priority: str(p, 'taskPriority'),
                dueInDays: p.taskDueInDays,
                note: noteOf(p),
              },
            ]
          : []),
      ],
    }),
  },

  // A task that is overdue: tell the person it is with and, where permitted, whoever supervises them.
  task_overdue: {
    code: 'task_overdue',
    eventKey: 'task.overdue',
    params: [
      { name: 'daysLate', type: 'int', required: true, min: 1, max: 365 },
      { name: 'notifyAssignee', type: 'flag', required: false },
      { name: 'notifySupervisor', type: 'flag', required: false },
      NOTE,
    ],
    build: (p) => {
      const recipients = [
        ...(p.notifyAssignee === true ? [{ kind: 'record_assignee' }] : []),
        ...(p.notifySupervisor === true ? [{ kind: 'assignee_supervisor' }] : []),
      ];
      if (recipients.length === 0) throw new AutomationError('Choose who is told: the person the task is with, their supervisor, or both.');
      return {
        conditions: [{ field: 'daysLate', op: 'gte', value: p.daysLate }],
        actions: [{ kind: 'create_notification', recipients, note: noteOf(p) }],
      };
    },
  },

  // A sales invoice past its due date: a follow-up task for, and a notice to, whoever raised it.
  invoice_overdue_follow_up: {
    code: 'invoice_overdue_follow_up',
    eventKey: 'ar_invoice.overdue',
    params: [
      { name: 'daysLate', type: 'int', required: true, min: 1, max: 365 },
      { name: 'minimumAmountIqd', type: 'money', required: false },
      { name: 'taskDepartment', type: 'department', required: true },
      { name: 'taskTitle', type: 'text', required: true },
      { name: 'taskPriority', type: 'priority', required: true },
      { name: 'taskDueInDays', type: 'int', required: true, min: 0, max: DUE_IN_DAYS_MAX },
      NOTE,
    ],
    build: (p) => ({
      conditions: [
        { field: 'daysLate', op: 'gte', value: p.daysLate },
        ...(str(p, 'minimumAmountIqd') !== '' ? [{ field: 'amountIqd', op: 'gte', value: str(p, 'minimumAmountIqd') }] : []),
      ],
      actions: [
        {
          kind: 'create_task',
          assignee: { kind: 'record_raiser' },
          departmentCode: str(p, 'taskDepartment'),
          title: str(p, 'taskTitle'),
          priority: str(p, 'taskPriority'),
          dueInDays: p.taskDueInDays,
          note: noteOf(p),
        },
        { kind: 'create_notification', recipients: [{ kind: 'record_raiser' }], note: noteOf(p) },
      ],
    }),
  },
});

export const templateOf = (code: string): TemplateDef | null => (isTemplateCode(code) ? TEMPLATES[code] : null);

// ---------------------------------------------------------------------------
// Parameters as a form sends them
// ---------------------------------------------------------------------------

const ROLE = /^[a-z][a-z0-9_]{1,40}$/;
const CODE = /^[A-Za-z0-9_.\- ]{1,60}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const FLAG_ON = new Set(['on', 'true', '1', 'yes']);

/** The form field a parameter is read from. */
export const paramField = (name: string): string => `p_${name}`;

function parseOne(def: ParamDef, raw: string): string | number | boolean {
  const bad = (what: string): never => {
    throw new AutomationError(`${def.name}: ${what}`);
  };
  switch (def.type) {
    case 'flag':
      return FLAG_ON.has(raw.trim().toLowerCase());
    case 'money': {
      let scaled: bigint;
      try {
        scaled = parseDecimal(raw.replace(/,/g, '').trim(), MONEY_SCALE);
      } catch {
        return bad('an amount in dinars (digits, at most four decimals).');
      }
      if (scaled < 0n || (def.required && scaled === 0n)) return bad('an amount above zero.');
      return toDecimalString(scaled, MONEY_SCALE);
    }
    case 'int': {
      if (!/^\d{1,7}$/.test(raw.trim())) return bad('a whole number.');
      const n = Number(raw.trim());
      if (def.min !== undefined && n < def.min) return bad(`at least ${def.min}.`);
      if (def.max !== undefined && n > def.max) return bad(`at most ${def.max}.`);
      return n;
    }
    case 'role':
      return ROLE.test(raw.trim()) ? raw.trim() : bad('choose a role.');
    case 'user':
      return UUID.test(raw.trim()) ? raw.trim().toLowerCase() : bad('choose a person.');
    case 'department':
      return CODE.test(raw.trim()) ? raw.trim() : bad('choose a section.');
    case 'priority':
      return (TASK_PRIORITIES as readonly string[]).includes(raw.trim()) ? raw.trim() : bad(`one of ${TASK_PRIORITIES.join(', ')}.`);
    case 'severity':
      return (SEVERITIES as readonly string[]).includes(raw.trim()) ? raw.trim() : bad(`one of ${SEVERITIES.join(', ')}.`);
    case 'text': {
      const text = raw.trim().replace(/\s+/g, ' ');
      if (def.name === 'note') return text.length <= NOTE_MAX ? text : bad(`at most ${NOTE_MAX} characters.`);
      return text.length >= TITLE_MIN && text.length <= TITLE_MAX ? text : bad(`${TITLE_MIN} to ${TITLE_MAX} characters.`);
    }
  }
}

/**
 * Parameters from the form's own text (`undefined` or empty is "not given"),
 * with each one's own sentence when it will not do. Parameters that belong to a
 * switched-off flag are dropped.
 */
export function parseParams(code: TemplateCode, raw: Readonly<Record<string, string | undefined>>): Params {
  const template = TEMPLATES[code];
  const out: Record<string, string | number | boolean> = {};
  for (const def of template.params.filter((d) => d.type === 'flag')) out[def.name] = parseOne(def, raw[def.name] ?? '');
  for (const def of template.params) {
    if (def.type === 'flag') continue;
    if (def.whenFlag && out[def.whenFlag] !== true) continue;
    const given = (raw[def.name] ?? '').trim();
    if (given === '') {
      if (def.required) throw new AutomationError(`${def.name}: required.`);
      if (def.type === 'text' || def.type === 'money') out[def.name] = '';
      continue;
    }
    out[def.name] = parseOne(def, given);
  }
  return out;
}

/** A template's parameters, built into the validated definition a rule version stores. */
export function buildDefinition(code: TemplateCode, params: Params): Definition {
  const template = TEMPLATES[code];
  const built = template.build(params);
  return validateDefinition(template.eventKey, built.conditions, built.actions);
}
