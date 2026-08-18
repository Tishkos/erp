/**
 * Phase 04.1 and 04.4 test gate — availability and the negative-stock rule.
 *
 * The 04.1 gate asks for the Available formula to be "verified against a
 * hand-computed dataset". That dataset is below, worked in the comments, so a
 * reviewer can check the arithmetic without running anything.
 */
import { describe, expect, it } from 'vitest';
import {
  AVAILABILITY_BUCKETS,
  EMPTY_POSITION,
  NegativeStockError,
  aggregate,
  assertCanIssue,
  assertCanReserve,
  availabilityOf,
  availableQuantity,
  type StockPosition,
} from '@domain/inventory';
import { formatQuantity, parseQuantity } from '@domain/uom';

const qty = (units: string) => parseQuantity(units);

const position = (overrides: Partial<StockPosition> = {}): StockPosition => ({
  itemCode: 'ITM-1',
  warehouseCode: 'WH-1',
  branchCode: 'BGW',
  ...EMPTY_POSITION,
  ...overrides,
});

describe('§9.5 · the nine buckets', () => {
  it('is exactly the list the blueprint names', () => {
    expect([...AVAILABILITY_BUCKETS]).toEqual([
      'on_hand',
      'available',
      'reserved',
      'in_transit',
      'in_quarantine',
      'damaged',
      'returns_stock',
      'ordered_from_suppliers',
      'committed_to_customers',
    ]);
  });

  it('reports every bucket, so a screen cannot silently omit one', () => {
    const buckets = availabilityOf(position({ onHand: qty('10') }));
    for (const name of AVAILABILITY_BUCKETS) {
      expect(buckets, name).toHaveProperty(name);
    }
  });
});

describe('04.1 gate · Available = On Hand − Reserved − Quarantine − Damaged', () => {
  /**
   * The hand-computed dataset — a company-level total, which is where all the
   * buckets appear together. §9.1's warehouse types mean a single warehouse
   * position has at most one of quarantine, damaged and returns non-zero; the
   * sum across warehouses is what a stock report shows.
   *
   *   On Hand        500   across every warehouse
   *   Reserved       120   promised to customer orders
   *   Quarantine      60   received, not yet inspected  (§8.4)
   *   Damaged         25   written down, not saleable   (§9.8)
   *   Returns stock   40   back from a customer, not yet dispositioned
   *   In transit      75   left one warehouse, not arrived at the next
   *
   *   Available = 500 − 120 − 60 − 25 − 40 = 255
   */
  const dataset = position({
    onHand: qty('500'),
    reserved: qty('120'),
    inQuarantine: qty('60'),
    damaged: qty('25'),
    returnsStock: qty('40'),
    inTransit: qty('75'),
  });

  it('computes 255 from the hand-worked figures', () => {
    expect(formatQuantity(availableQuantity(dataset))).toBe('255');
  });

  it('excludes quarantine stock (§8.4 — unavailable for sale)', () => {
    const withoutQuarantine = { ...dataset, inQuarantine: 0n };
    expect(availableQuantity(withoutQuarantine) - availableQuantity(dataset)).toBe(qty('60'));
  });

  it('excludes damaged stock (§9.8)', () => {
    const withoutDamage = { ...dataset, damaged: 0n };
    expect(availableQuantity(withoutDamage) - availableQuantity(dataset)).toBe(qty('25'));
  });

  it('excludes returns stock, which is not saleable until it is dispositioned', () => {
    // Returned goods sit in a returns warehouse (§9.1) until someone decides
    // whether they go back to stores, to quarantine or to damaged. Counting
    // them as available would let one be sold before that decision.
    const withoutReturns = { ...dataset, returnsStock: 0n };
    expect(availableQuantity(withoutReturns) - availableQuantity(dataset)).toBe(qty('40'));
  });

  it('does not subtract in-transit, which is not on hand here at all', () => {
    const withoutTransit = { ...dataset, inTransit: 0n };
    expect(availableQuantity(withoutTransit)).toBe(availableQuantity(dataset));
  });

  it('reports zero rather than a negative when everything is spoken for', () => {
    const spokenFor = position({ onHand: qty('10'), reserved: qty('10') });
    expect(availableQuantity(spokenFor)).toBe(0n);
  });
});

describe('04.1 gate · in-transit is available at neither end', () => {
  it('is not available at the source, because it has left', () => {
    const source = position({ warehouseCode: 'WH-SRC', onHand: 0n, inTransit: qty('75') });
    expect(availableQuantity(source)).toBe(0n);
  });

  it('is not available at the destination, because it has not arrived', () => {
    const destination = position({ warehouseCode: 'WH-DST', onHand: 0n, inTransit: qty('75') });
    expect(availableQuantity(destination)).toBe(0n);
    expect(availabilityOf(destination).in_transit).toBe(qty('75'));
  });

  it('is still visible as in-transit, so it is not lost from view (§9.9)', () => {
    const source = position({ inTransit: qty('75') });
    expect(availabilityOf(source).in_transit).toBe(qty('75'));
  });
});

describe('04.1 gate · consolidated equals the sum of the branches', () => {
  const positions: StockPosition[] = [
    position({ warehouseCode: 'WH-A', branchCode: 'BGW', onHand: qty('100'), reserved: qty('10') }),
    position({ warehouseCode: 'WH-B', branchCode: 'BGW', onHand: qty('50'), damaged: qty('5') }),
    position({ warehouseCode: 'WH-C', branchCode: 'EBL', onHand: qty('200'), inQuarantine: qty('20') }),
  ];

  it('sums warehouses into branches', () => {
    const branches = aggregate(positions, 'branch');
    const baghdad = branches.find((p) => p.branchCode === 'BGW');
    const erbil = branches.find((p) => p.branchCode === 'EBL');

    expect(baghdad?.onHand).toBe(qty('150'));
    expect(erbil?.onHand).toBe(qty('200'));
  });

  it('sums branches into the company, exactly', () => {
    const branches = aggregate(positions, 'branch');
    const company = aggregate(positions, 'company');

    const branchTotal = branches.reduce((sum, p) => sum + p.onHand, 0n);
    expect(company[0]!.onHand).toBe(branchTotal);
    expect(company[0]!.onHand).toBe(qty('350'));
  });

  it('keeps Available consistent at every level', () => {
    // 100−10 + 50−5 + 200−20 = 90 + 45 + 180 = 315
    const company = aggregate(positions, 'company');
    expect(availableQuantity(company[0]!)).toBe(qty('315'));

    const perWarehouse = positions.reduce((sum, p) => sum + availableQuantity(p), 0n);
    expect(perWarehouse).toBe(availableQuantity(company[0]!));
  });

  it('does not label a total with one of the codes it summed away', () => {
    // A company figure carrying "BGW" reads as Baghdad's figure.
    const company = aggregate(positions, 'company');
    expect(company[0]!.branchCode).toBe('');
    expect(company[0]!.warehouseCode).toBe('');
  });
});

describe('04.4 gate · negative inventory is prohibited without exception', () => {
  const stock = position({ onHand: qty('100'), reserved: qty('30') });

  it('permits an issue within Available', () => {
    expect(() => assertCanIssue(stock, qty('70'))).not.toThrow();
  });

  it('refuses an issue one unit beyond Available', () => {
    // Available is 70, not the 100 on hand — reserved stock is promised.
    expect(() => assertCanIssue(stock, qty('70.000001'))).toThrow(NegativeStockError);
  });

  it('names the figures, so the user does not have to go and look', () => {
    try {
      assertCanIssue(stock, qty('80'));
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/80 of ITM-1 from WH-1/);
      expect(message).toMatch(/70 is available/);
      // §25 — the corrective action.
      expect(message).toMatch(/Reduce the quantity, receive stock first/);
    }
  });

  it('refuses an issue of zero or a negative quantity', () => {
    expect(() => assertCanIssue(stock, 0n)).toThrow(NegativeStockError);
    expect(() => assertCanIssue(stock, -qty('1'))).toThrow(NegativeStockError);
  });

  it('refuses to reserve damaged stock (§9.8)', () => {
    // 10 on hand, all of it damaged: nothing may be promised.
    const damaged = position({ onHand: qty('10'), damaged: qty('10') });
    expect(() => assertCanReserve(damaged, qty('1'))).toThrow(NegativeStockError);
  });

  it('refuses to reserve quarantined stock (§8.4)', () => {
    const quarantined = position({ onHand: qty('10'), inQuarantine: qty('10') });
    expect(() => assertCanReserve(quarantined, qty('1'))).toThrow(NegativeStockError);
  });

  it('offers no flag, parameter or option that permits negative stock', () => {
    // §9.9 — "No UI, import or API transaction can create negative stock." The
    // way to be sure is for there to be nothing to pass: assertCanIssue takes a
    // position and a quantity, and that is all.
    expect(assertCanIssue.length).toBe(2);
  });
});
