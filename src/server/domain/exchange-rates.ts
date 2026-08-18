/**
 * Currency and exchange rates — Phase 02.3.
 *
 * §1.1: "IQD is the primary transaction and ledger currency; USD values are
 * reporting equivalents calculated using approved historical exchange rates."
 *
 * §14.3: "Exchange rate cannot be edited inside Journal Entry. Rates are
 * maintained only in the Finance Exchange Rate section."
 *
 * That second rule is why rate selection lives here and takes a **date**, never
 * an amount typed by a user. A journal line asks "what was the rate on this
 * posting date?" and gets an answer it cannot argue with. The rate that
 * answered is then stored on the row, so a reprint five years later reproduces
 * the same figure — §22 requires it, and recomputing from today's rate would
 * quietly rewrite history.
 */
import { parseDecimal, RATE_SCALE, type CurrencyCode } from './money';

/**
 * §4.3 lists an accounting rate, a market rate and a client rate type.
 *
 *   accounting  the approved rate the ledger posts at
 *   market      observed rate, for reference and variance analysis
 *   client      the rate quoted to a customer (§12 money transfer pricing)
 *
 * Only `accounting` ever reaches a journal. The others exist so that the
 * difference between them is visible rather than blended away.
 */
export const RATE_TYPES = ['accounting', 'market', 'client'] as const;
export type RateType = (typeof RATE_TYPES)[number];

/** The rate the ledger is entitled to use. */
export const LEDGER_RATE_TYPE: RateType = 'accounting';

/**
 * One published rate.
 *
 * `iqdPerUnit` is IQD per **one unit** of `currency`, scaled by RATE_SCALE.
 * The direction is fixed: the inverse (USD per IQD ≈ 0.000763) loses
 * catastrophic precision at any sane scale.
 */
export interface PublishedRate {
  readonly currency: CurrencyCode | string;
  readonly rateType: RateType;
  /** Scaled by RATE_SCALE (1e8). */
  readonly iqdPerUnit: bigint;
  /** Inclusive. The rate applies from this date until a later one supersedes it. */
  readonly effectiveFrom: string;
  readonly source: string | null;
}

export class NoRateForDateError extends Error {
  readonly code = 'NO_EXCHANGE_RATE';

  constructor(
    readonly currency: string,
    readonly rateType: RateType,
    readonly onDate: string,
  ) {
    super(
      `No ${rateType} rate for ${currency} is effective on ${onDate}. ` +
        'Rates are maintained in the Finance Exchange Rate section (§14.3) and must exist before a posting can use them.',
    );
    this.name = 'NoRateForDateError';
  }
}

export class RateNotEditableError extends Error {
  readonly code = 'RATE_NOT_EDITABLE';

  constructor() {
    super(
      'The exchange rate cannot be set on a transaction. It is resolved from the posting date against the rates ' +
        'maintained in the Finance Exchange Rate section (§14.3).',
    );
    this.name = 'RateNotEditableError';
  }
}

/**
 * The rate in force on a date: the latest one effective on or before it.
 *
 * Not "the nearest" and not "the newest row". A rate published on 1 March
 * governs 15 March even if a 1 April rate already exists — otherwise re-running
 * a March report after April's rate lands would produce different numbers, and
 * §14.8 requires it to reproduce.
 */
export function rateOn(
  rates: readonly PublishedRate[],
  currency: string,
  rateType: RateType,
  onDate: string,
): PublishedRate {
  const candidates = rates
    .filter((r) => r.currency === currency && r.rateType === rateType && r.effectiveFrom <= onDate)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));

  const selected = candidates[0];
  if (!selected) throw new NoRateForDateError(currency, rateType, onDate);
  return selected;
}

/**
 * Refuses a rate supplied by a caller — the 02.3 gate, as a function.
 *
 * "The rate field is not editable inside Journal Entry by any path, UI or API."
 * Anything that accepts a transaction payload calls this on the way in, so the
 * refusal happens once rather than being re-derived per screen.
 */
export function assertRateNotSupplied(payload: Record<string, unknown>): void {
  for (const field of ['rate', 'exchangeRate', 'exchange_rate', 'iqdPerUnit', 'iqd_per_unit']) {
    if (payload[field] !== undefined) {
      throw new RateNotEditableError();
    }
  }
}

export function parseRate(value: string): bigint {
  const scaled = parseDecimal(value, RATE_SCALE);
  if (scaled <= 0n) {
    throw new RangeError(`Exchange rate must be positive, received ${value}`);
  }
  return scaled;
}

/** A currency as configured in the master — §4.3. */
export interface Currency {
  readonly code: string;
  readonly name: string;
  /** Minor units the currency is quoted in. IQD is quoted whole. */
  readonly decimals: number;
  /** True for IQD only. §1.1 — not configurable at runtime. */
  readonly isLedger: boolean;
  readonly isActive: boolean;
}

export class CurrencyNotUsableError extends Error {
  readonly code = 'CURRENCY_NOT_USABLE';
  constructor(code: string, detail: string) {
    super(`Currency ${code} cannot be used: ${detail}`);
    this.name = 'CurrencyNotUsableError';
  }
}

export function assertCurrencyUsable(currency: Currency): void {
  if (!currency.isActive) {
    throw new CurrencyNotUsableError(currency.code, 'it is inactive');
  }
}
