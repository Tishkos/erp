import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { db, applyScope } from '@/server/db/client';
import { logger } from '@/server/logging';
import { revokeSession } from '@/server/services/authentication';
import { optionalContext, SESSION_COOKIE } from '@/server/session';

/**
 * Sign-out — the user menu's "Sign out" posts here.
 *
 * A POST, not a GET: a link that signs the visitor out on a plain navigation
 * is something an image tag on another site could trigger. The session is
 * revoked server-side (§25 — revocation is immediate) and the cookie cleared,
 * so neither the browser nor the database still honours it. A stale or
 * missing cookie is not an error: the visitor ends up at the sign-in form
 * either way.
 */
export const dynamic = 'force-dynamic';

export async function POST() {
  // Signing out never fails for the person: if the database cannot be asked
  // just now, the cookie is cleared all the same and the session runs out on
  // its own expiry. The failure is still logged.
  try {
    const context = await optionalContext();
    if (context) {
      await db.transaction(async (tx) => {
        await applyScope(tx, context.scope);
        await revokeSession(
          tx,
          { principal: context.principal, branchCode: context.scope.branchCode },
          context.sessionId,
          'User signed out',
        );
      });
    }
  } catch (error) {
    logger.error('sign-out: the session could not be revoked', { error });
  }

  const jar = await cookies();
  jar.delete(SESSION_COOKIE);

  redirect('/sign-in');
}
