import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { QUANTITY_SCALE, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/goods-receipt';
import { businessDateOf } from '@/server/domain/business-date';
import { PurchaseDoors, readDoors } from '../../record-doors';

/**
 * The goods receipt record — REQ-PAY-001 PAY6 (2026-10-04), on the Journal
 * Entry's window: the order it answers and the supplier as links, the four
 * doors in the title bar from the draft on, and per line what was ordered,
 * what this receipt brought, what has been received to date (every executed
 * receipt against the line, this one included) and what is still to come.
 * Read-only: receipts are raised and posted from their own flow, and the
 * stock they put on the shelf is the inventory movement ledger's.
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

  const { receiptNo: rawReceiptNo } = await params;
  const receiptNo = decodeURIComponent(rawReceiptNo);
  const [t, x, page, column, locale, outcome, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.payables_goods'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);
  // REQ-HARDEN-001 H3 — the document statuses read one shared namespace, not a copy per screen.
  const statusOf = await getTranslations('status_order');

  const { principal } = context;
  if (!can(principal, 'view', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('goods_receipts')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const seen = await receipts.viewByNo(tx, receiptNo);
    if (!seen) return null;
    return { ...seen, doors: await readDoors(tx, principal, { object: receipts.PERMISSION_OBJECT, recordId: seen.receipt.id }) };
  });
  if (!found) notFound();
  const { receipt, lines, orderNo, supplier, orderLines, doors } = found;

  const quantity = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—';
  const chip = receipt.status === 'posted' ? 'approved' : receipt.status === 'reversed' ? 'cancelled' : receipt.status;
  const self = `/payables/goods-receipts/${encodeURIComponent(receipt.receiptNo)}`;
  // Ordered, less received to date, less what a cancellation closed — the order line's own arithmetic.
  const remainingOf = (lineId: string) => {
    const order = orderLines.get(lineId);
    if (!order) return null;
    return toDecimalString(parseQuantity(order.quantity) - parseQuantity(order.receivedQuantity) - parseQuantity(order.closedQuantity), QUANTITY_SCALE);
  };
  const received = toDecimalString(lines.reduce((sum, line) => sum + parseQuantity(line.quantity), 0n), QUANTITY_SCALE);

  const fields: DocumentField[] = [
    { label: x('col_no'), value: <bdi dir="ltr">{receipt.receiptNo}</bdi> },
    { label: column('status'), value: statusOf(receipt.status), status: chip },
    { label: x('col_order'), value: <ProfileLink code={orderNo} kind="purchase_order" /> },
    { label: column('supplier_code'), value: <ProfileLink code={supplier?.code} kind="supplier">{supplier?.code ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={supplier?.code} dir="auto" kind="supplier">
          {supplier?.legalName ?? '—'}
        </ProfileLink>
      ),
    },
    { label: x('col_date'), value: <bdi dir="ltr">{day(receipt.receiptDate)}</bdi> },
    { label: x('delivery_note'), value: <bdi dir="auto">{receipt.supplierDeliveryNote ?? '—'}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{receipt.branchCode}</bdi> },
    ...(receipt.note ? [{ label: x('note'), value: <bdi dir="auto">{receipt.note}</bdi>, wide: true }] : []),
    ...(receipt.reversalReason ? [{ label: x('reversal_reason'), value: <bdi dir="auto">{receipt.reversalReason}</bdi>, wide: true }] : []),
  ];

  return (
    <AdminPage
      back={{ href: '/payables/goods-receipts', label: t('back') }}
      title={receipt.receiptNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        documentType={x('record_title')}
        fields={fields}
        id="goods-receipt-document"
        linesCount={lines.length}
        linesTitle={x('lines')}
        number={receipt.receiptNo}
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={receipt.receiptNo}
            exportKey="goods_receipt"
            object={receipts.PERMISSION_OBJECT}
            recordId={receipt.id}
            returnTo={self}
            title={`${x('record_title')} ${receipt.receiptNo}`}
          />
        }
        totals={[{ label: x('line_this_receipt'), value: quantity(received) }]}
      >
        <table aria-labelledby="goods-receipt-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{x('line_item')}</th>
              <th className={s.sapNum} scope="col">
                {x('line_ordered')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_this_receipt')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_received_to_date')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_remaining')}
              </th>
              <th scope="col">{x('line_uom')}</th>
              <th scope="col">{x('col_warehouse')}</th>
              <th scope="col">{x('line_batch')}</th>
              <th scope="col">{x('line_serial')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => {
              const order = orderLines.get(line.purchaseOrderLineId);
              const remaining = remainingOf(line.purchaseOrderLineId);
              return (
                <tr key={line.id}>
                  <td>{line.lineNo}</td>
                  <td className={s.sapAccountCell}>
                    <ProfileLink code={line.itemCode} kind="item" />
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{order ? quantity(order.quantity) : '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{quantity(line.quantity)}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{order ? quantity(order.receivedQuantity) : '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{remaining ? quantity(remaining) : '—'}</bdi>
                  </td>
                  <td>{line.uomCode}</td>
                  <td>
                    <ProfileLink code={line.warehouseCode} kind="warehouse" />
                  </td>
                  <td>
                    <bdi dir="ltr">{line.batchNumber ?? '—'}</bdi>
                  </td>
                  <td>
                    <bdi dir="ltr">{line.serialNumber ?? '—'}</bdi>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DocumentWindow>
    </AdminPage>
  );
}
