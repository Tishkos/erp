/**
 * Fixed assets — Phase 12, §18 and Appendix C.
 *
 * > §18.2: *"Finance creates the Fixed Asset Document directly from the approved
 * > purchasing evidence."* · *"**No Asset Clearing Account is required** by the
 * > approved company workflow."*
 * > §18.5: *"Depreciation cannot begin before Available for Use Date."* ·
 * > *"Transfer and disposal retain complete approval and document history."*
 *
 * **No clearing account, anywhere.** §18.2 says the approved workflow does not
 * use one, so recognition posts Dr Fixed Asset Cost / Cr the source account with
 * nothing in between. There is no role, no column and no code path that could
 * introduce one — adding it because other systems have it would be an
 * unapproved change under §28.
 *
 * **The depreciation run is idempotent by construction.** One row per asset per
 * period, held by a unique index; a second run collides rather than charging
 * twice. A guard inside the job would work until somebody ran two copies of it.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  assetCategory,
  assetDepreciation,
  assetImpairment,
  assetTransfer,
  assetVerification,
  fixedAsset,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertAvailable,
  assertImpairable,
  AssetNotDisposableError,
  carryingValue,
  disposalOutcome,
  monthlyCharge,
  type CarryingValue,
  type DepreciationMethod,
} from '../domain/fixed-assets';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import type { PostingLineRequest } from '../domain/posting';
import { allocateDocumentNumber } from './numbering';
import * as jobs from './jobs';

export const DOCUMENT_TYPE = 'fixed_asset';
export const PERMISSION_OBJECT = 'fixed_asset';
const SEQUENCE_KEY = 'FIXED_ASSET';

export { carryingValue, disposalOutcome, monthlyCharge } from '../domain/fixed-assets';

export class AssetStateError extends Error {
  readonly code = 'ASSET_STATE_INVALID';
  constructor(assetCode: string, status: string, detail: string) {
    super(`Asset ${assetCode} is '${status}': ${detail}`);
    this.name = 'AssetStateError';
  }
}

async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(fixedAsset).where(eq(fixedAsset.id, id)).limit(1);
  if (!row) throw new Error(`No fixed asset with id '${id}'.`);
  return row;
}

// ---------------------------------------------------------------------------
// 12.2 — the Fixed Asset Document
// ---------------------------------------------------------------------------

export interface CreateAssetInput {
  readonly description: string;
  readonly categoryCode: string;
  readonly branchCode: string;
  readonly acquisitionCostIqd: bigint;
  readonly acquiredOn: string;
  /** §18.2 — mandatory. The earliest date depreciation may begin. */
  readonly availableForUseOn: string;
  readonly departmentCode?: string | null;
  readonly costCentreCode?: string | null;
  readonly location?: string | null;
  readonly custodianUserId?: string | null;
  readonly usefulLifeMonths?: number;
  readonly residualValueIqd?: bigint;
  readonly depreciationMethod?: DepreciationMethod;
  /** §18.2 — the purchasing evidence Finance created the document from. */
  readonly apInvoiceId?: string | null;
  readonly supplierReference?: string | null;
}

/**
 * §18.2 — the Fixed Asset Document.
 *
 * The category supplies the defaults and the document may override them where
 * policy allows; what it may not do is omit the Available for Use Date, which
 * the column refuses to be null. An asset with no commissioning date cannot
 * exist, so no depreciation run has to decide what to do about one.
 */
export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateAssetInput,
): Promise<{ id: string; assetCode: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const [category] = await tx
    .select()
    .from(assetCategory)
    .where(eq(assetCategory.code, input.categoryCode))
    .limit(1);

  if (!category) throw new Error(`No asset category '${input.categoryCode}'.`);

  const usefulLifeMonths = input.usefulLifeMonths ?? category.defaultUsefulLifeMonths;
  if (!usefulLifeMonths || usefulLifeMonths <= 0) {
    throw new Error(
      `${input.categoryCode} has no default useful life, so this asset must state one (§18.2). ` +
        'An asset with no life cannot be depreciated, and a default of zero would silently mean ' +
        'never.',
    );
  }

  const residualValueIqd =
    input.residualValueIqd ??
    (category.defaultResidualPercent
      ? (input.acquisitionCostIqd * parseDecimal(category.defaultResidualPercent, 4n)) / 1_000_000n
      : 0n);

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.acquiredOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(fixedAsset)
    .values({
      assetCode: allocated.documentNo,
      description: input.description.trim(),
      categoryCode: input.categoryCode,
      branchCode: input.branchCode,
      departmentCode: input.departmentCode ?? null,
      costCentreCode: input.costCentreCode ?? null,
      location: input.location ?? null,
      custodianUserId: input.custodianUserId ?? null,
      acquisitionCostIqd: toDecimalString(input.acquisitionCostIqd, 4n),
      acquiredOn: input.acquiredOn,
      usefulLifeMonths,
      residualValueIqd: toDecimalString(residualValueIqd, 4n),
      depreciationMethod: input.depreciationMethod ?? category.defaultMethod,
      availableForUseOn: input.availableForUseOn,
      apInvoiceId: input.apInvoiceId ?? null,
      supplierReference: input.supplierReference ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: fixedAsset.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.created',
    objectType: DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      assetCode: allocated.documentNo,
      category: input.categoryCode,
      acquisitionCostIqd: toDecimalString(input.acquisitionCostIqd, 4n),
      acquiredOn: input.acquiredOn,
      availableForUseOn: input.availableForUseOn,
      evidence: input.apInvoiceId ?? input.supplierReference ?? null,
    },
    outcome: 'success',
  });

  return { id: created!.id, assetCode: allocated.documentNo };
}

/**
 * §18.2 and Appendix C — recognition: Dr Fixed Asset Cost / Cr the source
 * account.
 *
 * **Two lines, and nothing in between.** §18.2 says the approved company
 * workflow uses no Asset Clearing Account, so the credit goes straight to
 * whichever account the purchase came from — the supplier payable, the bank, or
 * another account Finance names.
 */
export async function recognise(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { creditAccountId: string; postingDate?: string },
): Promise<{ journalEntryId: string }> {
  const asset = await load(tx, id);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: asset.branchCode,
  });

  if (asset.status !== 'draft' && asset.status !== 'approved') {
    throw new AssetStateError(asset.assetCode, asset.status, 'it has already been recognised.');
  }

  const [category] = await tx
    .select()
    .from(assetCategory)
    .where(eq(assetCategory.code, asset.categoryCode))
    .limit(1);

  const criteria = { branchCode: asset.branchCode };
  // §4.2 names seven dimensions and cost centre is not one of them: it is a
  // document field, not something a journal line carries. The asset keeps it,
  // and the register reports on it; the ledger does not.
  const dimensions = {
    branch: asset.branchCode,
    department: asset.departmentCode,
  };

  const result = await posting.post(tx, ctx, {
    eventType: 'assets.recognition',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'assets', documentId: id, event: 'recognised' },
    branchCode: asset.branchCode,
    documentDate: input.postingDate ?? asset.acquiredOn,
    postingDate: input.postingDate ?? asset.acquiredOn,
    description: `Fixed asset ${asset.assetCode} — ${asset.description}`,
    lines: [
      {
        role: category!.costAccountRole,
        debit: asset.acquisitionCostIqd,
        criteria,
        dimensions,
      },
      // §18.2 — straight to the source account. No clearing account.
      {
        role: 'asset_source',
        accountId: input.creditAccountId,
        credit: asset.acquisitionCostIqd,
        criteria,
        dimensions: { branch: asset.branchCode },
      },
    ],
  });

  await tx
    .update(fixedAsset)
    .set({
      status: 'available_for_use',
      journalEntryId: result.journalEntryId,
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(fixedAsset.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.recognised',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: asset.branchCode,
    before: { status: asset.status },
    after: { status: 'available_for_use', journalEntryId: result.journalEntryId },
    outcome: 'success',
  });

  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// 12.3 — depreciation
// ---------------------------------------------------------------------------

export interface RunResult {
  readonly periodEnd: string;
  readonly assetsCharged: number;
  readonly assetsSkipped: number;
  readonly totalChargeIqd: string;
}

/**
 * §18.4 — the depreciation run for one period.
 *
 * Idempotent because the table is: one row per asset per period, held by a
 * unique index. A second run for the same period inserts nothing and reports
 * every asset as skipped, which is the truthful answer rather than a silent
 * success.
 *
 * Each charge carries the asset's **current** branch, department and cost
 * centre. A transfer therefore moves future depreciation and leaves the past
 * where it was, which is what §18.4 asks for and what makes the register
 * reconcile by dimension.
 */
export async function runDepreciation(
  tx: Tx,
  ctx: ActorContext,
  input: { periodStart: string; periodEnd: string; branchCode?: string | null },
): Promise<RunResult> {
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: input.branchCode ?? ctx.branchCode,
  });

  const assets = await tx
    .select()
    .from(fixedAsset)
    .where(
      and(
        sql`${fixedAsset.status} in ('available_for_use', 'active')`,
        input.branchCode ? eq(fixedAsset.branchCode, input.branchCode) : sql`true`,
      ),
    )
    .orderBy(fixedAsset.assetCode);

  let charged = 0;
  let skipped = 0;
  let total = 0n;

  for (const asset of assets) {
    // §18.5 — nothing before the Available for Use Date.
    if (asset.availableForUseOn > input.periodEnd) {
      skipped += 1;
      continue;
    }

    const accumulated = await accumulatedDepreciationOf(tx, asset.id);

    const charge = monthlyCharge(
      {
        acquisitionCostIqd: parseDecimal(asset.acquisitionCostIqd, 4n),
        residualValueIqd: parseDecimal(asset.residualValueIqd, 4n),
        usefulLifeMonths: asset.usefulLifeMonths,
        method: asset.depreciationMethod,
        availableForUseOn: asset.availableForUseOn,
      },
      accumulated,
      input.periodStart,
      input.periodEnd,
    );

    if (charge.chargeIqd <= 0n) {
      skipped += 1;
      continue;
    }

    const inserted = await tx
      .insert(assetDepreciation)
      .values({
        assetId: asset.id,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        chargeIqd: toDecimalString(charge.chargeIqd, 4n),
        accumulatedAfterIqd: toDecimalString(charge.accumulatedAfterIqd, 4n),
        branchCode: asset.branchCode,
        departmentCode: asset.departmentCode,
        costCentreCode: asset.costCentreCode,
        postedBy: ctx.principal.userId,
      })
      .onConflictDoNothing({
        target: [assetDepreciation.assetId, assetDepreciation.periodEnd],
      })
      .returning({ id: assetDepreciation.id });

    // Already charged for this period: the unique index said so.
    if (inserted.length === 0) {
      skipped += 1;
      continue;
    }

    const [category] = await tx
      .select()
      .from(assetCategory)
      .where(eq(assetCategory.code, asset.categoryCode))
      .limit(1);

    const criteria = { branchCode: asset.branchCode };
    const dimensions = {
      branch: asset.branchCode,
      department: asset.departmentCode,
    };

    const result = await posting.post(tx, ctx, {
      eventType: 'assets.depreciation',
      documentTypeCode: DOCUMENT_TYPE,
      source: { module: 'assets', documentId: asset.id, event: `depreciation-${input.periodEnd}` },
      branchCode: asset.branchCode,
      documentDate: input.periodEnd,
      postingDate: input.periodEnd,
      description: `Depreciation ${asset.assetCode} — ${input.periodEnd}`,
      lines: [
        {
          role: category!.depreciationExpenseRole,
          debit: toDecimalString(charge.chargeIqd, 4n),
          criteria,
          dimensions,
        },
        {
          role: category!.accumulatedDepreciationRole,
          credit: toDecimalString(charge.chargeIqd, 4n),
          criteria,
          dimensions: { branch: asset.branchCode },
        },
      ],
    });

    await tx
      .update(assetDepreciation)
      .set({ journalEntryId: result.journalEntryId })
      .where(eq(assetDepreciation.id, inserted[0]!.id));

    if (asset.status === 'available_for_use') {
      await tx
        .update(fixedAsset)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(fixedAsset.id, asset.id));
    }

    charged += 1;
    total += charge.chargeIqd;
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.depreciation_run',
    objectType: DOCUMENT_TYPE,
    objectId: input.periodEnd,
    branchCode: input.branchCode ?? ctx.branchCode,
    after: {
      period: `${input.periodStart}..${input.periodEnd}`,
      charged,
      skipped,
      totalChargeIqd: toDecimalString(total, 4n),
    },
    outcome: 'success',
  });

  return {
    periodEnd: input.periodEnd,
    assetsCharged: charged,
    assetsSkipped: skipped,
    totalChargeIqd: toDecimalString(total, 4n),
  };
}

export async function accumulatedDepreciationOf(tx: Tx, assetId: string): Promise<bigint> {
  const result = (await tx.execute(sql`
    select coalesce(sum(d.charge_iqd), 0)::text as "total"
      from asset_depreciation d where d.asset_id = ${assetId}
  `)) as unknown as { rows: { total: string }[] };
  return parseDecimal(result.rows[0]?.total ?? '0', 4n);
}

export async function accumulatedImpairmentOf(tx: Tx, assetId: string): Promise<bigint> {
  const result = (await tx.execute(sql`
    select coalesce(sum(i.amount_iqd), 0)::text as "total"
      from asset_impairment i where i.asset_id = ${assetId}
  `)) as unknown as { rows: { total: string }[] };
  return parseDecimal(result.rows[0]?.total ?? '0', 4n);
}

/** §18.8 — cost less accumulated depreciation less accumulated impairment. */
export async function carryingValueOf(tx: Tx, assetId: string): Promise<CarryingValue> {
  const asset = await load(tx, assetId);
  return carryingValue({
    acquisitionCostIqd: parseDecimal(asset.acquisitionCostIqd, 4n),
    accumulatedDepreciationIqd: await accumulatedDepreciationOf(tx, assetId),
    accumulatedImpairmentIqd: await accumulatedImpairmentOf(tx, assetId),
  });
}

// ---------------------------------------------------------------------------
// 12.4 — transfers
// ---------------------------------------------------------------------------

/**
 * §18.5 — a transfer, with its approval history.
 *
 * The old dimensions are copied onto the transfer before the asset moves, so
 * *"what did this asset used to belong to?"* is a fact rather than an inference
 * from a depreciation row. Future depreciation carries the new dimensions; the
 * past keeps the old, because each charge stored the ones it was posted with.
 */
export async function transfer(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    transferredOn: string;
    reason: string;
    requestedBy: string;
    toBranchCode?: string | null;
    toDepartmentCode?: string | null;
    toCostCentreCode?: string | null;
    toLocation?: string | null;
    toCustodianUserId?: string | null;
  },
): Promise<{ id: string }> {
  const asset = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: asset.branchCode,
  });

  if (asset.status === 'disposed' || asset.status === 'closed') {
    throw new AssetStateError(asset.assetCode, asset.status, 'a disposed asset cannot be moved.');
  }
  if (!input.reason.trim()) {
    throw new Error(
      'A transfer needs a reason (§18.5). The approval history is what the register is checked ' +
        'against at verification, and a move with no reason cannot be checked.',
    );
  }
  if (input.requestedBy === ctx.principal.userId) {
    throw new Error(
      'You requested this transfer, so somebody else approves it (§5.2). An asset moved on one ' +
        "person's say-so is an asset nobody can be asked about.",
    );
  }

  const [created] = await tx
    .insert(assetTransfer)
    .values({
      assetId: id,
      transferredOn: input.transferredOn,
      fromBranchCode: asset.branchCode,
      fromDepartmentCode: asset.departmentCode,
      fromCostCentreCode: asset.costCentreCode,
      fromLocation: asset.location,
      fromCustodianUserId: asset.custodianUserId,
      toBranchCode: input.toBranchCode ?? asset.branchCode,
      toDepartmentCode: input.toDepartmentCode ?? asset.departmentCode,
      toCostCentreCode: input.toCostCentreCode ?? asset.costCentreCode,
      toLocation: input.toLocation ?? asset.location,
      toCustodianUserId: input.toCustodianUserId ?? asset.custodianUserId,
      reason: input.reason.trim(),
      requestedBy: input.requestedBy,
      approvedBy: ctx.principal.userId,
    })
    .returning({ id: assetTransfer.id });

  await tx
    .update(fixedAsset)
    .set({
      branchCode: input.toBranchCode ?? asset.branchCode,
      departmentCode: input.toDepartmentCode ?? asset.departmentCode,
      costCentreCode: input.toCostCentreCode ?? asset.costCentreCode,
      location: input.toLocation ?? asset.location,
      custodianUserId: input.toCustodianUserId ?? asset.custodianUserId,
      updatedAt: new Date(),
    })
    .where(eq(fixedAsset.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.transferred',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: asset.branchCode,
    before: {
      branch: asset.branchCode,
      department: asset.departmentCode,
      costCentre: asset.costCentreCode,
      custodian: asset.custodianUserId,
    },
    after: {
      branch: input.toBranchCode ?? asset.branchCode,
      department: input.toDepartmentCode ?? asset.departmentCode,
      costCentre: input.toCostCentreCode ?? asset.costCentreCode,
      custodian: input.toCustodianUserId ?? asset.custodianUserId,
    },
    reason: input.reason.trim(),
    outcome: 'success',
  });

  return { id: created!.id };
}

/** §20 — what an employee is holding, for the offboarding clearance. */
export async function assetsHeldBy(tx: Tx, userId: string) {
  return tx
    .select({
      assetCode: fixedAsset.assetCode,
      description: fixedAsset.description,
      location: fixedAsset.location,
      status: fixedAsset.status,
    })
    .from(fixedAsset)
    .where(
      and(
        eq(fixedAsset.custodianUserId, userId),
        sql`${fixedAsset.status} not in ('disposed', 'closed')`,
      ),
    )
    .orderBy(fixedAsset.assetCode);
}

// ---------------------------------------------------------------------------
// 12.5 — impairment
// ---------------------------------------------------------------------------

export async function impair(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { impairedOn: string; amountIqd: bigint; reason: string },
): Promise<{ journalEntryId: string; carryingValueAfterIqd: bigint }> {
  const asset = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: asset.branchCode,
  });

  if (asset.status === 'disposed' || asset.status === 'closed') {
    throw new AssetStateError(asset.assetCode, asset.status, 'a disposed asset cannot be impaired.');
  }
  if (!input.reason.trim()) {
    throw new Error(
      'An impairment needs a reason (§18). It is a judgement about an asset\'s worth, and a ' +
        'judgement with no stated basis cannot be reviewed.',
    );
  }

  const before = await carryingValueOf(tx, id);
  assertImpairable(asset.assetCode, before, input.amountIqd);

  const [category] = await tx
    .select()
    .from(assetCategory)
    .where(eq(assetCategory.code, asset.categoryCode))
    .limit(1);

  const criteria = { branchCode: asset.branchCode };

  const result = await posting.post(tx, ctx, {
    eventType: 'assets.impairment',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'assets', documentId: id, event: `impairment-${input.impairedOn}` },
    branchCode: asset.branchCode,
    documentDate: input.impairedOn,
    postingDate: input.impairedOn,
    description: `Impairment ${asset.assetCode} — ${input.reason.trim()}`,
    lines: [
      {
        role: category!.impairmentRole,
        debit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions: {
          branch: asset.branchCode,
          department: asset.departmentCode,
        },
      },
      {
        role: 'accumulated_impairment',
        credit: toDecimalString(input.amountIqd, 4n),
        criteria,
        dimensions: { branch: asset.branchCode },
      },
    ],
  });

  await tx.insert(assetImpairment).values({
    assetId: id,
    impairedOn: input.impairedOn,
    amountIqd: toDecimalString(input.amountIqd, 4n),
    carryingValueBeforeIqd: toDecimalString(before.netBookValueIqd, 4n),
    reason: input.reason.trim(),
    journalEntryId: result.journalEntryId,
    approvedBy: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.impaired',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: asset.branchCode,
    before: { netBookValueIqd: toDecimalString(before.netBookValueIqd, 4n) },
    after: {
      amountIqd: toDecimalString(input.amountIqd, 4n),
      netBookValueIqd: toDecimalString(before.netBookValueIqd - input.amountIqd, 4n),
    },
    reason: input.reason.trim(),
    outcome: 'success',
  });

  return {
    journalEntryId: result.journalEntryId,
    carryingValueAfterIqd: before.netBookValueIqd - input.amountIqd,
  };
}

// ---------------------------------------------------------------------------
// 12.6 — disposal
// ---------------------------------------------------------------------------

/**
 * §18.6 — disposal, clearing the asset to nothing.
 *
 * Cost, accumulated depreciation and accumulated impairment all come off in one
 * entry, and what is left over against the proceeds is the gain or the loss.
 * Clearing all three is the point: an asset that left the company but whose
 * accumulated depreciation stayed would leave the register disagreeing with the
 * G/L for ever.
 */
export async function dispose(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { disposedOn: string; proceedsIqd: bigint; proceedsAccountId: string; reason?: string },
): Promise<{ journalEntryId: string; gainOrLossIqd: bigint; isGain: boolean }> {
  const asset = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: asset.branchCode,
  });

  if (asset.status === 'disposed' || asset.status === 'closed') {
    throw new AssetNotDisposableError(asset.assetCode, asset.status);
  }

  const value = await carryingValueOf(tx, id);
  const outcome = disposalOutcome(value, input.proceedsIqd);

  const [category] = await tx
    .select()
    .from(assetCategory)
    .where(eq(assetCategory.code, asset.categoryCode))
    .limit(1);

  const criteria = { branchCode: asset.branchCode };
  const dimensions = {
    branch: asset.branchCode,
    department: asset.departmentCode,
  };

  const lines: PostingLineRequest[] = [];

  if (input.proceedsIqd > 0n) {
    lines.push({
      role: 'disposal_proceeds',
      accountId: input.proceedsAccountId,
      debit: toDecimalString(input.proceedsIqd, 4n),
      criteria,
      dimensions: { branch: asset.branchCode },
    });
  }
  if (value.accumulatedDepreciationIqd > 0n) {
    lines.push({
      role: category!.accumulatedDepreciationRole,
      debit: toDecimalString(value.accumulatedDepreciationIqd, 4n),
      criteria,
      dimensions: { branch: asset.branchCode },
    });
  }
  if (value.accumulatedImpairmentIqd > 0n) {
    lines.push({
      role: 'accumulated_impairment',
      debit: toDecimalString(value.accumulatedImpairmentIqd, 4n),
      criteria,
      dimensions: { branch: asset.branchCode },
    });
  }
  if (!outcome.isGain && outcome.gainOrLossIqd !== 0n) {
    lines.push({
      role: category!.disposalLossRole,
      debit: toDecimalString(-outcome.gainOrLossIqd, 4n),
      criteria,
      dimensions,
    });
  }

  lines.push({
    role: category!.costAccountRole,
    credit: asset.acquisitionCostIqd,
    criteria,
    dimensions: { branch: asset.branchCode },
  });

  if (outcome.isGain && outcome.gainOrLossIqd !== 0n) {
    lines.push({
      role: category!.disposalGainRole,
      credit: toDecimalString(outcome.gainOrLossIqd, 4n),
      criteria,
      dimensions,
    });
  }

  const result = await posting.post(tx, ctx, {
    eventType: 'assets.disposal',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'assets', documentId: id, event: 'disposed' },
    branchCode: asset.branchCode,
    documentDate: input.disposedOn,
    postingDate: input.disposedOn,
    description: `Disposal ${asset.assetCode} — ${input.reason ?? 'disposed'}`,
    lines,
  });

  await tx
    .update(fixedAsset)
    .set({
      status: 'disposed',
      disposedOn: input.disposedOn,
      disposalProceedsIqd: toDecimalString(input.proceedsIqd, 4n),
      updatedAt: new Date(),
    })
    .where(eq(fixedAsset.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.disposed',
    objectType: DOCUMENT_TYPE,
    objectId: id,
    branchCode: asset.branchCode,
    before: {
      status: asset.status,
      netBookValueIqd: toDecimalString(value.netBookValueIqd, 4n),
    },
    after: {
      status: 'disposed',
      proceedsIqd: toDecimalString(input.proceedsIqd, 4n),
      gainOrLossIqd: toDecimalString(outcome.gainOrLossIqd, 4n),
      journalEntryId: result.journalEntryId,
    },
    reason: input.reason ?? null,
    outcome: 'success',
  });

  return {
    journalEntryId: result.journalEntryId,
    gainOrLossIqd: outcome.gainOrLossIqd,
    isGain: outcome.isGain,
  };
}

// ---------------------------------------------------------------------------
// 12.7 — physical verification
// ---------------------------------------------------------------------------

export async function verify(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    verifiedOn: string;
    found: 'present' | 'missing' | 'moved';
    foundLocation?: string | null;
    foundCustodianUserId?: string | null;
    note?: string | null;
  },
): Promise<{ id: string; hasVariance: boolean }> {
  const asset = await load(tx, id);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: asset.branchCode,
  });

  const hasVariance =
    input.found !== 'present' ||
    (input.foundLocation != null && input.foundLocation !== asset.location) ||
    (input.foundCustodianUserId != null && input.foundCustodianUserId !== asset.custodianUserId);

  const [created] = await tx
    .insert(assetVerification)
    .values({
      assetId: id,
      verifiedOn: input.verifiedOn,
      found: input.found,
      foundLocation: input.foundLocation ?? null,
      foundCustodianUserId: input.foundCustodianUserId ?? null,
      note: input.note ?? null,
      verifiedBy: ctx.principal.userId,
    })
    .returning({ id: assetVerification.id });

  return { id: created!.id, hasVariance };
}

/**
 * §18.7 — a variance is approved before the register is touched.
 *
 * The approval and the register change are one act, so there is no window in
 * which somebody has agreed the variance and the register still disagrees.
 */
export async function approveVariance(
  tx: Tx,
  ctx: ActorContext,
  verificationId: string,
): Promise<void> {
  const [row] = await tx
    .select()
    .from(assetVerification)
    .where(eq(assetVerification.id, verificationId))
    .limit(1);

  if (!row) throw new Error(`No verification with id '${verificationId}'.`);
  const asset = await load(tx, row.assetId);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: asset.branchCode,
  });

  if (row.verifiedBy === ctx.principal.userId) {
    throw new Error(
      'You recorded this verification, so somebody else approves the variance (§5.2, §18.7).',
    );
  }

  await tx
    .update(assetVerification)
    .set({ varianceApprovedBy: ctx.principal.userId, varianceApprovedAt: new Date() })
    .where(eq(assetVerification.id, verificationId));

  await tx
    .update(fixedAsset)
    .set({
      location: row.foundLocation ?? asset.location,
      custodianUserId: row.foundCustodianUserId ?? asset.custodianUserId,
      updatedAt: new Date(),
    })
    .where(eq(fixedAsset.id, row.assetId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'fixed_asset.variance_approved',
    objectType: DOCUMENT_TYPE,
    objectId: row.assetId,
    branchCode: asset.branchCode,
    before: { location: asset.location, custodian: asset.custodianUserId },
    after: {
      found: row.found,
      location: row.foundLocation ?? asset.location,
      custodian: row.foundCustodianUserId ?? asset.custodianUserId,
    },
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 12.8 — reports
// ---------------------------------------------------------------------------

export interface RegisterRow {
  readonly assetCode: string;
  readonly description: string;
  readonly categoryCode: string;
  readonly branchCode: string;
  readonly departmentCode: string | null;
  readonly costCentreCode: string | null;
  readonly status: string;
  readonly availableForUseOn: string;
  readonly acquisitionCostIqd: string;
  readonly accumulatedDepreciationIqd: string;
  readonly accumulatedImpairmentIqd: string;
  readonly netBookValueIqd: string;
}

/**
 * §18.8 — the asset register, with net book value per asset.
 *
 * Accumulated depreciation and accumulated impairment are separate columns
 * because §18.5 asks the register to reconcile to the G/L, and they are separate
 * G/L accounts. A single "accumulated" figure could be agreed to neither.
 */
export async function register(
  tx: Tx,
  ctx: ActorContext,
  filter: {
    branchCode?: string | null;
    categoryCode?: string | null;
    custodianUserId?: string | null;
    includeDisposed?: boolean;
  } = {},
): Promise<RegisterRow[]> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: filter.branchCode ?? ctx.branchCode,
  });

  const result = (await tx.execute(sql`
    select a.asset_code                                             as "assetCode",
           a.description                                            as "description",
           a.category_code                                          as "categoryCode",
           a.branch_code                                            as "branchCode",
           a.department_code                                        as "departmentCode",
           a.cost_centre_code                                       as "costCentreCode",
           a.status::text                                           as "status",
           a.available_for_use_on::text                             as "availableForUseOn",
           a.acquisition_cost_iqd::text                             as "acquisitionCostIqd",
           coalesce((select sum(d.charge_iqd) from asset_depreciation d
                      where d.asset_id = a.id), 0)::text            as "accumulatedDepreciationIqd",
           coalesce((select sum(i.amount_iqd) from asset_impairment i
                      where i.asset_id = a.id), 0)::text            as "accumulatedImpairmentIqd",
           (a.acquisition_cost_iqd
             - coalesce((select sum(d.charge_iqd) from asset_depreciation d
                          where d.asset_id = a.id), 0)
             - coalesce((select sum(i.amount_iqd) from asset_impairment i
                          where i.asset_id = a.id), 0))::text       as "netBookValueIqd"
      from fixed_asset a
     where (${filter.branchCode ?? null}::text is null or a.branch_code = ${filter.branchCode ?? null})
       and (${filter.categoryCode ?? null}::text is null or a.category_code = ${filter.categoryCode ?? null})
       and (${filter.custodianUserId ?? null}::uuid is null or a.custodian_user_id = ${filter.custodianUserId ?? null})
       and (${filter.includeDisposed ?? false} or a.status not in ('disposed', 'closed'))
     order by a.asset_code
  `)) as unknown as { rows: RegisterRow[] };

  return result.rows;
}

export async function view(tx: Tx, id: string) {
  const asset = await load(tx, id);
  const [depreciation, impairments, transfers, verifications] = await Promise.all([
    tx
      .select()
      .from(assetDepreciation)
      .where(eq(assetDepreciation.assetId, id))
      .orderBy(assetDepreciation.periodEnd),
    tx
      .select()
      .from(assetImpairment)
      .where(eq(assetImpairment.assetId, id))
      .orderBy(assetImpairment.impairedOn),
    tx
      .select()
      .from(assetTransfer)
      .where(eq(assetTransfer.assetId, id))
      .orderBy(assetTransfer.transferredOn),
    tx
      .select()
      .from(assetVerification)
      .where(eq(assetVerification.assetId, id))
      .orderBy(desc(assetVerification.verifiedOn)),
  ]);

  return {
    asset,
    depreciation,
    impairments,
    transfers,
    verifications,
    carryingValue: await carryingValueOf(tx, id),
  };
}

// ---------------------------------------------------------------------------
// The 01.10 queue — §18 runs depreciation as a scheduled background job
// ---------------------------------------------------------------------------

export const DEPRECIATION_QUEUE = 'assets.depreciation';

/**
 * Asks for a depreciation run rather than performing one.
 *
 * Enqueued inside the caller's transaction, like every other 01.10 event, so a
 * period that fails to close does not leave a run owed. The idempotency key is
 * the period and branch: the queue is at-least-once, and a second delivery must
 * not charge twice. It would not anyway — `asset_depreciation` is unique on
 * (asset, period end) — but the key means the second delivery is *recognised*
 * rather than merely absorbed.
 */
export async function scheduleDepreciationRun(
  tx: Tx,
  ctx: ActorContext,
  input: { periodStart: string; periodEnd: string; branchCode?: string | null },
): Promise<{ outboxId: bigint }> {
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: input.branchCode ?? ctx.branchCode,
  });

  return jobs.enqueue(tx, ctx.principal.userId, {
    queueName: DEPRECIATION_QUEUE,
    payload: {
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      branchCode: input.branchCode ?? null,
      requestedBy: ctx.principal.userId,
    },
    idempotencyKey: `depreciation:${input.branchCode ?? 'all'}:${input.periodEnd}`,
    branchCode: input.branchCode ?? ctx.branchCode,
  });
}

/**
 * Registers the run handler on the 01.10 queue.
 *
 * The caller supplies the transaction, and with it the scope: a worker posts as
 * the person who asked for the run, not as itself, so §5 authorisation and the
 * D10 branch boundary still apply to work nobody is watching.
 */
export function registerDepreciationHandler(
  runWith: (userId: string, fn: (tx: Tx, ctx: ActorContext) => Promise<void>) => Promise<void>,
): void {
  jobs.registerHandler(DEPRECIATION_QUEUE, async (payload) => {
    const requestedBy = String(payload.requestedBy);
    await runWith(requestedBy, async (tx, ctx) => {
      await runDepreciation(tx, ctx, {
        periodStart: String(payload.periodStart),
        periodEnd: String(payload.periodEnd),
        branchCode: (payload.branchCode as string | null) ?? null,
      });
    });
  });
}
