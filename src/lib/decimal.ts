/**
 * Decimal text as scaled integers, for the browser — REQ-HARDEN-001 HD8.
 *
 * A grid that shows a running total while the person types must not add
 * doubles: 0.1 + 0.2 is not 0.3, and a total that reads a fils off the posted
 * figure is a reconciliation nobody asked for. Quantities carry six places
 * and money four, as in the database; the arithmetic is on bigints and only
 * the final figure is turned back into a number for `Intl.NumberFormat`.
 */
export const MONEY_PLACES = 4;
export const QUANTITY_PLACES = 6;

/** Parses "1,234.5" to a bigint scaled by `places`; null when it is not a number yet. */
export function scaled(text: string, places: number): bigint | null {
  const clean = text.replace(/[,\s]/g, '');
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) return null;
  const [, sign, whole, fraction = ''] = match;
  const digits = (fraction + '0'.repeat(places)).slice(0, places);
  const value = BigInt((whole || '0') + digits);
  return sign === '-' ? -value : value;
}

/** quantity × unit price − discount, as money (4 places); null while a part is unreadable. */
export function lineTotal(quantity: string, unitPrice: string, discount = ''): bigint | null {
  const qty = scaled(quantity, QUANTITY_PLACES);
  const price = scaled(unitPrice, MONEY_PLACES);
  const off = discount.trim() === '' ? 0n : scaled(discount, MONEY_PLACES);
  if (qty === null || price === null || off === null) return null;
  return (qty * price) / 10n ** BigInt(QUANTITY_PLACES) - off;
}

/** A scaled bigint as a number, for formatting only — never for arithmetic. */
export function toNumber(value: bigint, places: number): number {
  return Number(value) / 10 ** places;
}

/** A scaled bigint as decimal text, exact. */
export function toText(value: bigint, places: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}
