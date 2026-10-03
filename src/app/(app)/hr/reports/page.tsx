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
import { BUILD, HR_REPORTS, HR_REPORT_KEY, HR_REPORT_OBJECT, type HrReport } from '@/server/print/hr-reports';
import { messagesFor } from '@/server/print/i18n';
import type { Cell, Column } from '@/server/print/model';
import { requireContext, withCurrentUser } from '@/server/session';

/**
 * HR Reports — REQ-HR-001 Stage HR-6. Copies the Project System's Reports
 * screen (itself the Warehouses Report's manner): the report's filters on one
 * line and its table with the totals row, the Print / Export menu in the
 * header. The table is drawn from the very model the PDF and the workbook
 * are drawn from. A report under a grant the reader lacks (the payroll
 * register, the advances) is not offered.
 */
export const dynamic = 'force-dynamic';

export default async function HrReportsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/reports')) notFound();
  const [t, x, page, list, locale, context, params] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.hr_reports'),
    getTranslations('page'),
    getTranslations('list'),
    getLocale(),
    requireContext(),
    searchParams,
  ]);
  const { principal } = context;
  if (!can(principal, 'view', 'hr_report')) return <Denied object={page('hr_reports')} />;
  const offered = HR_REPORTS.filter((r) => can(principal, 'view', HR_REPORT_OBJECT[r]));
  const report: HrReport = offered.includes(params.report as HrReport) ? (params.report as HrReport) : 'headcount';
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : '');
  const today = businessToday();
  const to = /^\d{4}-\d{2}-\d{2}$/.test(one('to')) ? one('to') : today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(one('from')) ? one('from') : `${to.slice(0, 4)}-01-01`;
  const year = /^\d{4}$/.test(one('year')) ? one('year') : today.slice(0, 4);
  const month = /^\d{4}-\d{2}$/.test(one('month')) ? one('month') : today.slice(0, 7);
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(one('as_of')) ? one('as_of') : today;
  const filters: Record<HrReport, Record<string, string>> = {
    headcount: { from, to },
    leave: { year },
    payroll: { month },
    advances: { as_of: asOf },
  };

  const built = await withCurrentUser((tx) =>
    BUILD[report]({ tx, principal, branchCode: context.scope.branchCode, locale: locale as Locale, m: messagesFor(locale as Locale) }, new URLSearchParams(filters[report])),
  );
  const table = built?.model.tables[0] ?? null;

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
      actions={<ExportMenu exportKey={HR_REPORT_KEY[report]} query={{ report, ...filters[report] }} />}
      back={{ href: '/', label: t('dashboard_label') }}
      subtitle={x('subtitle')}
      tabs={<SectionTabs route="/hr/reports" />}
      title={page('hr_reports')}
      variant="sap"
    >
      <form method="get">
        <FilterRow>
          <Select defaultValue={report} label={x('report')} name="report" options={offered.map((r) => ({ value: r, label: x(`report_${r}`) }))} required />
          {report === 'headcount' ? <Field defaultValue={from} label={x('from')} name="from" type="date" /> : null}
          {report === 'headcount' ? <Field defaultValue={to} label={x('to')} name="to" type="date" /> : null}
          {report === 'leave' ? <Field defaultValue={year} label={x('year')} max={2100} min={2000} name="year" type="number" /> : null}
          {report === 'payroll' ? <Field defaultValue={month} hint={x('month_hint')} label={x('month')} name="month" /> : null}
          {report === 'advances' ? <Field defaultValue={asOf} label={x('as_of')} name="as_of" type="date" /> : null}
          <SubmitRow>
            <Submit label={list('search')} />
          </SubmitRow>
        </FilterRow>
      </form>

      <div className={s.sapTableWrap}>
        <table aria-label={built?.model.title ?? page('hr_reports')} className={`${s.sapTable} ${s.sapReportTable}`}>
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
                  {table?.empty ?? x('none')}
                </td>
              </tr>
            ) : (
              table.rows.map((row, index) => (
                <tr key={index}>
                  {table.columns.map((c) => (
                    <td className={numeric(c) ? s.sapNum : undefined} key={c.key}>
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
