/**
 * REQ-AP-001 §15.7 — the loan rules, decidable without a database.
 */
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  assertMove,
  assertScheduleRepays,
  buildSchedule,
  commissionOf,
  commissionShares,
  dueDates,
  instalmentState,
  netProceeds,
  percentOf,
  splitEvenly,
} from '@domain/loans';

const U = 10_000n; // one unit at the money scale

describe('§15.7 · commission and proceeds (A14)', () => {
  it('2 % of 1,000,000 is 20,000; deducted, 980,000 lands; otherwise the principal does', () => {
    const commission = commissionOf(1_000_000n * U, percentOf('2', 'Commission'));
    expect(commission).toBe(20_000n * U);
    expect(netProceeds(1_000_000n * U, commission, true)).toBe(980_000n * U);
    expect(netProceeds(1_000_000n * U, commission, false)).toBe(1_000_000n * U);
    // To the cent, half up: 0.75 % of 333,333.33 = 2,500.00 (2,499.999975).
    expect(commissionOf(33_333_333n * 100n, percentOf('0.75', 'Commission'))).toBe(2_500n * U);
  });

  it('reads a percentage, and refuses what is not one', () => {
    expect(percentOf('', 'x')).toBe(0n);
    expect(() => percentOf('two', 'A commission')).toThrow(/is not a percentage/);
    expect(() => percentOf('100', 'A commission')).toThrow(/is not a loan's/);
  });
});

describe('§15.7 · the schedule', () => {
  it('four quarters from 31 December, month ends kept', () => {
    expect(dueDates('2026-12-31', 4, 'quarterly')).toEqual(['2026-12-31', '2027-03-31', '2027-06-30', '2027-09-30']);
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
    expect(() => dueDates('2026-12-31', 2, 'custom', ['2026-12-31'])).toThrow(/names each of its 2 due dates/);
    expect(() => dueDates('x', 2, 'custom', ['2027-01-01', '2026-12-01'])).toThrow(/run forward/);
  });

  it('equal principal to the cent, the last absorbing the rounding', () => {
    expect(splitEvenly(1_000_000n * U, 3)).toEqual([33_333_333n * 100n, 33_333_333n * 100n, 33_333_334n * 100n]);
    const rows = buildSchedule({
      principal: 1_000_000n * U,
      commission: 20_000n * U,
      spreadCommission: false,
      interestPctPa: null,
      count: 4,
      frequency: 'quarterly',
      firstDueDate: '2026-12-31',
      startDate: '2026-09-30',
    });
    expect(rows.map((row) => row.total)).toEqual([250_000n * U, 250_000n * U, 250_000n * U, 250_000n * U]);
  });

  it('a spread commission rides on each instalment; interest runs on the declining balance', () => {
    const rows = buildSchedule({
      principal: 900_000n * U,
      commission: 9_000n * U,
      spreadCommission: true,
      interestPctPa: percentOf('12', 'Interest'),
      count: 3,
      frequency: 'monthly',
      firstDueDate: '2026-10-31',
      startDate: '2026-09-30',
    });
    expect(rows.map((row) => [row.principal, row.commission, row.interest])).toEqual([
      [300_000n * U, 3_000n * U, 91_726_000n], // 9,172.60 — 31 days
      [300_000n * U, 3_000n * U, 59_178_100n], // 5,917.81 — 30 days
      [300_000n * U, 3_000n * U, 30_575_300n], // 3,057.53 — 31 days
    ]);
  });

  it('a typed schedule must repay the principal exactly, forward in time', () => {
    const row = (dueDate: string, principal: bigint) => ({ dueDate, principal, commission: 0n, interest: 0n });
    expect(() => assertScheduleRepays('L', [row('2027-01-01', 400n * U), row('2027-02-01', 500n * U)], 1_000n * U, 0n)).toThrow(
      /short by 100\.00/,
    );
    expect(() => assertScheduleRepays('L', [row('2027-02-01', 500n * U), row('2027-01-01', 500n * U)], 1_000n * U, 0n)).toThrow(
      /run forward/,
    );
    expect(() => assertScheduleRepays('L', [row('2027-01-01', 1_000n * U)], 1_000n * U, 0n)).not.toThrow();
  });
});

describe('§15.7 · the commission share', () => {
  it('by amount used: 600,000 / 400,000 of 1,000,000 carry 12,000 / 8,000 (A14)', () => {
    const shares = commissionShares('by_amount_used', 20_000n * U, 1_000_000n * U, [
      { id: 'a', amount: 600_000n * U },
      { id: 'b', amount: 400_000n * U },
    ]);
    expect([shares.get('a'), shares.get('b')]).toEqual([12_000n * U, 8_000n * U]);
  });

  it('equally, the last absorbing; manual, never more than the commission', () => {
    const equal = commissionShares('equal', 10_000n * U, 1n, [
      { id: 'a', amount: 1n },
      { id: 'b', amount: 1n },
      { id: 'c', amount: 1n },
    ]);
    expect([...equal.values()]).toEqual([33_333_300n, 33_333_300n, 33_333_400n]); // 3,333.33 ×2 + 3,333.34
    expect(() =>
      commissionShares('manual', 100n * U, 1n, [
        { id: 'a', amount: 1n, manualShare: 60n * U },
        { id: 'b', amount: 1n, manualShare: 50n * U },
      ]),
    ).toThrow(/more than the 100\.00 commission/);
  });
});

describe('§15.7 · status and instalment state', () => {
  it('draft → approved → active → fully repaid; cancelled only before the money arrives', () => {
    expect(() => assertMove('L', 'draft', 'approved')).not.toThrow();
    expect(() => assertMove('L', 'approved', 'cancelled')).not.toThrow();
    expect(() => assertMove('L', 'active', 'cancelled')).toThrow(/repaid, not cancelled/);
    expect(() => assertMove('L', 'cancelled', 'approved')).toThrow(/cancelled/);
  });

  it('due inside the window, overdue after the due date, paid stays paid', () => {
    expect(instalmentState({ status: 'upcoming', dueDate: '2026-10-10' }, '2026-10-01', 7)).toBe('upcoming');
    expect(instalmentState({ status: 'upcoming', dueDate: '2026-10-08' }, '2026-10-01', 7)).toBe('due');
    expect(instalmentState({ status: 'due', dueDate: '2026-09-30' }, '2026-10-01', 7)).toBe('overdue');
    expect(instalmentState({ status: 'paid', dueDate: '2026-09-30' }, '2026-10-01', 7)).toBe('paid');
  });
});
