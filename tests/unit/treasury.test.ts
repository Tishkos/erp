/**
 * Phase 07.1 and 07.3 — the treasury rules, tested where they are pure.
 *
 *   - §17 bank account currency must match the payment currency
 *   - §17 approval limits route a large payment to the higher approver
 *   - §17 cash accounts have limits, and counts produce variances
 *   - §17 creator, approver and executor are different people
 */
import { describe, expect, it } from 'vitest';
import {
  assertCurrencyMatches,
  assertSegregation,
  assertSufficientFunds,
  assertWithinCashLimit,
  availableFunds,
  cashCountVariance,
  requiresHigherApproval,
  CashLimitExceededError,
  CurrencyMismatchError,
  InsufficientFundsError,
  SegregationOfDutiesError,
} from '@domain/treasury';
import { parseDecimal } from '@domain/money';

const iqd = (amount: string) => parseDecimal(amount, 4n);

describe('07.1 gate · the account currency must match the payment (§17)', () => {
  it('accepts a payment in the account’s own currency', () => {
    expect(() => assertCurrencyMatches('BANK-1', 'IQD', 'IQD')).not.toThrow();
  });

  it('refuses a payment in another currency', () => {
    expect(() => assertCurrencyMatches('BANK-1', 'IQD', 'USD')).toThrow(CurrencyMismatchError);
  });

  it('allows it through an approved FX conversion, and only explicitly', () => {
    // The escape hatch is stated by the caller, never assumed: an automatic
    // conversion would be the system choosing a rate, which §14.3 makes a
    // Finance decision.
    expect(() =>
      assertCurrencyMatches('BANK-1', 'IQD', 'USD', { approvedFxConversion: true }),
    ).not.toThrow();
  });

  it('names both currencies and says why (§25)', () => {
    try {
      assertCurrencyMatches('BANK-USD', 'USD', 'IQD');
      expect.unreachable('should have refused');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('BANK-USD');
      expect(message).toContain('held in USD');
      expect(message).toContain('approved FX conversion');
    }
  });
});

describe('07.1 gate · approval limits route to the higher approver (§4.3, §17)', () => {
  it('lets a payment within the limit through the ordinary approver', () => {
    expect(requiresHigherApproval(iqd('900'), iqd('1000'))).toBe(false);
  });

  it('routes a payment above the limit higher', () => {
    expect(requiresHigherApproval(iqd('1001'), iqd('1000'))).toBe(true);
  });

  it('treats the limit itself as within it', () => {
    expect(requiresHigherApproval(iqd('1000'), iqd('1000'))).toBe(false);
  });

  it('routes everything higher when no limit is set', () => {
    // A limit nobody has configured is not a licence — it is an unanswered
    // question, so nothing is routine until Treasury answers it.
    expect(requiresHigherApproval(iqd('1'), null)).toBe(true);
  });
});

describe('07.1 · an account cannot pay out money it does not have (§17)', () => {
  it('deducts what is already committed', () => {
    // Cleared 1,000 with 400 in flight leaves 600 — the distinction §17 draws
    // between cleared and book balances.
    expect(availableFunds({ balanceIqd: iqd('1000'), committedIqd: iqd('400') })).toBe(iqd('600'));
  });

  it('never reports negative funds', () => {
    expect(availableFunds({ balanceIqd: iqd('100'), committedIqd: iqd('400') })).toBe(0n);
  });

  it('refuses a payment beyond what is available', () => {
    expect(() =>
      assertSufficientFunds(
        'BANK-1',
        { balanceIqd: iqd('1000'), committedIqd: iqd('400') },
        iqd('700'),
      ),
    ).toThrow(InsufficientFundsError);
  });

  it('allows one that exactly empties it', () => {
    expect(() =>
      assertSufficientFunds(
        'BANK-1',
        { balanceIqd: iqd('1000'), committedIqd: iqd('400') },
        iqd('600'),
      ),
    ).not.toThrow();
  });
});

describe('07.1 gate · cash counts and cash limits (§17)', () => {
  it('reports a shortfall', () => {
    const result = cashCountVariance({ countedIqd: iqd('900'), bookIqd: iqd('1000') });
    expect(result.varianceIqd).toBe(iqd('-100'));
    expect(result.direction).toBe('short');
    expect(result.needsApproval).toBe(true);
  });

  it('reports a surplus as a variance too', () => {
    // Cash found in a drawer is money the books cannot explain, and the usual
    // explanation is that something else was recorded wrongly.
    const result = cashCountVariance({ countedIqd: iqd('1100'), bookIqd: iqd('1000') });
    expect(result.direction).toBe('over');
    expect(result.needsApproval).toBe(true);
  });

  it('needs no approval when the count agrees', () => {
    const result = cashCountVariance({ countedIqd: iqd('1000'), bookIqd: iqd('1000') });
    expect(result.varianceIqd).toBe(0n);
    expect(result.direction).toBe('exact');
    expect(result.needsApproval).toBe(false);
  });

  it('refuses a float that would exceed its limit', () => {
    expect(() => assertWithinCashLimit('CASH-1', iqd('5000'), iqd('5001'))).toThrow(
      CashLimitExceededError,
    );
    expect(() => assertWithinCashLimit('CASH-1', iqd('5000'), iqd('5000'))).not.toThrow();
  });

  it('imposes nothing when no limit is configured', () => {
    expect(() => assertWithinCashLimit('CASH-1', null, iqd('999999'))).not.toThrow();
  });
});

describe('07.3 gate · creator, approver and executor differ (§17)', () => {
  const alice = 'user-alice';
  const bob = 'user-bob';
  const carol = 'user-carol';

  it('accepts three different people', () => {
    expect(() =>
      assertSegregation('PAY-1', { createdBy: alice, approvedBy: bob, executedBy: carol }),
    ).not.toThrow();
  });

  it('refuses the same person creating and approving', () => {
    expect(() =>
      assertSegregation('PAY-1', { createdBy: alice, approvedBy: alice }),
    ).toThrow(SegregationOfDutiesError);
  });

  it('refuses the same person approving and executing', () => {
    expect(() =>
      assertSegregation('PAY-1', { createdBy: alice, approvedBy: bob, executedBy: bob }),
    ).toThrow(SegregationOfDutiesError);
  });

  it('refuses the same person creating and executing — the pair people forget', () => {
    // A second person approved it, but one person both invented the payment and
    // sent the money.
    expect(() =>
      assertSegregation('PAY-1', { createdBy: alice, approvedBy: bob, executedBy: alice }),
    ).toThrow(SegregationOfDutiesError);
  });

  it('says which pair conflicted (§25)', () => {
    try {
      assertSegregation('PAY-7', { createdBy: alice, approvedBy: bob, executedBy: bob });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as Error).message).toContain('approved and executed PAY-7');
    }
  });

  it('permits a document that has only been created so far', () => {
    expect(() => assertSegregation('PAY-1', { createdBy: alice })).not.toThrow();
  });
});
