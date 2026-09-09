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

describe('the layout belongs to Finance, including the lines it started with', () => {
  const rows: StatementLineRow[] = [
    {
      id: 'is-header',
      code: 'expenses_header',
      name: 'Expenses',
      statement: 'income_statement',
      parentId: null,
      isHeader: true,
      ordinal: 40,
      role: null,
      side: null,
      cashFlowCategory: null,
      isCash: false,
      isSystem: false,
    },
    {
      id: 'is-admin',
      code: 'administrative_expenses',
      name: 'Administrative Expenses',
      statement: 'income_statement',
      parentId: 'is-header',
      isHeader: false,
      ordinal: 10,
      role: 'operating_expenses',
      side: null,
      cashFlowCategory: null,
      isCash: false,
      isSystem: false,
    },
  ];
  const catalogue = new LineCatalogue(rows);

  it('nests a line under the header it was given', () => {
    const tree = catalogue.treeFor('income_statement');
    expect(tree).toHaveLength(1);
    expect(tree[0]!.line.code).toBe('expenses_header');
    expect(tree[0]!.children.map((child) => child.line.code)).toEqual(['administrative_expenses']);
    expect(catalogue.flattened('income_statement').map((entry) => entry.depth)).toEqual([0, 1]);
  });

  it('finds another line of the same kind when the seeded one has been removed', () => {
    // 'operating_expenses' is what an unmapped expense account prefers, and
    // this layout does not have it: Finance removed it and built its own.
    expect(catalogue.byCode('operating_expenses')).toBeUndefined();
    expect(catalogue.lineFor('expense', 'income_statement', null)?.code).toBe(
      'administrative_expenses',
    );
  });

  it('never falls to a header, which prints the sum of its lines', () => {
    expect(catalogue.lineFor('expense', 'income_statement', 'expenses_header')?.code).toBe(
      'administrative_expenses',
    );
  });

  it('reports nothing where the report has no line of that kind at all', () => {
    expect(catalogue.lineFor('revenue', 'income_statement', null)).toBeUndefined();
    expect(catalogue.lineFor('asset', 'balance_sheet', null)).toBeUndefined();
  });

  it('knows what sits beneath a line, so nothing is moved inside itself', () => {
    expect([...catalogue.descendantIds('is-header')]).toEqual(['is-admin']);
    expect([...catalogue.descendantIds('is-admin')]).toEqual([]);
    expect(catalogue.heightOf('is-header')).toBe(1);
  });
});
