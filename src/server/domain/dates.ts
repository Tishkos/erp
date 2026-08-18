/**
 * Calendar arithmetic — TECHSTACK A10.
 *
 * §24: "All dates distinguish document date, posting date, due date, tax date
 * if required, and system timestamps."
 *
 * Business dates are ISO strings, not `Date` objects, throughout this system.
 * `new Date('2026-02-31')` does not throw — it silently becomes 3 March — and a
 * due date computed from a silent correction is a payment made on the wrong
 * day. These functions work on the string and refuse what is not a date.
 *
 * ISO dates also sort and compare correctly as text, which is why every
 * period, rate and price lookup in the system is a string comparison.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class CalendarDateError extends Error {
  readonly code = 'CALENDAR_DATE_INVALID';
  constructor(value: string) {
    super(`"${value}" is not a calendar date. Expected YYYY-MM-DD.`);
    this.name = 'CalendarDateError';
  }
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1]!;
}

/** Parses and validates, so an impossible date is refused rather than shifted. */
export function parseDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(value.trim());
  if (!match) throw new CalendarDateError(value);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12) throw new CalendarDateError(value);
  if (day < 1 || day > daysInMonth(year, month)) throw new CalendarDateError(value);

  return { year, month, day };
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function nextDay(date: string): string {
  const { year, month, day } = parseDate(date);
  if (day < daysInMonth(year, month)) return format(year, month, day + 1);
  if (month < 12) return format(year, month + 1, 1);
  return format(year + 1, 1, 1);
}

/** Adds days. Negative values subtract. */
export function addDays(date: string, days: number): string {
  if (!Number.isInteger(days)) {
    throw new CalendarDateError(`${days} days is not a whole number of days`);
  }

  let { year, month, day } = parseDate(date);
  let remaining = days;

  while (remaining > 0) {
    const monthLength = daysInMonth(year, month);
    if (day + remaining <= monthLength) {
      day += remaining;
      remaining = 0;
    } else {
      remaining -= monthLength - day + 1;
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }

  while (remaining < 0) {
    if (day + remaining >= 1) {
      day += remaining;
      remaining = 0;
    } else {
      remaining += day;
      month -= 1;
      if (month < 1) {
        month = 12;
        year -= 1;
      }
      day = daysInMonth(year, month);
    }
  }

  return format(year, month, day);
}

/**
 * Adds months, clamping to the end of the target month.
 *
 * 31 January plus one month is 28 February, not 3 March. Payment terms stated
 * in months are common and this is the behaviour a person expects when they
 * read "60 days end of month".
 */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parseDate(date);
  const total = (year * 12 + (month - 1)) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = (total % 12) + 1;

  return format(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

export function endOfMonth(date: string): string {
  const { year, month } = parseDate(date);
  return format(year, month, daysInMonth(year, month));
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((toEpochDay(to) - toEpochDay(from)));
}

function toEpochDay(date: string): number {
  const { year, month, day } = parseDate(date);
  // Days since 1970-01-01, by the civil-from-days algorithm.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}
