import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AdminPage, Field, Flash, Form, Grid, Select, admin as s, Submit, SubmitRow } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { InvoiceSettlement } from '@/components/admin/invoice-settlement';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Attachments } from '@/components/admin/attachments';
import * as attachmentsService from '@/server/services/attachments';
import { AttachmentsButton, HistoryButton, NotesButton } from '@/components/admin/icon-dialog';
import { ExportIcon } from '@/components/print/export-menu';
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
import * as expenses from '@/server/services/expenses';
import * as bankCash from '@/server/services/bank-cash-accounts';
import * as payables from '@/server/services/payables';
import { addInvoiceNoteAction, attachToInvoice, invoiceLineAvailability, markPaidAction, postApInvoice, removeApInvoiceLine, reverseApInvoice, saveApInvoiceAccounts, saveApInvoiceLine, setDueDateAction, submitApInvoice } from '../actions';
import { businessToday } from '@/server/domain/business-date';
import { MONEY_SCALE, parseDecimal, RATE_SCALE, toDecimalString, toIqd } from '@/server/domain/money';
import { advanceOf } from '@/server/domain/payment-applications';
import { QUANTITY_FACTOR, parseQuantity } from '@/server/domain/uom';

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
  if (!visibleRoute('/payables/invoices')) notFound();

  const [t, x, page, column, status, locale, context, outcome, { invoiceNo }] = await Promise.all([
    getTranslations('admin'),
    getTranslations('admin.expenses'),
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
      // D12 / D13 — the notes, the accounts a payment may leave from, and
      // the import application behind this invoice, if any.
      notes: await expenses.notesOf(tx, document.invoice.id),
      categoryName: document.invoice.expenseCategoryCode
        ? ((await expenses.categories(tx)).find((c) => c.code === document.invoice.expenseCategoryCode)
            ?.name ?? document.invoice.expenseCategoryCode)
        : null,
      payFrom: [
        ...(await bankCash.listOfKind(tx, 'bank')),
        ...(await bankCash.listOfKind(tx, 'cash')),
      ].filter((account) => account.active),
      importApplication: document.invoice.payableId
        ? await payables.load(tx, document.invoice.payableId)
        : null,
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
  // HD8 — in integers, the database's own scales.
  const lineTotal = (line: { quantity: string; unitPrice: string; discountIqd: string }) =>
    (parseQuantity(line.quantity) * parseDecimal(line.unitPrice, MONEY_SCALE)) / QUANTITY_FACTOR -
    parseDecimal(line.discountIqd, MONEY_SCALE);

  // Summed from the lines, as the Journal Entry sums its own. `totalIqd` is
  // written at posting and is deliberately zero until then, so printing it on a
  // draft shows nothing next to lines that plainly come to something.
  const total = lines.reduce((sum, line) => sum + lineTotal(line), 0n);

  // A draft raised on its own is typed into. One raised from a purchase order
  // takes its lines from that order — §8.4's match compares the three
  // documents, and a line typed over an ordered one compares the invoice with
  // itself. Those are corrected on the order.
  // D12 — an expense (one service line, no item) is not typed into the
  // stock grid: it is read as it was entered by Add expense.
  const mayEdit =
    invoice.status === 'draft' &&
    invoice.purchaseOrderId === null &&
    invoice.expenseCategoryCode === null &&
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
    parseDecimal(invoice.settledAmountIqd, MONEY_SCALE) === 0n &&
    can(principal, 'reverse_cancel', ap.PERMISSION_OBJECT);

  const today = businessToday();
  const paymentState = expenses.paymentState(
    {
      status: invoice.status,
      dueDate: invoice.dueDate,
      totalIqd: invoice.totalIqd,
      settledAmountIqd: invoice.settledAmountIqd,
    },
    today,
  );
  const stateTone =
    paymentState === 'paid' ? 'settled' : paymentState === 'overdue' ? 'rejected' : paymentState === 'part_paid' ? 'partially_executed' : 'submitted';
  // "Mark paid" — offered to whoever may post a supplier payment, on a posted
  // invoice with something still owed (D12).
  const mayMarkPaid =
    (invoice.status === 'posted' || invoice.status === 'partially_executed') &&
    paymentState !== 'paid' &&
    can(principal, 'post', 'supplier_payment');
  const importApplication = found.importApplication;

  // The paperwork: how many there are, and whether this person may add one.
  const attached = await withCurrentUser((tx) =>
    attachmentsService.currentFor(tx, ap.PERMISSION_OBJECT, invoice.id),
  );
  const mayAttach = can(context.principal, 'create', 'attachment');

  /*
   * The advance, by `advanceOf` — the same arithmetic the posting uses to
   * raise the payment application, so the record and the request to the bank
   * cannot differ. Against the total summed from the lines, because
   * `total_iqd` is written at posting and is zero before it.
   */
  const advanceIqd = advanceOf(total, invoice.advancePercent);
  /** "20.0000" is 20; "20.5000" is 20.5. Trailing zeroes say nothing. */
  const trimPercent = (percent: string) => percent.replace(/\.?0+$/, '');

  const fields: DocumentField[] = [
    { label: column('invoice_no'), value: <bdi dir="ltr">{invoice.invoiceNo}</bdi> },
    ...(importApplication
      ? [
          {
            label: x('import_application'),
            value: (
              <Link
                className={s.sapLink}
                href={`/payables/${encodeURIComponent(importApplication.payableNo)}`}
              >
                <bdi dir="ltr">{importApplication.payableNo}</bdi>
              </Link>
            ),
          },
        ]
      : []),
    ...(invoice.expenseCategoryCode
      ? [{ label: x('category'), value: <bdi dir="auto">{found.categoryName}</bdi> }]
      : []),
    ...(paymentState !== 'reversed'
      ? [
          {
            label: x('col_payment'),
            value:
              paymentState === 'overdue'
                ? x('state_overdue_days', { days: expenses.daysBetween(invoice.dueDate, today) })
                : x(`state_${paymentState}`),
            status: stateTone,
          },
        ]
      : []),
    { label: column('status'), value: status(invoice.status), status: invoice.status },
    { label: column('supplier_code'), value: <bdi dir="ltr">{supplier?.code ?? '—'}</bdi> },
    { label: column('supplier_name'), value: <bdi dir="auto">{supplier?.name ?? '—'}</bdi> },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(invoice.invoiceDate, locale as Locale)}</bdi>,
    },
    /*
     * The due date, only once there is one (0272).
     *
     * `due_date` cannot be empty, so an invoice entered on advance terms
     * carries the day it was entered; showing that reads as a promise nobody
     * made. `due_date_set_at` is stamped when somebody sets it on purpose.
     */
    ...(invoice.dueDateSetAt
      ? [
          {
            label: column('due_date'),
            value: <bdi dir="ltr">{formatBusinessDate(invoice.dueDate, locale as Locale)}</bdi>,
          },
        ]
      : []),
    /*
     * What the supplier's invoice was agreed in, and the rate its dinars were
     * worked out at — "the purchase invoice orignallay issued in usd"
     * (2026-10-03). Nothing to say when it was agreed in dinars.
     */
    ...(invoice.agreedCurrency && invoice.agreedRate
      ? [
          {
            label: x('agreed_in'),
            value: (
              <bdi dir="ltr">
                {/*
                  The rate is published at eight decimal places and the money
                  scale is four, so it is read at its own scale and said as
                  what one unit is worth — `toIqd`, the same step the new
                  invoice's header takes. Parsing it as money threw
                  (2026-10-03).
                */}
                {`${invoice.agreedCurrency} · 1 ${invoice.agreedCurrency} = ${money(
                  toDecimalString(
                    toIqd(parseDecimal('1', MONEY_SCALE), parseDecimal(invoice.agreedRate, RATE_SCALE)),
                    MONEY_SCALE,
                  ),
                )}`}
              </bdi>
            ),
          },
        ]
      : []),
    /*
     * What was agreed to be paid in front, and what that comes to — the figure
     * the payment application is raised for when the account is named (§15.3).
     */
    ...(invoice.advancePercent && advanceIqd !== null
      ? [
          {
            label: x('advance_percent'),
            value: (
              <bdi dir="ltr">
                {`${trimPercent(invoice.advancePercent)}% · ${money(
                  toDecimalString(advanceIqd, MONEY_SCALE),
                )}`}
              </bdi>
            ),
          },
        ]
      : []),

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
      back={{ href: '/payables/invoices', label: t('back') }}
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
            {importApplication ? (
              <Link
                className="action"
                href={`/payables/${encodeURIComponent(importApplication.payableNo)}`}
              >
                {x('import_tracking')}
              </Link>
            ) : null}
            {/*
              Set due date is hidden (2026-10-03, by direction). The invoice is
              entered without one because the company buys on advance, and the
              moment the date becomes known — the bank confirms the transfer and
              the supplier names the day for the balance — has not been settled.
              `setDueDateAction` and `ap.setDueDate` stay where they are for
              when it is.
            */}
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
        titleActions={
          <>
            {/* Printer, paperclip, notes, clock — the printer first, as asked
                (2026-10-03). The document is what is left underneath. */}
            <ExportIcon
              exportKey="purchase_invoice"
              id={invoice.invoiceNo}
              title={`${page('ap_invoice')} ${invoice.invoiceNo}`}
            />
            <AttachmentsButton
              closeLabel={t('close')}
              count={attached.length}
              label={t('attachments.title')}
              title={t('attachments.title')}
            >
              <Attachments
                action={attachToInvoice}
                hidden={{ invoice_no: invoice.invoiceNo }}
                mayAttach={mayAttach}
                objectId={invoice.id}
                objectType={ap.PERMISSION_OBJECT}
              />
            </AttachmentsButton>
            <NotesButton
              closeLabel={t('close')}
              count={found.notes.length}
              label={x('notes')}
              title={x('notes')}
            >
              <div className={s.sapTableWrap}>
                <table className={s.sapTable}>
                  <thead>
                    <tr>
                      <th scope="col">{x('note_when')}</th>
                      <th scope="col">{x('note_who')}</th>
                      <th scope="col">{x('note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.notes.length === 0 ? (
                      <tr>
                        <td className={s.sapEmptyRow} colSpan={3}>
                          {x('no_notes')}
                        </td>
                      </tr>
                    ) : null}
                    {found.notes.map((note) => (
                      <tr key={note.id}>
                        <td>
                          <bdi dir="ltr">{note.createdAt.slice(0, 16)}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{note.author ?? '—'}</bdi>
                        </td>
                        <td>
                          <bdi dir="auto">{note.note}</bdi>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Form action={addInvoiceNoteAction}>
                <input name="id" type="hidden" value={invoice.id} />
                <input name="invoice_no" type="hidden" value={invoice.invoiceNo} />
                <Field hint={x('note_hint')} label={x('add_note')} name="note" required wide />
                <SubmitRow>
                  <Submit label={x('add_note')} small tone="secondary" />
                </SubmitRow>
              </Form>
            </NotesButton>
            <HistoryButton closeLabel={t('close')} label={t('history')} title={t('history')}>
              <RecordHistory objectId={invoice.id} objectType={ap.PERMISSION_OBJECT} />
            </HistoryButton>
          </>
        }
        documentType={page('ap_invoice')}
        fields={fields}
        id="ap-invoice-document"
        linesCount={lines.length}
        linesTitle={t('ap_invoices.lines')}
        number={invoice.invoiceNo}
        totals={[{ label: column('total_price'), value: money(toDecimalString(total, MONEY_SCALE)) }]}
      >
        {mayEdit ? (
          <InvoiceLinesGrid
            currency="IQD"
            headingId="ap-invoice-document-lines-heading"
            items={found.stockItems}
            loadAvailability={invoiceLineAvailability}
            mode="purchase"
            unitColumn
            purchaseSupplierId={invoice.supplierId}
            widthsKey={`erp.lines.ap.${context.principal.userId}`}
            labels={{
              itemCode: column('item_code'),
              itemName: column('item_name'),
              quantity: column('quantity'),
              unit: column('unit'),
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
                uomCode: line.uomCode,
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
                    <bdi dir="ltr">{money(toDecimalString(lineTotal(line), MONEY_SCALE))}</bdi>
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
                  <bdi dir="ltr">{money(toDecimalString(total, MONEY_SCALE))}</bdi>
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

      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
