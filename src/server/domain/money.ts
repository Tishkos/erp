/**
 * Money — the four-part tuple required by blueprint §24.
 *
 *   "All money fields store transaction currency amount, base currency amount,
 *    currency and rate/reference."
 *
 *   §1.1: "IQD is the primary transaction and ledger currency; USD values are
 *    reporting equivalents calculated using approved historical exchange rates."
 *
 * TECHSTACK.md A4 calls this the constraint that cannot be retrofitted. It lives
 * in the domain layer, has no framework imports, and is unit-testable in
 * isolation.
 *
 * ── Why strings, not numbers ────────────────────────────────────────────────
 * JavaScript numbers are IEEE-754 doubles. 0.1 + 0.2 !== 0.3. A ledger that
 * must balance to the unit cannot use them. Amounts are held as bigint minor
 * units scaled to 4 decimal places, matching the numeric(19,4) domain in
 * Postgres, and serialised as decimal strings at the boundary.
 */

/** Decimal places on money. Matches the money_amount domain: numeric(19,4). */
export const MONEY_SCALE = 4n;
/** Decimal places on FX rates. Matches the fx_rate domain: numeric(18,8). */
export const RATE_SCALE = 8n;

const MONEY_FACTOR = 10n ** MONEY_SCALE;
const RATE_FACTOR = 10n ** RATE_SCALE;

/** The primary ledger currency. §1.1 — not configurable at runtime. */
export const LEDGER_CURRENCY = 'IQD' as const;
/** The reporting currency. §1.1 — historical rate, never current. */
export const REPORTING_CURRENCY = 'USD' as const;

export type CurrencyCode = string & { readonly __brand: 'CurrencyCode' };

export function currency(code: string): CurrencyCode {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new RangeError(`Invalid currency code: ${code}. Expected three uppercase letters.`);
  }
  return code as CurrencyCode;
}

/**
 * An exchange rate, always expressed as **IQD per one USD**.
 *
 * The inverse (USD per IQD ≈ 0.000763) loses catastrophic precision at any
 * sane scale — at 4dp it rounds to 0.0008, a ~5% error on every reporting
 * figure. The direction is fixed by construction so it cannot be got wrong.
 */
export interface Rate {
  /** Scaled by RATE_SCALE. */
  readonly iqdPerUsd: bigint;
}

export function rate(iqdPerUsd: string): Rate {
  const scaled = parseDecimal(iqdPerUsd, RATE_SCALE);
  if (scaled <= 0n) {
    throw new RangeError(`Exchange rate must be positive, received ${iqdPerUsd}`);
  }
  return { iqdPerUsd: scaled };
}

/**
 * A monetary value as stored on every transaction line.
 *
 * `amountIqd` is the balancing amount — §14.3: "IQD is the primary balancing
 * currency. USD is a historical-rate reporting equivalent and does not replace
 * IQD ledger values."
 */
export interface Money {
  /** Amount in the transaction currency, scaled by MONEY_SCALE. */
  readonly amountTxn: bigint;
  readonly currency: CurrencyCode;
  /** Balancing amount in IQD, scaled by MONEY_SCALE. */
  readonly amountIqd: bigint;
  /** Reporting equivalent in USD at the historical rate, scaled by MONEY_SCALE. */
  readonly amountUsd: bigint;
  /** The historical rate used. Retained so reprints reproduce (§22). */
  readonly rate: Rate;
}

/**
 * Builds a Money value from an IQD amount and the historical rate.
 *
 * USD is derived, never entered — §2.3: reports are available in IQD or USD
 * "without changing the original transaction currency or ledger amount."
 */
export function fromIqd(amountIqd: string, atRate: Rate): Money {
  const iqd = parseDecimal(amountIqd, MONEY_SCALE);
  return {
    amountTxn: iqd,
    currency: currency(LEDGER_CURRENCY),
    amountIqd: iqd,
    amountUsd: convertIqdToUsd(iqd, atRate),
    rate: atRate,
  };
}

/** Builds a Money value from a foreign-currency amount plus its IQD equivalent. */
export function fromForeign(
  amountTxn: string,
  txnCurrency: string,
  amountIqd: string,
  atRate: Rate,
): Money {
  const iqd = parseDecimal(amountIqd, MONEY_SCALE);
  return {
    amountTxn: parseDecimal(amountTxn, MONEY_SCALE),
    currency: currency(txnCurrency),
    amountIqd: iqd,
    amountUsd: convertIqdToUsd(iqd, atRate),
    rate: atRate,
  };
}

/**
 * IQD → USD at the historical rate, half-up at the last retained digit.
 *
 * Half-up is chosen because it is the rounding a reviewer reproduces by hand.
 * The rule is stated here rather than left to the runtime, so that the ledger
 * and any report recomputing a figure agree exactly.
 */
function convertIqdToUsd(amountIqd: bigint, atRate: Rate): bigint {
  const numerator = amountIqd * RATE_FACTOR;
  return divideHalfUp(numerator, atRate.iqdPerUsd);
}

/**
 * Converts a foreign-currency amount into IQD at a published rate — Phase 02.3.
 *
 * `iqdPerUnit` is IQD per one unit of the transaction currency, scaled by
 * RATE_SCALE. For an IQD amount the rate is exactly 1 and this is the identity,
 * which is worth stating rather than special-casing: the ledger amount of an
 * IQD transaction is the transaction amount, at a rate of one, by definition.
 */
export function toIqd(amountTxn: bigint, iqdPerUnit: bigint): bigint {
  if (iqdPerUnit <= 0n) {
    throw new RangeError(`Exchange rate must be positive, received ${iqdPerUnit}`);
  }
  return divideHalfUp(amountTxn * iqdPerUnit, RATE_FACTOR);
}

/** The USD reporting equivalent of an IQD amount, at the historical rate (§1.1). */
export function toUsd(amountIqd: bigint, iqdPerUsd: bigint): bigint {
  if (iqdPerUsd <= 0n) {
    throw new RangeError(`Exchange rate must be positive, received ${iqdPerUsd}`);
  }
  return divideHalfUp(amountIqd * RATE_FACTOR, iqdPerUsd);
}

/** The rate of one, scaled — what IQD converts to IQD at. */
export const UNIT_RATE = RATE_FACTOR;

/** Integer division, half away from zero — the one rounding the books use. */
export function divideHalfUp(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Adds two Money values. Rejects mixed currencies rather than guessing. */
export function add(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new TypeError(
      `Cannot add ${a.currency} to ${b.currency}. Convert through the rate engine first.`,
    );
  }
  return {
    amountTxn: a.amountTxn + b.amountTxn,
    currency: a.currency,
    amountIqd: a.amountIqd + b.amountIqd,
    amountUsd: a.amountUsd + b.amountUsd,
    rate: a.rate,
  };
}

export function negate(m: Money): Money {
  return {
    amountTxn: -m.amountTxn,
    currency: m.currency,
    amountIqd: -m.amountIqd,
    amountUsd: -m.amountUsd,
    rate: m.rate,
  };
}

export function isZero(m: Money): boolean {
  return m.amountIqd === 0n;
}

/**
 * The balance check every journal must pass — §14.3, §24.
 * Debits and credits must net to exactly zero **in IQD**.
 */
export function balancesInIqd(lines: readonly Money[]): boolean {
  return lines.reduce((sum, line) => sum + line.amountIqd, 0n) === 0n;
}

/** Formats a scaled bigint as a decimal string for the database and API. */
export function toDecimalString(scaled: bigint, scale: bigint = MONEY_SCALE): string {
  const factor = 10n ** scale;
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const whole = abs / factor;
  const fraction = (abs % factor).toString().padStart(Number(scale), '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export const moneyToString = (m: Money): string => toDecimalString(m.amountIqd);

/**
 * Parses a decimal string to a scaled bigint.
 *
 * Rejects more precision than the scale allows rather than truncating silently.
 * A rounding decision belongs to a documented rule, not to a parser.
 */
export function parseDecimal(input: string, scale: bigint): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new RangeError(`Not a decimal value: "${input}"`);
  }
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > Number(scale)) {
    throw new RangeError(
      `"${input}" has ${fraction.length} decimal places, more than the ${scale} permitted. ` +
        'Round explicitly before constructing a value.',
    );
  }
  const padded = fraction.padEnd(Number(scale), '0');
  const scaled = BigInt(`${whole}${padded}`);
  return sign === '-' ? -scaled : scaled;
}

/**
 * A figure in a sentence somebody reads: thousands separated, trailing zeros
 * dropped, the currency said.
 *
 * `toDecimalString` is the ledger's form — four decimal places, no
 * separators, exact — and it is right everywhere a figure is stored,
 * compared or summed. It is wrong in an event log, a notification or a
 * message, where "250000.0000 IQD" costs the reader a moment of counting and
 * "250,000 IQD" costs none (2026-10-03).
 *
 * Never parse this back. It is for saying, not for keeping.
 */
export function say(amount: string | number, currencyCode = 'IQD'): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(value)) return `${String(amount)} ${currencyCode}`;
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currencyCode}`;
}
