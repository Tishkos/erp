/**
 * REQ-PM-001 Stage PM-6 — the labour rate, the month and the close findings, worked by hand.
 */
import { describe, expect, it } from 'vitest';
import { hourlyRate, labourAmount, monthBounds, pmCloseFindings, settlementKindOf, workingDaysIn } from '@/server/domain/project-close';
import { DEFAULT_CALENDAR } from '@/server/domain/project-schedule';
import { parseDecimal } from '@/server/domain/money';

const iqd = (v: string) => parseDecimal(v, 4n);
const hours = (v: string) => parseDecimal(v, 2n);

describe('D-PM-8 — labour at the base salary ÷ working days ÷ 8', () => {
  it('counts the working days of a month in the calendar', () => {
    // September 2026 starts on a Tuesday: 30 days less 4 Fridays and 4 Saturdays.
    expect(workingDaysIn('2026-09', DEFAULT_CALENDAR)).toBe(22);
    // February 2026: 28 days, 4 Fridays and 4 Saturdays.
    expect(workingDaysIn('2026-02', DEFAULT_CALENDAR)).toBe(20);
    // A holiday on a working day takes it out; one on a Friday changes nothing.
    expect(workingDaysIn('2026-09', { ...DEFAULT_CALENDAR, holidays: new Set(['2026-09-01', '2026-09-04']) })).toBe(21);
    expect(monthBounds('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' });
    expect(() => monthBounds('2026-13')).toThrow(/not a month/);
  });

  it('rates the hour half up to four decimals, and the hours at it', () => {
    expect(hourlyRate(iqd('2200000'), 22)).toBe(iqd('12500'));
    // 1,000,000 ÷ 176 = 5,681.818181… → 5,681.8182.
    expect(hourlyRate(iqd('1000000'), 22)).toBe(iqd('5681.8182'));
    expect(labourAmount(hours('7.5'), iqd('12500'))).toBe(iqd('93750'));
    expect(labourAmount(hours('0.25'), iqd('5681.8182'))).toBe(iqd('1420.4546'));
    expect(() => hourlyRate(iqd('1'), 0)).toThrow(/no working day/);
  });
});

describe('§12 — settlement and close', () => {
  it('an investment project settles to the asset; the rest to the result', () => {
    expect(settlementKindOf('investment')).toBe('asset');
    expect(settlementKindOf('customer')).toBe('result');
    expect(settlementKindOf('internal')).toBe('result');
  });

  it('names what stands between the project and its close', () => {
    expect(pmCloseFindings({ openActivities: [], openBillingLines: 0, draftCertificates: 0, unpostedTimesheets: 0, settlementPosted: true })).toEqual([]);
    expect(pmCloseFindings({ openActivities: ['A0010'], openBillingLines: 1, draftCertificates: 2, unpostedTimesheets: 3, settlementPosted: false }).map((f) => f.blocker)).toEqual([
      'open_activities',
      'open_billing_lines',
      'draft_certificates',
      'unposted_timesheets',
      'settlement_not_posted',
    ]);
  });
});
