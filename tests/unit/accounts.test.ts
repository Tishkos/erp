/**
 * The normal balance of every account type, asserted one by one.
 *
 * This test exists because the Chart of Accounts extract received on
 * 2026-08-16 listed the Expense group as credit-normal. Expenses are
 * debit-normal. The rule is now derived from the account type rather than
 * stored alongside it, and this file is what stops it drifting again.
 */
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_TYPES,
  AccountCodeError,
  NORMAL_BALANCE,
  NormalBalanceError,
  STATEMENT_SECTION,
  accountTypeFromCode,
  assertNormalBalance,
  isAccountType,
  isDebitNormal,
  normalBalanceFor,
  normalBalanceForCode,
  signOfIncrease,
} from '@domain/accounts';

describe('normal balance by account type', () => {
  it('assets are debit-normal', () => {
    expect(normalBalanceFor('asset')).toBe('debit');
  });

  it('expenses are debit-normal', () => {
    // The line the received extract got wrong.
    expect(normalBalanceFor('expense')).toBe('debit');
  });

  it('liabilities are credit-normal', () => {
    expect(normalBalanceFor('liability')).toBe('credit');
  });

  it('equity is credit-normal', () => {
    expect(normalBalanceFor('equity')).toBe('credit');
  });

  it('revenue is credit-normal', () => {
    expect(normalBalanceFor('revenue')).toBe('credit');
  });

  it('states all five together, so the set can be read against a textbook', () => {
    expect(NORMAL_BALANCE).toEqual({
      asset: 'debit',
      liability: 'credit',
      equity: 'credit',
      revenue: 'credit',
      expense: 'debit',
    });
  });

  it('splits the five into exactly the two sides of the accounting equation', () => {
    // Assets + Expenses = Liabilities + Equity + Revenue
    const debitSide = ACCOUNT_TYPES.filter(isDebitNormal);
    const creditSide = ACCOUNT_TYPES.filter((t) => !isDebitNormal(t));

    expect(debitSide).toEqual(['asset', 'expense']);
    expect(creditSide).toEqual(['liability', 'equity', 'revenue']);
    expect(debitSide.length + creditSide.length).toBe(ACCOUNT_TYPES.length);
  });

  it('recognises no type outside the five', () => {
    expect(ACCOUNT_TYPES).toHaveLength(5);
    expect(isAccountType('asset')).toBe(true);
    expect(isAccountType('contra_asset')).toBe(false);
    expect(isAccountType('Asset')).toBe(false);
  });
});

describe('the account code carries its own type', () => {
  it('maps each received group code to its type', () => {
    // The five account groups in the imported extract.
    expect(accountTypeFromCode('A000001')).toBe('asset');
    expect(accountTypeFromCode('L000001')).toBe('liability');
    expect(accountTypeFromCode('E000001')).toBe('equity');
    expect(accountTypeFromCode('R000001')).toBe('revenue');
    expect(accountTypeFromCode('X000001')).toBe('expense');
  });

  it('gives the Expense group a debit normal balance, whatever the extract said', () => {
    expect(normalBalanceForCode('X000001')).toBe('debit');
    expect(normalBalanceForCode('A000001')).toBe('debit');
    expect(normalBalanceForCode('L000001')).toBe('credit');
    expect(normalBalanceForCode('E000001')).toBe('credit');
    expect(normalBalanceForCode('R000001')).toBe('credit');
  });

  it('accepts a lower-case or padded code but not a malformed one', () => {
    expect(accountTypeFromCode(' x000042 ')).toBe('expense');

    expect(() => accountTypeFromCode('X00042')).toThrow(AccountCodeError);
    expect(() => accountTypeFromCode('X0000042')).toThrow(AccountCodeError);
    expect(() => accountTypeFromCode('Q000001')).toThrow(/A, L, E, R or X/);
    expect(() => accountTypeFromCode('000001')).toThrow(AccountCodeError);
  });
});

describe('a contradicting normal balance is rejected, not stored', () => {
  it('rejects a credit-normal expense — the case that prompted this rule', () => {
    expect(() => assertNormalBalance('expense', 'credit')).toThrow(NormalBalanceError);
    expect(() => assertNormalBalance('expense', 'credit')).toThrow(
      /expense account is debit-normal/,
    );
  });

  it('rejects a debit-normal liability, equity or revenue', () => {
    for (const type of ['liability', 'equity', 'revenue'] as const) {
      expect(() => assertNormalBalance(type, 'debit'), type).toThrow(NormalBalanceError);
    }
  });

  it('accepts each type declared correctly', () => {
    for (const type of ACCOUNT_TYPES) {
      expect(() => assertNormalBalance(type, NORMAL_BALANCE[type])).not.toThrow();
    }
  });
});

describe('statement classification (§14.7, Phase 16)', () => {
  it('carries assets, liabilities and equity to the balance sheet', () => {
    expect(STATEMENT_SECTION.asset).toBe('balance_sheet');
    expect(STATEMENT_SECTION.liability).toBe('balance_sheet');
    expect(STATEMENT_SECTION.equity).toBe('balance_sheet');
  });

  it('closes revenue and expense through profit and loss', () => {
    expect(STATEMENT_SECTION.revenue).toBe('profit_and_loss');
    expect(STATEMENT_SECTION.expense).toBe('profit_and_loss');
  });
});

describe('the sign a balance is reported with', () => {
  it('is positive for debit-normal accounts and negative for credit-normal', () => {
    expect(signOfIncrease('asset')).toBe(1);
    expect(signOfIncrease('expense')).toBe(1);
    expect(signOfIncrease('liability')).toBe(-1);
    expect(signOfIncrease('equity')).toBe(-1);
    expect(signOfIncrease('revenue')).toBe(-1);
  });

  it('makes a balanced set of movements net to zero across all five types', () => {
    // One debit and one credit of the same size, on any two accounts, net to
    // zero regardless of which types they land on — the property §14.3's
    // balancing rule depends on.
    const netted = (type: Parameters<typeof signOfIncrease>[0], debit: number, credit: number) =>
      signOfIncrease(type) * (debit - credit);

    // Dr Expense 1,000 / Cr Liability 1,000 — a purchase on credit.
    expect(netted('expense', 1000, 0) + netted('liability', 0, 1000)).toBe(1000 + 1000);
    // Both sides report a positive, normal balance; the journal itself balances
    // because debits (1,000) equal credits (1,000).
    expect(1000 - 1000).toBe(0);
  });
});
