import { describe, expect, it } from 'vitest';
import {
  LineCatalogue,
  StatementLineError,
  type StatementLineRow,
} from '@domain/financial-statements';

const rows: StatementLineRow[] = [
  {
    id: 'is-revenue',
    code: 'revenue',
    name: 'Revenue',
    statement: 'income_statement',
    parentId: null,
    isHeader: false,
    ordinal: 10,
    role: 'revenue',
    side: null,
    cashFlowCategory: 'operating',
    isCash: false,
    isSystem: true,
  },
  {
    id: 'is-product-revenue',
    code: 'product_revenue',
    name: 'Product Revenue',
    statement: 'income_statement',
    parentId: null,
    isHeader: false,
    ordinal: 20,
    role: 'revenue',
    side: null,
    cashFlowCategory: 'operating',
    isCash: false,
    isSystem: false,
  },
  {
    id: 'bs-equity',
    code: 'equity',
    name: 'Equity',
    statement: 'balance_sheet',
    parentId: null,
    isHeader: false,
    ordinal: 10,
    role: null,
    side: 'equity',
    cashFlowCategory: 'financing',
    isCash: false,
    isSystem: true,
  },
  {
    id: 'bs-revenue',
    code: 'balance_sheet_revenue',
    name: 'Revenue',
    statement: 'balance_sheet',
    parentId: null,
    isHeader: false,
    ordinal: 20,
    role: null,
    side: 'equity',
    cashFlowCategory: 'financing',
    isCash: false,
    isSystem: false,
  },
  {
    id: 'bs-assets',
    code: 'current_assets',
    name: 'Current assets',
    statement: 'balance_sheet',
    parentId: null,
    isHeader: false,
    ordinal: 30,
    role: null,
    side: 'asset',
    cashFlowCategory: 'operating',
    isCash: false,
    isSystem: true,
  },
];

describe('independent financial statement mappings', () => {
  const catalogue = new LineCatalogue(rows);

  it('allows one revenue account on Product Revenue and Balance Sheet equity', () => {
    expect(
      catalogue.assertLineAllowed('revenue', 'product_revenue', 'income_statement').code,
    ).toBe('product_revenue');
    expect(
      catalogue.assertLineAllowed('revenue', 'balance_sheet_revenue', 'balance_sheet').code,
    ).toBe('balance_sheet_revenue');
  });

  it('does not invent a Balance Sheet line until Finance maps one', () => {
    expect(catalogue.lineForStatement('revenue', 'balance_sheet', null)).toBeUndefined();
  });

  it('keeps an asset line unavailable as the revenue Balance Sheet presentation', () => {
    expect(() =>
      catalogue.assertLineAllowed('revenue', 'current_assets', 'balance_sheet'),
    ).toThrow(StatementLineError);
  });
});
