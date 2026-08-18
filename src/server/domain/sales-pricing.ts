/**
 * Sales line pricing and discount — Phase 06.1, §7.3.
 *
 * > *"Unit prices are retrieved from the customer's linked Price List and cannot
 * > be edited in the Sales Order."*
 * > *"Discounts are allowed only at line level."*
 * > §7.7: *"Price List controls cannot be bypassed through the UI or API."*
 *
 * **The price is not an input.** The strongest reading of §7.3 — and the only one
 * §7.7 can be satisfied by — is that a sales order line has no unit-price field
 * to submit. A field that is validated can be bypassed by whatever route the
 * validation was not written for; a field that does not exist cannot. So
 * `SalesLineInput` carries no price, the service resolves it from the price list
 * effective on the order date, and "a price override submitted via the API is
 * rejected" holds because there is nothing to submit it in.
 *
 * **The discount is the negotiable part, and it is per line.** §7.3 allows it
 * there and nowhere else: a header discount would be a second way to change the
 * money, applied after the line prices were locked, and the price-list control
 * would mean very little.
 *
 * Money is scaled at 10^4, quantities at 10^6, percentages at 10^4.
 */

const QUANTITY_SCALE = 1_000_000n;
const PERCENT_SCALE = 10_000n;

export class SalesDiscountError extends Error {
  readonly code = 'SALES_DISCOUNT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'SalesDiscountError';
  }
}

export interface LineDiscount {
  /** Percentage off the gross, scaled at 10^4. '12.5' is 125000. */
  readonly percent?: bigint;
  /** A flat amount off the gross, scaled at 10^4. */
  readonly amountIqd?: bigint;
}

export interface PricedLine {
  /** Scaled at 10^6. */
  readonly quantity: bigint;
  /** From the price list. Scaled at 10^4. Never supplied by the caller. */
  readonly unitPriceIqd: bigint;
  readonly discount?: LineDiscount;
}

export interface LineTotals {
  /** quantity × unit price. */
  readonly grossIqd: bigint;
  /** What the discount takes off, whichever way it was expressed. */
  readonly discountIqd: bigint;
  /** gross − discount. What the customer is charged for this line. */
  readonly netIqd: bigint;
  /** The effective unit price after discount, for display. Scaled at 10^4. */
  readonly netUnitPriceIqd: bigint;
}

/** `quantity × unitPrice`, keeping money's scale. One operation, no rounding. */
export function grossOf(quantity: bigint, unitPriceIqd: bigint): bigint {
  return (quantity * unitPriceIqd) / QUANTITY_SCALE;
}

/**
 * §7.3 — what a line comes to, after its discount.
 *
 * A percentage and an amount are both allowed, but **not together**: two ways of
 * saying the same thing invites the question of which applies first, and the two
 * orders give different answers. One or the other, and the arithmetic is then
 * reproducible from the document.
 *
 * A discount larger than the line is refused rather than clamped. Clamping would
 * turn a keying error — a percentage typed in the amount field — into a free
 * line, silently.
 */
export function totalsFor(line: PricedLine): LineTotals {
  if (line.quantity <= 0n) {
    throw new SalesDiscountError('A sales line for no quantity has nothing to price.');
  }
  if (line.unitPriceIqd < 0n) {
    throw new SalesDiscountError('A negative unit price is not a price.');
  }

  const gross = grossOf(line.quantity, line.unitPriceIqd);
  const discount = line.discount ?? {};

  const hasPercent = discount.percent !== undefined && discount.percent !== 0n;
  const hasAmount = discount.amountIqd !== undefined && discount.amountIqd !== 0n;

  if (hasPercent && hasAmount) {
    throw new SalesDiscountError(
      'A line takes a discount percentage or a discount amount, not both (§7.3). ' +
        'Two ways of saying it would leave the order of application undecided, and the two orders give different answers.',
    );
  }

  let discountIqd = 0n;

  if (hasPercent) {
    const percent = discount.percent!;
    if (percent < 0n) {
      throw new SalesDiscountError(
        'A negative discount is a surcharge. Prices come from the price list (§7.3); ' +
          'if the customer is being charged more, the price list is what changes.',
      );
    }
    if (percent > 100n * PERCENT_SCALE) {
      throw new SalesDiscountError('A discount of more than 100% would pay the customer to buy.');
    }
    discountIqd = (gross * percent) / (100n * PERCENT_SCALE);
  }

  if (hasAmount) {
    const amount = discount.amountIqd!;
    if (amount < 0n) {
      throw new SalesDiscountError(
        'A negative discount is a surcharge. Prices come from the price list (§7.3).',
      );
    }
    if (amount > gross) {
      throw new SalesDiscountError(
        'The discount is larger than the line. Check whether a percentage has been typed into the amount field — ' +
          'a clamped discount would turn that mistake into a free line without anybody noticing.',
      );
    }
    discountIqd = amount;
  }

  const netIqd = gross - discountIqd;

  return {
    grossIqd: gross,
    discountIqd,
    netIqd,
    // Back out the effective unit price for the screen. Truncating is right:
    // the *line* total is the authority, and a displayed unit price that
    // multiplied back up to more than the line would be worse than one that
    // multiplied to slightly less.
    netUnitPriceIqd: (netIqd * QUANTITY_SCALE) / line.quantity,
  };
}

/** A document's total, from its lines. */
export function documentTotals(lines: readonly PricedLine[]): LineTotals {
  const totals = lines.map(totalsFor);
  const sum = (pick: (t: LineTotals) => bigint) =>
    totals.reduce((total, line) => total + pick(line), 0n);

  const grossIqd = sum((t) => t.grossIqd);
  const discountIqd = sum((t) => t.discountIqd);
  const netIqd = sum((t) => t.netIqd);
  const quantity = lines.reduce((total, line) => total + line.quantity, 0n);

  return {
    grossIqd,
    discountIqd,
    netIqd,
    netUnitPriceIqd: quantity > 0n ? (netIqd * QUANTITY_SCALE) / quantity : 0n,
  };
}

export { QUANTITY_SCALE, PERCENT_SCALE };
