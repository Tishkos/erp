import { getLocale, getTranslations } from 'next-intl/server';
import { registerAllRecords } from '@/server/records';
import { presentDeps, type SearchTranslator } from '@/server/search/deps';
import { present } from '@/server/search/present';
import { DEFAULT_GROUP_LIMIT } from '@domain/search';
import { searchAs } from '@/server/services/global-search';
import { optionalContext } from '@/server/session';

/**
 * The palette's records — `GET /search/results?q=<phrase>`.
 *
 * Server-side only: the browser holds the phrase and the answer, never the
 * tables. The search runs as the signed-in person, in a transaction the
 * database holds read-only (`services/global-search`); what comes back is what
 * their grants and their branches let them open, already translated and
 * formatted. A signed-out visitor is told so (401), and a session limited to
 * the password screen or to two-factor enrolment is answered with nothing —
 * the same restriction the shell applies to its menu.
 *
 * The phrase is not logged, audited or kept: this handler writes nothing.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const LONGEST_PHRASE = 200;

export async function GET(request: Request): Promise<Response> {
  const context = await optionalContext();
  if (!context) return Response.json({ error: 'not_signed_in' }, { status: 401, headers: NO_STORE });
  if (context.restriction) return Response.json({ groups: [], failed: [] }, { headers: NO_STORE });

  const phrase = new URL(request.url).searchParams.get('q')?.slice(0, LONGEST_PHRASE) ?? '';
  registerAllRecords();
  const [t, locale] = await Promise.all([getTranslations('search'), getLocale()]);
  const outcome = await searchAs(context.scope, context.principal, { query: phrase, limit: DEFAULT_GROUP_LIMIT });
  return Response.json(present(outcome, presentDeps(t as unknown as SearchTranslator, locale)), { headers: NO_STORE });
}
