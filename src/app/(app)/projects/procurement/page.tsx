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
import * as pe from '@/server/services/project-execution';
import * as ps from '@/server/services/project-system';

/**
 * Procurement — REQ-PM-001 §13: the orders and the payables assigned to
 * elements, with the promise each one made, what became actual, what was
 * given back, and what is still open. Copies the Purchase Invoices list.
 */
export const dynamic = 'force-dynamic';

export default async function ProcurementPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/procurement')) notFound();
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
  if (!can(principal, 'view', pe.PERMISSION_OBJECT)) {
    return <Denied object={page('project_procurement')} />;
  }
  const params = await searchParams;
  const projectParam = typeof params.project === 'string' ? params.project : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const { result, choices } = await withCurrentUser(async (tx) => ({
    result: await pe.procurement(tx, { projectCode: projectParam || null, search: outcome.q, page: pageNo }),
    choices: (await ps.list(tx, { pageSize: 100 })).rows,
  }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = (p: number) => [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', projectParam ? `project=${encodeURIComponent(projectParam)}` : '', `page=${p}`].filter(Boolean).join('&');
  const href = (row: (typeof result.rows)[number]) => (row.documentType === 'purchase_order' ? `/payables/purchase-orders/${encodeURIComponent(row.documentNo)}` : `/payables/${encodeURIComponent(row.documentNo)}`);

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} tabs={<SectionTabs route="/projects/procurement" />} subtitle={x('procurement_subtitle')} title={page('project_procurement')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="procurement-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="procurement-list-title">
            <span>{page('project_procurement')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects/procurement" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select defaultValue={projectParam} emptyLabel={x('all_projects')} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="procurement-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{x('document')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{x('project')}</th>
                  <th scope="col">{x('element')}</th>
                  <th scope="col">{x('cost_code')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('committed')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('converted')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('released')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('open')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={13}>
                      {x('no_procurement')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={`${row.documentType}:${row.documentId}`}>
                    <td>
                      <Link className={s.sapLink} href={href(row)}>
                        <bdi dir="ltr">{row.documentNo}</bdi>
                      </Link>
                    </td>
                    <td>{row.documentType === 'purchase_order' ? x('purchase_order') : x('payable')}</td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.documentDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.projectCode)}`}>
                        <bdi dir="ltr">{row.projectCode}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.wbsCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.costCode}</bdi>
                    </td>
                    <td className={s.sapNum}>{money(row.amountIqd)}</td>
                    <td className={s.sapNum}>{money(row.committedIqd)}</td>
                    <td className={s.sapNum}>{money(row.consumedIqd)}</td>
                    <td className={s.sapNum}>{money(row.releasedIqd)}</td>
                    <td className={s.sapNum}>{money(row.openIqd)}</td>
                    <td>
                      <bdi dir="auto">{status.has(row.status) ? status(row.status) : row.status.replace(/_/g, ' ')}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pagination count={pages} current={result.page} hrefFor={(p) => `/projects/procurement?${query(p)}`} labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
