import { currentClientIp, currentRequestId } from '@/server/request-id';
import { optionalContext, withCurrentUser } from '@/server/session';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as accounts from '@/server/services/cloud-accounts';
import { CloudUnreachableError } from '@/server/services/cloud-client';
import { sameSite } from '@/server/same-site';

/**
 * "Has the person approved the app password yet?" — asked every few seconds
 * by the waiting screen. The answer is one of `linked`, `pending`, `expired`
 * or `none`; the screen reloads itself on anything but `pending`.
 */
export const dynamic = 'force-dynamic';

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  if (!sameSite(request)) return json(403, { state: 'forbidden' });
  const context = await optionalContext();
  if (!context) return json(401, { state: 'signed_out' });
  const ctx: ActorContext = {
    principal: context.principal,
    branchCode: context.scope.branchCode,
    requestId: await currentRequestId(),
    clientIp: await currentClientIp(),
  };
  try {
    const state = await withCurrentUser((tx) => accounts.completeLink(tx, ctx));
    return json(200, { state });
  } catch (error) {
    // The cloud could not be asked just now; the screen tries again.
    if (error instanceof CloudUnreachableError) return json(200, { state: 'pending' });
    // Anything else ended the attempt (the new app password was revoked again): let go of it, and say why.
    await withCurrentUser((tx) => accounts.cancelLink(tx, ctx.principal.userId)).catch(() => undefined);
    return json(200, { state: 'failed', error: error instanceof Error ? error.message : 'Cloud Files could not be linked.' });
  }
}
