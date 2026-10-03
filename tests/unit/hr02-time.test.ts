/**
 * REQ-HR-001 Stage HR-2 — time, the arithmetic (domain/hr-time.ts).
 *
 *   H3a  a span counts its working days only: rest days and public holidays
 *        inside it are not taken; half days at the ends; split by year
 *   H3b  entitlement by months served in the hire year and the leaving year,
 *        to the nearest half day
 *   H3c  the balance carries year to year, capped by the type, never a debt
 *   H3d  the refusal names what remains and what may be borrowed
 *   H3e  a day reads leave over the sheet over the calendar (B-HR-9)
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALENDAR,
  assertWithinBalance,
  balanceFor,
  calendarOf,
  countLeave,
  dayKind,
  dayStatus,
  daysFrom,
  daysText,
  entitlementFor,
  monthsServed,
  showDays,
  timeOrNull,
  toHalfDays,
  weekdayOf,
} from '@/server/domain/hr-time';

const IQ_2026 = calendarOf({ workingDays: 'sun,mon,tue,wed,thu', holidays: ['2026-10-03', '2026-12-25'] });
const iq = () => IQ_2026;
const d = (days: number) => BigInt(Math.round(days * 100));

describe('H3a · a span counts its working days', () => {
  it('knows the week: 2026-10-04 is a Sunday, Friday and Saturday rest', () => {
    expect(weekdayOf('2026-10-04')).toBe('sun');
    expect(dayKind('2026-10-09', DEFAULT_CALENDAR)).toBe('rest');
    expect(dayKind('2026-10-03', IQ_2026)).toBe('holiday');
    expect(dayKind('2026-10-05', IQ_2026)).toBe('working');
  });

  it('Thursday to the next Tuesday is four days: the weekend is not taken', () => {
    const count = countLeave({ fromDate: '2026-10-08', toDate: '2026-10-13' }, iq);
    expect(count.total).toBe(d(4));
    expect(count.days.map((x) => x.portion)).toEqual([100n, 0n, 0n, 100n, 100n, 100n]);
  });

  it('a holiday inside the span is given back, and a span of only rest days takes nothing', () => {
    // Sunday 20 to Sunday 27 December is six working days; a public holiday on Wednesday 23 gives one back.
    expect(countLeave({ fromDate: '2026-12-20', toDate: '2026-12-27' }, iq).total).toBe(d(6));
    const withHoliday = calendarOf({ workingDays: 'sun,mon,tue,wed,thu', holidays: ['2026-12-23'] });
    expect(countLeave({ fromDate: '2026-12-20', toDate: '2026-12-27' }, () => withHoliday).total).toBe(d(5));
    // Friday 2 and Saturday 3 October (National Day, a Saturday) take nothing.
    expect(countLeave({ fromDate: '2026-10-02', toDate: '2026-10-03' }, iq).total).toBe(0n);
  });

  it('half days at the ends, and a one-day span marked half is half a day', () => {
    expect(countLeave({ fromDate: '2026-10-05', toDate: '2026-10-07', halfDayStart: true, halfDayEnd: true }, iq).total).toBe(d(2));
    expect(countLeave({ fromDate: '2026-10-05', toDate: '2026-10-05', halfDayEnd: true }, iq).total).toBe(d(0.5));
    expect(countLeave({ fromDate: '2026-10-05', toDate: '2026-10-05', halfDayStart: true, halfDayEnd: true }, iq).total).toBe(d(0.5));
  });

  it('over the new year the days are split by the year they fall in', () => {
    const count = countLeave({ fromDate: '2026-12-29', toDate: '2027-01-05' }, (year) => (year === 2026 ? IQ_2026 : DEFAULT_CALENDAR));
    expect(count.byYear.get(2026)).toBe(d(3));
    expect(count.byYear.get(2027)).toBe(d(3));
  });
});

describe('H3b · entitlement by months served', () => {
  it('a full year is the type’s days; joining on the 10th counts the month, on the 20th does not', () => {
    expect(monthsServed(2026, '2020-05-01', null)).toBe(12);
    expect(monthsServed(2026, '2026-03-10', null)).toBe(10);
    expect(monthsServed(2026, '2026-03-20', null)).toBe(9);
    expect(entitlementFor(2026, d(30), '2026-03-10')).toBe(d(25));
    expect(entitlementFor(2026, d(30), '2026-03-20')).toBe(d(22.5));
  });

  it('a leaver counts to the month they leave in, from the 15th', () => {
    expect(monthsServed(2026, '2020-01-01', '2026-06-20')).toBe(6);
    expect(monthsServed(2026, '2020-01-01', '2026-06-10')).toBe(5);
    expect(entitlementFor(2026, d(30), '2020-01-01', '2026-06-20')).toBe(d(15));
    expect(entitlementFor(2027, d(30), '2020-01-01', '2026-06-20')).toBe(0n);
    expect(entitlementFor(2025, d(30), '2026-03-10')).toBe(0n);
  });

  it('rounds to the nearest half day, a quarter up', () => {
    expect(toHalfDays(d(4.17))).toBe(d(4));
    expect(toHalfDays(d(4.25))).toBe(d(4.5));
    expect(toHalfDays(d(-4.25))).toBe(d(-4.5));
  });
});

describe('H3c · the balance carries, capped, never a debt', () => {
  const base = { hireDate: '2024-01-01', daysPerYear: d(30), carryOverDays: d(10) } as const;

  it('2024: 30 less 12 taken leaves 18; 10 carry into 2025; 2025: 10 + 30 + 2 adjusted − 5 = 37', () => {
    const facts = [
      { year: 2024, taken: d(12), adjustments: 0n },
      { year: 2025, taken: d(5), adjustments: d(2) },
    ];
    expect(balanceFor({ ...base, year: 2024, facts })).toMatchObject({ carryIn: 0n, entitlement: d(30), taken: d(12), balance: d(18) });
    expect(balanceFor({ ...base, year: 2025, facts })).toMatchObject({ carryIn: d(10), adjustments: d(2), balance: d(37) });
    // 2026 carries the cap again, not the 37.
    expect(balanceFor({ ...base, year: 2026, facts })).toMatchObject({ carryIn: d(10), balance: d(40) });
  });

  it('a year that ended below zero carries nothing, and borrows nothing from the next', () => {
    const facts = [{ year: 2024, taken: d(33), adjustments: 0n }];
    expect(balanceFor({ ...base, year: 2024, facts }).balance).toBe(d(-3));
    expect(balanceFor({ ...base, year: 2025, facts })).toMatchObject({ carryIn: 0n, balance: d(30) });
  });

  it('an opening balance at migration is a dated credit (R2)', () => {
    const facts = [{ year: 2026, taken: 0n, adjustments: d(7.5) }];
    expect(balanceFor({ ...base, hireDate: '2019-06-01', year: 2026, facts }).balance).toBe(d(10 + 30 + 7.5));
  });
});

describe('H3d · the refusal names the balance', () => {
  it('within the balance passes; past it is refused with what remains', () => {
    expect(() => assertWithinBalance(d(5), d(5), 0n, 'Annual leave')).not.toThrow();
    expect(() => assertWithinBalance(d(5), d(6), 0n, 'Annual leave')).toThrow(/6 days of Annual leave asked, 5 remain — at most 5 can be granted/);
  });

  it('a type that may go below zero (sick, five days) lends up to that', () => {
    expect(() => assertWithinBalance(d(2), d(7), d(5), 'Sick leave')).not.toThrow();
    expect(() => assertWithinBalance(d(2), d(7.5), d(5), 'Sick leave')).toThrow(/and 5 may be borrowed\) — at most 7 can be granted/);
  });
});

describe('H3e · what a day was', () => {
  it('leave over the sheet over the calendar; a working day nobody recorded says so', () => {
    expect(dayStatus({ onLeave: true, recorded: 'absent', kind: 'working' })).toBe('leave');
    expect(dayStatus({ onLeave: true, recorded: null, kind: 'holiday' })).toBe('holiday');
    expect(dayStatus({ onLeave: false, recorded: 'present', kind: 'rest' })).toBe('present');
    expect(dayStatus({ onLeave: false, recorded: null, kind: 'rest' })).toBe('rest');
    expect(dayStatus({ onLeave: false, recorded: null, kind: 'working' })).toBe('unrecorded');
  });
});

describe('the numbers in and out', () => {
  it('days round-trip through numeric(6,2) and print for people', () => {
    expect(daysFrom('12.50')).toBe(1250n);
    expect(daysFrom('-3')).toBe(-300n);
    expect(daysText(1250n)).toBe('12.50');
    expect(daysText(-50n)).toBe('-0.50');
    expect(showDays(1250n)).toBe('12.5');
    expect(showDays(1225n)).toBe('12.25');
    expect(showDays(-300n)).toBe('-3');
  });

  it('times are HH:MM or nothing', () => {
    expect(timeOrNull(' 08:30 ', 'check_in')).toBe('08:30');
    expect(timeOrNull('', 'check_in')).toBeNull();
    expect(() => timeOrNull('8.30', 'check_in')).toThrow(/is not a time/);
  });
});
