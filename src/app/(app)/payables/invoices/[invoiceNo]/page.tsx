import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { AdminPage, Field, Flash, Form, Grid, Select, admin as s, Submit, SubmitRow } from '@/components/admin';
import { NewRecordDialog } from '@/components/admin/dialog';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { InvoiceSettlement } from '@/components/admin/invoice-settlement';
import { InvoiceLinesGrid } from '@/components/admin/invoice-lines-grid';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
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
import { invoiceLineAvailability, markPaidAction, postApInvoice, removeApInvoiceLine, reverseApInvoice, saveApInvoiceAccounts, saveApInvoiceLine, setDueDateAction, submitApInvoice } from '../actions';
import * as supplierNotes from '@/server/services/supplier-notes';
import { PurchaseDoors, readDoors } from '../../record-doors';
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

/**
 * The warehouses a draft's lines may name: the branch's ordinary ones — and
 * whichever its lines already name.
 *
 * An import's lines are saved into its stage warehouse (In Process), which is
 * not an ordinary warehouse and so was not on the list: the box then showed
 * the first warehouse it did have ("WH-HQ") beside a record that says
 * "WH-INPROC" — the screen and the books disagreeing about where the goods
 * go (found 2026-10-05, from a screenshot). A line shows what it holds.
 */
async function housesFor(tx: Parameters<typeof warehouses.listActive>[0], branchCode: string, named: readonly (string | null)[]) {
  const offered = (await warehouses.listActive(tx)).filter((house) => house.branchCode === branchCode);
  const missing = [...new Set(named.filter((code): code is string => Boolean(code)))].filter((code) => !offered.some((house) => house.code === code));
  if (missing.length === 0) return offered;
  const every = await warehouses.listForReports(tx);
  return [...offered, ...every.filter((house) => missing.includes(house.code)).map((house) => ({ code: house.code, name: house.name, branchCode: house.branchCode }))];
}

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
      // The four doors' reads (notes from the trail, the files), and the
      // credit and debit notes that adjust this invoice (PAY8/PAY9).
      doors: await readDoors(tx, principal, { object: ap.PERMISSION_OBJECT, recordId: document.invoice.id }),
      adjustments: await supplierNotes.adjustmentsOf(tx, document.invoice.id),
      adjusts: document.invoice.adjustsInvoiceId ? await ap.view(tx, document.invoice.adjustsInvoiceId).then((seen) => seen.invoice.invoiceNo).catch(() => null) : null,
      // D12 / D13 — the accounts a payment may leave from, and the import
      // application behind this invoice, if any.
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
      houses: editable ? await housesFor(tx, document.invoice.branchCode, document.lines.map((line) => line.warehouseCode)) : [],
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
  // The account named opens its own profile (the shared `ProfileLink`, 2026-10-04);
  // the default and a broken link are said in words.
  const accountLabel = (id: string | null) => {
    if (!id) return <bdi dir="auto">{t('invoices.account_default')}</bdi>;
    const account =
      accounts.find((row) => row.id === id) ??
      found.chosenAccounts.find((row) => row?.id === id);
    // An id naming nothing at all is a broken link, not a default.
    return account ? (
      <ProfileLink code={account.code} dir="auto" kind="gl_account" name={account.name} />
    ) : (
      <bdi dir="auto">{t('invoices.account_missing')}</bdi>
    );
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
      accountLabel(current)
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

  const self = `/payables/invoices/${encodeURIComponent(invoice.invoiceNo)}`;

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
    // The supplier, as a link to its profile — "like bank loans" (2026-10-04).
    { label: column('supplier_code'), value: <ProfileLink code={supplier?.code} kind="supplier">{supplier?.code ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={supplier?.code} dir="auto" kind="supplier">
          {supplier?.name ?? '—'}
        </ProfileLink>
      ),
    },
    // PAY9 — a debit note names the invoice it adjusts.
    ...(found.adjusts ? [{ label: t('supplier_notes.invoice'), value: <ProfileLink code={found.adjusts} kind="purchase_invoice" /> }] : []),
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
          <PurchaseDoors
            doors={found.doors}
            exportId={invoice.invoiceNo}
            exportKey="purchase_invoice"
            object={ap.PERMISSION_OBJECT}
            recordId={invoice.id}
            returnTo={self}
            title={`${page('ap_invoice')} ${invoice.invoiceNo}`}
          />
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
                  {/* The item and the warehouse open their own profiles (the shared `ProfileLink`, 2026-10-04). */}
                  <td className={s.sapAccountCell}>
                    <ProfileLink code={line.itemCode} kind="item" />
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
                    <ProfileLink code={line.warehouseCode} kind="warehouse" />
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

      {/* PAY8/PAY9 — what adjusts this invoice: credit notes applied to it,
          debit notes raised on it. Each is its own record; this is the index. */}
      <section aria-labelledby="ap-invoice-adjustments-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="ap-invoice-adjustments-title">
            <span>{t('payables_record.adjustments')}</span>
            <span className={s.sapTitleMeta}>{t('payables_orders.rows', { count: found.adjustments.length })}</span>
          </h2>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{t('supplier_notes.col_kind')}</th>
                  <th scope="col">{t('supplier_notes.col_no')}</th>
                  <th scope="col">{column('date')}</th>
                  <th scope="col">{column('status')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('supplier_notes.amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {found.adjustments.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={5}>
                      {t('payables_record.no_adjustments')}
                    </td>
                  </tr>
                ) : null}
                {found.adjustments.map((row) => (
                  <tr key={`${row.kind}-${row.number}`}>
                    <td>{t(`supplier_notes.kind_${row.kind}`)}</td>
                    <td className={s.sapAccountCell}>
                      <ProfileLink code={row.number} kind={row.kind === 'credit' ? 'supplier_credit_note' : 'purchase_invoice'} />
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(row.noteDate, locale as Locale)}</bdi>
                    </td>
                    <td>
                      <span className={`status status--${row.status}`} data-status={row.status}>
                        {status(row.status)}
                      </span>
                    </td>
                    <td className={s.sapNum}>
                      <bdi dir="ltr">{money(row.amountIqd)}</bdi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
