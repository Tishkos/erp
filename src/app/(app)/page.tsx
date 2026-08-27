import { redirect } from 'next/navigation';
import { optionalContext } from '@/server/session';

/**
 * My Dashboard — deliberately empty.
 *
 * By direction (2026-08-26) this screen shows nothing at all for now. The
 * dashboard it replaces read live counts, a fortnight of audit activity, the
 * users-by-role split and the department managers; that component still exists
 * as `components/phase0-dashboard.tsx` and the queries that fed it are in this
 * file's history, so putting it back is a matter of restoring one page rather
 * than rebuilding anything.
 *
 * The redirect stays. It is the only thing this page ever did that mattered to
 * somebody who is not signed in, and losing it would send a visitor to a blank
 * screen instead of the sign-in form.
 */
export const dynamic = 'force-dynamic';

export default async function Home() {
  const context = await optionalContext();
  if (!context) redirect('/sign-in');

  return null;
}
