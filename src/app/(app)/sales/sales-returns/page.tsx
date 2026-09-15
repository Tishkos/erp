import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, ListToolbar, admin as s, matches } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as sr from '@/server/services/sales-return';

/**
 * Sales Returns — Operations build, block 9.
 *
 * The register carries the offset each return chose, because that is the
 * difference between reducing what a customer owes and handing their money
 * back, and it is not visible anywhere else in a list.
 */
export const dynamic = 'force-dynamic';

export default async function SalesReturnsPage({ searchParams }: { searchParams: SearchParams }) {
  if (!visibleRoute('/sales/sales-returns')) notFound();

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
  if (!can(principal, 'view', sr.PERMISSION_OBJECT)) {
    return <Denied object={page('sales_returns')} />;
  }
  const mayCreate = can(principal, 'create', sr.PERMISSION_OBJECT);

  const rows = await withCurrentUser((tx) => sr.list(tx));
  const shown = rows.filter((row) => matches(row, outcome.q));

  return (
    <AdminPage
      actions={
        mayCreate ? (
          <Link className="action action--primary" href="/sales/sales-returns/new">
            {t('sales_returns.new')}
          </Link>
        ) : null
      }
      back={{ href: '/', label: t('dashboard_label') }}
      tabs={<SectionTabs route="/sales/sales-returns" />}
      subtitle={t('sales_returns.subtitle')}
      title={t('sales_returns.title')}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <section aria-labelledby="sr-list-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="sr-list-title">
            <span>{t('sales_returns.title')}</span>
            <span className={s.sapTitleMeta}>{t('rows_shown', { count: shown.length })}</span>
          </h2>

          <ListToolbar
            clearHref="/sales/sales-returns"
            clearLabel={t('clear_search')}
            countLabel={t('rows_shown', { count: shown.length })}
            placeholder={t('search_placeholder')}
            q={outcome.q}
            searchLabel={t('search')}
          />

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="sr-list-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{column('reference')}</th>
                  <th scope="col">{column('posting_date')}</th>
                  <th scope="col">{column('customer_code')}</th>
                  <th scope="col">{column('customer_name')}</th>
                  <th scope="col">{t('sales_returns.invoice')}</th>
                  <th scope="col">{t('sales_returns.offset')}</th>
                  <th scope="col">{column('status')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={7}>
                      {t('sales_returns.none')}
                    </td>
                  </tr>
                ) : null}
                {shown.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/sales/sales-returns/${encodeURIComponent(row.returnNo)}`}
                      >
                        <bdi dir="ltr">{row.returnNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.requestedOn, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.customerCode ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="auto">{row.customerName ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{row.invoiceNo ?? '—'}</bdi>
                    </td>
                    <td>
                      {row.offsetKind === 'bank'
                        ? t('sales_returns.offset_bank')
                        : t('sales_returns.offset_receivable')}
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
