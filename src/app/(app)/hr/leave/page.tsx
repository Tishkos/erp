import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Checkbox, Field, FilterRow, Flash, Form, Grid, ListToolbar, Select, Submit, SubmitRow, admin as s } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Pagination } from '@/components/ui';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { businessToday } from '@/server/domain/business-date';
import { daysFrom, showDays } from '@/server/domain/hr-time';
import { requireContext, withCurrentUser } from '@/server/session';
import * as leave from '@/server/services/leave';
import { createLeaveRequest } from './actions';

/**
 * Leave Management — REQ-HR-001 Stage HR-2 (§8). Copies the Purchase
 * Invoices list: the register, the New dialog, the View filter, paging.
 * Requests waiting for a decision come first.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = { draft: 'draft', submitted: 'submitted', approved: 'approved', refused: 'rejected', cancelled: 'cancelled' };

export default async function LeavePage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/leave')) notFound();
  const [t, x, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.leave'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', leave.PERMISSION_OBJECT)) return <Denied object={page('leave')} />;
  const mayCreate = can(principal, 'create', leave.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const typeParam = typeof params.type === 'string' ? params.type : '';
  const { result, types, people } = await withCurrentUser(async (tx) => ({
    result: await leave.listForScreen(tx, { view: viewParam || null, leaveTypeCode: typeParam || null, search: outcome.q, page: outcome.page }),
    types: await leave.activeTypes(tx),
    people: mayCreate ? await leave.requestable(tx) : [],
  }));
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const typeLabel = (row: { typeName: string; typeNameAr: string | null }) => (locale === 'ar' && row.typeNameAr ? row.typeNameAr : row.typeName);
  const query = (p: number) =>
    new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), ...(typeParam ? { type: typeParam } : {}), page: String(p) }).toString();
  const today = businessToday();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
            <Form action={createLeaveRequest}>
              <Grid>
                <Select label={x('employee')} name="employee_id" options={people.map((p) => ({ value: p.id, label: `${p.employeeNo} · ${p.fullNameEn}` }))} required />
                <Select
                  label={x('leave_type')}
                  name="leave_type_code"
                  options={types.map((type) => ({ value: type.code, label: locale === 'ar' && type.nameAr ? type.nameAr : type.nameEn }))}
                  required
                />
                <Field defaultValue={today} label={x('from_date')} name="from_date" required type="date" />
                <Field defaultValue={today} label={x('to_date')} name="to_date" required type="date" />
              </Grid>
              <Checkbox label={x('half_day_start')} name="half_day_start" />
              <Checkbox label={x('half_day_end')} name="half_day_end" />
              <Grid>
                <Field label={x('reason')} name="reason" wide />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/leave" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="leave-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="leave-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/leave"
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
                options={['submitted', 'approved', 'draft', 'refused', 'cancelled'].map((value) => ({ value, label: x(`status_${value}`) }))}
              />
              <Select
                defaultValue={typeParam}
                emptyLabel={x('view_all')}
                label={x('leave_type')}
                name="type"
                options={types.map((type) => ({ value: type.code, label: locale === 'ar' && type.nameAr ? type.nameAr : type.nameEn }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="leave-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('employee')}</th>
                  <th scope="col">{x('leave_type')}</th>
                  <th scope="col">{x('from_date')}</th>
                  <th scope="col">{x('to_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('days')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {x('none')}
                    </td>
                  </tr>
                ) : null}
                {result.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/hr/leave/${encodeURIComponent(row.requestNo)}`}>
                        <bdi dir="ltr">{row.requestNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.employeeNo}</bdi>
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{typeLabel(row)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.fromDate)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.toDate)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{showDays(daysFrom(row.days))}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${STATUS_TONE[row.status] ?? 'draft'} ${s.sapRegisterStatus}`} data-status={STATUS_TONE[row.status] ?? 'draft'}>
                        {x(`status_${row.status}`)}
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
            hrefFor={(p) => `/hr/leave?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
