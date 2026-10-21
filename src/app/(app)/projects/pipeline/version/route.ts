import { can } from '@domain/permissions';
import { optionalContext, withCurrentUser } from '@/server/session';
import * as initiation from '@/server/services/project-initiation';

/**
 * The version of what a pipeline page shows (2026-10-21, "live updates"): one
 * record's (`?no=PIN-…`) or the whole board's. `LiveRefresh` asks it every few
 * seconds and redraws the page only when it moved. Read as the caller, under
 * their branches; it says when something changed, never what.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const context = await optionalContext();
  if (!context) return Response.json({ error: 'signed_out' }, { status: 401 });
  if (!can(context.principal, 'view', initiation.PERMISSION_OBJECT)) return Response.json({ error: 'denied' }, { status: 403 });
  const no = new URL(request.url).searchParams.get('no')?.trim() || null;
  if (no && no.length > 64) return Response.json({ error: 'bad_request' }, { status: 400 });
  const version = await withCurrentUser((tx) => initiation.liveVersion(tx, no));
  return Response.json({ version }, { headers: { 'cache-control': 'no-store' } });
}
