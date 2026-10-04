/**
 * IMPROVEMENT-002 — the final cost's arithmetic, decidable without a database
 * (`src/server/domain/final-cost.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  extendLineage,
  formatAmount,
  formatUnitChain,
  groupDepartures,
  landedUnitChain,
  reconcileLock,
  roundExactValue,
  exactValue,
  splitLargestRemainder,
  unitOf,
  unexplainedOf,
  type DepartureLine,
  type LineageEntry,
} from '@domain/final-cost';
import { parseDecimal } from '@domain/money';

const Q = 1_000_000n; // one unit of quantity
const U = 10_000n; // one IQD
const iqd = (value: string) => parseDecimal(value, 4n);
const sum = (parts: bigint[]) => parts.reduce((acc, part) => acc + part, 0n);

describe('largest remainder', () => {
  it('3,333.3333 split 6:3:1 is 2,000 / 1,000 / 333.3333, adding up exactly', () => {
    const parts = splitLargestRemainder(iqd('3333.3333'), [6n, 3n, 1n]);
    expect(parts).toEqual([iqd('2000'), iqd('1000'), iqd('333.3333')]);
    expect(sum(parts)).toBe(iqd('3333.3333'));
  });

  it('gives the left-over units to the largest fractions, never to the last part by default', () => {
    // 100 over 7:2:1 — exact 70 / 20 / 10.
    expect(splitLargestRemainder(100n, [7n, 2n, 1n])).toEqual([70n, 20n, 10n]);
    // 10 over 1:1:1 — exact 3.33 each: floors 3,3,3 → one unit left over, and
    // the tie among equal fractions goes to the earliest part.
    expect(splitLargestRemainder(10n, [1n, 1n, 1n])).toEqual([4n, 3n, 3n]);
    // 10 over 1:1:3 — exact 2 / 2 / 6: nothing left over, nothing moved.
    expect(splitLargestRemainder(10n, [1n, 1n, 3n])).toEqual([2n, 2n, 6n]);
    // 2 over 1:1:1 — ties again, earliest first, deterministically.
    expect(splitLargestRemainder(2n, [1n, 1n, 1n])).toEqual([1n, 1n, 0n]);
    expect(splitLargestRemainder(2n, [1n, 1n, 1n])).toEqual(splitLargestRemainder(2n, [1n, 1n, 1n]));
    // 1 over 1:2 — exact 0.33 / 0.67: the larger fraction takes it, not the last by position.
    expect(splitLargestRemainder(1n, [2n, 1n])).toEqual([1n, 0n]);
  });

  it('every part is within one unit of its exact share, and the parts always add up', () => {
    const weights = [123_457n, 1n, 98_765_432n, 0n, 5_555n, 777n];
    for (const total of [0n, 1n, 7n, 999_999n, iqd('150000'), iqd('1234567.8901')]) {
      const parts = splitLargestRemainder(total, weights);
      expect(sum(parts)).toBe(total);
      const whole = sum(weights);
      parts.forEach((part, index) => {
        const exactTimesWhole = total * weights[index]!;
        expect(part * whole - exactTimesWhole).toBeLessThan(whole);
        expect(exactTimesWhole - part * whole).toBeLessThan(whole);
      });
      expect(parts[3]).toBe(0n); // a zero weight gets nothing
    }
  });

  it('splits a negative whole as its absolute value, and refuses nothing to split over', () => {
    expect(splitLargestRemainder(-100n, [7n, 2n, 1n])).toEqual([-70n, -20n, -10n]);
    expect(sum(splitLargestRemainder(-10n, [1n, 1n, 1n]))).toBe(-10n);
    expect(splitLargestRemainder(0n, [0n, 0n])).toEqual([0n, 0n]);
    expect(() => splitLargestRemainder(1n, [0n, 0n])).toThrow(/every weight is zero/);
    expect(() => splitLargestRemainder(1n, [1n, -1n])).toThrow(/never negative/);
    expect(splitLargestRemainder(0n, [])).toEqual([]);
  });
});

describe('per unit, half up', () => {
  it('rounds half up at the money scale instead of flooring (A11)', () => {
    // 5,000 over 3 units: 1,666.66666… → 1,666.6667 (a floor would say 1,666.6666).
    expect(unitOf(iqd('5000'), 3n * Q)).toBe(iqd('1666.6667'));
    // 0.0001 over 2 units: 0.00005 → 0.0001 (half rounds up).
    expect(unitOf(1n, 2n * Q)).toBe(1n);
    // 0.0001 over 3 units: 0.0000333 → 0.
    expect(unitOf(1n, 3n * Q)).toBe(0n);
    // A fractional quantity: 10 over 0.5 units is 20 a unit.
    expect(unitOf(iqd('10'), Q / 2n)).toBe(iqd('20'));
    expect(unitOf(iqd('10'), 0n)).toBe(0n);
  });

  it('values a remaining quantity exactly and rounds once, as the Warehouses Report sums', () => {
    // 1.5 units at 0.0001 is 0.00015 each layer; two layers summed exactly then
    // rounded are 0.0003, where rounding each first would say 0.0004.
    const exact = exactValue(Q + Q / 2n, 1n) + exactValue(Q + Q / 2n, 1n);
    expect(roundExactValue(exact)).toBe(3n);
    expect(roundExactValue(exactValue(100n * Q, iqd('10050')))).toBe(iqd('1005000'));
  });
});

describe('the unit-cost chain', () => {
  it('cumulates the values, so the last link is the final unit cost and rounding never adds up', () => {
    // 100 received at 10,000; locks of 20,000 then 10,000.
    const chain = landedUnitChain(iqd('1000000'), 100n * Q, [iqd('20000'), iqd('10000')]);
    expect(chain).toEqual([iqd('10000'), iqd('10200'), iqd('10300')]);
    expect(formatUnitChain(chain)).toBe('10,000 → 10,200 → 10,300');
    // Three locks of 1 IQD over 3 units: per step 0.3333, but the chain is of
    // the totals — 1/3, 2/3, 3/3 — so it ends at exactly 1 more, not 0.9999.
    expect(landedUnitChain(iqd('30'), 3n * Q, [iqd('1'), iqd('1'), iqd('1')])).toEqual([
      iqd('10'),
      iqd('10.3333'),
      iqd('10.6667'),
      iqd('11'),
    ]);
    // A layer sold out before the lock still received the units it was given (A1):
    // 50 received at 10,000, 5,000 of charges → 100 a received unit.
    expect(landedUnitChain(iqd('500000'), 50n * Q, [iqd('5000')])).toEqual([iqd('10000'), iqd('10100')]);
  });

  it('formats a figure for reading: separators, only the places that say something', () => {
    expect(formatAmount(iqd('10050.5'))).toBe('10,050.5');
    expect(formatAmount(iqd('1234567.8901'))).toBe('1,234,567.8901');
    expect(formatAmount(iqd('-0.25'))).toBe('-0.25');
    expect(formatAmount(0n)).toBe('0');
    expect(formatUnitChain([iqd('999'), iqd('1000.1')])).toBe('999 → 1,000.1');
    expect(formatUnitChain([])).toBe('');
  });
});

describe('where the departed share went', () => {
  const line = (over: Partial<DepartureLine> & { id: string }): DepartureLine => ({
    kind: 'departure',
    movementKind: 'delivery',
    destinationRole: 'cogs',
    quantity: 10n * Q,
    amountIqd: iqd('1000'),
    returnsDepartureId: null,
    ...over,
  });

  it('groups by transaction and destination, with each return beside the departure it undoes', () => {
    const groups = groupDepartures([
      line({ id: 'sale-1' }),
      line({ id: 'issue-1', movementKind: 'project_issue', destinationRole: 'project_cost', quantity: 5n * Q, amountIqd: iqd('500') }),
      line({ id: 'sale-2', quantity: 2n * Q, amountIqd: iqd('200') }),
      line({ id: 'back-1', kind: 'return', movementKind: 'sales_return', quantity: -3n * Q, amountIqd: iqd('-300'), returnsDepartureId: 'sale-1' }),
      line({ id: 'round', kind: 'rounding', movementKind: null, quantity: 0n, amountIqd: 1n }),
    ]);
    expect(groups.map((group) => [group.movementKind, group.destinationRole])).toEqual([
      ['delivery', 'cogs'],
      ['project_issue', 'project_cost'],
      [null, 'cogs'],
    ]);
    const [sales, issues, rounding] = groups;
    expect(sales!.entries.map((entry) => [entry.departure?.id, entry.returns.map((r) => r.id)])).toEqual([
      ['sale-1', ['back-1']],
      ['sale-2', []],
    ]);
    expect([sales!.quantity, sales!.departedIqd, sales!.returnedIqd, sales!.netIqd]).toEqual([
      9n * Q,
      iqd('1200'),
      iqd('-300'),
      iqd('900'),
    ]);
    expect(issues!.netIqd).toBe(iqd('500'));
    expect([rounding!.departedIqd, rounding!.quantity]).toEqual([1n, 0n]);
    // Every dinar is in exactly one group.
    expect(sum(groups.map((group) => group.netIqd))).toBe(iqd('1000') + iqd('500') + iqd('200') - iqd('300') + 1n);
  });

  it('keeps a return whose departure is not in the set, on its own', () => {
    const [group] = groupDepartures([
      line({ id: 'back', kind: 'return', movementKind: 'sales_return', quantity: -1n * Q, amountIqd: iqd('-100'), returnsDepartureId: 'elsewhere' }),
    ]);
    expect(group!.entries).toEqual([{ departure: null, returns: [expect.objectContaining({ id: 'back' })] }]);
    expect(group!.netIqd).toBe(iqd('-100'));
  });
});

describe('reconciliation', () => {
  it('a lock is balanced when stock, departures and rounding are its total, exactly', () => {
    expect(
      reconcileLock({ totalIqd: iqd('150000'), inventoryIqd: iqd('135000'), departureIqd: iqd('14999.9999'), roundingIqd: 1n }),
    ).toEqual({ accountedIqd: iqd('150000'), differenceIqd: 0n, balanced: true });
    expect(
      reconcileLock({ totalIqd: iqd('150000'), inventoryIqd: iqd('135000'), departureIqd: iqd('14999.9999'), roundingIqd: 0n }),
    ).toEqual({ accountedIqd: iqd('149999.9999'), differenceIqd: 1n, balanced: false });
  });

  it('a lock written before 0280 is accounted for by its own record: the unattributed part is placed, not missing', () => {
    // 200,000 total: 150,000 restated into stock, 50,000 to cost of sales with no row behind it.
    const figures = { totalIqd: iqd('200000'), inventoryIqd: iqd('150000'), departureIqd: 0n, roundingIqd: 0n };
    expect(reconcileLock({ ...figures, unattributedIqd: iqd('50000') })).toEqual({
      accountedIqd: iqd('200000'),
      differenceIqd: 0n,
      balanced: true,
    });
    // Without it the same lock reads as 50,000 missing — what a reader must never be told of a lock that is whole.
    expect(reconcileLock(figures)).toEqual({ accountedIqd: iqd('150000'), differenceIqd: iqd('50000'), balanced: false });
    // The lock's record can still be wrong: the unattributed part counts, it does not forgive.
    expect(reconcileLock({ ...figures, unattributedIqd: iqd('49999.9999') })).toMatchObject({ differenceIqd: 1n, balanced: false });
  });

  it('the model identity leaves nothing unexplained when every flow is counted', () => {
    // 100 at 10,000; 30 sold at 10,000 before a 5,000 lock (1,500 departed);
    // 70 left at 10,050.
    expect(
      unexplainedOf({
        purchaseValueIqd: iqd('1000000'),
        chargesIqd: iqd('5000'),
        stockValueIqd: iqd('703500'),
        departedIqd: iqd('1500'),
        consumedIqd: iqd('300000'),
      }),
    ).toBe(0n);
  });
});

describe('lineage', () => {
  it('follows children to their root, keeps the first parent, and ends a loop', () => {
    const lineage = new Map<string, LineageEntry>([['R', { rootId: 'R', parentId: null, link: 'received', depth: 0 }]]);
    const first = extendLineage(lineage, [
      { childId: 'D1', parentId: 'R', link: 'origin_layer' },
      { childId: 'D1', parentId: 'R', link: 'lock_followed' },
      { childId: 'X', parentId: 'not-in-lineage', link: 'origin_layer' },
    ]);
    expect(first).toEqual(['D1']);
    expect(lineage.get('D1')).toEqual({ rootId: 'R', parentId: 'R', link: 'origin_layer', depth: 1 });
    const second = extendLineage(lineage, [
      { childId: 'S', parentId: 'D1', link: 'returned' },
      { childId: 'R', parentId: 'D1', link: 'moved' }, // a loop back to the root
    ]);
    expect(second).toEqual(['S']);
    expect(lineage.get('S')).toMatchObject({ rootId: 'R', depth: 2 });
    expect(lineage.get('R')).toMatchObject({ parentId: null, link: 'received' });
    expect(extendLineage(lineage, [])).toEqual([]);
  });
});
