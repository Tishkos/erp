import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ViewActions, ViewBadges, ViewRename, ViewSummary } from '@/components/saved-views/view-parts';
import { describeView } from '@/components/saved-views/describe';
import type { Locale } from '@/i18n/config';
import { MAX_PINNED_VIEWS, MAX_ROUTE_VIEWS, listRouteViews } from '@/server/services/saved-views';
import { requireContext, withCurrentUser } from '@/server/session';

/**
 * Saved views — everything a person has kept, across screens.
 *
 * Their own filters for the screens they use, nothing else: a view is a route
 * and a few filter parameters, never a row (`services/saved-views.ts`). The
 * list is read as the signed-in person and holds only their rows; each view is
 * checked against what they may open *today*, so one whose screen they have
 * lost is listed as unavailable — not hidden — and can still be renamed or
 * deleted. Drawn as Purchase Invoices is: the register window, the search box,
 * the table.
 */
export const dynamic = 'force-dynamic';

export default async function SavedViewsPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, profile, admin, page, locale, outcome] = await Promise.all([
    getTranslations('savedViews'),
    getTranslations('profile'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);

  const views = await withCurrentUser((tx, context) => listRouteViews(tx, context.principal));
  const screenName = (key: string | null, route: string | null) =>
    key && page.has(key) ? page(key) : (route ?? '—');
  const needle = outcome.q.trim().toLowerCase();
  const shown = views.filter(
    (view) =>
      !needle ||
      view.name.toLowerCase().includes(needle) ||
      screenName(view.screenKey, view.route).toLowerCase().includes(needle),
  );
  const rows = await Promise.all(
    shown.map(async (view) => ({
      view,
      lines: await describeView(view.routeKey, view.params, view.rules, locale as Locale),
    })),
  );
  const pinned = views.filter((view) => view.pinnedAt).length;

  return (
    <AdminPage
      back={{ href: '/profile', label: profile('title') }}
      subtitle={t('subtitle')}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="saved-views-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="saved-views-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: rows.length })}</span>
          </h2>
          <ListToolbar
            clearHref="/profile/views"
            clearLabel={admin('clear_search')}
            countLabel={t('limits', { views: views.length, maxViews: MAX_ROUTE_VIEWS, pinned, maxPins: MAX_PINNED_VIEWS })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="saved-views-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('screen')}</th>
                  <th scope="col">{t('view')}</th>
                  <th scope="col">{t('filters')}</th>
                  <th scope="col">{admin('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {views.length === 0 ? t('none') : t('none_found')}
                    </td>
                  </tr>
                ) : null}
                {rows.map(({ view, lines }) => (
                  <tr key={view.id}>
                    <td>{screenName(view.screenKey, view.route)}</td>
                    <td>
                      <ViewRename returnTo="/profile/views" view={view} />
                      <ViewBadges view={view} />
                    </td>
                    <td>
                      <ViewSummary lines={lines} view={view} />
                    </td>
                    <td>
                      <ViewActions returnTo="/profile/views" view={view} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
