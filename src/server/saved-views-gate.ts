/**
 * What a registered screen asks first (platform phase, Agent 8).
 *
 *   const saved = await savedViewsFor('payables.invoices', searchParams);
 *
 * called by the page after its own permission check. Two things follow from
 * the answer:
 *
 *   - a bare arrival at a screen whose owner has chosen a default view is sent
 *     to that view (`redirect`, issued here, outside any `try`); an address
 *     that already carries filters, or `sv=none`, is left alone;
 *   - the Views menu is drawn from the returned state — the person's own views
 *     of this screen, each one re-evaluated against their *current* grants.
 *
 * `null` means there is nothing to offer: the screen is not in the registry, or
 * the person cannot open it (the page has already refused them). The state is
 * read in the page's own request, as the person, so row security applies to the
 * views table itself — nobody's views but their own are ever read.
 */
import { redirect } from 'next/navigation';
import type { SearchParams } from '@/components/admin/params';
import * as savedViews from './services/saved-views';
import { withCurrentUser } from './session';

export async function savedViewsFor(
  routeKey: string,
  searchParams: SearchParams,
): Promise<savedViews.SavedViewsState | null> {
  const params = await searchParams;
  const state = await withCurrentUser((tx, context) => savedViews.stateFor(tx, context.principal, routeKey, params));
  if (state?.redirectTo) redirect(state.redirectTo);
  return state;
}
