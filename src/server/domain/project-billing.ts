/**
 * The Project System's billing, recognition and forecast rules — REQ-PM-001
 * §11, Stage PM-5: what a billing-plan line bills, when it falls due, how far
 * the certificates may go, the estimate to complete, and the percentage-of-
 * completion (cost-to-cost) figures of D-PM-1. No database.
 *
 * Money is IQD scaled by 10⁴; a percentage is scaled by 10⁴ too (100 % is
 * 1,000,000), so 12.5 % is 125,000 and is compared exactly.
 */
import { divideHalfUp } from './money';
import { ProjectSystemError } from './project-system';

/** 100 % at four decimals. */
export const HUNDRED_PERCENT = 1_000_000n;

export type DueTrigger = 'milestone' | 'date';
export type PlanBasis = 'percent' | 'amount';
export type PlanLineStatus = 'planned' | 'due' | 'billed' | 'cancelled';

/**
 * What a line bills: its amount, or its share of the contract value as it
 * stands now (the revised value — a change order that raised the contract
 * raises every percentage line not yet billed).
 */
export function planLineGross(
  line: { readonly basis: PlanBasis; readonly percentOfContract: bigint | null; readonly amountIqd: bigint | null },
  contractIqd: bigint,
): bigint {
  if (line.basis === 'amount') {
    if (line.amountIqd === null || line.amountIqd <= 0n) throw new ProjectSystemError('amount', 'an amount line bills more than nothing');
    return line.amountIqd;
  }
  if (line.percentOfContract === null || line.percentOfContract <= 0n || line.percentOfContract > HUNDRED_PERCENT) {
    throw new ProjectSystemError('percent_of_contract', 'a share of the contract is above 0 and at most 100 %');
  }
  return divideHalfUp(contractIqd * line.percentOfContract, HUNDRED_PERCENT);
}

/**
 * The day a line fell due, or null while it has not: a milestone line once
 * its milestone is reached and that is approved (the day it was reached); a
 * date line on its date.
 */
export function dueSince(
  line: { readonly dueTrigger: DueTrigger; readonly dueOn: string | null },
  milestone: { readonly reachedOn: string | null; readonly reachedApprovedAt: Date | string | null } | null,
  today: string,
): string | null {
  if (line.dueTrigger === 'date') return line.dueOn !== null && line.dueOn <= today ? line.dueOn : null;
  if (!milestone || !milestone.reachedOn || !milestone.reachedApprovedAt) return null;
  return milestone.reachedOn;
}

/** The plan line's state as the screen shows it: a planned line whose day has come reads as due. */
export function lineState(status: PlanLineStatus, due: string | null): PlanLineStatus {
  return status === 'planned' && due !== null ? 'due' : status;
}

/**
 * The certificates never bill more than the contract: what has been
 * certified (every certificate not cancelled) plus this one, against the
 * revised contract value.
 */
export function assertWithinContract(certifiedIqd: bigint, grossIqd: bigint, contractIqd: bigint): void {
  if (grossIqd <= 0n) throw new ProjectSystemError('gross', 'a certificate bills more than nothing');
  if (certifiedIqd + grossIqd > contractIqd) {
    throw new ProjectSystemError(
      'gross',
      `${fmt(certifiedIqd)} is certified and this adds ${fmt(grossIqd)}, above the contract value of ${fmt(contractIqd)}; ` +
        'a change order raises the contract before more is billed',
    );
  }
}

/** The cumulative share of the contract the certificates reach, to four decimals, at most 100 %. */
export function cumulativePercent(certifiedIqd: bigint, contractIqd: bigint): bigint {
  if (contractIqd <= 0n) return 0n;
  const pct = divideHalfUp(certifiedIqd * HUNDRED_PERCENT, contractIqd);
  return pct > HUNDRED_PERCENT ? HUNDRED_PERCENT : pct < 0n ? 0n : pct;
}

/**
 * The estimate to complete of one element (§10, §11): the manager's typed
 * figure when there is one; otherwise the budget not yet earned at the cost
 * performance so far (÷ CPI, the Progress screen's method), or simply the
 * budget not yet earned while nothing is both earned and spent. Never below
 * zero: an element that has earned its budget has nothing left to spend.
 */
export function etcOf(input: { readonly budgetIqd: bigint; readonly earnedIqd: bigint; readonly actualIqd: bigint; readonly typedIqd: bigint | null }): bigint {
  if (input.typedIqd !== null) return input.typedIqd < 0n ? 0n : input.typedIqd;
  const remaining = input.budgetIqd - input.earnedIqd;
  if (remaining <= 0n) return 0n;
  if (input.earnedIqd > 0n && input.actualIqd > 0n) return divideHalfUp(remaining * input.actualIqd, input.earnedIqd);
  return remaining;
}

export interface RecognitionFigures {
  readonly contractIqd: bigint;
  readonly actualIqd: bigint;
  readonly eacIqd: bigint;
  /** Percent complete by cost, scaled by 10⁴, at most 100 %. */
  readonly percent: bigint;
  readonly recognisedIqd: bigint;
  readonly billedIqd: bigint;
  /** Recognised less billed: positive to WIP, negative to deferred revenue. */
  readonly adjustmentIqd: bigint;
  /** The estimate at completion exceeds the contract — a loss Finance judges (not provided for here). */
  readonly onerous: boolean;
}

/**
 * D-PM-1, percentage of completion, cost to cost: recognised to date is the
 * contract value × actual ÷ EAC (never more than the contract), less what the
 * certificates have billed. The money is taken from the exact ratio, not from
 * the rounded percentage.
 */
export function recognitionOf(input: { readonly contractIqd: bigint; readonly actualIqd: bigint; readonly eacIqd: bigint; readonly billedIqd: bigint }): RecognitionFigures {
  const { contractIqd, actualIqd, eacIqd, billedIqd } = input;
  let percent = 0n;
  let recognisedIqd = 0n;
  if (eacIqd > 0n && actualIqd > 0n) {
    if (actualIqd >= eacIqd) {
      percent = HUNDRED_PERCENT;
      recognisedIqd = contractIqd;
    } else {
      percent = divideHalfUp(actualIqd * HUNDRED_PERCENT, eacIqd);
      recognisedIqd = divideHalfUp(contractIqd * actualIqd, eacIqd);
    }
  }
  return {
    contractIqd,
    actualIqd,
    eacIqd,
    percent,
    recognisedIqd,
    billedIqd,
    adjustmentIqd: recognisedIqd - billedIqd,
    onerous: eacIqd > contractIqd,
  };
}

function fmt(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10_000n;
  const frac = abs % 10_000n;
  return `${negative ? '-' : ''}${whole}${frac === 0n ? '' : `.${String(frac).padStart(4, '0').replace(/0+$/, '')}`}`;
}
