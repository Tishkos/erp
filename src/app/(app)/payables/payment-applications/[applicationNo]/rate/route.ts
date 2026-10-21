import { can } from '@domain/permissions';
import { isNotFoundError } from '@/server/not-found';
import { optionalContext, withCurrentUser } from '@/server/session';
import * as applications from '@/server/services/payment-applications';

/**
 * The rate a Paid paper would post this application at, for the date typed in
 * the Paid window (2026-10-21: "it should say before creating it: is the
 * current exchange rate correct"). Read as the caller; it changes nothing.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ applicationNo: string }> }): Promise<Response> {
  const context = await optionalContext();
  if (!context) return Response.json({ error: 'signed_out' }, { status: 401 });
  if (!can(context.principal, 'view', applications.PERMISSION_OBJECT)) return Response.json({ error: 'denied' }, { status: 403 });
  const applicationNo = decodeURIComponent((await params).applicationNo);
  const date = new URL(request.url).searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: 'bad_date' }, { status: 400 });
  const answer = await withCurrentUser(async (tx) => {
    try {
      const row = await applications.loadByNo(tx, applicationNo);
      return { rate: await applications.paidRateFor(tx, row, date) };
    } catch (error) {
      if (isNotFoundError(error)) return { notFound: true as const };
      // No rate for that currency at all: said, not a failure of the page.
      return { error: error instanceof Error ? error.message : String(error) };
    }
  });
  if ('notFound' in answer) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(answer, { headers: { 'cache-control': 'no-store' } });
}
