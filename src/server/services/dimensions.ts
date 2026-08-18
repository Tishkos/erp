/**
 * Dimensions service — Phase 02.4.
 *
 * Gathers the three layers §4.2 describes and hands them to the domain, which
 * resolves them. One round trip per posting line, not three, because the
 * posting engine (02.7) runs this for every line of every document in the
 * system.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  assertDimensionAvailable,
  assertDimensionsSupplied,
  effectiveRequirement,
  mandatoryDimensions,
  type DimensionDefinition,
  type DimensionRequirement,
  type DimensionRules,
  type DimensionType,
  type SuppliedDimensions,
} from '../domain/dimensions';
import { labelOf } from '../domain/dimensions';
import {
  accountRequiredDimension,
  accountTypeDimensionDefault,
  dimensionDefinition,
  documentTypeDimension,
} from '../db/schema';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { AccountNode } from '../domain/chart-of-accounts';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';

export const PERMISSION_OBJECT = 'dimension';

export class UnknownDimensionValueError extends Error {
  readonly code = 'DIMENSION_VALUE_UNKNOWN';

  constructor(
    readonly dimension: DimensionType,
    readonly value: string,
  ) {
    super(
      `'${value}' is not an active ${labelOf(dimension)}. Choose an existing one, or have it created first.`,
    );
    this.name = 'UnknownDimensionValueError';
  }
}

/** The registry — which dimensions exist and which are usable yet. */
export async function definitions(tx: Tx): Promise<DimensionDefinition[]> {
  const rows = await tx.select().from(dimensionDefinition);
  return rows.map((row) => ({
    dimension: row.dimension,
    label: row.label,
    sourceTable: row.sourceTable,
    isActive: row.isActive,
  }));
}

/**
 * The three layers for one account and one document type.
 *
 * Fetched here and resolved by the domain, so the decision itself is a pure
 * function over data the caller already holds.
 *
 * Sequential, not `Promise.all`: a transaction is one connection, and issuing
 * concurrent queries on it is deprecated in `pg` and an error from pg@9. The
 * driver serialises them regardless, so the parallel form buys nothing and
 * costs a warning that will one day become a failure.
 */
export async function rulesFor(
  tx: Tx,
  account: Pick<AccountNode, 'id' | 'accountType'>,
  documentTypeCode: string,
): Promise<DimensionRules> {
  const byDocumentTypeRows = await tx
    .select({
      dimension: documentTypeDimension.dimension,
      requirement: documentTypeDimension.requirement,
    })
    .from(documentTypeDimension)
    .where(eq(documentTypeDimension.documentTypeCode, documentTypeCode));

  // D7 (2026-08-17) — the account layer is inherited: the nearest self-or-
  // ancestor that declares its rules is the one that applies. Resolved in SQL
  // through `account_effective_dimensions`, so a report reading the same
  // function gets the same answer as a posting.
  const byAccountRows = await tx.execute<{ dimension: DimensionType }>(
    sql`select account_effective_dimensions(${account.id}::uuid) as dimension`,
  );

  const byAccountTypeRows = await tx
    .select({ dimension: accountTypeDimensionDefault.dimension })
    .from(accountTypeDimensionDefault)
    .where(eq(accountTypeDimensionDefault.accountType, account.accountType));

  const byDocumentType: Partial<Record<DimensionType, DimensionRequirement>> = {};
  for (const row of byDocumentTypeRows) {
    byDocumentType[row.dimension] = row.requirement;
  }

  // D7 — whether anything in this account's ancestry states its rules. When
  // something does, layer 2 is an answer rather than a silence and §4.2's
  // account-type default is not consulted.
  const declares = await tx.execute<{ declares: boolean }>(sql`
    with recursive chain as (
      select id, parent_id, declares_dimensions
        from chart_of_account where id = ${account.id}::uuid
      union all
      select p.id, p.parent_id, p.declares_dimensions
        from chart_of_account p join chain c on c.parent_id = p.id
    )
    select exists (select 1 from chain where declares_dimensions) as declares
  `);

  return {
    byDocumentType,
    byAccount: byAccountRows.rows.map((r) => r.dimension),
    byAccountType: byAccountTypeRows.map((r) => r.dimension),
    accountDeclares: declares.rows[0]?.declares ?? false,
  };
}

/**
 * Validates the dimensions on one posting line.
 *
 * Two separate questions, in this order:
 *   1. is everything mandatory present?  — reported all at once (§25)
 *   2. does each supplied value exist?   — checked against its own master
 *
 * A missing value and a wrong value are different mistakes and deserve
 * different messages.
 */
export async function assertDimensionsValid(
  tx: Tx,
  account: Pick<AccountNode, 'id' | 'code' | 'accountType'>,
  documentTypeCode: string,
  supplied: SuppliedDimensions,
): Promise<void> {
  const rules = await rulesFor(tx, account, documentTypeCode);
  assertDimensionsSupplied(account.code, rules, supplied);

  const registry = await definitions(tx);

  for (const [dimension, value] of Object.entries(supplied) as Array<
    [DimensionType, string | null | undefined]
  >) {
    if (value === undefined || value === null || value === '') continue;

    const definition = registry.find((d) => d.dimension === dimension);
    if (!definition) {
      throw new UnknownDimensionValueError(dimension, value);
    }

    // A value for a dimension with no master cannot be checked, so it is
    // refused rather than stored unverified.
    assertDimensionAvailable(definition);

    const result = await tx.execute(
      sql`select dimension_value_exists(${dimension}::dimension_type, ${value}) as exists`,
    );
    const exists = (result.rows[0] as { exists: boolean } | undefined)?.exists ?? false;

    if (!exists) {
      throw new UnknownDimensionValueError(dimension, value);
    }
  }
}

/** What a screen shows against each field: required, or not. */
export async function requirementsFor(
  tx: Tx,
  account: Pick<AccountNode, 'id' | 'accountType'>,
  documentTypeCode: string,
): Promise<Record<DimensionType, DimensionRequirement>> {
  const rules = await rulesFor(tx, account, documentTypeCode);
  const resolved = {} as Record<DimensionType, DimensionRequirement>;

  for (const dimension of Object.keys(labelsByDimension()) as DimensionType[]) {
    resolved[dimension] = effectiveRequirement(dimension, rules);
  }
  return resolved;
}

/** The mandatory set, for a posting preview (§02.7). */
export async function mandatoryFor(
  tx: Tx,
  account: Pick<AccountNode, 'id' | 'accountType'>,
  documentTypeCode: string,
): Promise<DimensionType[]> {
  return mandatoryDimensions(await rulesFor(tx, account, documentTypeCode));
}

/**
 * Sets a document type's rule for a dimension — the layer that lets the same
 * account be mandatory on one document and optional on another.
 */
export async function setDocumentTypeRequirement(
  tx: Tx,
  ctx: ActorContext,
  documentTypeCode: string,
  dimension: DimensionType,
  requirement: DimensionRequirement,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  if (requirement === 'mandatory') {
    const registry = await definitions(tx);
    const definition = registry.find((d) => d.dimension === dimension);
    if (definition) assertDimensionAvailable(definition);
  }

  await tx
    .insert(documentTypeDimension)
    .values({ documentTypeCode, dimension, requirement })
    .onConflictDoUpdate({
      target: [documentTypeDimension.documentTypeCode, documentTypeDimension.dimension],
      set: { requirement },
    });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'dimension.requirement_configured',
    objectType: PERMISSION_OBJECT,
    objectId: `${documentTypeCode}:${dimension}`,
    branchCode: ctx.branchCode,
    after: { documentTypeCode, dimension, requirement },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Clears a document type's override so the account and type defaults apply again. */
export async function clearDocumentTypeRequirement(
  tx: Tx,
  ctx: ActorContext,
  documentTypeCode: string,
  dimension: DimensionType,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  await tx
    .delete(documentTypeDimension)
    .where(
      and(
        eq(documentTypeDimension.documentTypeCode, documentTypeCode),
        eq(documentTypeDimension.dimension, dimension),
      ),
    );

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'dimension.requirement_cleared',
    objectType: PERMISSION_OBJECT,
    objectId: `${documentTypeCode}:${dimension}`,
    branchCode: ctx.branchCode,
    before: { documentTypeCode, dimension },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Accounts that require a given dimension — "which accounts need a cost centre?"
 *
 * Effective, not declared. Since D7 (2026-08-17) a rule set on a group applies
 * to everything below it, so answering from `account_required_dimension` alone
 * would name the one group and none of the accounts anybody actually posts to —
 * which is exactly backwards for the question being asked.
 */
export async function accountsRequiring(tx: Tx, dimension: DimensionType): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    with recursive resolved as (
      select id, declares_dimensions,
             declares_dimensions as governs,
             id as rule_source
        from chart_of_account
       where parent_id is null
      union all
      select c.id, c.declares_dimensions,
             c.declares_dimensions as governs,
             case when c.declares_dimensions then c.id else r.rule_source end
        from chart_of_account c
        join resolved r on c.parent_id = r.id
    )
    select resolved.id
      from resolved
      join account_required_dimension d on d.account_id = resolved.rule_source
     where d.dimension = ${dimension}
  `);

  return rows.rows.map((r) => r.id);
}

/**
 * Sets the dimensions an account requires, replacing whatever it required
 * before — and marking it as declaring its own rules (D7).
 *
 * Replacing rather than adding, and declaring rather than merging, are the same
 * decision seen from two sides: Finance may *override* a group's rule, and an
 * override that could only add would not be an override.
 */
export async function setAccountRequirements(
  tx: Tx,
  ctx: ActorContext,
  accountId: string,
  dimensions: readonly DimensionType[],
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', 'chart_of_account', {
    branchCode: ctx.branchCode,
    objectId: accountId,
    requestId: ctx.requestId ?? null,
  });

  const registry = await definitions(tx);
  for (const dimension of dimensions) {
    const definition = registry.find((d) => d.dimension === dimension);
    if (definition) assertDimensionAvailable(definition);
  }

  await tx
    .delete(accountRequiredDimension)
    .where(eq(accountRequiredDimension.accountId, accountId));

  // D7 — declaring first: the trigger refuses a rule on an account that
  // inherits, and refuses it on the rule rather than on the account.
  await tx.execute(
    sql`update chart_of_account set declares_dimensions = true where id = ${accountId}::uuid`,
  );

  if (dimensions.length > 0) {
    await tx
      .insert(accountRequiredDimension)
      .values(dimensions.map((dimension) => ({ accountId, dimension })));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'chart_of_account.dimensions_configured',
    objectType: 'chart_of_account',
    objectId: accountId,
    branchCode: ctx.branchCode,
    after: { requiredDimensions: [...dimensions] },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Small local helper so the label map is not duplicated. */
function labelsByDimension(): Record<DimensionType, string> {
  return {
    branch: labelOf('branch'),
    department: labelOf('department'),
    business_line: labelOf('business_line'),
    project: labelOf('project'),
    warehouse: labelOf('warehouse'),
    business_partner: labelOf('business_partner'),
    employee: labelOf('employee'),
  };
}

export { inArray };
