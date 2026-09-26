import { isExportKey } from '@/server/print/access';
import { exportResponse } from '@/server/print/route';

/**
 * Every document and report as PDF, Excel or Word — the one route behind every
 * Print / Export menu.
 *
 *   /export/<document>/<number>?format=pdf|xlsx|docx&lang=en|ar
 *   /export/<report>?format=…&lang=…&<the report's filters, as on its screen>
 *
 * One route rather than one beside each screen: an export reads nearly every
 * service, and each separate route entry is compiled on its own by the
 * development server, which ran out of memory at two dozen of them. The
 * permission, the branch scope and the audit record are the same for every
 * key either way — see `exportResponse` and `runExport`.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ key: string; id?: string[] }> },
) {
  const { key, id = [] } = await params;
  if (!isExportKey(key) || id.length > 1) return new Response(null, { status: 404 });
  return exportResponse(request, key, id[0] === undefined ? null : decodeURIComponent(id[0]));
}
