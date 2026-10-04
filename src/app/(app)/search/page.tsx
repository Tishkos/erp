import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  FilterRow,
  Hidden,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Pagination } from '@/components/ui';
import { registerAllRecords } from '@/server/records';
import { presentDeps, type SearchTranslator } from '@/server/search/deps';
import { present, type PresentedGroup } from '@/server/search/present';
import { registerBuiltInSearchTypes } from '@/server/search/entities';
import { searchTypes } from '@/server/search/registry';
import { matchScreens, normaliseQuery, MAX_QUERY_LENGTH, PAGE_GROUP_LIMIT, MIN_RECORD_QUERY } from '@domain/search';
import { mayView, searchAs, visibleScreens } from '@/server/services/global-search';
import { requireContext } from '@/server/session';

/**
 * Search — every result for a phrase, grouped by what it is.
 *
 * The palette (Ctrl K) shows the first few of each group; this page shows more
 * and pages one group at a time (`?type=<group>&page=<n>`). It is the same
 * search as the palette's — the same service, run as the signed-in person — so
 * the two cannot disagree about what exists or who may see it. Read-only: it
 * writes nothing and keeps no history of what was searched.
 */
export const dynamic = 'force-dynamic';

/** Rows per page when one group is open. */
const GROUP_PAGE_SIZE = 25;

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const [t, a, pageNames, nav, column, locale, context, params] = await Promise.all([
    getTranslations('search'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('nav'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  registerAllRecords();
  registerBuiltInSearchTypes();

  const { principal, scope } = context;
  const q = (typeof params.q === 'string' ? params.q : '').slice(0, MAX_QUERY_LENGTH).trim();
  const pageNo = Math.max(1, Math.trunc(Number(typeof params.page === 'string' ? params.page : '1')) || 1);

  // The types this person may search — the filter offers no other.
  const mayType = searchTypes().filter((type) => mayView(principal, type));
  const typeParam =
    typeof params.type === 'string' && (params.type === 'screen' || mayType.some((type) => type.key === params.type))
      ? params.type
      : '';

  const query = normaliseQuery(q);
  const wantsRecords = query.display.length >= MIN_RECORD_QUERY && typeParam !== 'screen';
  const outcome = wantsRecords
    ? await searchAs(scope, principal, {
        query: q,
        limit: typeParam ? GROUP_PAGE_SIZE : PAGE_GROUP_LIMIT,
        offset: typeParam ? (pageNo - 1) * GROUP_PAGE_SIZE : 0,
        ...(typeParam ? { types: [typeParam] } : {}),
      })
    : null;
  const deps = presentDeps(t as unknown as SearchTranslator, locale);
  const presented = outcome ? present(outcome, deps) : { groups: [], failed: [] };
  const { groups, failed } = presented;

  // The screens, from the same list the navigation shows.
  const screens =
    query.display.length > 0 && (typeParam === '' || typeParam === 'screen')
      ? matchScreens(
          visibleScreens(principal).map((screen) => ({
            key: `${screen.sectionKey}:${screen.itemKey}`,
            label: pageNames(screen.itemKey),
            section: nav(screen.sectionKey),
            href: screen.href,
          })),
          query,
          typeParam === 'screen' ? 100 : 8,
        )
      : [];

  const total = groups.reduce((sum, group) => sum + group.rows.length, 0) + screens.length;
  const shown = t('shown', { count: total });
  const here = (extra: Record<string, string | number>) => {
    const search = new URLSearchParams({ q });
    if (typeParam) search.set('type', typeParam);
    for (const [key, value] of Object.entries(extra)) search.set(key, String(value));
    return `/search?${search.toString()}`;
  };
  const labels = {
    label: a('pagination'),
    previous: a('previous'),
    next: a('next'),
    page: (p: number) => a('page_n', { page: p }),
  };

  const table = (group: PresentedGroup) => (
    <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
      <table aria-labelledby={`search-${group.key}`} className={`${s.sapTable} ${s.sapRegisterTable}`}>
        <thead>
          <tr>
            <th scope="col">{t('col_record')}</th>
            <th scope="col">{t('col_name')}</th>
            <th scope="col">{t('col_party')}</th>
            <th scope="col">{t('col_date')}</th>
            <th className={s.sapNum} scope="col">
              {column('amount')}
            </th>
            <th scope="col">{t('col_status')}</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link className={s.sapLink} href={row.href}>
                  <bdi dir="auto">{row.number}</bdi>
                </Link>
              </td>
              <td>
                <bdi dir="auto">{row.title ?? '—'}</bdi>
              </td>
              <td>
                <bdi dir="auto">{row.party ?? row.related ?? '—'}</bdi>
              </td>
              <td>
                <bdi dir="ltr">{row.date ?? '—'}</bdi>
              </td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{row.amount ?? '—'}</bdi>
              </td>
              <td>
                {row.status ? (
                  <span className={`status status--${row.status.chip} ${s.sapRegisterStatus}`} data-status={row.status.chip}>
                    {row.status.label}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <AdminPage
      back={{ href: '/', label: a('dashboard_label') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/search" />}
      title={t('title')}
      variant="sap"
    >
      <section aria-labelledby="search-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="search-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{shown}</span>
          </h2>

          <ListToolbar
            clearHref="/search"
            clearLabel={a('clear_search')}
            countLabel={shown}
            placeholder={t('placeholder')}
            q={q}
            searchLabel={a('search')}
          />

          <form className={s.filterBar} method="get">
            <Hidden name="q" value={q} />
            <FilterRow>
              <Select
                defaultValue={typeParam}
                emptyLabel={t('all_types')}
                label={t('filter_type')}
                name="type"
                options={[
                  { value: 'screen', label: t('types.screen') },
                  ...mayType.map((type) => ({ value: type.key, label: t(`types.${type.key}`) })),
                ]}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          {failed.length > 0 ? <p className={s.sapNote}>{t('failed', { types: failed.join(', ') })}</p> : null}

          {total === 0 ? (
            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table aria-labelledby="search-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <tbody>
                  <tr>
                    <td className={s.sapEmptyRow}>
                      {q === '' ? t('prompt') : query.display.length < MIN_RECORD_QUERY ? t('too_short') : t('none', { query: q })}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </section>

      {screens.length > 0 ? (
        <section aria-labelledby="search-screen" className={`${s.sapDoc} ${s.sapRegister}`}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id="search-screen">
              <span>{t('types.screen')}</span>
              <span className={s.sapTitleMeta}>{t('shown', { count: screens.length })}</span>
            </h2>
            <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
              <table aria-labelledby="search-screen" className={`${s.sapTable} ${s.sapRegisterTable}`}>
                <thead>
                  <tr>
                    <th scope="col">{t('col_screen')}</th>
                    <th scope="col">{t('col_menu')}</th>
                  </tr>
                </thead>
                <tbody>
                  {screens.map((screen) => (
                    <tr key={screen.key}>
                      <td>
                        <Link className={s.sapLink} href={screen.href}>
                          {screen.label}
                        </Link>
                      </td>
                      <td>{screen.section}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {groups.map((group) => (
        <section aria-labelledby={`search-${group.key}`} className={`${s.sapDoc} ${s.sapRegister}`} key={group.key}>
          <div className={s.sapWindow}>
            <h2 className={s.sapTitle} id={`search-${group.key}`}>
              <span>{group.label}</span>
              <span className={s.sapTitleMeta}>
                {group.more && !typeParam ? (
                  <Link className={s.sapLink} href={`/search?q=${encodeURIComponent(q)}&type=${encodeURIComponent(group.key)}`}>
                    {t('see_more')}
                  </Link>
                ) : (
                  t('shown', { count: group.rows.length })
                )}
              </span>
            </h2>
            {table(group)}
            {typeParam ? (
              <Pagination
                count={group.more ? pageNo + 1 : pageNo}
                current={pageNo}
                hrefFor={(p) => here({ page: p })}
                labels={labels}
                locale={locale}
              />
            ) : null}
          </div>
        </section>
      ))}
    </AdminPage>
  );
}
