/**
 * Department Manager routing — Phase 01.3.
 *
 * §5.2 decides two things about every document: whether it needs an approval at
 * all, and whose. This module answers both, and runs the document type's
 * execution effects when the approval lands.
 *
 * It sits **in front of** the 01.7 workflow engine rather than inside it. The
 * engine knows about routes and decisions; §5.2 is a rule about departments and
 * people, and folding one into the other would make both harder to read.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  ExecutionEffectMissingError,
  assignApprover,
  isManagerOf,
  routeFor,
  type RoutingActor,
  type RoutingDecision,
} from '../domain/department-routing';
import { department, userDepartmentScope, workflowInstance } from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as workflow from './workflow';

/**
 * §5.2 — "Manager approval shall automatically execute the operational,
 * inventory and accounting effects assigned to the document type."
 *
 * Effects are registered per document type and run inside the approving
 * transaction, so §24's atomicity holds: an approval that succeeded while its
 * posting failed is a state this cannot produce.
 */
export type ExecutionEffect = (
  tx: Tx,
  ctx: ActorContext,
  documentId: string,
) => Promise<void> | void;

const effects = new Map<string, ExecutionEffect>();

export function registerExecutionEffect(
  documentTypeCode: string,
  effect: ExecutionEffect,
): void {
  effects.set(documentTypeCode, effect);
}

export function clearExecutionEffects(): void {
  effects.clear();
}

/** Loads the actor's department assignments — the §5.2 toggle, per department. */
export async function routingActorFor(tx: Tx, userId: string): Promise<RoutingActor> {
  const rows = await tx
    .select({
      code: userDepartmentScope.departmentCode,
      isManager: userDepartmentScope.isManager,
    })
    .from(userDepartmentScope)
    .where(eq(userDepartmentScope.userId, userId));

  return { userId, departments: rows };
}

/** Everyone who manages that department. */
export async function managersOf(tx: Tx, departmentCode: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: userDepartmentScope.userId })
    .from(userDepartmentScope)
    .innerJoin(department, eq(department.code, userDepartmentScope.departmentCode))
    .where(
      and(
        eq(userDepartmentScope.departmentCode, departmentCode),
        eq(userDepartmentScope.isManager, true),
        eq(department.active, true),
      ),
    )
    .orderBy(asc(userDepartmentScope.userId));

  return rows.map((r) => r.userId);
}

/** The §5.2 decision for a document, without acting on it. */
export async function decide(
  tx: Tx,
  ctx: ActorContext,
  departmentCode: string,
): Promise<RoutingDecision> {
  const actor = await routingActorFor(tx, ctx.principal.userId);
  return routeFor(actor, departmentCode);
}

export interface RouteResult {
  readonly outcome: RoutingDecision['outcome'];
  readonly departmentCode: string;
  /** Set only when the document was submitted. */
  readonly assignedToUserId: string | null;
  readonly instanceId: string | null;
  readonly reason: string;
}

/**
 * Applies §5.2: finalise directly, or submit to the department's manager.
 *
 * When it finalises directly the execution effects run **here**, in the
 * caller's transaction — because for a manager's own document, saving and
 * approving are one act (§5.2) and so their effects must be too.
 */
export async function submitOrFinalise(
  tx: Tx,
  ctx: ActorContext,
  input: {
    documentTypeCode: string;
    documentId: string;
    departmentCode: string;
  },
): Promise<RouteResult> {
  const decision = await decide(tx, ctx, input.departmentCode);

  if (decision.outcome === 'finalise_directly') {
    await runEffect(tx, ctx, input.documentTypeCode, input.documentId);

    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'workflow.finalised_directly',
      objectType: input.documentTypeCode,
      objectId: input.documentId,
      branchCode: ctx.branchCode,
      after: { departmentCode: input.departmentCode, route: 'finalise_directly' },
      reason: decision.reason,
      outcome: 'success',
      requestId: ctx.requestId ?? null,
    });

    return {
      outcome: decision.outcome,
      departmentCode: input.departmentCode,
      assignedToUserId: null,
      instanceId: null,
      reason: decision.reason,
    };
  }

  // Resolved from the **document's** department, which is the whole of §5.2.
  const managers = await managersOf(tx, input.departmentCode);
  const assignedToUserId = assignApprover(
    input.departmentCode,
    managers,
    ctx.principal.userId,
  );

  const { instanceId } = await workflow.submit(tx, ctx, {
    documentTypeCode: input.documentTypeCode,
    documentId: input.documentId,
    branchCode: ctx.branchCode,
  });

  await tx
    .update(workflowInstance)
    .set({ departmentCode: input.departmentCode, assignedToUserId })
    .where(eq(workflowInstance.id, instanceId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'workflow.submitted_to_department_manager',
    objectType: input.documentTypeCode,
    objectId: input.documentId,
    branchCode: ctx.branchCode,
    after: {
      departmentCode: input.departmentCode,
      assignedTo: assignedToUserId,
      route: 'submit_to_department_manager',
    },
    reason: decision.reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return {
    outcome: decision.outcome,
    departmentCode: input.departmentCode,
    assignedToUserId,
    instanceId,
    reason: decision.reason,
  };
}

/**
 * Approves a submitted document and runs its effects, in one transaction.
 *
 * The approver must manage the document's department — §5.2 routes to "the
 * assigned Department Manager", and an approval by someone else is not the
 * approval the rule required.
 */
export async function approveAsDepartmentManager(
  tx: Tx,
  ctx: ActorContext,
  input: { documentTypeCode: string; documentId: string },
): Promise<void> {
  const instance = await workflow.pendingInstanceFor(
    tx,
    input.documentTypeCode,
    input.documentId,
  );

  const actor = await routingActorFor(tx, ctx.principal.userId);

  if (instance.departmentCode && !isManagerOf(actor, instance.departmentCode)) {
    throw new Error(
      `This document belongs to ${instance.departmentCode} and is approved by that department's ` +
        'manager. You do not manage it (§5.2).',
    );
  }

  await workflow.decide(tx, {
    documentTypeCode: input.documentTypeCode,
    documentId: input.documentId,
    actor: {
      userId: ctx.principal.userId,
      roles: ctx.principal.roleCodes,
      isDepartmentManager: instance.departmentCode
        ? isManagerOf(actor, instance.departmentCode)
        : false,
    },
    decision: 'approved',
  });

  // §5.2 — approval executes the document type's effects, in this transaction.
  await runEffect(tx, ctx, input.documentTypeCode, input.documentId);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'workflow.approved_by_department_manager',
    objectType: input.documentTypeCode,
    objectId: input.documentId,
    branchCode: ctx.branchCode,
    after: { departmentCode: instance.departmentCode, effectsExecuted: true },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

async function runEffect(
  tx: Tx,
  ctx: ActorContext,
  documentTypeCode: string,
  documentId: string,
): Promise<void> {
  const effect = effects.get(documentTypeCode);

  if (!effect) {
    // Silently doing nothing would make "approval executes the effects" a claim
    // rather than a behaviour. A document type with genuinely no effect
    // registers an explicit no-op, which is a decision someone made.
    throw new ExecutionEffectMissingError(documentTypeCode);
  }

  await effect(tx, ctx, documentId);
}

/** What is waiting for this Department Manager (§5.2). */
export async function inboxFor(tx: Tx, userId: string) {
  return tx
    .select({
      instanceId: workflowInstance.id,
      documentTypeCode: workflowInstance.documentTypeCode,
      documentId: workflowInstance.documentId,
      departmentCode: workflowInstance.departmentCode,
      submittedBy: workflowInstance.submittedBy,
      submittedAt: workflowInstance.submittedAt,
    })
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.assignedToUserId, userId),
        eq(workflowInstance.isComplete, false),
      ),
    )
    .orderBy(asc(workflowInstance.submittedAt));
}

export { isNull };
