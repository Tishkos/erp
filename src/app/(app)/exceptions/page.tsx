import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { Pagination } from '@/components/ui';
import { formatBusinessDate, formatTimestamp, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { DOMAINS, SEVERITIES, SEVERITY_TONE, STATUS_TONE } from '@/server/domain/exceptions';
import { registerAllRecords } from '@/server/records';
import { savedViewsFor } from '@/server/saved-views-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as exceptions from '@/server/services/exceptions';
import { refreshExceptions } from './actions';

/**
 * Exceptions — platform phase, Agent 7. Copies the Tasks list: the register,
 * the filters as a form of Selects (domain, severity, status, owner — the
 * choices carry how many are open), paging. One route; the record behind a
 * row is its own page. What is listed is what the reader may open: the grant
 * on the exception and on the object it is about, their branches, and — for
 * a record that is its parties' alone, a task — the right to open that record.
 *
 * The last check is said under the toolbar; "Refresh now" is offered to
 * whoever administers the centre and runs the same sweep the schedule does.
 */
export const dynamic = 'force-dynamic';

export default async function ExceptionsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/exceptions')) notFound();
  registerAllRecords();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.exceptions'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', exceptions.PERMISSION_OBJECT)) return <Denied object={page('exceptions')} />;
  const mayRefresh = can(principal, 'administer', exceptions.PERMISSION_OBJECT);

  const params = await searchParams;
  const param = (name: string) => (typeof params[name] === 'string' ? (params[name] as string) : '');
  const filter = { domain: param('domain'), severity: param('severity'), status: param('status'), owner: param('owner') };
  const saved = await savedViewsFor('exceptions.list', searchParams);

  const found = await withCurrentUser(async (tx) => {
    // One after the other: the transaction is one connection and answers one question at a time.
    const result = await exceptions.listForScreen(tx, principal, { ...filter, q: outcome.q, page: outcome.page, locale: locale as Locale });
    const last = await exceptions.lastRun(tx);
    return { result, last };
  });
  const { result, last } = found;
  const { counts } = result;
  const status = (exceptions.STATUS_FILTERS as readonly string[]).includes(filter.status) ? filter.status : 'live';

  const day = (value: string | null) => (value ? formatBusinessDate(value.slice(0, 10), locale as Locale) : '—');
  const query = (p: number) =>
    new URLSearchParams({
      ...(outcome.q ? { q: outcome.q } : {}),
      ...(filter.domain ? { domain: filter.domain } : {}),
      ...(filter.severity ? { severity: filter.severity } : {}),
      ...(status !== 'live' ? { status } : {}),
      ...(filter.owner ? { owner: filter.owner } : {}),
      page: String(p),
    }).toString();

  return (
    <AdminPage
      actions={
        mayRefresh ? (
          <form action={refreshExceptions}>
            <Submit label={x('refresh')} tone="secondary" />
          </form>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/exceptions" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      {last && last.failed > 0 ? <p className={s.sapNote}>{x('last_check_failed', { failed: last.failed })}</p> : null}

      <section aria-labelledby="exceptions-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="exceptions-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/exceptions"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            hidden={{ ...(filter.domain ? { domain: filter.domain } : {}), ...(filter.severity ? { severity: filter.severity } : {}), ...(status !== 'live' ? { status } : {}), ...(filter.owner ? { owner: filter.owner } : {}) }}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          >
            <SavedViewsMenu state={saved} />
          </ListToolbar>

          <p className={s.hint}>
            {last
              ? x('last_check', {
                  when: formatTimestamp(last.finishedAt, locale as Locale),
                  found: last.found,
                  created: last.created,
                  reopened: last.reopened,
                  resolved: last.resolved,
                })
              : x('last_check_none')}
          </p>

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={DOMAINS.includes(filter.domain as (typeof DOMAINS)[number]) ? filter.domain : ''}
                emptyLabel={`${x('all_domains')} (${counts.total})`}
                label={x('domain')}
                name="domain"
                options={DOMAINS.map((d) => ({ value: d, label: `${x(`domain_${d}`)} (${counts.byDomain[d]})` }))}
              />
              <Select
                defaultValue={SEVERITIES.includes(filter.severity as (typeof SEVERITIES)[number]) ? filter.severity : ''}
                emptyLabel={x('all_severities')}
                label={x('severity')}
                name="severity"
                options={[...SEVERITIES].reverse().map((v) => ({ value: v, label: `${x(`severity_${v}`)} (${counts.bySeverity[v]})` }))}
              />
              <Select
                defaultValue={status}
                label={x('status')}
                name="status"
                options={exceptions.STATUS_FILTERS.map((v) => ({ value: v, label: x(`status_${v}`) }))}
              />
              <Select
                defaultValue={filter.owner === 'me' || filter.owner === 'none' ? filter.owner : ''}
                emptyLabel={x('owner_any')}
                label={x('owner')}
                name="owner"
                options={[
                  { value: 'me', label: x('owner_me') },
                  { value: 'none', label: x('owner_none') },
                ]}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="exceptions-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('severity')}</th>
                  <th scope="col">{x('col_exception')}</th>
                  <th scope="col">{x('col_record')}</th>
                  <th scope="col">{x('domain')}</th>
                  <th scope="col">{x('owner')}</th>
                  <th scope="col">{x('col_first')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {outcome.q || filter.domain || filter.severity || filter.owner || status !== 'live' ? x('none_filtered') : x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={row.href}>
                        <bdi dir="ltr">{row.no}</bdi>
                      </Link>
                    </td>
                    <td>
                      <span className={`status status--${SEVERITY_TONE[row.severity]} ${s.sapRegisterStatus}`} data-status={SEVERITY_TONE[row.severity]}>
                        {x(`severity_${row.severity}`)}
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{row.title}</bdi>
                    </td>
                    <td>
                      {row.recordHref.startsWith('/') ? (
                        <Link className={s.sapLink} href={row.recordHref}>
                          <bdi dir="auto">{row.recordLabel}</bdi>
                        </Link>
                      ) : (
                        <bdi dir="auto">{row.recordLabel}</bdi>
                      )}
                    </td>
                    <td>{x(`domain_${row.domain}`)}</td>
                    <td>
                      <bdi dir="auto">{row.ownerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.firstDetectedAt)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${STATUS_TONE[row.status]} ${s.sapRegisterStatus}`} data-status={STATUS_TONE[row.status]}>
                        {x(`status_${row.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            count={result.pages}
            current={result.page}
            hrefFor={(p) => `/exceptions?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
