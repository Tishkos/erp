import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { Pagination } from '@/components/ui';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as views from '@/server/services/logistics-views';
import { BL_OBJECT } from '@/server/services/shipments';
import { containerChip } from '../../payables/containers/status';

/**
 * Shipments — REQ-LOG-001 item 12 (Q2: a register, no table). One row per
 * import that has a B/L: its B/Ls, its containers counted as they arrive,
 * the route, the furthest-back stage, and where customs stands. The import
 * page's Shipment section is the record; this is the way to it. Drawn as
 * Purchase Invoices is.
 */
export const dynamic = 'force-dynamic';

const VIEWS = ['open', 'arrived', 'all'] as const;

export default async function ShipmentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/logistics/shipments')) notFound();

  const [t, sh, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.logistics'),
    getTranslations('admin.shipments'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', BL_OBJECT)) {
    return <Denied object={page('import_shipments')} />;
  }
  const params = await searchParams;
  const view = (VIEWS as readonly string[]).includes(String(params.view)) ? (params.view as (typeof VIEWS)[number]) : 'open';

  const result = await withCurrentUser((tx) => views.shipmentsRegister(tx, { view, search: outcome.q, page: outcome.page }));
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', `view=${view}`, `page=${p}`].filter(Boolean).join('&');
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale as Locale) : '—');
  const cs = (code: string | null, name: string | null) => (code && locale !== 'en' && sh.has(`cs.${code}`) ? sh(`cs.${code}`) : (name ?? '—'));

  return (
    <AdminPage back={{ href: '/', label: admin('dashboard_label') }} tabs={<SectionTabs route="/logistics/shipments" />} subtitle={t('shipments_subtitle')} title={page('import_shipments')} variant="sap">
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="shipment-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="shipment-list-title">
            <span>{page('import_shipments')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>
          <ListToolbar clearHref="/logistics/shipments" clearLabel={admin('clear_search')} countLabel={admin('rows_shown', { count: result.total })} placeholder={admin('search_placeholder')} q={outcome.q} searchLabel={admin('search')} />
          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={view} label={t('view')} name="view" options={VIEWS.map((key) => ({ value: key, label: t(`view_${key}`) }))} />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="shipment-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('import')}</th>
                  <th scope="col">{t('supplier')}</th>
                  <th scope="col">{t('col_bls')}</th>
                  <th scope="col">{t('col_route')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_containers')}
                  </th>
                  <th scope="col">{t('col_eta')}</th>
                  <th scope="col">{sh('status')}</th>
                  <th scope="col">{t('col_stage')}</th>
                  <th scope="col">{t('col_customs')}</th>
                  <th scope="col">{t('col_declarations')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {t('no_shipments')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.payableId}>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}#shipment`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                      {row.reference ? <div className="muted">{row.reference}</div> : null}
                    </td>
                    <td>
                      <ProfileLink code={row.supplierCode} dir="auto" kind="supplier">
                        {row.supplierName}
                      </ProfileLink>
                    </td>
                    <td>
                      {(row.blNos ?? '').split(', ').filter(Boolean).map((blNo, index) => (
                        <span key={blNo}>
                          {index > 0 ? ', ' : ''}
                          <ProfileLink code={blNo} kind="bl">
                            {blNo}
                          </ProfileLink>
                        </span>
                      ))}
                    </td>
                    <td>
                      <bdi dir="auto">{row.ports ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">
                        {row.received} / {row.containerCount}
                      </bdi>
                      {row.late > 0 ? <div className="muted">{t('late_n', { count: row.late })}</div> : null}
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.firstEta)}</bdi>
                    </td>
                    <td>
                      {row.leastStatusCode ? (
                        <span className={`status status--${containerChip({ statusCode: row.leastStatusCode })} ${s.sapRegisterStatus}`} data-status={containerChip({ statusCode: row.leastStatusCode })}>
                          {cs(row.leastStatusCode, row.leastStatusName)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <bdi dir="auto">{row.stageName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.pdSummary ?? '—'}</bdi>
                    </td>
                    <td>{row.declarationCount > 0 ? t('declarations_n', { cleared: row.clearedDeclarations, total: row.declarationCount }) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination
              count={result.pages}
              current={result.page}
              hrefFor={(p) => `/logistics/shipments?${query(p)}`}
              labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }}
              locale={locale}
            />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
