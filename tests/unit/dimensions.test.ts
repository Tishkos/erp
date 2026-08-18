/**
 * Phase 02.4 test gate — the three-layer requirement resolution.
 *
 * The database-side assertions (a value must exist in its master, a dimension
 * with no master cannot be made mandatory) are in
 * tests/integration/phase02-dimensions.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DERIVED_DIMENSIONS,
  DIMENSION_TYPES,
  DerivedDimensionAlteredError,
  DimensionNotAvailableError,
  MissingDimensionsError,
  NO_DIMENSION_RULES,
  assertDerivedDimensionsUnchanged,
  assertDimensionAvailable,
  assertDimensionsSupplied,
  effectiveRequirement,
  isAvailable,
  isDerivedDimension,
  isDimensionType,
  labelOf,
  mandatoryDimensions,
  missingDimensions,
  dimensionRuleSource,
  resolveDeclaredDimensions,
  type DimensionRules,
  type DimensionType,
} from '@domain/dimensions';

const rules = (overrides: Partial<DimensionRules> = {}): DimensionRules => ({
  ...NO_DIMENSION_RULES,
  ...overrides,
});

describe('§4.2 · the seven dimensions', () => {
  it('are exactly the seven the blueprint lists', () => {
    expect(DIMENSION_TYPES).toEqual([
      'branch',
      'department',
      'business_line',
      'project',
      'warehouse',
      'business_partner',
      'employee',
    ]);
  });

  it('rejects anything outside the list', () => {
    expect(isDimensionType('branch')).toBe(true);
    expect(isDimensionType('region')).toBe(false);
  });

  it('labels them the way a user would name them', () => {
    expect(labelOf('department')).toBe('Department / Cost Centre');
    expect(labelOf('business_partner')).toBe('Customer / Supplier');
  });

  it('marks Customer/Supplier as derived from the source document', () => {
    expect(DERIVED_DIMENSIONS).toEqual(['business_partner']);
    expect(isDerivedDimension('business_partner')).toBe(true);
    expect(isDerivedDimension('branch')).toBe(false);
  });
});

describe('resolving a requirement across the three layers', () => {
  it('requires nothing when nothing is configured', () => {
    expect(mandatoryDimensions(rules())).toEqual([]);
    expect(effectiveRequirement('department', rules())).toBe('optional');
  });

  it('takes the account-type default when nothing more specific exists', () => {
    // §4.2 — "Department/Cost Centre: mandatory for operating expense accounts."
    const expense = rules({ byAccountType: ['department', 'business_line'] });
    expect(effectiveRequirement('department', expense)).toBe('mandatory');
    expect(effectiveRequirement('project', expense)).toBe('optional');
  });

  it('lets the account require a dimension its type does not', () => {
    // §14.3 — "Cost Centre is optional or mandatory according to the Chart of
    // Accounts setting for the selected account."
    const projectAsset = rules({ byAccount: ['project'] });
    expect(effectiveRequirement('project', projectAsset)).toBe('mandatory');
  });

  it('lets the document type override both', () => {
    const configured = rules({
      byDocumentType: { department: 'optional' },
      byAccount: ['department'],
      byAccountType: ['department'],
    });
    expect(effectiveRequirement('department', configured)).toBe('optional');
  });

  it('lets the document type add a requirement neither the account nor its type has', () => {
    // §4.2 — "Branch: mandatory for all operational transactions." A property
    // of the transaction, not of the account.
    const operational = rules({ byDocumentType: { branch: 'mandatory' } });
    expect(effectiveRequirement('branch', operational)).toBe('mandatory');
  });

  it('makes the same account mandatory on one document type and optional on another', () => {
    // The 02.4 gate, stated exactly.
    const account = { byAccount: ['department' as const], byAccountType: [] };

    const onJournal = rules({ ...account, byDocumentType: {} });
    const onExpenseClaim = rules({ ...account, byDocumentType: { department: 'optional' } });

    expect(effectiveRequirement('department', onJournal)).toBe('mandatory');
    expect(effectiveRequirement('department', onExpenseClaim)).toBe('optional');
  });

  it('lists every mandatory dimension in blueprint order', () => {
    const everything = rules({
      byDocumentType: { branch: 'mandatory' },
      byAccount: ['project'],
      byAccountType: ['department', 'business_line'],
    });
    expect(mandatoryDimensions(everything)).toEqual([
      'branch',
      'department',
      'business_line',
      'project',
    ]);
  });
});

describe('validating what was supplied', () => {
  const expenseAccount = rules({ byAccountType: ['department', 'business_line'] });

  it('accepts a posting that carries everything required', () => {
    expect(() =>
      assertDimensionsSupplied('X000002', expenseAccount, {
        department: 'FIN',
        business_line: 'TRADE',
      }),
    ).not.toThrow();
  });

  it('rejects a posting to an operating expense account with no Cost Centre', () => {
    // 02.4 gate, first line.
    expect(() =>
      assertDimensionsSupplied('X000002', expenseAccount, { business_line: 'TRADE' }),
    ).toThrow(MissingDimensionsError);
    expect(() =>
      assertDimensionsSupplied('X000002', expenseAccount, { business_line: 'TRADE' }),
    ).toThrow(/Department \/ Cost Centre/);
  });

  it('rejects a posting to a revenue account with no Business Line', () => {
    // 02.4 gate, second line.
    const revenue = rules({ byAccountType: ['business_line'] });
    expect(() => assertDimensionsSupplied('R000002', revenue, {})).toThrow(/Business Line/);
  });

  it('rejects a stock movement with no Warehouse', () => {
    // 02.4 gate, third line. Set on the document type, since it is a property
    // of the movement rather than of the account.
    const stockMovement = rules({ byDocumentType: { warehouse: 'mandatory' } });
    expect(() => assertDimensionsSupplied('A000010', stockMovement, {})).toThrow(/Warehouse/);
  });

  it('reports every missing dimension at once, not the first', () => {
    expect(missingDimensions(expenseAccount, {})).toEqual(['department', 'business_line']);
    expect(() => assertDimensionsSupplied('X000002', expenseAccount, {})).toThrow(
      /Department \/ Cost Centre, Business Line/,
    );
  });

  it('treats null and empty string as not supplied', () => {
    expect(missingDimensions(expenseAccount, { department: null, business_line: '' })).toEqual([
      'department',
      'business_line',
    ]);
  });

  it('ignores an optional dimension that was left empty', () => {
    expect(() =>
      assertDimensionsSupplied('X000002', expenseAccount, {
        department: 'FIN',
        business_line: 'TRADE',
        project: null,
      }),
    ).not.toThrow();
  });
});

describe('§4.2 · a derived dimension cannot be altered after posting', () => {
  it('refuses a change to Customer/Supplier', () => {
    // 02.4 gate: "Customer/Supplier on a posted line cannot be altered by any
    // path." Changing it would let the receivables subledger and the G/L
    // disagree about who owes the money.
    expect(() =>
      assertDerivedDimensionsUnchanged(
        { business_partner: 'CUST-001' },
        { business_partner: 'CUST-002' },
      ),
    ).toThrow(DerivedDimensionAlteredError);
  });

  it('refuses clearing it as well as changing it', () => {
    expect(() =>
      assertDerivedDimensionsUnchanged({ business_partner: 'CUST-001' }, { business_partner: null }),
    ).toThrow(/cannot be changed after posting/);
  });

  it('refuses setting one that was empty', () => {
    expect(() =>
      assertDerivedDimensionsUnchanged({}, { business_partner: 'CUST-001' }),
    ).toThrow(DerivedDimensionAlteredError);
  });

  it('allows an unchanged value', () => {
    expect(() =>
      assertDerivedDimensionsUnchanged(
        { business_partner: 'CUST-001', department: 'FIN' },
        { business_partner: 'CUST-001', department: 'FIN' },
      ),
    ).not.toThrow();
  });

  it('does not restrict the dimensions that are not derived', () => {
    expect(() =>
      assertDerivedDimensionsUnchanged({ department: 'FIN' }, { department: 'SLS' }),
    ).not.toThrow();
  });

  it('names both values so the refusal can be understood', () => {
    expect(() =>
      assertDerivedDimensionsUnchanged(
        { business_partner: 'CUST-001' },
        { business_partner: 'CUST-002' },
      ),
    ).toThrow(/It was CUST-001 and the change to CUST-002 was refused/);
  });
});

describe('a dimension with no master data yet', () => {
  const warehouse = {
    dimension: 'warehouse' as const,
    label: 'Warehouse',
    sourceTable: null,
    isActive: true,
  };

  it('is not available', () => {
    expect(isAvailable(warehouse)).toBe(false);
    expect(() => assertDimensionAvailable(warehouse)).toThrow(DimensionNotAvailableError);
  });

  it('says when it will become available, rather than just refusing', () => {
    expect(() => assertDimensionAvailable(warehouse)).toThrow(
      /becomes available when the phase that delivers its master data registers it/,
    );
  });

  it('is available once a source is registered', () => {
    expect(isAvailable({ ...warehouse, sourceTable: 'warehouse' })).toBe(true);
  });

  it('is not available if it has been deactivated', () => {
    expect(isAvailable({ ...warehouse, sourceTable: 'warehouse', isActive: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D7, decided 2026-08-17: "Dimension rules are configured primarily at the
// account-group level. Child accounts automatically inherit the group's rules …
// Finance may override a rule for a specific account when necessary."
// ---------------------------------------------------------------------------
describe('D7 · dimension rules are inherited from the group', () => {
  const group = (dimensions: DimensionType[]) => ({
    accountCode: 'X100000',
    declaresDimensions: true,
    dimensions,
  });
  const inheriting = (code: string) => ({
    accountCode: code,
    declaresDimensions: false,
    dimensions: [] as DimensionType[],
  });

  it('takes the group’s rules when the account declares none', () => {
    // The chain runs outwards: the account, then its parent, then the root.
    const chain = [inheriting('X100001'), group(['branch', 'department'])];
    expect([...resolveDeclaredDimensions(chain)].sort()).toEqual(['branch', 'department']);
  });

  it('walks past a group that declares nothing to one that does', () => {
    const chain = [
      inheriting('X100002'),
      inheriting('X100001'),
      group(['branch']),
    ];
    expect(resolveDeclaredDimensions(chain)).toEqual(['branch']);
  });

  it('lets the account override the group entirely', () => {
    const chain = [
      { accountCode: 'X100003', declaresDimensions: true, dimensions: ['project'] as DimensionType[] },
      group(['branch', 'department']),
    ];
    // Not a merge. Merging would make it impossible to *remove* a requirement,
    // and the decision says Finance may override.
    expect(resolveDeclaredDimensions(chain)).toEqual(['project']);
  });

  it('lets an account require nothing, against a group that requires something', () => {
    const chain = [
      { accountCode: 'X100004', declaresDimensions: true, dimensions: [] as DimensionType[] },
      group(['branch']),
    ];
    // An empty declaration is how "not for this account" is said. It is a
    // different fact from having said nothing at all.
    expect(resolveDeclaredDimensions(chain)).toEqual([]);
  });

  it('requires nothing when no one in the chain declares', () => {
    expect(resolveDeclaredDimensions([inheriting('A100001'), inheriting('A000001')])).toEqual([]);
  });

  it('names where the rule came from, so Finance knows what to change', () => {
    const chain = [inheriting('X100001'), group(['branch'])];
    expect(dimensionRuleSource(chain)).toBe('X100000');
    expect(dimensionRuleSource([inheriting('A100001')])).toBeNull();
  });
});
