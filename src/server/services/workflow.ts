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
import { and, asc, desc, eq, sql } from "drizzle-orm";
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
  type WorkflowStep,
} from "../domain/workflow";
import {
  appUser,
  documentTypeControlledField,
  workflowDecisionLog,
  workflowDefinition,
  workflowInstance,
  userRole,
  workflowStep,
} from "../db/schema";
import {
  assertControlledFieldsUnchanged,
  type FieldValues,
} from "../domain/controlled-fields";
import type { DocumentStatus } from "../domain/statuses";
import type { Tx } from "../db/client";
import type { ActorContext } from "./chart-of-accounts";
import * as notifications from "./notifications";

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
  /** §5.2 — the department the document belongs to, and the manager it went to (department routing). */
  readonly departmentCode?: string | null;
  readonly assignedToUserId?: string | null;
  /**
   * False when nobody is left waiting — the submitter is about to approve it
   * themselves in the same act (a journal submitted by someone who may post).
   * Default true: the approvers of step 1 are told (`approval.required`).
   */
  readonly announce?: boolean;
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
  const { id: definitionId, definition } = await activeDefinitionFor(
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
      departmentCode: input.departmentCode ?? null,
      assignedToUserId: input.assignedToUserId ?? null,
    })
    .returning({ id: workflowInstance.id });

  if (input.announce !== false) {
    await notifications.safely(tx, (sp) =>
      announceRequired(sp, ctx.principal.userId, {
        documentTypeCode: input.documentTypeCode,
        documentId: input.documentId,
        branchCode: input.branchCode ?? null,
        revision,
        step: stepAt(definition, 1),
        assignedToUserId: input.assignedToUserId ?? null,
        submittedBy: ctx.principal.userId,
      }),
    );
  }

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

    await notifications.safely(tx, (sp) =>
      announceDecision(sp, row, input.actor.userId, "approval.rejected", input.reason ?? null),
    );

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

  await notifications.safely(tx, async (sp) => {
    if (outcome.isComplete || outcome.nextStep === null) {
      await announceDecision(sp, row, input.actor.userId, "approval.completed", input.reason ?? null);
      return;
    }
    // The route goes on: the first step is done, the next one's approvers are asked.
    await settleAsks(sp, row);
    await announceRequired(sp, input.actor.userId, {
      documentTypeCode: row.documentTypeCode,
      documentId: row.documentId,
      branchCode: row.branchCode,
      revision: row.revision,
      step: stepAt(definition, outcome.nextStep),
      assignedToUserId: row.assignedToUserId,
      submittedBy: row.submittedBy,
    });
  });

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

  // Nobody is asked any more: the approvers' copies are done, not outstanding.
  await notifications.safely(tx, (sp) => settleAsks(sp, row));
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

// ---------------------------------------------------------------------------
// Notification centre — who is told when a route starts, moves on and ends.
// A notification can never change what the document is (§21): every call is
// made through `notifications.safely`, a savepoint that is undone on failure.
// ---------------------------------------------------------------------------

/**
 * A bank account's submission is announced by its own audit event
 * (`partner_bank_account.submitted`, a rule the accounting managers hold), so
 * the engine does not tell the same people twice.
 */
const ANNOUNCED_ELSEWHERE: ReadonlySet<string> = new Set(["partner_bank_account"]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a person calls the document: the journal's number, the account's code, else the id as given. */
async function referenceOf(tx: Tx, documentTypeCode: string, documentId: string): Promise<string> {
  if (!UUID.test(documentId)) return documentId;
  const found =
    documentTypeCode === "journal_entry"
      ? await tx.execute(sql`select entry_no as ref from journal_entry where id = ${documentId}::uuid limit 1`)
      : documentTypeCode === "chart_of_account"
        ? await tx.execute(sql`select code as ref from chart_of_account where id = ${documentId}::uuid limit 1`)
        : null;
  return (found?.rows[0] as { ref: string } | undefined)?.ref ?? documentId;
}

async function nameOf(tx: Tx, userId: string): Promise<string> {
  const [row] = await tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, userId)).limit(1);
  return row?.name ?? "";
}

/**
 * Who a step waits for: the manager it was sent to, else whoever holds the
 * step's role. Never the submitter — they know what they sent, and a company
 * with one accountant is not told about its own submissions (the step may still
 * let them approve it: `allowSelfApproval` decides who may act, not who is asked).
 */
async function approversOf(
  tx: Tx,
  step: WorkflowStep,
  assignedToUserId: string | null,
  submittedBy: string,
): Promise<string[]> {
  const people = assignedToUserId
    ? [assignedToUserId]
    : step.approverKind === "role"
      ? (await tx.select({ userId: userRole.userId }).from(userRole).where(eq(userRole.roleCode, step.approverRole))).map((r) => r.userId)
      : [];
  return people.filter((id) => id !== submittedBy);
}

/** `approval.required` — told once per (revision, step): a refresh or a retry writes nothing more. */
async function announceRequired(
  tx: Tx,
  actorUserId: string,
  at: {
    readonly documentTypeCode: string;
    readonly documentId: string;
    readonly branchCode: string | null;
    readonly revision: number;
    readonly step: WorkflowStep;
    readonly assignedToUserId: string | null;
    readonly submittedBy: string;
  },
): Promise<void> {
  if (ANNOUNCED_ELSEWHERE.has(at.documentTypeCode)) return;
  const recipients = await approversOf(tx, at.step, at.assignedToUserId, at.submittedBy);
  if (recipients.length === 0) return;
  const reference = await referenceOf(tx, at.documentTypeCode, at.documentId);
  const submitter = await nameOf(tx, at.submittedBy);
  await notifications.emit(tx, {
    kind: "approval.required",
    objectType: at.documentTypeCode,
    objectId: at.documentId,
    recipients,
    subject: `Approval required: ${reference}`,
    body: submitter ? `Submitted by ${submitter}.` : "",
    context: {
      reference,
      actor: submitter,
      documentType: at.documentTypeCode,
      step: at.step.sequence,
      revision: at.revision,
    },
    occurrence: `${at.revision}:${at.step.sequence}`,
    branchCode: at.branchCode,
    actorUserId,
  });
}

/** The people who were asked have nothing left to do: their copies are marked acted. */
async function settleAsks(tx: Tx, row: typeof workflowInstance.$inferSelect): Promise<void> {
  await notifications.markActed(tx, row.documentTypeCode, row.documentId);
}

/** `approval.completed` / `approval.rejected` — to the submitter, unless they are the one who decided. */
async function announceDecision(
  tx: Tx,
  row: typeof workflowInstance.$inferSelect,
  actorUserId: string,
  kind: "approval.completed" | "approval.rejected",
  reason: string | null,
): Promise<void> {
  await settleAsks(tx, row);
  if (ANNOUNCED_ELSEWHERE.has(row.documentTypeCode)) return;
  const reference = await referenceOf(tx, row.documentTypeCode, row.documentId);
  const decider = await nameOf(tx, actorUserId);
  await notifications.emit(tx, {
    kind,
    objectType: row.documentTypeCode,
    objectId: row.documentId,
    recipients: [row.submittedBy],
    except: [actorUserId],
    subject: kind === "approval.completed" ? `Approved: ${reference}` : `Rejected: ${reference}`,
    body: reason ?? "",
    context: {
      reference,
      actor: decider,
      documentType: row.documentTypeCode,
      revision: row.revision,
      reason: reason ?? "",
    },
    occurrence: String(row.revision),
    branchCode: row.branchCode,
    actorUserId,
  });
}
