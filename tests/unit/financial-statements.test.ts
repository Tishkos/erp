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

describe('four independent financial statement mappings', () => {
  const catalogue = new LineCatalogue(rows);

  it('lets one revenue account report on the Income Statement and inside equity', () => {
    // The example that drove the direction: two answers for one account,
    // neither derived from the other.
    expect(catalogue.assertLineAllowed('product_revenue', 'income_statement').code).toBe(
      'product_revenue',
    );
    expect(catalogue.assertLineAllowed('balance_sheet_revenue', 'balance_sheet').code).toBe(
      'balance_sheet_revenue',
    );
  });

  it('invents no Balance Sheet line for a revenue account until Finance maps one', () => {
    // Unmapped, it is carried by the computed result under equity instead —
    // which is what keeps the two sides agreeing.
    expect(catalogue.lineFor('revenue', 'balance_sheet', null)).toBeUndefined();
  });

  it('falls to the type default when nobody has mapped the account', () => {
    expect(catalogue.lineFor('revenue', 'income_statement', null)?.code).toBe('revenue');
    expect(catalogue.lineFor('asset', 'balance_sheet', null)?.code).toBe('current_assets');
  });

  it('does not argue with Finance about which line suits which account type', () => {
    // Mapping is a mapping. An asset line for a revenue account is unusual and
    // it is still the chart owner's decision to make.
    expect(catalogue.assertLineAllowed('current_assets', 'balance_sheet').code).toBe(
      'current_assets',
    );
  });

  it('refuses a line that belongs to another report', () => {
    expect(() => catalogue.assertLineAllowed('product_revenue', 'balance_sheet')).toThrow(
      StatementLineError,
    );
  });

  it('refuses a line that does not exist', () => {
    expect(() => catalogue.assertLineAllowed('no_such_line', 'income_statement')).toThrow(
      StatementLineError,
    );
  });
});
