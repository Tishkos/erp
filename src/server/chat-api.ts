/**
 * How the chat's route handlers (the poll, the files) reach the services.
 *
 * A route is not a page: a visitor who is not signed in gets a 401, not a
 * redirect to the sign-in form, because the caller is a script on a page that
 * is already open. Everything else is `withCurrentUser`'s — the session is
 * resolved on this request, the branch comes from the person's own scope, and
 * the work runs inside it.
 *
 * `sameOrigin` is the cross-site guard for the one POST route: the session
 * cookie is `SameSite=Lax`, which already keeps it off a cross-site POST, and
 * a request that names another origin is refused as well.
 */
import { headers } from 'next/headers';
import { applyScope, db, type Tx } from './db/client';
import { currentClientIp, currentRequestId } from './request-id';
import type { ActorContext } from './services/chart-of-accounts';
import { optionalContext } from './session';

export type ChatApiOutcome<T> =
  | { readonly status: 'ok'; readonly value: T }
  | { readonly status: 'signed_out' }
  | { readonly status: 'restricted' };

export async function runChatApi<T>(handler: (tx: Tx, ctx: ActorContext) => Promise<T>): Promise<ChatApiOutcome<T>> {
  const context = await optionalContext();
  if (!context) return { status: 'signed_out' };
  if (context.restriction) return { status: 'restricted' };
  const [requestId, clientIp] = await Promise.all([currentRequestId(), currentClientIp()]);
  const value = await db.transaction(async (tx) => {
    await applyScope(tx, context.scope);
    return handler(tx, { principal: context.principal, branchCode: context.scope.branchCode, requestId, clientIp });
  });
  return { status: 'ok', value };
}

/** The request names this site as its origin, or names none (a same-origin fetch from an older browser). */
export async function sameOrigin(): Promise<boolean> {
  const list = await headers();
  const origin = list.get('origin');
  if (!origin) return true;
  const host = list.get('x-forwarded-host') ?? list.get('host');
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}
