/**
 * §7.2 picking rules — Phase 06.4.
 *
 * The Pick List is the one step in the sales chain with **no** accounting or
 * inventory effect (Appendix B: *Operational*). Nothing has moved and nothing is
 * owed; what has happened is that a person has been told which units to take off
 * which shelf, and has come back and said which ones they took.
 *
 * That makes the rules here small and almost entirely about identity: which
 * specific serials and batches were picked. Getting that wrong is not a rounding
 * problem, it is a traceability problem — §9.9 requires a serial to be followable
 * from receipt to delivery, and the pick is where the chain would break, because
 * it is the first point at which a *particular* unit is chosen for a *particular*
 * customer.
 *
 * Pure: no SQL, no clock. Quantities are scaled integers at 10^6, as everywhere.
 */
import { QUANTITY_FACTOR, formatQuantity as format } from './uom';

/** A promise of stock that a pick is drawing down. */
export interface ReservationPosition {
  readonly reserved: bigint;
  /** Picked on earlier pick lists against the same order line. */
  readonly alreadyPicked: bigint;
}

export class PickExceedsReservationError extends Error {
  readonly code = 'PICK_EXCEEDS_RESERVATION';

  constructor(
    readonly itemCode: string,
    readonly reserved: bigint,
    readonly alreadyPicked: bigint,
    readonly picking: bigint,
  ) {
    const available = reserved - alreadyPicked;
    super(
      `Picking ${format(picking)} of ${itemCode} would exceed the stock reserved for this order. ` +
        `Reserved: ${format(reserved)}; already picked: ${format(alreadyPicked)}; ` +
        `available to pick: ${format(available > 0n ? available : 0n)}. ` +
        'Reserve more stock on the Sales Order, or pick the quantity that is reserved.',
    );
    this.name = 'PickExceedsReservationError';
  }
}

/**
 * §7.4 — *"Stock is reserved automatically when the Sales Order is approved"*,
 * and the pick is the draw-down of that reservation.
 *
 * Judged **cumulatively** across pick lists, for the same reason an over-receipt
 * is: two pick lists of 40 against a reservation of 60 is an over-pick on the
 * second, and neither is one on its own.
 *
 * Picking *less* than was reserved is ordinary — the picker found six of the ten
 * and the rest is a shortfall for the warehouse to chase. Only the excess is an
 * error, because stock picked beyond the reservation is stock promised to
 * somebody else's order.
 */
export function assertWithinReservation(
  itemCode: string,
  position: ReservationPosition,
  picking: bigint,
): void {
  if (picking <= 0n) {
    throw new RangeError(
      `A picked quantity must be positive. Nothing picked for ${itemCode} is recorded by leaving the line off the pick list, not by picking zero.`,
    );
  }

  if (position.alreadyPicked + picking > position.reserved) {
    throw new PickExceedsReservationError(
      itemCode,
      position.reserved,
      position.alreadyPicked,
      picking,
    );
  }
}

/** One identified unit — a serial, or a quantity out of a batch. */
export interface PickedUnit {
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly quantity: bigint;
}

export class PickIdentityMismatchError extends Error {
  readonly code = 'PICK_IDENTITY_MISMATCH';

  constructor(
    readonly itemCode: string,
    readonly picked: bigint,
    readonly identified: bigint,
  ) {
    super(
      `The serial and batch selections for ${itemCode} account for ${format(identified)} ` +
        `but ${format(picked)} was picked. ` +
        'Every unit of a tracked item must be identified at the pick, because the Delivery Note ' +
        'carries these selections through and §9.9 traces them from receipt to delivery. ' +
        (identified < picked
          ? 'Select the remaining units.'
          : 'Remove the selections that were not picked.'),
    );
    this.name = 'PickIdentityMismatchError';
  }
}

/**
 * What §9.3 says an item is identified by. `null` is an untracked item — a
 * service, or a stock item in a company that does not track it, which §9.3
 * forbids for stock but the column still permits for services.
 */
export type ItemTracking = 'serial' | 'batch' | 'serial_and_batch' | null;

function needsSerial(tracking: ItemTracking): boolean {
  return tracking === 'serial' || tracking === 'serial_and_batch';
}

function needsBatch(tracking: ItemTracking): boolean {
  return tracking === 'batch' || tracking === 'serial_and_batch';
}

export class UnidentifiedPickError extends Error {
  readonly code = 'PICK_IDENTITY_MISSING';

  constructor(
    readonly itemCode: string,
    readonly missing: readonly string[],
  ) {
    super(
      `The pick of ${itemCode} does not say ${missing.join(' or ')}. ` +
        'A tracked item is identified at the pick, because the Delivery Note carries the selection ' +
        'through and §9.9 traces it from receipt to delivery.',
    );
    this.name = 'UnidentifiedPickError';
  }
}

export class SerialQuantityError extends Error {
  readonly code = 'PICK_SERIAL_QUANTITY';

  constructor(readonly serialNumber: string) {
    super(
      `Serial ${serialNumber} was picked in a quantity other than one. ` +
        'A serial number identifies a single unit; two units are two serials.',
    );
    this.name = 'SerialQuantityError';
  }
}

export class DuplicateSerialPickError extends Error {
  readonly code = 'PICK_SERIAL_DUPLICATED';

  constructor(readonly serialNumber: string) {
    super(
      `Serial ${serialNumber} appears twice on this pick. ` +
        'One physical unit cannot be picked twice; check the scan.',
    );
    this.name = 'DuplicateSerialPickError';
  }
}

/**
 * The identity check — what the Delivery Note will inherit.
 *
 * 06.4's third gate is *"serial/batch selection at pick is carried through to
 * the Delivery Note"*, and carrying something through is only meaningful if it
 * was complete when captured. So this is checked at the pick rather than at the
 * delivery: a Delivery Note that discovered a missing serial would have to
 * reject a document the warehouse has already acted on.
 *
 * An untracked item takes no selections at all — not an empty list, which would
 * read as "we did not bother", but nothing to give.
 */
export function assertIdentitiesComplete(input: {
  readonly itemCode: string;
  readonly tracking: ItemTracking;
  readonly pickedQuantity: bigint;
  readonly units: readonly PickedUnit[];
}): void {
  const { itemCode, tracking, pickedQuantity, units } = input;

  if (!tracking) {
    if (units.length > 0) {
      throw new PickIdentityMismatchError(itemCode, 0n, sumOf(units));
    }
    return;
  }

  const wanted: string[] = [];
  if (needsSerial(tracking)) wanted.push('which serials were taken');
  if (needsBatch(tracking)) wanted.push('which batches they came from');

  if (units.length === 0) {
    throw new UnidentifiedPickError(itemCode, wanted);
  }

  const seenSerials = new Set<string>();

  for (const unit of units) {
    const serial = unit.serialNumber?.trim();
    const batch = unit.batchNumber?.trim();

    if (needsSerial(tracking) && !serial) throw new UnidentifiedPickError(itemCode, wanted);
    if (needsBatch(tracking) && !batch) throw new UnidentifiedPickError(itemCode, wanted);

    // A serial is one unit whether or not a batch is recorded beside it, so the
    // rule is on the serial rather than on the tracking mode.
    if (serial) {
      if (unit.quantity !== QUANTITY_FACTOR) throw new SerialQuantityError(serial);
      if (seenSerials.has(serial)) throw new DuplicateSerialPickError(serial);
      seenSerials.add(serial);
    }

    if (unit.quantity <= 0n) {
      throw new RangeError(
        `A pick selection for ${itemCode} must be a positive quantity. A unit that was not taken is left off the list.`,
      );
    }
  }

  const identified = sumOf(units);
  if (identified !== pickedQuantity) {
    throw new PickIdentityMismatchError(itemCode, pickedQuantity, identified);
  }
}

function sumOf(units: readonly PickedUnit[]): bigint {
  return units.reduce((total, unit) => total + unit.quantity, 0n);
}

/**
 * Whether the pick has taken everything it was asked for.
 *
 * Appendix B gives the Pick List five statuses and no partial one, so a
 * short pick is still *Picked* — the shortfall is a quantity on the line, not a
 * state of the document. This function is what tells the warehouse there is one.
 */
export function pickShortfall(input: {
  readonly requested: bigint;
  readonly picked: bigint;
}): bigint {
  const short = input.requested - input.picked;
  return short > 0n ? short : 0n;
}

