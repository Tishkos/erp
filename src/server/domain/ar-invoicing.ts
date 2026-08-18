/**
 * §7.4 A/R invoicing rules — Phase 06.6.
 *
 * Three sentences of the blueprint, and each one is a control rather than a
 * preference:
 *
 *   *"Every inventory A/R Invoice shall be created from an approved Delivery
 *   Note."* — so revenue cannot be recognised for goods nobody delivered. That
 *   one is structural: `delivery_note_id` is NOT NULL on the invoice, and the
 *   line names the delivery line it bills.
 *
 *   *"The A/R Invoice shall be issued on the same date as delivery."* — so the
 *   sale, its cost and its revenue land in the same period. Appendix C says the
 *   same thing from the accounting side: *"Same delivery and invoice date."*
 *
 *   And Appendix B splits the effect in two: the Delivery Note is *Inventory and
 *   COGS*, the A/R Invoice is *A/R and revenue*. Appendix C's single row covers
 *   the combined economic event across both documents; it is not an instruction
 *   to post the cost twice.
 *
 * Pure. Money is scaled at 10^4, quantities at 10^6.
 */
import { formatQuantity } from './uom';
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// §7.4 — same date as delivery
// ---------------------------------------------------------------------------

export class InvoiceDateMismatchError extends Error {
  readonly code = 'INVOICE_DATE_NOT_DELIVERY_DATE';

  constructor(
    readonly invoiceDate: string,
    readonly deliveryDate: string,
  ) {
    super(
      `An A/R Invoice is issued on the same date as the delivery (§7.4). ` +
        `The Delivery Note is dated ${deliveryDate} and this invoice ${invoiceDate}. ` +
        'Issue it on the delivery date, or reverse the delivery and deliver again on the date you mean — ' +
        'the two dates decide one period, and the cost and the revenue of a sale belong in the same one.',
    );
    this.name = 'InvoiceDateMismatchError';
  }
}

/**
 * §7.4 and Appendix C — *"Same delivery and invoice date."*
 *
 * An equality rather than a tolerance. A "within a day or two" rule would be a
 * rule about when somebody got round to it, and the reason the clause exists is
 * that the cost posted on the delivery date: an invoice a week later puts the
 * revenue in a different month from its own cost of sale, and the gross margin
 * of both months is then wrong.
 */
export function assertInvoiceDateMatchesDelivery(
  invoiceDate: string,
  deliveryDate: string,
): void {
  if (invoiceDate !== deliveryDate) {
    throw new InvoiceDateMismatchError(invoiceDate, deliveryDate);
  }
}

// ---------------------------------------------------------------------------
// §7.7 — invoiced quantities reconcile to what was delivered
// ---------------------------------------------------------------------------

export interface InvoicePosition {
  readonly delivered: bigint;
  readonly alreadyInvoiced: bigint;
}

export class OverInvoiceError extends Error {
  readonly code = 'OVER_INVOICE';

  constructor(
    readonly itemCode: string,
    readonly delivered: bigint,
    readonly alreadyInvoiced: bigint,
    readonly invoicing: bigint,
  ) {
    const remaining = delivered - alreadyInvoiced;
    super(
      `Invoicing ${formatQuantity(invoicing)} of ${itemCode} would bill more than was delivered. ` +
        `Delivered: ${formatQuantity(delivered)}; already invoiced: ${formatQuantity(alreadyInvoiced)}; ` +
        `still to invoice: ${formatQuantity(remaining > 0n ? remaining : 0n)}. ` +
        'A customer is billed for what they received (§7.7).',
    );
    this.name = 'OverInvoiceError';
  }
}

/**
 * Cumulative, like every other quantity control in this chain: one delivery may
 * be billed by more than one invoice, and it is the last of them that is too
 * large rather than any one on its own.
 *
 * Under-invoicing is not an error — a delivery may be billed in stages, and the
 * outstanding balance is what says so.
 */
export function assertWithinDelivered(
  itemCode: string,
  position: InvoicePosition,
  invoicing: bigint,
): void {
  if (invoicing <= 0n) {
    throw new RangeError(
      `An invoiced quantity must be positive. A delivery line that is not being billed is left off the invoice (${itemCode}).`,
    );
  }

  if (position.alreadyInvoiced + invoicing > position.delivered) {
    throw new OverInvoiceError(
      itemCode,
      position.delivered,
      position.alreadyInvoiced,
      invoicing,
    );
  }
}

export function outstandingInvoicing(position: {
  readonly delivered: bigint;
  readonly invoiced: bigint;
}): bigint {
  const remaining = position.delivered - position.invoiced;
  return remaining > 0n ? remaining : 0n;
}

// ---------------------------------------------------------------------------
// Settlement — Appendix B's Partially Paid and Paid
// ---------------------------------------------------------------------------

export class OverAllocationError extends Error {
  readonly code = 'OVER_ALLOCATION';

  constructor(
    readonly invoiceNo: string,
    readonly total: bigint,
    readonly allocated: bigint,
  ) {
    super(
      `Allocating ${toDecimalString(allocated, 4n)} to invoice ${invoiceNo} exceeds its balance of ` +
        `${toDecimalString(total, 4n)}. Money received beyond an invoice is a customer credit, ` +
        'not a larger invoice — allocate the excess to another open item or leave it unapplied (§15).',
    );
    this.name = 'OverAllocationError';
  }
}

/**
 * Appendix B — *Posted, Partially Paid, Paid*, in §3.2's vocabulary.
 *
 * Derived from the money rather than set by whoever recorded the receipt, so an
 * invoice cannot be marked paid while a balance remains. The comparison is
 * `>=` for the same reason the delivery's is: an allocation that rounds to the
 * last dinar should close the invoice, not leave it one unit short forever.
 */
export function settlementStatusFor(input: {
  readonly totalIqd: bigint;
  readonly allocatedIqd: bigint;
}): 'posted' | 'partially_executed' | 'settled' {
  if (input.allocatedIqd <= 0n) return 'posted';
  return input.allocatedIqd >= input.totalIqd ? 'settled' : 'partially_executed';
}

export function assertWithinBalance(
  invoiceNo: string,
  input: { readonly totalIqd: bigint; readonly allocatedIqd: bigint },
  allocating: bigint,
): void {
  if (allocating <= 0n) {
    throw new RangeError(`An allocation to ${invoiceNo} must be positive.`);
  }

  if (input.allocatedIqd + allocating > input.totalIqd) {
    throw new OverAllocationError(invoiceNo, input.totalIqd, input.allocatedIqd + allocating);
  }
}

/** What is still owed on an invoice. Never negative. */
export function openBalance(input: {
  readonly totalIqd: bigint;
  readonly allocatedIqd: bigint;
}): bigint {
  const remaining = input.totalIqd - input.allocatedIqd;
  return remaining > 0n ? remaining : 0n;
}
