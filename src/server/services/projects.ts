/**
 * Projects and contracting — Phase 11, §10 and §19.
 *
 * > §10: *"Create a project from an approved CRM opportunity or an approved
 * > management instruction."*
 * > §10 acceptance criterion 2: *"Budget availability updates immediately after
 * > commitments and actual postings."*
 * > §10 acceptance criterion 5: *"Project closeout blocks unresolved financial
 * > and operational items."*
 *
 * **Availability is computed, never stored.** §10 requires it to update
 * *immediately* after a commitment or a posting; the cheapest way to be certain
 * of that is to have nothing to update — the figure is a sum over commitments
 * and costs each time it is asked for.
 *
 * **Revenue recognition is absent on purpose.** §10 requires Finance to approve
 * the policy before WIP and progress billing are developed and forbids IT from
 * inventing it. D1 is open, so `recognitionMethod` is a column nothing reads.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  opportunity,
  project,
  projectBalanceMovement,
  projectBudgetLine,
  projectCertificate,
  projectCommitment,
  projectCost,
  projectProgress,
  projectVariation,
  projectWbs,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertCloseable,
  assertNoWbsCycle,
  assertWithinBudget,
  assertWithinMeasuredProgress,
  budgetPosition,
  closeoutFindings,
  progressBill,
  revisedPosition,
  type BudgetPosition,
  type CloseoutState,
} from '../domain/projects';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as statuses from './statuses';
import * as inventory from './inventory';
import { allocateDocumentNumber } from './numbering';

export const DOCUMENT_TYPE = 'project';
export const PERMISSION_OBJECT = 'project';

export {
  CLOSEOUT_BLOCKERS,
  budgetPosition,
  closeoutFindings,
  progressBill,
  revisedPosition,
} from '../domain/projects';

export class ProjectStateError extends Error {
  readonly code = 'PROJECT_STATE_INVALID';
  constructor(projectCode: string, status: string, detail: string) {
    super(`Project ${projectCode} is '${status}': ${detail}`);
    this.name = 'ProjectStateError';
  }
}

async function load(tx: Tx, projectCode: string) {
  const [row] = await tx.select().from(project).where(eq(project.code, projectCode)).limit(1);
  if (!row) throw new Error(`No project '${projectCode}'.`);
  return row;
}

// ---------------------------------------------------------------------------
// 11.1 — the project and its WBS
// ---------------------------------------------------------------------------

export interface CreateProjectInput {
  readonly projectCode: string;
  readonly name: string;
  readonly customerId: string;
  readonly branchCode: string;
  readonly managerUserId: string;
  readonly contractValueIqd: bigint;
  readonly baselineBudgetIqd: bigint;
  readonly baselineStartsOn?: string | null;
  readonly baselineEndsOn?: string | null;
  readonly billingMethod?: 'milestone' | 'progress' | 'time_and_material' | 'lump_sum';
  readonly retentionPercent?: bigint;
  readonly advanceRecoveryPercent?: bigint;
  readonly departmentCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly costCentreCode?: string | null;
  readonly requiresCostCode?: boolean;
  /** §10 — where it came from, when it came from CRM. */
  readonly opportunityId?: string | null;
}

/**
 * §10 — a project, from an approved opportunity or from a management
 * instruction.
 *
 * When it comes from an opportunity, the customer comes with it and is not
 * accepted from the caller: §6's first acceptance criterion applies to the
 * project conversion exactly as it does to the order one, and the way to keep it
 * true is to leave the caller no way to state a different customer.
 */
export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateProjectInput,
): Promise<{ projectCode: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  let customerId = input.customerId;

  if (input.opportunityId) {
    const [source] = await tx
      .select()
      .from(opportunity)
      .where(eq(opportunity.id, input.opportunityId))
      .limit(1);

    if (!source) throw new Error(`No opportunity with id '${input.opportunityId}'.`);
    if (source.stage !== 'won') {
      throw new Error(
        `Opportunity ${source.opportunityNo} is '${source.stage}'. §10 creates a project from an ` +
          '*approved* opportunity; marking it won is the decision, and the project is the consequence.',
      );
    }
    // §6 criterion 1 — the customer travels with the conversion.
    customerId = source.partnerId;
  }

  const [partner] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, customerId))
    .limit(1);

  if (!partner) throw new Error(`No business partner with id '${customerId}'.`);
  if (!partner.isCustomer) {
    throw new Error(`${partner.code} is not a customer, so no work can be contracted to them (§6).`);
  }

  const [created] = await tx
    .insert(project)
    .values({
      code: input.projectCode,
      name: input.name.trim(),
      partnerId: customerId,
      opportunityId: input.opportunityId ?? null,
      branchCode: input.branchCode,
      departmentCode: input.departmentCode ?? null,
      businessLineCode: input.businessLineCode ?? null,
      costCentreCode: input.costCentreCode ?? null,
      managerUserId: input.managerUserId,
      contractValueIqd: toDecimalString(input.contractValueIqd, 4n),
      baselineBudgetIqd: toDecimalString(input.baselineBudgetIqd, 4n),
      baselineStartsOn: input.baselineStartsOn ?? null,
      baselineEndsOn: input.baselineEndsOn ?? null,
      billingMethod: input.billingMethod ?? 'progress',
      retentionPercent: toDecimalString(input.retentionPercent ?? 0n, 4n),
      advanceRecoveryPercent: toDecimalString(input.advanceRecoveryPercent ?? 0n, 4n),
      requiresCostCode: input.requiresCostCode ?? true,
      createdBy: ctx.principal.userId,
    })
    .returning({ code: project.code });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.created',
    objectType: DOCUMENT_TYPE,
    objectId: created!.code,
    branchCode: input.branchCode,
    after: {
      projectCode: input.projectCode,
      customer: partner.code,
      opportunityId: input.opportunityId ?? null,
      contractValueIqd: toDecimalString(input.contractValueIqd, 4n),
      baselineBudgetIqd: toDecimalString(input.baselineBudgetIqd, 4n),
    },
    outcome: 'success',
  });

  return { projectCode: created!.code };
}

/** §10 — *"approve contract, budget, WBS and baseline dates."* */
export async function approve(tx: Tx, ctx: ActorContext, projectCode: string): Promise<void> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  if (row.status !== 'draft') {
    throw new ProjectStateError(row.code, row.status, 'it is not a draft.');
  }
  if (row.createdBy === ctx.principal.userId) {
    throw new Error(
      `${row.code} was raised by you, so somebody else approves the contract and its ` +
        'baseline (§5.2). The baseline is what every variation is measured against.',
    );
  }

  await tx
    .update(project)
    .set({
      status: 'active',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(project.code, projectCode));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.approved',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    before: { status: row.status },
    after: {
      status: 'active',
      contractValueIqd: row.contractValueIqd,
      baselineBudgetIqd: row.baselineBudgetIqd,
      baselineEndsOn: row.baselineEndsOn,
    },
    outcome: 'success',
  });
}

/** §10 — a WBS element. The tree is kept a tree. */
export async function addWbs(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    code: string;
    name: string;
    parentCode?: string | null;
    responsibleUserId?: string | null;
    plannedStartsOn?: string | null;
    plannedEndsOn?: string | null;
    isMilestone?: boolean;
  },
): Promise<{ id: string }> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  const existing = await tx
    .select({ code: projectWbs.code, parentCode: projectWbs.parentCode })
    .from(projectWbs)
    .where(eq(projectWbs.projectCode, projectCode));

  assertNoWbsCycle(
    input.code,
    input.parentCode ?? null,
    new Map(existing.map((e) => [e.code, e.parentCode])),
  );

  if (input.parentCode && !existing.some((e) => e.code === input.parentCode)) {
    throw new Error(
      `There is no WBS element '${input.parentCode}' on ${row.code} to hang this under.`,
    );
  }

  const [created] = await tx
    .insert(projectWbs)
    .values({
      projectCode,
      code: input.code,
      name: input.name,
      parentCode: input.parentCode ?? null,
      responsibleUserId: input.responsibleUserId ?? null,
      plannedStartsOn: input.plannedStartsOn ?? null,
      plannedEndsOn: input.plannedEndsOn ?? null,
      isMilestone: input.isMilestone ? 'true' : 'false',
    })
    .returning({ id: projectWbs.id });

  return { id: created!.id };
}

// ---------------------------------------------------------------------------
// 11.2 and 11.4 — budget, commitments and availability
// ---------------------------------------------------------------------------

export async function addBudgetLine(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    costCode: string;
    description: string;
    baselineIqd: bigint;
    wbsCode?: string | null;
    accountId?: string | null;
    forecastIqd?: bigint;
  },
): Promise<{ id: string }> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  const [created] = await tx
    .insert(projectBudgetLine)
    .values({
      projectCode,
      costCode: input.costCode,
      description: input.description,
      wbsCode: input.wbsCode ?? null,
      accountId: input.accountId ?? null,
      baselineIqd: toDecimalString(input.baselineIqd, 4n),
      forecastIqd: toDecimalString(input.forecastIqd ?? input.baselineIqd, 4n),
    })
    .returning({ id: projectBudgetLine.id });

  return { id: created!.id };
}

/**
 * §10 and §19 — the five amounts for one cost code, computed from the facts.
 *
 * Commitments are the unreleased, unconsumed part of approved orders; actuals
 * are what has been posted. Neither is cached anywhere, so *"availability
 * updates immediately"* is not a promise about a job that runs — there is no
 * job, and no figure that could be stale.
 */
export async function budgetFor(
  tx: Tx,
  projectCode: string,
  costCode: string,
): Promise<BudgetPosition> {
  const [line] = await tx
    .select()
    .from(projectBudgetLine)
    .where(
      and(eq(projectBudgetLine.projectCode, projectCode), eq(projectBudgetLine.costCode, costCode)),
    )
    .limit(1);

  if (!line) {
    throw new Error(
      `There is no budget line '${costCode}' on this project. §10 requires a valid cost code for ` +
        'project spending where the project is configured to need one.',
    );
  }

  const totals = (await tx.execute(sql`
    select
      coalesce((select sum(v.budget_delta_iqd) from project_variation v
                 where v.project_code = ${projectCode} and v.status = 'approved'), 0)::text as "revisions",
      coalesce((select sum(c.amount_iqd - c.consumed_iqd) from project_commitment c
                 where c.project_code = ${projectCode} and c.cost_code = ${costCode}
                   and c.released_on is null), 0)::text                                  as "committed",
      coalesce((select sum(k.amount_iqd) from project_cost k
                 where k.project_code = ${projectCode} and k.cost_code = ${costCode}), 0)::text as "actual"
  `)) as unknown as { rows: { revisions: string; committed: string; actual: string }[] };

  const row = totals.rows[0]!;

  return budgetPosition({
    budgetIqd: parseDecimal(line.baselineIqd, 4n),
    revisionsIqd: parseDecimal(row.revisions, 4n),
    committedIqd: parseDecimal(row.committed, 4n),
    actualIqd: parseDecimal(row.actual, 4n),
    forecastIqd: parseDecimal(line.forecastIqd, 4n),
  });
}

/**
 * §19 — a commitment, created when a project purchase order is approved.
 *
 * It reduces availability the moment it exists, which is the whole point:
 * §10 acceptance criterion 2 asks for availability to move on commitment, not on
 * receipt, so that two buyers cannot each spend the same remaining budget.
 */
export async function commit(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    costCode: string;
    amountIqd: bigint;
    committedOn: string;
    purchaseOrderId?: string | null;
  },
): Promise<{ id: string; availableAfterIqd: bigint }> {
  const row = await assertSpendable(tx, ctx, projectCode, input.costCode, input.amountIqd);

  const [created] = await tx
    .insert(projectCommitment)
    .values({
      projectCode,
      costCode: input.costCode,
      purchaseOrderId: input.purchaseOrderId ?? null,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      committedOn: input.committedOn,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectCommitment.id });

  const after = await budgetFor(tx, projectCode, input.costCode);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.committed',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    after: {
      costCode: input.costCode,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      availableAfterIqd: toDecimalString(after.availableIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, availableAfterIqd: after.availableIqd };
}

/** §19 — *"release when closed/cancelled."* The row stays; the release is dated. */
export async function releaseCommitment(
  tx: Tx,
  ctx: ActorContext,
  commitmentId: string,
  input: { releasedOn: string; reason: string },
): Promise<void> {
  const [row] = await tx
    .select()
    .from(projectCommitment)
    .where(eq(projectCommitment.id, commitmentId))
    .limit(1);

  if (!row) throw new Error(`No commitment with id '${commitmentId}'.`);
  const owner = await load(tx, row.projectCode);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: owner.branchCode ?? ctx.branchCode,
  });

  if (!input.reason.trim()) {
    throw new Error(
      'Releasing a commitment needs a reason (§19). The budget history has to say why the money ' +
        'stopped being promised.',
    );
  }

  await tx
    .update(projectCommitment)
    .set({ releasedOn: input.releasedOn, releaseReason: input.reason.trim() })
    .where(eq(projectCommitment.id, commitmentId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.commitment_released',
    objectType: DOCUMENT_TYPE,
    objectId: row.projectCode,
    branchCode: owner.branchCode ?? ctx.branchCode,
    before: { costCode: row.costCode, amountIqd: row.amountIqd },
    after: { releasedOn: input.releasedOn },
    reason: input.reason.trim(),
    outcome: 'success',
  });
}

/**
 * §10 — an actual cost against the project.
 *
 * The commitment it consumes is named where there is one, so a receipt turns a
 * promise into a cost rather than adding a second charge on top of it — which is
 * the double-count the 11.4 gate names.
 */
export async function recordCost(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    costCode: string;
    kind: string;
    description: string;
    incurredOn: string;
    amountIqd: bigint;
    wbsCode?: string | null;
    journalEntryId?: string | null;
    consumesCommitmentId?: string | null;
  },
): Promise<{ id: string; availableAfterIqd: bigint }> {
  const row = await assertSpendable(
    tx,
    ctx,
    projectCode,
    input.costCode,
    // A cost that consumes a commitment was already counted against
    // availability when the commitment was made.
    input.consumesCommitmentId ? 0n : input.amountIqd,
  );
  // REQ-PM-001 §5 — an element named on a cost must be one that may receive it.
  if (input.wbsCode) await assertAccountAssignmentElement(tx, projectCode, input.wbsCode);

  if (input.consumesCommitmentId) {
    await tx
      .update(projectCommitment)
      .set({
        consumedIqd: sql`least(${projectCommitment.amountIqd},
                               ${projectCommitment.consumedIqd} + ${toDecimalString(input.amountIqd, 4n)})`,
      })
      .where(eq(projectCommitment.id, input.consumesCommitmentId));
  }

  const [created] = await tx
    .insert(projectCost)
    .values({
      projectCode,
      costCode: input.costCode,
      wbsCode: input.wbsCode ?? null,
      kind: input.kind,
      description: input.description,
      incurredOn: input.incurredOn,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      journalEntryId: input.journalEntryId ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectCost.id });

  const after = await budgetFor(tx, projectCode, input.costCode);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.cost_recorded',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    after: {
      costCode: input.costCode,
      kind: input.kind,
      amountIqd: toDecimalString(input.amountIqd, 4n),
      availableAfterIqd: toDecimalString(after.availableIqd, 4n),
    },
    outcome: 'success',
  });

  return { id: created!.id, availableAfterIqd: after.availableIqd };
}

/**
 * §10 — *"no project spending without an active project and valid budget/cost
 * code where required."*
 *
 * Three refusals in one place, because they are three ways of asking the same
 * question and a caller that remembered two of them would be a caller whose
 * spending is *nearly* controlled.
 */
/**
 * REQ-PM-001 §5 — the operative indicator: only an active account-assignment
 * element receives a cost, a commitment or an issue. Kept here, beside the
 * three refusals above, so a caller cannot reach the spending without it.
 */
export class WbsNotAssignableError extends Error {
  readonly code = 'WBS_NOT_ASSIGNABLE';
  constructor(projectCode: string, wbsCode: string, detail: string) {
    super(`${projectCode} / ${wbsCode}: ${detail}`);
    this.name = 'WbsNotAssignableError';
  }
}

export async function assertAccountAssignmentElement(tx: Tx, projectCode: string, wbsCode: string): Promise<void> {
  const [element] = await tx
    .select({ isAccountAssignment: projectWbs.isAccountAssignment, active: projectWbs.active })
    .from(projectWbs)
    .where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, wbsCode)))
    .limit(1);
  if (!element) throw new WbsNotAssignableError(projectCode, wbsCode, 'there is no such element');
  if (!element.active) throw new WbsNotAssignableError(projectCode, wbsCode, 'the element is deactivated');
  if (!element.isAccountAssignment) {
    throw new WbsNotAssignableError(projectCode, wbsCode, 'the element is not an account-assignment element — nothing posts to it (REQ-PM-001 §5)');
  }
}

async function assertSpendable(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  costCode: string,
  amountIqd: bigint,
) {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  if (row.status !== 'active') {
    throw new ProjectStateError(
      row.code,
      row.status,
      'nothing can be spent against a project that is not active (§10).',
    );
  }

  if (row.requiresCostCode || amountIqd > 0n) {
    const position = await budgetFor(tx, projectCode, costCode);
    if (amountIqd > 0n) assertWithinBudget(costCode, position, amountIqd);
  }

  return row;
}

// ---------------------------------------------------------------------------
// 11.3 — project stock
// ---------------------------------------------------------------------------

/**
 * §10 — stock issued to a project.
 *
 * **One transaction, two effects.** The warehouse loses the stock and the
 * project gains the cost, and the cost is the FIFO cost the issue actually
 * consumed — not a standard, not an average, and not a figure the caller
 * supplies. §9.2 decides what the stock was worth; this records that decision
 * against the project.
 *
 * The issue also passes the budget check, because §10 puts project spending
 * under the same rule whether the money leaves through a supplier or through the
 * store.
 */
export async function issueToProject(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    itemCode: string;
    warehouseCode: string;
    quantity: bigint;
    movementDate: string;
    costCode: string;
    wbsCode?: string | null;
    serialNumber?: string | null;
    batchNumber?: string | null;
  },
): Promise<{ movementId: string; costIqd: bigint; availableAfterIqd: bigint }> {
  const row = await load(tx, projectCode);

  if (row.status !== 'active') {
    throw new ProjectStateError(
      row.code,
      row.status,
      'nothing can be issued to a project that is not active (§10).',
    );
  }
  // REQ-PM-001 §5 — refused before the stock moves, not after.
  if (input.wbsCode) await assertAccountAssignmentElement(tx, projectCode, input.wbsCode);

  const movement = await inventory.issue(tx, ctx, {
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    quantity: input.quantity,
    movementDate: input.movementDate,
    kind: 'project_issue',
    sourceDocumentType: 'project',
    sourceDocumentId: projectCode,
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
  });

  const costIqd = movement.costIqd ?? 0n;

  const recorded = await recordCost(tx, ctx, projectCode, {
    costCode: input.costCode,
    kind: 'material_issue',
    description: `${input.itemCode} issued from ${input.warehouseCode}`,
    incurredOn: input.movementDate,
    amountIqd: costIqd,
    wbsCode: input.wbsCode ?? null,
  });

  return {
    movementId: movement.movementId,
    costIqd,
    availableAfterIqd: recorded.availableAfterIqd,
  };
}

/**
 * §10 — stock coming back from a project.
 *
 * The reverse of the issue, and **at the cost it went out at**: §9.2's FIFO
 * layers describe what the company paid, and returning stock at today's cost
 * would create a profit or a loss out of a movement that was neither. The
 * project's actual cost falls by the same figure it rose by.
 */
export async function returnFromProject(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    itemCode: string;
    warehouseCode: string;
    quantity: bigint;
    movementDate: string;
    costCode: string;
    unitCostIqd: bigint;
    wbsCode?: string | null;
    serialNumber?: string | null;
    batchNumber?: string | null;
  },
): Promise<{ movementId: string; creditedIqd: bigint }> {
  const row = await load(tx, projectCode);

  if (row.status !== 'active') {
    throw new ProjectStateError(
      row.code,
      row.status,
      'stock cannot be returned to a project that is not active (§10).',
    );
  }

  const movement = await inventory.receive(tx, ctx, {
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    quantity: input.quantity,
    unitCostIqd: input.unitCostIqd,
    movementDate: input.movementDate,
    kind: 'project_return',
    sourceDocumentType: 'project',
    sourceDocumentId: projectCode,
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
  });

  const creditedIqd = (input.quantity * input.unitCostIqd) / 1_000_000n;

  // A negative cost row rather than a deletion: §10 asks for material issued
  // *and returned* to be reported, and a deleted issue reports neither.
  await tx.insert(projectCost).values({
    projectCode,
    costCode: input.costCode,
    wbsCode: input.wbsCode ?? null,
    kind: 'material_return',
    description: `${input.itemCode} returned to ${input.warehouseCode}`,
    incurredOn: input.movementDate,
    amountIqd: toDecimalString(-creditedIqd, 4n),
    createdBy: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.material_returned',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    after: {
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      creditedIqd: toDecimalString(creditedIqd, 4n),
    },
    outcome: 'success',
  });

  return { movementId: movement.movementId, creditedIqd };
}

/** §10 — what has gone out to the project and what has come back. */
export async function materialMovements(tx: Tx, ctx: ActorContext, projectCode: string) {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  return tx
    .select()
    .from(projectCost)
    .where(
      and(
        eq(projectCost.projectCode, projectCode),
        sql`${projectCost.kind} in ('material_issue', 'material_return')`,
      ),
    )
    .orderBy(projectCost.incurredOn);
}

// ---------------------------------------------------------------------------
// 11.7 and 11.8 — progress, certificates and billing
// ---------------------------------------------------------------------------

export async function measureProgress(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: { wbsCode: string; measuredOn: string; percentComplete: bigint; note?: string | null },
): Promise<{ id: string }> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  const [created] = await tx
    .insert(projectProgress)
    .values({
      projectCode,
      wbsCode: input.wbsCode,
      measuredOn: input.measuredOn,
      percentComplete: toDecimalString(input.percentComplete, 4n),
      measuredBy: ctx.principal.userId,
      note: input.note ?? null,
    })
    .returning({ id: projectProgress.id });

  return { id: created!.id };
}

/** §5.2 — measured by one person, approved by another. */
export async function approveProgress(
  tx: Tx,
  ctx: ActorContext,
  progressId: string,
): Promise<void> {
  const [row] = await tx
    .select()
    .from(projectProgress)
    .where(eq(projectProgress.id, progressId))
    .limit(1);

  if (!row) throw new Error(`No progress measurement with id '${progressId}'.`);
  const owner = await load(tx, row.projectCode);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: owner.branchCode ?? ctx.branchCode,
  });

  if (row.measuredBy === ctx.principal.userId) {
    throw new Error(
      'You measured this progress, so somebody else approves it (§5.2). A measurement one person ' +
        'takes and signs is a number with nobody behind it.',
    );
  }

  await tx
    .update(projectProgress)
    .set({ approvedBy: ctx.principal.userId, approvedAt: new Date() })
    .where(eq(projectProgress.id, progressId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.progress_approved',
    objectType: DOCUMENT_TYPE,
    objectId: row.projectCode,
    branchCode: owner.branchCode ?? ctx.branchCode,
    after: {
      wbsCode: row.wbsCode,
      measuredOn: row.measuredOn,
      percentComplete: row.percentComplete,
    },
    outcome: 'success',
  });
}

/** The approved measured progress for the project as a whole, at a date. */
export async function approvedProgressPercent(
  tx: Tx,
  projectCode: string,
  asOf: string,
): Promise<bigint> {
  const result = (await tx.execute(sql`
    select coalesce(avg(latest.percent_complete), 0)::numeric(9,4)::text as "percent"
      from (
        select distinct on (p.wbs_code) p.percent_complete
          from project_progress p
         where p.project_code = ${projectCode}
           and p.approved_at is not null
           and p.measured_on <= ${asOf}::date
         order by p.wbs_code, p.measured_on desc
      ) latest
  `)) as unknown as { rows: { percent: string }[] };

  return parseDecimal(result.rows[0]?.percent ?? '0', 4n);
}

/**
 * §10 — the client certificate, with retention withheld and the advance
 * recovered.
 *
 * The three figures are computed from the project's terms and the advance still
 * outstanding, and stored: the terms can change between certificates, and each
 * one was issued under the terms of its day.
 */
export async function certify(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: { certifiedOn: string; percentComplete: bigint; grossIqd: bigint },
): Promise<{ id: string; certificateNo: string; retentionIqd: bigint; netIqd: bigint }> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  if (row.status !== 'active') {
    throw new ProjectStateError(
      row.code,
      row.status,
      'certificates are raised against an active project.',
    );
  }

  // §10 — never beyond what somebody measured and somebody else approved.
  const measured = await approvedProgressPercent(tx, projectCode, input.certifiedOn);
  assertWithinMeasuredProgress(measured, input.percentComplete);

  const advanceOutstanding = await balanceOf(tx, projectCode, 'advance');

  const bill = progressBill(
    input.grossIqd,
    {
      retentionPercent: parseDecimal(row.retentionPercent, 4n),
      advanceRecoveryPercent: parseDecimal(row.advanceRecoveryPercent, 4n),
    },
    advanceOutstanding,
  );

  const allocated = await allocateDocumentNumber(
    tx,
    'PROJECT_CERTIFICATE',
    { branchCode: row.branchCode ?? ctx.branchCode, year: Number(input.certifiedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(projectCertificate)
    .values({
      certificateNo: allocated.documentNo,
      projectCode,
      branchCode: row.branchCode ?? ctx.branchCode,
      certifiedOn: input.certifiedOn,
      percentComplete: toDecimalString(input.percentComplete, 4n),
      grossIqd: toDecimalString(bill.grossIqd, 4n),
      retentionIqd: toDecimalString(bill.retentionIqd, 4n),
      advanceRecoveredIqd: toDecimalString(bill.advanceRecoveredIqd, 4n),
      netIqd: toDecimalString(bill.netIqd, 4n),
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectCertificate.id });

  // §10 — retention and the advance recovery move their own balances. Neither
  // is revenue, and neither is netted into the invoice.
  if (bill.retentionIqd > 0n) {
    await tx.insert(projectBalanceMovement).values({
      projectCode,
      kind: 'retention',
      amountIqd: toDecimalString(bill.retentionIqd, 4n),
      movedOn: input.certifiedOn,
      description: `Withheld on certificate ${allocated.documentNo}`,
      certificateId: created!.id,
      createdBy: ctx.principal.userId,
    });
  }
  if (bill.advanceRecoveredIqd > 0n) {
    await tx.insert(projectBalanceMovement).values({
      projectCode,
      kind: 'advance',
      amountIqd: toDecimalString(-bill.advanceRecoveredIqd, 4n),
      movedOn: input.certifiedOn,
      description: `Recovered on certificate ${allocated.documentNo}`,
      certificateId: created!.id,
      createdBy: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.certified',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    after: {
      certificateNo: allocated.documentNo,
      percentComplete: toDecimalString(input.percentComplete, 4n),
      grossIqd: toDecimalString(bill.grossIqd, 4n),
      retentionIqd: toDecimalString(bill.retentionIqd, 4n),
      advanceRecoveredIqd: toDecimalString(bill.advanceRecoveredIqd, 4n),
      netIqd: toDecimalString(bill.netIqd, 4n),
    },
    outcome: 'success',
  });

  return {
    id: created!.id,
    certificateNo: allocated.documentNo,
    retentionIqd: bill.retentionIqd,
    netIqd: bill.netIqd,
  };
}

/** §10 — an advance received from the customer, into its own balance. */
export async function receiveAdvance(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: { amountIqd: bigint; receivedOn: string; description: string },
): Promise<void> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  await tx.insert(projectBalanceMovement).values({
    projectCode,
    kind: 'advance',
    amountIqd: toDecimalString(input.amountIqd, 4n),
    movedOn: input.receivedOn,
    description: input.description,
    createdBy: ctx.principal.userId,
  });
}

/** §10 — retention released, which is the only way it leaves that balance. */
export async function releaseRetention(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: { amountIqd: bigint; releasedOn: string; description: string },
): Promise<void> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  const held = await balanceOf(tx, projectCode, 'retention');
  if (input.amountIqd > held) {
    throw new Error(
      `${toDecimalString(held, 4n)} of retention is held on ${row.code} and this releases ` +
        `${toDecimalString(input.amountIqd, 4n)} (§10). Releasing more than was withheld would pay ` +
        'the customer money the company never held back.',
    );
  }

  await tx.insert(projectBalanceMovement).values({
    projectCode,
    kind: 'retention',
    amountIqd: toDecimalString(-input.amountIqd, 4n),
    movedOn: input.releasedOn,
    description: input.description,
    createdBy: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.retention_released',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    after: {
      amountIqd: toDecimalString(input.amountIqd, 4n),
      heldAfterIqd: toDecimalString(held - input.amountIqd, 4n),
    },
    outcome: 'success',
  });
}

/** §10 — the balance of retention held, or of advance outstanding. */
export async function balanceOf(
  tx: Tx,
  projectCode: string,
  kind: 'retention' | 'advance',
): Promise<bigint> {
  const result = (await tx.execute(sql`
    select coalesce(sum(m.amount_iqd), 0)::text as "balance"
      from project_balance_movement m
     where m.project_code = ${projectCode} and m.kind = ${kind}
  `)) as unknown as { rows: { balance: string }[] };

  return parseDecimal(result.rows[0]?.balance ?? '0', 4n);
}

// ---------------------------------------------------------------------------
// 11.9 — variations
// ---------------------------------------------------------------------------

export async function raiseVariation(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  input: {
    variationNo: string;
    raisedOn: string;
    description: string;
    contractDeltaIqd: bigint;
    budgetDeltaIqd: bigint;
    revisedEndsOn?: string | null;
    supersedesId?: string | null;
  },
): Promise<{ id: string; version: number }> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  let version = 1;
  if (input.supersedesId) {
    const [previous] = await tx
      .select()
      .from(projectVariation)
      .where(eq(projectVariation.id, input.supersedesId))
      .limit(1);
    if (!previous) throw new Error(`No variation with id '${input.supersedesId}'.`);
    version = previous.version + 1;
  }

  const [created] = await tx
    .insert(projectVariation)
    .values({
      variationNo: input.variationNo,
      projectCode,
      version,
      supersedesId: input.supersedesId ?? null,
      raisedOn: input.raisedOn,
      description: input.description,
      contractDeltaIqd: toDecimalString(input.contractDeltaIqd, 4n),
      budgetDeltaIqd: toDecimalString(input.budgetDeltaIqd, 4n),
      revisedEndsOn: input.revisedEndsOn ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectVariation.id });

  return { id: created!.id, version };
}

/**
 * §10 — *"change orders … require commercial and budget approval."*
 *
 * Two separate approvals, and the variation only counts once both are in. The
 * table refuses an approved status without both, so the rule survives a code
 * path that forgot.
 */
export async function approveVariation(
  tx: Tx,
  ctx: ActorContext,
  variationId: string,
  which: 'commercial' | 'budget',
): Promise<{ approved: boolean }> {
  const [row] = await tx
    .select()
    .from(projectVariation)
    .where(eq(projectVariation.id, variationId))
    .limit(1);

  if (!row) throw new Error(`No variation with id '${variationId}'.`);
  const owner = await load(tx, row.projectCode);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: owner.branchCode ?? ctx.branchCode,
  });

  const now = new Date();
  const commercialBy = which === 'commercial' ? ctx.principal.userId : row.commercialApprovedBy;
  const budgetBy = which === 'budget' ? ctx.principal.userId : row.budgetApprovedBy;
  const bothIn = commercialBy !== null && budgetBy !== null;

  await tx
    .update(projectVariation)
    .set({
      commercialApprovedBy: commercialBy,
      commercialApprovedAt: which === 'commercial' ? now : row.commercialApprovedAt,
      budgetApprovedBy: budgetBy,
      budgetApprovedAt: which === 'budget' ? now : row.budgetApprovedAt,
      status: bothIn ? 'approved' : row.status,
      updatedAt: now,
    })
    .where(eq(projectVariation.id, variationId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `project.variation_${which}_approved`,
    objectType: DOCUMENT_TYPE,
    objectId: row.projectCode,
    branchCode: owner.branchCode ?? ctx.branchCode,
    after: {
      variationNo: row.variationNo,
      version: row.version,
      fullyApproved: bothIn,
      contractDeltaIqd: row.contractDeltaIqd,
      budgetDeltaIqd: row.budgetDeltaIqd,
    },
    outcome: 'success',
  });

  return { approved: bothIn };
}

/** §10 criterion 3 — the baseline and the revised figures, side by side. */
export async function position(tx: Tx, projectCode: string) {
  const row = await load(tx, projectCode);

  const approved = await tx
    .select({
      contractDeltaIqd: projectVariation.contractDeltaIqd,
      budgetDeltaIqd: projectVariation.budgetDeltaIqd,
      endsOn: projectVariation.revisedEndsOn,
    })
    .from(projectVariation)
    .where(
      and(eq(projectVariation.projectCode, projectCode), eq(projectVariation.status, 'approved')),
    )
    .orderBy(projectVariation.version);

  return revisedPosition(
    {
      contractValueIqd: parseDecimal(row.contractValueIqd, 4n),
      budgetIqd: parseDecimal(row.baselineBudgetIqd, 4n),
      startsOn: row.baselineStartsOn ?? '',
      endsOn: row.baselineEndsOn ?? '',
    },
    approved.map((v) => ({
      contractDeltaIqd: parseDecimal(v.contractDeltaIqd, 4n),
      budgetDeltaIqd: parseDecimal(v.budgetDeltaIqd, 4n),
      endsOn: v.endsOn,
    })),
  );
}

// ---------------------------------------------------------------------------
// 11.11 — closeout
// ---------------------------------------------------------------------------

/** §10 criterion 5 — everything standing between this project and its close. */
export async function closeoutState(tx: Tx, projectCode: string): Promise<CloseoutState> {
  const result = (await tx.execute(sql`
    select
      (select count(*)::int from project_commitment c
        where c.project_code = ${projectCode} and c.released_on is null
          and c.consumed_iqd < c.amount_iqd)                              as "openPurchaseOrders",
      (select count(*)::int from project_cost k
        where k.project_code = ${projectCode} and k.kind = 'material_issue'
          and k.billed = 'false')                                        as "unreturnedStockItems",
      (select coalesce(sum(k.amount_iqd), 0)::text from project_cost k
        where k.project_code = ${projectCode} and k.billed = 'false')         as "unbilledCostIqd",
      (select count(*)::int from project_variation v
        where v.project_code = ${projectCode} and v.status <> 'approved'
          and v.status <> 'cancelled')                                   as "unapprovedVariations"
  `)) as unknown as {
    rows: {
      openPurchaseOrders: number;
      unreturnedStockItems: number;
      unbilledCostIqd: string;
      unapprovedVariations: number;
    }[];
  };

  const row = result.rows[0]!;

  return {
    openPurchaseOrders: row.openPurchaseOrders,
    unreturnedStockItems: row.unreturnedStockItems,
    unbilledCostIqd: parseDecimal(row.unbilledCostIqd, 4n),
    unapprovedVariations: row.unapprovedVariations,
    advanceOutstandingIqd: await balanceOf(tx, projectCode, 'advance'),
    retentionOutstandingIqd: await balanceOf(tx, projectCode, 'retention'),
  };
}

export async function close(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  note: string,
): Promise<void> {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  if (row.status === 'closed') {
    throw new ProjectStateError(row.code, row.status, 'it is already closed.');
  }

  assertCloseable(row.code, await closeoutState(tx, projectCode));

  await tx
    .update(project)
    .set({
      status: 'closed',
      closedBy: ctx.principal.userId,
      closedAt: new Date(),
      closeNote: note,
      updatedAt: new Date(),
    })
    .where(eq(project.code, projectCode));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'project.closed',
    objectType: DOCUMENT_TYPE,
    objectId: projectCode,
    branchCode: row.branchCode ?? ctx.branchCode,
    before: { status: row.status },
    after: { status: 'closed', note },
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 11.12 — reports
// ---------------------------------------------------------------------------

/** §10 — budget vs committed vs actual vs forecast, by cost code. */
export async function budgetReport(tx: Tx, ctx: ActorContext, projectCode: string) {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  const lines = await tx
    .select({ costCode: projectBudgetLine.costCode, description: projectBudgetLine.description })
    .from(projectBudgetLine)
    .where(eq(projectBudgetLine.projectCode, projectCode))
    .orderBy(projectBudgetLine.costCode);

  const rows = [];
  for (const line of lines) {
    const position = await budgetFor(tx, projectCode, line.costCode);
    rows.push({
      costCode: line.costCode,
      description: line.description,
      budgetIqd: toDecimalString(position.budgetIqd, 4n),
      revisionsIqd: toDecimalString(position.revisionsIqd, 4n),
      revisedIqd: toDecimalString(position.revisedIqd, 4n),
      committedIqd: toDecimalString(position.committedIqd, 4n),
      actualIqd: toDecimalString(position.actualIqd, 4n),
      forecastIqd: toDecimalString(position.forecastIqd, 4n),
      availableIqd: toDecimalString(position.availableIqd, 4n),
    });
  }
  return rows;
}

/**
 * §10 acceptance criterion 1 — *"a project shows all related opportunities,
 * contracts, budgets, purchases, stock issues, costs, invoices and receipts."*
 */
export async function projectView(tx: Tx, ctx: ActorContext, projectCode: string) {
  const row = await load(tx, projectCode);

  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: row.branchCode ?? ctx.branchCode,
  });

  // Sequential, not `Promise.all`: a transaction is one connection, and issuing
  // concurrent queries on it is deprecated in `pg` and an error from pg@9. The
  // driver serialises them regardless, so the parallel form buys nothing — the
  // rule `dimensions.ts` writes down, applied here too.
  const wbs = await tx
    .select()
    .from(projectWbs)
    .where(eq(projectWbs.projectCode, projectCode))
    .orderBy(projectWbs.code);
  const budget = await budgetReport(tx, ctx, projectCode);
  const commitments = await tx
    .select()
    .from(projectCommitment)
    .where(eq(projectCommitment.projectCode, projectCode))
    .orderBy(projectCommitment.committedOn);
  const costs = await tx
    .select()
    .from(projectCost)
    .where(eq(projectCost.projectCode, projectCode))
    .orderBy(desc(projectCost.incurredOn));
  const certificates = await tx
    .select()
    .from(projectCertificate)
    .where(eq(projectCertificate.projectCode, projectCode))
    .orderBy(projectCertificate.certifiedOn);
  const variations = await tx
    .select()
    .from(projectVariation)
    .where(eq(projectVariation.projectCode, projectCode))
    .orderBy(projectVariation.version);

  return {
    project: row,
    opportunityId: row.opportunityId,
    wbs,
    budget,
    commitments,
    costs,
    certificates,
    variations,
    position: await position(tx, projectCode),
    retentionHeldIqd: toDecimalString(await balanceOf(tx, projectCode, 'retention'), 4n),
    advanceOutstandingIqd: toDecimalString(await balanceOf(tx, projectCode, 'advance'), 4n),
  };
}

export async function view(tx: Tx, projectCode: string) {
  return load(tx, projectCode);
}
