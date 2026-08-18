/**
 * §7.3 and §16 — credit control.
 *
 * The rules here are the ones a salesperson under pressure will look for a way
 * around, so each test names the way round it closes.
 */
import { describe, expect, it } from 'vitest';
import {
  CreditLimitExceededError,
  CreditOverrideInvalidError,
  CustomerOnCreditHoldError,
  NO_EXPOSURE,
  assertNotOnCreditHold,
  assertOverrideComplete,
  assertWithinCredit,
  isOverrideLive,
  positionFor,
  totalExposure,
  type CreditOverride,
} from '@domain/credit-control';

/** Money, scaled at four places. */
const m = (n: string) => {
  const negative = n.startsWith('-');
  const [whole = '0', fraction = ''] = n.replace('-', '').split('.');
  const scaled = BigInt(whole) * 10_000n + BigInt(fraction.padEnd(4, '0').slice(0, 4));
  return negative ? -scaled : scaled;
};

const override = (overrides: Partial<CreditOverride> = {}): CreditOverride => ({
  amountIqd: m('500000'),
  expiresOn: '2026-06-30',
  approvedByUserId: 'sales-manager-1',
  reason: 'Ramadan stock build; customer has paid on time for two years.',
  ...overrides,
});

describe('§16 · exposure is five things, not one', () => {
  it('adds what is owed and committed, and subtracts what is held', () => {
    const exposure = totalExposure({
      outstandingInvoicesIqd: m('1000000'),
      openOrdersIqd: m('400000'),
      deliveredNotInvoicedIqd: m('250000'),
      unappliedCreditMemosIqd: m('50000'),
      customerAdvancesIqd: m('100000'),
    });

    expect(exposure).toBe(m('1500000'));
  });

  it('counts goods that have gone out and not been invoiced', () => {
    // The case a single "customer balance" gets wrong: the goods have left the
    // warehouse and the A/R ledger cannot see them yet.
    const withoutIt = totalExposure({ ...NO_EXPOSURE, outstandingInvoicesIqd: m('1000000') });
    const withIt = totalExposure({
      ...NO_EXPOSURE,
      outstandingInvoicesIqd: m('1000000'),
      deliveredNotInvoicedIqd: m('300000'),
    });

    expect(withIt - withoutIt).toBe(m('300000'));
  });

  it('lets credits and advances take exposure below zero', () => {
    // A customer in credit is not at risk, and the arithmetic should say so
    // rather than clamping at nothing.
    expect(
      totalExposure({ ...NO_EXPOSURE, customerAdvancesIqd: m('200000') }),
    ).toBe(m('-200000'));
  });

  it('is zero for a customer with nothing outstanding', () => {
    expect(totalExposure(NO_EXPOSURE)).toBe(0n);
  });
});

describe('§7.3 · the position, as of a date', () => {
  it('reports available credit as limit less exposure', () => {
    const position = positionFor({
      limitIqd: m('2000000'),
      components: { ...NO_EXPOSURE, outstandingInvoicesIqd: m('1500000') },
      onDate: '2026-04-01',
    });

    expect(position.availableIqd).toBe(m('500000'));
    expect(position.withinLimit).toBe(true);
  });

  it('reports a negative figure when the customer is over the line', () => {
    const position = positionFor({
      limitIqd: m('1000000'),
      components: { ...NO_EXPOSURE, outstandingInvoicesIqd: m('1200000') },
      onDate: '2026-04-01',
    });

    expect(position.availableIqd).toBe(m('-200000'));
    expect(position.withinLimit).toBe(false);
  });

  it('adds a live override to the ceiling', () => {
    const position = positionFor({
      limitIqd: m('1000000'),
      components: { ...NO_EXPOSURE, outstandingInvoicesIqd: m('1200000') },
      override: override(),
      onDate: '2026-04-01',
    });

    expect(position.overrideIqd).toBe(m('500000'));
    expect(position.availableIqd).toBe(m('300000'));
    expect(position.withinLimit).toBe(true);
  });

  it('ignores an override that has expired', () => {
    const position = positionFor({
      limitIqd: m('1000000'),
      components: { ...NO_EXPOSURE, outstandingInvoicesIqd: m('1200000') },
      override: override({ expiresOn: '2026-03-31' }),
      onDate: '2026-04-01',
    });

    // The day after, the ceiling is what it was. That is the whole point of
    // §16 requiring an expiry.
    expect(position.overrideIqd).toBe(0n);
    expect(position.withinLimit).toBe(false);
  });

  it('treats the expiry date itself as still live', () => {
    expect(isOverrideLive(override({ expiresOn: '2026-06-30' }), '2026-06-30')).toBe(true);
    expect(isOverrideLive(override({ expiresOn: '2026-06-30' }), '2026-07-01')).toBe(false);
  });
});

describe('§7.3 · approval is blocked when the limit is exceeded', () => {
  const within = {
    customerCode: 'CUST-001',
    limitIqd: m('1000000'),
    components: { ...NO_EXPOSURE, outstandingInvoicesIqd: m('600000') },
    onDate: '2026-04-01',
  };

  it('lets an order through that fits', () => {
    const position = assertWithinCredit({ ...within, requestedIqd: m('400000') });
    expect(position.withinLimit).toBe(true);
  });

  it('lets an order through that fits exactly', () => {
    expect(() => assertWithinCredit({ ...within, requestedIqd: m('400000') })).not.toThrow();
  });

  it('blocks the order that would cross the line', () => {
    expect(() => assertWithinCredit({ ...within, requestedIqd: m('400000.0001') })).toThrow(
      CreditLimitExceededError,
    );
  });

  it('judges the order being approved, not the balance this morning', () => {
    // Within limit today; the order is what takes them over. A check that only
    // looked at the current balance would approve it.
    const position = positionFor(within);
    expect(position.withinLimit).toBe(true);
    expect(() => assertWithinCredit({ ...within, requestedIqd: m('900000') })).toThrow(
      CreditLimitExceededError,
    );
  });

  it('says the numbers, so the salesperson can act on them', () => {
    try {
      assertWithinCredit({ ...within, requestedIqd: m('900000') });
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/400000 of credit available/);
      expect(message).toMatch(/this order needs 900000/);
      expect(message).toMatch(/Exposure is 600000 against a limit of 1000000/);
      expect(message).toMatch(/Sales Manager can raise the limit/);
    }
  });

  it('mentions the override in the message when one is in force', () => {
    try {
      assertWithinCredit({
        ...within,
        override: override({ amountIqd: m('100000') }),
        requestedIqd: m('900000'),
      });
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as Error).message).toMatch(/plus an override of 100000/);
    }
  });

  it('blocks everything for a customer with a zero limit', () => {
    // There is no "unlimited": a customer who should have no ceiling has a
    // large one, stated, that somebody decided and can be found.
    expect(() =>
      assertWithinCredit({
        customerCode: 'CUST-NEW',
        limitIqd: 0n,
        components: NO_EXPOSURE,
        onDate: '2026-04-01',
        requestedIqd: m('1'),
      }),
    ).toThrow(CreditLimitExceededError);
  });
});

describe('§16 · an override needs all four things', () => {
  it('accepts one that has them', () => {
    expect(() => assertOverrideComplete(override())).not.toThrow();
  });

  it('refuses one with no amount', () => {
    expect(() => assertOverrideComplete(override({ amountIqd: 0n }))).toThrow(
      /an override of nothing raises nothing/,
    );
  });

  it('refuses one with no expiry, and says why an expiry matters', () => {
    expect(() => assertOverrideComplete(override({ expiresOn: 'forever' }))).toThrow(
      /a permanent override is the credit limit being changed/,
    );
  });

  it('refuses one with no approver', () => {
    expect(() => assertOverrideComplete(override({ approvedByUserId: '' }))).toThrow(
      CreditOverrideInvalidError,
    );
  });

  it('refuses one with no reason, and quotes the blueprint', () => {
    expect(() => assertOverrideComplete(override({ reason: '   ' }))).toThrow(
      /the blueprint calls it mandatory/,
    );
  });
});

describe('§16 criterion 3 · a credit hold is not a limit of zero', () => {
  it('blocks regardless of limit or balance', () => {
    expect(() => assertNotOnCreditHold('CUST-001', true)).toThrow(CustomerOnCreditHoldError);
  });

  it('says that an override does not lift it', () => {
    try {
      assertNotOnCreditHold('CUST-001', true);
      throw new Error('expected a refusal');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/A credit-limit override does not lift a hold/);
      expect(message).toMatch(/A cash sale is a different document/);
    }
  });

  it('passes a customer who is not on hold', () => {
    expect(() => assertNotOnCreditHold('CUST-001', false)).not.toThrow();
  });
});
