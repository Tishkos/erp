import { optionalContext } from '@/server/session';

/**
 * REQ-HARDEN-001 HD1 — the version of the caller's permissions, read on every
 * navigation by the shell. When it has moved since the shell was rendered the
 * shell refreshes itself, so a grant or a revocation shows on the next click
 * rather than after a hard reload.
 */
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const context = await optionalContext();
  return Response.json(
    { version: context?.permissionsVersion ?? 0 },
    { headers: { 'cache-control': 'no-store' } },
  );
}
