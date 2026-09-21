/**
 * Phase 02.7 test gate — account determination.
 *
 * The atomicity, idempotency and after-commit guarantees are database and
 * transaction properties, and are proved in
 * tests/integration/phase02-posting-engine.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AmbiguousPostingRuleError,
  NoPostingRuleError,
  PostingRequestError,
  assertRequestWellFormed,
  resolveRule,
  ruleMatches,
  specificity,
  type PostingRequest,
  type PostingRule,
} from '@domain/posting';
import {
  assertMappedControlAccount,
  requiredControlAccount,
} from '@domain/posting-map';

const rule = (overrides: Partial<PostingRule> = {}): PostingRule => ({
  id: 'r-1',
  eventType: 'sales_invoice.posted',
  lineRole: 'revenue',
  accountId: 'acc-general',
  accountCode: 'R000002',
  itemGroup: null,
  partnerGroup: null,
  warehouseCode: null,
  projectCode: null,
  branchCode: null,
  isActive: true,
  ...overrides,
});

describe('how specific a mapping is', () => {
  it('counts the criteria it pins down', () => {
    expect(specificity(rule())).toBe(0);
    expect(specificity(rule({ itemGroup: 'FUEL' }))).toBe(1);
    expect(specificity(rule({ itemGroup: 'FUEL', branchCode: 'BGW' }))).toBe(2);
  });

  it('matches anything on a criterion it leaves unset', () => {
    expect(ruleMatches(rule(), { itemGroup: 'FUEL', branchCode: 'BGW' })).toBe(true);
  });

  it('matches only the value it states', () => {
    const fuelOnly = rule({ itemGroup: 'FUEL' });
    expect(ruleMatches(fuelOnly, { itemGroup: 'FUEL' })).toBe(true);
    expect(ruleMatches(fuelOnly, { itemGroup: 'SPARES' })).toBe(false);
    expect(ruleMatches(fuelOnly, {})).toBe(false);
  });

  it('never matches when it is inactive', () => {
    expect(ruleMatches(rule({ isActive: false }), {})).toBe(false);
  });
});

describe('resolving the account for a line', () => {
  const general = rule({ id: 'general', accountCode: 'R000002' });
  const fuel = rule({ id: 'fuel', itemGroup: 'FUEL', accountCode: 'R000003' });
  const fuelInBasra = rule({
    id: 'fuel-bsr',
    itemGroup: 'FUEL',
    branchCode: 'BSR',
    accountCode: 'R000004',
  });

  it('falls back to the general mapping', () => {
    const resolved = resolveRule([general, fuel], 'sales_invoice.posted', 'revenue', {
      itemGroup: 'SPARES',
    });
    expect(resolved.accountCode).toBe('R000002');
  });

  it('prefers the more specific mapping', () => {
    const resolved = resolveRule([general, fuel], 'sales_invoice.posted', 'revenue', {
      itemGroup: 'FUEL',
    });
    expect(resolved.accountCode).toBe('R000003');
  });

  it('prefers the most specific of several', () => {
    const resolved = resolveRule(
      [general, fuel, fuelInBasra],
      'sales_invoice.posted',
      'revenue',
      { itemGroup: 'FUEL', branchCode: 'BSR' },
    );
    expect(resolved.accountCode).toBe('R000004');
  });

  it('does not confuse one line role with another', () => {
    const receivable = rule({ id: 'ar', lineRole: 'receivable', accountCode: 'A000010' });
    expect(
      resolveRule([general, receivable], 'sales_invoice.posted', 'receivable', {}).accountCode,
    ).toBe('A000010');
  });

  it('does not confuse one event with another', () => {
    const purchase = rule({
      id: 'p',
      eventType: 'purchase_invoice.posted',
      lineRole: 'revenue',
      accountCode: 'X000009',
    });
    expect(
      resolveRule([general, purchase], 'sales_invoice.posted', 'revenue', {}).accountCode,
    ).toBe('R000002');
  });

  it('refuses to guess when nothing is mapped', () => {
    expect(() => resolveRule([], 'sales_invoice.posted', 'revenue', {})).toThrow(
      NoPostingRuleError,
    );
  });

  it('says what was being looked for when nothing is mapped', () => {
    expect(() =>
      resolveRule([], 'sales_invoice.posted', 'revenue', { itemGroup: 'FUEL' }),
    ).toThrow(/'revenue' line of 'sales_invoice.posted' \(itemGroup=FUEL\)/);
    expect(() => resolveRule([], 'sales_invoice.posted', 'revenue', {})).toThrow(
      /Configure the mapping in Accounting Mapping/,
    );
  });

  it('refuses to pick between two equally specific mappings', () => {
    // Two rules matching equally well is an ambiguous configuration. Resolving
    // it quietly means resolving it differently one day.
    const byItem = rule({ id: 'a', itemGroup: 'FUEL', accountCode: 'R000003' });
    const byPartner = rule({ id: 'b', partnerGroup: 'WHOLESALE', accountCode: 'R000005' });

    expect(() =>
      resolveRule([byItem, byPartner], 'sales_invoice.posted', 'revenue', {
        itemGroup: 'FUEL',
        partnerGroup: 'WHOLESALE',
      }),
    ).toThrow(AmbiguousPostingRuleError);

    expect(() =>
      resolveRule([byItem, byPartner], 'sales_invoice.posted', 'revenue', {
        itemGroup: 'FUEL',
        partnerGroup: 'WHOLESALE',
      }),
    ).toThrow(/R000003, R000005/);
  });

  it('ignores an inactive mapping and falls through to the next', () => {
    const retired = rule({ id: 'old', itemGroup: 'FUEL', accountCode: 'R000099', isActive: false });
    const resolved = resolveRule([general, retired], 'sales_invoice.posted', 'revenue', {
      itemGroup: 'FUEL',
    });
    expect(resolved.accountCode).toBe('R000002');
  });
});

describe('the control account an invoice mapping must name', () => {
  it.each([
    {
      eventType: 'purchasing.ap_invoice',
      lineRole: 'supplier_payable',
      required: 'supplier',
      opposite: 'customer',
    },
    {
      eventType: 'sales.ar_invoice',
      lineRole: 'customer_receivable',
      required: 'customer',
      opposite: 'supplier',
    },
  ] as const)('requires %s / %s to use a %s control account', ({ eventType, lineRole, required, opposite }) => {
    expect(requiredControlAccount(eventType, lineRole)).toBe(required);
    expect(() =>
      assertMappedControlAccount(eventType, lineRole, {
        code: 'USER-CHOSEN',
        controlAccount: required,
      }),
    ).not.toThrow();
    expect(() =>
      assertMappedControlAccount(eventType, lineRole, {
        code: 'USER-CHOSEN',
        controlAccount: null,
      }),
    ).toThrow(/control account/);
    expect(() =>
      assertMappedControlAccount(eventType, lineRole, {
        code: 'USER-CHOSEN',
        controlAccount: opposite,
      }),
    ).toThrow(/control account/);
  });

  it.each([
    ['sales_invoice.posted', 'receivable'],
    ['sales.ar_invoice', 'sales_revenue'],
  ] as const)('leaves %s / %s to any postable account', (eventType, lineRole) => {
    expect(requiredControlAccount(eventType, lineRole)).toBeNull();
    expect(() =>
      assertMappedControlAccount(eventType, lineRole, {
        code: 'USER-CHOSEN',
        controlAccount: null,
      }),
    ).not.toThrow();
  });
});

describe('the request a module makes', () => {
  const request = (overrides: Partial<PostingRequest> = {}): PostingRequest => ({
    eventType: 'sales_invoice.posted',
    source: { module: 'sales', documentId: 'INV-1', event: 'posted' },
    branchCode: 'BGW',
    documentDate: '2026-08-16',
    postingDate: '2026-08-16',
    lines: [
      { role: 'receivable', debit: '1000.0000' },
      { role: 'revenue', credit: '1000.0000' },
    ],
    ...overrides,
  });

  it('accepts a well-formed request', () => {
    expect(() => assertRequestWellFormed(request())).not.toThrow();
  });

  it('refuses fewer than two lines', () => {
    expect(() =>
      assertRequestWellFormed(request({ lines: [{ role: 'revenue', credit: '1000.0000' }] })),
    ).toThrow(PostingRequestError);
  });

  it('refuses an incomplete source reference', () => {
    // §24 — the reference is what stops the same event posting twice.
    expect(() =>
      assertRequestWellFormed(
        request({ source: { module: 'sales', documentId: '', event: 'posted' } }),
      ),
    ).toThrow(/stops the same event posting twice/);
  });

  it('refuses a line carrying both sides, or neither', () => {
    expect(() =>
      assertRequestWellFormed(
        request({
          lines: [
            { role: 'receivable', debit: '1000.0000', credit: '1000.0000' },
            { role: 'revenue', credit: '1000.0000' },
          ],
        }),
      ),
    ).toThrow(/exactly one of debit or credit/);

    expect(() =>
      assertRequestWellFormed(
        request({
          lines: [{ role: 'receivable' }, { role: 'revenue', credit: '1000.0000' }],
        }),
      ),
    ).toThrow(PostingRequestError);
  });
});
