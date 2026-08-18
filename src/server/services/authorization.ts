/**
 * Authorisation service — Phase 01.2.
 *
 * Resolves a user into a `Principal`, asks the domain for the decision, and
 * records the refusal when the answer is no.
 *
 * §25 — "Use deny-by-default, server-side authorisation for every page, API and
 * record. Navigation hiding alone is not access control."
 * §23 — "Every create/update API must enforce the same permissions and business
 * validations as the user interface."
 *
 * There is no second implementation of the decision anywhere: screens, route
 * handlers and background jobs all arrive here. The database enforces row scope
 * again through RLS, so a query that forgets to filter still cannot leak a row.
 */
import { eq } from 'drizzle-orm';
import {
  PermissionDeniedError,
  ScopeDeniedError,
  assertBranchInScope,
  assertCan,
  can,
  canAccessBranch,
  type Grant,
  type PermissionVerb,
  type Principal,
} from '../domain/permissions';
import {
  appUser,
  roleGrant,
  userBranchScope,
  userDepartmentScope,
  userRole,
} from '../db/schema';
import type { RequestScope, Tx } from '../db/client';
import * as audit from './audit';

export class UnknownUserError extends Error {
  readonly code = 'UNKNOWN_USER';

  constructor(userId: string) {
    super(`No user record for '${userId}'.`);
    this.name = 'UnknownUserError';
  }
}

/**
 * Loads everything a decision depends on, in one place.
 *
 * A user with no roles resolves to a Principal with no grants — not to an
 * error and not to a null. Deny-by-default has to be representable, or the
 * first caller to hit it will invent a fallback.
 */
export async function loadPrincipal(tx: Tx, userId: string): Promise<Principal> {
  const [user] = await tx.select().from(appUser).where(eq(appUser.id, userId)).limit(1);

  if (!user) throw new UnknownUserError(userId);

  const roleRows = await tx
    .select({ roleCode: userRole.roleCode })
    .from(userRole)
    .where(eq(userRole.userId, userId));

  const grantRows = await tx
    .select({ object: roleGrant.object, verb: roleGrant.verb })
    .from(userRole)
    .innerJoin(roleGrant, eq(roleGrant.roleCode, userRole.roleCode))
    .where(eq(userRole.userId, userId));

  const branchRows = await tx
    .select({ branchCode: userBranchScope.branchCode, isDefault: userBranchScope.isDefault })
    .from(userBranchScope)
    .where(eq(userBranchScope.userId, userId))
    .orderBy(userBranchScope.branchCode);

  const departmentRows = await tx
    .select({
      code: userDepartmentScope.departmentCode,
      isManager: userDepartmentScope.isManager,
    })
    .from(userDepartmentScope)
    .where(eq(userDepartmentScope.userId, userId));

  return {
    userId: user.id,
    isSuperUser: user.isSuperUser,
    isActive: user.isActive,
    roleCodes: roleRows.map((r) => r.roleCode),
    grants: grantRows as Grant[],
    branchCodes: branchRows.map((r) => r.branchCode),
    // Ordered by code above, so the fallback when nobody set a default is at
    // least stable between requests rather than whatever the plan returned.
    defaultBranchCode:
      branchRows.find((r) => r.isDefault)?.branchCode ?? branchRows[0]?.branchCode ?? null,
    departments: departmentRows,
  };
}

/** The scope a request runs under, derived from the principal — never from the client. */
export function scopeFor(principal: Principal, branchCode: string): RequestScope {
  return {
    userId: principal.userId,
    branchCode,
    isSuperUser: principal.isSuperUser,
  };
}

export interface AuthorizationContext {
  readonly branchCode: string;
  readonly objectId?: string | null;
  readonly requestId?: string | null;
  readonly sessionId?: string | null;
  readonly clientIp?: string | null;
}

/**
 * Authorises a verb on an object, and records the refusal if it is one.
 *
 * The refusal is written on its own connection: the caller is about to throw,
 * and an event written into a transaction that rolls back is not a record of
 * anything. See `services/audit.ts`.
 *
 * §25 lists "authorisation failures" among the security events that must be
 * logged — the failed attempt is the one worth keeping.
 */
export async function authorize(
  principal: Principal,
  verb: PermissionVerb,
  object: string,
  context: AuthorizationContext,
): Promise<void> {
  const permitted = can(principal, verb, object);
  const inScope = permitted && canAccessBranch(principal, context.branchCode);

  if (permitted && inScope) return;

  await audit.recordSecurity(scopeFor(principal, context.branchCode), {
    actorUserId: principal.userId,
    action: permitted ? 'authorisation.scope_denied' : 'authorisation.denied',
    objectType: object,
    objectId: context.objectId ?? null,
    branchCode: context.branchCode,
    after: { verb, object, branchCode: context.branchCode },
    outcome: 'denied',
    requestId: context.requestId ?? null,
    sessionId: context.sessionId ?? null,
    clientIp: context.clientIp ?? null,
  });

  if (!permitted) {
    throw new PermissionDeniedError(principal.userId, verb, object);
  }
  throw new ScopeDeniedError(principal.userId, context.branchCode);
}

export { assertCan, assertBranchInScope, PermissionDeniedError, ScopeDeniedError };
