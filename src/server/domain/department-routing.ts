/**
 * Department Manager routing — Phase 01.3.
 *
 * §5.2, in five bullets that reduce to one rule and one consequence:
 *
 *   a Department Manager creating a document **in that department** finalises
 *   it directly; anyone else submits it to that department's manager. And
 *   "Manager approval shall automatically execute the operational, inventory
 *   and accounting effects assigned to the document type."
 *
 * ── The word doing the work is "that" ───────────────────────────────────────
 * The manager who may finalise directly is the manager of the **document's**
 * department, not of the author's usual one. A user who manages Finance and
 * sells in Sales finalises their Finance document and submits their Sales one,
 * and the 01.3 gate tests exactly that person. So every routing decision takes
 * the document's department as an argument; there is no default to fall back
 * on, because a default is how the wrong manager ends up approving.
 */

export interface DepartmentAssignment {
  readonly code: string;
  readonly isManager: boolean;
}

export interface RoutingActor {
  readonly userId: string;
  readonly departments: readonly DepartmentAssignment[];
}

export class DepartmentRoutingError extends Error {
  readonly code = 'DEPARTMENT_ROUTING';
  constructor(detail: string) {
    super(detail);
    this.name = 'DepartmentRoutingError';
  }
}

export class NoDepartmentManagerError extends Error {
  readonly code = 'NO_DEPARTMENT_MANAGER';
  constructor(readonly departmentCode: string) {
    super(
      `No Department Manager is assigned to ${departmentCode}, so this document has nobody to go to. ` +
        'Assign one before raising documents in that department (§5.2).',
    );
    this.name = 'NoDepartmentManagerError';
  }
}

/** Is this person the manager of that department — not of any department? */
export function isManagerOf(actor: RoutingActor, departmentCode: string): boolean {
  return actor.departments.some((d) => d.code === departmentCode && d.isManager);
}

export function isMemberOf(actor: RoutingActor, departmentCode: string): boolean {
  return actor.departments.some((d) => d.code === departmentCode);
}

export type RoutingOutcome = 'finalise_directly' | 'submit_to_department_manager';

export interface RoutingDecision {
  readonly outcome: RoutingOutcome;
  readonly departmentCode: string;
  /** Why, in words a user can be shown. */
  readonly reason: string;
}

/**
 * §5.2's decision, for one document in one department.
 *
 * Membership of the department is not required to *raise* a document — §5.2
 * does not say it is, and a shared-services model where Finance raises on
 * behalf of Sales is ordinary. What is required is that the approval goes to
 * the right department's manager, which is the whole of the rule.
 */
export function routeFor(actor: RoutingActor, departmentCode: string): RoutingDecision {
  if (!departmentCode.trim()) {
    throw new DepartmentRoutingError(
      'A document must name the department it belongs to before it can be routed (§5.2).',
    );
  }

  if (isManagerOf(actor, departmentCode)) {
    return {
      outcome: 'finalise_directly',
      departmentCode,
      reason: `You manage ${departmentCode}, so this finalises on save (§5.2).`,
    };
  }

  return {
    outcome: 'submit_to_department_manager',
    departmentCode,
    reason: `This goes to the Department Manager of ${departmentCode} for approval (§5.2).`,
  };
}

/**
 * Picks the approver from the department's managers.
 *
 * Refuses when there is none, rather than falling back to anyone else. A
 * document routed to "whoever is available" is a document approved by someone
 * with no authority over it, and the failure is silent until an auditor asks.
 */
export function assignApprover(
  departmentCode: string,
  managerUserIds: readonly string[],
  raisedBy: string,
): string {
  if (managerUserIds.length === 0) {
    throw new NoDepartmentManagerError(departmentCode);
  }

  // Prefer a manager who is not the author. §5.2 lets a manager finalise their
  // own document directly — that path never reaches here — so an author
  // arriving here is a non-manager, or a manager of a *different* department.
  const others = managerUserIds.filter((id) => id !== raisedBy);
  return (others[0] ?? managerUserIds[0])!;
}

/**
 * §5.2 — "Manager approval shall automatically execute the operational,
 * inventory and accounting effects assigned to the document type."
 *
 * The effects are *assigned to the document type*, not written into the
 * approval code, so approving a purchase order and approving a journal run
 * different effects through one path. And they run in the approving
 * transaction: §24 requires the posting to be atomic with the approval that
 * caused it, so an approval that succeeded while its effects failed is a state
 * this cannot produce.
 */
export interface ExecutionEffect {
  readonly documentTypeCode: string;
  readonly description: string;
}

export class ExecutionEffectMissingError extends Error {
  readonly code = 'EXECUTION_EFFECT_MISSING';
  constructor(readonly documentTypeCode: string) {
    super(
      `'${documentTypeCode}' has no execution effect registered, so approving it would do nothing. ` +
        'Register one, or register an explicit no-op if approval genuinely has no effect (§5.2).',
    );
    this.name = 'ExecutionEffectMissingError';
  }
}
