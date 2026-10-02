import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Pagination } from '@/components/ui';
import { formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { nextMonth } from '@/server/domain/advances';
import { businessToday } from '@/server/domain/business-date';
import { requireContext, withCurrentUser } from '@/server/session';
import * as advances from '@/server/services/employee-advances';
import { createAdvance } from './actions';

/**
 * Advances & Loans — REQ-HR-001 Stage HR-4 (§10). Copies the Purchase
 * Invoices list: the register, the New dialog, the View filter, paging.
 * Requests waiting for somebody come first.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  submitted: 'submitted',
  endorsed: 'submitted',
  approved: 'approved',
  paid: 'posted',
  settled: 'settled',
  refused: 'rejected',
  cancelled: 'cancelled',
};

export default async function AdvancesPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/advances')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.advances'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', advances.PERMISSION_OBJECT)) return <Denied object={page('employee_advances')} />;
  const mayCreate = can(principal, 'create', advances.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const { result, people } = await withCurrentUser(async (tx) => ({
    result: await advances.listForScreen(tx, { view: viewParam || null, search: outcome.q, page: outcome.page }),
    people: mayCreate ? await advances.borrowers(tx) : [],
  }));
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  // The document statuses read as the invoices' do; "endorsed" and "paid" are the advance's own.
  const statusLabel = (value: string) => (value === 'endorsed' || value === 'paid' ? x(`status_${value}`) : statusOf(value === 'refused' ? 'rejected' : value));
  const query = (p: number) => new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), page: String(p) }).toString();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
            <Form action={createAdvance}>
              <Grid>
                <Select label={x('employee')} name="employee_id" options={people.map((p) => ({ value: p.id, label: `${p.employeeNo} · ${p.fullNameEn}` }))} required />
                <Select
                  defaultValue="advance"
                  label={x('kind')}
                  name="kind"
                  options={[
                    { value: 'advance', label: x('kind_advance') },
                    { value: 'loan', label: x('kind_loan') },
                  ]}
                  required
                />
                <Field hint={x('amount_hint')} label={x('amount')} name="amount" required />
                <Field defaultValue="1" hint={x('instalments_hint')} label={x('instalments')} name="instalments" />
                <Field defaultValue={nextMonth(businessToday()).slice(0, 7)} hint={x('first_month_hint')} label={x('first_month')} name="first_recovery_month" />
                <Field label={x('reason')} name="reason" required wide />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/advances" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="advances-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="advances-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/advances"
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
                options={['submitted', 'endorsed', 'approved', 'paid', 'settled', 'draft', 'refused', 'cancelled'].map((value) => ({ value, label: statusLabel(value) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="advances-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('employee')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('instalments')}
                  </th>
                  <th scope="col">{x('first_month')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('recovered')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {x('owed')}
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
                      <Link className={s.sapLink} href={`/hr/advances/${encodeURIComponent(row.advanceNo)}`}>
                        <bdi dir="ltr">{row.advanceNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.employeeNo}</bdi>
                      </span>
                    </td>
                    <td>{x(`kind_${row.kind}`)}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.instalments}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.firstMonth}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(row.recoveredIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{iqd(row.owedIqd)}</bdi>
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
            hrefFor={(p) => `/hr/advances?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
