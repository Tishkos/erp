/**
 * Three-way match — Phase 05.4, §8.4.
 *
 * > *"Three-Way Matching is mandatory. Quantity, price and value variances are
 * > allowed only after manager approval."*
 *
 * The three documents are the purchase order (what was agreed), the receipt
 * (what arrived) and the supplier's invoice (what is being charged). Matching
 * them is the control that stops the company paying for goods it did not get,
 * at a price it did not agree.
 *
 * **Three variances, not one, because they answer different questions.**
 *
 * | Variance | Question | Cause |
 * |---|---|---|
 * | Quantity | Are we being billed for more than arrived? | Short delivery, or a supplier billing the order rather than the delivery |
 * | Price | Is the unit price the one we agreed? | A price rise the buyer did not accept, or the wrong price list |
 * | Value | How much money is actually at stake? | Either of the above, or both partly cancelling |
 *
 * The first two are the *causes* and the third is the *effect*. A manager asked
 * to approve a variance needs both: what differs, and what it costs. Reporting
 * only the value would hide a large quantity error offset by a price credit;
 * reporting only the causes would leave the manager doing arithmetic.
 *
 * **Everything is exact-decimal integers.** Money is scaled at 10^4 and
 * quantities at 10^6, so a zero tolerance is a workable rule rather than an
 * invitation to rounding noise — 3 × 33.333333 is exactly what it is, and the
 * match does not fail on a floating-point remainder nobody can see.
 */

/** Quantities carry six decimal places (`numeric(24,6)`). */
const QUANTITY_SCALE = 1_000_000n;

/** Money carries four (`numeric(19,4)`). */
const MONEY_SCALE = 10_000n;

/** Percentages carry four (`numeric(9,4)`) — 2.5% is 25000. */
const PERCENT_SCALE = 10_000n;

export const VARIANCE_KINDS = ['quantity', 'price', 'value'] as const;
export type VarianceKind = (typeof VARIANCE_KINDS)[number];

/** Appendix B gives the A/P Invoice both a Matched and an Exception status. */
export type MatchStatus = 'matched' | 'exception';

export interface MatchTolerance {
  /** Percentage of the received quantity that may be over-invoiced. */
  readonly quantityPercent: string;
  /** Percentage the unit price may exceed the ordered price by. */
  readonly pricePercent: string;
  /** Percentage the line value may exceed the received-at-ordered-price value by. */
  readonly valuePercent: string;
}

/**
 * §8.4 read literally: *"variances are allowed only after manager approval."*
 *
 * Zero, therefore, until Finance says otherwise. The tolerance exists as
 * configuration so that relaxing it is a business decision rather than a code
 * change — but nothing is relaxed by default, because the blueprint allows no
 * variance without a manager and a default that quietly permitted one would be
 * the implementation team deciding what "small" means.
 */
export const NO_TOLERANCE: MatchTolerance = Object.freeze({
  quantityPercent: '0',
  pricePercent: '0',
  valuePercent: '0',
});

export interface MatchLineInput {
  /** What the purchase order committed to. */
  readonly ordered: { readonly quantity: bigint; readonly unitPriceIqd: bigint };
  /**
   * What arrived — a goods receipt for stock (§8.4), or a service
   * confirmation for anything else (§8.6). The match does not care which; it
   * cares that somebody outside Finance said it was delivered.
   */
  readonly received: { readonly quantity: bigint };
  /** What the supplier is charging. */
  readonly invoiced: { readonly quantity: bigint; readonly unitPriceIqd: bigint };
  /**
   * What earlier posted invoices have already charged for this ordered line.
   *
   * Without it, three invoices of 40 against a delivery of 100 each look
   * innocent and together over-bill by 20. The match has to be cumulative for
   * the same reason the receipt tolerance is (§8.4).
   */
  readonly alreadyInvoiced?: bigint;
  readonly tolerance?: MatchTolerance;
}

export interface Variance {
  readonly kind: VarianceKind;
  /** What the matched documents say it should be. */
  readonly expected: bigint;
  /** What the invoice says. */
  readonly actual: bigint;
  /** actual − expected. Positive means the supplier is charging more. */
  readonly difference: bigint;
  /** Scaled at 10^4. Null when `expected` is zero — the ratio has no meaning. */
  readonly percent: bigint | null;
  /** Whether this variance is inside the configured tolerance. */
  readonly withinTolerance: boolean;
}

export interface MatchResult {
  readonly status: MatchStatus;
  readonly variances: readonly Variance[];
  /** Every variance, including the ones absorbed by tolerance. */
  readonly allVariances: readonly Variance[];
  /**
   * The money difference the ledger will have to carry if this invoice is
   * approved — the value variance, or zero when there is none. This is what
   * posts to the variance account rather than into inventory (§8.4).
   */
  readonly varianceValueIqd: bigint;
}

export class MatchInputError extends Error {
  readonly code = 'MATCH_INPUT_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'MatchInputError';
  }
}

const maxOf = (a: bigint, b: bigint) => (a > b ? a : b);

/** `a × b` where `b` is scaled at 10^4 and the result keeps that scale. */
function multiplyByPrice(quantity: bigint, unitPriceIqd: bigint): bigint {
  // quantity is scaled 10^6, price 10^4; the product is scaled 10^10 and the
  // answer wants 10^4, so divide by 10^6. Done as one operation to avoid
  // rounding the intermediate.
  return (quantity * unitPriceIqd) / QUANTITY_SCALE;
}

function parsePercent(value: string): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MatchInputError(`'${value}' is not a percentage.`);
  }
  const negative = trimmed.startsWith('-');
  const [whole = '0', fraction = ''] = trimmed.replace('-', '').split('.');
  const scaled = BigInt(whole) * PERCENT_SCALE + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  if (negative) {
    throw new MatchInputError(
      `A match tolerance of ${value}% would require the invoice to be *less* than the receipt. ` +
        'Under-invoicing needs no tolerance; the tolerance is for what the supplier charges over.',
    );
  }
  return scaled;
}

/** `expected × (1 + percent)`, in the same scale as `expected`. */
function ceilingFor(expected: bigint, percent: string): bigint {
  const scaled = parsePercent(percent);
  const hundred = 100n * PERCENT_SCALE;
  return (expected * (hundred + scaled)) / hundred;
}

/** `actual − expected` as a percentage of `expected`, scaled at 10^4. */
function percentDifference(expected: bigint, actual: bigint): bigint | null {
  if (expected === 0n) return null;
  const difference = actual - expected;
  return (difference * 100n * PERCENT_SCALE) / (expected < 0n ? -expected : expected);
}

function varianceOf(
  kind: VarianceKind,
  expected: bigint,
  actual: bigint,
  tolerancePercent: string,
): Variance | null {
  if (actual === expected) return null;

  return {
    kind,
    expected,
    actual,
    difference: actual - expected,
    percent: percentDifference(expected, actual),
    // Only an *over*-charge can be absorbed: a supplier billing less than was
    // delivered is a variance the company would be glad of, and it still has to
    // be seen, because it usually means a second invoice is coming.
    withinTolerance: actual < expected ? false : actual <= ceilingFor(expected, tolerancePercent),
  };
}

/**
 * Matches one invoice line against its order and its receipt.
 *
 * Returns every variance rather than throwing at the first, because §25 asks
 * for messages that name the field and the correction, and a manager deciding
 * whether to accept an invoice needs the whole picture at once.
 */
export function matchLine(input: MatchLineInput): MatchResult {
  const tolerance = input.tolerance ?? NO_TOLERANCE;

  // Validated before anything else, and for all three at once: a nonsensical
  // tolerance is a configuration error, and it should surface the moment the
  // configuration is used rather than on the first line that happens to vary —
  // which might be weeks later, on somebody else's invoice.
  parsePercent(tolerance.quantityPercent);
  parsePercent(tolerance.pricePercent);
  parsePercent(tolerance.valuePercent);

  if (input.invoiced.quantity <= 0n) {
    throw new MatchInputError('An invoice line for nothing cannot be matched against anything.');
  }
  if (input.ordered.quantity <= 0n) {
    throw new MatchInputError('A purchase order line for nothing cannot be matched.');
  }

  const all: Variance[] = [];
  const alreadyInvoiced = input.alreadyInvoiced ?? 0n;

  // 1 · Quantity — the invoice may bill for what arrived, not for what was
  //     ordered. This catches a supplier invoicing the whole order against a
  //     part delivery, which is the commonest error of all.
  //
  //     Only an *over*-bill is a variance. Invoicing 40 of a delivery of 100 is
  //     an ordinary partial invoice with the balance still to come — treating it
  //     as an exception would put a manager in front of every second invoice
  //     and teach them to approve without reading. The unbilled balance is
  //     visible in the GRNI account, which is where it belongs.
  const invoicedToDate = alreadyInvoiced + input.invoiced.quantity;
  const quantity =
    invoicedToDate > input.received.quantity
      ? varianceOf(
          'quantity',
          input.received.quantity,
          invoicedToDate,
          tolerance.quantityPercent,
        )
      : null;
  if (quantity) all.push(quantity);

  // 2 · Price — against the order, because the order is what was agreed. Never
  //     against the receipt, which carries no price of its own for exactly this
  //     reason (05.2: the FIFO layer is valued at the *ordered* price).
  const price = varianceOf(
    'price',
    input.ordered.unitPriceIqd,
    input.invoiced.unitPriceIqd,
    tolerance.pricePercent,
  );
  if (price) all.push(price);

  // 3 · Value — the money at stake, and the figure that posts.
  //
  //     What the company owes for *this* invoice is the quantity it is entitled
  //     to charge — the smaller of what is billed and what arrived — at the
  //     agreed price. Anything else is the difference, whether it came from the
  //     quantity, the price, or both partly cancelling.
  //
  //     Comparing against the whole received quantity instead would make every
  //     partial invoice look like a shortfall of money, which it is not: the
  //     rest is still owed and still sitting in GRNI.
  const entitled =
    input.invoiced.quantity < input.received.quantity - alreadyInvoiced
      ? input.invoiced.quantity
      : maxOf(input.received.quantity - alreadyInvoiced, 0n);
  const expectedValue = multiplyByPrice(entitled, input.ordered.unitPriceIqd);
  const actualValue = multiplyByPrice(input.invoiced.quantity, input.invoiced.unitPriceIqd);
  const value = varianceOf('value', expectedValue, actualValue, tolerance.valuePercent);
  if (value) all.push(value);

  const blocking = all.filter((v) => !v.withinTolerance);

  return {
    status: blocking.length > 0 ? 'exception' : 'matched',
    variances: blocking,
    allVariances: all,
    // The difference that will hit the ledger if this is approved. Taken from
    // the value variance whether or not tolerance absorbed it: a tolerance
    // decides whether a manager is asked, never whether the money exists.
    varianceValueIqd: value ? value.difference : 0n,
  };
}

/**
 * §8.4 — *"Every A/P Invoice must be created from both a Purchase Order and
 * Goods Receipt, or from a Purchase Order and Service Receipt / Expense
 * Confirmation."*
 *
 * Separate from the variance arithmetic because it is a different kind of rule:
 * a missing receipt is not a variance to be approved, it is a document that
 * cannot be raised at all. A manager may accept a price rise; nobody may accept
 * an invoice for goods no one has confirmed arrived.
 */
export class NoReceiptError extends Error {
  readonly code = 'MATCH_NO_RECEIPT';
  constructor(
    readonly orderNo: string,
    readonly lineNo: number,
    readonly isInventory: boolean,
  ) {
    super(
      `Line ${lineNo} of ${orderNo} has nothing received against it, so it cannot be invoiced (§8.4). ` +
        (isInventory
          ? 'The warehouse records a Goods Receipt first.'
          : 'The benefiting department confirms the service first (§8.6).'),
    );
    this.name = 'NoReceiptError';
  }
}

/** Whether a line may be invoiced at all — the mandatory half of §8.4. */
export function canInvoice(received: { quantity: bigint }): boolean {
  return received.quantity > 0n;
}

/**
 * Rolls line results up to a document.
 *
 * An invoice is Matched only if every line is. One exception makes the whole
 * document an exception, because the document is what gets approved and posted
 * — approving nine good lines and leaving the tenth would post a half-invoice.
 */
export function matchDocument(lines: readonly MatchResult[]): {
  readonly status: MatchStatus;
  readonly varianceValueIqd: bigint;
  readonly exceptionCount: number;
} {
  const exceptions = lines.filter((line) => line.status === 'exception');
  return {
    status: exceptions.length > 0 ? 'exception' : 'matched',
    varianceValueIqd: lines.reduce((total, line) => total + line.varianceValueIqd, 0n),
    exceptionCount: exceptions.length,
  };
}

/**
 * A sentence a manager can act on, for one variance.
 *
 * §25: *"Validation messages identify the field, reason and corrective action."*
 * The numbers are formatted by the caller, which holds the scale conventions;
 * this decides what is worth saying.
 */
export function describeVariance(variance: Variance): string {
  const direction = variance.difference > 0n ? 'more than' : 'less than';

  switch (variance.kind) {
    case 'quantity':
      // Only an over-bill reaches here: a partial invoice is ordinary and
      // raises no quantity variance at all.
      return `The invoice bills for ${direction} was received, counting everything invoiced against this line so far. Check whether a delivery is missing, or the supplier has invoiced the whole order.`;
    case 'price':
      return variance.difference > 0n
        ? `The unit price is ${direction} the order agreed. Either the order is varied, or the supplier is asked to correct the invoice.`
        : `The unit price is ${direction} the order agreed. Confirm the lower price is intended before accepting it.`;
    case 'value':
      return `The line total is ${direction} the received goods at the agreed price. This is the amount that would post to the variance account (§8.4).`;
  }
}

export { QUANTITY_SCALE, MONEY_SCALE, PERCENT_SCALE };
