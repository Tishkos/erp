/**
 * The events automation can be built on — platform phase, Agent 10.
 *
 * This is not a general event bus and not a workflow builder. It is a short,
 * closed list of things that happen in the ERP, each declared here with the
 * shape of what it says (`fields`), where it comes from (`origin`), what a
 * person must be allowed to open to hear of it (`object`) and what a rule built
 * on it may do (`actions`, `recipients`). A rule can name nothing that is not on
 * this page: not a table, not an expression, not a field the event does not
 * declare. `tests/unit/wf01-automation.test.ts` holds the list to its labels in
 * both languages and to the producers that fire each event.
 *
 * Two kinds of event, both landing in the same outbox (`automation_event`):
 *
 *   record   something happened in a business transaction (a purchase invoice
 *            was submitted). The owning service calls `automation-dispatch`,
 *            which only RECORDS a row in that transaction and never runs a rule
 *            there: a failing rule cannot roll back, or delay, the document.
 *   sweep    something became true while nobody was looking (a task is overdue).
 *            `scripts/ops/automation-run.ts` reads the real data through the
 *            services that already know it (`tasks.owedWithDueDate`,
 *            `logistics-views.shipmentTracking`, `open-items.openItems`) — never
 *            a loop over arbitrary tables — and records one event per item per
 *            business day.
 *
 * Pure: no database, no clock. Money is a decimal string in IQD (scaled bigint
 * at the point of comparison, never `Number`).
 */
import { parseDecimal } from './money';

export const EVENT_KEYS = ['ap_invoice.submitted', 'ap_invoice.posted', 'task.overdue', 'container.eta_exceeded', 'ar_invoice.overdue'] as const;
export type EventKey = (typeof EVENT_KEYS)[number];

export const isEventKey = (value: unknown): value is EventKey => typeof value === 'string' && (EVENT_KEYS as readonly string[]).includes(value);

/** What a rule may do. The vocabulary is closed; `domain/automation.ts` validates each one's parameters. */
export const ACTION_KINDS = ['create_notification', 'open_workflow', 'create_task', 'request_approval', 'create_exception'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * Who a notification may go to, or a task be given to. People are named by
 * their relationship to the record or by a role; the owner's own access and the
 * recipient's own access are both asked again when the action runs.
 */
export const RECIPIENT_KINDS = ['role', 'user', 'rule_owner', 'record_raiser', 'record_assignee', 'assignee_supervisor', 'raiser_supervisor'] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export type FieldType = 'money' | 'int' | 'code' | 'text' | 'date' | 'user';

export interface FieldDef {
  readonly type: FieldType;
  /** A condition may test it (otherwise it is only carried: a title, a name, a person). */
  readonly conditionable: boolean;
  /** The payload may leave it out or null. */
  readonly optional?: boolean;
}

export interface EventDef {
  readonly key: EventKey;
  readonly source: 'record' | 'sweep';
  /** The module and the code that raise it (documentation, and the handoff's table). */
  readonly origin: string;
  /** The permission object whose `view` a person needs to be told of it, and the rule's owner to build on it. */
  readonly object: string;
  /** The record type a notification or a task is filed against (`cloud-link-targets` knows it). */
  readonly subjectType: string;
  readonly fields: Readonly<Record<string, FieldDef>>;
  /** For a sweep: the payload field that says which stretch of lateness this is (a due date, an ETA). A rule acts once per stretch. */
  readonly episodeField?: string;
  readonly recipients: readonly RecipientKind[];
  readonly actions: readonly ActionKind[];
  /** The Exception Center detector a `create_exception` action raises under, when the event can raise one. */
  readonly exceptionDetector?: string;
  /** Where the record opens, from the payload. */
  readonly href: (payload: Readonly<Record<string, unknown>>) => string;
}

const enc = encodeURIComponent;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Every payload says which record it is about and what a person calls it. */
const COMMON: Readonly<Record<string, FieldDef>> = {
  subjectId: { type: 'text', conditionable: false },
  reference: { type: 'text', conditionable: false },
  branchCode: { type: 'code', conditionable: true, optional: true },
};

const INVOICE_FIELDS: Readonly<Record<string, FieldDef>> = {
  ...COMMON,
  supplierCode: { type: 'code', conditionable: true },
  supplierName: { type: 'text', conditionable: false },
  amountIqd: { type: 'money', conditionable: true },
  invoiceDate: { type: 'date', conditionable: false },
  raisedBy: { type: 'user', conditionable: false, optional: true },
};

export const EVENTS: Readonly<Record<EventKey, EventDef>> = Object.freeze({
  'ap_invoice.submitted': {
    key: 'ap_invoice.submitted',
    source: 'record',
    origin: 'services/ap-invoice.submit',
    object: 'ap_invoice',
    subjectType: 'ap_invoice',
    fields: INVOICE_FIELDS,
    recipients: ['role', 'user', 'rule_owner', 'record_raiser', 'raiser_supervisor'],
    actions: ['create_notification', 'open_workflow', 'create_task', 'request_approval'],
    href: (p) => `/payables/invoices/${enc(text(p.reference))}`,
  },
  'ap_invoice.posted': {
    key: 'ap_invoice.posted',
    source: 'record',
    origin: 'services/ap-invoice.post',
    object: 'ap_invoice',
    subjectType: 'ap_invoice',
    fields: INVOICE_FIELDS,
    recipients: ['role', 'user', 'rule_owner', 'record_raiser', 'raiser_supervisor'],
    actions: ['create_notification', 'create_task'],
    href: (p) => `/payables/invoices/${enc(text(p.reference))}`,
  },
  'task.overdue': {
    key: 'task.overdue',
    source: 'sweep',
    origin: 'scripts/ops/automation-run.ts › tasks.owedWithDueDate',
    object: 'task',
    subjectType: 'task',
    fields: {
      ...COMMON,
      taskTitle: { type: 'text', conditionable: false },
      assigneeId: { type: 'user', conditionable: false },
      raisedBy: { type: 'user', conditionable: false, optional: true },
      priority: { type: 'code', conditionable: true },
      departmentCode: { type: 'code', conditionable: true },
      dueDate: { type: 'date', conditionable: false },
      daysLate: { type: 'int', conditionable: true },
    },
    episodeField: 'dueDate',
    recipients: ['role', 'user', 'rule_owner', 'record_assignee', 'record_raiser', 'assignee_supervisor'],
    actions: ['create_notification', 'create_task', 'create_exception'],
    exceptionDetector: 'tasks.automation_task_overdue',
    href: (p) => `/tasks/${enc(text(p.reference))}`,
  },
  'container.eta_exceeded': {
    key: 'container.eta_exceeded',
    source: 'sweep',
    origin: 'scripts/ops/automation-run.ts › logistics-views.shipmentTracking',
    object: 'shipment_container',
    subjectType: 'shipment_container',
    fields: {
      ...COMMON,
      blNo: { type: 'text', conditionable: false },
      supplierName: { type: 'text', conditionable: false },
      importNo: { type: 'text', conditionable: false },
      etaDate: { type: 'date', conditionable: false },
      daysLate: { type: 'int', conditionable: true },
    },
    episodeField: 'etaDate',
    recipients: ['role', 'user', 'rule_owner'],
    actions: ['create_notification', 'create_task', 'create_exception'],
    exceptionDetector: 'logistics.automation_container_eta',
    href: (p) => `/payables/containers/${enc(text(p.reference))}`,
  },
  'ar_invoice.overdue': {
    key: 'ar_invoice.overdue',
    source: 'sweep',
    origin: 'scripts/ops/automation-run.ts › open-items.openItems (customer side)',
    object: 'ar_invoice',
    subjectType: 'ar_invoice',
    fields: {
      ...COMMON,
      customerCode: { type: 'code', conditionable: true },
      customerName: { type: 'text', conditionable: false },
      amountIqd: { type: 'money', conditionable: true },
      departmentCode: { type: 'code', conditionable: true, optional: true },
      raisedBy: { type: 'user', conditionable: false, optional: true },
      dueDate: { type: 'date', conditionable: false },
      daysLate: { type: 'int', conditionable: true },
    },
    episodeField: 'dueDate',
    recipients: ['role', 'user', 'rule_owner', 'record_raiser', 'raiser_supervisor'],
    actions: ['create_notification', 'create_task', 'create_exception'],
    exceptionDetector: 'receivables.automation_invoice_overdue',
    href: (p) => `/sales/ar-invoices/${enc(text(p.reference))}`,
  },
});

export const eventOf = (key: string): EventDef | null => (isEventKey(key) ? EVENTS[key] : null);

/** `ap_invoice.submitted` → `ap_invoice_submitted`: the key under which its words live. */
export const eventLabelKey = (key: string): string => key.replace(/\./g, '_');

/** The notification kind an event's notices are raised under (`automation.<key>`), registered in `notification-center.KINDS`. */
export const noticeKind = (key: EventKey): string => `automation.${eventLabelKey(key)}`;

export const EVENT_NOTICE_KINDS: readonly string[] = EVENT_KEYS.map(noticeKind);

/** The kind that tells the administrators a rule was paused. */
export const PAUSED_KIND = 'automation.paused';

/** The window a record event is told in: the moment it happened, so a second submission is a second event. */
export const recordWindow = (occurredAtIso: string): string => `at:${occurredAtIso}`;

/** The window a sweep event is told in: the business day. */
export const sweepWindow = (businessDate: string): string => `on:${businessDate}`;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function typeProblem(name: string, def: FieldDef, value: unknown): string | null {
  switch (def.type) {
    case 'money':
      try {
        if (typeof value !== 'string') return `${name} must be an amount as a decimal string`;
        parseDecimal(value, 4n);
        return null;
      } catch {
        return `${name} must be an amount as a decimal string`;
      }
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? null : `${name} must be a whole number of days`;
    case 'code':
      return typeof value === 'string' && /^[A-Za-z0-9_.\- ]{1,60}$/.test(value) ? null : `${name} must be a short code`;
    case 'text':
      return typeof value === 'string' && value.length >= 1 && value.length <= 300 ? null : `${name} must be text of at most 300 characters`;
    case 'date':
      return typeof value === 'string' && DATE.test(value) ? null : `${name} must be a date (YYYY-MM-DD)`;
    case 'user':
      return isUuid(value) ? null : `${name} must be a user id`;
  }
}

/**
 * What is wrong with a payload, or nothing. A payload carries exactly the
 * fields its event declares: a producer that adds a field, or leaves one out,
 * is a bug caught at the moment it fires rather than a rule that quietly never
 * matches.
 */
export function payloadProblems(key: EventKey, payload: Readonly<Record<string, unknown>>): string[] {
  const def = EVENTS[key];
  const problems: string[] = [];
  for (const name of Object.keys(payload)) if (!(name in def.fields)) problems.push(`${key} does not carry "${name}"`);
  for (const [name, field] of Object.entries(def.fields)) {
    const value = payload[name];
    if (value === undefined || value === null) {
      if (!field.optional) problems.push(`${key} needs "${name}"`);
      continue;
    }
    const problem = typeProblem(name, field, value);
    if (problem) problems.push(`${key}: ${problem}`);
  }
  return problems;
}

/** The subject key an event is filed under: `<record type>:<id>`. */
export const subjectKeyOf = (key: EventKey, payload: Readonly<Record<string, unknown>>): string => `${EVENTS[key].subjectType}:${text(payload.subjectId)}`;

/** Which stretch of lateness a sweep event belongs to; a record event is its own stretch. */
export function episodeOf(key: EventKey, payload: Readonly<Record<string, unknown>>, window: string): string {
  const field = EVENTS[key].episodeField;
  return field ? text(payload[field]) || window : window;
}
