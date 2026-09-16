import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { InvoiceLinesGrid, type LineItem } from '@/components/admin/invoice-lines-grid';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import {
  formatBusinessDate,
  formatMoney,
  formatTimestamp,
  type Locale,
} from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ar from '@/server/services/ar-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import {
  approveArInvoice,
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
 * Wearing the Journal Entry's window: header fields in boxes, a disclosed grid
 * of lines, and a foot where the verbs sit beside the total.
 *
 * And, like the Journal Entry, it names everybody it passed through (by
 * direction, 2026-09-16): who raised it, who approved it, and who carried it to
 * the ledger. Approving and posting are two verbs here — "the invoice is not
 * posted until CEO approval" — so they are two boxes, and which of the two has
 * happened is readable at a glance instead of being inferred from the status.
 *
 * The line's Total Price is read from the invoice rather than recomputed. A
 * sale stores its net because the price and the discount were agreed when the
 * invoice was raised, and doing the arithmetic again on screen could print a
 * figure that differs from what the customer was billed.
 *
 * While it is a draft its lines are the same live grid the form raises it with
 * (by direction, 2026-09-16): a row is saved as it is left, filling the last
 * one opens the next, and ✕ takes one off. Once approved the document stops
 * offering anything that would change it — and the service refuses it too.
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
    const options: LineItem[] = [];
    if (editable) {
      for (const row of await items.listAll(tx)) {
        if (!row.isStock || !row.active) continue;
        const linked = await items.suppliersOf(tx, row.id);
        options.push({
          code: row.code,
          name: row.name,
          uomCode: row.baseUomCode,
          onHand: row.onHand,
          suppliers: linked
            .filter((link) => link.active)
            .map((link) => ({
              id: link.supplierId,
              label: `${link.supplierCode} · ${link.supplierName}`,
            })),
        });
      }
    }

    return {
      document,
      customers: await partners.listActiveInRole(tx, 'customer'),
      // The sponsor's Supplier column: whose stock each line was sold from.
      suppliers: await partners.listActiveInRole(tx, 'supplier'),
      options,
      houses: editable ? await warehouses.listActive(tx) : [],
    };
  });

  if (!found) notFound();
  const {
    lines,
    raisedBy,
    approvedByName,
    postedByName,
    reversedByName,
    journalEntryNo,
    ...invoice
  } = found.document;
  const customer = found.customers.find((row) => row.id === invoice.customerId);
  const supplierOf = (id: string | null) =>
    id ? (found.suppliers.find((row) => row.id === id)?.code ?? '—') : '—';

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const when = (at: Date | null) => (at ? formatTimestamp(at.toISOString(), locale as Locale) : '—');

  // Summed from the lines, as the Journal Entry sums its own. A sale writes each
  // line's net when it is raised, so this agrees with the header at every stage.
  const total = lines.reduce((sum, line) => sum + Number(line.netIqd), 0);
  const gross = lines.reduce((sum, line) => sum + Number(line.grossIqd), 0);
  const discount = gross - total;

  // What the customer still owes. Written by the receipts (06.9) and the credit
  // memos (§15), not decided here.
  const allocated = Number(invoice.allocatedIqd);
  const outstanding = Number(invoice.netIqd) - allocated;
  const isPosted = invoice.journalEntryId !== null;

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
    // The posting this invoice became, by the number a person would read out.
    {
      label: t('ar_invoices.journal'),
      value: journalEntryNo ? (
        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(journalEntryNo)}`}>
          <bdi dir="ltr">{journalEntryNo}</bdi>
        </Link>
      ) : (
        t('none')
      ),
    },
    { label: t('created_at'), value: <bdi dir="ltr">{when(invoice.createdAt)}</bdi> },
    { label: t('journals.posted_at'), value: <bdi dir="ltr">{when(invoice.postedAt)}</bdi> },

    // Who the document passed through. An empty box is an answer too: it says
    // that step has not happened yet.
    { label: t('ar_invoices.raised_by'), value: <bdi dir="auto">{raisedBy ?? '—'}</bdi> },
    {
      label: t('ar_invoices.approved_by'),
      value: <bdi dir="auto">{approvedByName ?? t('none')}</bdi>,
    },
    {
      label: t('ar_invoices.approved_at'),
      value: <bdi dir="ltr">{when(invoice.approvedAt)}</bdi>,
    },
    {
      label: t('ar_invoices.posted_by'),
      value: <bdi dir="auto">{postedByName ?? t('none')}</bdi>,
    },

    // A reversal is the one thing that can happen to a posted invoice, and §5.4
    // asks for the reason with it rather than in a log somewhere else.
    ...(reversedByName
      ? [
          {
            label: t('ar_invoices.reversed_by'),
            value: <bdi dir="auto">{reversedByName}</bdi>,
          },
          {
            label: t('journals.reverse_reason'),
            value: <bdi dir="auto">{invoice.reversalReason ?? '—'}</bdi>,
            wide: true,
          },
        ]
      : []),

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
            {/* A document nobody here can move says what it is waiting for.
                Otherwise the foot is silently empty and reads as broken. */}
            {!mayApprove && !mayPost ? (
              <span className={s.sapNote}>
                {isPosted ? t('ar_invoices.posted_note') : t('ar_invoices.awaiting')}
              </span>
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
        totals={[
          { label: column('gross_amount'), value: money(String(gross)) },
          { label: column('discount'), value: money(String(discount)) },
          { label: column('net_amount'), value: money(String(total)) },
          // Settlement is only a fact once the debt exists. Before posting
          // there is nothing to collect, and a row of zeros would suggest
          // somebody had failed to collect it.
          ...(isPosted
            ? [
                { label: column('allocated'), value: money(String(allocated)) },
                { label: column('outstanding'), value: money(String(outstanding)) },
              ]
            : []),
        ]}
      >
        {mayEdit ? (
          <InvoiceLinesGrid
            currency="IQD"
            headingId="ar-invoice-document-lines-heading"
            items={found.options}
            labels={{
              itemCode: column('item_code'),
              quantity: column('quantity'),
              unitPrice: column('unit_price'),
              discount: column('discount'),
              total: column('total_price'),
              supplier: column('supplier'),
              warehouse: column('warehouse_code'),
              anySupplier: t('ar_invoices.any_supplier'),
              chooseItem: t('choose_item'),
              remove: t('remove_line'),
              documentTotal: t('reports.totals'),
              lines: t('ar_invoices.lines'),
              onHand: column('on_hand'),
              saving: t('journals.saving'),
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
              <th scope="col">{column('warehouse_code')}</th>
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
                {/* The quantity carries the unit it was sold in. Twelve of
                    something is not a figure until it says twelve of what. */}
                <td className={s.sapNum}>
                  <bdi dir="ltr">{String(Number(line.quantity))}</bdi>{' '}
                  <span className={s.sapNote}>{line.uomCode}</span>
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
              <td colSpan={5}>{t('reports.totals')}</td>
              <td className={s.sapNum}>
                <bdi dir="ltr">{money(String(discount))}</bdi>
              </td>
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
