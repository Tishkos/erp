/**
 * Phase 11 — project rules, §10 and §19.
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertCloseable,
  assertNoWbsCycle,
  assertWithinBudget,
  assertWithinMeasuredProgress,
  budgetPosition,
  BudgetExceededError,
  CLOSEOUT_BLOCKERS,
  closeoutFindings,
  ProgressExceededError,
  progressBill,
  ProjectNotCloseableError,
  revisedPosition,
  WbsCycleError,
  type CloseoutState,
} from '@domain/projects';

const iqd = (whole: string) => BigInt(whole) * 10_000n;
const pct = (whole: string) => BigInt(whole) * 10_000n;

describe('§10 · the work breakdown structure is a tree', () => {
  const parents = new Map<string, string | null>([
    ['1', null],
    ['1.1', '1'],
    ['1.1.1', '1.1'],
    ['2', null],
  ]);

  it('accepts a root element', () => {
    expect(() => assertNoWbsCycle('3', null, parents)).not.toThrow();
  });

  it('accepts an ordinary child', () => {
    expect(() => assertNoWbsCycle('1.2', '1', parents)).not.toThrow();
  });

  it('refuses an element that is its own parent', () => {
    expect(() => assertNoWbsCycle('1', '1', parents)).toThrow(WbsCycleError);
  });

  it('refuses a move that would close a loop', () => {
    // Making 1 a child of its own grandchild.
    expect(() => assertNoWbsCycle('1', '1.1.1', parents)).toThrow(WbsCycleError);
  });

  it('says why it matters', () => {
    expect(() => assertNoWbsCycle('1', '1.1', parents)).toThrow(/roll-up .* would run forever|cycle/);
  });

  it('does not blame this move for a cycle that was already there', () => {
    const broken = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
    ]);
    expect(() => assertNoWbsCycle('new', 'a', broken)).not.toThrow();
  });
});

describe('§10 and §19 · the five budget amounts', () => {
  const amounts = {
    budgetIqd: iqd('100000'),
    revisionsIqd: iqd('20000'),
    committedIqd: iqd('30000'),
    actualIqd: iqd('45000'),
    forecastIqd: iqd('118000'),
  };

  it('revises the baseline by approved variations', () => {
    expect(budgetPosition(amounts).revisedIqd).toBe(iqd('120000'));
  });

  it('computes available as budget + revisions − commitments − actuals', () => {
    expect(budgetPosition(amounts).availableIqd).toBe(iqd('45000'));
  });

  it('keeps the forecast out of availability — an opinion is not spending room', () => {
    const optimistic = budgetPosition({ ...amounts, forecastIqd: iqd('1') });
    const pessimistic = budgetPosition({ ...amounts, forecastIqd: iqd('999999') });
    expect(optimistic.availableIqd).toBe(pessimistic.availableIqd);
  });

  it('keeps all five separately visible', () => {
    const position = budgetPosition(amounts);
    expect(position.budgetIqd).toBe(iqd('100000'));
    expect(position.committedIqd).toBe(iqd('30000'));
    expect(position.actualIqd).toBe(iqd('45000'));
    expect(position.forecastIqd).toBe(iqd('118000'));
    expect(position.availableIqd).toBe(iqd('45000'));
  });

  it('goes negative rather than clamping — an overspend is a fact', () => {
    const overspent = budgetPosition({ ...amounts, actualIqd: iqd('200000') });
    expect(overspent.availableIqd).toBeLessThan(0n);
  });

  it('refuses spending beyond what is available', () => {
    expect(() => assertWithinBudget('CC-01', budgetPosition(amounts), iqd('45001'))).toThrow(
      BudgetExceededError,
    );
  });

  it('accepts spending exactly to the line', () => {
    expect(() => assertWithinBudget('CC-01', budgetPosition(amounts), iqd('45000'))).not.toThrow();
  });

  it('names the two ways out rather than only refusing', () => {
    expect(() => assertWithinBudget('CC-01', budgetPosition(amounts), iqd('99999'))).toThrow(
      /Raise a variation .* or move the cost/,
    );
  });
});

describe('§10 · a certificate cannot exceed measured progress', () => {
  it('accepts a certificate within the measurement', () => {
    expect(() => assertWithinMeasuredProgress(pct('60'), pct('55'))).not.toThrow();
  });

  it('accepts one exactly at it', () => {
    expect(() => assertWithinMeasuredProgress(pct('60'), pct('60'))).not.toThrow();
  });

  it('refuses one beyond it', () => {
    expect(() => assertWithinMeasuredProgress(pct('60'), pct('61'))).toThrow(ProgressExceededError);
  });

  it('says what certifying beyond the measurement would mean', () => {
    expect(() => assertWithinMeasuredProgress(pct('10'), pct('90'))).toThrow(
      /bills for work nobody has said was done/,
    );
  });
});

describe('§10 criterion 4 · retention and advance recovery on a progress bill', () => {
  const terms = { retentionPercent: pct('5'), advanceRecoveryPercent: pct('20') };

  it('withholds retention and recovers the advance', () => {
    const bill = progressBill(iqd('100000'), terms, iqd('50000'));

    expect(bill.retentionIqd).toBe(iqd('5000'));
    expect(bill.advanceRecoveredIqd).toBe(iqd('20000'));
    expect(bill.netIqd).toBe(iqd('75000'));
  });

  it('never recovers more advance than is left', () => {
    const bill = progressBill(iqd('100000'), terms, iqd('3000'));

    expect(bill.advanceRecoveredIqd).toBe(iqd('3000'));
    expect(bill.netIqd).toBe(iqd('92000')); // 100,000 − 5,000 − 3,000
  });

  it('recovers nothing when no advance remains', () => {
    const bill = progressBill(iqd('100000'), terms, 0n);
    expect(bill.advanceRecoveredIqd).toBe(0n);
    expect(bill.netIqd).toBe(iqd('95000'));
  });

  it('returns the three figures separately, never netted', () => {
    // §10 keeps retention and advances in their own balances; a single net
    // number would have to be taken apart again by the ledger.
    const bill = progressBill(iqd('100000'), terms, iqd('50000'));
    expect(bill.grossIqd - bill.retentionIqd - bill.advanceRecoveredIqd).toBe(bill.netIqd);
  });

  it('handles terms of nothing', () => {
    const bill = progressBill(iqd('100000'), { retentionPercent: 0n, advanceRecoveryPercent: 0n }, iqd('50000'));
    expect(bill).toMatchObject({ retentionIqd: 0n, advanceRecoveredIqd: 0n, netIqd: iqd('100000') });
  });
});

describe('§10 criterion 3 · variations preserve the baseline', () => {
  const baseline = {
    contractValueIqd: iqd('1000000'),
    budgetIqd: iqd('800000'),
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
  };

  it('shows both the baseline and the revised figure', () => {
    const position = revisedPosition(baseline, [
      { contractDeltaIqd: iqd('150000'), budgetDeltaIqd: iqd('120000'), endsOn: '2027-03-31' },
    ]);

    expect(position.contractValueIqd).toBe(iqd('1000000'));
    expect(position.revisedContractValueIqd).toBe(iqd('1150000'));
    expect(position.budgetIqd).toBe(iqd('800000'));
    expect(position.revisedBudgetIqd).toBe(iqd('920000'));
    expect(position.endsOn).toBe('2026-12-31');
    expect(position.revisedEndsOn).toBe('2027-03-31');
  });

  it('accumulates several variations', () => {
    const position = revisedPosition(baseline, [
      { contractDeltaIqd: iqd('100000'), budgetDeltaIqd: iqd('80000') },
      { contractDeltaIqd: iqd('50000'), budgetDeltaIqd: iqd('40000') },
    ]);
    expect(position.revisedContractValueIqd).toBe(iqd('1150000'));
    expect(position.variations).toBe(2);
  });

  it('takes a reduction as readily as an increase', () => {
    const position = revisedPosition(baseline, [
      { contractDeltaIqd: -iqd('200000'), budgetDeltaIqd: -iqd('150000') },
    ]);
    expect(position.revisedContractValueIqd).toBe(iqd('800000'));
  });

  it('leaves the baseline alone when there are no variations', () => {
    const position = revisedPosition(baseline, []);
    expect(position.revisedContractValueIqd).toBe(position.contractValueIqd);
    expect(position.revisedEndsOn).toBe(position.endsOn);
  });
});

describe('§10 criterion 5 · closeout blocks on all five conditions', () => {
  const clean: CloseoutState = {
    openPurchaseOrders: 0,
    unreturnedStockItems: 0,
    unbilledCostIqd: 0n,
    unapprovedVariations: 0,
    advanceOutstandingIqd: 0n,
    retentionOutstandingIqd: 0n,
  };

  it('names all five', () => {
    expect(CLOSEOUT_BLOCKERS).toEqual([
      'open_purchase_orders',
      'unreturned_stock',
      'unbilled_costs',
      'unapproved_variations',
      'unresolved_advances_or_retention',
    ]);
  });

  it('lets a clean project close', () => {
    expect(closeoutFindings(clean)).toEqual([]);
    expect(() => assertCloseable('PRJ-1', clean)).not.toThrow();
  });

  it('blocks on each condition on its own', () => {
    const cases: [Partial<CloseoutState>, string][] = [
      [{ openPurchaseOrders: 1 }, 'open_purchase_orders'],
      [{ unreturnedStockItems: 3 }, 'unreturned_stock'],
      [{ unbilledCostIqd: iqd('1') }, 'unbilled_costs'],
      [{ unapprovedVariations: 2 }, 'unapproved_variations'],
      [{ advanceOutstandingIqd: iqd('5') }, 'unresolved_advances_or_retention'],
      [{ retentionOutstandingIqd: iqd('5') }, 'unresolved_advances_or_retention'],
    ];

    for (const [state, blocker] of cases) {
      const findings = closeoutFindings({ ...clean, ...state });
      expect(findings.map((f) => f.blocker)).toEqual([blocker]);
    }
  });

  it('reports every blocker at once, not the first', () => {
    const findings = closeoutFindings({
      openPurchaseOrders: 2,
      unreturnedStockItems: 1,
      unbilledCostIqd: iqd('500'),
      unapprovedVariations: 1,
      advanceOutstandingIqd: iqd('100'),
      retentionOutstandingIqd: iqd('50'),
    });
    expect(findings).toHaveLength(5);
  });

  it('throws with all of them listed', () => {
    let caught: unknown;
    try {
      assertCloseable('PRJ-1', { ...clean, openPurchaseOrders: 1, unapprovedVariations: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProjectNotCloseableError);
    expect((caught as ProjectNotCloseableError).findings).toHaveLength(2);
    expect((caught as Error).message).toMatch(/2 thing\(s\) are unresolved/);
  });
});
