/**
 * §17 treasury rules — Phase 07.1.
 *
 * > *"Bank account currency must match payment currency or use an approved FX
 * > conversion transaction."*
 * > *"Cash accounts have custodians, limits and periodic cash counts."*
 *
 * Treasury is where the company's money physically moves, and §17 calls it
 * *"the execution layer for A/P, A/R, payroll, investments, projects and Money
 * Transfer"*. The rules here are small and unforgiving for that reason: a
 * mistake in this layer is money in the wrong place rather than a figure in the
 * wrong column.
 *
 * Pure. Money is scaled at 10^4.
 */
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// Currency — §17
// ---------------------------------------------------------------------------

export class CurrencyMismatchError extends Error {
  readonly code = 'ACCOUNT_CURRENCY_MISMATCH';

  constructor(
    readonly accountCode: string,
    readonly accountCurrency: string,
    readonly paymentCurrency: string,
  ) {
    super(
      `Account ${accountCode} is held in ${accountCurrency} and this payment is in ${paymentCurrency}. ` +
        '§17 requires the two to match, or the payment to go through an approved FX conversion — ' +
        'a bank cannot send dollars out of a dinar account, and pretending otherwise puts the ' +
        'difference somewhere nobody chose.',
    );
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * §17 — *"Bank account currency must match payment currency or use an approved
 * FX conversion transaction."*
 *
 * The escape hatch is explicit rather than implicit: a caller that has an
 * approved conversion says so, and one that has not gets the refusal. An
 * automatic conversion would be the system choosing a rate, which §14.3 makes
 * a Finance decision.
 */
export function assertCurrencyMatches(
  accountCode: string,
  accountCurrency: string,
  paymentCurrency: string,
  options: { readonly approvedFxConversion?: boolean } = {},
): void {
  if (accountCurrency === paymentCurrency) return;
  if (options.approvedFxConversion) return;

  throw new CurrencyMismatchError(accountCode, accountCurrency, paymentCurrency);
}

// ---------------------------------------------------------------------------
// Approval limits — §4.3, §17
// ---------------------------------------------------------------------------

/**
 * Whether a payment from this account needs the higher approver.
 *
 * `null` means the account has no limit configured, which is treated as **no
 * amount being routine** — every payment goes to the higher approver until
 * Treasury sets a figure. The same safe-by-default reading §8.4's receipt
 * tolerance and §16's write-off threshold get: a limit nobody has set is not a
 * licence, it is an unanswered question.
 */
export function requiresHigherApproval(
  amountIqd: bigint,
  approvalLimitIqd: bigint | null,
): boolean {
  if (approvalLimitIqd === null) return true;
  return amountIqd > approvalLimitIqd;
}

export class PaymentExceedsLimitError extends Error {
  readonly code = 'PAYMENT_ABOVE_APPROVAL_LIMIT';

  constructor(
    readonly accountCode: string,
    readonly amountIqd: bigint,
    readonly limitIqd: bigint | null,
  ) {
    super(
      `A payment of ${toDecimalString(amountIqd, 4n)} from ${accountCode} is above its approval limit of ` +
        `${limitIqd === null ? 'nothing (no limit has been set)' : toDecimalString(limitIqd, 4n)}, ` +
        'so it needs the higher approver (§4.3, §17).',
    );
    this.name = 'PaymentExceedsLimitError';
  }
}

// ---------------------------------------------------------------------------
// Available balance — §17
// ---------------------------------------------------------------------------

export class InsufficientFundsError extends Error {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(
    readonly accountCode: string,
    readonly availableIqd: bigint,
    readonly requiredIqd: bigint,
  ) {
    super(
      `${accountCode} holds ${toDecimalString(availableIqd, 4n)} and this needs ` +
        `${toDecimalString(requiredIqd, 4n)}. Paying anyway would either bounce at the bank or ` +
        'create an overdraft nobody arranged (§17).',
    );
    this.name = 'InsufficientFundsError';
  }
}

/**
 * What an account can actually pay out.
 *
 * Cleared balance less what is already committed to payments in flight — the
 * same distinction §17 draws between *"cleared and book balances"*. Paying
 * twice from the same money is the failure this prevents, and it is exactly the
 * failure a balance read straight from the ledger would allow.
 */
export function availableFunds(input: {
  readonly balanceIqd: bigint;
  readonly committedIqd: bigint;
}): bigint {
  const available = input.balanceIqd - input.committedIqd;
  return available > 0n ? available : 0n;
}

export function assertSufficientFunds(
  accountCode: string,
  position: { readonly balanceIqd: bigint; readonly committedIqd: bigint },
  requiredIqd: bigint,
): void {
  const available = availableFunds(position);
  if (requiredIqd > available) {
    throw new InsufficientFundsError(accountCode, available, requiredIqd);
  }
}

// ---------------------------------------------------------------------------
// Cash counts — §17
// ---------------------------------------------------------------------------

export interface CashCountResult {
  /** Positive when more cash was found than the books say. */
  readonly varianceIqd: bigint;
  readonly direction: 'over' | 'short' | 'exact';
  /** A variance always needs approval — the sign does not make it innocent. */
  readonly needsApproval: boolean;
}

/**
 * §17 — *"periodic cash counts."*
 *
 * A surplus is as much a variance as a shortfall, and that is the point worth
 * stating: cash found in a drawer is money the books cannot explain, and the
 * usual explanation is that something else was recorded wrongly. Treating
 * "over" as harmless is how a float slowly stops meaning anything.
 */
export function cashCountVariance(input: {
  readonly countedIqd: bigint;
  readonly bookIqd: bigint;
}): CashCountResult {
  const varianceIqd = input.countedIqd - input.bookIqd;

  return {
    varianceIqd,
    direction: varianceIqd > 0n ? 'over' : varianceIqd < 0n ? 'short' : 'exact',
    needsApproval: varianceIqd !== 0n,
  };
}

export class CashLimitExceededError extends Error {
  readonly code = 'CASH_LIMIT_EXCEEDED';

  constructor(
    readonly accountCode: string,
    readonly limitIqd: bigint,
    readonly balanceIqd: bigint,
  ) {
    super(
      `${accountCode} would hold ${toDecimalString(balanceIqd, 4n)}, above its cash limit of ` +
        `${toDecimalString(limitIqd, 4n)} (§17). A float above its limit is cash sitting in a drawer ` +
        'that should be in a bank — bank the excess, or have the limit raised.',
    );
    this.name = 'CashLimitExceededError';
  }
}

/**
 * §17 — *"cash accounts have … limits."*
 *
 * Checked when cash goes **in**, not when it goes out: the limit is about how
 * much is held, and a float only breaches it by receiving.
 */
export function assertWithinCashLimit(
  accountCode: string,
  limitIqd: bigint | null,
  resultingBalanceIqd: bigint,
): void {
  if (limitIqd === null) return;
  if (resultingBalanceIqd > limitIqd) {
    throw new CashLimitExceededError(accountCode, limitIqd, resultingBalanceIqd);
  }
}

// ---------------------------------------------------------------------------
// Maker-checker — §17, Phase 07.3
// ---------------------------------------------------------------------------

export class SegregationOfDutiesError extends Error {
  readonly code = 'SEGREGATION_OF_DUTIES';

  constructor(
    readonly documentNo: string,
    readonly conflict: 'create_approve' | 'approve_execute' | 'create_execute',
  ) {
    const pairs: Record<string, string> = {
      create_approve: 'raised and approved',
      approve_execute: 'approved and executed',
      create_execute: 'raised and executed',
    };

    super(
      `The same person cannot have ${pairs[conflict]} ${documentNo}. §17 requires the creator, ` +
        'approver and executor of a high-risk payment to be different people — one person doing two ' +
        'of the three is one person able to move money on their own say-so.',
    );
    this.name = 'SegregationOfDutiesError';
  }
}

/**
 * §17 — *"Creator, approver and executor shall be different users for high-risk
 * payments."*
 *
 * All three pairs are checked, not only the obvious one. Create-and-approve is
 * the classic fraud; approve-and-execute is the one that actually moves the
 * money; and create-and-execute is the pair people forget, where a second
 * person approves a payment somebody else both invented and sent.
 */
export function assertSegregation(
  documentNo: string,
  actors: {
    readonly createdBy: string;
    readonly approvedBy?: string | null;
    readonly executedBy?: string | null;
  },
): void {
  if (actors.approvedBy && actors.approvedBy === actors.createdBy) {
    throw new SegregationOfDutiesError(documentNo, 'create_approve');
  }
  if (actors.executedBy && actors.executedBy === actors.approvedBy) {
    throw new SegregationOfDutiesError(documentNo, 'approve_execute');
  }
  if (actors.executedBy && actors.executedBy === actors.createdBy) {
    throw new SegregationOfDutiesError(documentNo, 'create_execute');
  }
}
