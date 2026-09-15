import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as partners from '@/server/services/partners';
import { approveArInvoice, postArInvoice } from '../actions';

/**
 * One Sales Invoice — Operations build, block 5.
 *
 *   Header            Invoice Number (automatically generated); Posting Date;
 *                     Due Date; Customer Code; Customer Name.
 *   Lines             Item Code; Item Name; Quantity; Unit Price; Discount;
 *                     Total Price; Supplier; Warehouse.
 *   Inventory Effect  Decreases stock from the selected warehouse.
 *   Journal Entry     Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. /
 *                     COGS Dr.
 *   Posting           The invoice is not posted until CEO approval.
 *
 * Wearing the Journal Entry's window: header fields in boxes, a disclosed grid
 * of lines, and a foot where the verbs sit beside the total.
 *
 * The line's Total Price is read from the invoice rather than recomputed. A
 * sale stores its net because the price and the discount were agreed when the
 * invoice was raised, and doing the arithmetic again on screen could print a
 * figure that differs from what the customer was billed.
 */
export const dynamic = 'force-dynamic';

export default async function ArInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/ar-invoices')) notFound();

  const [t, page, column, status, locale, context, outcome, { invoiceNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('page'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
    requireContext(),
    outcomeOf(searchParams),
    params,
  ]);

  const { principal } = context;
  if (!can(principal, 'view', ar.PERMISSION_OBJECT)) {
    return <Denied object={page('ar_invoices')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const document = await ar.viewByNo(tx, decodeURIComponent(invoiceNo));
    if (!document) return null;
    return {
      document,
      customers: await partners.listActiveInRole(tx, 'customer'),
      // The sponsor's Supplier column: whose stock each line was sold from.
      suppliers: await partners.listActiveInRole(tx, 'supplier'),
    };
  });

  if (!found) notFound();
  const { lines, ...invoice } = found.document;
  const customer = found.customers.find((row) => row.id === invoice.customerId);
  const supplierOf = (id: string | null) =>
    id ? (found.suppliers.find((row) => row.id === id)?.code ?? '—') : '—';

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  // Two steps, and the sponsor's rule lives in the second: "the invoice is not
  // posted until CEO approval". Approval and posting are separate verbs, so the
  // person who raised it cannot carry it to the ledger alone.
  const mayApprove =
    ['draft', 'submitted'].includes(invoice.status) &&
    can(principal, 'approve', ar.PERMISSION_OBJECT);
  const mayPost = invoice.status === 'approved' && can(principal, 'post', ar.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{invoice.invoiceNo}</bdi> },
    { label: column('status'), value: status(invoice.status), status: invoice.status },
    { label: column('customer_code'), value: <bdi dir="ltr">{customer?.code ?? '—'}</bdi> },
    { label: column('customer_name'), value: <bdi dir="auto">{customer?.name ?? '—'}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{invoice.branchCode}</bdi> },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(invoice.invoiceDate, locale as Locale)}</bdi>,
    },
    {
      label: column('due_date'),
      value: <bdi dir="ltr">{formatBusinessDate(invoice.dueDate, locale as Locale)}</bdi>,
    },
    // The note the invoice was raised with. It is on the record and was shown
    // nowhere, which is the one field a person actually writes prose into.
    {
      label: t('journals.description'),
      value: <bdi dir="auto">{invoice.note ?? '—'}</bdi>,
      wide: true,
    },
  ];

  return (
    <AdminPage
      back={{ href: '/sales/ar-invoices', label: t('back') }}
      title={invoice.invoiceNo}
      trail={[{ href: '/', label: t('dashboard_label') }]}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <DocumentWindow
        actions={
          <>
            {mayApprove ? (
              <form action={approveArInvoice}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <button className="action action--primary" type="submit">
                  {t('ar_invoices.approve')}
                </button>
              </form>
            ) : null}
            {mayPost ? (
              <form action={postArInvoice}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <button className="action action--primary" type="submit">
                  {t('ar_invoices.post')}
                </button>
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('ar_invoices')}
        fields={fields}
        id="ar-invoice-document"
        linesCount={lines.length}
        linesTitle={t('ar_invoices.lines')}
        number={invoice.invoiceNo}
        totals={[{ label: column('amount'), value: money(invoice.netIqd) }]}
      >
        <table aria-labelledby="ar-invoice-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">{column('item_code')}</th>
              <th scope="col">{column('item_name')}</th>
              <th className={s.sapNum} scope="col">
                {column('quantity')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('unit_price')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('discount')}
              </th>
              <th className={s.sapNum} scope="col">
                {column('total_price')}
              </th>
              <th scope="col">{column('supplier')}</th>
              <th scope="col">{column('warehouse_code')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id}>
                <td>
                  <bdi dir="ltr">{line.lineNo}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.itemCode}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{String(Number(line.quantity))}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.unitPrice)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.discountAmountIqd ?? '0')}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.netIqd)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{supplierOf(line.supplierId)}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{line.warehouseCode ?? '—'}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className={s.sapTotalRow}>
              <td colSpan={6}>{t('reports.totals')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(invoice.netIqd)}</bdi>
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={invoice.id} objectType={ar.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
