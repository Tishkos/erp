/**
 * Saved views of screens — the pure rules (platform phase, Agent 8).
 *
 * A saved view is a screen's *question*, never its answer: a route key and the
 * few query-string parameters that screen declares it accepts. Opening one
 * sends the person to the screen with those parameters, and the screen runs its
 * own query as the person — their grants, their branch, their row policies —
 * exactly as if they had typed the filters. Nothing here can widen what a
 * person sees, because nothing here reads business data.
 *
 * What this module decides, and why it is code and not a convention:
 *
 *   - which parameters a view may carry (`ViewableRoute.params`): a name the
 *     screen did not declare, or a value of the wrong shape, is refused when
 *     the view is saved and *dropped* when it is opened, so a view can never
 *     smuggle a parameter into a screen that never asked for one, and a view
 *     saved against a filter the screen has since lost still opens (saying so);
 *   - relative dates: "this month", "next 30 days" are stored as a *rule name*
 *     and turned into dates only when the view is opened, from the business day
 *     the caller passes (`businessToday()`); a stored date would be last
 *     month's by the time anyone looked at it;
 *   - what counts as "explicit filters" (a default view applies only to a bare
 *     arrival), which view is active, and how a name is kept unique.
 *
 * Pure: no SQL, no request, no clock. The registry of screens is
 * `saved-view-routes.ts`; the service that stores views is
 * `services/saved-views.ts`.
 */
import type { PermissionVerb } from './permissions';

// ---------------------------------------------------------------------------
// What a screen declares
// ---------------------------------------------------------------------------

/** Where the label of an enum value comes from — the screen's own messages, so the summary says what the filter says. */
export type LabelSource =
  | {
      /** A message namespace, `admin.expenses`. */
      readonly namespace: string;
      /** Prepended to the value: `view_` → `view_overdue`. */
      readonly prefix?: string;
      /** A value whose message is not `<prefix><value>`. */
      readonly map?: Readonly<Record<string, string>>;
    }
  | {
      /** A group under `savedViews.values.<own>` holding one label per value. */
      readonly own: string;
    };

export type ParamSpec =
  /** Free text the screen searches on (`q`, an item name): trimmed, one line. */
  | { readonly kind: 'text'; readonly max?: number }
  /** An identifier — a partner, warehouse or category code. Letters, digits and ` ._-/` only. */
  | { readonly kind: 'token'; readonly max?: number }
  /** One of a closed list. */
  | { readonly kind: 'enum'; readonly values: readonly string[]; readonly labels?: LabelSource }
  /** A checkbox: present as `1`, absent otherwise. */
  | { readonly kind: 'flag' }
  /** A calendar date, `YYYY-MM-DD`. */
  | { readonly kind: 'date' }
  /** A non-negative decimal amount, at most four decimals. */
  | { readonly kind: 'amount' };

/**
 * The dates of a screen that may be kept as a rule instead of as dates.
 *
 * `range` owns two date parameters; `point` owns one. The slot's id names the
 * rule in a stored view (`dates: { range: 'this_month' }`), so a screen that
 * later renames a parameter keeps its views' rules.
 */
export type DateSlot =
  | { readonly id: string; readonly kind: 'range'; readonly from: string; readonly to: string }
  | { readonly id: string; readonly kind: 'point'; readonly param: string };

export interface ViewableRoute {
  /** Stable key stored with the view: `payables.invoices`. Contains a dot (the table's check). */
  readonly key: string;
  /** The screen's path. Must be a route the shell serves. */
  readonly route: string;
  /**
   * The permission the screen asks to be opened, when it is not the menu
   * item's own (`screenRoutes().get(route).item`). A view of a screen the
   * person can no longer open is shown as unavailable.
   */
  readonly object?: string;
  readonly verb?: PermissionVerb;
  /** The parameters the screen reads, in the order they are written to an address. */
  readonly params: Readonly<Record<string, ParamSpec>>;
  readonly slots?: readonly DateSlot[];
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** What Next hands a page. */
export type RawParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/** Never part of a view: paging, the outcome of an earlier action, the view picker itself. */
export const NON_VIEW_PARAMS: readonly string[] = ['page', 'saved', 'error', 'sv'];

/** A view without a name worth reading, or one that would not fit a menu. */
export const NAME_MAX = 80;
/** A view carries a handful of filters; this stops a hand-made request storing a novel. */
export const MAX_PARAMS = 16;

export type DroppedReason = 'unknown_param' | 'invalid_value' | 'unknown_rule' | 'unreadable';

export interface DroppedParam {
  /** The parameter, or the slot for a rule, or `*` for a config that could not be read. */
  readonly name: string;
  readonly reason: DroppedReason;
}

const TOKEN = /^[\p{L}\p{N}][\p{L}\p{N} ._\-/]*$/u;
// Control characters and the bidi overrides (a name that reorders what is drawn around it). Zero-width joiners stay: Arabic and Persian text uses them.
const CONTROL = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u;
const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** First value of a parameter, as the page would read it. */
export function firstOf(raw: RawParams, name: string): string | undefined {
  const value = raw[name];
  if (Array.isArray(value)) return value[0] as string | undefined;
  return typeof value === 'string' ? value : undefined;
}

/** A real calendar date in a sane year. */
export function isCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The value as the screen would receive it, or null when it is not one this
 * parameter accepts. Pure shape checks: whether `SUP-000001` exists is the
 * screen's question, asked as the person.
 */
export function normaliseValue(spec: ParamSpec, value: string): string | null {
  const text = value.trim();
  switch (spec.kind) {
    case 'text': {
      const collapsed = text.replace(/\s+/g, ' ');
      if (!collapsed || collapsed.length > (spec.max ?? 80) || CONTROL.test(collapsed)) return null;
      return collapsed;
    }
    case 'token':
      return text && text.length <= (spec.max ?? 60) && TOKEN.test(text) ? text : null;
    case 'enum':
      return spec.values.includes(text) ? text : null;
    case 'flag':
      return text === '1' ? '1' : null;
    case 'date':
      return isCalendarDate(text) ? text : null;
    case 'amount':
      return AMOUNT.test(text) ? text : null;
  }
}

export interface SanitisedParams {
  /** The parameters the screen declares, valid, in the screen's order. */
  readonly params: Readonly<Record<string, string>>;
  readonly dropped: readonly DroppedParam[];
}

/**
 * Keep what the screen declares and what is well formed.
 *
 * An empty value is "not set", not an error: a filter form submits every field
 * it has, blank ones included. Parameters the screen does not declare are
 * ignored without a mark when they belong to the page's own mechanics
 * (`NON_VIEW_PARAMS`, anything else a page uses) — they were never part of the
 * question — and the browser's address is not a place to report them.
 */
export function sanitiseParams(route: ViewableRoute, raw: RawParams): SanitisedParams {
  const params: Record<string, string> = {};
  const dropped: DroppedParam[] = [];
  for (const [name, spec] of Object.entries(route.params)) {
    const given = firstOf(raw, name);
    if (given === undefined || given.trim() === '') continue;
    const value = normaliseValue(spec, given);
    if (value === null) dropped.push({ name, reason: 'invalid_value' });
    else params[name] = value;
  }
  return { params, dropped };
}

/** Whether the address already says what the person wants to see (a default view applies only to a bare arrival). */
export function hasExplicitParams(route: ViewableRoute, raw: RawParams): boolean {
  if (raw['sv'] !== undefined) return true;
  return Object.keys(route.params).some((name) => raw[name] !== undefined);
}

/** The query string for a set of parameters, in the screen's own order. No leading `?`. */
export function queryOf(route: ViewableRoute, params: Readonly<Record<string, string>>): string {
  const query = new URLSearchParams();
  for (const name of Object.keys(route.params)) {
    const value = params[name];
    if (value !== undefined && value !== '') query.set(name, value);
  }
  return query.toString();
}

/** The screen's address with those parameters. */
export function hrefOf(route: ViewableRoute, params: Readonly<Record<string, string>>): string {
  const query = queryOf(route, params);
  return query ? `${route.route}?${query}` : route.route;
}

/** Whether two parameter sets ask the same question. */
export function sameParams(
  route: ViewableRoute,
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  return queryOf(route, a) === queryOf(route, b);
}

// ---------------------------------------------------------------------------
// Relative dates
// ---------------------------------------------------------------------------

export const RANGE_RULES = [
  'today',
  'this_month',
  'last_month',
  'next_month',
  'next_7_days',
  'next_30_days',
  'last_7_days',
  'last_30_days',
  'month_to_date',
  'year_to_date',
  'this_year',
  'until_today',
  'from_today',
] as const;
export type RangeRule = (typeof RANGE_RULES)[number];

export const POINT_RULES = ['today', 'month_start', 'month_end', 'last_month_end', 'year_start'] as const;
export type PointRule = (typeof POINT_RULES)[number];

export function rulesFor(slot: DateSlot): readonly string[] {
  return slot.kind === 'range' ? RANGE_RULES : POINT_RULES;
}

function parts(date: string): { y: number; m: number; d: number } {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`'${date}' is not a business date`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Calendar arithmetic on a business date; the time of day plays no part. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parts(date);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

export function monthStart(date: string, shiftMonths = 0): string {
  const { y, m } = parts(date);
  const moved = new Date(Date.UTC(y, m - 1 + shiftMonths, 1));
  return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, 1);
}

export function monthEnd(date: string, shiftMonths = 0): string {
  const { y, m } = parts(date);
  const moved = new Date(Date.UTC(y, m + shiftMonths, 0));
  return iso(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

export function yearStart(date: string): string {
  return iso(parts(date).y, 1, 1);
}

export function yearEnd(date: string): string {
  return iso(parts(date).y, 12, 31);
}

/** `from` and `to` as dates; null leaves that end open. */
export interface DateRange {
  readonly from: string | null;
  readonly to: string | null;
}

export function evaluateRangeRule(rule: RangeRule, today: string): DateRange {
  switch (rule) {
    case 'today':
      return { from: today, to: today };
    case 'this_month':
      return { from: monthStart(today), to: monthEnd(today) };
    case 'last_month':
      return { from: monthStart(today, -1), to: monthEnd(today, -1) };
    case 'next_month':
      return { from: monthStart(today, 1), to: monthEnd(today, 1) };
    case 'next_7_days':
      return { from: today, to: addDays(today, 7) };
    case 'next_30_days':
      return { from: today, to: addDays(today, 30) };
    case 'last_7_days':
      return { from: addDays(today, -7), to: today };
    case 'last_30_days':
      return { from: addDays(today, -30), to: today };
    case 'month_to_date':
      return { from: monthStart(today), to: today };
    case 'year_to_date':
      return { from: yearStart(today), to: today };
    case 'this_year':
      return { from: yearStart(today), to: yearEnd(today) };
    case 'until_today':
      return { from: null, to: today };
    case 'from_today':
      return { from: today, to: null };
  }
}

export function evaluatePointRule(rule: PointRule, today: string): string {
  switch (rule) {
    case 'today':
      return today;
    case 'month_start':
      return monthStart(today);
    case 'month_end':
      return monthEnd(today);
    case 'last_month_end':
      return monthEnd(today, -1);
    case 'year_start':
      return yearStart(today);
  }
}

const isRangeRule = (rule: string): rule is RangeRule => (RANGE_RULES as readonly string[]).includes(rule);
const isPointRule = (rule: string): rule is PointRule => (POINT_RULES as readonly string[]).includes(rule);

/** The parameters a rule sets on a slot, as of `today`. A null value removes that parameter. */
export function slotParams(slot: DateSlot, rule: string, today: string): Record<string, string | null> | null {
  if (slot.kind === 'range') {
    if (!isRangeRule(rule)) return null;
    const range = evaluateRangeRule(rule, today);
    return { [slot.from]: range.from, [slot.to]: range.to };
  }
  if (!isPointRule(rule)) return null;
  return { [slot.param]: evaluatePointRule(rule, today) };
}

// ---------------------------------------------------------------------------
// The stored shape
// ---------------------------------------------------------------------------

/**
 * What `saved_view.query` holds for a screen view — filters and rules, nothing
 * else. Versioned so a later change of shape can be read alongside this one.
 */
export interface StoredView {
  readonly v: 1;
  readonly params: Readonly<Record<string, string>>;
  /** Slot id → rule name. Wins over the slot's own literal parameters. */
  readonly dates?: Readonly<Record<string, string>>;
}

export class SavedViewInputError extends Error {
  readonly code = 'SAVED_VIEW_INPUT';
  constructor(
    readonly reason:
      | 'name_required'
      | 'name_too_long'
      | 'name_invalid'
      | 'unknown_route'
      | 'unknown_rule'
      | 'too_many_params',
    detail: string,
  ) {
    super(detail);
    this.name = 'SavedViewInputError';
  }
}

/** A name as it is kept: trimmed, one line, 1–80 characters. */
export function normaliseName(name: string): string {
  const collapsed = name.replace(/\s+/g, ' ').trim();
  if (!collapsed) throw new SavedViewInputError('name_required', 'A view needs a name.');
  if (CONTROL.test(collapsed)) throw new SavedViewInputError('name_invalid', 'A view name is one line of text.');
  if (collapsed.length > NAME_MAX) {
    throw new SavedViewInputError('name_too_long', `A view name is at most ${NAME_MAX} characters.`);
  }
  return collapsed;
}

/**
 * A name that is not yet taken: `Wanted`, else `Wanted (2)`, `Wanted (3)` …,
 * kept within the length limit.
 */
export function uniqueName(taken: ReadonlySet<string>, wanted: string): string {
  const base = normaliseName(wanted);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new SavedViewInputError('name_invalid', 'No free name was found for this view.');
}

export interface StoreResult {
  readonly stored: StoredView;
  /** Parameters in the address the screen would not accept — left out of the view. */
  readonly dropped: readonly DroppedParam[];
}

/**
 * The view to store for what the screen is showing now.
 *
 * `rules` maps a slot id to the rule the person chose ("this month"); a slot
 * with no rule keeps the dates as they are in the address. A rule replaces the
 * slot's literal dates — storing both would leave two answers to "which dates?".
 * An unknown slot or rule is refused, not dropped: it was typed by a person or a
 * script *now*, so the mistake can be told to them.
 */
export function storedFrom(
  route: ViewableRoute,
  raw: RawParams,
  rules: Readonly<Record<string, string>> = {},
): StoreResult {
  const clean = sanitiseParams(route, raw);
  const params: Record<string, string> = { ...clean.params };
  const dates: Record<string, string> = {};

  for (const [slotId, rule] of Object.entries(rules)) {
    if (!rule || rule === 'keep') continue;
    const slot = route.slots?.find((candidate) => candidate.id === slotId);
    if (!slot || !(rulesFor(slot) as readonly string[]).includes(rule)) {
      throw new SavedViewInputError('unknown_rule', `'${rule}' is not a date rule of ${slotId} on ${route.key}.`);
    }
    dates[slotId] = rule;
    if (slot.kind === 'range') {
      delete params[slot.from];
      delete params[slot.to];
    } else {
      delete params[slot.param];
    }
  }

  if (Object.keys(params).length + Object.keys(dates).length > MAX_PARAMS) {
    throw new SavedViewInputError('too_many_params', 'A view holds at most a handful of filters.');
  }
  return {
    stored: { v: 1, params, ...(Object.keys(dates).length > 0 ? { dates } : {}) },
    dropped: clean.dropped,
  };
}

export interface ResolvedView {
  /** The parameters to open the screen with, rules already turned into dates. */
  readonly params: Readonly<Record<string, string>>;
  /** Slot id → rule, for the summary ("this month"). */
  readonly rules: Readonly<Record<string, string>>;
  /** What the screen no longer accepts, left out. */
  readonly dropped: readonly DroppedParam[];
}

function readStored(value: unknown): { params: Record<string, unknown>; dates: Record<string, unknown> } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const params = record['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const dates = record['dates'];
  if (dates !== undefined && (typeof dates !== 'object' || dates === null || Array.isArray(dates))) return null;
  return { params: params as Record<string, unknown>, dates: (dates ?? {}) as Record<string, unknown> };
}

/**
 * Turn a stored view into the parameters to open its screen with, today.
 *
 * Re-validated on every use: the screen may have lost a parameter or an allowed
 * value since the view was saved, and the row could have been written by
 * anything with database access. Whatever does not pass is dropped and named.
 */
export function resolveStored(route: ViewableRoute, stored: unknown, today: string): ResolvedView {
  const read = readStored(stored);
  if (!read) return { params: {}, rules: {}, dropped: [{ name: '*', reason: 'unreadable' }] };

  const params: Record<string, string> = {};
  const rules: Record<string, string> = {};
  const dropped: DroppedParam[] = [];

  for (const [name, value] of Object.entries(read.params)) {
    const spec = route.params[name];
    if (!spec) {
      dropped.push({ name, reason: 'unknown_param' });
      continue;
    }
    const normalised = typeof value === 'string' ? normaliseValue(spec, value) : null;
    if (normalised === null) dropped.push({ name, reason: 'invalid_value' });
    else params[name] = normalised;
  }

  for (const [slotId, rule] of Object.entries(read.dates)) {
    const slot = route.slots?.find((candidate) => candidate.id === slotId);
    const set = slot && typeof rule === 'string' ? slotParams(slot, rule, today) : null;
    if (!slot || !set || typeof rule !== 'string') {
      dropped.push({ name: slotId, reason: 'unknown_rule' });
      continue;
    }
    rules[slotId] = rule;
    for (const [name, value] of Object.entries(set)) {
      if (value === null) delete params[name];
      else params[name] = value;
    }
  }
  return { params, rules, dropped };
}

// ---------------------------------------------------------------------------
// Choosing among views
// ---------------------------------------------------------------------------

export interface Choosable {
  readonly id: string;
  readonly isDefault: boolean;
  readonly available: boolean;
}

/**
 * The view a bare arrival opens: the owner's default, if the screen can be
 * opened. (The table allows one default per screen; this is the same rule read
 * defensively.) Null means "show the screen as it is".
 */
export function chooseDefault<T extends Choosable>(views: readonly T[]): T | null {
  return views.find((view) => view.isDefault && view.available) ?? null;
}

/**
 * Where a bare arrival should go instead, or null to stay.
 *
 * Staying is right when the address already carries filters, when there is no
 * usable default, and when the default asks for nothing the screen does not do
 * on its own (an empty question would redirect to itself).
 */
export function defaultRedirect(
  route: ViewableRoute,
  raw: RawParams,
  view: { readonly params: Readonly<Record<string, string>> } | null,
): string | null {
  if (!view || hasExplicitParams(route, raw)) return null;
  const query = queryOf(route, view.params);
  if (!query) return null;
  // The outcome of the action that brought the person here travels with them:
  // a "saved" notice that vanished into a redirect would be a success nobody saw.
  const carried = new URLSearchParams(query);
  for (const name of ['saved', 'error']) {
    const value = firstOf(raw, name);
    if (value !== undefined) carried.set(name, value);
  }
  return `${route.route}?${carried.toString()}`;
}
