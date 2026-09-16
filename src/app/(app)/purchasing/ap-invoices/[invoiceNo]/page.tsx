import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
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
import * as ap from '@/server/services/ap-invoice';
import * as items from '@/server/services/items';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import {
  postApInvoice,
  removeApInvoiceLine,
  saveApInvoiceLine,
  submitApInvoice,
} from '../actions';

/**
 * One Purchase Invoice — Operations build, block 4.
 *
 *   Header            Invoice Number (automatically generated); Posting Date;
 *                     Due Date; Supplier Code; Supplier Name.
 *   Lines             Item Code; Item Name; Quantity; Unit Price; Discount;
 *                     Total Price; Warehouse.
 *   Inventory Effect  Increases stock in the selected warehouse.
 *   Journal Entry     Inventory Dr. / Accounts Payable Cr.
 *   Posting           The invoice is not posted until CEO approval.
 *
 * Wearing the Journal Entry's window, because it is the same kind of thing: a
 * numbered document with header fields, a grid of lines, and a foot where what
 * may be done to it sits beside what it comes to. A person who has read one has
 * read this.
 *
 * And, like the Journal Entry, it names everybody it passed through (by
 * direction, 2026-09-16): who raised it, who sent it up for approval, who
 * accepted the variance, and who carried it to the ledger. Each is a different
 * answer to a different question, which is why they are four boxes and not one.
 * §8.4's match status is on the document too, where the gate asks for it to be
 * visible at all times rather than on request.
 *
 * While it is a draft its lines are the same live grid the form raises it with
 * (by direction, 2026-09-16): a row is saved as it is left, filling the last
 * one opens the next, and ✕ takes one off. Once it is submitted the document
 * stops offering anything that would change it — and the service refuses it
 * too; this page simply stops asking.
 */
export const dynamic = 'force-dynamic';

export default async function ApInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ invoiceNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/purchasing/ap-invoices')) notFound();

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
  if (!can(principal, 'view', ap.PERMISSION_OBJECT)) {
    return <Denied object={page('ap_invoices')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    const document = await ap.viewByNo(tx, decodeURIComponent(invoiceNo));
    if (!document) return null;
    // The pickers the grid needs, fetched only when there is a grid to fill:
    // a posted invoice is read, and reading it should not cost the item master.
    const editable =
      document.invoice.status === 'draft' && document.invoice.purchaseOrderId === null;
    return {
      document,
      suppliers: await partners.listActiveInRole(tx, 'supplier'),
      stockItems: editable
        ? (await items.listAll(tx)).filter((row) => row.isStock && row.active)
        : [],
      houses: editable ? await warehouses.listActive(tx) : [],
    };
  });

  if (!found) notFound();
  const {
    invoice,
    lines,
    raisedBy,
    submittedBy,
    postedBy,
    varianceApprovedBy,
    journalEntryNo,
  } = found.document;
  const supplier = found.suppliers.find((row) => row.id === invoice.supplierId);

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const when = (at: Date | null) => (at ? formatTimestamp(at.toISOString(), locale as Locale) : '—');
  // The sponsor's "Total Price" is not a stored column and should not be: it is
  // quantity x unit price less the discount, and a fourth copy of it could
  // disagree with the three figures beside it on the same row.
  const lineTotal = (line: { quantity: string; unitPrice: string; discountIqd: string }) =>
    Number(line.quantity) * Number(line.unitPrice) - Number(line.discountIqd);

  // Summed from the lines, as the Journal Entry sums its own. `totalIqd` is
  // written at posting and is deliberately zero until then, so printing it on a
  // draft shows nothing next to lines that plainly come to something.
  const gross = lines.reduce(
    (sum, line) => sum + Number(line.quantity) * Number(line.unitPrice),
    0,
  );
  const discount = lines.reduce((sum, line) => sum + Number(line.discountIqd), 0);
  const total = gross - discount;

  // What is still owed. Read from the header rather than recomputed, because
  // settlement is written by the payment run and the advances (§8.5) and this
  // screen is not the place that decides it.
  const settled = Number(invoice.settledAmountIqd);
  const outstanding = Number(invoice.totalIqd) - settled;
  const isPosted = invoice.journalEntryId !== null;

  // A draft raised on its own is typed into. One raised from a purchase order
  // takes its lines from that order — §8.4's match compares the three
  // documents, and a line typed over an ordered one compares the invoice with
  // itself. Those are corrected on the order.
  const mayEdit =
    invoice.status === 'draft' &&
    invoice.purchaseOrderId === null &&
    can(principal, 'edit_draft', ap.PERMISSION_OBJECT);
  const maySubmit = invoice.status === 'draft' && can(principal, 'submit', ap.PERMISSION_OBJECT);
  const mayPost = invoice.status === 'submitted' && can(principal, 'post', ap.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('reference'), value: <bdi dir="ltr">{invoice.invoiceNo}</bdi> },
    { label: column('status'), value: status(invoice.status), status: invoice.status },
    // §8.4's gate — "match status is visible on the invoice at all times".
    {
      label: t('ap_invoices.match_status'),
      value: t(`ap_invoices.match_${invoice.matchStatus}`),
      status: invoice.matchStatus,
    },
    { label: column('supplier_code'), value: <bdi dir="ltr">{supplier?.code ?? '—'}</bdi> },
    { label: column('supplier_name'), value: <bdi dir="auto">{supplier?.name ?? '—'}</bdi> },

    {
      label: t('ap_invoices.supplier_invoice_no'),
      value: <bdi dir="ltr">{invoice.supplierInvoiceNo}</bdi>,
    },
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
      label: t('ap_invoices.journal'),
      value: journalEntryNo ? (
        <Link className={s.sapLink} href={`/finance/journals/${encodeURIComponent(journalEntryNo)}`}>
          <bdi dir="ltr">{journalEntryNo}</bdi>
        </Link>
      ) : (
        t('none')
      ),
    },

    // Who the document passed through. Four questions, four answers — and an
    // empty one is an answer too: it says that step has not happened.
    { label: t('ap_invoices.raised_by'), value: <bdi dir="auto">{raisedBy ?? '—'}</bdi> },
    {
      label: column('submitted_by'),
      value: <bdi dir="auto">{submittedBy ?? t('none')}</bdi>,
    },
    {
      label: t('ap_invoices.posted_by'),
      value: <bdi dir="auto">{postedBy ?? t('none')}</bdi>,
    },
    { label: t('created_at'), value: <bdi dir="ltr">{when(invoice.createdAt)}</bdi> },
    { label: t('journals.posted_at'), value: <bdi dir="ltr">{when(invoice.postedAt)}</bdi> },

    // §8.4 — a variance is allowed only after a manager approves it, in
    // writing. Shown only when there was one: an empty box would invite the
    // question of what it was for.
    ...(varianceApprovedBy
      ? [
          {
            label: t('ap_invoices.variance_approved_by'),
            value: <bdi dir="auto">{varianceApprovedBy}</bdi>,
          },
          {
            label: t('ap_invoices.variance_reason'),
            value: <bdi dir="auto">{invoice.varianceApprovalReason ?? '—'}</bdi>,
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
      back={{ href: '/purchasing/ap-invoices', label: t('back') }}
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
            {maySubmit ? (
              <form action={submitApInvoice}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <button className="action action--primary" type="submit">
                  {t('ap_invoices.submit')}
                </button>
              </form>
            ) : null}
            {mayPost ? (
              <form action={postApInvoice}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <button className="action action--primary" type="submit">
                  {t('ap_invoices.approve_and_post')}
                </button>
              </form>
            ) : null}
            {/* A document that has left the clerk's hands says what it is
                waiting for, where the buttons would be if this person had
                them. Otherwise the foot is silently empty and reads as broken. */}
            {!maySubmit && !mayPost ? (
              <span className={s.sapNote}>
                {isPosted ? t('ap_invoices.posted_note') : t('ap_invoices.awaiting')}
              </span>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('ap_invoice')}
        fields={fields}
        id="ap-invoice-document"
        linesCount={lines.length}
        linesTitle={t('ap_invoices.lines')}
        number={invoice.invoiceNo}
        totals={[
          { label: column('gross_amount'), value: money(String(gross)) },
          { label: column('discount'), value: money(String(discount)) },
          { label: column('net_amount'), value: money(String(total)) },
          // Settlement is only a fact once the debt exists. Before posting
          // there is nothing to pay, and a row of zeros would suggest there is.
          ...(isPosted
            ? [
                { label: column('settled'), value: money(String(settled)) },
                { label: column('outstanding'), value: money(String(outstanding)) },
              ]
            : []),
        ]}
      >
        {mayEdit ? (
          <InvoiceLinesGrid
            currency="IQD"
            headingId="ap-invoice-document-lines-heading"
            items={found.stockItems.map((row) => ({
              code: row.code,
              name: row.name,
              uomCode: row.baseUomCode,
            }))}
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
              lines: t('ap_invoices.lines'),
              onHand: column('on_hand'),
              saving: t('journals.saving'),
            }}
            live={{
              documentId: invoice.id,
              documentNo: invoice.invoiceNo,
              lines: lines.map((line) => ({
                id: line.id,
                lineNo: line.lineNo,
                itemCode: line.itemCode ?? '',
                quantity: line.quantity,
                unitPrice: line.unitPrice,
                discount: line.discountIqd,
                supplierId: '',
                warehouseCode: line.warehouseCode ?? '',
              })),
              save: saveApInvoiceLine,
              remove: removeApInvoiceLine,
            }}
            locale={locale}
            warehouses={found.houses.map((house) => ({ code: house.code, name: house.name }))}
          />
        ) : (
        <table aria-labelledby="ap-invoice-document-lines-heading" className={s.sapTable}>
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
              <th scope="col">{column('warehouse_code')}</th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td className={s.sapEmptyRow} colSpan={8}>
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
                  <bdi dir="ltr">{line.itemCode ?? '—'}</bdi>
                </td>
                <td>
                  <bdi dir="auto">{line.description}</bdi>
                </td>
                {/* The quantity carries the unit it was billed in. Twelve of
                    something is not a figure until it says twelve of what. */}
                <td className={s.sapNum}>
                  <bdi dir="ltr">{String(Number(line.quantity))}</bdi>{' '}
                  <span className={s.sapNote}>{line.uomCode}</span>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.unitPrice)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(line.discountIqd)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(String(lineTotal(line)))}</bdi>
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
              <td />
            </tr>
          </tfoot>
        </table>
        )}
      </DocumentWindow>

      <RecordHistory objectId={invoice.id} objectType={ap.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
