import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payments from '@/server/services/supplier-payment';

/**
 * Payments — Operations build, block 6.
 *
 *   Payments   Supplier Name; Supplier Code; Date; Bank/Cash Name; Bank/Cash
 *              Code; Amount; Reference; Supplier Invoice.
 *   Journal    Accounts Payable Dr. / Bank or Cash Cr.
 *
 * Every column the sponsor names except the invoice, which is not one value —
 * a payment can be spread across several, and partly — so it lives on the
 * payment's own page rather than being squeezed into a cell here.
 */
export const dynamic = 'force-dynamic';

export default async function PaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/payables/supplier-payments')) notFound();

  const [t, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);

  const { principal } = context;
  if (!can(principal, 'view', payments.PERMISSION_OBJECT)) {
    return <Denied object={page('supplier_payments')} />;
  }
  const mayCreate = can(principal, 'create', payments.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => payments.list(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/payables/supplier-payments/new">
            {t('supplier_payments.new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/payables/supplier-payments" />}
      subtitle={t('supplier_payments.subtitle')}
      title={t('supplier_payments.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="pay-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="pay-list-title">
            <span>{t('supplier_payments.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/payables/supplier-payments"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="pay-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('supplier_code')}</th>
                  <th scope="col">{column('supplier_name')}</th>
                  <th scope="col">{column('bank_code')}</th>
                  <th scope="col">{column('bank_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('supplier_payments.amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('supplier_payments.allocated')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('supplier_payments.none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/supplier-payments/${encodeURIComponent(row.paymentNo)}`}
                      >
                        <bdi dir="ltr">{row.paymentNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.paymentDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.supplierCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.bankCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.bankName ?? '—'}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.allocatedAmountIqd)}</bdi>
                    </td>
                    <td>
                      <span
                        className={`status status--${row.status} ${s.sapRegisterStatus}`}
                        data-status={row.status}
                      >
                        {status(row.status)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </AdminPage>
  );
}
