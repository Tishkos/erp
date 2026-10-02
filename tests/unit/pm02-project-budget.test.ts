/**
 * REQ-PM-001 Stage PM-2 — the planning and budget rules without a database:
 * what each document kind may carry, where an assignment stands against the
 * profile (exactly, not to two decimals), who may raise the stop line, and
 * how a plan spreads over months.
 */
import { describe, expect, it } from 'vitest';
import {
  assertRaisedStopLine,
  availabilityDecision,
  budgetDocumentTotal,
  monthsBetween,
  plannedThrough,
  spreadEvenly,
} from '@/server/domain/project-budget';
import { availabilityState } from '@/server/domain/project-system';

const line = (wbsCode: string, amount: bigint, costCode = 'MAT') => ({ wbsCode, costCode, amountIqd: amount });

describe('budget documents — the sign of each kind', () => {
  it('an original and a supplement add, a return takes, a transfer nets to zero between two elements', () => {
    expect(budgetDocumentTotal('original', [line('A', 10n), line('B', 5n)])).toBe(15n);
    expect(budgetDocumentTotal('supplement', [line('A', 10n)])).toBe(10n);
    expect(budgetDocumentTotal('return', [line('A', -10n)])).toBe(-10n);
    expect(budgetDocumentTotal('transfer', [line('A', -10n), line('B', 10n)])).toBe(0n);
    expect(() => budgetDocumentTotal('original', [line('A', -1n)])).toThrow(/an original budget adds budget/);
    expect(() => budgetDocumentTotal('supplement', [line('A', -1n)])).toThrow(/a supplement adds budget/);
    expect(() => budgetDocumentTotal('return', [line('A', 1n)])).toThrow(/a return takes budget/);
    expect(() => budgetDocumentTotal('transfer', [line('A', -10n), line('B', 9n)])).toThrow(/sum to zero/);
    expect(() => budgetDocumentTotal('transfer', [line('A', -10n), line('A', 10n, 'LAB')])).not.toThrow();
    expect(() => budgetDocumentTotal('transfer', [line('A', 0n), line('B', 0n)])).toThrow(/zero moves nothing/);
    expect(() => budgetDocumentTotal('supplement', [])).toThrow(/at least one line/);
    expect(() => budgetDocumentTotal('supplement', [line('A', 1n), line('A', 2n)])).toThrow(/appears twice/);
  });
});

describe('availability control — exact against the lines', () => {
  const profile = { warnPercent: 90, stopPercent: 100 };

  it('warns at the first line, once as it is crossed; stops a dinar over the second', () => {
    const budget = 1_000_000_0000n;
    expect(availabilityDecision(budget, 0n, 850_000_0000n, profile)).toMatchObject({ state: 'ok', crossedWarn: false, percentAfter: 85 });
    expect(availabilityDecision(budget, 850_000_0000n, 60_000_0000n, profile)).toMatchObject({ state: 'warn', crossedWarn: true, percentAfter: 91 });
    expect(availabilityDecision(budget, 910_000_0000n, 40_000_0000n, profile)).toMatchObject({ state: 'warn', crossedWarn: false, percentAfter: 95 });
    expect(availabilityDecision(budget, 950_000_0000n, 50_000_0000n, profile)).toMatchObject({ state: 'warn', percentAfter: 100, availableAfterIqd: 0n });
    // 1,000,000.0001 is over 100 % even though two decimals say 100.00.
    expect(availabilityDecision(budget, 1_000_000_0000n, 1n, profile).state).toBe('stop');
    expect(availabilityState(budget, 1_000_000_0001n, profile)).toBe('stop');
    expect(availabilityState(budget, 1_000_000_0000n, profile)).toBe('warn');
    expect(availabilityState(budget, 899_999_9999n, profile)).toBe('ok');
    expect(availabilityState(budget, 900_000_0000n, profile)).toBe('warn');
  });

  it('a raised stop line replaces the profile\'s for the element; no budget means nothing may be assigned', () => {
    const budget = 1_000_000_0000n;
    expect(availabilityDecision(budget, 1_000_000_0000n, 100_000_0000n, profile, 110)).toMatchObject({ state: 'warn', stopPercent: 110 });
    expect(availabilityDecision(budget, 1_000_000_0000n, 100_000_0001n, profile, 110).state).toBe('stop');
    expect(availabilityDecision(0n, 0n, 1n, profile)).toMatchObject({ state: 'stop', percentAfter: null });
    expect(availabilityDecision(0n, 0n, 0n, profile).state).toBe('ok');
    expect(availabilityDecision(budget, 0n, 0n, profile)).toMatchObject({ availableBeforeIqd: budget, availableAfterIqd: budget });
  });

  it('D-PM-5 — the project manager raises to 110 %, the accounting manager beyond, nobody above 200 %', () => {
    expect(() => assertRaisedStopLine(105, profile, false)).not.toThrow();
    expect(() => assertRaisedStopLine(110, profile, false)).not.toThrow();
    expect(() => assertRaisedStopLine(110.5, profile, false)).toThrow(/accounting manager raises/);
    expect(() => assertRaisedStopLine(150, profile, true)).not.toThrow();
    expect(() => assertRaisedStopLine(201, profile, true)).toThrow(/200 % at most/);
    expect(() => assertRaisedStopLine(100, profile, true)).toThrow(/above the profile/);
    expect(() => assertRaisedStopLine(Number.NaN, profile, true)).toThrow(/above the profile/);
  });
});

describe('the cost plan — months and the spread', () => {
  it('lists the months inclusive, across a year end, and refuses a plan that ends before it starts', () => {
    expect(monthsBetween('2026-10-15', '2027-01-03')).toEqual(['2026-10-01', '2026-11-01', '2026-12-01', '2027-01-01']);
    expect(monthsBetween('2026-10-01', '2026-10-31')).toEqual(['2026-10-01']);
    expect(() => monthsBetween('2026-11-01', '2026-10-01')).toThrow(/ends before it starts/);
    expect(() => monthsBetween('x', '2026-10-01')).toThrow(/is a date/);
  });

  it('spreads evenly with the remainder on the last month so the sum is exact', () => {
    const months = monthsBetween('2026-10-01', '2027-03-01');
    const spread = spreadEvenly(1_000_000_0000n, months);
    expect([...spread.values()].reduce((a, b) => a + b, 0n)).toBe(1_000_000_0000n);
    expect(spread.get('2026-10-01')).toBe(166_666_6666n);
    expect(spread.get('2027-03-01')).toBe(166_666_6670n);
    expect(() => spreadEvenly(1n, [])).toThrow(/at least one month/);
    expect(() => spreadEvenly(-1n, months)).toThrow(/not negative/);
    const lines = [...spread].map(([period, amountIqd]) => ({ period, amountIqd }));
    expect(plannedThrough(lines, '2026-12-15')).toBe(166_666_6666n * 3n);
    expect(plannedThrough(lines, '2027-03-01')).toBe(1_000_000_0000n);
    expect(plannedThrough(lines, '2026-09-30')).toBe(0n);
  });
});
