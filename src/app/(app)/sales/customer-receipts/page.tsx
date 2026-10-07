import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ProfileLink } from '@/components/admin/profile-link';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/customer-receipt';
import { SavedViewsMenu } from '@/components/saved-views/saved-views-menu';
import { savedViewsFor } from '@/server/saved-views-gate';
import { RegisterFilter } from '@/components/admin/register-filter';
import { applyRegisterDates, registerDatesOf, registerDatesParams } from '@/server/domain/register-dates';

/**
 * Receipts — Operations build, block 6.
 *
 *   Receipts   Customer Name; Customer Code; Date; Bank/Cash Name; Bank/Cash
 *              Code; Amount; Reference; Customer Invoice.
 *   Journal    Bank or Cash Dr. / Accounts Receivable Cr.
 *
 * Every column the sponsor names except the invoice, which is not one value —
 * a receipt can be spread across several, and partly — so it lives on the
 * receipt's own page rather than being squeezed into a cell here.
 *
 * The customer may be blank. §16 allows money to arrive before anybody knows
 * whose it is, and a receipt that guessed would settle the wrong person's debt.
 */
export const dynamic = 'force-dynamic';

export default async function ReceiptsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/customer-receipts')) notFound();

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
  if (!can(principal, 'view', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('customer_receipts')} />;
  }
  const mayCreate = can(principal, 'create', receipts.PERMISSION_OBJECT);

  // The person's saved views of this screen — and, on a bare arrival, their default one.
  const saved = await savedViewsFor('sales.receipts', searchParams);
  const rows = await withCurrentUser((tx) => receipts.list(tx));
  // The Filter's window of receipt dates and the order, over the whole register — newest first unless asked.
  const dates = registerDatesOf(await searchParams);
  const shown = applyRegisterDates(
    rows.filter((row) => matches(row, outcome.q)),
    (row) => row.receiptDate,
    dates,
    (row) => row.receiptNo,
  );
  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/sales/customer-receipts/new">
            {t('customer_receipts.new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/sales/customer-receipts" />}
      subtitle={t('customer_receipts.subtitle')}
      title={t('customer_receipts.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="rec-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="rec-list-title">
            <span>{t('customer_receipts.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/sales/customer-receipts"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            hidden={registerDatesParams(dates)}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          >
            <RegisterFilter dates={dates} keep={{ q: outcome.q }} path="/sales/customer-receipts" />
            <SavedViewsMenu state={saved} />
          </ListToolbar>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="rec-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('customer_code')}</th>
                  <th scope="col">{column('customer_name')}</th>
                  <th scope="col">{column('bank_code')}</th>
                  <th scope="col">{column('bank_name')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('customer_receipts.amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('customer_receipts.allocated')}
                  </th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={9}>
                      {t('customer_receipts.none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/sales/customer-receipts/${encodeURIComponent(row.receiptNo)}`}
                      >
                        <bdi dir="ltr">{row.receiptNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.receiptDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <ProfileLink code={row.customerCode} kind="customer">{row.customerCode ?? '—'}</ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.customerCode} dir="auto" kind="customer">{row.customerName ?? '—'}</ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.bankCode} kind={row.bankType === 'cash' ? 'cash_account' : 'bank_account'}>
                        {row.bankCode ?? '—'}
                      </ProfileLink>
                    </td>
                    <td>
                      <ProfileLink code={row.bankCode} dir="auto" kind={row.bankType === 'cash' ? 'cash_account' : 'bank_account'}>
                        {row.bankName ?? '—'}
                      </ProfileLink>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.allocatedIqd)}</bdi>
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
