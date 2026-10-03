/**
 * Exact arithmetic on the decimal strings the database returns, for the few
 * figures a print computes the way its screen does — a line's Total Price is
 * quantity × unit price − discount, a statement's running balance is the sum
 * so far. Scaled integers, never floats, so a printed total cannot differ from
 * the ledger by a rounding the screen never made.
 */

/** Parse at `scale` places, rounding half away from zero past it. */
export function scaled(value: string | null | undefined, scale: bigint): bigint {
  if (value === null || value === undefined || value.trim() === '') return 0n;
  const match = /^(-?)(\d*)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) throw new RangeError(`Not a decimal value: "${value}"`);
  const [, sign, whole = '0', fraction = ''] = match;
  const places = Number(scale);
  const kept = fraction.slice(0, places).padEnd(places, '0');
  let result = BigInt(`${whole || '0'}${kept}`);
  if (fraction.length > places && Number(fraction[places]) >= 5) result += 1n;
  return sign === '-' ? -result : result;
}

export function decimalString(value: bigint, scale: bigint): string {
  const factor = 10n ** scale;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = (abs % factor).toString().padStart(Number(scale), '0');
  return `${negative ? '-' : ''}${abs / factor}.${fraction}`;
}

const MONEY = 4n;
const QUANTITY = 6n;

/** A sum of money strings, as a money string. */
export function sumMoney(values: readonly (string | null | undefined)[]): string {
  return decimalString(
    values.reduce((total: bigint, value) => total + scaled(value, MONEY), 0n),
    MONEY,
  );
}

/** A sum of quantities, as a quantity string. */
export function sumQuantity(values: readonly (string | null | undefined)[]): string {
  return decimalString(
    values.reduce((total: bigint, value) => total + scaled(value, QUANTITY), 0n),
    QUANTITY,
  );
}

/** quantity × unit price − discount, to the fils. */
export function lineTotal(quantity: string, unitPrice: string, discount: string | null): string {
  const product = scaled(quantity, QUANTITY) * scaled(unitPrice, MONEY); // 10 places
  const factor = 10n ** QUANTITY;
  const half = factor / 2n;
  const rounded = product >= 0n ? (product + half) / factor : -((-product + half) / factor);
  return decimalString(rounded - scaled(discount, MONEY), MONEY);
}

/** total ÷ quantity, to four places — Opening Stock's Average Unit Price. */
export function average(total: string, quantity: string): string | null {
  const q = scaled(quantity, QUANTITY);
  if (q <= 0n) return null;
  // total (4 places) × 10^6 ÷ quantity (6 places) keeps 4 places.
  const numerator = scaled(total, MONEY) * 10n ** QUANTITY;
  const rounded = (numerator * 2n + q) / (2n * q);
  return decimalString(rounded, MONEY);
}

export function isZero(value: string | null | undefined): boolean {
  return scaled(value, MONEY) === 0n;
}
