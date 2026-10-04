/**
 * The ERP Control Center's rules — platform phase, Agent 9. Pure: no database, no
 * request, no translation. `services/control-center.ts` runs the checks with these;
 * `tests/unit/cc01-control-center.test.ts` holds them.
 *
 * ── What the Control Center is ─────────────────────────────────────────────
 * One screen that answers "is Qimah internally healthy?" with real checks and
 * nothing else. A check is a question the system already knows how to ask — the
 * trial balance, the control accounts' reconciliation, the stock ledger's own
 * integrity view, the FIFO valuation against the inventory accounts, the jobs'
 * last exit — asked again, now, as the person looking. It does not repair, post,
 * edit or resolve anything, and it invents no score: there is no percentage and
 * no grade, only the state of each check and the figures behind it.
 *
 * ── The four states ────────────────────────────────────────────────────────
 *
 *   ok            the check ran and what it compared agrees.
 *   attention     the check ran and found something a person should look at.
 *   not_checked   the check was not run FOR THIS PERSON: they may not read its source
 *                 (the grant on the screen it summarises), or the feature it looks at
 *                 is switched off here. Never green, never a zero.
 *   unavailable   the check was run and could not answer: the read failed, ran out of
 *                 time, or needs a file or service this host does not have. The reason
 *                 is said; it is never shown as a green tick.
 *
 * ── Evidence ───────────────────────────────────────────────────────────────
 * A finished check carries the figures it compared (the sub-ledger, the control
 * account, the difference — shown whether they agree or not) and, when something
 * needs attention, the first things that do, each with the record it opens.
 */
import { MONEY_SCALE, parseDecimal, toDecimalString } from './money';
import type { PermissionVerb } from './permissions';
import { parseQuantity } from './uom';

export const CHECK_STATES = ['ok', 'attention', 'not_checked', 'unavailable'] as const;
export type CheckState = (typeof CHECK_STATES)[number];

export const isCheckState = (value: unknown): value is CheckState =>
  typeof value === 'string' && (CHECK_STATES as readonly string[]).includes(value);

/**
 * The chip each state wears — tones the application already has (`status--<tone>`), so a check reads like every
 * other register row: green is agreed, red needs a person, blue could not be asked, grey was not asked.
 */
export const STATE_TONE: Readonly<Record<CheckState, string>> = Object.freeze({
  ok: 'approved',
  attention: 'rejected',
  not_checked: 'draft',
  unavailable: 'submitted',
});

/** Most urgent first: how the checks of a domain are ordered and what its heading says. */
export const STATE_ORDER: readonly CheckState[] = ['attention', 'unavailable', 'not_checked', 'ok'];

/** The Control Center's six areas — each is also an Exception Center domain, so its count links to that register. */
export const CC_DOMAINS = ['accounting', 'inventory', 'receivables', 'payables', 'logistics', 'platform'] as const;
export type CcDomain = (typeof CC_DOMAINS)[number];

export const isCcDomain = (value: unknown): value is CcDomain =>
  typeof value === 'string' && (CC_DOMAINS as readonly string[]).includes(value);

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** What a person must hold to read a check's source: the grant of the screen the check summarises. */
export interface Requirement {
  readonly object: string;
  readonly verb: PermissionVerb;
}

export interface CheckDefinition {
  /** `<domain>.<name>`, lower case. The message key under `admin.control_center.check` swaps the dot. */
  readonly code: string;
  readonly domain: CcDomain;
  /** The grants that open the source — ALL of them. A person lacking one gets `not_checked`, not a figure. */
  readonly requires: readonly Requirement[];
  /** The screen that shows the source in full; the check's "open" link. */
  readonly route: string;
  /** Reads files or services of the machine it runs on (backups, job records): an answer for THIS host. */
  readonly host?: boolean;
}

const view = (object: string): Requirement => ({ object, verb: 'view' });

/**
 * Every check, in the order a domain lists them. Each reads through the service that already owns the
 * question (`services/control-center-readers.ts` names it) — a check that needed a query of its own would be
 * a second answer to a question the system already answers.
 */
export const CHECKS: readonly CheckDefinition[] = Object.freeze([
  // Accounting — the books agree with themselves.
  { code: 'accounting.trial_balance', domain: 'accounting', requires: [view('trial_balance')], route: '/finance/trial-balance' },
  { code: 'accounting.journal_integrity', domain: 'accounting', requires: [view('trial_balance')], route: '/finance/trial-balance' },
  { code: 'accounting.bank_reconciliation', domain: 'accounting', requires: [view('bank_reconciliation')], route: '/treasury/bank-reconciliation' },
  { code: 'accounting.bank_accounts', domain: 'accounting', requires: [view('bank_account')], route: '/master-data/bank-accounts' },
  { code: 'accounting.posting_roles', domain: 'accounting', requires: [view('posting_rule')], route: '/finance/posting-mappings' },
  { code: 'accounting.fx_mapping', domain: 'accounting', requires: [view('posting_rule')], route: '/finance/posting-mappings' },
  { code: 'accounting.posting_failures', domain: 'accounting', requires: [view('posting_rule')], route: '/finance/posting-mappings' },

  // Inventory — one ledger, and the books agree with it.
  { code: 'inventory.stock_vs_gl', domain: 'inventory', requires: [view('inventory_movement'), view('trial_balance')], route: '/inventory/fifo-valuation' },
  { code: 'inventory.negative_stock', domain: 'inventory', requires: [view('inventory_movement')], route: '/inventory/checks' },
  { code: 'inventory.fifo_layers', domain: 'inventory', requires: [view('inventory_movement')], route: '/inventory/checks' },
  { code: 'inventory.documents_ledger', domain: 'inventory', requires: [view('inventory_movement')], route: '/inventory/checks' },
  { code: 'inventory.transit', domain: 'inventory', requires: [view('in_transit')], route: '/logistics/in-transit' },

  // Receivables
  { code: 'receivables.control_account', domain: 'receivables', requires: [view('ar_invoice')], route: '/sales/customer-reconciliation' },
  { code: 'receivables.statement_ageing', domain: 'receivables', requires: [view('ar_invoice')], route: '/sales/receivables' },

  // Payables
  { code: 'payables.control_account', domain: 'payables', requires: [view('ap_invoice')], route: '/payables/reconciliation' },
  { code: 'payables.statement_ageing', domain: 'payables', requires: [view('ap_invoice')], route: '/payables/open-items' },
  { code: 'payables.supplier_credits', domain: 'payables', requires: [view('supplier_credit_memo')], route: '/payables/credit-memos' },

  // Logistics
  { code: 'logistics.transit_issues', domain: 'logistics', requires: [view('in_transit')], route: '/logistics/in-transit' },
  { code: 'logistics.landed_costs', domain: 'logistics', requires: [view('landed_cost_register'), view('landed_cost')], route: '/logistics/landed-costs' },
  { code: 'logistics.customs', domain: 'logistics', requires: [view('customs_pd')], route: '/payables/pd' },
  { code: 'logistics.shipment_delays', domain: 'logistics', requires: [view('shipment_container')], route: '/logistics/shipment-tracking' },

  // Platform — the machinery the books run on.
  { code: 'platform.jobs', domain: 'platform', requires: [view('job')], route: '/administration/jobs', host: true },
  { code: 'platform.outbox', domain: 'platform', requires: [view('job')], route: '/administration/jobs' },
  { code: 'platform.deliveries', domain: 'platform', requires: [view('job')], route: '/administration/jobs' },
  { code: 'platform.whatsapp', domain: 'platform', requires: [view('whatsapp')], route: '/administration/whatsapp' },
  { code: 'platform.cloud', domain: 'platform', requires: [view('cloud_setting')], route: '/administration/cloud-files' },
  { code: 'platform.system_health', domain: 'platform', requires: [view('system_health')], route: '/administration/backup-health', host: true },
  { code: 'platform.users_without_role', domain: 'platform', requires: [view('app_user')], route: '/administration/users' },
  { code: 'platform.unknown_grants', domain: 'platform', requires: [view('role')], route: '/administration/roles' },
  { code: 'platform.super_users', domain: 'platform', requires: [view('app_user')], route: '/administration/users' },
  { code: 'platform.employee_links', domain: 'platform', requires: [view('app_user'), view('employee')], route: '/hr/employees' },
]);

export const checkOf = (code: string): CheckDefinition | undefined => CHECKS.find((check) => check.code === code);

export const checksOf = (domain: CcDomain): readonly CheckDefinition[] => CHECKS.filter((check) => check.domain === domain);

/** The message key under `admin.control_center.check`: `accounting.trial_balance` → `accounting_trial_balance`. */
export const checkKey = (code: string): string => code.replace('.', '_');

/** The first requirement the person lacks, or null when they hold them all. */
export function missingRequirement(
  definition: Pick<CheckDefinition, 'requires'>,
  may: (verb: PermissionVerb, object: string) => boolean,
): Requirement | null {
  return definition.requires.find((requirement) => !may(requirement.verb, requirement.object)) ?? null;
}

// ---------------------------------------------------------------------------
// Why a check did not answer
// ---------------------------------------------------------------------------

export const REASON_CODES = ['no_access', 'timeout', 'budget', 'error', 'no_host_data', 'not_configured'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  readonly code: ReasonCode;
  /** The numbers or names the wording uses (a screen's route, the seconds allowed, a short message). */
  readonly params?: Readonly<Record<string, string | number>>;
}

/** PostgreSQL's "canceling statement due to statement timeout". */
const QUERY_CANCELED = '57014';

/** The longest error text shown on the page; the full error is logged with the check's code. */
export const REASON_MESSAGE_MAX = 160;

/**
 * Why a thrown error is "could not be checked": a statement that ran out of time says so, anything else shows
 * the first line of its message, shortened — a person needs a reason, not a stack.
 */
export function reasonFromError(error: unknown, timeoutSeconds: number): Reason {
  const code = (error as { code?: unknown } | null)?.code;
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === QUERY_CANCELED || cause === QUERY_CANCELED) return { code: 'timeout', params: { seconds: timeoutSeconds } };
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const firstLine = raw.split('\n')[0]!.replace(/\s+/g, ' ').trim();
  const message = firstLine.length > REASON_MESSAGE_MAX ? `${firstLine.slice(0, REASON_MESSAGE_MAX - 1)}…` : firstLine;
  return { code: 'error', params: { message: message || 'unknown' } };
}

// ---------------------------------------------------------------------------
// Figures and items
// ---------------------------------------------------------------------------

/**
 * One figure a check compared. `amountIqd` is a decimal string (money is compared as scaled integers, never as
 * numbers); `quantity` the same for stock; `count` a whole number; `text` a word or a date. The message
 * `admin.control_center.figure.<key>` names it.
 */
export interface Figure {
  readonly key: string;
  readonly amountIqd?: string | null;
  readonly quantity?: string | null;
  readonly count?: number | null;
  readonly text?: string | null;
  /** Wording numbers for the label (the account it belongs to, the job it describes). */
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * One thing that needs attention, with the record that opens it. `detector` names an Exception Center detector
 * whose own wording (`admin.exceptions.detector.<name>.title`) reads the item; without it the item is worded by
 * `admin.control_center.item.<code>`. Parameter names follow the Exception Center's convention — a name ending
 * `Iqd` is money, `Qty` a quantity, `Date` a date — so one formatter reads both.
 */
export interface Item {
  readonly code: string;
  readonly detector?: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** The number or name a person recognises it by. */
  readonly ref: string | null;
  /** A local path that opens the record; null when it has no page of its own. */
  readonly href: string | null;
}

/** The longest list of things a check carries; the rest are counted (`attention`) and reached by the check's link. */
export const ITEM_CAP = 8;

export interface Reading {
  readonly figures: readonly Figure[];
  readonly items: readonly Item[];
  /** How many things need attention — more than `items.length` when the list was cut at `ITEM_CAP`. */
  readonly attention: number;
  /** The check could not answer here, with the reason. */
  readonly unavailable?: Reason | null;
  /** The check is switched off or not set up here: not asked, not a fault. */
  readonly notConfigured?: boolean;
}

export interface CheckResult {
  readonly code: string;
  readonly domain: CcDomain;
  readonly state: CheckState;
  readonly route: string;
  readonly figures: readonly Figure[];
  readonly items: readonly Item[];
  readonly attention: number;
  /** Items beyond the cap. */
  readonly hidden: number;
  readonly reason: Reason | null;
  readonly elapsedMs: number;
}

/** The state a reading earns. A reading that could not answer is never `ok`. */
export function stateOf(reading: Pick<Reading, 'attention' | 'unavailable' | 'notConfigured'>): CheckState {
  if (reading.unavailable) return 'unavailable';
  if (reading.notConfigured) return 'not_checked';
  return reading.attention > 0 ? 'attention' : 'ok';
}

/** The first `ITEM_CAP` items, and how many were left out. */
export function capItems<T>(items: readonly T[], cap: number = ITEM_CAP): { readonly shown: readonly T[]; readonly hidden: number } {
  return { shown: items.slice(0, cap), hidden: Math.max(0, items.length - cap) };
}

/** A reading, shaped with the cap applied so every check reports `attention` and `hidden` the same way. */
export function readingOf(input: {
  readonly figures?: readonly Figure[];
  readonly items?: readonly Item[];
  readonly attention?: number;
  readonly unavailable?: Reason | null;
  readonly notConfigured?: boolean;
}): Reading {
  const items = input.items ?? [];
  const { shown } = capItems(items);
  return {
    figures: input.figures ?? [],
    items: shown,
    attention: Math.max(input.attention ?? items.length, items.length),
    unavailable: input.unavailable ?? null,
    notConfigured: input.notConfigured ?? false,
  };
}

/** The result of a check from its definition, its reading and the time it took. */
export function resultOf(definition: CheckDefinition, reading: Reading, elapsedMs: number): CheckResult {
  const state = stateOf(reading);
  return {
    code: definition.code,
    domain: definition.domain,
    state,
    route: definition.route,
    figures: reading.figures,
    items: state === 'attention' ? reading.items : [],
    attention: state === 'attention' ? reading.attention : 0,
    hidden: state === 'attention' ? Math.max(0, reading.attention - reading.items.length) : 0,
    reason: reading.unavailable ?? (reading.notConfigured ? { code: 'not_configured' } : null),
    elapsedMs,
  };
}

/** A check that was not run, or could not be, and says why. */
export function withheld(definition: CheckDefinition, state: 'not_checked' | 'unavailable', reason: Reason, elapsedMs = 0): CheckResult {
  return {
    code: definition.code,
    domain: definition.domain,
    state,
    route: definition.route,
    figures: [],
    items: [],
    attention: 0,
    hidden: 0,
    reason,
    elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// Arithmetic — money compared exactly
// ---------------------------------------------------------------------------

export interface Comparison {
  readonly leftIqd: string;
  readonly rightIqd: string;
  /** left − right, as a decimal string. */
  readonly differenceIqd: string;
  readonly equal: boolean;
}

/**
 * Two amounts compared as scaled integers: a dinar over is over, and a fils is a fils. `tolerance` is a
 * decimal string (default none) — only the stock check uses one, for its documented provisional amount.
 */
export function compareAmounts(left: string, right: string, tolerance = '0'): Comparison {
  const l = parseDecimal(left.trim() === '' ? '0' : left, MONEY_SCALE);
  const r = parseDecimal(right.trim() === '' ? '0' : right, MONEY_SCALE);
  const allowed = parseDecimal(tolerance, MONEY_SCALE);
  const difference = l - r;
  const magnitude = difference < 0n ? -difference : difference;
  return {
    leftIqd: toDecimalString(l, MONEY_SCALE),
    rightIqd: toDecimalString(r, MONEY_SCALE),
    differenceIqd: toDecimalString(difference, MONEY_SCALE),
    equal: magnitude <= allowed,
  };
}

/** The sum of decimal strings, exactly. */
export function sumAmounts(values: readonly string[]): string {
  return toDecimalString(
    values.reduce((total, value) => total + parseDecimal(value.trim() === '' ? '0' : value, MONEY_SCALE), 0n),
    MONEY_SCALE,
  );
}

/** Is this decimal string zero? */
export function isZeroAmount(value: string | null | undefined): boolean {
  if (value === null || value === undefined || value.trim() === '') return true;
  return parseDecimal(value, MONEY_SCALE) === 0n;
}

// ---------------------------------------------------------------------------
// The summary — counts, never a score
// ---------------------------------------------------------------------------

export type StateCounts = Readonly<Record<CheckState, number>>;

export interface Summary {
  readonly total: number;
  readonly byState: StateCounts;
  readonly byDomain: Readonly<Record<CcDomain, StateCounts>>;
}

const emptyCounts = (): Record<CheckState, number> => ({ ok: 0, attention: 0, not_checked: 0, unavailable: 0 });

/**
 * How many checks stand in each state, overall and by domain. This is the whole of the "headline": there is no
 * percentage and no grade, because "7 of 31" would imply that a not-checked check counts for or against the
 * system — and a check nobody could run says nothing about the books.
 */
export function summarize(results: readonly Pick<CheckResult, 'domain' | 'state'>[]): Summary {
  const byState = emptyCounts();
  const byDomain = Object.fromEntries(CC_DOMAINS.map((d) => [d, emptyCounts()])) as Record<CcDomain, Record<CheckState, number>>;
  for (const result of results) {
    byState[result.state] += 1;
    byDomain[result.domain][result.state] += 1;
  }
  return { total: results.length, byState, byDomain };
}

/** The state that stands for a whole domain: the most urgent among its checks. */
export function worstState(states: readonly CheckState[]): CheckState | null {
  for (const state of STATE_ORDER) if (states.includes(state)) return state;
  return null;
}

// ---------------------------------------------------------------------------
// Scheduled jobs — failed, never run, overdue
// ---------------------------------------------------------------------------

/**
 * How often a cron line fires, in minutes, for the shapes `scripts/ops/crontab.erp` uses; null for a shape not
 * recognised (the job is then judged only on its last exit, never called overdue on a guess).
 */
export function cronIntervalMinutes(schedule: string): number | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  const everyMinutes = /^\*\/(\d+)$/.exec(minute);
  if (everyMinutes && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(everyMinutes[1]);
    return n > 0 ? n : null;
  }
  if (!/^\d+$/.test(minute)) return null;
  if (hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return 60;
  const everyHours = /^\*\/(\d+)$/.exec(hour);
  if (everyHours && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    const n = Number(everyHours[1]);
    return n > 0 ? n * 60 : null;
  }
  if (!/^\d+$/.test(hour) || month !== '*') return null;
  if (dayOfMonth === '*' && dayOfWeek === '*') return 24 * 60;
  if (dayOfMonth === '*' && /^[0-7]$/.test(dayOfWeek)) return 7 * 24 * 60;
  return null;
}

/** A run is overdue when the last one is older than one and a half intervals and ten minutes — one missed run is a wobble, two is a stop. */
export function overdueAfterMinutes(intervalMinutes: number): number {
  return Math.floor((intervalMinutes * 3) / 2) + 10;
}

export type JobState = 'ok' | 'failed' | 'overdue' | 'never';

export interface JobFact {
  readonly name: string;
  readonly schedule: string;
  readonly lastRunAt: string | null;
  readonly lastExit: number | null;
}

/** One job's standing at `now`: its last exit first (a failure is a failure however old), then whether it has run at all, then whether it is late. */
export function jobState(job: JobFact, now: Date): JobState {
  if (job.lastRunAt === null || job.lastExit === null) return 'never';
  if (job.lastExit !== 0) return 'failed';
  const interval = cronIntervalMinutes(job.schedule);
  if (interval === null) return 'ok';
  const at = Date.parse(job.lastRunAt);
  if (Number.isNaN(at)) return 'never';
  const ageMinutes = (now.getTime() - at) / 60_000;
  return ageMinutes > overdueAfterMinutes(interval) ? 'overdue' : 'ok';
}

/** Whole minutes between the last run and now (for the item's wording); null when there was no run. */
export function minutesSince(lastRunAt: string | null, now: Date): number | null {
  if (lastRunAt === null) return null;
  const at = Date.parse(lastRunAt);
  return Number.isNaN(at) ? null : Math.max(0, Math.floor((now.getTime() - at) / 60_000));
}

// ---------------------------------------------------------------------------
// Permissions — what counts as an anomaly, defined once
// ---------------------------------------------------------------------------

/**
 * Permission objects the code checks that no menu item carries: the permission editor offers only
 * `menuObjects()`, so these are granted by migrations and read by services (an attachment, a payment batch, a
 * logistics job cost). A grant naming an object outside the menu AND outside this list is one nothing reads —
 * a typo, a renamed object, a leftover. `tests/unit/cc01-control-center.test.ts` fails when an entry here is
 * no longer used anywhere in `src`, and the integration test fails when a fresh database holds a grant outside
 * both lists, so the list cannot rot in either direction unnoticed.
 */
export const NON_MENU_OBJECTS: readonly string[] = Object.freeze([
  'ar_write_off',
  'attachment',
  'cash_advance',
  'client_goods_delivery',
  'client_import_payment',
  'client_kyc_record',
  'crm',
  'dimension',
  'employee_asset',
  'employee_compensation',
  'investment_proposal',
  'invoice',
  'landed_cost',
  'logistics_carrier',
  'logistics_client_charge',
  'logistics_client_funding',
  'logistics_delivery_evidence',
  'logistics_job_cost',
  'logistics_job_settlement',
  'logistics_route',
  'logistics_service_type',
  'money_transfer_client_account',
  'money_transfer_deposit',
  'money_transfer_expense',
  'organisation',
  'other_receipt',
  'payment_batch',
  'payment_terms',
  'supplier_shipment',
  'warranty_registration',
]);

/**
 * Objects a shipped migration grants for a screen that is not built yet — nothing reads them today, and they are
 * the platform's own reservation, not a stray. `tests/unit/cc01-control-center.test.ts` fails when one is not
 * granted by any migration (it would then be a name for nothing) or has become a menu object (it would then
 * belong to the menu, not here).
 */
export const RESERVED_OBJECTS: readonly string[] = Object.freeze(['data_scope']);

/** Granted objects that neither the menu, `NON_MENU_OBJECTS` nor `RESERVED_OBJECTS` knows, sorted. */
export function unknownObjects(granted: readonly string[], menu: readonly string[]): string[] {
  const known = new Set<string>([...menu, ...NON_MENU_OBJECTS, ...RESERVED_OBJECTS]);
  return [...new Set(granted)].filter((object) => !known.has(object)).sort();
}

/**
 * More than one active Super User is a finding: a Super User passes every permission check, so each one is a
 * key to everything. One is the owner's break-glass account and is listed, not flagged.
 */
export const SUPER_USERS_ALLOWED = 1;

export const superUsersNeedAttention = (activeSuperUsers: number): boolean => activeSuperUsers > SUPER_USERS_ALLOWED;

// ---------------------------------------------------------------------------
// Imports — the quantities in transit
// ---------------------------------------------------------------------------

export interface TransitQuantities {
  /** Base units, as `logistics-views.inTransitInventory` reports them. */
  readonly ordered: string;
  readonly shipped: string;
  readonly received: string;
  readonly inTransit: string;
  readonly containers: number;
  readonly containersOpen: number;
}

export const TRANSIT_ISSUES = ['shipped_over_ordered', 'received_over_ordered', 'short_in_transit'] as const;
export type TransitIssue = (typeof TRANSIT_ISSUES)[number];

/**
 * What cannot be true of one item on one import, from the quantities the In-Transit screen already shows:
 *
 *   shipped_over_ordered    more is planned into containers than the posted invoices bought;
 *   received_over_ordered   more has been received than the invoices bought;
 *   short_in_transit        every container is in, yet goods still stand in a transit warehouse — a shortage
 *                           nobody has claimed or written off (the import's claim is `shipments.claimShortage`).
 *
 * A container still on the water with goods in transit is the normal state and says nothing.
 */
export function transitIssues(row: TransitQuantities): TransitIssue[] {
  const ordered = parseQuantity(row.ordered);
  const shipped = parseQuantity(row.shipped);
  const received = parseQuantity(row.received);
  const inTransit = parseQuantity(row.inTransit);
  const issues: TransitIssue[] = [];
  if (shipped > ordered) issues.push('shipped_over_ordered');
  if (received > ordered) issues.push('received_over_ordered');
  if (row.containers > 0 && row.containersOpen === 0 && inTransit > 0n) issues.push('short_in_transit');
  return issues;
}
