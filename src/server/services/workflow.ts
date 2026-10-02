/**
 * Approval workflow repository — Phase 01.7.
 *
 * One engine for every document type. An Accounting Officer submits, the
 * Accounting Manager approves, and the decision — whichever way it went — is
 * kept forever.
 *
 * The instance pins the definition version it started under, so changing the
 * route later cannot rewrite what happened under the old one (01.7 gate).
 */
import { and, asc, desc, eq } from "drizzle-orm";
import {
  advance,
  assertCanApprove,
  assertCanRecall,
  assertDecisionReason,
  stepAt,
  validateDefinition,
  type WorkflowActor,
  type WorkflowDecision,
  type WorkflowDefinition,
  type WorkflowInstance,
} from "../domain/workflow";
import {
  documentTypeControlledField,
  workflowDecisionLog,
  workflowDefinition,
  workflowInstance,
  workflowStep,
} from "../db/schema";
import {
  assertControlledFieldsUnchanged,
  type FieldValues,
} from "../domain/controlled-fields";
import type { DocumentStatus } from "../domain/statuses";
import type { Tx } from "../db/client";
import type { ActorContext } from "./chart-of-accounts";

export class NoWorkflowDefinedError extends Error {
  readonly code = "NO_WORKFLOW_DEFINED";
  constructor(documentTypeCode: string) {
    super(
      `No active approval route is configured for '${documentTypeCode}'. ` +
        "Configure one before submitting, rather than letting the document finalise unapproved.",
    );
    this.name = "NoWorkflowDefinedError";
  }
}

export class WorkflowInstanceNotFoundError extends Error {
  readonly code = "WORKFLOW_INSTANCE_NOT_FOUND";
  constructor(documentTypeCode: string, documentId: string) {
    super(`No approval in progress for ${documentTypeCode} ${documentId}.`);
    this.name = "WorkflowInstanceNotFoundError";
  }
}

interface LoadedDefinition {
  readonly id: string;
  readonly definition: WorkflowDefinition;
}

/** The active route for a document type, with its steps in order. */
export async function activeDefinitionFor(
  tx: Tx,
  documentTypeCode: string,
): Promise<LoadedDefinition> {
  const [row] = await tx
    .select()
    .from(workflowDefinition)
    .where(
      and(
        eq(workflowDefinition.documentTypeCode, documentTypeCode),
        eq(workflowDefinition.isActive, true),
      ),
    )
    .limit(1);

  if (!row) throw new NoWorkflowDefinedError(documentTypeCode);

  const steps = await tx
    .select()
    .from(workflowStep)
    .where(eq(workflowStep.definitionId, row.id))
    .orderBy(asc(workflowStep.sequence));

  const definition: WorkflowDefinition = {
    documentType: row.documentTypeCode,
    version: row.version,
    steps: steps.map((s) => ({
      sequence: s.sequence,
      approverKind: s.approverKind,
      approverRole: s.approverRole,
      allowSelfApproval: s.allowSelfApproval,
    })),
  };

  validateDefinition(definition);
  return { id: row.id, definition };
}

/** The definition an in-flight instance is pinned to — not necessarily the active one. */
async function pinnedDefinitionFor(
  tx: Tx,
  definitionId: string,
): Promise<WorkflowDefinition> {
  const [row] = await tx
    .select()
    .from(workflowDefinition)
    .where(eq(workflowDefinition.id, definitionId))
    .limit(1);

  if (!row) {
    throw new WorkflowInstanceNotFoundError("unknown", definitionId);
  }

  const steps = await tx
    .select()
    .from(workflowStep)
    .where(eq(workflowStep.definitionId, definitionId))
    .orderBy(asc(workflowStep.sequence));

  return {
    documentType: row.documentTypeCode,
    version: row.version,
    steps: steps.map((s) => ({
      sequence: s.sequence,
      approverKind: s.approverKind,
      approverRole: s.approverRole,
      allowSelfApproval: s.allowSelfApproval,
    })),
  };
}

function toInstance(
  row: typeof workflowInstance.$inferSelect,
): WorkflowInstance {
  return {
    documentType: row.documentTypeCode,
    documentId: row.documentId,
    definitionVersion: 0, // filled by the caller when the definition is loaded
    currentStep: row.currentStep,
    submittedBy: row.submittedBy,
    isComplete: row.isComplete,
  };
}

export interface SubmitInput {
  readonly documentTypeCode: string;
  readonly documentId: string;
  readonly branchCode?: string | null;
}

/**
 * Starts an approval route.
 *
 * A resubmission after rejection creates a **new revision** rather than
 * reopening the old instance, so the earlier decisions stay exactly as they
 * were taken.
 */
/**
 * HD6 — the submitter is the caller, read from the context the owning
 * service already authorised, never from the input.
 */
export async function submit(
  tx: Tx,
  ctx: ActorContext,
  input: SubmitInput,
): Promise<{ instanceId: string; revision: number }> {
  const { id: definitionId } = await activeDefinitionFor(
    tx,
    input.documentTypeCode,
  );

  const previous = await tx
    .select({ revision: workflowInstance.revision })
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.documentTypeCode, input.documentTypeCode),
        eq(workflowInstance.documentId, input.documentId),
      ),
    )
    .orderBy(desc(workflowInstance.revision))
    .limit(1);

  const revision = (previous[0]?.revision ?? 0) + 1;

  const [created] = await tx
    .insert(workflowInstance)
    .values({
      documentTypeCode: input.documentTypeCode,
      documentId: input.documentId,
      definitionId,
      revision,
      currentStep: 1,
      isComplete: false,
      submittedBy: ctx.principal.userId,
      branchCode: input.branchCode ?? null,
    })
    .returning({ id: workflowInstance.id });

  return { instanceId: created!.id, revision };
}

/** The instance currently awaiting a decision, if there is one. */
export async function pendingInstanceFor(
  tx: Tx,
  documentTypeCode: string,
  documentId: string,
): Promise<typeof workflowInstance.$inferSelect> {
  const [row] = await tx
    .select()
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.documentTypeCode, documentTypeCode),
        eq(workflowInstance.documentId, documentId),
        eq(workflowInstance.isComplete, false),
      ),
    )
    .orderBy(desc(workflowInstance.revision))
    .limit(1);

  if (!row)
    throw new WorkflowInstanceNotFoundError(documentTypeCode, documentId);
  return row;
}

export interface DecideInput {
  readonly documentTypeCode: string;
  readonly documentId: string;
  readonly actor: WorkflowActor;
  /**
   * 'delegated' is an approval taken under someone else's authority: it moves
   * the route on exactly as an approval does, and is recorded under its own
   * name so the history shows that it was not the named approver who acted.
   * Recording it as an approval would lose that, and refusing it outright would
   * mean approvals stop whenever an approver is on leave.
   */
  readonly decision: Extract<WorkflowDecision, "approved" | "rejected" | "delegated">;
  readonly reason?: string | null;
  /** Required for 'delegated' — whose authority is being exercised (§5.4). */
  readonly onBehalfOf?: string | null;
}

export interface DecisionOutcome {
  readonly instanceId: string;
  readonly isComplete: boolean;
  readonly nextStep: number | null;
  readonly decision: WorkflowDecision;
}

/**
 * Records a decision and moves the route on.
 *
 * Approval advances to the next step, or completes the route if there is none.
 * Rejection ends the instance — the document returns to draft and a corrected
 * version is submitted as a new revision (01.7 gate).
 */
export async function decide(
  tx: Tx,
  input: DecideInput,
): Promise<DecisionOutcome> {
  const row = await pendingInstanceFor(
    tx,
    input.documentTypeCode,
    input.documentId,
  );
  const definition = await pinnedDefinitionFor(tx, row.definitionId);
  const instance = {
    ...toInstance(row),
    definitionVersion: definition.version,
  };

  const step = stepAt(definition, row.currentStep!);

  assertCanApprove(step, input.actor, instance);
  assertDecisionReason(input.decision, input.reason);

  await tx.insert(workflowDecisionLog).values({
    instanceId: row.id,
    stepSequence: row.currentStep!,
    actorUserId: input.actor.userId,
    decision: input.decision,
    reason: input.reason ?? null,
    onBehalfOf: input.onBehalfOf ?? null,
  });

  if (input.decision === "rejected") {
    await tx
      .update(workflowInstance)
      .set({ currentStep: null, isComplete: true, completedAt: new Date() })
      .where(eq(workflowInstance.id, row.id));

    return {
      instanceId: row.id,
      isComplete: true,
      nextStep: null,
      decision: "rejected",
    };
  }

  const outcome = advance(definition, instance);

  await tx
    .update(workflowInstance)
    .set({
      currentStep: outcome.nextStep,
      isComplete: outcome.isComplete,
      completedAt: outcome.isComplete ? new Date() : null,
    })
    .where(eq(workflowInstance.id, row.id));

  return {
    instanceId: row.id,
    isComplete: outcome.isComplete,
    nextStep: outcome.nextStep,
    decision: input.decision,
  };
}

/** The raiser withdraws a submission that has not yet been decided. */
export async function recall(
  tx: Tx,
  documentTypeCode: string,
  documentId: string,
  actor: WorkflowActor,
  reason?: string | null,
): Promise<void> {
  const row = await pendingInstanceFor(tx, documentTypeCode, documentId);
  const definition = await pinnedDefinitionFor(tx, row.definitionId);
  const instance = {
    ...toInstance(row),
    definitionVersion: definition.version,
  };

  assertCanRecall(instance, actor);

  await tx.insert(workflowDecisionLog).values({
    instanceId: row.id,
    stepSequence: row.currentStep!,
    actorUserId: actor.userId,
    decision: "recalled",
    reason: reason ?? null,
  });

  await tx
    .update(workflowInstance)
    .set({ currentStep: null, isComplete: true, completedAt: new Date() })
    .where(eq(workflowInstance.id, row.id));
}

/**
 * Every decision ever taken on this document, oldest first, across every
 * revision. This is the "complete decision history" of Appendix B.
 */
export async function historyFor(
  tx: Tx,
  documentTypeCode: string,
  documentId: string,
): Promise<
  Array<{
    revision: number;
    stepSequence: number;
    actorUserId: string;
    decision: WorkflowDecision;
    reason: string | null;
    onBehalfOf: string | null;
    decidedAt: Date;
  }>
> {
  const rows = await tx
    .select({
      revision: workflowInstance.revision,
      stepSequence: workflowDecisionLog.stepSequence,
      actorUserId: workflowDecisionLog.actorUserId,
      decision: workflowDecisionLog.decision,
      reason: workflowDecisionLog.reason,
      onBehalfOf: workflowDecisionLog.onBehalfOf,
      decidedAt: workflowDecisionLog.decidedAt,
    })
    .from(workflowDecisionLog)
    .innerJoin(
      workflowInstance,
      eq(workflowInstance.id, workflowDecisionLog.instanceId),
    )
    .where(
      and(
        eq(workflowInstance.documentTypeCode, documentTypeCode),
        eq(workflowInstance.documentId, documentId),
      ),
    )
    .orderBy(asc(workflowDecisionLog.decidedAt), asc(workflowDecisionLog.id));

  return rows;
}

/** Documents waiting on this actor — the approval inbox (§21). */
export async function pendingFor(
  tx: Tx,
  documentTypeCode: string,
): Promise<
  Array<{ documentId: string; currentStep: number; submittedBy: string }>
> {
  const rows = await tx
    .select({
      documentId: workflowInstance.documentId,
      currentStep: workflowInstance.currentStep,
      submittedBy: workflowInstance.submittedBy,
    })
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.documentTypeCode, documentTypeCode),
        eq(workflowInstance.isComplete, false),
      ),
    )
    .orderBy(asc(workflowInstance.submittedAt));

  return rows.filter(
    (
      r,
    ): r is { documentId: string; currentStep: number; submittedBy: string } =>
      r.currentStep !== null,
  );
}

// ---------------------------------------------------------------------------
// Controlled fields (§24, 01.7 gate)
// ---------------------------------------------------------------------------

/**
 * The fields a submission freezes for this document type.
 *
 * Loaded rather than hardcoded: which fields carry the approval is the Business
 * Process Owner's decision (§28.1), and the Administration screen edits it.
 * A type with no rows controls nothing — which is a real answer for a note, and
 * a visible one, because the row set is inspectable.
 */
export async function controlledFieldsFor(
  tx: Tx,
  documentTypeCode: string,
): Promise<readonly string[]> {
  const rows = await tx
    .select({ fieldName: documentTypeControlledField.fieldName })
    .from(documentTypeControlledField)
    .where(eq(documentTypeControlledField.documentTypeCode, documentTypeCode))
    .orderBy(asc(documentTypeControlledField.fieldName));

  return rows.map((r) => r.fieldName);
}

/**
 * Refuses a change to a field the approval rests on.
 *
 * Called by the service that owns the document, before it writes. It is not a
 * database trigger because the check needs to know which fields the *caller*
 * intends to change — a trigger sees only that a row differs, and a row can
 * differ because a status column moved.
 */
export async function assertControlledFieldsEditable(
  tx: Tx,
  documentTypeCode: string,
  status: DocumentStatus,
  before: FieldValues,
  after: FieldValues,
): Promise<void> {
  const controlled = await controlledFieldsFor(tx, documentTypeCode);
  assertControlledFieldsUnchanged(documentTypeCode, status, controlled, before, after);
}
