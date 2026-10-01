import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, KeyValue, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as orders from '@/server/services/purchase-order';

/**
 * The purchase order record — REQ-AP-001 §21.6: the lines with their
 * received and invoiced quantities, the status, and the payable it answers
 * to. Read-only: an order is raised and corrected from its payable.
 */
export const dynamic = 'force-dynamic';

export default async function PurchaseOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/purchase-orders')) notFound();

  const { orderNo } = await params;
  const [t, page, locale, outcome, context] = await Promise.all([
    getTranslations('admin.payables_orders'),
    getTranslations('page'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);

  if (!can(context.principal, 'view', orders.PERMISSION_OBJECT)) {
    return <Denied object={page('purchase_orders')} />;
  }

  const found = await withCurrentUser((tx) => orders.viewByNo(tx, orderNo));
  if (!found) notFound();
  const { order, lines, supplier, payableNo } = found;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const quantity = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(new Date(value).toISOString().slice(0, 10), locale as Locale) : '—';

  return (
    <AdminPage
      back={{ href: '/payables/purchase-orders', label: t('title') }}
      subtitle={supplier?.legalName ?? ''}
      title={order.orderNo}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="order-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="order-title">
            <span>{t('record_title')}</span>
            <span className={s.sapTitleMeta}>
              <span
                className="status"
                data-status={
                  order.status === 'approved' || order.status === 'partially_executed'
                    ? 'approved'
                    : order.status === 'cancelled'
                      ? 'cancelled'
                      : order.status
                }
              >
                {t(`status_${order.status}`)}
              </span>
            </span>
          </h2>

          <KeyValue
            rows={[
              { label: t('col_supplier'), value: supplier?.legalName ?? '—' },
              { label: t('col_date'), value: day(order.orderDate) },
              { label: t('expected_date'), value: day(order.expectedDate) },
              { label: t('currency'), value: order.currency },
              { label: t('reference'), value: order.reference ?? '—' },
              ...(payableNo ? [{ label: t('col_payable'), value: payableNo }] : []),
              ...(order.cancellationReason
                ? [{ label: t('cancellation_reason'), value: order.cancellationReason }]
                : []),
            ]}
          />
          {payableNo ? (
            <p className={s.sapNote}>
              <Link className={s.sapLink} href={`/payables/${encodeURIComponent(payableNo)}`}>
                {t('open_payable', { payableNo })}
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="lines-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="lines-title">
            <span>{t('lines')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: lines.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t('line_item')}</th>
                  <th scope="col">{t('line_description')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('line_quantity')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('line_received')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('line_invoiced')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {t('line_price')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.lineNo}</td>
                    <td>
                      <bdi dir="ltr">{line.itemCode ?? '—'}</bdi>
                    </td>
                    <td>{line.description}</td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{quantity(line.quantity)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{quantity(line.receivedQuantity)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{quantity(line.invoicedQuantity)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(line.unitPrice)}</bdi>
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
