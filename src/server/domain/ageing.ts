/**
 * Ageing buckets — Phase 05.9, §15.
 *
 * Pure, because the rule is a date comparison and a date comparison is exactly
 * the kind of thing that goes quietly wrong: an off-by-one at the boundary puts
 * an invoice in the wrong column on the day it falls due, which is the day
 * somebody looks.
 *
 * Shared by the A/P ageing, the cash-requirement forecast and any screen that
 * colours a row, so all three agree about what "overdue" means.
 */

/** §15's buckets. The ones every A/P department already uses. */
export const AGEING_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** Whole days from `from` to `to`, both ISO dates (TECHSTACK A10 — never `Date`). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new RangeError(`'${from}' or '${to}' is not an ISO date.`);
  }
  return Math.round((b - a) / 86_400_000);
}

/**
 * Which bucket an open item falls in.
 *
 * Counted from the **due** date, not the invoice date: an invoice on 90-day
 * terms is not overdue on day 60, and an ageing that said otherwise would have
 * the A/P clerk chasing a supplier who is not late.
 *
 * The day it falls due is `current`, not `1-30`. Payment is due *by* that date,
 * so nothing is late until it has passed — the boundary the off-by-one lives on.
 */
export function bucketFor(dueDate: string, asOf: string): AgeingBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return '1-30';
  if (overdue <= 60) return '31-60';
  if (overdue <= 90) return '61-90';
  return '90+';
}

/** The forward view: what is about to be needed, rather than how late we are. */
export const FORECAST_HORIZONS = ['overdue', '0-30', '31-60', '61+'] as const;
export type ForecastHorizon = (typeof FORECAST_HORIZONS)[number];

export function horizonFor(dueDate: string, asOf: string): ForecastHorizon {
  const until = daysBetween(asOf, dueDate);
  if (until < 0) return 'overdue';
  if (until <= 30) return '0-30';
  if (until <= 60) return '31-60';
  return '61+';
}
