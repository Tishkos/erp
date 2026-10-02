import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, KeyValue, admin as s } from '@/components/admin';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/goods-receipt';
import { businessDateOf } from '@/server/domain/business-date';

/**
 * The goods receipt record — REQ-AP-001 §21.6: the lines as they landed,
 * warehouse by warehouse, with batch and serial where the item carries one.
 * Read-only: receipts are raised and posted from their own flow.
 */
export const dynamic = 'force-dynamic';

export default async function GoodsReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ receiptNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/goods-receipts')) notFound();

  const { receiptNo } = await params;
  const [t, page, locale, outcome, context] = await Promise.all([
    getTranslations('admin.payables_goods'),
    getTranslations('page'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);

  if (!can(context.principal, 'view', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('goods_receipts')} />;
  }

  const found = await withCurrentUser((tx) => receipts.viewByNo(tx, receiptNo));
  if (!found) notFound();
  const { receipt, lines, orderNo } = found;

  const quantity = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—';

  return (
    <AdminPage
      back={{ href: '/payables/goods-receipts', label: t('title') }}
      subtitle={orderNo ? t('against_order', { orderNo }) : t('subtitle')}
      title={receipt.receiptNo}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <section aria-labelledby="receipt-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="receipt-title">
            <span>{t('record_title')}</span>
            <span className={s.sapTitleMeta}>
              <span
                className="status"
                data-status={
                  receipt.status === 'posted'
                    ? 'approved'
                    : receipt.status === 'reversed'
                      ? 'cancelled'
                      : receipt.status
                }
              >
                {t(`status_${receipt.status}`)}
              </span>
            </span>
          </h2>

          <KeyValue
            rows={[
              { label: t('col_date'), value: day(receipt.receiptDate) },
              { label: t('delivery_note'), value: receipt.supplierDeliveryNote ?? '—' },
              { label: t('note'), value: receipt.note ?? '—' },
              ...(receipt.reversalReason
                ? [{ label: t('reversal_reason'), value: receipt.reversalReason }]
                : []),
            ]}
          />
          {orderNo ? (
            <p className={s.sapNote}>
              <Link
                className={s.sapLink}
                href={`/payables/purchase-orders/${encodeURIComponent(orderNo)}`}
              >
                {t('open_order', { orderNo })}
              </Link>
            </p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="gr-lines-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="gr-lines-title">
            <span>{t('lines')}</span>
            <span className={s.sapTitleMeta}>{t('rows', { count: lines.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">{t('line_item')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('line_quantity')}
                  </th>
                  <th scope="col">{t('line_uom')}</th>
                  <th scope="col">{t('col_warehouse')}</th>
                  <th scope="col">{t('line_batch')}</th>
                  <th scope="col">{t('line_serial')}</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.lineNo}</td>
                    <td>
                      <bdi dir="ltr">{line.itemCode}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{quantity(line.quantity)}</bdi>
                    </td>
                    <td>{line.uomCode}</td>
                    <td>
                      <bdi dir="ltr">{line.warehouseCode}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{line.batchNumber ?? '—'}</bdi>
                    </td>
                    <td>
                      <bdi dir="ltr">{line.serialNumber ?? '—'}</bdi>
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
