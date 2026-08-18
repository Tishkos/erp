/**
 * §7.5 sales returns — Phase 06.9.
 *
 * > *"A/R Invoice → Sales Return / Goods Return from Customer → Inspection →
 * > Saleable Warehouse, Quarantine Warehouse or Damaged Goods Warehouse →
 * > Customer Credit Memo."*
 * > *"Product exchange is not supported."* Replacement requires a new Sales
 * > Order.
 * > *"Damaged returned goods cannot be sold."*
 *
 * The first of those three is a workflow, the third is Phase 04's job (damaged
 * stock is not available stock), and the second is the interesting one: it is a
 * rule enforced by **absence**. There is no exchange function here, no
 * `replacementItemCode` on any type, and no field on any table to name one. A
 * validation that refused exchanges would be a validation somebody could route
 * around; a concept that does not exist cannot be reached by any route.
 *
 * What this module holds is the arithmetic: how much may come back, and what it
 * costs when it does.
 *
 * Pure. Quantities scaled at 10^6, money at 10^4.
 */
import { formatQuantity, QUANTITY_FACTOR } from './uom';
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// How much may come back — §7.5
// ---------------------------------------------------------------------------

export interface ReturnPosition {
  /** What the customer was billed for on the source invoice. */
  readonly invoiced: bigint;
  /** What earlier returns against the same invoice line already accepted. */
  readonly alreadyReturned: bigint;
}

export class OverReturnError extends Error {
  readonly code = 'OVER_RETURN';

  constructor(
    readonly itemCode: string,
    readonly invoiced: bigint,
    readonly alreadyReturned: bigint,
    readonly returning: bigint,
  ) {
    const remaining = invoiced - alreadyReturned;
    super(
      `Returning ${formatQuantity(returning)} of ${itemCode} is more than the customer bought. ` +
        `Invoiced: ${formatQuantity(invoiced)}; already returned: ${formatQuantity(alreadyReturned)}; ` +
        `still returnable: ${formatQuantity(remaining > 0n ? remaining : 0n)}. ` +
        'Goods the customer was never billed for are not a return (§7.5).',
    );
    this.name = 'OverReturnError';
  }
}

/**
 * §7.5 — *"Return quantity cannot exceed invoiced quantity less previous
 * accepted returns."*
 *
 * Cumulative, and counting only **accepted** returns: a return that was rejected
 * went back to the customer, so those units are still theirs to return again.
 * Counting rejected ones would let one refused claim block a legitimate second
 * attempt at the same goods.
 */
export function assertWithinInvoiced(
  itemCode: string,
  position: ReturnPosition,
  returning: bigint,
): void {
  if (returning <= 0n) {
    throw new RangeError(
      `A returned quantity must be positive. A line the customer kept is left off the return, not returned as zero (${itemCode}).`,
    );
  }

  if (position.alreadyReturned + returning > position.invoiced) {
    throw new OverReturnError(
      itemCode,
      position.invoiced,
      position.alreadyReturned,
      returning,
    );
  }
}

/** What is still returnable on an invoice line. Never negative. */
export function returnableQuantity(position: {
  readonly invoiced: bigint;
  readonly returned: bigint;
}): bigint {
  const remaining = position.invoiced - position.returned;
  return remaining > 0n ? remaining : 0n;
}

// ---------------------------------------------------------------------------
// Inspection routing — §7.5
// ---------------------------------------------------------------------------

/**
 * Where inspected goods go.
 *
 * The three §7.5 names, and no fourth. Each maps to a warehouse *type* rather
 * than to a named warehouse, so a company with two damaged-goods stores does not
 * need a code change — and so that "damaged" cannot accidentally be pointed at a
 * saleable location.
 */
export const RETURN_DISPOSITIONS = ['saleable', 'quarantine', 'damaged'] as const;
export type ReturnDisposition = (typeof RETURN_DISPOSITIONS)[number];

const WAREHOUSE_TYPE_FOR: Readonly<Record<ReturnDisposition, string>> = Object.freeze({
  saleable: 'main',
  quarantine: 'quarantine',
  damaged: 'damaged_goods',
});

export class WrongDestinationError extends Error {
  readonly code = 'RETURN_WRONG_DESTINATION';

  constructor(
    readonly disposition: ReturnDisposition,
    readonly warehouseCode: string,
    readonly warehouseType: string,
  ) {
    super(
      `A return inspected as '${disposition}' cannot be put into ${warehouseCode}, which is a ` +
        `${warehouseType.replace('_', ' ')} warehouse. §7.5 routes an inspected return to a saleable, ` +
        'quarantine or damaged-goods location, and §9.8 keeps damaged stock out of the saleable pool ' +
        'by keeping it in a warehouse that is not one.',
    );
    this.name = 'WrongDestinationError';
  }
}

/**
 * Checks that the destination matches what the inspector decided.
 *
 * The reason this is a rule rather than a convention: §7.5's *"damaged returned
 * goods cannot be sold"* is enforced in Phase 04 by the warehouse the stock sits
 * in — damaged-goods stock is not available stock. That control is worth exactly
 * as much as the guarantee that damaged goods actually land there.
 */
export function assertDestinationMatches(
  disposition: ReturnDisposition,
  warehouseCode: string,
  warehouseType: string,
): void {
  const expected = WAREHOUSE_TYPE_FOR[disposition];

  // A 'saleable' return may go to any warehouse that sells — main or branch.
  const acceptable =
    disposition === 'saleable'
      ? warehouseType === 'main' || warehouseType === 'branch'
      : warehouseType === expected;

  if (!acceptable) {
    throw new WrongDestinationError(disposition, warehouseCode, warehouseType);
  }
}

/** Whether goods with this disposition may be sold again (§7.5, §9.8). */
export function isSaleableAgain(disposition: ReturnDisposition): boolean {
  return disposition === 'saleable';
}

// ---------------------------------------------------------------------------
// What it costs — the 06.9 gate
// ---------------------------------------------------------------------------

export class ReturnCostError extends Error {
  readonly code = 'RETURN_COST_UNKNOWN';

  constructor(readonly itemCode: string) {
    super(
      `The original cost of ${itemCode} on the source delivery is not known, so this return cannot ` +
        'be valued. A return puts stock back at what it left at (§7.5, Appendix C) — valuing it at ' +
        'today’s cost would move the difference into gross margin, where nobody would look for it.',
    );
    this.name = 'ReturnCostError';
  }
}

/**
 * The unit cost a returned unit goes back at — *"the original FIFO cost, not
 * current cost"*.
 *
 * Derived from the delivery's own recorded COGS rather than from the layers,
 * because the layers it came out of may since have been emptied by somebody
 * else's sale. The Delivery Note recorded what it cost at the moment it left,
 * precisely so this question has an answer years later.
 *
 * The division truncates. That is the safe direction: the return goes back to
 * stock at no more than it left at, so a rounding remainder stays in cost of
 * sales rather than inflating inventory.
 */
export function originalUnitCost(input: {
  readonly itemCode: string;
  readonly deliveredQuantity: bigint;
  readonly deliveredCogsIqd: bigint;
}): bigint {
  if (input.deliveredQuantity <= 0n) throw new ReturnCostError(input.itemCode);

  return (input.deliveredCogsIqd * QUANTITY_FACTOR) / input.deliveredQuantity;
}

/**
 * What a returned quantity is worth at the original cost.
 *
 * Computed from the unit cost rather than pro-rated from the total, so two
 * partial returns of the same line cannot add up to more than the line cost.
 */
export function returnCostFor(input: {
  readonly unitCostIqd: bigint;
  readonly quantity: bigint;
}): bigint {
  return (input.unitCostIqd * input.quantity) / QUANTITY_FACTOR;
}

/**
 * The credit a return earns — §7.5, at the **price the customer paid**.
 *
 * Deliberately not the current price list: a customer returning goods they
 * bought in March is credited what March charged them. Appendix C's *"accepted
 * return and source invoice required"* is the same point from the other side —
 * the invoice is required because the invoice is where the price is.
 */
export function creditAmountFor(input: {
  readonly invoicedQuantity: bigint;
  readonly invoicedNetIqd: bigint;
  readonly returningQuantity: bigint;
}): bigint {
  if (input.invoicedQuantity <= 0n) return 0n;

  return (input.invoicedNetIqd * input.returningQuantity) / input.invoicedQuantity;
}

/** Formats a scaled amount for a message. Re-exported for the services. */
export function describeCost(amountIqd: bigint): string {
  return toDecimalString(amountIqd, 4n);
}
