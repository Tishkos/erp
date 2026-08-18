/**
 * §8.4 — the quantity tolerance an over-receipt is judged against.
 *
 * Pure, because the judgement is arithmetic and the arithmetic is the part that
 * can be wrong in ways nobody notices: a tolerance computed in floating point
 * accepts 100.00000000001 units against 100 ordered with a zero tolerance, and
 * the receipt that should have gone to a manager does not.
 *
 * Everything here is scaled integers. Quantities carry six decimal places
 * (`numeric(24,6)`), percentages four (`numeric(9,4)`).
 */
import { parseDecimal } from './money';

/** Quantities are scaled at 10^6. */
const QUANTITY_SCALE = 1_000_000n;

/** Percentages are scaled at 10^4 — 2.5% is 25000. */
const PERCENT_SCALE = 10_000n;

/**
 * The most that may be received against a line, given a tolerance percentage.
 *
 * `ordered × (100% + tolerance)`, done as one integer multiplication before the
 * single division, so 2.5% of 100 units is exactly 102.5 rather than 102.499999.
 * The division truncates, which errs towards *needing* a manager — the safe
 * direction, since the alternative is accepting stock nobody approved.
 */
export function allowedQuantity(ordered: bigint, tolerancePercent: string): bigint {
  if (ordered < 0n) {
    throw new RangeError('An ordered quantity cannot be negative.');
  }

  const scaledPercent = parseDecimal(tolerancePercent, 4n);

  if (scaledPercent < 0n) {
    throw new RangeError(
      `A receipt tolerance of ${tolerancePercent}% would allow less than was ordered. ` +
        'Under-receipt is normal and needs no tolerance; the tolerance is for what arrives over.',
    );
  }

  const hundredPercent = 100n * PERCENT_SCALE;
  return (ordered * (hundredPercent + scaledPercent)) / hundredPercent;
}

/**
 * Whether this delivery takes the line beyond what may be received.
 *
 * Judged on the **cumulative** quantity, not on this delivery alone: three
 * deliveries of 40 against 100 ordered is an over-receipt on the third, even
 * though no single one of them is.
 */
export function isOverReceipt(input: {
  readonly ordered: bigint;
  readonly alreadyReceived: bigint;
  readonly arriving: bigint;
  readonly tolerancePercent: string;
}): boolean {
  return (
    input.alreadyReceived + input.arriving > allowedQuantity(input.ordered, input.tolerancePercent)
  );
}

/**
 * What is still expected on a line.
 *
 * Over-receipt reports zero outstanding rather than a negative number, because
 * "−4 still to come" reads to a warehouse clerk as an instruction to send four
 * back — which is a Goods Return (§8.8), a different document with a different
 * accounting effect.
 */
export function outstandingQuantity(input: {
  readonly ordered: bigint;
  readonly received: bigint;
  readonly closed: bigint;
}): { readonly outstanding: bigint; readonly overReceived: bigint } {
  const remaining = input.ordered - input.received - input.closed;
  return {
    outstanding: remaining > 0n ? remaining : 0n,
    overReceived: remaining < 0n ? -remaining : 0n,
  };
}

/** A line is complete when nothing further is expected — received or closed. */
export function isLineComplete(input: {
  readonly ordered: bigint;
  readonly received: bigint;
  readonly closed: bigint;
}): boolean {
  return input.received + input.closed >= input.ordered;
}

export { QUANTITY_SCALE, PERCENT_SCALE };
