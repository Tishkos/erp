/**
 * Approval workflow — Phase 01.7.
 *
 * The maker-checker rule, once, for every document type:
 *
 *   §5.2  a Department Manager creating a document in their own department
 *         finalises it directly; anyone else submits it to that department's
 *         manager.
 *   §14.4 a Finance user creates and submits to the Finance Manager; a Finance
 *         Manager creates and posts directly.
 *
 * Those are the same rule stated twice, and this module is that rule. An
 * Accounting Officer raising a new account submits it; the Accounting Manager
 * approves it. A manager raising it themselves needs no second signature —
 * approving your own work is only a control failure when someone else could
 * have done it.
 *
 * Appendix B, Workflow Instance: "No self-approval where prohibited; complete
 * decision history."
 */

/** What an actor did at a step. Every one of these is kept — §01.7 gate. */
export const WORKFLOW_DECISIONS = ['approved', 'rejected', 'recalled', 'delegated'] as const;
export type WorkflowDecision = (typeof WORKFLOW_DECISIONS)[number];

/**
 * Who a step waits for.
 *
 * The blueprint has two mechanisms and they are not the same: §14.4 routes a
 * journal to Finance **by role**, and §5.2 routes an operational document to
 * whoever manages the department it belongs to. Collapsing them would mean
 * inventing a role per department, which is how department structures end up
 * duplicated in the permission model.
 */
export const APPROVER_KINDS = ['role', 'department_manager'] as const;
export type ApproverKind = (typeof APPROVER_KINDS)[number];

/** One step of an approval route. */
export interface WorkflowStep {
  readonly sequence: number;
  readonly approverKind: ApproverKind;
  /** The role that may act at this step, when the step waits for a role. */
  readonly approverRole: string;
  /**
   * §5.2's direct-finalisation case. False for anything with a segregation-of-
   * duties requirement — a payment must never be approvable by its raiser, even
   * when the raiser is the manager.
   */
  readonly allowSelfApproval: boolean;
}

/**
 * A definition is versioned and instances pin the version they started under.
 *
 * 01.7 gate: "Changing a workflow definition does not alter the recorded
 * history of in-flight or completed instances." An approval that happened under
 * two-step approval must not read as one-step because someone simplified the
 * route afterwards.
 */
export interface WorkflowDefinition {
  readonly documentType: string;
  readonly version: number;
  readonly steps: readonly WorkflowStep[];
}

export interface WorkflowActor {
  readonly userId: string;
  readonly roles: readonly string[];
  /** §5.2 — manager of the document's department, not of the actor's own. */
  readonly isDepartmentManager: boolean;
}

export interface WorkflowInstance {
  readonly documentType: string;
  readonly documentId: string;
  readonly definitionVersion: number;
  /** 1-based. Null once the route is complete or the document was rejected. */
  readonly currentStep: number | null;
  readonly submittedBy: string;
  readonly isComplete: boolean;
}

export class WorkflowDefinitionError extends Error {
  readonly code = 'WORKFLOW_DEFINITION_INVALID';
  constructor(detail: string) {
    super(`Workflow definition is not usable: ${detail}`);
    this.name = 'WorkflowDefinitionError';
  }
}

export class SelfApprovalError extends Error {
  readonly code = 'SELF_APPROVAL_PROHIBITED';
  constructor(readonly userId: string) {
    super(
      'You cannot approve a document you raised. This step requires a different approver (Appendix B).',
    );
    this.name = 'SelfApprovalError';
  }
}

export class NotAnApproverError extends Error {
  readonly code = 'NOT_AN_APPROVER';
  constructor(
    readonly userId: string,
    readonly requiredRole: string,
  ) {
    super(`This step is approved by '${requiredRole}'. You do not hold that role.`);
    this.name = 'NotAnApproverError';
  }
}

export class WorkflowStateError extends Error {
  readonly code = 'WORKFLOW_STATE_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'WorkflowStateError';
  }
}

export class DecisionReasonRequiredError extends Error {
  readonly code = 'DECISION_REASON_REQUIRED';
  constructor(readonly decision: WorkflowDecision) {
    super(`A '${decision}' decision requires a reason, and the reason is kept with it (§5.4).`);
    this.name = 'DecisionReasonRequiredError';
  }
}

export function validateDefinition(definition: WorkflowDefinition): void {
  if (definition.steps.length === 0) {
    throw new WorkflowDefinitionError(
      `${definition.documentType} has no steps. A route with no approver is not an approval — remove the definition instead, so the document finalises on save by design rather than by omission.`,
    );
  }

  const sequences = definition.steps.map((s) => s.sequence);
  const expected = Array.from({ length: definition.steps.length }, (_, i) => i + 1);

  if (JSON.stringify([...sequences].sort((a, b) => a - b)) !== JSON.stringify(expected)) {
    throw new WorkflowDefinitionError(
      `${definition.documentType} steps must be numbered 1..${definition.steps.length} with no gaps; received ${sequences.join(', ')}`,
    );
  }

  for (const step of definition.steps) {
    if (step.approverKind === 'role' && !step.approverRole.trim()) {
      throw new WorkflowDefinitionError(`step ${step.sequence} names no approver role`);
    }
  }
}

export function stepAt(definition: WorkflowDefinition, sequence: number): WorkflowStep {
  const step = definition.steps.find((s) => s.sequence === sequence);
  if (!step) {
    throw new WorkflowStateError(
      `${definition.documentType} version ${definition.version} has no step ${sequence}`,
    );
  }
  return step;
}

/**
 * §5.2 — may this actor finalise directly instead of submitting?
 *
 * True only when they manage the department the document belongs to. A user who
 * manages Finance and sells in Sales submits their Sales document and finalises
 * their Finance one; the toggle is read per department, never per user.
 */
export function finalisesDirectly(actor: WorkflowActor): boolean {
  return actor.isDepartmentManager;
}

/** Whether this actor may act at this step, and why not if they may not. */
export function assertCanApprove(
  step: WorkflowStep,
  actor: WorkflowActor,
  instance: WorkflowInstance,
): void {
  if (instance.isComplete) {
    throw new WorkflowStateError(
      `This ${instance.documentType} has already completed its approval route.`,
    );
  }

  if (instance.currentStep === null) {
    throw new WorkflowStateError(
      `This ${instance.documentType} is not awaiting approval. It may have been rejected or recalled.`,
    );
  }

  if (step.approverKind === 'department_manager') {
    // §5.2 — authority here comes from managing the document's department, not
    // from a role. `isDepartmentManager` is resolved against the department on
    // the instance, so a manager of Finance approving a Sales document arrives
    // here with false.
    if (!actor.isDepartmentManager) {
      throw new NotAnApproverError(actor.userId, 'department manager');
    }
  } else if (!actor.roles.includes(step.approverRole)) {
    throw new NotAnApproverError(actor.userId, step.approverRole);
  }

  if (!step.allowSelfApproval && actor.userId === instance.submittedBy) {
    throw new SelfApprovalError(actor.userId);
  }
}

export function assertDecisionReason(decision: WorkflowDecision, reason?: string | null): void {
  // A rejection without a reason gives the raiser nothing to correct, and a
  // delegation without one hides why authority moved.
  if ((decision === 'rejected' || decision === 'delegated') && !reason?.trim()) {
    throw new DecisionReasonRequiredError(decision);
  }
}

/** Only the raiser may recall, and only while it is still awaiting a decision. */
export function assertCanRecall(instance: WorkflowInstance, actor: WorkflowActor): void {
  if (instance.isComplete || instance.currentStep === null) {
    throw new WorkflowStateError(
      'This document is no longer awaiting approval and cannot be recalled.',
    );
  }
  if (instance.submittedBy !== actor.userId) {
    throw new WorkflowStateError('Only the person who submitted a document may recall it.');
  }
}

export interface ApprovalOutcome {
  /** Null when the route is finished. */
  readonly nextStep: number | null;
  readonly isComplete: boolean;
}

/** Advances the route by one step. */
export function advance(
  definition: WorkflowDefinition,
  instance: WorkflowInstance,
): ApprovalOutcome {
  if (instance.currentStep === null) {
    throw new WorkflowStateError('This document is not awaiting approval.');
  }

  const next = instance.currentStep + 1;
  const hasNext = definition.steps.some((s) => s.sequence === next);

  return hasNext ? { nextStep: next, isComplete: false } : { nextStep: null, isComplete: true };
}
