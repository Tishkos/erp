/**
 * REQ-AP-001 §20.2 — the landed cost's arithmetic, decidable without a database.
 */
import { describe, expect, it } from 'vitest';
import { allocate, basisWeights, restate, spreadByWeights, valueOf } from '@domain/landed-cost';

const Q = 1_000_000n; // one unit of quantity
const U = 10_000n; // one IQD

describe('§20.2 · spreading a total', () => {
  it('in proportion, the last taking the remainder', () => {
    expect(spreadByWeights(100n * U, [1n, 1n, 1n])).toEqual([333_333n, 333_333n, 333_334n]);
    expect(spreadByWeights(150_000n * U, [500_000n * U, 500_000n * U])).toEqual([75_000n * U, 75_000n * U]);
    expect(() => spreadByWeights(1n, [0n, 0n])).toThrow(/every share is zero/);
  });

  it('by value, by quantity; weight and volume wait for the item master', () => {
    const layers = [
      { itemCode: 'A', originalQuantity: 10n * Q, unitCost: 1_000n * U },
      { itemCode: 'B', originalQuantity: 30n * Q, unitCost: 100n * U },
    ];
    expect(basisWeights('by_value', layers)).toEqual([10_000n * U, 3_000n * U]);
    expect(basisWeights('by_quantity', layers)).toEqual([10n * Q, 30n * Q]);
    expect(() => basisWeights('by_weight', layers)).toThrow(/not on the item master/);
  });

  it('manual: an amount per model, spread over its layers by quantity, and it must add up', () => {
    const layers = [
      { itemCode: 'A', originalQuantity: 10n * Q, unitCost: 1n },
      { itemCode: 'A', originalQuantity: 30n * Q, unitCost: 1n },
      { itemCode: 'B', originalQuantity: 5n * Q, unitCost: 1n },
    ];
    expect(allocate('manual', 500n * U, layers, new Map([['A', 400n * U], ['B', 100n * U]]))).toEqual([
      100n * U,
      300n * U,
      100n * U,
    ]);
    expect(() => allocate('manual', 500n * U, layers, new Map([['A', 400n * U]]))).toThrow(/add up to 400\.00 IQD/);
    expect(() => allocate('by_value', 1n, [])).toThrow(/no stock to land on/);
  });
});

describe('§20.2 · restating a layer', () => {
  it('what is on hand raises the unit cost; what has gone is returned for cost of sales', () => {
    // 50 received at 10,000; 40 left; 75,000 to land: 60,000 stays, 15,000 went.
    const result = restate({ originalQuantity: 50n * Q, remainingQuantity: 40n * Q, unitCost: 10_000n * U }, 75_000n * U);
    expect(result).toEqual({ inventoryIqd: 60_000n * U, goneIqd: 15_000n * U, unitCostAfter: 11_500n * U });
  });

  it('the inventory figure is exactly what the new unit cost adds; rounding falls to what has gone', () => {
    const layer = { originalQuantity: 3n * Q, remainingQuantity: 3n * Q, unitCost: 100n * U };
    const result = restate(layer, 100n * U);
    expect(result.unitCostAfter).toBe(133_3333n);
    expect(result.inventoryIqd).toBe(valueOf(3n * Q, 133_3333n) - valueOf(3n * Q, 100n * U));
    expect(result.inventoryIqd + result.goneIqd).toBe(100n * U);
    // An empty layer keeps nothing.
    expect(restate({ ...layer, remainingQuantity: 0n }, 5n * U)).toEqual({ inventoryIqd: 0n, goneIqd: 5n * U, unitCostAfter: 100n * U });
  });
});
