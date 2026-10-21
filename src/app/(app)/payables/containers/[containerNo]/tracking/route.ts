import { can } from '@domain/permissions';
import { isNotFoundError } from '@/server/not-found';
import { optionalContext, withCurrentUser } from '@/server/session';
import * as tracking from '@/server/services/container-tracking';
import * as shipments from '@/server/services/shipments';

/**
 * Where one container is now, as its line says (2026-10-21, live tracking).
 * The container is read as the caller first — their grant, their branches —
 * so nobody learns where a box is that they could not open. The line's answer
 * is remembered in memory for a few minutes and never written down.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ containerNo: string }> }): Promise<Response> {
  const context = await optionalContext();
  if (!context) return Response.json({ error: 'signed_out' }, { status: 401 });
  if (!can(context.principal, 'view', shipments.CONTAINER_OBJECT)) return Response.json({ error: 'denied' }, { status: 403 });
  const containerNo = decodeURIComponent((await params).containerNo);
  const id = new URL(request.url).searchParams.get('id');
  const found = await withCurrentUser(async (tx) => {
    try {
      const view = await shipments.viewContainer(tx, containerNo, id);
      return { containerNo: view.container.containerNo, shippingLine: view.bl.shippingLine };
    } catch (error) {
      if (isNotFoundError(error)) return null;
      throw error;
    }
  });
  if (!found) return Response.json({ error: 'not_found' }, { status: 404 });
  const live = await tracking.liveTrackingFor(found.containerNo, found.shippingLine);
  return Response.json(live, { headers: { 'cache-control': 'no-store' } });
}
