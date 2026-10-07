/**
 * Every register's date window and order (2026-10-07, by direction: "filters
 * on table by dates between or by ascending descending by date … just add
 * filter button for it and do that for table … the tables first comes latest
 * ones made for all").
 *
 * One question for every register, asked with the same three parameters:
 *
 *   from — the first day kept (inclusive), `YYYY-MM-DD`;
 *   to   — the last day kept (inclusive), `YYYY-MM-DD`;
 *   sort — `newest` (the default, on every register) or `oldest`.
 *
 * The date is the register's own document date — an invoice's date, a
 * journal's posting date, a request's date raised — named by each register's
 * read. A paged register asks it in SQL (`services/register-dates-sql.ts`); a
 * register read whole asks it here (`applyRegisterDates`), on every row before
 * anything is drawn — never on a page of rows in the browser.
 *
 * Pure: the screens, the saved views and the pinned counts read the same rule.
 */

export const REGISTER_SORTS = ['newest', 'oldest'] as const;
export type RegisterSort = (typeof REGISTER_SORTS)[number];

export interface RegisterDates {
  readonly from: string | null;
  readonly to: string | null;
  readonly sort: RegisterSort;
}

/** Nothing set: every row, newest first. */
export const NO_REGISTER_DATES: RegisterDates = { from: null, to: null, sort: 'newest' };

type RawParams = Readonly<Record<string, string | readonly string[] | undefined>>;

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day written `YYYY-MM-DD` that exists (no 2026-02-30), else null. */
export function isoDayOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DAY.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last ? `${y}-${m}-${d}` : null;
}

function first(raw: RawParams, name: string): string | undefined {
  const value = raw[name];
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

/**
 * The window and order the address asks for. A day that is not a real day is
 * not set; a window typed back to front (to before from) is read the right way
 * round, because that is what the person meant.
 */
export function registerDatesOf(raw: RawParams, names: { readonly from?: string; readonly to?: string } = {}): RegisterDates {
  let from = isoDayOrNull(first(raw, names.from ?? 'from'));
  let to = isoDayOrNull(first(raw, names.to ?? 'to'));
  if (from && to && from > to) [from, to] = [to, from];
  const sort = first(raw, 'sort') === 'oldest' ? 'oldest' : 'newest';
  return { from, to, sort };
}

/** Whether anything but the default is asked — the Filter button says so. */
export function registerDatesActive(dates: RegisterDates): number {
  return (dates.from ? 1 : 0) + (dates.to ? 1 : 0) + (dates.sort === 'oldest' ? 1 : 0);
}

/**
 * The parameters to carry on every other link and form of the screen (the
 * search, the view filter, the pages), so that changing one keeps the rest.
 * Only what is set: the default order is never written into an address.
 */
export function registerDatesParams(
  dates: RegisterDates,
  names: { readonly from?: string; readonly to?: string } = {},
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  if (dates.from) out[names.from ?? 'from'] = dates.from;
  if (dates.to) out[names.to ?? 'to'] = dates.to;
  if (dates.sort !== 'newest') out['sort'] = dates.sort;
  return out;
}

/** `registerDatesParams` as a query string fragment (`from=…&sort=oldest`), empty when nothing is set. */
export function registerDatesQuery(dates: RegisterDates, names: { readonly from?: string; readonly to?: string } = {}): string {
  return Object.entries(registerDatesParams(dates, names))
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

/** The day part of a date column's value — a `YYYY-MM-DD` string, a timestamp string or a Date. */
export function dayOf(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value);
  return ISO_DAY.test(text.slice(0, 10)) ? text.slice(0, 10) : null;
}

/** Whether a row's day is inside the window. With either end set, a row with no date is outside it. */
export function withinRegisterDates(day: string | null, dates: RegisterDates): boolean {
  if (!dates.from && !dates.to) return true;
  if (!day) return false;
  if (dates.from && day < dates.from) return false;
  if (dates.to && day > dates.to) return false;
  return true;
}

function compareText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/**
 * A register read whole: the rows inside the window, newest first (or oldest
 * first). `dateOf` is the register's own document date; `stampOf`, when
 * given, orders rows of the same day by when they were made (a timestamp or
 * the document number — anything that sorts as text); rows with no date go
 * last either way. The order is stable, so rows that tie keep the read's order.
 */
export function applyRegisterDates<T>(
  rows: readonly T[],
  dateOf: (row: T) => string | Date | null | undefined,
  dates: RegisterDates,
  stampOf?: (row: T) => string | Date | null | undefined,
): T[] {
  const sign = dates.sort === 'oldest' ? 1 : -1;
  const stamp = (row: T): string | null => {
    if (!stampOf) return null;
    const value = stampOf(row);
    if (value === null || value === undefined) return null;
    return value instanceof Date ? value.toISOString() : String(value);
  };
  return rows
    .map((row, index) => ({ row, index, day: dayOf(dateOf(row)), stamp: stamp(row) }))
    .filter((entry) => withinRegisterDates(entry.day, dates))
    .sort((a, b) => {
      if (a.day === null || b.day === null) {
        if (a.day !== b.day) return a.day === null ? 1 : -1;
      } else if (a.day !== b.day) {
        return sign * compareText(a.day, b.day);
      }
      if (a.stamp !== null && b.stamp !== null && a.stamp !== b.stamp) return sign * compareText(a.stamp, b.stamp);
      return a.index - b.index;
    })
    .map((entry) => entry.row);
}

/**
 * The three parameters as a saved-view registry declares them, and the range
 * slot over the window ("this month" kept as a rule) — spread into every
 * register's `ViewableRoute`.
 */
export const REGISTER_DATE_PARAMS = {
  from: { kind: 'date' },
  to: { kind: 'date' },
  sort: { kind: 'enum', values: REGISTER_SORTS, labels: { own: 'sort' } },
} as const;

export const REGISTER_DATE_SLOT = { id: 'dates', kind: 'range', from: 'from', to: 'to' } as const;
