/**
 * Fixed assets — Phase 12, §18 and Appendix E (IAS 16).
 *
 * > §18.2: *"Depreciation starts from Available for Use Date in accordance with
 * > the approved IFRS treatment."*
 * > §18.5: *"Depreciation cannot begin before Available for Use Date."*
 * > §18.2: *"**No Asset Clearing Account is required** by the approved company
 * > workflow."*
 *
 * **The Available for Use Date is the spine of this module.** An asset bought in
 * January and commissioned in March depreciates from March, because until it is
 * available for use it is not being used up. Every function here takes that date
 * rather than the acquisition date, and the two are deliberately separate
 * fields: the gap between them is a real fact about the asset.
 *
 * Pure. Money is scaled at 10^4.
 */
import { toDecimalString } from './money';
import { daysBetween } from './dates';

// ---------------------------------------------------------------------------
// Depreciation methods
// ---------------------------------------------------------------------------

/**
 * The methods this build computes.
 *
 * Which method an asset *uses* is category configuration set by Finance — §18
 * asks for the method to be a field on the category and the asset, not a choice
 * the code makes. What is not configurable is the arithmetic of each one.
 */
export const DEPRECIATION_METHODS = ['straight_line', 'reducing_balance'] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export interface AssetBasis {
  /** What the asset cost, from the Fixed Asset Document. */
  readonly acquisitionCostIqd: bigint;
  /** §18.2 — what it is expected to be worth at the end of its life. */
  readonly residualValueIqd: bigint;
  /** In months. §18.2 calls it useful life. */
  readonly usefulLifeMonths: number;
  readonly method: DepreciationMethod;
  /** §18.2 — the date depreciation may begin, and not before. */
  readonly availableForUseOn: string;
}

export class NotYetAvailableError extends Error {
  readonly code = 'ASSET_NOT_YET_AVAILABLE';
  constructor(
    readonly assetCode: string,
    readonly availableForUseOn: string,
    readonly periodEnd: string,
  ) {
    super(
      `${assetCode} becomes available for use on ${availableForUseOn}, after the period ending ` +
        `${periodEnd} (§18.5). Depreciation is the using-up of an asset; an asset nobody can use ` +
        'yet is not being used up, and charging for it would move cost into a period that did not ' +
        'consume any.',
    );
    this.name = 'NotYetAvailableError';
  }
}

/**
 * §18.5 — *"depreciation cannot begin before Available for Use Date."*
 *
 * Stated as its own assertion rather than folded into the calculation, so the
 * refusal has a name and a message. A calculation that quietly returned zero
 * would be indistinguishable from a fully depreciated asset.
 */
export function assertAvailable(
  assetCode: string,
  availableForUseOn: string,
  periodEnd: string,
): void {
  if (availableForUseOn > periodEnd) {
    throw new NotYetAvailableError(assetCode, availableForUseOn, periodEnd);
  }
}

// ---------------------------------------------------------------------------
// The charge for one period
// ---------------------------------------------------------------------------

export interface PeriodCharge {
  readonly chargeIqd: bigint;
  /** What has been charged in total once this period posts. */
  readonly accumulatedAfterIqd: bigint;
  readonly carryingValueAfterIqd: bigint;
  /** True when the asset has reached residual value and stops. */
  readonly fullyDepreciated: boolean;
}

/**
 * The depreciation charge for one month, by the asset's own method.
 *
 * **Straight line** spreads the depreciable amount — cost less residual — evenly
 * over the useful life. **Reducing balance** takes a fixed proportion of what is
 * left, at a rate derived from the life so that the two methods describe the
 * same asset rather than two unrelated ones.
 *
 * Three rules are shared and are the ones that matter:
 *
 * 1. **Nothing before the Available for Use Date** (§18.5) — the caller asserts
 *    it, and this returns zero if asked anyway, so a run over a mixed population
 *    does not have to filter first.
 * 2. **Never below residual value** (§18.2) — the last charge is trimmed to land
 *    exactly on it. An asset that depreciated past its residual would report a
 *    carrying value the company does not believe.
 * 3. **A part month is a part charge**, prorated on days, so an asset available
 *    from the 20th is not charged as if it had been there all month.
 */
export function monthlyCharge(
  basis: AssetBasis,
  accumulatedIqd: bigint,
  periodStart: string,
  periodEnd: string,
): PeriodCharge {
  const depreciable = basis.acquisitionCostIqd - basis.residualValueIqd;
  const carrying = basis.acquisitionCostIqd - accumulatedIqd;

  const stop = (): PeriodCharge => ({
    chargeIqd: 0n,
    accumulatedAfterIqd: accumulatedIqd,
    carryingValueAfterIqd: carrying,
    fullyDepreciated: accumulatedIqd >= depreciable,
  });

  if (basis.availableForUseOn > periodEnd) return stop();
  if (depreciable <= 0n || basis.usefulLifeMonths <= 0) return stop();
  if (accumulatedIqd >= depreciable) return stop();

  let charge: bigint;

  if (basis.method === 'straight_line') {
    charge = depreciable / BigInt(basis.usefulLifeMonths);
  } else {
    // A rate that consumes the depreciable amount over the same life. Held in
    // basis points so the arithmetic stays exact.
    const rateBp = (10_000n * 2n) / BigInt(basis.usefulLifeMonths);
    charge = ((carrying - basis.residualValueIqd) * rateBp) / 10_000n;
  }

  // §18 — a part month is a part charge. The first period of an asset that
  // became available mid-month is prorated on days.
  if (basis.availableForUseOn > periodStart) {
    const daysInPeriod = daysBetween(periodStart, periodEnd) + 1;
    const daysAvailable = daysBetween(basis.availableForUseOn, periodEnd) + 1;
    if (daysInPeriod > 0) {
      charge = (charge * BigInt(daysAvailable)) / BigInt(daysInPeriod);
    }
  }

  // §18.2 — never past residual value.
  const remaining = depreciable - accumulatedIqd;
  if (charge > remaining) charge = remaining;
  if (charge < 0n) charge = 0n;

  const accumulatedAfterIqd = accumulatedIqd + charge;

  return {
    chargeIqd: charge,
    accumulatedAfterIqd,
    carryingValueAfterIqd: basis.acquisitionCostIqd - accumulatedAfterIqd,
    fullyDepreciated: accumulatedAfterIqd >= depreciable,
  };
}

// ---------------------------------------------------------------------------
// Carrying value — §18.5's reconciliation
// ---------------------------------------------------------------------------

export interface CarryingValue {
  readonly acquisitionCostIqd: bigint;
  readonly accumulatedDepreciationIqd: bigint;
  readonly accumulatedImpairmentIqd: bigint;
  readonly netBookValueIqd: bigint;
}

/**
 * §18.8 — *"Net Book Value = cost − accumulated depreciation − accumulated
 * impairment."*
 *
 * Impairment is kept apart from depreciation rather than added to it, because
 * §18.5 asks for them to reconcile to the G/L *separately* — they are different
 * accounts and different events, and a single "accumulated" figure could not be
 * agreed to either.
 */
export function carryingValue(input: {
  acquisitionCostIqd: bigint;
  accumulatedDepreciationIqd: bigint;
  accumulatedImpairmentIqd: bigint;
}): CarryingValue {
  return {
    ...input,
    netBookValueIqd:
      input.acquisitionCostIqd -
      input.accumulatedDepreciationIqd -
      input.accumulatedImpairmentIqd,
  };
}

// ---------------------------------------------------------------------------
// Disposal — §18.6
// ---------------------------------------------------------------------------

export interface DisposalResult {
  readonly netBookValueIqd: bigint;
  readonly proceedsIqd: bigint;
  /** Positive is a gain, negative a loss. */
  readonly gainOrLossIqd: bigint;
  readonly isGain: boolean;
}

/**
 * §18.6 — what a disposal produces.
 *
 * Proceeds less carrying value, and the sign says which it was. Returned as one
 * signed figure with a flag rather than two fields, because a gain and a loss
 * are the same arithmetic and splitting them invites a caller to handle one and
 * forget the other.
 */
export function disposalOutcome(
  value: CarryingValue,
  proceedsIqd: bigint,
): DisposalResult {
  const gainOrLossIqd = proceedsIqd - value.netBookValueIqd;
  return {
    netBookValueIqd: value.netBookValueIqd,
    proceedsIqd,
    gainOrLossIqd,
    isGain: gainOrLossIqd >= 0n,
  };
}

export class AssetNotDisposableError extends Error {
  readonly code = 'ASSET_NOT_DISPOSABLE';
  constructor(
    readonly assetCode: string,
    readonly status: string,
  ) {
    super(
      `${assetCode} is '${status}' and cannot be disposed of (§18.3). ` +
        'The lifecycle is document → available for use → depreciation → transfer or impairment → ' +
        'disposal → closed; an asset already disposed of cannot be disposed of again.',
    );
    this.name = 'AssetNotDisposableError';
  }
}

// ---------------------------------------------------------------------------
// Impairment — §18.5
// ---------------------------------------------------------------------------

export class ImpairmentTooLargeError extends Error {
  readonly code = 'IMPAIRMENT_TOO_LARGE';
  constructor(
    readonly assetCode: string,
    readonly netBookValueIqd: bigint,
    readonly amountIqd: bigint,
  ) {
    super(
      `${assetCode} carries ${toDecimalString(netBookValueIqd, 4n)} and this impairs ` +
        `${toDecimalString(amountIqd, 4n)} (§18). An asset cannot be written down below nothing; ` +
        'if the intention is to remove it from the register, that is a disposal.',
    );
    this.name = 'ImpairmentTooLargeError';
  }
}

/** §18 — an impairment reduces carrying value, and cannot take it below zero. */
export function assertImpairable(
  assetCode: string,
  value: CarryingValue,
  amountIqd: bigint,
): void {
  if (amountIqd <= 0n || amountIqd > value.netBookValueIqd) {
    throw new ImpairmentTooLargeError(assetCode, value.netBookValueIqd, amountIqd);
  }
}
