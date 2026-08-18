/**
 * Phase 06.11 — Days Sales Outstanding, §22's KPI dictionary.
 *
 * The blueprint gives no formula: *"calculated from the approved management
 * formula and documented period basis."* So what is tested here is the formula
 * **D12 proposes**, and the tests are written so that swapping it is a small,
 * visible change rather than a hunt.
 */
import { describe, expect, it } from 'vitest';
import {
  canComputeDso,
  daysInPeriod,
  daysSalesOutstanding,
  daysSalesOutstandingCountback,
  formatDays,
  DsoUncomputableError,
} from '@domain/dso';
import { parseDecimal } from '@domain/money';

const iqd = (amount: string) => parseDecimal(amount, 4n);

describe('06.11 · DSO computes per the documented formula (§22, D12)', () => {
  it('counts both ends of the period', () => {
    // 1–31 January is 31 days, not 30.
    expect(daysInPeriod('2026-01-01', '2026-01-31')).toBe(31);
    expect(daysInPeriod('2026-01-01', '2026-01-01')).toBe(1);
  });

  it('is the classic formula: (A/R ÷ credit sales) × days', () => {
    // 100,000 owed against 200,000 of sales in a 30-day month = 15 days.
    expect(
      formatDays(
        daysSalesOutstanding({
          closingReceivableIqd: iqd('100000'),
          creditSalesIqd: iqd('200000'),
          from: '2026-04-01',
          to: '2026-04-30',
        }),
      ),
    ).toBe('15');
  });

  it('keeps the fraction — 45.5 days is not 45 or 46', () => {
    // 91,000 against 60,000 over 30 days = 45.5.
    expect(
      formatDays(
        daysSalesOutstanding({
          closingReceivableIqd: iqd('91000'),
          creditSalesIqd: iqd('60000'),
          from: '2026-04-01',
          to: '2026-04-30',
        }),
      ),
    ).toBe('45.5');
  });

  it('refuses a period with no credit sales rather than reporting zero', () => {
    // Zero days would say the company collects instantly, which is the opposite
    // of what an empty period means.
    expect(() =>
      daysSalesOutstanding({
        closingReceivableIqd: iqd('100000'),
        creditSalesIqd: 0n,
        from: '2026-04-01',
        to: '2026-04-30',
      }),
    ).toThrow(DsoUncomputableError);
  });

  it('refuses a backwards period', () => {
    expect(() =>
      daysSalesOutstanding({
        closingReceivableIqd: iqd('100000'),
        creditSalesIqd: iqd('200000'),
        from: '2026-04-30',
        to: '2026-04-01',
      }),
    ).toThrow(DsoUncomputableError);
  });

  it('refuses a negative receivable — customers in credit, not in debt', () => {
    expect(() =>
      daysSalesOutstanding({
        closingReceivableIqd: iqd('-5000'),
        creditSalesIqd: iqd('200000'),
        from: '2026-04-01',
        to: '2026-04-30',
      }),
    ).toThrow(DsoUncomputableError);
  });

  it('reports whether it can be computed, without throwing', () => {
    expect(
      canComputeDso({
        closingReceivableIqd: iqd('100000'),
        creditSalesIqd: iqd('200000'),
        from: '2026-04-01',
        to: '2026-04-30',
      }),
    ).toBe(true);

    expect(
      canComputeDso({
        closingReceivableIqd: iqd('100000'),
        creditSalesIqd: 0n,
        from: '2026-04-01',
        to: '2026-04-30',
      }),
    ).toBe(false);
  });

  it('explains itself when it cannot (§25)', () => {
    try {
      daysSalesOutstanding({
        closingReceivableIqd: iqd('100000'),
        creditSalesIqd: 0n,
        from: '2026-04-01',
        to: '2026-04-30',
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('no credit sales between 2026-04-01 and 2026-04-30');
    }
  });
});

describe('06.11 · the countback D12 offers as an alternative', () => {
  it('consumes the balance against the most recent months first', () => {
    // 150,000 owed. April sold 100,000 (30 days) — all still outstanding — and
    // March sold 100,000 (31 days), of which 50,000 is. So 30 days plus half of
    // March's 31 = 45.5 days.
    expect(
      formatDays(
        daysSalesOutstandingCountback({
          closingReceivableIqd: iqd('150000'),
          periods: [
            { creditSalesIqd: iqd('100000'), days: 30 },
            { creditSalesIqd: iqd('100000'), days: 31 },
          ],
        }),
      ),
    ).toBe('45.5');
  });

  it('gives a different answer from the classic formula on a lumpy month', () => {
    // A large sale on the last day of April: the classic formula divides by the
    // whole month's sales and understates; the countback follows the ageing.
    const components = {
      closingReceivableIqd: iqd('100000'),
      creditSalesIqd: iqd('100000'),
      from: '2026-04-01',
      to: '2026-04-30',
    };

    expect(formatDays(daysSalesOutstanding(components))).toBe('30');

    expect(
      formatDays(
        daysSalesOutstandingCountback({
          closingReceivableIqd: iqd('100000'),
          periods: [{ creditSalesIqd: iqd('100000'), days: 30 }],
        }),
      ),
    ).toBe('30');

    // …and they diverge once the balance spans more than one period.
    expect(
      formatDays(
        daysSalesOutstandingCountback({
          closingReceivableIqd: iqd('200000'),
          periods: [
            { creditSalesIqd: iqd('100000'), days: 30 },
            { creditSalesIqd: iqd('100000'), days: 31 },
          ],
        }),
      ),
    ).toBe('61');
  });

  it('refuses when the balance outruns the history supplied', () => {
    expect(() =>
      daysSalesOutstandingCountback({
        closingReceivableIqd: iqd('500000'),
        periods: [{ creditSalesIqd: iqd('100000'), days: 30 }],
      }),
    ).toThrow(DsoUncomputableError);
  });

  it('is zero for a company owed nothing', () => {
    expect(
      daysSalesOutstandingCountback({
        closingReceivableIqd: 0n,
        periods: [{ creditSalesIqd: iqd('100000'), days: 30 }],
      }),
    ).toBe(0n);
  });
});
