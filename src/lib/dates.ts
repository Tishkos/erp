/**
 * Calendar steps for the browser — the twin of the loans domain's own.
 *
 * `src/server/domain/loans.ts` has `addMonths`, and it is the authority: a
 * schedule the server generates is generated there. But a form that shows a
 * person the due dates it is about to ask for has to work them out while they
 * type, before anything is submitted, and a client component in this codebase
 * does not import from `src/server` (nothing does — `src/lib/decimal.ts` is
 * the same arrangement for money).
 *
 * Twin, not an approximation: `tests/unit/loan-schedule-dates.test.ts` runs the
 * two over the awkward dates — the 31st into February, a leap year, a year
 * boundary — and fails if they ever disagree. Were they to drift, the form
 * would promise a date the loan did not keep.
 */

/**
 * `date` (YYYY-MM-DD) moved `months` forward, the day clamped to the month's
 * last: the 31st of January plus one month is the 28th or 29th of February,
 * which is what a bank's letter means by "monthly".
 */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
