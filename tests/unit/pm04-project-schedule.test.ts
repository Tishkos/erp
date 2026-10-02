/**
 * REQ-PM-001 Stage PM-4 — the schedule and earned value without a database.
 *
 * The network below is worked by hand on a Sunday–Thursday week from
 * Sunday 4 October 2026, with Thursday 8 October a holiday:
 *
 *   A  Survey          3 days                          Sun 4 – Tue 6
 *   B  Foundations     5 days   FS A                   Wed 7, Sun 11 – Wed 14
 *   C  Order steel     2 days   SS A + 1               Mon 5 – Tue 6   (float)
 *   D  Steel frame     4 days   FS B, FS C             Thu 15, Sun 18 – Tue 20
 *   M  Frame complete  milestone FS D                  Tue 20
 *   E  Cladding        3 days   FS M                   Wed 21 – Sun 25
 *
 * Critical: A B D M E. C may slip until D's start: C finishes Tue 6 and D
 * needs it by Wed 14 — five working days of float (its latest run is
 * Tue 13 – Wed 14).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALENDAR,
  WorkingDays,
  earnedOf,
  earnedValue,
  isWorkingDay,
  nextWorkingDay,
  plannedValueAt,
  ratioText,
  schedule,
  topologicalOrder,
  type ScheduleDependency,
} from '@/server/domain/project-schedule';

const calendar = { workingDays: ['sun', 'mon', 'tue', 'wed', 'thu'], holidays: new Set(['2026-10-08']) };

const activities = [
  { code: 'A', durationDays: 3 },
  { code: 'B', durationDays: 5 },
  { code: 'C', durationDays: 2 },
  { code: 'D', durationDays: 4 },
  { code: 'M', durationDays: 0 },
  { code: 'E', durationDays: 3 },
];
const dependencies: ScheduleDependency[] = [
  { predecessor: 'A', successor: 'B', kind: 'FS', lagDays: 0 },
  { predecessor: 'A', successor: 'C', kind: 'SS', lagDays: 1 },
  { predecessor: 'B', successor: 'D', kind: 'FS', lagDays: 0 },
  { predecessor: 'C', successor: 'D', kind: 'FS', lagDays: 0 },
  { predecessor: 'D', successor: 'M', kind: 'FS', lagDays: 0 },
  { predecessor: 'M', successor: 'E', kind: 'FS', lagDays: 0 },
];

describe('the working calendar', () => {
  it('skips the weekend and the holidays', () => {
    expect(isWorkingDay('2026-10-04', calendar)).toBe(true); // Sunday
    expect(isWorkingDay('2026-10-08', calendar)).toBe(false); // holiday Thursday
    expect(isWorkingDay('2026-10-09', calendar)).toBe(false); // Friday
    expect(nextWorkingDay('2026-10-09', calendar)).toBe('2026-10-11');
    const days = new WorkingDays('2026-10-03', calendar); // a Saturday: day 0 is Sunday
    expect([0, 1, 2, 3, 4].map((i) => days.dateOf(i))).toEqual(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-11']);
    expect(days.indexOf('2026-10-09')).toBe(4);
    expect(DEFAULT_CALENDAR.workingDays).toEqual(['sun', 'mon', 'tue', 'wed', 'thu']);
  });
});

describe('PM8 · the critical-path pass', () => {
  it('gives every activity its earliest dates and float, and marks the critical path', () => {
    const result = schedule('2026-10-04', calendar, activities, dependencies);
    const by = Object.fromEntries(result.activities.map((a) => [a.code, a]));
    expect(by.A).toMatchObject({ earliestStart: '2026-10-04', earliestFinish: '2026-10-06', totalFloat: 0, critical: true });
    expect(by.B).toMatchObject({ earliestStart: '2026-10-07', earliestFinish: '2026-10-14', totalFloat: 0, critical: true });
    expect(by.C).toMatchObject({ earliestStart: '2026-10-05', earliestFinish: '2026-10-06', latestStart: '2026-10-13', latestFinish: '2026-10-14', totalFloat: 5, freeFloat: 5, critical: false });
    expect(by.D).toMatchObject({ earliestStart: '2026-10-15', earliestFinish: '2026-10-20', critical: true });
    expect(by.M).toMatchObject({ earliestStart: '2026-10-20', earliestFinish: '2026-10-20', totalFloat: 0, critical: true });
    expect(by.E).toMatchObject({ earliestStart: '2026-10-21', earliestFinish: '2026-10-25', critical: true });
    expect(result.finish).toBe('2026-10-25');
    expect(result.criticalPath).toEqual(['A', 'B', 'D', 'M', 'E']);
  });

  it('honours a lag, a not-before date and an actual start', () => {
    const lagged = schedule('2026-10-04', calendar, activities, dependencies.map((d) => (d.predecessor === 'B' ? { ...d, lagDays: 2 } : d)));
    expect(lagged.activities.find((a) => a.code === 'D')!.earliestStart).toBe('2026-10-19');
    const pinned = schedule('2026-10-04', calendar, [...activities.filter((a) => a.code !== 'C'), { code: 'C', durationDays: 2, notBefore: '2026-10-13' }], dependencies);
    // C now starts Tue 13 and finishes Wed 14 — exactly when D needs it: no float.
    expect(pinned.activities.find((a) => a.code === 'C')).toMatchObject({ earliestStart: '2026-10-13', totalFloat: 0, critical: true });
    const started = schedule('2026-10-04', calendar, [{ code: 'A', durationDays: 3, actualStart: '2026-10-05' }, ...activities.slice(1)], dependencies);
    expect(started.activities.find((a) => a.code === 'B')!.earliestStart).toBe('2026-10-11');
    // A date milestone not before a day stands at the end of that day.
    const dated = schedule('2026-10-04', calendar, [{ code: 'H', durationDays: 0, notBefore: '2026-10-07' }], []);
    expect(dated.activities[0]).toMatchObject({ earliestStart: '2026-10-07', earliestFinish: '2026-10-07' });
  });

  it('refuses a loop, an activity depending on itself and an unknown activity', () => {
    expect(() => topologicalOrder(['A', 'B', 'C'], [{ predecessor: 'A', successor: 'B', kind: 'FS', lagDays: 0 }, { predecessor: 'B', successor: 'C', kind: 'FS', lagDays: 0 }, { predecessor: 'C', successor: 'A', kind: 'SS', lagDays: 0 }])).toThrow(/loop through A, B, C/);
    expect(() => topologicalOrder(['A'], [{ predecessor: 'A', successor: 'A', kind: 'FS', lagDays: 0 }])).toThrow(/depend on itself/);
    expect(() => topologicalOrder(['A'], [{ predecessor: 'A', successor: 'Z', kind: 'FS', lagDays: 0 }])).toThrow(/not on the project/);
    expect(() => schedule('2026-10-04', calendar, [{ code: 'A', durationDays: 1.5 }], [])).toThrow(/whole number/);
  });
});

describe('PM9 · earned value', () => {
  it('follows §10: CPI, SPI, EAC and VAC from plan, earned and actual', () => {
    // Budget 1,000,000; planned to date 500,000; 40 % done → earned 400,000; spent 500,000.
    const budget = 1_000_000_0000n;
    const earned = earnedOf(budget, 40_0000n);
    expect(earned).toBe(400_000_0000n);
    const ev = earnedValue({ budgetIqd: budget, plannedIqd: 500_000_0000n, earnedIqd: earned, actualIqd: 500_000_0000n });
    expect(ev.cpi).toBe(8_000n);
    expect(ev.spi).toBe(8_000n);
    expect(ratioText(ev.cpi)).toBe('0.80');
    expect(ratioText(9_549n)).toBe('0.95');
    expect(ratioText(12_345n)).toBe('1.23');
    // EAC = 500,000 + 600,000 ÷ 0.8 = 1,250,000; VAC = −250,000.
    expect(ev.eacIqd).toBe(1_250_000_0000n);
    expect(ev.vacIqd).toBe(-250_000_0000n);
    expect(ev.costVarianceIqd).toBe(-100_000_0000n);
    expect(ev.scheduleVarianceIqd).toBe(-100_000_0000n);
    expect(ev.percentComplete).toBe(40);
  });

  it('with nothing spent the remaining work is taken at budget; without a plan SPI is undefined', () => {
    const ev = earnedValue({ budgetIqd: 1_000_0000n, plannedIqd: 0n, earnedIqd: 0n, actualIqd: 0n });
    expect(ev).toMatchObject({ cpi: null, spi: null, eacIqd: 1_000_0000n, vacIqd: 0n });
    expect(earnedValue({ budgetIqd: 0n, plannedIqd: 0n, earnedIqd: 0n, actualIqd: 5n }).percentComplete).toBeNull();
  });

  it('plans to a day: whole months before it, and its month in proportion', () => {
    const lines = [
      { period: '2026-09-01', amountIqd: 300_0000n },
      { period: '2026-10-01', amountIqd: 310_0000n },
      { period: '2026-11-01', amountIqd: 300_0000n },
    ];
    expect(plannedValueAt(lines, '2026-10-10')).toBe(300_0000n + 100_0000n);
    expect(plannedValueAt(lines, '2026-10-31')).toBe(610_0000n);
    expect(plannedValueAt(lines, '2026-08-31')).toBe(0n);
  });
});
