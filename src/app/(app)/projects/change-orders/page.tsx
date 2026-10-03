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
import * as pb from '@/server/services/project-budget';
import * as ps from '@/server/services/project-system';

/**
 * Change Orders — REQ-PM-001 §13: the variations with their scope, cost and
 * schedule effect and the two approvals each one needs. Copies the
 * Purchase Invoices list; a row opens the document.
 */
export const dynamic = 'force-dynamic';

export default async function ChangeOrdersPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/change-orders')) notFound();
  const [t, x, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', pb.PERMISSION_OBJECT)) {
    return <Denied object={page('change_orders')} />;
  }
  const params = await searchParams;
  const projectParam = typeof params.project === 'string' ? params.project : '';
  const statusParam = typeof params.status === 'string' ? params.status : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const { result, choices } = await withCurrentUser(async (tx) => ({
    result: await pb.changeOrders(tx, { projectCode: projectParam || null, status: statusParam || null, search: outcome.q, page: pageNo }),
    choices: (await ps.list(tx, { pageSize: 100 })).rows,
  }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', projectParam ? `project=${encodeURIComponent(projectParam)}` : '', statusParam ? `status=${statusParam}` : '', `page=${p}`]
      .filter(Boolean)
      .join('&');
  const mayCreate = can(principal, 'create', pb.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href={`/projects/change-orders/new${projectParam ? `?project=${encodeURIComponent(projectParam)}` : ''}`}>
            {x('new_change_order')}
          </Link>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/change-orders" />}
      subtitle={x('change_orders_subtitle')}
      title={page('change_orders')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="change-orders-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="change-orders-list-title">
            <span>{page('change_orders')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects/change-orders" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select defaultValue={projectParam} emptyLabel={x('all_projects')} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} />
              <Select defaultValue={statusParam} emptyLabel={x('status_all')} label={column('status')} name="status" options={['draft', 'approved', 'rejected'].map((value) => ({ value, label: status(value) }))} />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="change-orders-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{x('project')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('contract_delta')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('budget_delta')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('schedule_delta')}
                  </th>
                  <th scope="col">{x('approvals')}</th>
                  <th scope="col">{x('raised_by')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {x('no_change_orders')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.variationNo}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/change-orders/${encodeURIComponent(row.variationNo)}`}>
                        <bdi dir="ltr">{row.variationNo}</bdi>
                      </Link>
                      {row.version > 1 ? <span className="muted"> · v{row.version}</span> : null}
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.projectCode)}`}>
                        <bdi dir="ltr">{row.projectCode}</bdi>
                      </Link>{' '}
                      <bdi dir="auto">{row.projectName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.raisedOn, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.description}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.contractDeltaIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.budgetDeltaIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.revisedEndsOn ? formatBusinessDate(row.revisedEndsOn, locale as Locale) : row.scheduleDeltaDays ? x('days', { count: row.scheduleDeltaDays }) : '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{[row.commercialIn ? x('approval_commercial') : null, row.budgetIn ? x('approval_budget') : null].filter(Boolean).join(' · ') || '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.raisedBy}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pagination count={pages} current={result.page} hrefFor={(p) => `/projects/change-orders?${query(p)}`} labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
