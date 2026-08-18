/**
 * FIFO cost layers — Phase 04.2, §9.2.
 *
 * §9.2: *"FIFO is the single valuation method for every item and warehouse"*
 * and *"Every inventory issue consumes the oldest available FIFO cost layers"*.
 *
 * The phase brief is blunt about why this module is written the way it is: *"a
 * FIFO error does not announce itself, it just makes the margin wrong."* An
 * average-cost mistake produces plausible figures for years. So:
 *
 *   - Costs are scaled integers. A unit cost of 10.5 held as a float and
 *     multiplied by 3 is 31.499999999999996, and the difference lands in COGS.
 *   - A layer is never mutated in place. Consumption is recorded against it, so
 *     the receipt that created it stays readable — which is what makes the
 *     04.2 gate's "every issue names the layers it consumed" possible at all.
 *   - Ordering is explicit and total. "Oldest" means by layer date, then by the
 *     sequence in which the layers were created; ties broken by anything less
 *     deterministic would make the same movements cost differently on a re-run,
 *     and the gate requires that they do not.
 *
 * Pure. The service writes the consumption rows this returns; nothing here
 * knows about a database, so the arithmetic can be checked by hand against the
 * gate's own worked example.
 */
import { QUANTITY_SCALE } from './uom';

const QUANTITY_FACTOR = 10n ** QUANTITY_SCALE;

/**
 * One receipt's worth of stock at one cost.
 *
 * `remaining` is what is left of it. `sequence` orders layers created on the
 * same date — the receipt order within the day, which is the only defensible
 * tie-break: it is what actually happened.
 */
export interface CostLayer {
  readonly id: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  /** ISO date the layer is costed at — the receipt date, or §9.7's stated
   *  cost-layer date for opening stock, which may be earlier. */
  readonly layerDate: string;
  readonly sequence: number;
  /** Scaled at QUANTITY_SCALE. */
  readonly originalQuantity: bigint;
  readonly remainingQuantity: bigint;
  /** Scaled at MONEY_SCALE. Cost of one base unit, in IQD. */
  readonly unitCostIqd: bigint;
}

/** How much of one layer an issue took. */
export interface LayerConsumption {
  readonly layerId: string;
  readonly quantity: bigint;
  readonly unitCostIqd: bigint;
  /** quantity × unitCost, at MONEY_SCALE — computed once, here. */
  readonly costIqd: bigint;
}

export interface IssueResult {
  readonly consumptions: readonly LayerConsumption[];
  /** The total that goes to COGS or to the receiving account. */
  readonly totalCostIqd: bigint;
  /** The layers as they now stand. Inputs are not mutated. */
  readonly layers: readonly CostLayer[];
}

export class InsufficientLayersError extends Error {
  readonly code = 'INSUFFICIENT_COST_LAYERS';

  constructor(
    readonly itemCode: string,
    readonly warehouseCode: string,
    readonly shortfall: bigint,
  ) {
    // Reaching here means the quantity ledger and the cost layers disagree —
    // the availability check passed and there is no cost to attach to it. That
    // is a reconciliation failure, not a user error, and it says so.
    super(
      `Cost layers for ${itemCode} in ${warehouseCode} are short by ${shortfall} scaled units. ` +
        'The quantity ledger and the FIFO layers disagree, which is a reconciliation failure — ' +
        'the issue has not been made. Run the inventory integrity report (§9.9).',
    );
    this.name = 'InsufficientLayersError';
  }
}

/**
 * Oldest first: by layer date, then by creation sequence.
 *
 * Total and deterministic, so the same movements always produce the same cost
 * — the 04.2 gate's last item. Layer date rather than creation timestamp,
 * because §9.7 lets opening stock state a cost-layer date earlier than the day
 * it was entered, and that stock is genuinely older.
 */
export function fifoOrder(a: CostLayer, b: CostLayer): number {
  if (a.layerDate !== b.layerDate) return a.layerDate < b.layerDate ? -1 : 1;
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Layers with stock left, oldest first. */
export function consumableLayers(layers: readonly CostLayer[]): CostLayer[] {
  return layers.filter((l) => l.remainingQuantity > 0n).sort(fifoOrder);
}

export function totalRemaining(layers: readonly CostLayer[]): bigint {
  return layers.reduce((sum, l) => sum + l.remainingQuantity, 0n);
}

/**
 * The value of what is on hand, from the layers.
 *
 * 04.2's gate requires this to equal the inventory G/L control account balance.
 * It can, because both are derived from the same movements — and it is checked
 * rather than assumed.
 */
export function valuation(layers: readonly CostLayer[]): bigint {
  return layers.reduce((sum, l) => sum + costOf(l.remainingQuantity, l.unitCostIqd), 0n);
}

/**
 * quantity × unitCost, both scaled, result at MONEY_SCALE.
 *
 * Rounded half-up on the final division only, so a long issue does not
 * accumulate a rounding error per layer. Half-up because it is what a reviewer
 * reproduces by hand (money.ts uses the same rule).
 */
export function costOf(quantity: bigint, unitCostIqd: bigint): bigint {
  const product = quantity * unitCostIqd;
  const half = QUANTITY_FACTOR / 2n;
  return product >= 0n
    ? (product + half) / QUANTITY_FACTOR
    : -((-product + half) / QUANTITY_FACTOR);
}

/**
 * Consume `quantity` from the oldest layers.
 *
 * Returns what was taken from each, the total cost, and the updated layers.
 * Nothing is mutated: the caller writes both the consumption rows and the new
 * remaining quantities in one transaction, so a partial application is not
 * representable.
 */
export function issue(
  layers: readonly CostLayer[],
  quantity: bigint,
  context: { itemCode: string; warehouseCode: string },
): IssueResult {
  if (quantity <= 0n) {
    throw new InsufficientLayersError(context.itemCode, context.warehouseCode, quantity);
  }

  const available = totalRemaining(layers);
  if (quantity > available) {
    throw new InsufficientLayersError(
      context.itemCode,
      context.warehouseCode,
      quantity - available,
    );
  }

  const remainingById = new Map(layers.map((l) => [l.id, l.remainingQuantity]));
  const consumptions: LayerConsumption[] = [];
  let outstanding = quantity;
  let totalCostIqd = 0n;

  for (const layer of consumableLayers(layers)) {
    if (outstanding === 0n) break;

    const taken = layer.remainingQuantity < outstanding ? layer.remainingQuantity : outstanding;
    const cost = costOf(taken, layer.unitCostIqd);

    consumptions.push({
      layerId: layer.id,
      quantity: taken,
      unitCostIqd: layer.unitCostIqd,
      costIqd: cost,
    });

    remainingById.set(layer.id, layer.remainingQuantity - taken);
    totalCostIqd += cost;
    outstanding -= taken;
  }

  return {
    consumptions,
    totalCostIqd,
    layers: layers.map((l) => ({ ...l, remainingQuantity: remainingById.get(l.id)! })),
  };
}

/**
 * §8.7 — goods going back to the supplier, taken from the layer they arrived in.
 *
 * **Why this is not a departure from FIFO.** FIFO decides the *order in which
 * unidentified units are consumed*: when the warehouse ships a hundred cables,
 * nobody knows or cares which physical cables they were, so the oldest cost is
 * relieved first. A return to a supplier is the opposite case — the units are
 * identified. They are the ones that supplier delivered on that receipt, and
 * they are going back to that supplier against that invoice.
 *
 * Relieving inventory at the oldest layer's cost instead would credit inventory
 * with a number the supplier never charged, and the credit memo would then not
 * clear the return. The quantity would be right and the money would be wrong —
 * the same failure §9.2 guards against when it refuses to restore a reversal at
 * the issue's cost rather than the layer's.
 *
 * Refuses rather than partially consuming: a return of more than the layer
 * still holds means some of those goods have already been sold, and the
 * decision about that belongs to a person.
 */
export function issueFromLayer(
  layers: readonly CostLayer[],
  layerId: string,
  quantity: bigint,
  context: { itemCode: string; warehouseCode: string },
): IssueResult {
  if (quantity <= 0n) {
    throw new InsufficientLayersError(context.itemCode, context.warehouseCode, quantity);
  }

  const layer = layers.find((l) => l.id === layerId);
  if (!layer) {
    throw new InsufficientLayersError(context.itemCode, context.warehouseCode, quantity);
  }

  if (quantity > layer.remainingQuantity) {
    throw new InsufficientLayersError(
      context.itemCode,
      context.warehouseCode,
      quantity - layer.remainingQuantity,
    );
  }

  const cost = costOf(quantity, layer.unitCostIqd);

  return {
    consumptions: [{ layerId, quantity, unitCostIqd: layer.unitCostIqd, costIqd: cost }],
    totalCostIqd: cost,
    layers: layers.map((l) =>
      l.id === layerId ? { ...l, remainingQuantity: l.remainingQuantity - quantity } : l,
    ),
  };
}

/**
 * §9.2 — *"A reversal restores the original quantity and cost relationship."*
 *
 * Note what this does **not** do: it does not create a new layer at the issue's
 * cost. Putting the stock back as a fresh layer would change its position in
 * the FIFO order and make the next issue cost differently — the quantity would
 * be right and the margin would be wrong, quietly. The original layers are
 * restored instead, so the sequence is as if the issue never happened.
 */
export function restore(
  layers: readonly CostLayer[],
  consumptions: readonly LayerConsumption[],
): readonly CostLayer[] {
  const restoredById = new Map(layers.map((l) => [l.id, l.remainingQuantity]));

  for (const consumption of consumptions) {
    const current = restoredById.get(consumption.layerId);
    if (current === undefined) {
      throw new Error(
        `Cannot restore ${consumption.quantity} to layer ${consumption.layerId}: the layer is not in the set being restored. ` +
          'A reversal must be applied to the same item and warehouse as the issue it reverses (§9.2).',
      );
    }
    restoredById.set(consumption.layerId, current + consumption.quantity);
  }

  const restored = layers.map((l) => ({ ...l, remainingQuantity: restoredById.get(l.id)! }));

  for (const layer of restored) {
    if (layer.remainingQuantity > layer.originalQuantity) {
      throw new Error(
        `Restoring layer ${layer.id} would leave ${layer.remainingQuantity} of an original ${layer.originalQuantity}. ` +
          'A reversal cannot put back more than was taken (§9.2).',
      );
    }
  }

  return restored;
}

/**
 * A layer created by a receipt.
 *
 * `sequence` is supplied by the caller from a per-item, per-warehouse, per-date
 * counter — the service allocates it, because "the order receipts happened" is
 * a fact about the database, not about this function.
 */
export function receive(input: {
  id: string;
  itemCode: string;
  warehouseCode: string;
  layerDate: string;
  sequence: number;
  quantity: bigint;
  unitCostIqd: bigint;
}): CostLayer {
  if (input.quantity <= 0n) {
    throw new Error(
      `A receipt of ${input.quantity} creates no cost layer. Receive a positive quantity, or record a return instead.`,
    );
  }
  if (input.unitCostIqd < 0n) {
    throw new Error(
      `A unit cost of ${input.unitCostIqd} is not a cost. Stock cannot be received at a negative value (§9.2).`,
    );
  }

  return {
    id: input.id,
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
    layerDate: input.layerDate,
    sequence: input.sequence,
    originalQuantity: input.quantity,
    remainingQuantity: input.quantity,
    unitCostIqd: input.unitCostIqd,
  };
}

/**
 * Moves layers to another warehouse, keeping their costs — 04.6's gate:
 * *"the destination inherits the source's layer costs, not a recomputed value"*.
 *
 * A transfer is not a purchase. Recomputing the cost at the destination would
 * value the same goods differently depending on where they sit, and a transfer
 * would become a way of restating margin.
 */
export function transfer(
  consumptions: readonly LayerConsumption[],
  destination: { warehouseCode: string; layerDate: string; idFor: (index: number) => string },
): CostLayer[] {
  return consumptions.map((consumption, index) => ({
    id: destination.idFor(index),
    itemCode: '',
    warehouseCode: destination.warehouseCode,
    layerDate: destination.layerDate,
    sequence: index + 1,
    originalQuantity: consumption.quantity,
    remainingQuantity: consumption.quantity,
    unitCostIqd: consumption.unitCostIqd,
  }));
}
