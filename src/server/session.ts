/**
 * The request's identity, for server components and route handlers — Phase 01.12.
 *
 * Every screen begins here. §25: *"Use deny-by-default, server-side
 * authorisation for every page, API and record. Navigation hiding alone is not
 * access control."* So a page does not receive a user id from anywhere it could
 * be influenced — it reads the session cookie, resolves it against the database
 * on this request (so a revocation a second ago is seen now), and gets back a
 * `Principal` with the grants and scopes that were true a moment ago.
 *
 * There is no unauthenticated path into a screen: `requireContext` sends the
 * visitor to the sign-in form before any work is done.
 */
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { db, applyScope, type RequestScope, type Tx } from './db/client';
import type { Principal } from './domain/permissions';
import { loadPrincipal } from './services/authorization';
import { resolveSession } from './services/authentication';

export const SESSION_COOKIE = 'erp_session';
/** The branch the person chose to work in — written by the header's picker. */
export const BRANCH_COOKIE = 'erp_branch';

export class NotSignedInError extends Error {
  readonly code = 'NOT_SIGNED_IN';
  constructor(reason: string) {
    super(`Sign in to continue: ${reason}`);
    this.name = 'NotSignedInError';
  }
}

export interface RequestContext {
  readonly principal: Principal;
  readonly scope: RequestScope;
  readonly sessionId: string;
}

/**
 * Resolve the caller.
 *
 * The branch a request runs under comes from the user's own scope list, not
 * from anything the client sends. A user with several branches works in one at
 * a time; the picker writes the chosen one to a cookie, and it is checked
 * against their scope here rather than trusted.
 */
export async function currentContext(): Promise<RequestContext> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;

  if (!token) throw new NotSignedInError('no session cookie was sent');

  return db.transaction(async (tx) => {
    const { session, user } = await resolveSession(tx, token);

    // Scope must be set before the principal is read: `user_branch_scope` and
    // the rest are behind RLS, and a transaction with no scope sees nothing.
    const bootstrap: RequestScope = {
      userId: user.id,
      branchCode: '',
      isSuperUser: user.isSuperUser,
    };
    await applyScope(tx, bootstrap);

    const principal = await loadPrincipal(tx, user.id);
    const requested = jar.get(BRANCH_COOKIE)?.value;

    // A branch the user may not see is not an error worth a page for — it is
    // usually a stale cookie from a scope that was withdrawn. Fall back to one
    // they do have rather than locking them out of the application.
    const branchCode =
      requested && principal.branchCodes.includes(requested)
        ? requested
        : (principal.defaultBranchCode ?? '');

    return {
      principal,
      scope: { userId: user.id, branchCode, isSuperUser: user.isSuperUser },
      sessionId: session.id,
    };
  });
}

/** The same, returning null instead of throwing — for the sign-in page itself. */
export async function optionalContext(): Promise<RequestContext | null> {
  try {
    return await currentContext();
  } catch {
    return null;
  }
}

/**
 * The context, or the sign-in page.
 *
 * Every screen and route handler goes through this. An unauthenticated visitor
 * gets the sign-in form, not an error page — but note what is *not* happening
 * here: nothing is being rendered before the check. §25's deny-by-default
 * applies to "every page, API and record", so the refusal is the first thing
 * that happens on the request, not a guard around the parts that look sensitive.
 */
export async function requireContext(): Promise<RequestContext> {
  const context = await optionalContext();
  if (!context) redirect('/sign-in');
  return context;
}

/**
 * Run work for the current user, inside their scope.
 *
 * Two round trips — one to resolve the session, one for the work — because the
 * alternative is holding a transaction open across the whole render.
 */
export async function withCurrentUser<T>(
  fn: (tx: Tx, context: RequestContext) => Promise<T>,
): Promise<T> {
  const context = await requireContext();
  return db.transaction(async (tx) => {
    await applyScope(tx, context.scope);
    return fn(tx, context);
  });
}

/** The client's address, for the audit trail (§5.4 "source device/session"). */
export async function requestOrigin(): Promise<{ ip: string | null; userAgent: string | null }> {
  const list = await headers();
  return {
    ip: list.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    userAgent: list.get('user-agent'),
  };
}
