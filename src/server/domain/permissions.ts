/**
 * Permissions — the authorisation model, Phase 01.2.
 *
 * Blueprint §5.3 fixes the verb list. Blueprint §25 fixes the default:
 *
 *   "Use deny-by-default, server-side authorisation for every page, API and
 *    record. Navigation hiding alone is not access control."
 *
 * This module is the single decision point. It is pure — no database, no
 * request, no CASL — so the same function answers for a screen, an API route
 * and a background job, which is what §23 requires:
 *
 *   "Every create/update API must enforce the same permissions and business
 *    validations as the user interface."
 *
 * The service layer above adapts this to CASL for ergonomics; it must never
 * re-implement the decision. Row scope (branch/department) is enforced a second
 * time in the database by RLS — see TECHSTACK.md A3. Two layers, deliberately:
 * this one can be reasoned about, the database one cannot be forgotten.
 */

/**
 * The thirteen permission verbs, verbatim from §5.3.
 *
 * The list is closed. A new verb is a change request under §28.1, not a
 * convenience added mid-module — every role definition in the system is
 * expressed against these.
 */
export const PERMISSION_VERBS = [
  'view',
  'create',
  'edit_draft',
  'submit',
  'approve',
  'execute',
  'post',
  'reverse_cancel',
  'print',
  'export',
  'import',
  'configure',
  'administer',
] as const;

export type PermissionVerb = (typeof PERMISSION_VERBS)[number];

export function isPermissionVerb(value: string): value is PermissionVerb {
  return (PERMISSION_VERBS as readonly string[]).includes(value);
}

/**
 * One grant: a verb on an object.
 *
 * `object` is the permission-controlled thing — a document type, a screen, a
 * configuration area ('journal_entry', 'chart_of_account', 'user'). There are
 * deliberately **no wildcards**. A wildcard makes "which users can post?"
 * unanswerable without evaluating patterns, and §5.1 requires access granted
 * "by screen and action". Super User is the only blanket grant, per §5.1.
 */
export interface Grant {
  readonly object: string;
  readonly verb: PermissionVerb;
}

/** A department the user is assigned to, and whether they manage it (§5.2). */
export interface DepartmentAssignment {
  readonly code: string;
  readonly isManager: boolean;
}

/**
 * The resolved identity a decision is made against.
 *
 * §5.3: "Department access and approval authority are separate settings." They
 * are separate fields here for the same reason — being assigned to a department
 * confers no approval right, and holding `approve` confers no department.
 */
export interface Principal {
  readonly userId: string;
  /** §5.1 — "Super Users retain full administration access." */
  readonly isSuperUser: boolean;
  readonly isActive: boolean;
  /**
   * The role codes held. Grants are what authorisation decides on; these are
   * what an approval *step* names (§01.7), which is a different question —
   * "may you do this?" versus "are you the person this step is waiting for?".
   */
  readonly roleCodes: readonly string[];
  readonly grants: readonly Grant[];
  /** Branches whose records this user may see. Empty means none, not all. */
  readonly branchCodes: readonly string[];
  /**
   * The branch a session starts in, and which a new document defaults to.
   *
   * Null when the user has no branch at all — which is a user who can see
   * nothing, not a user who can see everything.
   */
  readonly defaultBranchCode?: string | null;
  readonly departments: readonly DepartmentAssignment[];
}

export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED';

  constructor(
    readonly principalId: string,
    readonly verb: PermissionVerb,
    readonly object: string,
  ) {
    // §25: "Validation messages identify the field, reason and corrective
    // action; no generic 'something went wrong' for business errors." The
    // message names what was refused; it does not leak what else exists.
    super(`Permission denied: '${verb}' on '${object}' is not granted to this user.`);
    this.name = 'PermissionDeniedError';
  }
}

export class ScopeDeniedError extends Error {
  readonly code = 'SCOPE_DENIED';

  constructor(
    readonly principalId: string,
    readonly branchCode: string,
  ) {
    super(`Out of scope: this user has no access to branch '${branchCode}'.`);
    this.name = 'ScopeDeniedError';
  }
}

/**
 * The decision. Absence of a grant is denial — there is no implicit allow
 * anywhere in this function, which is the 01.2 test gate.
 *
 * An inactive user is denied everything, including Super User. Deactivation has
 * to be immediate and total or it is not a control (§25, immediate revocation).
 */
export function can(principal: Principal, verb: PermissionVerb, object: string): boolean {
  if (!principal.isActive) return false;
  if (principal.isSuperUser) return true;
  return principal.grants.some((g) => g.verb === verb && g.object === object);
}

/** `can`, as an assertion. Use at the entry of every command. */
export function assertCan(
  principal: Principal,
  verb: PermissionVerb,
  object: string,
): void {
  if (!can(principal, verb, object)) {
    throw new PermissionDeniedError(principal.userId, verb, object);
  }
}

/**
 * Data scope — §5.1, §22.
 *
 * Enforced here so a service can fail fast with a business error, and again in
 * the database by RLS so that a query which forgets cannot leak a row. The
 * database is the control; this is the message.
 */
export function canAccessBranch(principal: Principal, branchCode: string): boolean {
  if (!principal.isActive) return false;
  if (principal.isSuperUser) return true;
  return principal.branchCodes.includes(branchCode);
}

export function assertBranchInScope(principal: Principal, branchCode: string): void {
  if (!canAccessBranch(principal, branchCode)) {
    throw new ScopeDeniedError(principal.userId, branchCode);
  }
}

/**
 * §5.2 — the Department Manager toggle is **per assigned department**. A user
 * may manage one department and be an ordinary user in another, so this is
 * always asked about a specific department, never about the user.
 *
 * Super User is not a Department Manager by implication: §5.1 grants
 * administration access, and §5.2 routing is an approval authority. §5.3 keeps
 * those separate, so conflating them here would breach it.
 */
export function isDepartmentManager(principal: Principal, departmentCode: string): boolean {
  if (!principal.isActive) return false;
  return principal.departments.some((d) => d.code === departmentCode && d.isManager);
}

export function isInDepartment(principal: Principal, departmentCode: string): boolean {
  if (!principal.isActive) return false;
  return principal.departments.some((d) => d.code === departmentCode);
}
