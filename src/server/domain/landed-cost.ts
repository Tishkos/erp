/**
 * The landed cost — REQ-AP-001 §20.2, decidable without a database.
 *
 * Quantities are bigints at QUANTITY_SCALE (1e6), money at MONEY_SCALE (1e4);
 * a layer's value is quantity × unit cost / 1e6. Every split floors its parts
 * and gives the remainder to the last, so the parts always add up to the whole.
 */
export class LandedCostError extends Error {
  readonly code = 'LANDED_COST_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'LandedCostError';
  }
}

export const BASES = ['by_value', 'by_quantity', 'by_weight', 'by_volume', 'manual'] as const;
export type Basis = (typeof BASES)[number];

/** The charge types that are the goods themselves, not a cost of landing them. */
export const NOT_ALLOCATED = new Set(['purchase']);

const QUANTITY_ONE = 1_000_000n;

/** quantity × unit cost, at the money scale, half up. */
export function valueOf(quantity: bigint, unitCost: bigint): bigint {
  const raw = quantity * unitCost;
  const whole = raw / QUANTITY_ONE;
  return (raw % QUANTITY_ONE) * 2n >= QUANTITY_ONE ? whole + 1n : whole;
}

/** total split in proportion to the weights; the last part takes the remainder. */
export function spreadByWeights(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, w) => acc + w, 0n);
  if (sum <= 0n) throw new LandedCostError('Nothing to spread the cost over: every share is zero.');
  const parts = weights.map((w) => (total * w) / sum);
  const given = parts.slice(0, -1).reduce((acc, p) => acc + p, 0n);
  parts[parts.length - 1] = total - given;
  return parts;
}

export interface LayerState {
  readonly originalQuantity: bigint;
  readonly remainingQuantity: bigint;
  readonly unitCost: bigint;
}

export interface Restatement {
  /** What of the amount stays with the stock still in this layer. */
  readonly inventoryIqd: bigint;
  /** What belongs to the stock that has left it (sold, or moved on). */
  readonly goneIqd: bigint;
  readonly unitCostAfter: bigint;
}

/**
 * §20.2 — a layer given `amount`: the share of its original quantity still
 * remaining raises the unit cost of what remains; the rest left with the
 * stock that has gone. The inventory figure is exactly what the restated unit
 * cost adds to the layer's value, so the warehouse and the ledger hold one
 * number; rounding falls to the stock that has gone.
 */
export function restate(layer: LayerState, amount: bigint): Restatement {
  if (amount < 0n) throw new LandedCostError('A landed cost is never negative.');
  if (layer.originalQuantity <= 0n) throw new LandedCostError('A layer with no quantity carries no cost.');
  const remaining = layer.remainingQuantity;
  if (remaining <= 0n || amount === 0n) {
    return { inventoryIqd: 0n, goneIqd: amount, unitCostAfter: layer.unitCost };
  }
  const onHandShare = (amount * remaining) / layer.originalQuantity;
  // Δunit = share / remaining, half up, at the money scale.
  const raw = onHandShare * QUANTITY_ONE;
  let delta = raw / remaining;
  if ((raw % remaining) * 2n >= remaining) delta += 1n;
  const before = valueOf(remaining, layer.unitCost);
  let inventory = valueOf(remaining, layer.unitCost + delta) - before;
  while (inventory > amount && delta > 0n) {
    delta -= 1n;
    inventory = valueOf(remaining, layer.unitCost + delta) - before;
  }
  return { inventoryIqd: inventory, goneIqd: amount - inventory, unitCostAfter: layer.unitCost + delta };
}

export interface BasisLayer {
  readonly itemCode: string;
  readonly originalQuantity: bigint;
  readonly unitCost: bigint;
}

/**
 * The weight each received layer carries under a basis. `manual` takes an
 * amount per model and spreads it over that model's layers by quantity, so its
 * weights are the amounts themselves (see `allocate`).
 */
export function basisWeights(basis: Basis, layers: readonly BasisLayer[]): bigint[] {
  switch (basis) {
    case 'by_value':
      return layers.map((layer) => valueOf(layer.originalQuantity, layer.unitCost));
    case 'by_quantity':
      return layers.map((layer) => layer.originalQuantity);
    case 'by_weight':
    case 'by_volume':
      throw new LandedCostError(
        `${basis === 'by_weight' ? 'Weight' : 'Volume'} is not on the item master yet; allocate by value, by quantity or manually.`,
      );
    default:
      throw new LandedCostError(`'${basis}' is allocated per model, not by weight.`);
  }
}

/** The amount each layer is given: by a basis, or (manual) by the amounts typed per model. */
export function allocate(
  basis: Basis,
  total: bigint,
  layers: readonly BasisLayer[],
  manual?: ReadonlyMap<string, bigint>,
): bigint[] {
  if (layers.length === 0) {
    throw new LandedCostError('No container of this import has been received; the cost has no stock to land on.');
  }
  if (basis !== 'manual') return spreadByWeights(total, basisWeights(basis, layers));
  const typed = manual ?? new Map<string, bigint>();
  const models = [...new Set(layers.map((layer) => layer.itemCode))];
  const sum = models.reduce((acc, model) => acc + (typed.get(model) ?? 0n), 0n);
  if (sum !== total) {
    throw new LandedCostError(
      `The amounts typed per model add up to ${formatIqd(sum)}; the charges to allocate are ${formatIqd(total)}.`,
    );
  }
  const result = layers.map(() => 0n);
  for (const model of models) {
    const indexes = layers.map((layer, index) => (layer.itemCode === model ? index : -1)).filter((index) => index >= 0);
    const parts = spreadByWeights(
      typed.get(model) ?? 0n,
      indexes.map((index) => layers[index]!.originalQuantity),
    );
    indexes.forEach((index, n) => {
      result[index] = parts[n]!;
    });
  }
  return result;
}

/** 1,234,567.89 IQD — for a sentence. */
export function formatIqd(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 10_000n;
  const cents = (absolute % 10_000n) / 100n;
  return `${negative ? '-' : ''}${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents.toString().padStart(2, '0')} IQD`;
}
