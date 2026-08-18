/**
 * Units of measure and quantity conversion — Phase 03.3.
 *
 * §9.3: "Base UOM, Purchase UOM, Sales UOM, conversion factors, barcodes by
 * UOM."
 *
 * The 03.3 gate is the whole design brief: "UOM conversion round-trips exactly:
 * convert to purchase UOM and back yields the original quantity with no drift."
 *
 * ── Why a fraction and not a factor ─────────────────────────────────────────
 * A box of three stored as 0.333333 loses a unit every few thousand
 * conversions, and inventory is the one place where a lost unit is eventually
 * counted by a human standing in a warehouse. Held as numerator over
 * denominator, a conversion is exact in both directions because it is never
 * evaluated as a decimal: `qty × n / d` and then `× d / n` cancel.
 *
 * Quantities are scaled integers, like money — six decimal places, because
 * §9.3 allows fractional units and a kilogram divided into grams needs three,
 * with room left for a conversion that lands between them.
 */

/** Decimal places on a quantity. */
export const QUANTITY_SCALE = 6n;
export const QUANTITY_FACTOR = 10n ** QUANTITY_SCALE;

export interface UomConversion {
  readonly uomCode: string;
  /** One unit of this UOM equals numerator/denominator base units. */
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export class UomConversionError extends Error {
  readonly code = 'UOM_CONVERSION_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'UomConversionError';
  }
}

export class InexactConversionError extends Error {
  readonly code = 'UOM_CONVERSION_INEXACT';

  constructor(
    readonly quantity: string,
    readonly fromUom: string,
    readonly toUom: string,
  ) {
    super(
      `${quantity} ${fromUom} is not a whole number of ${toUom}. ` +
        'Enter the quantity in a unit it divides into, or in the base unit.',
    );
    this.name = 'InexactConversionError';
  }
}

export function assertConversionUsable(conversion: UomConversion): void {
  if (conversion.numerator <= 0n || conversion.denominator <= 0n) {
    throw new UomConversionError(
      `Conversion for ${conversion.uomCode} must be positive on both sides, received ` +
        `${conversion.numerator}/${conversion.denominator}.`,
    );
  }
}

/**
 * Converts a quantity into base units.
 *
 * Exact when the result lands on the quantity scale, which it does for every
 * conversion whose denominator divides the scale — every integer factor, and
 * every fraction with a denominator of 2, 5, 10 and their products. Anything
 * else is rounded half-up and `toBaseExact` is the way to refuse instead.
 */
export function toBase(quantity: bigint, conversion: UomConversion): bigint {
  assertConversionUsable(conversion);
  return divideHalfUp(quantity * conversion.numerator, conversion.denominator);
}

/** Converts a base quantity into the given UOM. */
export function fromBase(baseQuantity: bigint, conversion: UomConversion): bigint {
  assertConversionUsable(conversion);
  return divideHalfUp(baseQuantity * conversion.denominator, conversion.numerator);
}

/**
 * `toBase`, refusing rather than rounding.
 *
 * Used where a rounded quantity would be a real-world impossibility: you cannot
 * receive 2.5 of an indivisible box, and silently making it 3 is how stock
 * counts stop matching shelves.
 */
export function toBaseExact(quantity: bigint, conversion: UomConversion, toUomLabel = 'base'): bigint {
  assertConversionUsable(conversion);
  const numerator = quantity * conversion.numerator;

  if (numerator % conversion.denominator !== 0n) {
    throw new InexactConversionError(
      formatQuantity(quantity),
      conversion.uomCode,
      toUomLabel,
    );
  }

  return numerator / conversion.denominator;
}

/**
 * Converts between two units of the same item, through the base.
 *
 * Round-trips exactly: `convert(convert(q, a, b), b, a)` returns `q` whenever
 * the intermediate lands on the scale, which is the 03.3 gate.
 */
export function convert(
  quantity: bigint,
  from: UomConversion,
  to: UomConversion,
): bigint {
  assertConversionUsable(from);
  assertConversionUsable(to);

  // One expression, so the intermediate never rounds: q × (fn/fd) × (td/tn).
  return divideHalfUp(
    quantity * from.numerator * to.denominator,
    from.denominator * to.numerator,
  );
}

function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const rounded = (n % d) * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Parses a decimal quantity string to a scaled integer. */
export function parseQuantity(input: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new UomConversionError(`Not a quantity: "${input}"`);
  }

  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > Number(QUANTITY_SCALE)) {
    throw new UomConversionError(
      `"${input}" has ${fraction.length} decimal places, more than the ${QUANTITY_SCALE} permitted.`,
    );
  }

  const scaled = BigInt(`${whole}${fraction.padEnd(Number(QUANTITY_SCALE), '0')}`);
  return sign === '-' ? -scaled : scaled;
}

export function formatQuantity(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / QUANTITY_FACTOR;
  const fraction = (abs % QUANTITY_FACTOR)
    .toString()
    .padStart(Number(QUANTITY_SCALE), '0')
    .replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ---------------------------------------------------------------------------
// Item rules — §9.2, §9.3
// ---------------------------------------------------------------------------

/** §9.3 — serial, batch, or both. */
export const ITEM_TRACKING = ['serial', 'batch', 'serial_and_batch'] as const;
export type ItemTracking = (typeof ITEM_TRACKING)[number];

/** §9.2 — "FIFO is the single valuation method for every item and warehouse." */
export const COSTING_METHODS = ['fifo'] as const;
export type CostingMethod = (typeof COSTING_METHODS)[number];

export class ItemDefinitionError extends Error {
  readonly code = 'ITEM_DEFINITION_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'ItemDefinitionError';
  }
}

export class ItemInactiveError extends Error {
  readonly code = 'ITEM_INACTIVE';
  constructor(
    readonly itemCode: string,
    readonly documentDate: string,
    readonly inactiveFrom: string,
  ) {
    super(
      `Item ${itemCode} is inactive from ${inactiveFrom} and cannot be used on a document dated ${documentDate}.`,
    );
    this.name = 'ItemInactiveError';
  }
}

export interface ItemDefinition {
  readonly code: string;
  readonly isStock: boolean;
  readonly tracking: ItemTracking | null;
  readonly costingMethod: CostingMethod;
  readonly active: boolean;
  readonly inactiveFrom?: string | null;
}

/**
 * §9.3 — "No-tracking is not allowed."
 *
 * A stock item without serial or batch tracking cannot be traced to a delivery,
 * a warranty claim or a recall. §9.3 removes the option rather than making it a
 * default, and so does this.
 */
export function assertItemDefinition(item: ItemDefinition): void {
  if (item.isStock && !item.tracking) {
    throw new ItemDefinitionError(
      `Stock item ${item.code} must use serial tracking, batch tracking, or both. ` +
        'No-tracking is not allowed (§9.3).',
    );
  }

  if (!item.isStock && item.tracking) {
    throw new ItemDefinitionError(
      `${item.code} is a service and cannot carry ${item.tracking} tracking — there is nothing to track.`,
    );
  }

  if (item.costingMethod !== 'fifo') {
    throw new ItemDefinitionError(
      `Item ${item.code} must be valued FIFO. §9.2 makes it the single valuation method for every item and warehouse.`,
    );
  }
}

/** Appendix B — "inactive-date enforcement", judged by the document's date. */
export function assertItemUsableOn(item: ItemDefinition, documentDate: string): void {
  if (!item.active) {
    throw new ItemInactiveError(item.code, documentDate, 'deactivation');
  }

  if (item.inactiveFrom && documentDate >= item.inactiveFrom) {
    throw new ItemInactiveError(item.code, documentDate, item.inactiveFrom);
  }
}
