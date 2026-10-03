import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Pagination } from '@/components/ui';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payroll from '@/server/services/payroll';
import { createPayrollRun } from './actions';

/**
 * Payroll — REQ-HR-001 Stage HR-3 (§9). Copies the Purchase Invoices list:
 * the register of runs, the New dialog (a branch and a month), the View
 * filter, paging. Runs waiting for somebody come first.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  submitted: 'submitted',
  approved: 'approved',
  posted: 'posted',
  paid: 'settled',
  reversed: 'reversed',
  cancelled: 'cancelled',
};

export default async function PayrollPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/payroll')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.payroll'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', payroll.PERMISSION_OBJECT)) return <Denied object={page('payroll')} />;
  const mayCreate = can(principal, 'create', payroll.PERMISSION_OBJECT) && can(principal, 'view', 'employee_compensation');

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const result = await withCurrentUser((tx) => payroll.listForScreen(tx, { view: viewParam || null, search: outcome.q, page: outcome.page }));
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  // The document statuses read as the invoices' do; only "paid" is the payroll's own.
  const statusLabel = (value: string) => (value === 'paid' ? x('status_paid') : statusOf(value));
  const query = (p: number) => new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), page: String(p) }).toString();
  const today = businessToday();
  // This month and the eleven before it: a month's pay is prepared once it has begun.
  const months = (() => {
    const [y, m] = today.slice(0, 7).split('-').map(Number) as [number, number];
    return Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7));
  })();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
            <Form action={createPayrollRun}>
              <Grid>
                <Select
                  defaultValue={context.scope.branchCode ?? principal.branchCodes[0] ?? ''}
                  label={column('branch')}
                  name="branch"
                  options={principal.branchCodes.map((code) => ({ value: code, label: code }))}
                  required
                />
                <Select defaultValue={months[0]} label={x('month')} name="month" options={months.map((m) => ({ value: m, label: m }))} required />
                <Field hint={x('pay_date_hint')} label={x('pay_date')} name="pay_date" type="date" />
                <Field label={x('note')} name="note" wide />
              </Grid>
              <SubmitRow>
                <Submit label={x('compute')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/payroll" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="payroll-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payroll-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/payroll"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={['submitted', 'approved', 'draft', 'posted', 'paid', 'reversed', 'cancelled'].map((value) => ({ value, label: statusLabel(value) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="payroll-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('branch')}</th>
                  <th scope="col">{x('month')}</th>
                  <th scope="col">{x('pay_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('employees')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('gross')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('deductions')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('net')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/payroll/${encodeURIComponent(row.runNo)}`}>
                        <bdi dir="ltr">{row.runNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.branchCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.month}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.payDate, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.employees}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(row.grossIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(row.deductionsIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(row.netIqd)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${STATUS_TONE[row.status] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={STATUS_TONE[row.status] ?? 'draft'}>
                        {statusLabel(row.status)}
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
            hrefFor={(p) => `/hr/payroll?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
