import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ps from '@/server/services/project-system';
import { chipOf } from '../chip';

/**
 * Contracts — REQ-PM-001 §13: the customer projects seen as contracts —
 * value, billing method, retention and advance, what has been billed.
 * Copies the Purchase Invoices list; a row opens the project's record,
 * where the contract window sits under the structure.
 */
export const dynamic = 'force-dynamic';

export default async function ContractsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/contracts')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', ps.PERMISSION_OBJECT)) {
    return <Denied object={page('contracts')} />;
  }
  const params = await searchParams;
  const statusParam = typeof params.status === 'string' ? params.status : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const result = await withCurrentUser((tx) => ps.list(tx, { status: statusParam || null, typeCode: 'CUSTOMER', search: outcome.q, page: pageNo }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const hrefFor = (p: number) => `/projects/contracts?${[outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', statusParam ? `status=${statusParam}` : '', `page=${p}`].filter(Boolean).join('&')}`;

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} tabs={<SectionTabs route="/projects/contracts" />} subtitle={x('contracts_subtitle')} title={page('contracts')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="contracts-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="contracts-list-title">
            <span>{page('contracts')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects/contracts" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select
                defaultValue={statusParam}
                emptyLabel={x('status_all')}
                label={column('status')}
                name="status"
                options={['draft', 'active', 'on_hold', 'closing', 'closed'].map((value) => ({ value, label: x(`status_${value}`) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="contracts-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('code')}</th>
                  <th scope="col">{column('name')}</th>
                  <th scope="col">{x('customer')}</th>
                  <th scope="col">{x('manager')}</th>
                  <th scope="col">{x('baseline_starts_on')}</th>
                  <th scope="col">{x('baseline_ends_on')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('contract_value')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('budget')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('actual')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.code}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.code)}`}>
                        <bdi dir="ltr">{row.code}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.name}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.customerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.managerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.baselineStartsOn ? formatBusinessDate(row.baselineStartsOn, locale as Locale) : '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.baselineEndsOn ? formatBusinessDate(row.baselineEndsOn, locale as Locale) : '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.contractValueIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.budgetIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.actualIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${chipOf(row.status)} ${s.sapRegisterStatus}`} data-status={chipOf(row.status)}>
                        {x(`status_${row.status}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pagination count={pages} current={result.page} hrefFor={hrefFor} labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
