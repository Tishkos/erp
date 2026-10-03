/**
 * The browser's calendar step and the loan domain's are the same step.
 *
 * The new-loan form shows a date per instalment and reckons them while a
 * person types, so the arithmetic exists twice: `src/server/domain/loans.ts`
 * for the schedule that is stored, `src/lib/dates.ts` for the one on screen.
 * The form submits the dates it showed, so a drift between the two could not
 * corrupt a stored schedule — but it would show a person one date and store
 * another on the one path where the server still generates them (an untouched
 * monthly or quarterly schedule), and a form that lies about a due date is
 * not worth having.
 *
 * So they are held equal here, over the dates that break naive month
 * arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { addMonths as onScreen } from '@/lib/dates';
import { addMonths as inTheBooks } from '@/server/domain/loans';

const AWKWARD = [
  // The 31st into months that have no 31st.
  ['2026-01-31', 1],
  ['2026-01-31', 3],
  ['2026-03-31', 1],
  ['2026-08-31', 6],
  // February of a leap year, and of the year that is not one.
  ['2024-01-29', 1],
  ['2026-01-29', 1],
  ['2024-02-29', 12],
  // Across a year boundary, and well past one.
  ['2026-11-15', 2],
  ['2026-12-31', 1],
  ['2026-10-03', 36],
  // No step at all, which is the first instalment's case.
  ['2026-10-03', 0],
] as const;

describe('addMonths — the browser twin', () => {
  it.each(AWKWARD)('agrees with the domain on %s + %i months', (date, months) => {
    expect(onScreen(date, months)).toBe(inTheBooks(date, months));
  });

  it('agrees across three years of every month, every step a schedule uses', () => {
    // A quarterly schedule of twenty instalments steps 57 months out; monthly
    // ones step one at a time. Both, from every day of every month.
    for (let month = 1; month <= 12; month += 1) {
      for (const day of [1, 15, 28, 29, 30, 31]) {
        const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
        if (day > last) continue;
        const date = `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        for (const step of [1, 3]) {
          for (let instalment = 0; instalment < 20; instalment += 1) {
            const months = instalment * step;
            expect(onScreen(date, months)).toBe(inTheBooks(date, months));
          }
        }
      }
    }
  });
});
