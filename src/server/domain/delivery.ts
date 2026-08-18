/**
 * §7.2 delivery rules — Phase 06.5.
 *
 * The Delivery Note is where a sale stops being a promise. Appendix B gives its
 * effect as **Inventory and COGS**, and Appendix C as *"Sales delivery and
 * invoice | Customer A/R; COGS | Sales Revenue; Inventory | Same delivery and
 * invoice date"* — so the date on this document decides the date on the
 * invoice, and the quantity on it decides what may be invoiced at all.
 *
 * Two families of rule live here, both pure:
 *
 *   **What may be delivered.** §7.2 supports *"partial deliveries and multiple
 *   deliveries from one Sales Order"*, which means every check is cumulative:
 *   no single delivery is too large, and the third one is.
 *
 *   **Proof of Delivery.** §7.2: *"Proof of Delivery shall capture recipient
 *   name, signature, attachments and delivery photos."* Capturing it is what
 *   makes a delivery provable afterwards, so it is checked when the note is
 *   marked Delivered rather than being a field somebody might fill in later.
 */
import { formatQuantity as format } from './uom';

// ---------------------------------------------------------------------------
// What may be delivered
// ---------------------------------------------------------------------------

/** An order line's delivery position. Quantities are scaled at 10^6. */
export interface DeliveryPosition {
  readonly ordered: bigint;
  readonly alreadyDelivered: bigint;
  /** What the warehouse actually picked and has in its hands. */
  readonly picked: bigint;
}

export class OverDeliveryError extends Error {
  readonly code = 'OVER_DELIVERY';

  constructor(
    readonly itemCode: string,
    readonly ordered: bigint,
    readonly alreadyDelivered: bigint,
    readonly delivering: bigint,
  ) {
    const remaining = ordered - alreadyDelivered;
    super(
      `Delivering ${format(delivering)} of ${itemCode} would exceed the Sales Order. ` +
        `Ordered: ${format(ordered)}; already delivered: ${format(alreadyDelivered)}; ` +
        `still to deliver: ${format(remaining > 0n ? remaining : 0n)}. ` +
        'A customer receives what they ordered; more than that is a new order, not a larger delivery (§7.7).',
    );
    this.name = 'OverDeliveryError';
  }
}

export class DeliveryExceedsPickError extends Error {
  readonly code = 'DELIVERY_EXCEEDS_PICK';

  constructor(
    readonly itemCode: string,
    readonly picked: bigint,
    readonly delivering: bigint,
  ) {
    super(
      `Delivering ${format(delivering)} of ${itemCode} when ${format(picked)} was picked. ` +
        'A delivery carries the units the warehouse took off the shelf; ' +
        'to send more, pick more first — otherwise the serials on the note are not the ones in the van (§9.9).',
    );
    this.name = 'DeliveryExceedsPickError';
  }
}

/**
 * §7.7 — *"reservation, delivery, invoice and receipt quantities reconcile to
 * the source Sales Order."*
 *
 * Cumulative, because §7.2 supports several deliveries against one order: two
 * deliveries of 60 against 100 ordered is an over-delivery on the second, and
 * neither is one alone.
 *
 * Under-delivering is not an error. A short delivery leaves the line open, and
 * the order is closed deliberately when the customer stops waiting — which is a
 * decision, not an arithmetic result.
 */
export function assertWithinOrdered(
  itemCode: string,
  position: DeliveryPosition,
  delivering: bigint,
): void {
  if (delivering <= 0n) {
    throw new RangeError(
      `A delivered quantity must be positive. A line that was not delivered is left off the note, not delivered as zero (${itemCode}).`,
    );
  }

  if (position.alreadyDelivered + delivering > position.ordered) {
    throw new OverDeliveryError(
      itemCode,
      position.ordered,
      position.alreadyDelivered,
      delivering,
    );
  }

  if (delivering > position.picked) {
    throw new DeliveryExceedsPickError(itemCode, position.picked, delivering);
  }
}

/** What is still owed on a line. Never negative — see `assertWithinOrdered`. */
export function outstandingDelivery(position: {
  readonly ordered: bigint;
  readonly delivered: bigint;
}): bigint {
  const remaining = position.ordered - position.delivered;
  return remaining > 0n ? remaining : 0n;
}

export function isLineDelivered(position: {
  readonly ordered: bigint;
  readonly delivered: bigint;
}): boolean {
  return position.delivered >= position.ordered;
}

/**
 * The Sales Order's status after a delivery — Appendix B's *Partially
 * Delivered* and *Delivered*, in §3.2's vocabulary.
 *
 * Derived from the lines rather than set by the delivery, so an order cannot
 * claim to be delivered while a line still owes something. `null` means nothing
 * has been delivered yet and the order's status is not this function's business.
 */
export function orderStatusAfterDelivery(
  lines: readonly { ordered: bigint; delivered: bigint }[],
): 'partially_executed' | 'executed' | null {
  if (lines.length === 0) return null;

  const anyDelivered = lines.some((line) => line.delivered > 0n);
  if (!anyDelivered) return null;

  return lines.every(isLineDelivered) ? 'executed' : 'partially_executed';
}

// ---------------------------------------------------------------------------
// Proof of Delivery — §7.2
// ---------------------------------------------------------------------------

/**
 * What §7.2 asks a Proof of Delivery to hold.
 *
 * `attachments` is the general document panel every record has (§21) and is not
 * required: a delivery may have a customs form or a gate pass attached to it, or
 * nothing. The other three are what make the delivery *provable*, and the
 * blueprint names them individually.
 */
export interface ProofOfDelivery {
  readonly recipientName?: string | null;
  readonly signatureAttachmentId?: string | null;
  readonly photoCount: number;
}

export class IncompleteProofOfDeliveryError extends Error {
  readonly code = 'POD_INCOMPLETE';

  constructor(readonly missing: readonly string[]) {
    super(
      `The Proof of Delivery is missing ${missing.join(', ')}. ` +
        '§7.2 requires a delivery to capture the recipient’s name, their signature and ' +
        'delivery photos. A delivery that cannot be proved is one the customer can deny ' +
        'receiving, and the A/R Invoice raised from it (§7.4) would have nothing behind it.',
    );
    this.name = 'IncompleteProofOfDeliveryError';
  }
}

/**
 * §7.2 — *"Proof of Delivery shall capture recipient name, signature,
 * attachments and delivery photos."*
 *
 * Read literally, and deliberately so: the clause is the blueprint's own
 * instruction rather than a judgement made here. If the company needs to accept
 * a delivery without a photo — a driver's phone that died, a dock with no
 * camera — that is a change request under §28.1 and not something the build
 * should quietly decide by leaving the check out.
 */
export function assertProofOfDeliveryComplete(pod: ProofOfDelivery): void {
  const missing: string[] = [];

  if (!pod.recipientName?.trim()) missing.push('the recipient’s name');
  if (!pod.signatureAttachmentId) missing.push('a signature');
  if (pod.photoCount < 1) missing.push('at least one delivery photo');

  if (missing.length > 0) throw new IncompleteProofOfDeliveryError(missing);
}

/** Whether a Proof of Delivery is complete, without throwing — for a screen. */
export function isProofOfDeliveryComplete(pod: ProofOfDelivery): boolean {
  try {
    assertProofOfDeliveryComplete(pod);
    return true;
  } catch {
    return false;
  }
}
