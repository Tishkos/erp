import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payments from '@/server/services/customer-payment';

/**
 * Customer Payments (0428) — the register, copying Customer Receipts': the number, the date, the
 * customer, the account it left, the amount in that account's currency and in dinars, the status.
 * Searched by number, customer, purpose or reference.
 */
export const dynamic = 'force-dynamic';

export default async function CustomerPaymentsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-payments')) notFound();
  const [t, admin, page, column, status, locale, context, outcome] = await Promise.all([
    getTranslations('admin.money_out'),
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
  ]);
  const { principal } = context;
  if (!can(principal, 'view', payments.PERMISSION_OBJECT)) return <Denied object={page('customer_payments')} />;

  const rows = await withCurrentUser((tx) => payments.list(tx, { search: outcome.q }));
  const money = (value: string, currency: string) => formatMoney(value, currency, locale as Locale);

  return (
    <AdminPage
      actions={
        can(principal, 'create', payments.PERMISSION_OBJECT) ? (
          <Link className="action action--primary" href="/sales/customer-payments/new">
            {t('customer_new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: admin('dashboard_label') }}
      subtitle={t('customer_subtitle')}
      tabs={<SectionTabs route="/sales/customer-payments" />}
      title={t('customer_title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={admin('error_title')} saved={outcome.saved} savedLabel={admin('saved')} />
      <section aria-labelledby="cp-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="cp-list-title">
            <span>{t('customer_title')}</span>
            <span className={s.sapTitleMeta}>{admin('rows_shown', { count: rows.length })}</span>
          </h2>
          <ListToolbar
            clearHref="/sales/customer-payments"
            clearLabel={admin('clear_search')}
            countLabel={admin('rows_shown', { count: rows.length })}
            placeholder={admin('search_placeholder')}
            q={outcome.q}
            searchLabel={admin('search')}
          />
          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="cp-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('document_no')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('customer_code')}</th>
                  <th scope="col">{column('customer_name')}</th>
                  <th scope="col">{column('bank_code')}</th>
                  <th scope="col">{t('purpose')}</th>
                  <th className={s.sapNum} scope="col">{t('amount')}</th>
                  <th className={s.sapNum} scope="col">{t('amount_iqd')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('customer_none')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link className={s.sapLink} href={`/sales/customer-payments/${encodeURIComponent(row.paymentNo)}`}>
                        <bdi dir="ltr">{row.paymentNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.paymentDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.customerCode} kind="customer" />
                    </td>
                    <td>
                      <ProfileLink code={row.customerCode} dir="auto" kind="customer">
                        {row.customerName}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.accountCode} kind={row.accountType === 'cash' ? 'cash_account' : 'bank_account'} />
                    </td>
                    <td>
                      <bdi dir="auto">{row.purpose}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amount, row.currency)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd, 'IQD')}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status} ${s.sapRegisterStatus}`} data-status={row.status}>
                        {status.has(row.status) ? status(row.status) : row.status}
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
