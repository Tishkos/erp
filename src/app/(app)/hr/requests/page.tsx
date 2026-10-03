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
import { LETTER_TYPES, REQUEST_KINDS } from '@/server/domain/hr-requests';
import { requireContext, withCurrentUser } from '@/server/session';
import * as requests from '@/server/services/employee-requests';
import { createRequest } from './actions';

/**
 * Employee Requests — REQ-HR-001 Stage HR-6. Copies the Purchase Invoices
 * list: the register, the New dialog, the Kind and View filters, paging.
 * Requests waiting for somebody come first.
 */
export const dynamic = 'force-dynamic';

const STATUS_TONE: Readonly<Record<string, string>> = {
  draft: 'draft',
  submitted: 'submitted',
  approved: 'approved',
  refused: 'rejected',
  paid: 'posted',
  issued: 'posted',
  cancelled: 'cancelled',
};

export default async function RequestsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/hr/requests')) notFound();
  const [t, x, statusOf, page, column, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.requests'),
    getTranslations('status'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', requests.PERMISSION_OBJECT)) return <Denied object={page('employee_requests')} />;
  const mayCreate = can(principal, 'create', requests.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';
  const kindParam = typeof params.kind === 'string' ? params.kind : '';
  const { result, people } = await withCurrentUser(async (tx) => ({
    result: await requests.listForScreen(tx, { view: viewParam || null, kind: kindParam || null, search: outcome.q, page: outcome.page }),
    people: mayCreate ? await requests.people(tx, { principal }) : [],
  }));
  // The document statuses read as the invoices' do; "paid" and "issued" are the request's own.
  const statusLabel = (value: string) => (value === 'paid' || value === 'issued' ? x(`status_${value}`) : statusOf(value === 'refused' ? 'rejected' : value));
  const iqd = (value: string) => formatMoney(value, 'IQD', locale as Locale);
  const query = (p: number) =>
    new URLSearchParams({ ...(outcome.q ? { q: outcome.q } : {}), ...(viewParam ? { view: viewParam } : {}), ...(kindParam ? { kind: kindParam } : {}), page: String(p) }).toString();

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={x('new')} closeLabel={t('close')} openOnLoad={params.new === '1' && Boolean(outcome.error)} title={x('new')}>
            <Form action={createRequest}>
              <Grid>
                <Select defaultValue="expense_claim" label={x('kind')} name="request_kind" options={REQUEST_KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))} required />
                <Select label={x('employee')} name="employee_id" options={people.map((p) => ({ value: p.id, label: `${p.employeeNo} · ${p.fullNameEn}` }))} required />
                <Field label={x('subject')} name="subject" required wide />
                <Field label={x('details')} name="details" type="textarea" wide />
              </Grid>
              <p className={s.sapGridCaption}>{x('travel_caption')}</p>
              <Grid>
                <Field label={x('destination')} name="destination" />
                <Field label={x('travel_from')} name="travel_from" type="date" />
                <Field label={x('travel_to')} name="travel_to" type="date" />
                <Field hint={x('estimated_hint')} label={x('estimated')} name="estimated" />
              </Grid>
              <p className={s.sapGridCaption}>{x('letter_caption')}</p>
              <Grid>
                <Select defaultValue="employment" label={x('letter_type')} name="letter_type" options={LETTER_TYPES.map((type) => ({ value: type, label: x(`letter_type_${type}`) }))} />
                <Field label={x('addressed_to')} name="addressed_to" />
              </Grid>
              <SubmitRow>
                <Submit label={t('create')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/hr/requests" />}
      subtitle={x('subtitle')}
      title={x('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="requests-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="requests-list-title">
            <span>{x('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/hr/requests"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: result.total })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select defaultValue={kindParam} emptyLabel={x('kind_all')} label={x('kind')} name="kind" options={REQUEST_KINDS.map((kind) => ({ value: kind, label: x(`kind_${kind}`) }))} />
              <Select
                defaultValue={viewParam}
                emptyLabel={x('view_all')}
                label={x('view')}
                name="view"
                options={['submitted', 'approved', 'draft', 'paid', 'issued', 'refused', 'cancelled'].map((value) => ({ value, label: statusLabel(value) }))}
              />
              <SubmitRow>
                <Submit label={x('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="requests-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{x('kind')}</th>
                  <th scope="col">{x('employee')}</th>
                  <th scope="col">{x('subject')}</th>
                  <th scope="col">{x('asked_on')}</th>
                  <th className={s.sapNum} scope="col">
                    {column('amount')}
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
                      <Link className={s.sapLink} href={`/hr/requests/${encodeURIComponent(row.requestNo)}`}>
                        <bdi dir="ltr">{row.requestNo}</bdi>
                      </Link>
                    </td>
                    <td>{x(`kind_${row.kind}`)}</td>
                    <td>
                      <bdi dir="auto">{locale === 'ar' && row.fullNameAr ? row.fullNameAr : row.fullNameEn}</bdi>{' '}
                      <span className="muted">
                        <bdi dir="ltr">{row.employeeNo}</bdi>
                      </span>
                    </td>
                    <td>
                      <bdi dir="auto">{row.subject}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.askedOn, locale as Locale)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.kind === 'expense_claim' ? iqd(row.amountIqd) : row.kind === 'travel' && row.estimatedIqd ? iqd(row.estimatedIqd) : '—'}</bdi>
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
            hrefFor={(p) => `/hr/requests?${query(p)}`}
            labels={{ label: t('pagination'), previous: t('previous'), next: t('next'), page: (p) => t('page_n', { page: p }) }}
            locale={locale}
          />
        </div>
      </section>
    </AdminPage>
  );
}
