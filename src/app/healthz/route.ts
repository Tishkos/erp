import { db } from '@/server/db/client';
import { buildId, probe, version } from '@/server/services/system-health';

/**
 * REQ-IMPROVE-001 OP-4 (IM3) — what the deploy script and an external
 * monitor ask. No sign-in: it answers with no business data, only whether
 * the database answers, whether the migrations are at head and which build
 * this is. 503 when the database is down or the schema is behind, so a
 * deploy whose migration failed does not report itself healthy.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const result = await db.transaction((tx) => probe(tx)).catch(() => null);
  const body = result ?? {
    ok: false,
    database: false,
    migrations: { applied: 0, expected: null, atHead: false },
    build: buildId(),
    revision: 'unknown',
    version: version(),
    checkedAt: new Date().toISOString(),
  };
  return Response.json(body, { status: body.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } });
}
