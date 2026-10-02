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
 * Budgets — REQ-PM-001 §13: the budget documents (original, supplement,
 * return, transfer) with their status and the person on each side. Copies
 * the Purchase Invoices list; a row opens the document, where the
 * resulting budget by element sits under the lines.
 */
export const dynamic = 'force-dynamic';

export default async function BudgetsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/budgets')) notFound();
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
    return <Denied object={page('project_budgets')} />;
  }
  const params = await searchParams;
  const projectParam = typeof params.project === 'string' ? params.project : '';
  const statusParam = typeof params.status === 'string' ? params.status : '';
  const kindParam = typeof params.kind === 'string' ? params.kind : '';
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;
  const { result, choices } = await withCurrentUser(async (tx) => ({
    result: await pb.budgetDocuments(tx, { projectCode: projectParam || null, status: statusParam || null, kind: kindParam || null, search: outcome.q, page: pageNo }),
    choices: (await ps.list(tx, { pageSize: 100 })).rows,
  }));
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', projectParam ? `project=${encodeURIComponent(projectParam)}` : '', statusParam ? `status=${statusParam}` : '', kindParam ? `kind=${kindParam}` : '', `page=${p}`]
      .filter(Boolean)
      .join('&');
  const mayCreate = can(principal, 'create', pb.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href={`/projects/budgets/new${projectParam ? `?project=${encodeURIComponent(projectParam)}` : ''}`}>
            {x('new_budget')}
          </Link>
        ) : undefined
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/projects/budgets" />}
      subtitle={x('budgets_subtitle')}
      title={page('project_budgets')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="budgets-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="budgets-list-title">
            <span>{page('project_budgets')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects/budgets" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select defaultValue={projectParam} emptyLabel={x('all_projects')} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} />
              <Select defaultValue={kindParam} emptyLabel={x('kind_all')} label={x('kind')} name="kind" options={['original', 'supplement', 'return', 'transfer'].map((value) => ({ value, label: x(`kind_${value}`) }))} />
              <Select defaultValue={statusParam} emptyLabel={x('status_all')} label={column('status')} name="status" options={['draft', 'submitted', 'approved', 'rejected'].map((value) => ({ value, label: status(value) }))} />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="budgets-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{x('project')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('description')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('lines')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                  <th scope="col">{x('raised_by')}</th>
                  <th scope="col">{x('approved_by')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={10}>
                      {x('no_budgets')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.documentNo}>
                    <td>
                      <Link className={s.sapLink} href={`/projects/budgets/${encodeURIComponent(row.documentNo)}`}>
                        <bdi dir="ltr">{row.documentNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.projectCode)}`}>
                        <bdi dir="ltr">{row.projectCode}</bdi>
                      </Link>{' '}
                      <bdi dir="auto">{row.projectName}</bdi>
                    </td>
                    <td>{x(`kind_${row.kind}`)}</td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.raisedOn, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.description}</bdi>
                    </td>
                    <td className={s.sapNum}>{row.lines}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.totalIqd)}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.raisedBy}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.approvedBy ?? '—'}</bdi>
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
            <Pagination count={pages} current={result.page} hrefFor={(p) => `/projects/budgets?${query(p)}`} labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
