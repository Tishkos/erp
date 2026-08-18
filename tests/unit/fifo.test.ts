/**
 * Phase 04.2 test gate — FIFO cost layers.
 *
 * The gate's first item is a worked example, and it is worked here by hand:
 *
 *   receive 100 @ 10, receive 100 @ 12, issue 150
 *   → 100 from the first layer at 10 = 1,000
 *   →  50 from the second layer at 12 =  600
 *   → COGS 1,600, not 150 × 11 = 1,650
 *
 * The average-cost answer is 1,650. That is the number a wrong implementation
 * produces, and it is close enough to the right one to survive review — which
 * is why the phase brief says a FIFO error "does not announce itself".
 */
import { describe, expect, it } from 'vitest';
import {
  InsufficientLayersError,
  consumableLayers,
  costOf,
  fifoOrder,
  issue,
  issueFromLayer,
  receive,
  restore,
  totalRemaining,
  transfer,
  valuation,
  type CostLayer,
} from '@domain/fifo';
import { parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';

/** 100 units, scaled. */
const qty = (units: string) => parseQuantity(units);
/** A unit cost in IQD, scaled. */
const cost = (iqd: string) => parseDecimal(iqd, 4n);

const layer = (
  id: string,
  layerDate: string,
  sequence: number,
  quantity: string,
  unitCost: string,
): CostLayer =>
  receive({
    id,
    itemCode: 'ITM-1',
    warehouseCode: 'WH-1',
    layerDate,
    sequence,
    quantity: qty(quantity),
    unitCostIqd: cost(unitCost),
  });

describe('§9.2 · the gate’s worked example', () => {
  const layers = [
    layer('L1', '2026-01-10', 1, '100', '10'),
    layer('L2', '2026-01-20', 1, '100', '12'),
  ];

  it('costs an issue of 150 at 1,600 — not the 1,650 an average would give', () => {
    const result = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });

    expect(toDecimalString(result.totalCostIqd, 4n)).toBe('1600.0000');
    expect(toDecimalString(result.totalCostIqd, 4n)).not.toBe('1650.0000');
  });

  it('names the layers it consumed and how much from each', () => {
    // 04.2 gate: "Every issue line names the specific layers it consumed and
    // the quantity from each."
    const result = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });

    expect(result.consumptions).toHaveLength(2);
    expect(result.consumptions[0]).toMatchObject({ layerId: 'L1', quantity: qty('100') });
    expect(result.consumptions[1]).toMatchObject({ layerId: 'L2', quantity: qty('50') });
    expect(toDecimalString(result.consumptions[0]!.costIqd, 4n)).toBe('1000.0000');
    expect(toDecimalString(result.consumptions[1]!.costIqd, 4n)).toBe('600.0000');
  });

  it('leaves the older layer empty and the newer one part-used', () => {
    const result = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });

    const [first, second] = result.layers;
    expect(first!.remainingQuantity).toBe(0n);
    expect(second!.remainingQuantity).toBe(qty('50'));
  });

  it('values what is left at 600 — the 50 remaining units at 12', () => {
    const result = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    expect(toDecimalString(valuation(result.layers), 4n)).toBe('600.0000');
  });
});

describe('§9.2 · oldest first, deterministically', () => {
  it('orders by layer date', () => {
    const older = layer('B', '2026-01-01', 1, '10', '5');
    const newer = layer('A', '2026-06-01', 1, '10', '5');
    expect([newer, older].sort(fifoOrder).map((l) => l.id)).toEqual(['B', 'A']);
  });

  it('breaks a same-date tie by the order the receipts happened', () => {
    const second = layer('X', '2026-01-01', 2, '10', '5');
    const first = layer('Y', '2026-01-01', 1, '10', '5');
    expect([second, first].sort(fifoOrder).map((l) => l.id)).toEqual(['Y', 'X']);
  });

  it('uses an opening-stock date earlier than its entry date', () => {
    // §9.7 lets opening stock state its own cost-layer date. That stock is
    // genuinely older and must be consumed first.
    const opening = layer('OPEN', '2025-12-31', 1, '10', '9');
    const received = layer('RCV', '2026-01-05', 1, '10', '11');

    const result = issue([received, opening], qty('10'), {
      itemCode: 'ITM-1',
      warehouseCode: 'WH-1',
    });

    expect(result.consumptions[0]!.layerId).toBe('OPEN');
  });

  it('produces the same cost every time for the same sequence of movements', () => {
    // 04.2 gate: "Layer consumption is deterministic."
    const layers = [
      layer('L1', '2026-01-10', 1, '40', '7.25'),
      layer('L2', '2026-01-10', 2, '40', '8.75'),
      layer('L3', '2026-02-01', 1, '40', '9'),
    ];

    const runs = Array.from({ length: 20 }, () =>
      issue(layers, qty('95'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' }).totalCostIqd,
    );

    expect(new Set(runs.map(String)).size).toBe(1);
  });

  it('skips a layer that is already exhausted', () => {
    const empty = { ...layer('L0', '2026-01-01', 1, '10', '5'), remainingQuantity: 0n };
    const live = layer('L1', '2026-01-02', 1, '10', '6');

    expect(consumableLayers([empty, live]).map((l) => l.id)).toEqual(['L1']);
  });
});

describe('§9.2 · exact arithmetic', () => {
  it('multiplies a fractional quantity by a fractional cost without drift', () => {
    // 0.1 × 3 must be 0.3. A float gives 0.30000000000000004, and the
    // difference lands in COGS.
    expect(toDecimalString(costOf(qty('0.1'), cost('3')), 4n)).toBe('0.3000');
  });

  it('rounds half-up, the way a reviewer would by hand', () => {
    // 1.5 units at 1.0001 = 1.50015 → 1.5002 at four places.
    expect(toDecimalString(costOf(qty('1.5'), cost('1.0001')), 4n)).toBe('1.5002');
  });

  it('shows no drift over ten thousand small issues', () => {
    // The gate for money is a 10,000-row repeated-addition test; the same
    // standard applies to inventory cost, which is where it actually bites.
    let layers: readonly CostLayer[] = [layer('L1', '2026-01-01', 1, '10000', '3.3333')];
    let total = 0n;

    for (let i = 0; i < 10_000; i++) {
      const result = issue(layers, qty('1'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
      layers = result.layers;
      total += result.totalCostIqd;
    }

    expect(toDecimalString(total, 4n)).toBe('33333.0000');
    expect(totalRemaining(layers)).toBe(0n);
  });
});

describe('§9.2 · a reversal restores the quantity and the cost relationship', () => {
  const layers = [
    layer('L1', '2026-01-10', 1, '100', '10'),
    layer('L2', '2026-01-20', 1, '100', '12'),
  ];

  it('puts both layers back exactly as they were', () => {
    // 04.2 gate: "Reversing that issue restores both layers to their original
    // quantities and unit costs."
    const issued = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    const restored = restore(issued.layers, issued.consumptions);

    expect(restored[0]!.remainingQuantity).toBe(qty('100'));
    expect(restored[1]!.remainingQuantity).toBe(qty('100'));
    expect(restored[0]!.unitCostIqd).toBe(cost('10'));
    expect(restored[1]!.unitCostIqd).toBe(cost('12'));
  });

  it('leaves the next issue costing what it would have cost', () => {
    // The real test of "cost relationship": after a reversal, the FIFO order is
    // as if nothing happened. A reversal that created a new layer at the issue
    // cost would pass a quantity check and fail this.
    const issued = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    const restored = restore(issued.layers, issued.consumptions);

    const after = issue(restored, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    expect(toDecimalString(after.totalCostIqd, 4n)).toBe('1600.0000');
  });

  it('refuses to put back more than was taken', () => {
    const issued = issue(layers, qty('50'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    const doubled = issued.consumptions.map((c) => ({ ...c, quantity: c.quantity * 3n }));

    expect(() => restore(issued.layers, doubled)).toThrow(/cannot put back more than was taken/);
  });

  it('refuses to restore into a different item’s layers', () => {
    const issued = issue(layers, qty('50'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    const elsewhere = [layer('OTHER', '2026-01-01', 1, '10', '5')];

    expect(() => restore(elsewhere, issued.consumptions)).toThrow(/same item and warehouse/);
  });
});

describe('§9.2 · what cannot be done', () => {
  it('refuses an issue larger than the layers hold, and says by how much', () => {
    const layers = [layer('L1', '2026-01-10', 1, '10', '10')];

    try {
      issue(layers, qty('11'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InsufficientLayersError);
      // This state means the quantity ledger and the layers disagree, which is
      // a reconciliation failure rather than a user mistake — and it says so.
      expect((error as Error).message).toMatch(/reconciliation failure/);
    }
  });

  it('refuses a receipt of nothing', () => {
    expect(() =>
      receive({
        id: 'L',
        itemCode: 'I',
        warehouseCode: 'W',
        layerDate: '2026-01-01',
        sequence: 1,
        quantity: 0n,
        unitCostIqd: cost('5'),
      }),
    ).toThrow(/creates no cost layer/);
  });

  it('refuses stock received at a negative value', () => {
    expect(() =>
      receive({
        id: 'L',
        itemCode: 'I',
        warehouseCode: 'W',
        layerDate: '2026-01-01',
        sequence: 1,
        quantity: qty('1'),
        unitCostIqd: -1n,
      }),
    ).toThrow(/not a cost/);
  });
});

describe('§9.4 · a transfer carries its costs across', () => {
  it('gives the destination the source’s layer costs, not a recomputed value', () => {
    // 04.6 gate. Recomputing at the destination would value the same goods
    // differently depending on where they sit, making a transfer a way of
    // restating margin.
    const layers = [
      layer('L1', '2026-01-10', 1, '100', '10'),
      layer('L2', '2026-01-20', 1, '100', '12'),
    ];

    const issued = issue(layers, qty('150'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    const arriving = transfer(issued.consumptions, {
      warehouseCode: 'WH-2',
      layerDate: '2026-01-25',
      idFor: (i) => `T${i}`,
    });

    expect(arriving.map((l) => l.unitCostIqd)).toEqual([cost('10'), cost('12')]);
    expect(arriving.map((l) => l.remainingQuantity)).toEqual([qty('100'), qty('50')]);
    expect(toDecimalString(valuation(arriving), 4n)).toBe('1600.0000');
  });

  it('keeps the transferred quantity equal to what left the source', () => {
    const layers = [layer('L1', '2026-01-10', 1, '80', '9')];
    const issued = issue(layers, qty('30'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' });
    const arriving = transfer(issued.consumptions, {
      warehouseCode: 'WH-2',
      layerDate: '2026-02-01',
      idFor: (i) => `T${i}`,
    });

    expect(totalRemaining(arriving)).toBe(qty('30'));
  });
});

// ---------------------------------------------------------------------------
// §8.7 — a return to the supplier comes out of the layer it arrived in.
// ---------------------------------------------------------------------------
describe('§8.7 · goods going back to the supplier', () => {
  const two = () => [
    layer('L1', '2026-01-10', 1, '100', '10'),
    layer('L2', '2026-01-20', 1, '100', '12'),
  ];

  it('takes the named layer, not the oldest one', () => {
    const result = issueFromLayer(two(), 'L2', qty('30'), {
      itemCode: 'ITM-1',
      warehouseCode: 'WH-1',
    });

    // FIFO decides the order for *unidentified* units. These are identified:
    // they are the ones that supplier delivered, going back to that supplier
    // against that invoice.
    expect(result.consumptions).toHaveLength(1);
    expect(result.consumptions[0]!.layerId).toBe('L2');
    expect(result.consumptions[0]!.unitCostIqd).toBe(cost('12'));
  });

  it('credits inventory with what the supplier actually charged', () => {
    const result = issueFromLayer(two(), 'L2', qty('30'), {
      itemCode: 'ITM-1',
      warehouseCode: 'WH-1',
    });

    // 30 × 12 = 360. Taking the oldest layer would credit 300, and the credit
    // memo would then not clear the return — the quantity right, the money
    // wrong, quietly.
    expect(result.totalCostIqd).toBe(cost('360'));
  });

  it('leaves every other layer untouched', () => {
    const result = issueFromLayer(two(), 'L2', qty('30'), {
      itemCode: 'ITM-1',
      warehouseCode: 'WH-1',
    });

    const byId = new Map(result.layers.map((l) => [l.id, l.remainingQuantity]));
    expect(byId.get('L1')).toBe(qty('100'));
    expect(byId.get('L2')).toBe(qty('70'));
  });

  it('refuses more than the layer still holds', () => {
    const layers = issueFromLayer(two(), 'L2', qty('80'), {
      itemCode: 'ITM-1',
      warehouseCode: 'WH-1',
    }).layers;

    // Twenty left in L2 and a hundred elsewhere: a return of fifty means
    // thirty of those goods have already been sold, and what to do about that
    // is a person's decision.
    expect(() =>
      issueFromLayer(layers, 'L2', qty('50'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' }),
    ).toThrow(InsufficientLayersError);
  });

  it('refuses a layer that is not there', () => {
    expect(() =>
      issueFromLayer(two(), 'L9', qty('10'), { itemCode: 'ITM-1', warehouseCode: 'WH-1' }),
    ).toThrow(InsufficientLayersError);
  });

  it('refuses a return of nothing', () => {
    expect(() =>
      issueFromLayer(two(), 'L1', 0n, { itemCode: 'ITM-1', warehouseCode: 'WH-1' }),
    ).toThrow(InsufficientLayersError);
  });

  it('can be restored exactly, like any other consumption (§9.2)', () => {
    const result = issueFromLayer(two(), 'L2', qty('30'), {
      itemCode: 'ITM-1',
      warehouseCode: 'WH-1',
    });
    const back = restore(result.layers, result.consumptions);

    const byId = new Map(back.map((l) => [l.id, l.remainingQuantity]));
    expect(byId.get('L2')).toBe(qty('100'));
  });
});
