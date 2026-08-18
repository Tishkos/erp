/**
 * Inventory availability — Phase 04.1, §9.5.
 *
 * §9.5 names nine buckets. Six of them describe stock the company physically
 * holds; three describe expectations. The distinction is the whole model, and
 * getting it wrong is how a warehouse promises stock it does not have:
 *
 *   On Hand              physically present in this warehouse, whatever its state
 *   Reserved             on hand, but promised to a specific customer document
 *   In Quarantine        on hand, not yet inspected — §8.4 "unavailable for sale"
 *   Damaged              on hand, and §9.8 forbids selling or reserving it
 *   Returns Stock        on hand, received back, awaiting disposition
 *   In Transit           left the source, not yet received at the destination —
 *                        physically nowhere, and 04.1's gate says it must be
 *                        Available at neither end
 *   Ordered from Suppliers   expected in. Not stock.
 *   Committed to Customers   expected out. Not stock.
 *   Available            what may actually be promised
 *
 * The last is derived, never stored. A stored Available is a number that drifts
 * from the movements that produced it, and the drift is silent — §9.9 requires
 * inventory to reconcile, so the figure is computed from the buckets every time.
 *
 * Quantities are scaled integers at `QUANTITY_SCALE` (uom.ts), never floats. An
 * inventory count of 0.1 + 0.2 must be 0.3.
 */
import { QUANTITY_SCALE } from './uom';

/** §9.5's list, in the blueprint's order. */
export const AVAILABILITY_BUCKETS = [
  'on_hand',
  'available',
  'reserved',
  'in_transit',
  'in_quarantine',
  'damaged',
  'returns_stock',
  'ordered_from_suppliers',
  'committed_to_customers',
] as const;

export type AvailabilityBucket = (typeof AVAILABILITY_BUCKETS)[number];

/**
 * The physically-held buckets that are *not* available for sale.
 *
 * Named as a list rather than written into the subtraction, because the next
 * module to add a bucket (§8.4's inspection states, say) has to decide
 * explicitly whether it reduces Available — and adding to this list is that
 * decision, made in one place.
 */
export const UNAVAILABLE_ON_HAND_BUCKETS = [
  'reserved',
  'in_quarantine',
  'damaged',
] as const;

/**
 * A position for one item in one warehouse.
 *
 * Every figure is a scaled integer. `available` is absent because it is
 * computed — see `availableQuantity`.
 */
export interface StockPosition {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly onHand: bigint;
  readonly reserved: bigint;
  readonly inQuarantine: bigint;
  readonly damaged: bigint;
  readonly returnsStock: bigint;
  readonly inTransit: bigint;
  readonly orderedFromSuppliers: bigint;
  readonly committedToCustomers: bigint;
}

export const EMPTY_POSITION: Omit<StockPosition, 'itemCode' | 'warehouseCode' | 'branchCode'> =
  Object.freeze({
    onHand: 0n,
    reserved: 0n,
    inQuarantine: 0n,
    damaged: 0n,
    returnsStock: 0n,
    inTransit: 0n,
    orderedFromSuppliers: 0n,
    committedToCustomers: 0n,
  });

export class NegativeStockError extends Error {
  readonly code = 'NEGATIVE_STOCK';

  constructor(
    readonly itemCode: string,
    readonly warehouseCode: string,
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    // §25 — the field, the reason, the corrective action. The figures are given
    // because "insufficient stock" without them sends the user to a screen to
    // find out how much they actually have.
    super(
      `Cannot issue ${format(requested)} of ${itemCode} from ${warehouseCode}: ` +
        `${format(available)} is available. Negative inventory is prohibited without exception (§9.2). ` +
        'Reduce the quantity, receive stock first, or issue from another warehouse.',
    );
    this.name = 'NegativeStockError';
  }
}

function format(scaled: bigint): string {
  const factor = 10n ** QUANTITY_SCALE;
  const whole = scaled / factor;
  const fraction = (scaled < 0n ? -scaled : scaled) % factor;
  const text = `${whole}.${fraction.toString().padStart(Number(QUANTITY_SCALE), '0')}`;
  return text.replace(/\.?0+$/, '') || '0';
}

/**
 * §9.5's Available.
 *
 *   Available = On Hand − Reserved − Quarantine − Damaged − Returns Stock
 *
 * The three subtracted buckets are the stock that is present but not saleable:
 * quarantine awaiting inspection (§8.4), damaged goods (§9.8), and returns
 * awaiting disposition. Under §9.1's warehouse types each of those lives in a
 * warehouse of its own type, so for any one position at most one of them is
 * non-zero and equals On Hand — which is why the same subtraction gives zero
 * there and the right figure when positions are summed to branch or company.
 *
 * In Transit is not subtracted, because it is not part of On Hand at this
 * warehouse in the first place — it belongs to neither end, which is the 04.1
 * gate's fourth item.
 */
export function availableQuantity(position: StockPosition): bigint {
  return (
    position.onHand -
    position.reserved -
    position.inQuarantine -
    position.damaged -
    position.returnsStock
  );
}

/** The nine figures, for a screen or an API. */
export function availabilityOf(position: StockPosition): Readonly<Record<AvailabilityBucket, bigint>> {
  return Object.freeze({
    on_hand: position.onHand,
    available: availableQuantity(position),
    reserved: position.reserved,
    in_transit: position.inTransit,
    in_quarantine: position.inQuarantine,
    damaged: position.damaged,
    returns_stock: position.returnsStock,
    ordered_from_suppliers: position.orderedFromSuppliers,
    committed_to_customers: position.committedToCustomers,
  });
}

/**
 * What may physically leave this warehouse: what is here, less what is promised.
 *
 * Distinct from `availableQuantity`, and the distinction matters. Stock sitting
 * in quarantine is not available *for sale* (§8.4) but it is certainly there,
 * and an inspector releasing it to stores must be able to move it. Damaged
 * stock is the same: it cannot be sold (§9.8), and it still has to be capable
 * of being written off.
 *
 * Conflating the two rules makes one of them unenforceable. Either quarantined
 * stock can never leave quarantine, or it can be sold from it — and the second
 * is the one that quietly happens, because the first is noticed immediately.
 */
export function issuableQuantity(position: StockPosition): bigint {
  return position.onHand - position.reserved;
}

/**
 * §9.2 — "Negative inventory is prohibited without exception."
 *
 * The physical rule: nothing leaves a warehouse that is not in it. Every write
 * path calls this, and there is no flag to disable it and no parameter to relax
 * it — §9.9 requires that "no UI, import or API transaction can create negative
 * stock", and the way to be sure of that is for there to be nothing to pass.
 *
 * In a saleable warehouse this is the same figure as Available, because the
 * quarantine and damaged buckets are zero there. The two only diverge where
 * stock is somewhere it cannot be sold from, which is exactly where they should.
 */
export function assertCanIssue(position: StockPosition, quantity: bigint): void {
  const issuable = issuableQuantity(position);

  if (quantity <= 0n || quantity > issuable) {
    throw new NegativeStockError(position.itemCode, position.warehouseCode, quantity, issuable);
  }
}

/**
 * §8.4 and §9.8 — the saleability rule: only stock that is available may be
 * promised to a customer or shipped to one.
 *
 * Separate from `assertCanIssue` because they fail for different reasons and a
 * user needs to be told which: "there isn't that much" and "that stock is in
 * quarantine" call for different actions.
 */
export function assertCanSell(position: StockPosition, quantity: bigint): void {
  const available = availableQuantity(position);

  if (quantity <= 0n || quantity > available) {
    throw new NegativeStockError(position.itemCode, position.warehouseCode, quantity, available);
  }
}

/** §9.8 — damaged and quarantined stock cannot be promised to anyone. */
export function assertCanReserve(position: StockPosition, quantity: bigint): void {
  assertCanSell(position, quantity);
}

/**
 * Aggregates positions to the level being asked about — §9.5 requires views
 * "by item, warehouse, branch and consolidated company".
 *
 * The consolidated figure is the sum of the branch figures by construction,
 * which is the 04.1 gate's fifth item: it holds because there is one summing
 * function rather than a separate company-level query that could drift.
 */
export function aggregate(
  positions: readonly StockPosition[],
  by: 'item' | 'warehouse' | 'branch' | 'company',
): StockPosition[] {
  const keyOf = (p: StockPosition): string => {
    switch (by) {
      case 'item':
        return p.itemCode;
      case 'warehouse':
        return `${p.itemCode}|${p.warehouseCode}`;
      case 'branch':
        return `${p.itemCode}|${p.branchCode}`;
      case 'company':
        return p.itemCode;
    }
  };

  const totals = new Map<string, StockPosition>();

  for (const position of positions) {
    const key = keyOf(position);
    const running = totals.get(key);

    if (!running) {
      totals.set(key, {
        ...position,
        // The dimensions that are being summed away are blanked rather than
        // kept from whichever row happened to be first — a total labelled with
        // one branch's code reads as that branch's figure.
        warehouseCode: by === 'warehouse' ? position.warehouseCode : '',
        branchCode: by === 'branch' ? position.branchCode : '',
      });
      continue;
    }

    totals.set(key, {
      ...running,
      onHand: running.onHand + position.onHand,
      reserved: running.reserved + position.reserved,
      inQuarantine: running.inQuarantine + position.inQuarantine,
      damaged: running.damaged + position.damaged,
      returnsStock: running.returnsStock + position.returnsStock,
      inTransit: running.inTransit + position.inTransit,
      orderedFromSuppliers: running.orderedFromSuppliers + position.orderedFromSuppliers,
      committedToCustomers: running.committedToCustomers + position.committedToCustomers,
    });
  }

  return [...totals.values()];
}
