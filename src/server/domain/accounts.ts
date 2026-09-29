/**
 * Account types and normal balances.
 *
 * Blueprint §1.2: "The Chart of Accounts shall remain hierarchical and
 * configurable." Configurable means the *accounts* are chosen by the Business
 * Process Owner (D7, Appendix C). It does not mean the accounting is
 * configurable: which side increases an account follows from double entry, and
 * a system that lets it be configured per account is a system that can be
 * configured into an unbalanced trial balance.
 *
 *     Assets       increase on the DEBIT  side
 *     Expenses     increase on the DEBIT  side
 *     Liabilities  increase on the CREDIT side
 *     Equity       increase on the CREDIT side
 *     Revenue      increase on the CREDIT side
 *
 * That is the accounting equation — Assets + Expenses = Liabilities + Equity +
 * Revenue — and §14.3's requirement that IQD debits equal IQD credits on every
 * journal is only meaningful if every account agrees which side it is on.
 *
 * ── Why this module exists at all ───────────────────────────────────────────
 * One imported Chart of Accounts extract listed the Expense group as "0 IQD Cr".
 * Expenses are debit-normal. Whether
 * that is an export artefact or a misconfiguration in the source system is a
 * question for the Business Process Owner (D7), but either way it must not be
 * able to enter this system: the normal balance is derived here from the
 * account type, never stored as an independent field that could contradict it.
 */

/** The five types. §14 and Appendix C recognise no others. */
export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type NormalBalance = 'debit' | 'credit';

/**
 * The normal balance of each type. Not configuration — the definition.
 *
 * Exported as a lookup rather than hidden behind the function below so that a
 * reviewer can read all five in one place and check them against a textbook.
 */
export const NORMAL_BALANCE: Readonly<Record<AccountType, NormalBalance>> = Object.freeze({
  asset: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
  expense: 'debit',
});

/**
 * Which financial statement a type belongs to — §14.7, Phase 16.
 *
 * Balance-sheet accounts carry forward across a year-end; profit-and-loss
 * accounts close to retained earnings. Recorded with the type because it is the
 * same fact, and because year-end close cannot be written without it.
 */
export const STATEMENT_SECTION: Readonly<Record<AccountType, 'balance_sheet' | 'profit_and_loss'>> =
  Object.freeze({
    asset: 'balance_sheet',
    liability: 'balance_sheet',
    equity: 'balance_sheet',
    revenue: 'profit_and_loss',
    expense: 'profit_and_loss',
  });

/**
 * The code format received from the Business Process Owner: one type letter
 * followed by six digits — A000001, L000001, E000001, R000001, X000001.
 *
 * The type letter is part of the code, so an account's type is readable from
 * its code and the two cannot drift apart. X for expense, because E is taken by
 * equity.
 */
export const TYPE_BY_CODE_LETTER: Readonly<Record<string, AccountType>> = Object.freeze({
  A: 'asset',
  L: 'liability',
  E: 'equity',
  R: 'revenue',
  X: 'expense',
});

export const ACCOUNT_CODE_PATTERN = /^([ALERX])(\d{6})$/;

export class AccountCodeError extends Error {
  readonly code = 'ACCOUNT_CODE_INVALID';

  constructor(accountCode: string, detail: string) {
    super(`Account code '${accountCode}' is not usable: ${detail}`);
    this.name = 'AccountCodeError';
  }
}

export class NormalBalanceError extends Error {
  readonly code = 'NORMAL_BALANCE_CONTRADICTION';

  constructor(
    readonly accountType: AccountType,
    readonly declared: NormalBalance,
  ) {
    super(
      `A ${accountType} account is ${NORMAL_BALANCE[accountType]}-normal, but '${declared}' was declared. ` +
        'The normal balance follows from the account type and is not configurable.',
    );
    this.name = 'NormalBalanceError';
  }
}

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** The normal balance of a type. The single place this is answered. */
export function normalBalanceFor(type: AccountType): NormalBalance {
  return NORMAL_BALANCE[type];
}

export function isDebitNormal(type: AccountType): boolean {
  return NORMAL_BALANCE[type] === 'debit';
}

/** Derives the account type from the code letter. */
export function accountTypeFromCode(accountCode: string): AccountType {
  const match = ACCOUNT_CODE_PATTERN.exec(accountCode.trim().toUpperCase());
  if (!match) {
    throw new AccountCodeError(
      accountCode,
      'expected one type letter (A, L, E, R or X) followed by six digits, e.g. A000001',
    );
  }
  return TYPE_BY_CODE_LETTER[match[1]!]!;
}

/** The normal balance of an account, read from its code. */
export function normalBalanceForCode(accountCode: string): NormalBalance {
  return normalBalanceFor(accountTypeFromCode(accountCode));
}

/**
 * Rejects a normal balance that contradicts the account type.
 *
 * Used when accounts arrive from outside — an import, a migration, an extract
 * from the previous system. §26 requires migrated data to be validated rather
 * than trusted, and this is the check that would have caught the Expense group
 * arriving as credit-normal.
 */
export function assertNormalBalance(type: AccountType, declared: NormalBalance): void {
  if (NORMAL_BALANCE[type] !== declared) {
    throw new NormalBalanceError(type, declared);
  }
}

/**
 * The sign an account's balance takes when debits and credits are netted.
 *
 * +1 for debit-normal accounts, -1 for credit-normal. A trial balance in which
 * every account is summed as `sign × (debits − credits)` reports positive
 * figures for accounts behaving normally, which is what makes an abnormal
 * balance visible rather than merely arithmetically correct.
 */
export function signOfIncrease(type: AccountType): 1 | -1 {
  return isDebitNormal(type) ? 1 : -1;
}
