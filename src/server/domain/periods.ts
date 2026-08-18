/**
 * Fiscal calendar and period control — Phase 02.2.
 *
 * §14.6, verbatim:
 *
 *   "The accounting period model is Soft Close. Normal users cannot post to a
 *    Soft-Closed period. Authorised Finance Manager users can post approved
 *    adjustments to the period. Posting dates earlier than the current date are
 *    allowed when the period permits posting."
 *
 * Three sentences, three rules, and the third is the one teams usually get
 * wrong: back-dating is **not** an exception. A posting dated last week is an
 * ordinary posting if last week's period is open. What is exceptional is
 * posting into a period someone has closed — and that is an override, which is
 * permitted, recorded, and reportable (§24: "Period-lock override and
 * back-dated posting report").
 */

/**
 * §14.6 — soft close, plus the hard close that year-end applies (Phase 16).
 *
 *   open         anyone with the permission may post
 *   soft_closed  Finance Manager only, as an approved adjustment, recorded
 *   closed       nobody, by any route. Year-end has been run.
 */
export const PERIOD_STATUSES = ['open', 'soft_closed', 'closed'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export interface FiscalPeriod {
  readonly id: string;
  readonly fiscalYearCode: string;
  /** 1-based within the fiscal year. */
  readonly periodNo: number;
  readonly name: string;
  /** Inclusive. Business dates, never timestamps — TECHSTACK A10. */
  readonly startsOn: string;
  readonly endsOn: string;
  readonly status: PeriodStatus;
}

export class NoPeriodForDateError extends Error {
  readonly code = 'NO_FISCAL_PERIOD';

  constructor(readonly postingDate: string) {
    super(
      `No fiscal period covers ${postingDate}. The fiscal calendar must be extended before anything can be posted on that date.`,
    );
    this.name = 'NoPeriodForDateError';
  }
}

export class PeriodClosedError extends Error {
  readonly code = 'PERIOD_CLOSED';

  constructor(
    readonly period: FiscalPeriod,
    detail: string,
  ) {
    super(`Cannot post into ${period.name}: ${detail}`);
    this.name = 'PeriodClosedError';
  }
}

export class PeriodOverrideReasonRequiredError extends Error {
  readonly code = 'PERIOD_OVERRIDE_REASON_REQUIRED';

  constructor(readonly period: FiscalPeriod) {
    super(
      `Posting into soft-closed ${period.name} is an override and requires a stated reason, which is recorded and reported (§24).`,
    );
    this.name = 'PeriodOverrideReasonRequiredError';
  }
}

/** Who is posting, and under what authority. */
export interface PostingAuthority {
  /** §14.6 — only a Finance Manager may post into a soft-closed period. */
  readonly isFinanceManager: boolean;
  /**
   * The reason for posting into a soft-closed period. §14.6 calls these
   * "approved adjustments"; the reason is what makes the override reviewable.
   */
  readonly overrideReason?: string | null;
}

export interface PostingPermission {
  readonly period: FiscalPeriod;
  /** True when this posting is a §24 period-lock override and must be logged. */
  readonly isOverride: boolean;
  readonly overrideReason: string | null;
}

/** Simple inclusive date-in-range test on ISO date strings, which sort correctly. */
export function periodCovers(period: FiscalPeriod, date: string): boolean {
  return date >= period.startsOn && date <= period.endsOn;
}

export function findPeriodFor(
  periods: readonly FiscalPeriod[],
  postingDate: string,
): FiscalPeriod | null {
  return periods.find((period) => periodCovers(period, postingDate)) ?? null;
}

/**
 * The decision: may this posting date be used, and is doing so an override?
 *
 * Returning the override flag rather than silently allowing it is the whole
 * point — the caller must then record it, and §24's report is built from those
 * records.
 */
export function assertPostingAllowed(
  period: FiscalPeriod,
  authority: PostingAuthority,
): PostingPermission {
  if (period.status === 'closed') {
    throw new PeriodClosedError(
      period,
      'the period is closed. A closed period is final — the correction belongs in an open period (§3.2).',
    );
  }

  if (period.status === 'open') {
    // Includes back-dating: §14.6 permits an earlier posting date "when the
    // period permits posting", and an open period permits posting.
    return { period, isOverride: false, overrideReason: null };
  }

  // Soft-closed from here.
  if (!authority.isFinanceManager) {
    throw new PeriodClosedError(
      period,
      'the period is soft-closed. Only a Finance Manager may post an approved adjustment into it (§14.6).',
    );
  }

  if (!authority.overrideReason?.trim()) {
    throw new PeriodOverrideReasonRequiredError(period);
  }

  return { period, isOverride: true, overrideReason: authority.overrideReason.trim() };
}

// ---------------------------------------------------------------------------
// Building a calendar
// ---------------------------------------------------------------------------

export class FiscalCalendarError extends Error {
  readonly code = 'FISCAL_CALENDAR_INVALID';
  constructor(detail: string) {
    super(`Fiscal calendar is not usable: ${detail}`);
    this.name = 'FiscalCalendarError';
  }
}

export interface FiscalYearInput {
  readonly code: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

export interface GeneratedPeriod {
  readonly periodNo: number;
  readonly name: string;
  readonly startsOn: string;
  readonly endsOn: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertIsoDate(value: string, field: string): void {
  if (!ISO_DATE.test(value)) {
    throw new FiscalCalendarError(`${field} must be a calendar date as YYYY-MM-DD, received "${value}"`);
  }
}

/**
 * Splits a fiscal year into calendar months.
 *
 * Months, because every statutory and management report in Appendix D is
 * monthly or a roll-up of months. A company needing 13 periods or 4-4-5 gets a
 * different generator; the rest of the system only ever sees the periods table.
 *
 * Deliberately pure date arithmetic on strings: `new Date('2026-02-31')` does
 * not throw, it silently becomes March, and a fiscal calendar built on silent
 * corrections is a reconciliation problem waiting to happen.
 */
export function generateMonthlyPeriods(year: FiscalYearInput): GeneratedPeriod[] {
  assertIsoDate(year.startsOn, 'startsOn');
  assertIsoDate(year.endsOn, 'endsOn');

  if (year.endsOn <= year.startsOn) {
    throw new FiscalCalendarError(`${year.code} ends on or before it starts`);
  }

  const [startYear, startMonth, startDay] = year.startsOn.split('-').map(Number) as [
    number,
    number,
    number,
  ];

  if (startDay !== 1) {
    throw new FiscalCalendarError(
      `${year.code} starts on day ${startDay}. A monthly calendar must start on the first of a month.`,
    );
  }

  const periods: GeneratedPeriod[] = [];
  let cursorYear = startYear;
  let cursorMonth = startMonth;

  for (let periodNo = 1; periodNo <= 24; periodNo++) {
    const startsOn = `${pad4(cursorYear)}-${pad2(cursorMonth)}-01`;
    if (startsOn > year.endsOn) break;

    const endsOn = `${pad4(cursorYear)}-${pad2(cursorMonth)}-${pad2(daysInMonth(cursorYear, cursorMonth))}`;

    periods.push({
      periodNo,
      name: `${MONTH_NAMES[cursorMonth - 1]} ${cursorYear}`,
      startsOn,
      endsOn: endsOn > year.endsOn ? year.endsOn : endsOn,
    });

    if (endsOn >= year.endsOn) break;

    cursorMonth += 1;
    if (cursorMonth > 12) {
      cursorMonth = 1;
      cursorYear += 1;
    }
  }

  if (periods.length === 0) {
    throw new FiscalCalendarError(`${year.code} produced no periods`);
  }

  return periods;
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function pad4(value: number): string {
  return String(value).padStart(4, '0');
}

export function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1]!;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Periods must tile their year with no gap and no overlap. */
export function assertPeriodsAreContiguous(
  periods: readonly GeneratedPeriod[],
  year: FiscalYearInput,
): void {
  if (periods[0]!.startsOn !== year.startsOn) {
    throw new FiscalCalendarError(
      `the first period starts ${periods[0]!.startsOn} but ${year.code} starts ${year.startsOn}`,
    );
  }

  for (let i = 1; i < periods.length; i++) {
    const previous = periods[i - 1]!;
    const current = periods[i]!;
    if (nextDay(previous.endsOn) !== current.startsOn) {
      throw new FiscalCalendarError(
        `period ${current.periodNo} starts ${current.startsOn}, but period ${previous.periodNo} ends ${previous.endsOn} — periods must be contiguous`,
      );
    }
  }

  const last = periods[periods.length - 1]!;
  if (last.endsOn !== year.endsOn) {
    throw new FiscalCalendarError(
      `the last period ends ${last.endsOn} but ${year.code} ends ${year.endsOn}`,
    );
  }
}

export function nextDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  if (day < daysInMonth(year, month)) return `${pad4(year)}-${pad2(month)}-${pad2(day + 1)}`;
  if (month < 12) return `${pad4(year)}-${pad2(month + 1)}-01`;
  return `${pad4(year + 1)}-01-01`;
}
