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
  resolveLineAccount,
  resolveRule,
  ruleMatches,
  specificity,
  type PostingRequest,
  type PostingRule,
} from '@domain/posting';
import {
  InvalidSalesRevenueAccountError,
  POSTING_MAP,
  assertMappedAccount,
  assertMappedControlAccount,
  eventKey,
  mappingAccountEligible,
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

describe('choosing between a scoped exception, an item account and a fallback', () => {
  const event = 'sales.ar_invoice';
  const role = 'sales_revenue';
  const generic = rule({ id: 'generic', eventType: event, lineRole: role, accountId: 'generic', accountCode: 'GENERAL' });
  const warehouse = rule({ id: 'warehouse', eventType: event, lineRole: role, warehouseCode: 'WH1', accountId: 'scoped', accountCode: 'SCOPED' });
  const branch = rule({ id: 'branch', eventType: event, lineRole: role, branchCode: 'BGW', accountId: 'branch', accountCode: 'BRANCH' });
  const criteria = { warehouseCode: 'WH1', branchCode: 'BGW' };

  it('keeps an explicit document account ahead of every configured answer', () => {
    expect(resolveLineAccount([generic, warehouse], event, {
      role,
      accountId: 'document',
      itemAccountId: 'item',
    }, criteria)).toEqual({ accountId: 'document', postingRuleId: null, source: 'explicit' });
  });

  it('lets a matching scoped mapping beat the item', () => {
    expect(resolveLineAccount([generic, warehouse], event, {
      role,
      itemAccountId: 'item',
    }, criteria)).toEqual({ accountId: 'scoped', postingRuleId: 'warehouse', source: 'scoped_rule' });
  });

  it('lets the item beat the general mapping', () => {
    expect(resolveLineAccount([generic], event, { role, itemAccountId: 'item' }, criteria))
      .toEqual({ accountId: 'item', postingRuleId: null, source: 'item' });
  });

  it('lets the item work without a general mapping', () => {
    expect(resolveLineAccount([], event, { role, itemAccountId: 'item' }, criteria))
      .toEqual({ accountId: 'item', postingRuleId: null, source: 'item' });
  });

  it('uses the general mapping when there is no item account', () => {
    expect(resolveLineAccount([generic], event, { role }, criteria))
      .toEqual({ accountId: 'generic', postingRuleId: 'generic', source: 'default_rule' });
  });

  it('ignores scoped mappings that do not match or are inactive', () => {
    const otherWarehouse = rule({ ...warehouse, id: 'other', warehouseCode: 'WH2' });
    const inactive = rule({ ...warehouse, id: 'inactive', isActive: false });
    expect(resolveLineAccount([generic, otherWarehouse, inactive], event, {
      role,
      itemAccountId: 'item',
    }, { warehouseCode: 'WH3' })).toEqual({ accountId: 'item', postingRuleId: null, source: 'item' });
  });

  it('still refuses equally specific scoped mappings when an item exists', () => {
    expect(() => resolveLineAccount([warehouse, branch], event, {
      role,
      itemAccountId: 'item',
    }, criteria)).toThrow(AmbiguousPostingRuleError);
  });

  it('refuses when neither an item account nor a mapping exists', () => {
    expect(() => resolveLineAccount([], event, { role }, criteria)).toThrow(NoPostingRuleError);
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

describe('the account a revenue mapping may choose', () => {
  it('accepts an ordinary revenue posting account', () => {
    const account = { code: 'REV', accountType: 'revenue', controlAccount: null } as const;
    expect(mappingAccountEligible('sales.ar_invoice', 'sales_revenue', account)).toBe(true);
    expect(() => assertMappedAccount('sales.ar_invoice', 'sales_revenue', account)).not.toThrow();
  });

  it.each([
    { code: 'ASSET', accountType: 'asset', controlAccount: null },
    { code: 'CONTROL', accountType: 'revenue', controlAccount: 'customer' },
  ] as const)('rejects %s', (account) => {
    expect(mappingAccountEligible('sales.ar_invoice', 'sales_revenue', account)).toBe(false);
    expect(() => assertMappedAccount('sales.ar_invoice', 'sales_revenue', account))
      .toThrow(InvalidSalesRevenueAccountError);
  });

  it('keeps customer and supplier control-account requirements unchanged', () => {
    expect(mappingAccountEligible('sales.ar_invoice', 'customer_receivable', {
      accountType: 'asset',
      controlAccount: 'customer',
    })).toBe(true);
    expect(mappingAccountEligible('purchasing.ap_invoice', 'supplier_payable', {
      accountType: 'liability',
      controlAccount: 'customer',
    })).toBe(false);
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

/**
 * The catalogue the Posting Mappings screen is drawn from.
 *
 * The screen shows each document as the journal it will post — the side, the
 * line, the account — so the catalogue has to be able to answer for its own
 * shape. A role listed twice under one event would render two rows writing to
 * one mapping, where the second silently wins; a missing side would render a
 * blank column an accountant reads as "neither".
 *
 * The sides themselves are read off the services in
 * tests/integration/ops04-purchase-invoice.test.ts and its siblings, which
 * post a real document and assert which way each line went. What is asserted
 * here is only what can be known without a database.
 */
describe('the catalogue the mappings screen is drawn from', () => {
  it('names every line once per document, and gives each one a side', () => {
    for (const document of POSTING_MAP) {
      const roles = document.lines.map((line) => line.role);
      expect(new Set(roles).size, document.event).toBe(roles.length);
      expect(document.lines.length, document.event).toBeGreaterThan(0);

      for (const line of document.lines) {
        expect(['debit', 'credit', 'either'], `${document.event} / ${line.role}`).toContain(
          line.side,
        );
      }
    }
  });

  it('names each event once, and derives a message key from it', () => {
    const events = POSTING_MAP.map((document) => document.event);
    expect(new Set(events).size).toBe(events.length);
    for (const event of events) {
      // The catalogue is indexed by this key at render time, so a character
      // the key cannot carry would resolve to nothing on the screen.
      expect(eventKey(event), event).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it('marks a control-account line only where the subledger needs one', () => {
    for (const document of POSTING_MAP) {
      for (const line of document.lines) {
        if (!line.controlAccount) continue;
        // Only the two party subledgers are designated from a mapping; the
        // rest are decided by the record the posting names.
        expect(['customer', 'supplier']).toContain(line.controlAccount);
        expect(requiredControlAccount(document.event, line.role)).toBe(line.controlAccount);
      }
    }
  });

  it('holds the two entries a whole journal can be read from', () => {
    const invoice = POSTING_MAP.find((d) => d.event === 'purchasing.ap_invoice')!;
    expect(
      invoice.lines.map((line) => [line.role, line.side, line.always]),
    ).toEqual([
      // What the company owes, credited — every purchase invoice posts it.
      ['supplier_payable', 'credit', true],
      ['grni', 'debit', false],
      ['expense', 'debit', false],
      // Over the order it is a debit, under it a credit.
      ['purchase_variance', 'either', false],
    ]);

    const sale = POSTING_MAP.find((d) => d.event === 'sales.ar_invoice')!;
    expect(sale.lines.map((line) => [line.role, line.side, line.always])).toEqual([
      ['customer_receivable', 'debit', true],
      ['sales_revenue', 'credit', false],
    ]);
  });
});
