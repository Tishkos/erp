/**
 * Dimensions framework — Phase 02.4.
 *
 * §4.2: "Dimensions shall be mandatory or optional by account and document
 * type."
 *
 * Two words in that sentence do the work: *and* means a requirement can come
 * from either side, and *by* means it is configuration rather than code. So
 * this module resolves a requirement from three layers and refuses to guess
 * when it cannot.
 *
 * ── Precedence, and why it runs this way ────────────────────────────────────
 *
 *   1. the document type      most specific to what is being posted
 *   2. the account            §14.3: "Cost Centre is optional or mandatory
 *                             according to the Chart of Accounts setting for
 *                             the selected account"
 *   3. the account type       §4.2's own table: Cost Centre for operating
 *                             expenses, Business Line for revenue and direct
 *                             cost, and so on
 *   4. optional              nothing said, nothing required
 *
 * The document type sits above the account because the 02.4 gate asks for
 * exactly that: "The same account can be mandatory for one document type and
 * optional for another, if so configured." The account sits above the type
 * default because §14.3 names the account as the deciding setting. Neither
 * ordering is arbitrary and neither is ours to change.
 */

/** The seven dimensions of §4.2. Closed list. */
export const DIMENSION_TYPES = [
  'branch',
  'department',
  'business_line',
  'project',
  'warehouse',
  'business_partner',
  'employee',
] as const;

export type DimensionType = (typeof DIMENSION_TYPES)[number];

export function isDimensionType(value: string): value is DimensionType {
  return (DIMENSION_TYPES as readonly string[]).includes(value);
}

export type DimensionRequirement = 'mandatory' | 'optional';

/** One link in an account's ancestry, for resolving inherited rules. */
export interface DimensionDeclaration {
  readonly accountCode: string;
  /** True when this account states its own rules rather than inheriting. */
  readonly declaresDimensions: boolean;
  /** Its own rules. Meaningful only where `declaresDimensions` is true. */
  readonly dimensions: readonly DimensionType[];
}

/**
 * D7, decided 2026-08-17 — *"child accounts automatically inherit the group's
 * rules … Finance may override a rule for a specific account when necessary."*
 *
 * The chain runs from the account outwards: itself, its parent, its
 * grandparent, up to the root. The first link that declares wins, and nothing
 * further up is consulted — an override is total, not additive.
 *
 * That last point is the one worth being deliberate about. Merging an account's
 * rules with its group's would make it impossible to *remove* a requirement
 * ("Finance may override a rule") — you could only ever add. So a declaring
 * account replaces the inheritance outright, and declaring no dimensions is how
 * Finance says "not for this account".
 */
export function resolveDeclaredDimensions(
  chain: readonly DimensionDeclaration[],
): readonly DimensionType[] {
  const declaring = chain.find((link) => link.declaresDimensions);
  return declaring ? declaring.dimensions : [];
}

/**
 * Which account in the chain the rules actually came from.
 *
 * Returned separately because a screen that says "Branch is required" is much
 * less useful than one that says "Branch is required — inherited from Operating
 * Expenses". Finance overrides the rule on the group far more often than on the
 * account, and they cannot do that without being told which group it is.
 */
export function dimensionRuleSource(
  chain: readonly DimensionDeclaration[],
): string | null {
  return chain.find((link) => link.declaresDimensions)?.accountCode ?? null;
}

/**
 * Dimensions the system fills in from the source document rather than taking
 * from a user — §4.2: "Derived from source document; not manually altered after
 * posting."
 *
 * A sales invoice knows its customer. Letting that be edited on the posted
 * journal line would let the receivables subledger and the G/L disagree about
 * who owes the money, which is the one thing a control account exists to
 * prevent.
 */
export const DERIVED_DIMENSIONS = ['business_partner'] as const;
export type DerivedDimension = (typeof DERIVED_DIMENSIONS)[number];

export function isDerivedDimension(dimension: DimensionType): dimension is DerivedDimension {
  return (DERIVED_DIMENSIONS as readonly string[]).includes(dimension);
}

/** Everything the resolution needs, gathered by the service in one round trip. */
export interface DimensionRules {
  /** Layer 1 — explicit setting for this document type, if any. */
  readonly byDocumentType: Readonly<Partial<Record<DimensionType, DimensionRequirement>>>;
  /** Layer 2 — dimensions this account requires (`account_required_dimension`). */
  readonly byAccount: readonly DimensionType[];
  /** Layer 3 — §4.2 defaults for the account's type. */
  readonly byAccountType: readonly DimensionType[];
  /**
   * D7 — whether the account (or an ancestor) states its own rules.
   *
   * True means layer 2 is an answer rather than a silence, and layer 3 is not
   * consulted. False means nobody has said anything about this account and
   * §4.2's type default stands.
   */
  readonly accountDeclares?: boolean;
}

export const NO_DIMENSION_RULES: DimensionRules = {
  byDocumentType: {},
  byAccount: [],
  byAccountType: [],
  accountDeclares: false,
};

/** A value supplied on a posting line. */
export type SuppliedDimensions = Readonly<Partial<Record<DimensionType, string | null>>>;

export class MissingDimensionsError extends Error {
  readonly code = 'DIMENSIONS_MISSING';

  constructor(
    readonly accountCode: string,
    readonly missing: readonly DimensionType[],
  ) {
    super(
      `Account ${accountCode} requires ${missing.map(labelOf).join(', ')}. ` +
        'Supply the missing value(s) and post again.',
    );
    this.name = 'MissingDimensionsError';
  }
}

export class DimensionNotAvailableError extends Error {
  readonly code = 'DIMENSION_NOT_AVAILABLE';

  constructor(readonly dimension: DimensionType) {
    super(
      `The ${labelOf(dimension)} dimension has no master data yet, so it cannot be required or supplied. ` +
        'It becomes available when the module that delivers its master data registers it.',
    );
    this.name = 'DimensionNotAvailableError';
  }
}

export class DerivedDimensionAlteredError extends Error {
  readonly code = 'DERIVED_DIMENSION_ALTERED';

  constructor(
    readonly dimension: DerivedDimension,
    readonly from: string | null,
    readonly to: string | null,
  ) {
    super(
      `${labelOf(dimension)} is derived from the source document and cannot be changed after posting ` +
        `(§4.2). It was ${from ?? 'empty'} and the change to ${to ?? 'empty'} was refused. ` +
        'Correct the source document through its approved reversal instead.',
    );
    this.name = 'DerivedDimensionAlteredError';
  }
}

/** Human labels, so a validation message reads like §25 requires. */
const LABELS: Readonly<Record<DimensionType, string>> = {
  branch: 'Branch',
  department: 'Department / Cost Centre',
  business_line: 'Business Line',
  project: 'Project',
  warehouse: 'Warehouse',
  business_partner: 'Customer / Supplier',
  employee: 'Employee / Salesperson',
};

export function labelOf(dimension: DimensionType): string {
  return LABELS[dimension];
}

/**
 * The resolution, for one dimension.
 *
 * Three layers, most specific first — and D7 (2026-08-17) sharpened the middle
 * one. *"Finance may override a rule for a specific account when necessary"*: an
 * account (or the group it inherits from) that **declares** its rules replaces
 * §4.2's account-type default outright rather than adding to it. An override
 * that could only ever add would not be an override — Finance could make an
 * expense account require a project, but never stop one requiring a department.
 *
 * Where nothing declares, `accountDeclares` is false and the type default
 * stands, which is §4.2 unchanged.
 */
export function effectiveRequirement(
  dimension: DimensionType,
  rules: DimensionRules,
): DimensionRequirement {
  const fromDocumentType = rules.byDocumentType[dimension];
  if (fromDocumentType) return fromDocumentType;

  if (rules.byAccount.includes(dimension)) return 'mandatory';
  if (rules.accountDeclares) return 'optional';
  if (rules.byAccountType.includes(dimension)) return 'mandatory';

  return 'optional';
}

/** Every dimension this posting must carry. */
export function mandatoryDimensions(rules: DimensionRules): DimensionType[] {
  return DIMENSION_TYPES.filter((d) => effectiveRequirement(d, rules) === 'mandatory');
}

/**
 * What is missing, all of it.
 *
 * A list rather than the first failure, because §25 requires the message to
 * tell the user what to fix, and fixing one field at a time is how people come
 * to hate a system.
 */
export function missingDimensions(
  rules: DimensionRules,
  supplied: SuppliedDimensions,
): DimensionType[] {
  return mandatoryDimensions(rules).filter((dimension) => {
    const value = supplied[dimension];
    return value === undefined || value === null || value === '';
  });
}

export function assertDimensionsSupplied(
  accountCode: string,
  rules: DimensionRules,
  supplied: SuppliedDimensions,
): void {
  const missing = missingDimensions(rules, supplied);
  if (missing.length > 0) {
    throw new MissingDimensionsError(accountCode, missing);
  }
}

/**
 * §4.2 — a derived dimension is fixed once the document is posted.
 *
 * Compares the dimensions of a posted line against a proposed replacement.
 * Anything that is not derived may still change through the normal correction
 * routes; a derived one may not change at all.
 */
export function assertDerivedDimensionsUnchanged(
  before: SuppliedDimensions,
  after: SuppliedDimensions,
): void {
  for (const dimension of DERIVED_DIMENSIONS) {
    const from = before[dimension] ?? null;
    const to = after[dimension] ?? null;
    if (from !== to) {
      throw new DerivedDimensionAlteredError(dimension, from, to);
    }
  }
}

/**
 * Where a dimension's values live.
 *
 * Branch and Department have masters from Phase 01. The rest arrive with the
 * phases that own them — Business Line and Business Partner in Phase 03,
 * Warehouse in Phase 04, Project in Phase 11, Employee in Phase 15. Until then
 * the dimension is registered but has nowhere to draw values from, and this is
 * the flag that says so.
 */
export interface DimensionDefinition {
  readonly dimension: DimensionType;
  readonly label: string;
  /** Null until the module that delivers this dimension's master data lands. */
  readonly sourceTable: string | null;
  readonly isActive: boolean;
}

export function isAvailable(definition: DimensionDefinition): boolean {
  return definition.isActive && definition.sourceTable !== null;
}

/**
 * Refuses to configure or supply a dimension whose master does not exist.
 *
 * Failing loudly here is the point: silently accepting a Warehouse value before
 * warehouses exist would store codes nothing can validate, and Phase 04 would
 * inherit a column full of typos.
 */
export function assertDimensionAvailable(definition: DimensionDefinition): void {
  if (!isAvailable(definition)) {
    throw new DimensionNotAvailableError(definition.dimension);
  }
}
