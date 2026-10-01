import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { ExportMenu } from '@/components/print/export-menu';
import { PrintSheet } from '@/components/print/print-sheet';
import { printSheet } from '@/server/print/sheet';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/customer-receipt';
import { allocateOldestFirst, allocateReceipt, approveReceipt, postReceipt } from '../actions';

/**
 * One Receipt — Operations build, block 6.
 *
 *   Receipts  Customer Name; Customer Code; Date; Bank/Cash Name; Bank/Cash
 *             Code; Amount; Reference; Customer Invoice.
 *   Journal   Bank or Cash Dr. / Accounts Receivable Cr.
 *
 * Wearing the Journal Entry's window, like every other document here. Its lines
 * are the customer's open invoices, each with its own amount box, because
 * partial receipt is the ordinary case.
 *
 * Allocation waits for posting, and that is the service's rule rather than this
 * page's: until the money is in the ledger it has settled nothing. A receipt
 * whose payer is unknown cannot settle anybody's debt at all (§16), and offers
 * no invoices rather than guessing at a debt to clear.
 */
export const dynamic = 'force-dynamic';

export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ receiptNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/sales/customer-receipts')) notFound();

  const [t, page, column, status, locale, context, outcome, { receiptNo }] = await Promise.all([
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
  if (!can(principal, 'view', receipts.PERMISSION_OBJECT)) {
    return <Denied object={page('customer_receipts')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    // `view` answers with the receipt, what it has been put against, and what
    // is left — all three wanted together, and working the last out twice is
    // how two figures start to differ.
    const seen = await receipts.viewByNo(tx, decodeURIComponent(receiptNo));
    if (!seen) return null;
    // §16 — a receipt whose payer is unknown has no invoices to offer, and
    // asking for them by a null customer would be asking the wrong question.
    const open = seen.customerId ? await receipts.openInvoicesFor(tx, seen.customerId) : [];
    return {
      receipt: seen,
      open,
      // What oldest-first would give each invoice. The boxes used to offer
      // every row the whole of the receipt, so two rows offered the same money
      // twice and the second submit was refused as an over-allocation.
      plan: await receipts.planFor(tx, seen),
      parties: await receipts.partiesOf(tx, seen.id),
    };
  });

  if (!found) notFound();
  const { receipt, open, plan, parties } = found;
  const unallocated = receipt.unappliedIqd;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const mayAllocate =
    receipt.status === 'posted' &&
    unallocated > 0n &&
    Boolean(receipt.customerId) &&
    can(principal, 'execute', receipts.PERMISSION_OBJECT);
  const mayApprove =
    receipt.status === 'draft' && can(principal, 'approve', receipts.PERMISSION_OBJECT);
  const mayPost =
    receipt.status === 'approved' && can(principal, 'post', receipts.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    // The number, not "Reference" — the reference is the field below, and two
    // boxes with one label read as one of them being wrong (and were one React
    // key, which is how the duplication was found).
    { label: column('document_no'), value: <bdi dir="ltr">{receipt.receiptNo}</bdi> },
    { label: column('status'), value: status(receipt.status), status: receipt.status },
    // Who paid and into which account: the two things the form asked for and
    // the document did not say back. The printed copy has carried them all
    // along, so the screen was the odd one out. §16 — a receipt whose payer is
    // unknown says so rather than naming nobody.
    { label: column('customer_code'), value: <bdi dir="ltr">{parties.customerCode ?? '—'}</bdi> },
    { label: column('customer_name'), value: <bdi dir="auto">{parties.customerName ?? '—'}</bdi> },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(receipt.receiptDate, locale as Locale)}</bdi>,
    },
    { label: column('bank_code'), value: <bdi dir="ltr">{parties.bankCode ?? '—'}</bdi> },
    { label: column('bank_name'), value: <bdi dir="auto">{parties.bankName ?? '—'}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{receipt.branchCode}</bdi> },
    {
      label: t('customer_receipts.amount'),
      value: <bdi dir="ltr">{money(receipt.amountIqd)}</bdi>,
    },
    {
      label: t('customer_receipts.unallocated'),
      value: <bdi dir="ltr">{money(toDecimalString(unallocated, 4n))}</bdi>,
    },
    {
      label: t('customer_receipts.reference'),
      value: <bdi dir="auto">{receipt.bankReference ?? '—'}</bdi>,
    },
  ];

  const sheet = await printSheet('customer_receipt', receipt.receiptNo);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="customer_receipt" id={receipt.receiptNo} />}
      back={{ href: '/sales/customer-receipts', label: t('back') }}
      title={receipt.receiptNo}
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
              <form action={approveReceipt}>
                <input name="id" type="hidden" value={receipt.id} />
                <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
                <Submit label={t('customer_receipts.approve')} variant="document" />
              </form>
            ) : null}
            {mayPost ? (
              <form action={postReceipt}>
                <input name="id" type="hidden" value={receipt.id} />
                <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
                <Submit label={t('customer_receipts.post')} variant="document" />
              </form>
            ) : null}
            {/* The whole plan in one press, for the ordinary case where the
                customer sent money without saying which invoice it pays. */}
            {mayAllocate && plan.size > 0 ? (
              <form action={allocateOldestFirst}>
                <input name="id" type="hidden" value={receipt.id} />
                <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
                <Submit
                  label={t('customer_receipts.allocate_oldest_first')}
                  tone="secondary"
                  variant="document"
                />
              </form>
            ) : null}
          </>
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('customer_receipts')}
        fields={fields}
        id="receipt-document"
        linesCount={open.length}
        linesTitle={t('customer_receipts.invoice')}
        number={receipt.receiptNo}
        totals={[
          { label: t('customer_receipts.amount'), value: money(receipt.amountIqd) },
          { label: t('customer_receipts.allocated'), value: money(receipt.allocatedIqd) },
        ]}
      >
        <table aria-labelledby="receipt-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('reference')}</th>
              <th scope="col">{column('due_date')}</th>
              <th className={s.sapNum} scope="col">
                {t('customer_receipts.outstanding')}
              </th>
              {mayAllocate ? <th scope="col" /> : null}
            </tr>
          </thead>
          <tbody>
            {open.length === 0 ? (
              <tr>
                <td colSpan={mayAllocate ? 4 : 3}>{t('customer_receipts.no_open_invoices')}</td>
              </tr>
            ) : null}
            {open.map((invoice) => (
              <tr key={invoice.id}>
                <td className={s.sapAccountCell}>
                  <bdi dir="ltr">{invoice.invoiceNo}</bdi>
                </td>
                <td>
                  <bdi dir="ltr">{formatBusinessDate(invoice.dueDate, locale as Locale)}</bdi>
                </td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(toDecimalString(invoice.outstanding, 4n))}</bdi>
                </td>
                {mayAllocate ? (
                  <td>
                    <form action={allocateReceipt} className={s.fieldWithAction}>
                      <input name="id" type="hidden" value={receipt.id} />
                      <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
                      <input name="ar_invoice_id" type="hidden" value={invoice.id} />
                      <input
                        aria-label={`${t('customer_receipts.allocate')} ${invoice.invoiceNo}`}
                        className={s.sapCellField}
                        // A whole dinar. `toDecimalString(_, 4n)` put "50000.0000"
                        // in the box: the dinar has no minor unit, and four
                        // decimal places in a figure somebody is about to
                        // retype reads as a fault in the amount.
                        // This invoice's share under oldest-first, so the
                        // amounts down the column add up to the receipt.
                        defaultValue={String(Number(toDecimalString(plan.get(invoice.id) ?? 0n, 4n)))}
                        inputMode="decimal"
                        name="amount_iqd"
                      />
                      <Submit label={t('customer_receipts.allocate')} tone="secondary" variant="document" />
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={receipt.id} objectType={receipts.PERMISSION_OBJECT} />
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
