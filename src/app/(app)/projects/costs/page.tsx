import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, Field, FilterRow, Flash, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { toDecimalString } from '@/server/domain/money';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as pe from '@/server/services/project-execution';
import * as ps from '@/server/services/project-system';

/**
 * Project Costs — REQ-PM-001 §13, PM7: the line items — every cost row with
 * its element, cost code, document and journal — filtered by project,
 * element, cost code and period, their sum beside the journal's figure for
 * the same project. Copies the Purchase Invoices list.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectCostsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/costs')) notFound();
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
  if (!can(principal, 'view', pe.PERMISSION_OBJECT)) {
    return <Denied object={page('project_costs')} />;
  }
  const params = await searchParams;
  const str = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const projectParam = str('project');
  const wbsParam = str('wbs');
  const costParam = str('cost_code');
  const fromParam = str('from');
  const toParam = str('to');
  const pageNo = Number(params.page) > 0 ? Number(params.page) : 1;

  const { result, choices, codes, journal } = await withCurrentUser(async (tx) => {
    const result = await pe.lineItems(tx, { projectCode: projectParam || null, wbsCode: wbsParam || null, costCode: costParam || null, from: fromParam || null, to: toParam || null, search: outcome.q, page: pageNo });
    return {
      result,
      choices: (await ps.list(tx, { pageSize: 100 })).rows,
      codes: await ps.costCodes(tx),
      journal: projectParam && !wbsParam && !costParam && !outcome.q ? await pe.journalTotal(tx, projectParam, { from: fromParam || null, to: toParam || null }) : null,
    };
  });
  const money = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', projectParam ? `project=${encodeURIComponent(projectParam)}` : '', wbsParam ? `wbs=${encodeURIComponent(wbsParam)}` : '', costParam ? `cost_code=${costParam}` : '', fromParam ? `from=${fromParam}` : '', toParam ? `to=${toParam}` : '', `page=${p}`]
      .filter(Boolean)
      .join('&');
  const costName = (c: { nameEn: string; nameAr: string | null }) => (locale === 'ar' && c.nameAr ? c.nameAr : c.nameEn);
  const sourceHref = (row: (typeof result.rows)[number]) =>
    row.sourceType === 'ap_invoice' && row.invoiceNo ? `/payables/invoices/${encodeURIComponent(row.invoiceNo)}` : row.sourceType === 'project_material_issue' && row.sourceId ? `/projects/material-issues/${encodeURIComponent(row.sourceId)}` : null;
  const sourceLabel = (row: (typeof result.rows)[number]) => (row.sourceType === 'ap_invoice' ? (row.invoiceNo ?? '—') : (row.sourceId ?? '—'));

  return (
    <AdminPage back={{ href: '/', label: t('dashboard_label') }} tabs={<SectionTabs route="/projects/costs" />} subtitle={x('costs_subtitle')} title={page('project_costs')} variant="sap">
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="costs-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="costs-list-title">
            <span>{page('project_costs')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar clearHref="/projects/costs" clearLabel={t('clear_search')} countLabel={t('rows_shown', { count: result.total })} placeholder={t('search_placeholder')} q={outcome.q} searchLabel={t('search')} />

          <form className={s.filterBar} method="get">
            {outcome.q ? <input name="q" type="hidden" value={outcome.q} /> : null}
            <FilterRow>
              <Select defaultValue={projectParam} emptyLabel={x('all_projects')} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} />
              <Field defaultValue={wbsParam} hint={x('wbs_filter_hint')} label={x('element')} name="wbs" />
              <Select defaultValue={costParam} emptyLabel={x('all_cost_codes')} label={x('cost_code')} name="cost_code" options={codes.map((c) => ({ value: c.code, label: `${c.code} · ${costName(c)}` }))} />
              <Field defaultValue={fromParam} label={x('from_date')} name="from" type="date" />
              <Field defaultValue={toParam} label={x('to_date')} name="to" type="date" />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          {journal !== null ? (
            <p className={s.sapNote}>
              {x('journal_reconciliation', { items: money(result.totalIqd), journal: money(toDecimalString(journal, 4n)) })}
              {toDecimalString(journal, 4n) === result.totalIqd ? ` · ${x('reconciled')}` : ` · ${x('stock_at_issue_note')}`}
            </p>
          ) : null}

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="costs-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{x('project')}</th>
                  <th scope="col">{x('element')}</th>
                  <th scope="col">{x('cost_code')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{column('description')}</th>
                  <th scope="col">{x('document')}</th>
                  <th scope="col">{x('journal')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('no_costs')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.incurredOn, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/projects/${encodeURIComponent(row.projectCode)}`}>
                        <bdi dir="ltr">{row.projectCode}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.wbsCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.costCode}</bdi>
                    </td>
                    <td>{x.has(`cost_kind_${row.kind}`) ? x(`cost_kind_${row.kind}`) : row.kind.replace(/_/g, ' ')}</td>
                    <td>
                      <bdi dir="auto">{row.description}</bdi>
                    </td>
                    <td>
                      {sourceHref(row) ? (
                        <Link className={s.sapLink} href={sourceHref(row)!}>
                          <bdi dir="ltr">{sourceLabel(row)}</bdi>
                        </Link>
                      ) : (
                        <bdi dir="ltr">{sourceLabel(row)}</bdi>
                      )}
                    </td>
                    <td>
                      <bdi dir="ltr">{row.journalNo ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                  </tr>
                ))}
                {result.rows.length > 0 ? (
                  <tr>
                    <td colSpan={8}>{x('total')}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(result.totalIqd)}</bdi>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {pages > 1 ? (
            <Pagination count={pages} current={result.page} hrefFor={(p) => `/projects/costs?${query(p)}`} labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
