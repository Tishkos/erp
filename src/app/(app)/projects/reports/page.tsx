import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import type { SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { messagesFor } from '@/server/print/i18n';
import type { Column, Cell } from '@/server/print/model';
import { BUILD, PROJECT_REPORTS, PROJECT_REPORT_KEY, type ProjectReport } from '@/server/print/project-reports';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ps from '@/server/services/project-system';

/**
 * Reports — REQ-PM-001 §13, PM13. Copies the Warehouses Report: the report's
 * filters on one line (the project, which of the four reports, the day or
 * the period) and the report table with its totals row, the Print / Export
 * menu in the header. The table is drawn from the very model the PDF and the
 * workbook are drawn from, so the screen and the copy state one set of
 * figures.
 */
export const dynamic = 'force-dynamic';

export default async function ProjectReportsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/projects/reports')) notFound();
  const [t, x, page, list, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.projects'),
    getTranslations('page'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', 'project')) {
    return <Denied object={page('project_reports')} />;
  }
  const report: ProjectReport = PROJECT_REPORTS.includes(params.report as ProjectReport) ? (params.report as ProjectReport) : 'cost';
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(one('as_of')) ? one('as_of') : businessToday();

  const { choices, code, built } = await withCurrentUser(async (tx) => {
    const choices = (await ps.list(tx, { pageSize: 100 })).rows;
    const code = one('project') || choices.find((c) => c.status === 'active')?.code || choices[0]?.code || '';
    if (!code) return { choices, code, built: null };
    const query = new URLSearchParams({ project: code, as_of: asOf, ...(one('from') ? { from: one('from') } : {}), ...(one('to') ? { to: one('to') } : {}) });
    const built = await BUILD[report]({ tx, principal, branchCode: context.scope.branchCode, locale: locale as Locale, m: messagesFor(locale as Locale) }, query);
    return { choices, code, built };
  });
  const table = built?.model.tables[0] ?? null;
  const exportQuery = { project: code, report, as_of: asOf, from: one('from') || undefined, to: one('to') || undefined };

  const cell = (column: Column, value: Cell) => {
    if (value === null || value === '') return '—';
    if (column.kind === 'money') return <bdi dir="ltr">{formatMoney(value, 'IQD', locale as Locale)}</bdi>;
    if (column.kind === 'date') return <bdi dir="ltr">{formatBusinessDate(value, locale as Locale)}</bdi>;
    if (column.kind === 'code' || column.kind === 'quantity') return <bdi dir="ltr">{value}</bdi>;
    return <bdi dir="auto">{value}</bdi>;
  };
  const numeric = (column: Column) => column.kind === 'money' || column.kind === 'quantity';

  return (
    <AdminPage
      actions={code ? <ExportMenu exportKey={PROJECT_REPORT_KEY[report]} query={exportQuery} /> : undefined}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={x('reports_subtitle')}
      tabs={<SectionTabs route="/projects/reports" />}
      title={page('project_reports')}
      variant="sap"
    >
      <form method="get">
        <FilterRow>
          <Select defaultValue={code} label={x('project')} name="project" options={choices.map((c) => ({ value: c.code, label: `${c.code} · ${c.name}` }))} required />
          <Select defaultValue={report} label={x('report')} name="report" options={PROJECT_REPORTS.map((r) => ({ value: r, label: x(`report_${r}`) }))} required />
          <Field defaultValue={asOf} label={x('as_of_label')} name="as_of" type="date" />
          {report === 'lines' ? <Field defaultValue={one('from')} label={x('from_date')} name="from" type="date" /> : null}
          {report === 'lines' ? <Field defaultValue={one('to')} label={x('to_date')} name="to" type="date" /> : null}
          <SubmitRow>
            <Submit label={list('search')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <div className={s.sapTableWrap}>
        <table aria-label={built?.model.title ?? page('project_reports')} className={`${s.sapTable} ${s.sapReportTable}`}>
          <thead>
            <tr>
              {(table?.columns ?? []).map((c) => (
                <th className={numeric(c) ? s.sapNum : undefined} key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {!table || table.rows.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={Math.max(1, table?.columns.length ?? 1)}>
                  {table?.empty ?? x('no_projects')}
                </td>
              </tr>
            ) : (
              table.rows.map((row, index) => (
                <tr className={row.tone === 'header' ? s.sapSectionRow : undefined} key={index}>
                  {table.columns.map((c, i) => (
                    <td className={numeric(c) ? s.sapNum : undefined} key={c.key}>
                      {i === 0 && row.depth ? <bdi dir="ltr">{'· '.repeat(row.depth)}</bdi> : null}
                      {cell(c, row.cells[c.key] ?? null)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
          {table?.totals && table.rows.length > 0 ? (
            <tfoot>
              <tr className={s.sapTotalRow}>
                {table.columns.map((c, i) => (
                  <td className={numeric(c) ? s.sapNum : undefined} key={c.key}>
                    {i === 0 ? table.totals!.label : table.totals!.cells[c.key] !== undefined ? cell(c, table.totals!.cells[c.key] ?? null) : null}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
    </AdminPage>
  );
}
