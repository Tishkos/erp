import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import {
  AdminPage,
  FilterRow,
  Flash,
  Form,
  ListToolbar,
  Select,
  Submit,
  SubmitRow,
  admin as s,
} from '@/components/admin';
import { Pagination } from '@/components/ui';
import { NewRecordDialog } from '@/components/admin/dialog';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as applications from '@/server/services/payment-applications';
import { startApplication } from './actions';
import { STATUS_CHIP, statusKey } from './status';

/**
 * Payment applications — REQ-AP-001 §21.7.
 *
 * The company's requests to its banks and cashier, longest-waiting first: a
 * SWIFT that went on the 10th and has not come back is the row a treasury
 * accountant opens the screen to find. Drawn as Purchase Invoices is: the
 * module's tabs, one register window, the search box and one filter, status
 * chips in the last column.
 */
export const dynamic = 'force-dynamic';

const VIEWS: Readonly<Record<string, readonly string[]>> = {
  to_approve: ['draft'],
  to_send: ['approved'],
  waiting: ['sent'],
  paid: ['confirmed', 'debited'],
  closed: ['rejected', 'cancelled'],
};

export default async function PaymentApplicationsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/payment-applications')) notFound();

  const [t, admin, page, locale, context, outcome] = await Promise.all([
    getTranslations('admin.payment_applications'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', applications.PERMISSION_OBJECT)) {
    return <Denied object={page('payment_applications')} />;
  }
  const mayCreate = can(principal, 'create', applications.PERMISSION_OBJECT);

  const params = await searchParams;
  const viewParam = typeof params.view === 'string' ? params.view : '';

  const inView = Object.hasOwn(VIEWS, viewParam) ? VIEWS[viewParam] : undefined;
  const { result, imports } = await withCurrentUser(async (tx) => ({
    result: await applications.listForScreen(tx, { statuses: inView ?? null, search: outcome.q, page: outcome.page }),
    imports: mayCreate ? await applications.payableImports(tx) : [],
  }));
  const shown = result.rows;
  const query = (p: number) =>
    [outcome.q ? `q=${encodeURIComponent(outcome.q)}` : '', inView ? `view=${viewParam}` : '', `page=${p}`].filter(Boolean).join('&');

  const statusLabel = (status: string, kind: string) => t(statusKey(status, kind));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <NewRecordDialog buttonLabel={t('new')} closeLabel={admin('close')} title={t('new')}>
            <p className="muted">{t('new_note')}</p>
            <Form action={startApplication}>
              <Select
                label={t('import')}
                name="payable_no"
                options={imports.map((row) => ({
                  value: row.payableNo,
                  label: `${row.payableNo} · ${row.reference} · ${row.supplierName}`,
                }))}
                required
              />
              <SubmitRow>
                <Submit label={t('continue')} />
              </SubmitRow>
            </Form>
          </NewRecordDialog>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      tabs={<SectionTabs route="/payables/payment-applications" />}
      subtitle={t('subtitle')}
      title={page('payment_applications')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />

      <section aria-labelledby="payapp-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payapp-list-title">
            <span>{page('payment_applications')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: result.total })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/payment-applications"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: result.total })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />

          <form className={s.filterBar} method="get">
            <FilterRow>
              <Select
                defaultValue={viewParam}
                emptyLabel={t('view_all')}
                label={t('view')}
                name="view"
                options={Object.keys(VIEWS).map((key) => ({ value: key, label: t(`view_${key}`) }))}
              />
              <SubmitRow>
                <Submit label={t('filter')} />
              </SubmitRow>
            </FilterRow>
          </form>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="payapp-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('col_import')}</th>
                  <th scope="col">{t('col_supplier')}</th>
                  <th scope="col">{t('col_method')}</th>
                  <th scope="col">{t('col_account')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_amount')}
                  </th>
                  <th scope="col">{t('col_application_date')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_days_waiting')}
                  </th>
                  <th scope="col">{t('col_status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/payment-applications/${encodeURIComponent(row.applicationNo)}`}
                      >
                        <bdi dir="ltr">{row.applicationNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <Link className={s.sapLink} href={`/payables/${encodeURIComponent(row.payableNo)}`}>
                        <bdi dir="ltr">{row.payableNo}</bdi>
                      </Link>
                      <div className="muted">
                        <bdi dir="ltr">{row.reference}</bdi>
                      </div>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.methodName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.accountCode}</bdi>
                      {row.bankName ? (
                        <div className="muted">
                          <bdi dir="auto">{row.bankName}</bdi>
                        </div>
                      ) : null}
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{formatMoney(row.amountTxn, row.currency, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">
                        {row.applicationDate ? formatBusinessDate(row.applicationDate, locale as Locale) : '—'}
                      </bdi>
                    </td>
                    <td className={s.sapNum}>{row.daysWaiting ?? '—'}</td>
                    <td>
                      <span
                        className={`status status--${STATUS_CHIP[row.status] ?? 'draft'} ${s.sapRegisterStatus}`}
                        data-status={STATUS_CHIP[row.status] ?? 'draft'}
                      >
                        {statusLabel(row.status, row.methodKind)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination count={result.pages} current={result.page} hrefFor={(p) => `/payables/payment-applications?${query(p)}`} labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
