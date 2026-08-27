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
import {
  LEDGER_CURRENCY,
  parseDecimal,
  RATE_SCALE,
  UNIT_RATE,
  type CurrencyCode,
} from './money';

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
    // Only reachable now when a currency has *no* published rate at all: a
    // date outside the published range falls back to the nearest rate rather
    // than refusing. So the remedy is always the same one sentence — publish a
    // rate — and the screen is named the way the menu names it.
    super(
      `No ${currency} exchange rate has been published yet, so this cannot be valued. ` +
        'Add one in Accounting → Master Data → Currencies and Rates.',
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
 * The identity rate — IQD per one IQD, which is one.
 *
 * The ledger currency never needed a published row: `toIqd` already documents
 * an IQD amount as converting at a rate of one, by definition. Asking the
 * table for one meant an ordinary dinar journal was refused for want of a rate
 * nobody could sensibly publish.
 */
export function identityRate(currency: string = LEDGER_CURRENCY): PublishedRate {
  return {
    currency,
    rateType: LEDGER_RATE_TYPE,
    iqdPerUnit: UNIT_RATE,
    // Earlier than any calendar this system will meet, so it covers every date.
    effectiveFrom: '0001-01-01',
    source: 'ledger currency',
  };
}

/**
 * The rate to use on a date: the latest one effective on or before it, and
 * failing that the earliest one published.
 *
 * The first clause is the accounting rule — a rate published on 1 March
 * governs 15 March even once an April rate exists, so re-running a March
 * report after April's rate lands still reproduces (§14.8). The second is the
 * concession that makes it usable: a date preceding every published rate used
 * to refuse outright, which stopped the ledger dead over a gap no accountant
 * caused. It now reaches for the nearest rate there is. Either way the row
 * that answered is stored on the line, so the figure still explains itself.
 *
 * The ledger currency answers one, always, with no row required.
 */
export function rateOn(
  rates: readonly PublishedRate[],
  currency: string,
  rateType: RateType,
  onDate: string,
): PublishedRate {
  if (currency === LEDGER_CURRENCY) return identityRate(currency);

  // Newest first, so the first row on or before the date is the one in force.
  const published = rates
    .filter((r) => r.currency === currency && r.rateType === rateType)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));

  // Nothing on or before the date: the earliest published rate is the nearest
  // in time, so it is the one that values the entry.
  const selected = published.find((r) => r.effectiveFrom <= onDate) ?? published.at(-1);

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
  /** Display glyph, when one was given. Formatting still goes by code. */
  readonly symbol?: string | null;
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
