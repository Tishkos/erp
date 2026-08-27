/**
 * Phase 02.2 test gate — soft close, as decidable rules.
 *
 * The override *record* and the §24 report are database facts and are proved in
 * tests/integration/phase02-periods-rates.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  FiscalCalendarError,
  NoPeriodForDateError,
  PeriodClosedError,
  PeriodOverrideReasonRequiredError,
  assertPeriodsAreContiguous,
  assertPostingAllowed,
  daysInMonth,
  findPeriodFor,
  generateMonthlyPeriods,
  isLeapYear,
  nextDay,
  periodCovers,
  type FiscalPeriod,
} from '@domain/periods';

const period = (overrides: Partial<FiscalPeriod> = {}): FiscalPeriod => ({
  id: 'p-1',
  fiscalYearCode: 'FY2026',
  periodNo: 8,
  name: 'August 2026',
  startsOn: '2026-08-01',
  endsOn: '2026-08-31',
  status: 'open',
  ...overrides,
});

describe('§14.6 · who may post into which period', () => {
  it('lets anyone with the permission post into an open period', () => {
    const permission = assertPostingAllowed(period(), { isFinanceManager: false });
    expect(permission.isOverride).toBe(false);
  });

  it('treats back-dating into an open period as ordinary, not exceptional', () => {
    // §14.6: "Posting dates earlier than the current date are allowed when the
    // period permits posting." An open period permits posting.
    const july = period({ name: 'July 2026', startsOn: '2026-07-01', endsOn: '2026-07-31' });
    const permission = assertPostingAllowed(july, { isFinanceManager: false });

    expect(permission.isOverride).toBe(false);
    expect(permission.overrideReason).toBeNull();
  });

  it('refuses an ordinary user posting into a soft-closed period', () => {
    expect(() =>
      assertPostingAllowed(period({ status: 'soft_closed' }), { isFinanceManager: false }),
    ).toThrow(PeriodClosedError);
    expect(() =>
      assertPostingAllowed(period({ status: 'soft_closed' }), { isFinanceManager: false }),
    ).toThrow(/Only a Finance Manager may post an approved adjustment/);
  });

  it('lets a Finance Manager post an approved adjustment, and marks it an override', () => {
    const permission = assertPostingAllowed(period({ status: 'soft_closed' }), {
      isFinanceManager: true,
      overrideReason: 'Audit adjustment AJ-12 approved by Finance',
    });

    expect(permission.isOverride).toBe(true);
    expect(permission.overrideReason).toBe('Audit adjustment AJ-12 approved by Finance');
  });

  it('refuses even a Finance Manager without a stated reason', () => {
    // The reason is what makes the override reviewable in the §24 report.
    expect(() =>
      assertPostingAllowed(period({ status: 'soft_closed' }), { isFinanceManager: true }),
    ).toThrow(PeriodOverrideReasonRequiredError);

    expect(() =>
      assertPostingAllowed(period({ status: 'soft_closed' }), {
        isFinanceManager: true,
        overrideReason: '   ',
      }),
    ).toThrow(PeriodOverrideReasonRequiredError);
  });

  it('refuses everyone on a closed period, Finance Manager included', () => {
    for (const isFinanceManager of [false, true]) {
      expect(() =>
        assertPostingAllowed(period({ status: 'closed' }), {
          isFinanceManager,
          overrideReason: 'Year-end tidy up',
        }),
      ).toThrow(/the period is closed/);
    }
  });
});

describe('finding the period for a date', () => {
  const periods = [
    period({ id: 'jul', name: 'July 2026', startsOn: '2026-07-01', endsOn: '2026-07-31' }),
    period({ id: 'aug' }),
  ];

  it('includes both boundary dates', () => {
    expect(periodCovers(periods[1]!, '2026-08-01')).toBe(true);
    expect(periodCovers(periods[1]!, '2026-08-31')).toBe(true);
    expect(periodCovers(periods[1]!, '2026-07-31')).toBe(false);
    expect(periodCovers(periods[1]!, '2026-09-01')).toBe(false);
  });

  it('resolves a date to exactly one period', () => {
    expect(findPeriodFor(periods, '2026-07-15')!.id).toBe('jul');
    expect(findPeriodFor(periods, '2026-08-15')!.id).toBe('aug');
  });

  it('returns nothing for a date the calendar does not cover', () => {
    expect(findPeriodFor(periods, '2027-01-01')).toBeNull();
  });

  it('names the date when there is no period for it', () => {
    expect(new NoPeriodForDateError('2027-01-01').message).toMatch(
      /No accounting period covers 2027-01-01/,
    );
  });
});

describe('generating a calendar', () => {
  const fy2026 = { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' };

  it('splits a calendar year into twelve months', () => {
    const periods = generateMonthlyPeriods(fy2026);

    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({
      periodNo: 1,
      name: 'January 2026',
      startsOn: '2026-01-01',
      endsOn: '2026-01-31',
    });
    expect(periods[11]).toMatchObject({
      periodNo: 12,
      name: 'December 2026',
      startsOn: '2026-12-01',
      endsOn: '2026-12-31',
    });
  });

  it('handles a fiscal year that does not start in January', () => {
    const periods = generateMonthlyPeriods({
      code: 'FY2026-27',
      startsOn: '2026-04-01',
      endsOn: '2027-03-31',
    });

    expect(periods).toHaveLength(12);
    expect(periods[0]!.name).toBe('April 2026');
    expect(periods[9]!.name).toBe('January 2027');
    expect(periods[11]!.endsOn).toBe('2027-03-31');
  });

  it('gets February right in a leap year', () => {
    const periods = generateMonthlyPeriods({
      code: 'FY2028',
      startsOn: '2028-01-01',
      endsOn: '2028-12-31',
    });
    expect(periods[1]!.endsOn).toBe('2028-02-29');
  });

  it('produces periods that tile the year with no gap or overlap', () => {
    const periods = generateMonthlyPeriods(fy2026);
    expect(() => assertPeriodsAreContiguous(periods, fy2026)).not.toThrow();
  });

  it('refuses a year that does not start on the first of a month', () => {
    expect(() =>
      generateMonthlyPeriods({ code: 'FY', startsOn: '2026-01-15', endsOn: '2026-12-31' }),
    ).toThrow(/must start on the first of a month/);
  });

  it('refuses a year that ends before it starts', () => {
    expect(() =>
      generateMonthlyPeriods({ code: 'FY', startsOn: '2026-01-01', endsOn: '2025-12-31' }),
    ).toThrow(FiscalCalendarError);
  });

  it('refuses a date that is not a calendar date', () => {
    // `new Date('2026-02-31')` silently becomes March. A fiscal calendar built
    // on silent corrections is a reconciliation problem waiting to happen.
    expect(() =>
      generateMonthlyPeriods({ code: 'FY', startsOn: '01/01/2026', endsOn: '2026-12-31' }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('detects a gap between periods', () => {
    const broken = [
      { periodNo: 1, name: 'January', startsOn: '2026-01-01', endsOn: '2026-01-30' },
      { periodNo: 2, name: 'February', startsOn: '2026-02-01', endsOn: '2026-12-31' },
    ];
    expect(() => assertPeriodsAreContiguous(broken, fy2026)).toThrow(/must be contiguous/);
  });
});

describe('date arithmetic the calendar depends on', () => {
  it('knows the length of every month', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 4)).toBe(30);
  });

  it('applies the century rule for leap years', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it('rolls over month and year ends', () => {
    expect(nextDay('2026-01-30')).toBe('2026-01-31');
    expect(nextDay('2026-01-31')).toBe('2026-02-01');
    expect(nextDay('2026-02-28')).toBe('2026-03-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
  });
});
