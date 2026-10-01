import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { InvoiceSettlement } from '@/components/admin/invoice-settlement';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { printSheet } from '@/server/print/sheet';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as ap from '@/server/services/ap-invoice';
import * as items from '@/server/services/items';
import * as coa from '@/server/services/chart-of-accounts';
import * as partners from '@/server/services/partners';
import * as warehouses from '@/server/services/warehouses';
import {
  invoiceLineAvailability,
  postApInvoice,
  reverseApInvoice,
  saveApInvoiceAccounts,
  removeApInvoiceLine,
  saveApInvoiceLine,
  submitApInvoice,
} from '../actions';

/**
 * One Purchase Invoice — Operations build, block 4.
 *
 *   Header            Invoice Number (automatically generated); Posting Date;
 *                     Due Date; Supplier Code; Supplier Name (searchable).
 *   Lines             Item Code; Item Name; Quantity; Unit Price; Discount;
 *                     Total Price; Warehouse.
 *   Inventory Effect  Increases stock in the selected warehouse.
 *   Journal Entry     Inventory Dr. / Accounts Payable Cr.
 *   Posting           The invoice is not posted until CEO approval.
 *
 * Those fields and no others (by direction, 2026-09-16: *"no extra details or
 * buttons"*). What the document also carries — the branch it was raised in, the
 * match status, the supplier's own invoice number, the journal it posted to —
 * is on the record and is read from the audit log or the ledger, not printed
 * here beside the five fields the sponsor asked for.
 *
 * The one addition is the four names, which were asked for: who raised it, who
 * sent it for approval, who posted it.
 *
 * It wears the Journal Entry's window because it is the same kind of thing: a
 * numbered document with header fields, a grid of lines, and a foot where what
 * may be done to it sits beside what it comes to. While it is a draft the lines
 * are typed straight into that grid.
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
      stockItems: editable ? await items.invoiceChoices(tx, 'purchase') : [],
      // What may be chosen on the document: the supplier control accounts the
      // statement can be kept on, and the expense accounts a service line's
      // cost may go to.
      accounts: editable ? await coa.postableAccounts(tx) : [],
      /*
       * The accounts this invoice actually names, looked up by id.
       *
       * Separately from the picker above, which is empty on anything but a
       * draft — so a posted invoice with a deliberately chosen payable or
       * expense account reported "As configured", the opposite of what was
       * configured. Looked up whether or not the account is still selectable:
       * one since deactivated is still the account this document posted to.
       */
      chosenAccounts: await Promise.all(
        [document.invoice.payableAccountId, document.invoice.expenseAccountId]
          .filter((id): id is string => Boolean(id))
          .map((id) => coa.loadAccount(tx, id).catch(() => null)),
      ),
      houses: editable
        ? (await warehouses.listActive(tx)).filter(
            (house) => house.branchCode === document.invoice.branchCode,
          )
        : [],
    };
  });

  if (!found) notFound();
  const { invoice, lines, raisedBy, submittedBy, postedBy } = found.document;
  const supplier = found.suppliers.find((row) => row.id === invoice.supplierId);
  // Named once: a `typeof found.…` in a type position is not narrowed by the
  // `notFound()` above, and reads worse besides.
  const accounts = found.accounts;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // The sponsor's "Total Price" is not a stored column and should not be: it is
  // quantity x unit price less the discount, and a fourth copy of it could
  // disagree with the three figures beside it on the same row.
  const lineTotal = (line: { quantity: string; unitPrice: string; discountIqd: string }) =>
    Number(line.quantity) * Number(line.unitPrice) - Number(line.discountIqd);

  // Summed from the lines, as the Journal Entry sums its own. `totalIqd` is
  // written at posting and is deliberately zero until then, so printing it on a
  // draft shows nothing next to lines that plainly come to something.
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0);

  // A draft raised on its own is typed into. One raised from a purchase order
  // takes its lines from that order — §8.4's match compares the three
  // documents, and a line typed over an ordered one compares the invoice with
  // itself. Those are corrected on the order.
  const mayEdit =
    invoice.status === 'draft' &&
    invoice.purchaseOrderId === null &&
    can(principal, 'edit_draft', ap.PERMISSION_OBJECT);
  const maySubmit = invoice.status === 'draft' && can(principal, 'submit', ap.PERMISSION_OBJECT);
  const mayChooseAccounts = mayEdit;
  /*
   * "As configured" means *no account was chosen on this document* — the
   * mapping decides. It must never be shown for a document that did choose
   * one, and it used to be shown for every posted invoice.
   */
  const accountLabel = (id: string | null) => {
    if (!id) return t('invoices.account_default');
    const account =
      accounts.find((row) => row.id === id) ??
      found.chosenAccounts.find((row) => row?.id === id);
    // An id naming nothing at all is a broken link, not a default.
    return account ? `${account.code} · ${account.name}` : t('invoices.account_missing');
  };
  const accountField = (
    label: string,
    name: string,
    current: string | null,
    eligible: (account: (typeof accounts)[number]) => boolean,
  ): DocumentField => ({
    label,
    control: mayChooseAccounts,
    value: mayChooseAccounts ? (
      <select aria-label={label} defaultValue={current ?? ''} form="ap-invoice-accounts" name={name}>
        <option value="">{t('invoices.account_default')}</option>
        {accounts.filter(eligible).map((account) => (
          <option key={account.id} value={account.id}>
            {`${account.code} · ${account.name}`}
          </option>
        ))}
      </select>
    ) : (
      <bdi dir="auto">{accountLabel(current)}</bdi>
    ),
  });
  const mayPost =
    invoice.status === 'submitted' &&
    can(principal, 'approve', ap.PERMISSION_OBJECT) &&
    can(principal, 'post', ap.PERMISSION_OBJECT);
  // A posted invoice is undone, never edited (§3.2). Offered while nothing has
  // been paid against it; the service refuses the rest and says why.
  const mayReverse =
    invoice.status === 'posted' &&
    Number(invoice.settledAmountIqd) === 0 &&
    can(principal, 'reverse_cancel', ap.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    { label: column('invoice_no'), value: <bdi dir="ltr">{invoice.invoiceNo}</bdi> },
    { label: column('status'), value: status(invoice.status), status: invoice.status },
    { label: column('supplier_code'), value: <bdi dir="ltr">{supplier?.code ?? '—'}</bdi> },
    { label: column('supplier_name'), value: <bdi dir="auto">{supplier?.name ?? '—'}</bdi> },
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
    { label: t('ap_invoices.raised_by'), value: <bdi dir="auto">{raisedBy ?? '—'}</bdi> },
    // The sponsor's ask (2026-09-22): the invoice names its own accounts.
    accountField(
      t('invoices.statement_account_supplier'),
      'payable_account_id',
      invoice.payableAccountId,
      (account) => account.controlAccount === 'supplier',
    ),
    accountField(
      t('invoices.expense_account'),
      'expense_account_id',
      invoice.expenseAccountId,
      (account) => account.accountType === 'expense' && account.controlAccount === null,
    ),
    { label: column('submitted_by'), value: <bdi dir="auto">{submittedBy ?? t('none')}</bdi> },
    { label: t('ap_invoices.posted_by'), value: <bdi dir="auto">{postedBy ?? t('none')}</bdi> },
  ];

  const sheet = await printSheet('purchase_invoice', invoice.invoiceNo);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="purchase_invoice" id={invoice.invoiceNo} />}
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
            {mayChooseAccounts ? (
              <form action={saveApInvoiceAccounts} id="ap-invoice-accounts">
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <Submit label={t('invoices.save_accounts')} tone="secondary" variant="document" />
              </form>
            ) : null}
            {maySubmit ? (
              <form action={submitApInvoice}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <Submit label={t('ap_invoices.submit')} variant="document" />
              </form>
            ) : null}
            {/* "The invoice is not posted until CEO approval." */}
            {mayPost ? (
              <form action={postApInvoice}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <Submit label={t('ap_invoices.approve_and_post')} variant="document" />
              </form>
            ) : null}
            {mayReverse ? (
              <form action={reverseApInvoice} title={t('invoices.reverse_hint')}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <input aria-label={t('reason')} name="reason" placeholder={t('invoices.reverse_reason')} required type="text" />
                <Submit label={t('invoices.reverse')} tone="secondary" variant="document" />
              </form>
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
        totals={[{ label: column('total_price'), value: money(String(total)) }]}
      >
        {mayEdit ? (
          <InvoiceLinesGrid
            currency="IQD"
            headingId="ap-invoice-document-lines-heading"
            items={found.stockItems}
            loadAvailability={invoiceLineAvailability}
            mode="purchase"
            purchaseSupplierId={invoice.supplierId}
            widthsKey={`erp.lines.ap.${context.principal.userId}`}
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
              resizeColumn: t('invoices.resize_column'),
              saveFailed: t('invoices.save_failed'),
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
            searchItems
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
                <th scope="col">{column('warehouse')}</th>
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
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{String(Number(line.quantity))}</bdi>
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
                <td colSpan={6}>{t('reports.totals')}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(String(total))}</bdi>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        )}
      </DocumentWindow>

      {/* How it stands against its payment terms — read through the same
          service the Receivables and Payables reports use, so an invoice and
          the report listing it cannot disagree about its own due date. */}
      <InvoiceSettlement invoiceNo={invoice.invoiceNo} side="supplier" />

      <RecordHistory objectId={invoice.id} objectType={ap.PERMISSION_OBJECT} />
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
