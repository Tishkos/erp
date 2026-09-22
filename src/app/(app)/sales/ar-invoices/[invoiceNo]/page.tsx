import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import {
  approveArInvoice,
  invoiceLineAvailability,
  postArInvoice,
  removeArInvoiceLine,
  saveArInvoiceLine,
} from '../actions';

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
 * Those fields and no others (by direction, 2026-09-16: *"no extra details or
 * buttons"*), with the three names that were asked for: who raised it, who
 * approved it, who posted it. Approving and posting are two verbs — *"the
 * invoice is not posted until CEO approval"* — so they are two names.
 *
 * It wears the Journal Entry's window, and while it is a draft the lines are
 * typed straight into that grid.
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

    // The pickers the grid needs, fetched only when there is a grid to fill: a
    // posted invoice is read, and reading it should not cost the item master.
    const editable = document.status === 'draft' && document.deliveryNoteId === null;
    return {
      document,
      customers: await partners.listActiveInRole(tx, 'customer'),
      // The sponsor's Supplier column: whose stock each line was sold from.
      suppliers: await partners.listActiveInRole(tx, 'supplier'),
      options: editable ? await items.invoiceChoices(tx, 'sale') : [],
      houses: editable
        ? (await warehouses.listActive(tx)).filter(
            (house) => house.branchCode === document.branchCode,
          )
        : [],
    };
  });

  if (!found) notFound();
  const { lines, raisedBy, approvedByName, postedByName, ...invoice } = found.document;
  const customer = found.customers.find((row) => row.id === invoice.customerId);
  const supplierOf = (id: string | null) =>
    id ? (found.suppliers.find((row) => row.id === id)?.code ?? '—') : '—';

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);

  // Summed from the lines, as the Journal Entry sums its own. A sale writes each
  // line's net when it is raised, so this agrees with the header at every stage.
  const total = lines.reduce((sum, line) => sum + Number(line.netIqd), 0);

  // Two steps, and the sponsor's rule lives in the second: "the invoice is not
  // posted until CEO approval". Approval and posting are separate verbs, so the
  // person who raised it cannot carry it to the ledger alone.
  const mayApprove =
    ['draft', 'submitted'].includes(invoice.status) &&
    can(principal, 'approve', ar.PERMISSION_OBJECT);
  // A draft raised on its own is typed into. One that bills a Delivery Note
  // takes its lines from the shipment — §7.4 carries the item down the chain
  // rather than choosing it at invoicing. Those are corrected on the delivery.
  const mayEdit =
    invoice.status === 'draft' &&
    invoice.deliveryNoteId === null &&
    can(principal, 'edit_draft', ar.PERMISSION_OBJECT);
  const mayPost = invoice.status === 'approved' && can(principal, 'post', ar.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('invoice_no'), value: <bdi dir="ltr">{invoice.invoiceNo}</bdi> },
    { label: column('status'), value: status(invoice.status), status: invoice.status },
    { label: column('customer_code'), value: <bdi dir="ltr">{customer?.code ?? '—'}</bdi> },
    { label: column('customer_name'), value: <bdi dir="auto">{customer?.name ?? '—'}</bdi> },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(invoice.invoiceDate, locale as Locale)}</bdi>,
    },
    {
      label: column('due_date'),
      value: <bdi dir="ltr">{formatBusinessDate(invoice.dueDate, locale as Locale)}</bdi>,
    },

    // Who the document passed through. An empty box is an answer too: it says
    // that step has not happened.
    { label: t('ar_invoices.raised_by'), value: <bdi dir="auto">{raisedBy ?? '—'}</bdi> },
    {
      label: t('ar_invoices.approved_by'),
      value: <bdi dir="auto">{approvedByName ?? t('none')}</bdi>,
    },
    {
      label: t('ar_invoices.posted_by'),
      value: <bdi dir="auto">{postedByName ?? t('none')}</bdi>,
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
            {/* "The invoice is not posted until CEO approval." */}
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
        documentType={page('ar_invoice')}
        fields={fields}
        id="ar-invoice-document"
        linesCount={lines.length}
        linesTitle={t('ar_invoices.lines')}
        number={invoice.invoiceNo}
        totals={[{ label: column('total_price'), value: money(String(total)) }]}
      >
        {mayEdit ? (
          <InvoiceLinesGrid
            currency="IQD"
            headingId="ar-invoice-document-lines-heading"
            items={found.options}
            loadAvailability={invoiceLineAvailability}
            mode="sale"
            labels={{
              itemCode: column('item_code'),
              itemName: column('item_name'),
              quantity: column('quantity'),
              unitPrice: column('unit_price'),
              discount: column('discount'),
              total: column('total_price'),
              supplier: column('supplier'),
              warehouse: column('warehouse'),
              anySupplier: t('ar_invoices.any_supplier'),
              chooseItem: '',
              remove: t('remove_line'),
              documentTotal: t('reports.totals'),
              saving: t('journals.saving'),
              saveFailed: t('invoices.save_failed'),
              noDefaultPrice: t('invoices.no_default_price'),
              checkingStock: t('invoices.checking_stock'),
              stockUnavailable: t('invoices.stock_unavailable'),
              availableStock: t('invoices.available_stock'),
              availabilityHint: t('invoices.availability_hint'),
            }}
            live={{
              documentId: invoice.id,
              documentNo: invoice.invoiceNo,
              lines: lines.map((line) => ({
                id: line.id,
                lineNo: line.lineNo,
                itemCode: line.itemCode,
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                discount: line.discountAmountIqd ?? '0',
                supplierId: line.supplierId ?? '',
                warehouseCode: line.warehouseCode ?? '',
              })),
              save: saveArInvoiceLine,
              remove: removeArInvoiceLine,
            }}
            locale={locale}
            searchItems
            showSupplier
            warehouses={found.houses.map((house) => ({ code: house.code, name: house.name }))}
          />
        ) : (
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
                <th scope="col">{column('warehouse')}</th>
              </tr>
            </thead>
            <tbody>
              {lines.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={9}>
                    {t('journals.no_lines')}
                  </td>
                </tr>
              ) : null}
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <bdi dir="ltr">{line.lineNo}</bdi>
                  </td>
                  <td className={s.sapAccountCell}>
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
                  <bdi dir="ltr">{money(String(total))}</bdi>
                </td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </DocumentWindow>

      <RecordHistory objectId={invoice.id} objectType={ar.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
