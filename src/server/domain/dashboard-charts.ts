/**
 * Chart data for Home — platform phase, Agent 2.
 *
 * Pure shaping of figures a service already computed into the series a chart
 * draws. Three rules, the same ones `services/dashboard.ts` states for its
 * bands:
 *
 * 1. **Money is a scaled bigint until the last step.** Totals, ordering and
 *    "is this zero" are decided on bigints; a `number` appears only in
 *    `chartNumber`, the step before a bar's length is drawn, and never comes
 *    back as an amount.
 * 2. **No chart of nothing.** `hasActivity` / the shapers answer null for a
 *    series whose every point is zero, so a loader reports "empty" instead of
 *    drawing a flat axis that looks like a fault in the data.
 * 3. **Dates are arithmetic, not `Date`.** The month windows are computed from
 *    the business date's digits, so a Baghdad evening cannot become "last
 *    month" through a UTC conversion.
 */
import { AGEING_BUCKETS, type AgeingBucket } from './ageing';
import { toDecimalString } from './money';

export const CHART_MONEY = 4n;

/**
 * A money string as a scaled bigint at four places, rounding half away from
 * zero past them. The FIFO valuation carries ten places (quantity × unit cost,
 * left unrounded so the Warehouses Report can show the multiplication); this is
 * the one place that rule is applied to it for a chart, written down rather
 * than hidden in a cast.
 */
export function moneyOf(value: string | null | undefined): bigint {
  const raw = (value ?? '').trim();
  if (raw === '') return 0n;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match) throw new RangeError(`Not a decimal value: "${raw}"`);
  const [, sign, whole = '', fraction = ''] = match;
  const kept = fraction.slice(0, 4).padEnd(4, '0');
  let scaled = BigInt(`${whole === '' ? '0' : whole}${kept}`);
  if (fraction.length > 4 && Number(fraction[4]) >= 5) scaled += 1n;
  return sign === '-' ? -scaled : scaled;
}

export const moneyString = (value: bigint): string => toDecimalString(value, CHART_MONEY);

export const sumMoney = (values: readonly (string | null | undefined)[]): bigint =>
  values.reduce<bigint>((total, value) => total + moneyOf(value), 0n);

/** The last step before a bar's length is drawn — never an amount that is added or compared again. */
export function chartNumber(decimal: string): number {
  return Number(moneyString(moneyOf(decimal)));
}

// ── Months ──────────────────────────────────────────────────────────────────

const isLeap = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const daysInMonth = (year: number, month: number): number =>
  [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;

export interface MonthWindow {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly from: string;
  readonly to: string;
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * The `months` calendar months ending with the month of `asOf`, oldest first.
 * The last window ends on `asOf` itself — a month in progress is not padded
 * with days that have not happened.
 */
export function monthWindows(asOf: string, months: number): MonthWindow[] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  if (!match) throw new RangeError(`'${asOf}' is not an ISO date.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const windows: MonthWindow[] = [];
  for (let back = months - 1; back >= 0; back -= 1) {
    const index = year * 12 + (month - 1) - back;
    const y = Math.floor(index / 12);
    const m = (index % 12) + 1;
    const last = back === 0 ? asOf : `${y}-${two(m)}-${two(daysInMonth(y, m))}`;
    windows.push({ month: `${y}-${two(m)}`, from: `${y}-${two(m)}-01`, to: last });
  }
  return windows;
}

/** The first day of the month of `asOf`. */
export const monthStart = (asOf: string): string => `${asOf.slice(0, 7)}-01`;

// ── Two series by month ─────────────────────────────────────────────────────

export interface MonthPair {
  readonly month: string;
  readonly first: string;
  readonly second: string;
}

/** Whether any point of a pair series is non-zero. */
export function hasActivity(points: readonly MonthPair[]): boolean {
  return points.some((point) => moneyOf(point.first) !== 0n || moneyOf(point.second) !== 0n);
}

/** The months with their figures as money strings at the ledger's scale, or null when every month is zero. */
export function pairSeries(points: readonly MonthPair[]): readonly MonthPair[] | null {
  if (!hasActivity(points)) return null;
  return points.map((point) => ({
    month: point.month,
    first: moneyString(moneyOf(point.first)),
    second: moneyString(moneyOf(point.second)),
  }));
}

// ── Ranked bars ─────────────────────────────────────────────────────────────

export interface NamedAmount {
  readonly key: string;
  readonly label: string;
  readonly amount: string;
}

/**
 * Largest first, positives only, at most `limit`. Ties keep the label order so
 * the same data always draws the same chart. A bar of zero is not a bar.
 */
export function rankedRows(rows: readonly NamedAmount[], limit: number): NamedAmount[] {
  return rows
    .map((row) => ({ row, value: moneyOf(row.amount) }))
    .filter((entry) => entry.value > 0n)
    .sort((a, b) => (a.value === b.value ? (a.row.label < b.row.label ? -1 : 1) : a.value > b.value ? -1 : 1))
    .slice(0, limit)
    .map((entry) => ({ key: entry.row.key, label: entry.row.label, amount: moneyString(entry.value) }));
}

/** Balances may be negative (an overdrawn account is a real figure): everything non-zero, largest magnitude first. */
export function balanceRows(rows: readonly NamedAmount[], limit: number): NamedAmount[] {
  return rows
    .map((row) => ({ row, value: moneyOf(row.amount) }))
    .filter((entry) => entry.value !== 0n)
    .sort((a, b) => {
      const x = a.value < 0n ? -a.value : a.value;
      const y = b.value < 0n ? -b.value : b.value;
      return x === y ? (a.row.label < b.row.label ? -1 : 1) : x > y ? -1 : 1;
    })
    .slice(0, limit)
    .map((entry) => ({ key: entry.row.key, label: entry.row.label, amount: moneyString(entry.value) }));
}

// ── Ageing ──────────────────────────────────────────────────────────────────

/** Which ramp step each bucket wears: the darkest always means ninety days and over. */
export const BUCKET_STEP: Readonly<Record<AgeingBucket, number>> = {
  current: 1,
  '1-30': 2,
  '31-60': 3,
  '61-90': 4,
  '90+': 5,
};

/** `home.value.bucket_<x>` — '90+' is not a message key, so the keys are named. */
export const BUCKET_WORD: Readonly<Record<AgeingBucket, string>> = {
  current: 'bucket_current',
  '1-30': 'bucket_1_30',
  '31-60': 'bucket_31_60',
  '61-90': 'bucket_61_90',
  '90+': 'bucket_over_90',
};

export interface AgeingLike {
  readonly buckets: readonly { readonly bucket: AgeingBucket; readonly amountIqd: string; readonly invoices: number }[];
}

/** The bands in the ageing report's order, each with its step; empty buckets are not drawn. */
export function ageingBands(ageing: AgeingLike) {
  return AGEING_BUCKETS.flatMap((bucket) => {
    const found = ageing.buckets.find((row) => row.bucket === bucket);
    if (!found || moneyOf(found.amountIqd) <= 0n) return [];
    return [
      {
        key: bucket as string,
        labelKey: BUCKET_WORD[bucket],
        value: moneyString(moneyOf(found.amountIqd)),
        step: BUCKET_STEP[bucket],
        count: found.invoices,
      },
    ];
  });
}
