import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { Pagination } from '@/components/ui';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { SectionTabs } from '@/components/admin/section-tabs';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as orders from '@/server/services/purchase-order';

/**
 * Purchase orders — REQ-AP-001 §21.6. The documents existed since the
 * foundation; this is their screen: commitment, fulfilment and billing on
 * one row, and the payable each order answers to. Orders are raised from
 * the payable (D9) — there is no New here.
 */
export const dynamic = 'force-dynamic';

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/purchase-orders')) notFound();

  const [t, admin, page, locale, outcome, context] = await Promise.all([
    getTranslations('admin.payables_orders'),
    getTranslations('admin'),
    getTranslations('page'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);
  // REQ-HARDEN-001 H3 — the document statuses read one shared namespace, not a copy per screen.
  const statusOf = await getTranslations('status_order');

  if (!can(context.principal, 'view', orders.PERMISSION_OBJECT)) {
    return <Denied object={page('purchase_orders')} />;
  }

  const result = await withCurrentUser((tx) => orders.listForScreen(tx, { page: outcome.page }));
  const rows = result.rows;
  const query = (p: number) => `page=${p}`;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string | null) =>
    value ? formatBusinessDate(value, locale as Locale) : '—';

  return (
    <AdminPage
      back={{ href: '/payables', label: t('payables') }}
      subtitle={t('subtitle')}
      tabs={<SectionTabs route="/payables/purchase-orders" />}
      title={t('title')}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="orders-title" className={`${s.sapDoc} ${s.sapRegister}`}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="orders-title">
            <span>{t('title')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: result.total })}</span>
          </h2>

          <div className={`${s.sapTableWrap} ${s.sapRegisterTableWrap}`}>
            <table aria-labelledby="orders-title" className={`${s.sapTable} ${s.sapRegisterTable}`}>
              <thead>
                <tr>
                  <th scope="col">{t('col_no')}</th>
                  <th scope="col">{t('col_supplier')}</th>
                  <th scope="col">{t('col_date')}</th>
                  <th scope="col">{t('col_status')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('col_total')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_received')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('col_invoiced')}
                  </th>
                  <th scope="col">{t('col_payable')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={8}>
                      {t('none')}
                    </td>
                  </tr>
                ) : null}
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link
                        className={s.sapLink}
                        href={`/payables/purchase-orders/${encodeURIComponent(row.orderNo)}`}
                      >
                        <bdi dir="ltr">{row.orderNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="auto">{row.supplierName}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{day(row.orderDate)}</bdi>
                    </td>
                    <td>
                      <span
                        className="status"
                        data-status={
                          row.status === 'approved' || row.status === 'partially_executed'
                            ? 'approved'
                            : row.status === 'cancelled'
                              ? 'cancelled'
                              : row.status
                        }
                      >
                        {statusOf(row.status)}
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.totalIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.receivedShare}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{row.invoicedShare}</bdi>
                    </td>
                    <td>
                      {row.payableNo ? (
                        <Link
                          className={s.sapLink}
                          href={`/payables/${encodeURIComponent(row.payableNo)}`}
                        >
                          <bdi dir="ltr">{row.payableNo}</bdi>
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {result.pages > 1 ? (
            <Pagination count={result.pages} current={result.page} hrefFor={(p) => `/payables/purchase-orders?${query(p)}`} labels={{ label: admin('pagination'), previous: admin('previous'), next: admin('next'), page: (p) => admin('page_n', { page: p }) }} locale={locale} />
          ) : null}
        </div>
      </section>
    </AdminPage>
  );
}
