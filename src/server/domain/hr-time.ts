/**
 * Time — REQ-HR-001 Stage HR-2 (§7, §8). Pure: no database, no clock.
 *
 * Days are counted in hundredths as bigints, like money: a half day is 50, a
 * year's thirty days 3000. Nothing here rounds through a float.
 *
 *   countLeave      the working days a span takes, half days at its ends,
 *                   split by year (a span over the new year draws on both)
 *   entitlementFor  a year's days for someone hired, or leaving, inside it
 *   balanceFor      carry-in + entitlement + adjustments − taken, year by
 *                   year from the hire year, the carry capped by the type
 *   dayStatus       what a day was: leave over the sheet over the calendar
 */
import { HrValidationError, workingDays, type Weekday } from './hr';

export const HUNDRED = 100n;

export interface Calendar {
  readonly workingDays: readonly Weekday[];
  readonly holidays: ReadonlySet<string>;
}

/** No calendar for the year: Sunday to Thursday, no holidays (as the Project System). */
export const DEFAULT_CALENDAR: Calendar = { workingDays: ['sun', 'mon', 'tue', 'wed', 'thu'], holidays: new Set() };

export function calendarOf(row: { workingDays: string; holidays: readonly string[] } | null | undefined): Calendar {
  if (!row) return DEFAULT_CALENDAR;
  return { workingDays: workingDays(row.workingDays), holidays: new Set(row.holidays) };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const WEEK: readonly Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const epoch = (day: string): number => {
  if (!ISO.test(day)) throw new HrValidationError('day', `"${day}" is not a day (YYYY-MM-DD)`);
  return Date.parse(`${day}T00:00:00Z`);
};
const isoOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const yearOf = (day: string): number => Number(day.slice(0, 4));

export function weekdayOf(day: string): Weekday {
  return WEEK.at(new Date(epoch(day)).getUTCDay())!;
}

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const start = epoch(from);
  const end = epoch(to);
  if (end < start) throw new HrValidationError('to_date', 'cannot be before the first day');
  const out: string[] = [];
  for (let at = start; at <= end; at += DAY_MS) out.push(isoOf(at));
  return out;
}

export type DayKind = 'working' | 'rest' | 'holiday';

export function dayKind(day: string, calendar: Calendar): DayKind {
  if (calendar.holidays.has(day)) return 'holiday';
  return calendar.workingDays.includes(weekdayOf(day)) ? 'working' : 'rest';
}

export interface LeaveSpan {
  readonly fromDate: string;
  readonly toDate: string;
  readonly halfDayStart?: boolean;
  readonly halfDayEnd?: boolean;
}

export interface CountedDay {
  readonly day: string;
  readonly kind: DayKind;
  /** Hundredths of a day taken: 100, 50 at a half end, 0 on a rest day or holiday. */
  readonly portion: bigint;
}

export interface LeaveCount {
  readonly total: bigint;
  readonly byYear: ReadonlyMap<number, bigint>;
  readonly days: readonly CountedDay[];
}

/**
 * The working days a leave takes (§7): rest days and holidays inside the span
 * are not taken. A half day at either end counts 50; a one-day span marked half
 * at either end is half a day.
 */
export function countLeave(span: LeaveSpan, calendarFor: (year: number) => Calendar): LeaveCount {
  const all = daysBetween(span.fromDate, span.toDate);
  const single = all.length === 1;
  const byYear = new Map<number, bigint>();
  let total = 0n;
  const days = all.map((day, index) => {
    const kind = dayKind(day, calendarFor(yearOf(day)));
    let portion = kind === 'working' ? HUNDRED : 0n;
    if (portion > 0n) {
      const halfHere = single ? Boolean(span.halfDayStart || span.halfDayEnd) : (index === 0 && span.halfDayStart) || (index === all.length - 1 && span.halfDayEnd);
      if (halfHere) portion = 50n;
    }
    total += portion;
    byYear.set(yearOf(day), (byYear.get(yearOf(day)) ?? 0n) + portion);
    return { day, kind, portion };
  });
  return { total, byYear, days };
}

/** Hundredths rounded to the nearest half day, a quarter rounding up. */
export function toHalfDays(hundredths: bigint): bigint {
  const negative = hundredths < 0n;
  const value = negative ? -hundredths : hundredths;
  const rounded = ((value + 25n) / 50n) * 50n;
  return negative ? -rounded : rounded;
}

/** The months a person counts inside a year: a start on or before the 15th counts its month, an end on or after the 15th counts its month. */
export function monthsServed(year: number, hireDate: string, endDate: string | null): number {
  const hireYear = yearOf(hireDate);
  if (hireYear > year) return 0;
  if (endDate && yearOf(endDate) < year) return 0;
  const firstMonth = hireYear < year ? 1 : Number(hireDate.slice(5, 7)) + (Number(hireDate.slice(8, 10)) <= 15 ? 0 : 1);
  const lastMonth = !endDate || yearOf(endDate) > year ? 12 : Number(endDate.slice(5, 7)) - (Number(endDate.slice(8, 10)) >= 15 ? 0 : 1);
  return Math.max(0, lastMonth - firstMonth + 1);
}

/**
 * A year's entitlement (§7): the type's days for a full year, the months
 * served for a year someone joined or left in, to the nearest half day.
 */
export function entitlementFor(year: number, daysPerYear: bigint, hireDate: string, endDate: string | null = null): bigint {
  const months = BigInt(monthsServed(year, hireDate, endDate));
  if (months === 12n) return daysPerYear;
  return toHalfDays((daysPerYear * months) / 12n);
}

export interface YearFacts {
  readonly year: number;
  /** Opening balances and adjustments of that year, signed. */
  readonly adjustments: bigint;
  /** Approved leave days that fell in that year. */
  readonly taken: bigint;
}

export interface Balance {
  readonly year: number;
  readonly carryIn: bigint;
  readonly entitlement: bigint;
  readonly adjustments: bigint;
  readonly taken: bigint;
  /** carryIn + entitlement + adjustments − taken. */
  readonly balance: bigint;
}

/**
 * The balance of one type in `year` (R2): each year from the hire year adds
 * its entitlement and adjustments and takes its leave; what is left carries
 * into the next, capped by the type's carry-over and never below zero (a
 * year that ended in debt does not borrow from the next).
 */
export function balanceFor(input: {
  readonly year: number;
  readonly hireDate: string;
  readonly endDate?: string | null;
  readonly daysPerYear: bigint;
  readonly carryOverDays: bigint;
  readonly facts: readonly YearFacts[];
}): Balance {
  const firstYear = Math.min(yearOf(input.hireDate), ...input.facts.map((f) => f.year), input.year);
  let carryIn = 0n;
  let result: Balance | null = null;
  for (let year = firstYear; year <= input.year; year += 1) {
    const fact = input.facts.find((f) => f.year === year);
    const entitlement = entitlementFor(year, input.daysPerYear, input.hireDate, input.endDate ?? null);
    const adjustments = fact?.adjustments ?? 0n;
    const taken = fact?.taken ?? 0n;
    const balance = carryIn + entitlement + adjustments - taken;
    result = { year, carryIn, entitlement, adjustments, taken, balance };
    const left = balance > 0n ? balance : 0n;
    carryIn = left < input.carryOverDays ? left : input.carryOverDays;
  }
  return result!;
}

/** A type with no days a year (unpaid leave) is not held to a balance. */
export const isBalanceLimited = (daysPerYear: bigint): boolean => daysPerYear > 0n;

/**
 * The refusal of §8: a request past what remains is refused with the balance
 * named, unless the type allows going below zero by so much (D-HR-6).
 */
export function assertWithinBalance(available: bigint, requested: bigint, allowedNegative: bigint, typeName: string): void {
  if (available - requested >= -allowedNegative) return;
  const room = available + allowedNegative;
  throw new HrValidationError(
    'days',
    `${showDays(requested)} days of ${typeName} asked, ${showDays(available)} remain` +
      (allowedNegative > 0n ? ` (and ${showDays(allowedNegative)} may be borrowed)` : '') +
      ` — at most ${showDays(room > 0n ? room : 0n)} can be granted`,
  );
}

/** "12", "12.5", "-3": days for people. */
export function showDays(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const value = negative ? -hundredths : hundredths;
  const whole = value / HUNDRED;
  const rest = value % HUNDRED;
  const text = rest === 0n ? `${whole}` : `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
  return negative ? `-${text}` : text;
}

/** "12.50" from the database to hundredths. */
export function daysFrom(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const text = String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) throw new HrValidationError('days', `"${text}" is not a number of days`);
  const hundredths = BigInt(match[2]!) * HUNDRED + BigInt((match[3] ?? '').padEnd(2, '0') || '0');
  return match[1] ? -hundredths : hundredths;
}

/** Hundredths back to the database's numeric(6,2). */
export function daysText(hundredths: bigint): string {
  const negative = hundredths < 0n;
  const value = negative ? -hundredths : hundredths;
  return `${negative ? '-' : ''}${value / HUNDRED}.${String(value % HUNDRED).padStart(2, '0')}`;
}

export type DayStatus = 'leave' | 'present' | 'absent' | 'holiday' | 'rest' | 'unrecorded';

/**
 * What a day was (B-HR-9): an approved leave over it wins — a sick note that
 * arrives late excuses the absence the sheet recorded — then what the sheet
 * recorded, then the calendar. A working day nobody recorded is said to be so.
 */
export function dayStatus(input: { readonly onLeave: boolean; readonly recorded: 'present' | 'absent' | null; readonly kind: DayKind }): DayStatus {
  if (input.onLeave && input.kind === 'working') return 'leave';
  if (input.recorded) return input.recorded;
  if (input.kind === 'holiday') return 'holiday';
  if (input.kind === 'rest') return 'rest';
  return 'unrecorded';
}

export const ATTENDANCE_STATUSES = ['present', 'absent'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const LEAVE_STATUSES = ['draft', 'submitted', 'approved', 'refused', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "08:30" or nothing; anything else is refused with the field named. */
export function timeOrNull(value: string | null | undefined, field: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!TIME.test(text)) throw new HrValidationError(field, `"${text}" is not a time (HH:MM)`);
  return text;
}
