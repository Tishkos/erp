/**
 * Petty cash advances — Phase 07.5, §17 and Appendix D.
 *
 * > §17 scope: *"Petty Cash, Cash Advance and Cash Count."*
 * > Appendix D, Treasury: *"Petty cash advances, ageing and cash count
 * > variances."*
 *
 * A cash advance is money handed to a person who has not yet said what it was
 * for. That is the whole of it, and it is why the balance is a **receivable**
 * rather than an expense: until the receipts come back the company has not spent
 * anything, it has lent something.
 *
 * The rules here are all about closing that gap — every dinar issued is either
 * accounted for or handed back, and the arithmetic will not let it be neither.
 *
 * Pure. Money is scaled at 10^4.
 */
import { toDecimalString } from './money';
import { daysBetween } from './dates';

// ---------------------------------------------------------------------------
// The balance on an advance
// ---------------------------------------------------------------------------

export interface AdvanceAmounts {
  readonly amountIqd: bigint;
  /** Accounted for with receipts. */
  readonly settledIqd: bigint;
  /** Handed back unspent. */
  readonly returnedIqd: bigint;
}

/** What the holder still has to account for. */
export function outstandingOn(advance: AdvanceAmounts): bigint {
  return advance.amountIqd - advance.settledIqd - advance.returnedIqd;
}

export class AdvanceOverAccountedError extends Error {
  readonly code = 'ADVANCE_OVER_ACCOUNTED';

  constructor(
    readonly advanceNo: string,
    outstandingIqd: bigint,
    requestedIqd: bigint,
  ) {
    super(
      `${advanceNo} has ${toDecimalString(outstandingIqd, 4n)} left to account for and this ` +
        `accounts for ${toDecimalString(requestedIqd, 4n)}. ` +
        'Somebody has spent money that was never advanced to them (§17). If they did, that is an ' +
        'expense claim — a different document, with its own approval.',
    );
    this.name = 'AdvanceOverAccountedError';
  }
}

/**
 * §17 — an advance cannot account for more than it issued.
 *
 * The refusal names the alternative rather than only the rule. Somebody who
 * spent their own money on the company's behalf has a real claim; what they do
 * not have is a bigger advance than the one they were given, and quietly
 * enlarging it here would hide a payment nobody approved.
 */
export function assertWithinAdvance(
  advanceNo: string,
  advance: AdvanceAmounts,
  requestedIqd: bigint,
): void {
  const outstanding = outstandingOn(advance);
  if (requestedIqd <= 0n || requestedIqd > outstanding) {
    throw new AdvanceOverAccountedError(advanceNo, outstanding, requestedIqd);
  }
}

// ---------------------------------------------------------------------------
// Ageing — Appendix D
// ---------------------------------------------------------------------------

export const ADVANCE_BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'] as const;
export type AdvanceBucket = (typeof ADVANCE_BUCKETS)[number];

/**
 * Appendix D — *"petty cash advances, ageing."*
 *
 * Aged from the **date it was due to be accounted for**, not from the date it
 * was issued. An advance given a month before a trip is not overdue; one given
 * for last week's trip is. Ageing from the issue date would flag the first and
 * the second alike, and a report that cries wolf is a report nobody reads.
 */
export function bucketFor(dueDate: string, asOf: string): AdvanceBucket {
  const overdue = daysBetween(dueDate, asOf);

  if (overdue <= 0) return 'current';
  if (overdue <= 30) return '1-30';
  if (overdue <= 60) return '31-60';
  if (overdue <= 90) return '61-90';
  return '90+';
}

// ---------------------------------------------------------------------------
// Issue rules
// ---------------------------------------------------------------------------

export class AdvanceNotIssuableError extends Error {
  readonly code = 'ADVANCE_NOT_ISSUABLE';
  constructor(detail: string) {
    super(detail);
    this.name = 'AdvanceNotIssuableError';
  }
}

/**
 * §17 — what has to be true before cash leaves the drawer.
 *
 * The purpose is required and the accounting date is required, and both are
 * required *at issue* rather than at settlement. An advance with no stated
 * purpose is untraceable the moment the person holding it forgets, and a
 * deadline set afterwards is a deadline set by whoever is late.
 */
export function assertIssuable(input: {
  readonly amountIqd: bigint;
  readonly purpose: string | null;
  readonly issueDate: string;
  readonly dueDate: string;
}): void {
  if (input.amountIqd <= 0n) {
    throw new AdvanceNotIssuableError(
      'An advance of nothing advances nothing. State the amount leaving the float.',
    );
  }

  if (!input.purpose || input.purpose.trim().length === 0) {
    throw new AdvanceNotIssuableError(
      'An advance needs a stated purpose (§17). Money handed over for an unrecorded reason is ' +
        'untraceable the moment the person holding it forgets what it was for.',
    );
  }

  if (input.dueDate < input.issueDate) {
    throw new AdvanceNotIssuableError(
      `The advance is due to be accounted for on ${input.dueDate}, before it was issued on ` +
        `${input.issueDate}. It cannot be overdue before it exists.`,
    );
  }
}
