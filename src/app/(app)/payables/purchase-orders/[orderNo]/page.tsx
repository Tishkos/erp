import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, formatQuantity, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import { QUANTITY_FACTOR, QUANTITY_SCALE, parseQuantity } from '@domain/uom';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as orders from '@/server/services/purchase-order';
import { businessDateOf } from '@/server/domain/business-date';
import { PurchaseDoors, readDoors } from '../../record-doors';

/**
 * The purchase order record — REQ-PAY-001 PAY5 (2026-10-04), on the Journal
 * Entry's window like every other document: the supplier as a link to its
 * profile, the four doors in the title bar from the draft on, and per line
 * Ordered / Received / Remaining / Invoiced / price, with the receipts and
 * the invoices that answered the order underneath. Read-only: an order is
 * raised, approved and corrected from its own register and its payable.
 *
 * Remaining is the order's own arithmetic (`openCommitments`): ordered, less
 * received, less what a cancellation closed — in exact decimals.
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

  const { orderNo: rawOrderNo } = await params;
  const orderNo = decodeURIComponent(rawOrderNo);
  const [t, x, page, column, locale, outcome, context] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.payables_orders'),
    getTranslations('page'),
    getTranslations('column'),
    getLocale(),
    outcomeOf(searchParams),
    requireContext(),
  ]);
  // REQ-HARDEN-001 H3 — the document statuses read one shared namespace, not a copy per screen.
  const statusOf = await getTranslations('status_order');
  const status = await getTranslations('status');

  const { principal } = context;
  if (!can(principal, 'view', orders.PERMISSION_OBJECT)) {
    return <Denied object={page('purchase_orders')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const seen = await orders.viewByNo(tx, orderNo);
    if (!seen) return null;
    return { ...seen, doors: await readDoors(tx, principal, { object: orders.PERMISSION_OBJECT, recordId: seen.order.id }) };
  });
  if (!found) notFound();
  const { order, lines, supplier, payableNo, receipts, invoices, doors } = found;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const quantity = (value: string) => formatQuantity(value, locale as Locale);
  const day = (value: string | Date | null) =>
    value ? formatBusinessDate(businessDateOf(new Date(value)), locale as Locale) : '—';
  const remainingOf = (line: (typeof lines)[number]) =>
    toDecimalString(parseQuantity(line.quantity) - parseQuantity(line.receivedQuantity) - parseQuantity(line.closedQuantity), QUANTITY_SCALE);
  const lineTotal = (line: (typeof lines)[number]) =>
    (parseQuantity(line.quantity) * parseDecimal(line.unitPrice, MONEY_SCALE)) / QUANTITY_FACTOR;
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0n);
  const chip =
    order.status === 'approved' || order.status === 'partially_executed' ? 'approved' : order.status === 'cancelled' ? 'cancelled' : order.status;
  const self = `/payables/purchase-orders/${encodeURIComponent(order.orderNo)}`;

  const fields: DocumentField[] = [
    { label: x('col_no'), value: <bdi dir="ltr">{order.orderNo}</bdi> },
    { label: column('status'), value: statusOf(order.status), status: chip },
    { label: column('supplier_code'), value: <ProfileLink code={supplier?.code} kind="supplier">{supplier?.code ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={supplier?.code} dir="auto" kind="supplier">
          {supplier?.legalName ?? '—'}
        </ProfileLink>
      ),
    },
    { label: x('col_date'), value: <bdi dir="ltr">{day(order.orderDate)}</bdi> },
    { label: x('expected_date'), value: <bdi dir="ltr">{day(order.expectedDate)}</bdi> },
    { label: x('currency'), value: <bdi dir="ltr">{order.currency}</bdi> },
    { label: x('reference'), value: <bdi dir="auto">{order.reference ?? '—'}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{order.branchCode}</bdi> },
    ...(payableNo ? [{ label: x('col_payable'), value: <ProfileLink code={payableNo} kind="import" /> }] : []),
    ...(order.cancellationReason ? [{ label: x('cancellation_reason'), value: <bdi dir="auto">{order.cancellationReason}</bdi>, wide: true }] : []),
  ];

  return (
    <AdminPage
      back={{ href: '/payables/purchase-orders', label: t('back') }}
      title={order.orderNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash error={outcome.error} errorTitle={t('error_title')} saved={outcome.saved} savedLabel={t('saved')} />

      <DocumentWindow
        documentType={x('record_title')}
        fields={fields}
        id="purchase-order-document"
        linesCount={lines.length}
        linesTitle={x('lines_title')}
        number={order.orderNo}
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={order.orderNo}
            exportKey="purchase_order"
            object={orders.PERMISSION_OBJECT}
            recordId={order.id}
            returnTo={self}
            title={`${x('record_title')} ${order.orderNo}`}
          />
        }
        totals={[
          { label: x('line_quantity'), value: quantity(toDecimalString(lines.reduce((sum, line) => sum + parseQuantity(line.quantity), 0n), QUANTITY_SCALE)) },
          { label: x('line_received'), value: quantity(toDecimalString(lines.reduce((sum, line) => sum + parseQuantity(line.receivedQuantity), 0n), QUANTITY_SCALE)) },
          { label: x('total'), value: money(toDecimalString(total, MONEY_SCALE)) },
        ]}
      >
        <table aria-labelledby="purchase-order-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{x('line_item')}</th>
              <th scope="col">{x('line_description')}</th>
              <th className={s.sapNum} scope="col">
                {x('line_quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_received')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_remaining')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_invoiced')}
              </th>
              <th className={s.sapNum} scope="col">
                {x('line_price')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('total_price')}
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>{line.lineNo}</td>
                <td className={s.sapAccountCell}>
                  {line.itemCode ? <ProfileLink code={line.itemCode} kind="item" /> : '—'}
                </td>
                <td>
                  <bdi dir="auto">{line.description}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{quantity(line.quantity)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{quantity(line.receivedQuantity)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{quantity(remainingOf(line))}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{quantity(line.invoicedQuantity)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.unitPrice)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(toDecimalString(lineTotal(line), MONEY_SCALE))}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      {/* What answered the order — the receipts and the invoices, in the supplier-statement manner. */}
      <section aria-labelledby="order-receipts-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="order-receipts-title">
            <span>{x('receipts')}</span>
            <span className={s.sapTitleMeta}>{x('rows', { count: receipts.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('col_receipt')}</th>
                  <th scope="col">{x('col_date')}</th>
                  <th scope="col">{column('status')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('line_received')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {receipts.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {x('no_receipts')}
                    </td>
                  </tr>
                ) : null}
                {receipts.map((receipt) => (
                  <tr key={receipt.id}>
                    <td className={s.sapAccountCell}>
                      <Link className={s.sapLink} href={`/payables/goods-receipts/${encodeURIComponent(receipt.receiptNo)}`}>
                        <bdi dir="ltr">{receipt.receiptNo}</bdi>
                      </Link>
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(receipt.receiptDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${receipt.status}`} data-status={receipt.status}>
                        {status(receipt.status)}
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{quantity(receipt.quantity)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section aria-labelledby="order-invoices-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="order-invoices-title">
            <span>{x('invoices')}</span>
            <span className={s.sapTitleMeta}>{x('rows', { count: invoices.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{x('col_invoice')}</th>
                  <th scope="col">{x('col_date')}</th>
                  <th scope="col">{column('status')}</th>
                  <th className={s.sapNum} scope="col">
                    {x('col_amount')}
                  </th>
                  <th className={s.sapNum} scope="col">
                    {column('allocated')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {invoices.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {x('no_invoices')}
                    </td>
                  </tr>
                ) : null}
                {invoices.map((invoice) => (
                  <tr key={invoice.id}>
                    <td className={s.sapAccountCell}>
                      <ProfileLink code={invoice.invoiceNo} kind="purchase_invoice" />
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(invoice.invoiceDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${invoice.status}`} data-status={invoice.status}>
                        {status(invoice.status)}
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(invoice.totalIqd)}</bdi>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(invoice.settledAmountIqd)}</bdi>
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
