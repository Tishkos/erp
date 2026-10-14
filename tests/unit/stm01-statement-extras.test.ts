/**
 * The statement's two stacked windows (2026-10-14): the old books' documents
 * of an account and a supplier's import applications. Both are read-only; these
 * hold the grouping, the columns, the order and the currency rule.
 */
import { describe, expect, it } from 'vitest';
import { historyFor, type LegacyHistoryLine } from '@/server/domain/legacy-history';
import { importsSection } from '@/server/domain/statement-imports';

const line = (over: Partial<LegacyHistoryLine>): LegacyHistoryLine => ({
  kind: 'sale',
  legacyNo: '1',
  lineNo: 1,
  documentDate: null,
  itemName: null,
  quantity: null,
  unit: null,
  amount: '0',
  currency: 'IQD',
  ...over,
});

describe('the old books on a statement', () => {
  const lines: LegacyHistoryLine[] = [
    line({ kind: 'sale', legacyNo: '3', lineNo: 2, itemName: 'LONGI 585W', quantity: '552', amount: '55200000.0000' }),
    line({ kind: 'sale', legacyNo: '3', lineNo: 1, itemName: 'CABLE 2*6 DC', quantity: '10', unit: 'متر', amount: '2150000.0000' }),
    line({ kind: 'sale', legacyNo: '12', itemName: 'Inverter', quantity: '1', amount: '1000000' }),
    line({ kind: 'receipt', legacyNo: '1,017', documentDate: '2026-08-20', amount: '20000000.0000' }),
    line({ kind: 'receipt', legacyNo: '101', documentDate: '2025-01-27', amount: '31600000.0000' }),
    line({ kind: 'payment', legacyNo: '10', documentDate: '2025-02-06', amount: '390000.0000' }),
    line({ kind: 'receipt', legacyNo: '200', documentDate: '2025-03-01', amount: '500', currency: 'USD' }),
  ];

  it('makes one row per old document, its lines in the old order', () => {
    const history = historyFor(lines, 'customer');
    const sale = history.rows.find((row) => row.kind === 'sale' && row.legacyNo === '3')!;
    expect(sale.debit).toBe('57350000.0000');
    expect(sale.currency).toBe('IQD');
    expect(sale.items.map((item) => item.name)).toEqual(['CABLE 2*6 DC', 'LONGI 585W']);
    expect(history.rows).toHaveLength(6);
  });

  it('puts sales and payments in Debit, receipts and purchases in Credit', () => {
    const history = historyFor([...lines, line({ kind: 'purchase', legacyNo: '9', documentDate: '2025-07-12', amount: '25000000' })], 'customer');
    const by = (kind: string) => history.rows.find((row) => row.kind === kind)!;
    expect(by('payment')).toMatchObject({ debit: '390000.0000', credit: '0.0000' });
    expect(by('receipt')).toMatchObject({ debit: '0.0000' });
    expect(by('purchase')).toMatchObject({ debit: '0.0000', credit: '25000000.0000' });
  });

  it('dates first in date order, the undated sales after in the list’s order', () => {
    const history = historyFor(lines, 'customer');
    expect(history.rows.map((row) => `${row.kind}:${row.legacyNo}`)).toEqual([
      'receipt:101',
      'payment:10',
      'receipt:200',
      'receipt:1,017',
      'sale:3',
      'sale:12',
    ]);
  });

  it('reads the net the way each side reads its statement, one total per currency, dinars first', () => {
    const customer = historyFor(lines, 'customer');
    expect(customer.totals).toEqual([
      { currency: 'IQD', debit: '58740000.0000', credit: '51600000.0000', net: '7140000.0000' },
      { currency: 'USD', debit: '0.0000', credit: '500.0000', net: '-500.0000' },
    ]);
    expect(historyFor(lines, 'supplier').totals[0]!.net).toBe('-7140000.0000');
  });

  it('shows every currency whatever the statement is run in — a dollar receipt stays dollars', () => {
    const receipt = historyFor(lines, 'customer').rows.find((row) => row.legacyNo === '200')!;
    expect(receipt).toMatchObject({ currency: 'USD', credit: '500.0000' });
  });

  it('reads a line with no currency as dinars', () => {
    expect(historyFor([line({ currency: null, amount: '5' })], 'customer').totals).toEqual([{ currency: 'IQD', debit: '5.0000', credit: '0.0000', net: '5.0000' }]);
  });
});

describe('the imports on a supplier statement', () => {
  const row = (currency: string, agreed: string, withBank: string, paid: string, left: string) => ({
    payableNo: `IMP-${agreed}`,
    currency,
    agreedTxn: agreed,
    withBankTxn: withBank,
    paidTxn: paid,
    remainingTxn: left,
  });
  const rows = [
    row('USD', '1341787.8000', '0', '1341787.0000', '0.8000'),
    row('USD', '100520.0000', '20000.0000', '30000.0000', '70520.0000'),
    row('IQD', '5000000.0000', '0', '0', '5000000.0000'),
  ];

  it('keeps every import and totals each currency exactly, never across', () => {
    const section = importsSection(rows);
    expect(section.rows).toHaveLength(3);
    expect(section.totals).toEqual([
      { currency: 'IQD', agreed: '5000000.0000', withBank: '0.0000', paid: '0.0000', remaining: '5000000.0000' },
      { currency: 'USD', agreed: '1442307.8000', withBank: '20000.0000', paid: '1371787.0000', remaining: '70520.8000' },
    ]);
  });

  it('reads a padded currency code as its code', () => {
    const section = importsSection([row('USD', '1', '0', '0', '1')].map((r) => ({ ...r, currency: 'USD ' })));
    expect(section.rows[0]!.currency).toBe('USD');
    expect(section.totals.map((total) => total.currency)).toEqual(['USD']);
  });
});
