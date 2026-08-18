import { exportRows } from '@/server/services/list';
import { registerAllLists } from '@/server/lists';
import { withCurrentUser } from '@/server/session';
import { toCsv } from '@/server/services/csv';

/**
 * List export — Phase 01.12.
 *
 * 01.12 gate: *"Export returns exactly the rows the on-screen list would return
 * for that user — no more."*
 *
 * This handler receives the same query string the screen was showing and hands
 * it to `exportRows`, which normalises it exactly as the screen did and then
 * removes only the page window. There is no parameter here that could reopen a
 * filter, a column or a scope the screen had closed — the two paths share the
 * one normaliser, so they cannot drift.
 *
 * The export is recorded in the audit trail by the service, because who took a
 * copy of what is an audit question (§5.4).
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  registerAllLists();

  const params = new URL(request.url).searchParams;
  const search = params.get('q') ?? undefined;

  const result = await withCurrentUser((tx, context) =>
    exportRows(tx, context.principal, 'chart_of_account', {
      ...(search ? { search } : {}),
    }),
  );

  return new Response(toCsv(result.query.columns, result.rows), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="chart-of-accounts.csv"',
      // Never cached: an export reflects one person's permissions at one
      // moment, and a shared cache would serve it to the next reader.
      'cache-control': 'no-store, private',
    },
  });
}
