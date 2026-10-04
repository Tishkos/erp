/**
 * The notification centre's rules — platform phase, Agent 6. Pure: no database,
 * no request, no translation. `services/notifications.ts` writes and reads
 * with these; `components/notifications/` draws with them.
 *
 * ── One system, one registry ───────────────────────────────────────────────
 * There is one `notification` table, one delivery runner, one bell. What this
 * module adds is the *registry*: every kind of notification (`event_type`,
 * "kind" below) says in one line which category it belongs to, who may be told
 * (a grant), when the same subject may be told again (a window), and whether
 * its stored text is a person's own words. Adding a kind is one entry:
 *
 *     'task.assigned': { category: 'tasks', object: 'task', window: 'occurrence' },
 *
 * and its label in both message files (`notifications.kind.task_assigned`).
 * A kind that is not here still works: the longest matching prefix decides
 * its category (`task.` → tasks), and anything else is *system*. Nothing is
 * refused for being unregistered — an emitter must never lose a notification
 * because the registry was behind it — but only registered kinds with an
 * `object` are filtered by grant at creation.
 *
 * ── The target is not stored ───────────────────────────────────────────────
 * A notification names its subject (`object_type`, `object_id`) and may carry
 * a local `href` in its context. Where it leads is worked out when it is
 * shown and again when it is clicked (`services/notification-center.ts`), in
 * the reader's own scope, so a record the reader can no longer open reads "no
 * longer available" instead of leading to a refusal page.
 *
 * ── When the same thing may be told again ──────────────────────────────────
 * The dedupe key is (kind, subject type, subject id, window, recipient). The
 * *window* is the documented re-notify rule:
 *
 *   once        never again for this subject (a container is late once)
 *   day         once per business day while the condition lasts (an invoice
 *               that is overdue says so each morning, never on each render)
 *   occurrence  as often as the caller names a new occurrence (a revision, a
 *               status entered, the first unseen message)
 */
import type { PermissionVerb } from './permissions';

export const NOTIFICATION_CATEGORIES = [
  'approvals',
  'tasks',
  'chat',
  'documents',
  'payments',
  'invoices',
  'logistics',
  'accounting',
  'hr',
  'system',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export function isCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export const NOTIFICATION_WINDOWS = ['once', 'day', 'occurrence'] as const;
export type NotificationWindow = (typeof NOTIFICATION_WINDOWS)[number];

export interface KindDef {
  readonly category: NotificationCategory;
  /**
   * The permission object a recipient must hold `verb` (default `view`) on to
   * be told at all. Null/absent: no grant is checked at creation (the people
   * told are chosen by the emitter's own rule — a manager by the manager link,
   * the person themself) and the reader's record access decides at open.
   */
  readonly object?: string | null;
  readonly verb?: PermissionVerb;
  /** When the same subject may be told again. Default `occurrence`. */
  readonly window?: NotificationWindow;
  /** The stored body is somebody's own words (a chat message): shown as it was written. */
  readonly userText?: boolean;
  /**
   * Where a notification of this kind leads when its subject has no record
   * page of its own and the emitter named none (the approvals inbox for a
   * document type that has no screen yet).
   */
  readonly fallback?: string;
}

/**
 * The kinds the system raises today and the ones the platform phase adds.
 * Keep each on one line; the label goes in `notifications.kind.<key>` with
 * the dots turned into underscores (`kindKey`).
 */
export const KINDS: Readonly<Record<string, KindDef>> = Object.freeze({
  // Approvals — the workflow engine's submit / decide (services/workflow.ts).
  'approval.required': { category: 'approvals', window: 'occurrence', fallback: '/approvals' },
  'approval.completed': { category: 'approvals', window: 'occurrence', fallback: '/approvals' },
  'approval.rejected': { category: 'approvals', window: 'occurrence', fallback: '/approvals' },
  'journal_entry.submitted': { category: 'approvals', object: 'journal_entry', window: 'occurrence' },
  'journal_entry.rejected': { category: 'approvals', object: 'journal_entry', window: 'occurrence' },
  'chart_of_account.submitted': { category: 'approvals', object: 'chart_of_account', window: 'occurrence' },
  'partner_bank_account.submitted': { category: 'approvals', object: 'business_partner', window: 'occurrence' },

  // Tasks — the Task Center emits; the registry only classifies and labels.
  'task.assigned': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.accepted': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.started': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.blocked': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.submitted': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.completed': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.reassigned': { category: 'tasks', object: 'task', window: 'occurrence' },
  'task.due_soon': { category: 'tasks', object: 'task', window: 'day' },
  'task.overdue': { category: 'tasks', object: 'task', window: 'day' },

  // Exceptions — the Exception Center raises one kind per domain, so each lands in the category it belongs to.
  // A new critical or high finding is told once per occurrence and severity; `reason` carries the severity for the label.
  'exception.accounting': { category: 'accounting', object: 'exception', window: 'occurrence' },
  'exception.receivables': { category: 'invoices', object: 'exception', window: 'occurrence' },
  'exception.payables': { category: 'invoices', object: 'exception', window: 'occurrence' },
  'exception.inventory': { category: 'accounting', object: 'exception', window: 'occurrence' },
  'exception.logistics': { category: 'logistics', object: 'exception', window: 'occurrence' },
  'exception.tasks': { category: 'tasks', object: 'exception', window: 'occurrence' },
  'exception.approvals': { category: 'approvals', object: 'exception', window: 'occurrence' },
  'exception.platform': { category: 'system', object: 'exception', window: 'occurrence' },

  // Chat — emitted by services/chat.ts.
  'chat.message': { category: 'chat', object: 'chat', window: 'occurrence', userText: true },
  'chat.mention': { category: 'chat', object: 'chat', window: 'occurrence', userText: true },

  // Documents — a cloud file linked to a record (services/cloud-files.ts).
  'document.linked': { category: 'documents', window: 'occurrence' },

  // Money in and out.
  'customer_receipt.received': { category: 'payments', object: 'customer_receipt', window: 'once' },
  'supplier_payment.made': { category: 'payments', object: 'supplier_payment', window: 'once' },

  // Invoices falling due: said each morning while the condition lasts.
  'ar_invoice.due_soon': { category: 'invoices', object: 'ar_invoice', window: 'day' },
  'ar_invoice.due_today': { category: 'invoices', object: 'ar_invoice', window: 'day' },
  'ar_invoice.overdue': { category: 'invoices', object: 'ar_invoice', window: 'day' },
  'ar_invoice.paid_late': { category: 'invoices', object: 'ar_invoice', window: 'once' },
  'ap_invoice.due_soon': { category: 'invoices', object: 'ap_invoice', window: 'day' },
  'ap_invoice.due_today': { category: 'invoices', object: 'ap_invoice', window: 'day' },
  'ap_invoice.overdue': { category: 'invoices', object: 'ap_invoice', window: 'day' },
  'ap_invoice.paid_late': { category: 'invoices', object: 'ap_invoice', window: 'once' },

  // Imports and logistics.
  'container.late': { category: 'logistics', object: 'shipment_container', window: 'occurrence' },
  'shipment.status_changed': { category: 'logistics', window: 'occurrence' },
  'payable.stage.changed': { category: 'logistics', object: 'payable', window: 'occurrence' },
  'payable.hold.opened': { category: 'logistics', object: 'payable', window: 'day' },
  'payable.hold.escalated': { category: 'logistics', object: 'payable', window: 'day' },

  // The books: reconciliation and closing checks.
  'fiscal_period.close_blocked': { category: 'accounting', window: 'day' },
  'inventory.integrity_failed': { category: 'accounting', window: 'day' },
  'project.availability_warning': { category: 'accounting', window: 'day' },

  // Slot: no module raises this yet (Bank Reconciliation's unmatched lines).
  // The label and the category are ready; the module that owns the event calls emit() with the kind.
  'reconciliation.issue': { category: 'accounting', window: 'day' },

  // The system itself (raised by the health check, services/system-health.ts).
  'system.health': { category: 'system', window: 'day' },
});

/**
 * Families of kinds whose members are many and written by their own module
 * (every `hr.*` event of the HR stages). The longest prefix wins.
 */
export const KIND_PREFIXES: Readonly<Record<string, KindDef>> = Object.freeze({
  'hr.': { category: 'hr', window: 'occurrence' },
  'task.': { category: 'tasks', object: 'task', window: 'occurrence' },
  'chat.': { category: 'chat', object: 'chat', window: 'occurrence' },
  'approval.': { category: 'approvals', window: 'occurrence' },
  'document.': { category: 'documents', window: 'occurrence' },
  'ar_invoice.': { category: 'invoices', object: 'ar_invoice', window: 'day' },
  'ap_invoice.': { category: 'invoices', object: 'ap_invoice', window: 'day' },
  'payable.': { category: 'logistics', object: 'payable', window: 'occurrence' },
  'container.': { category: 'logistics', object: 'shipment_container', window: 'occurrence' },
  'shipment.': { category: 'logistics', window: 'occurrence' },
  'exception.': { category: 'accounting', window: 'day' },
});

const DEFAULT_KIND: KindDef = { category: 'system', window: 'occurrence' };

/** Kinds added at runtime by a module that owns them (Exceptions, Automation). */
const added = new Map<string, KindDef>();

/** One additive registration; replaces an earlier entry of the same kind. */
export function registerKind(kind: string, def: KindDef): void {
  added.set(kind, def);
}

export function clearAddedKinds(): void {
  added.clear();
}

/** A kind's entry: the exact one, else the longest prefix's, else *system*. */
export function kindDef(kind: string): KindDef {
  const exact = added.get(kind) ?? KINDS[kind];
  if (exact) return exact;
  let best: string | null = null;
  for (const prefix of Object.keys(KIND_PREFIXES)) {
    if (kind.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix;
  }
  return best === null ? DEFAULT_KIND : KIND_PREFIXES[best]!;
}

export function isRegisteredKind(kind: string): boolean {
  return added.has(kind) || Object.prototype.hasOwnProperty.call(KINDS, kind);
}

export function categoryOf(kind: string): NotificationCategory {
  return kindDef(kind).category;
}

export function allKinds(): readonly string[] {
  return [...new Set([...Object.keys(KINDS), ...added.keys()])];
}

/** The message key under `notifications.kind.` for a kind: dots become underscores. */
export function kindKey(kind: string): string {
  return kind.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Which kinds a category holds — for the list's filter, in SQL
// ---------------------------------------------------------------------------

export interface CategoryMatch {
  readonly exact: readonly string[];
  readonly prefixes: readonly string[];
}

/**
 * What an `event_type` must equal or begin with to belong to a category, for
 * every category but *system* — which is whatever none of the others claim
 * (`systemMatch`). Built from the registry, so a new entry is found by the
 * filter without another edit.
 */
export function matchOf(category: NotificationCategory): CategoryMatch {
  const kinds = allKinds().filter((kind) => kindDef(kind).category === category);
  const prefixes = Object.entries(KIND_PREFIXES)
    .filter(([, def]) => def.category === category)
    .map(([prefix]) => prefix);
  // A kind already under one of the category's own prefixes needs no line of its own.
  const exact = kinds.filter((kind) => !prefixes.some((prefix) => kind.startsWith(prefix)));
  return { exact, prefixes };
}

/** Every exact kind and prefix that is *not* system, so *system* can be "none of these". */
export function claimedByOthers(): CategoryMatch {
  const exact: string[] = [];
  const prefixes: string[] = [];
  for (const category of NOTIFICATION_CATEGORIES) {
    if (category === 'system') continue;
    const m = matchOf(category);
    exact.push(...m.exact);
    prefixes.push(...m.prefixes);
  }
  return { exact, prefixes };
}

// ---------------------------------------------------------------------------
// The dedupe key and its window
// ---------------------------------------------------------------------------

/**
 * The token the window contributes to the key. `day` is the business day the
 * caller passes (`businessToday()`); `once` contributes nothing; `occurrence`
 * is whatever the caller names (a revision, a status, a sequence number). With
 * none named it is empty, which `emit` refuses for an `occurrence` kind
 * (`needsOccurrence`): a bare one would tell a subject once forever and
 * silently drop every later, genuinely new event.
 */
export function windowToken(
  kind: string,
  input: { readonly occurrence?: string | null; readonly today: string },
): string {
  const given = input.occurrence?.trim() ?? '';
  if (given !== '') return given;
  const window = kindDef(kind).window ?? 'occurrence';
  if (window === 'once') return '';
  if (window === 'day') return input.today;
  return '';
}

/** Does this kind's window have to be named by the caller? (`occurrence` kinds, with none given.) */
export function needsOccurrence(kind: string, occurrence: string | null | undefined): boolean {
  return (kindDef(kind).window ?? 'occurrence') === 'occurrence' && (occurrence ?? '').trim() === '';
}

/**
 * (recipient, kind, subject, window) as one string — the unique index's key.
 * The shape is `services/notifications.dedupeKeyFor`'s, so keys raised by the
 * rule path and by `emit` for the same event are the same key and the second
 * is suppressed whichever came first. The recipient is last and carries no
 * separator (`eventKeyOf` cuts it off).
 */
export function dedupeKeyOf(input: {
  readonly kind: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly window: string;
  readonly recipientUserId: string;
}): string {
  return [input.kind, input.objectType, input.objectId, input.window, input.recipientUserId].join('|');
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/**
 * A path on this site, with an optional query: begins with one `/`, no scheme,
 * no host, no backslash, no control characters. The only kind of address a
 * notification's context may carry.
 */
export function isLocalHref(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 500) return false;
  if (!value.startsWith('/') || value.startsWith('//')) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\\\u0000-\u001f]/.test(value);
}

/** The path of a local href, without its query or fragment — what the screen catalogue knows. */
export function pathOf(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

// ---------------------------------------------------------------------------
// Paging, badges, time
// ---------------------------------------------------------------------------

export const BELL_LIMIT = 12;
export const NOTIFICATION_PAGE_SIZE = 50;

/** The count a badge shows: 1–99, then "99+". */
export function badgeText(count: number): string {
  return count > 99 ? '99+' : String(Math.max(0, Math.floor(count)));
}

/** The poll cadence of the bell: a visible tab every 30 s, a hidden one every two minutes, backing off after failures. */
export function pollIntervalMs(input: { readonly visible: boolean; readonly failures: number }): number {
  const base = input.visible ? 30_000 : 120_000;
  if (input.failures <= 0) return base;
  return Math.min(300_000, base * 2 ** Math.min(input.failures, 4));
}

export type RelativeUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/** How long ago, as the largest whole unit — for `Intl.RelativeTimeFormat`. Never in the future. */
export function relativeParts(then: Date, now: Date): { readonly value: number; readonly unit: RelativeUnit } {
  const seconds = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return { value: seconds, unit: 'second' };
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return { value: minutes, unit: 'minute' };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { value: hours, unit: 'hour' };
  const days = Math.floor(hours / 24);
  if (days < 7) return { value: days, unit: 'day' };
  if (days < 30) return { value: Math.floor(days / 7), unit: 'week' };
  if (days < 365) return { value: Math.floor(days / 30), unit: 'month' };
  return { value: Math.floor(days / 365), unit: 'year' };
}

/**
 * The values a kind's label may use, read from the notification's own context
 * and subject. Every key is always present (empty when unknown) so a message
 * never fails on a value a legacy row did not keep.
 */
export interface LabelParams {
  readonly ref: string;
  readonly party: string;
  /** A number, so a message can pluralise on it (0 when the row names none). */
  readonly days: number;
  readonly actor: string;
  readonly amount: string;
  readonly date: string;
  readonly name: string;
  readonly count: number;
  /** A second fact a label may show: the stage reached, the reason, the budget element. */
  readonly extra: string;
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'bigint' ? String(value) : '';

const whole = (value: unknown): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
};

export function labelParams(row: {
  readonly objectId: string;
  readonly context: Readonly<Record<string, unknown>> | null;
}): LabelParams {
  const c = row.context ?? {};
  const first = (...values: unknown[]): unknown => values.find((v) => text(v) !== '');
  return {
    ref: text(first(c.reference, c.documentNo, c.requestNo, c.runNo, c.payableNo, c.invoiceNo, c.containerNo, c.entryNo, c.taskNo, c.projectCode)) || row.objectId,
    party: text(c.party) || text(c.supplier) || text(c.customer),
    days: whole(first(c.days_overdue, c.days_until_due, c.days_late, c.days)),
    actor: text(c.actor) || text(c.actorName) || text(c.senderName),
    amount: text(c.amount) || text(c.outstanding),
    date: text(c.due_date) || text(c.eta) || text(c.date),
    name: text(c.name) || text(c.title) || text(c.period),
    count: whole(c.count),
    extra: text(c.stage) || text(c.reason) || text(c.wbsCode),
  };
}
