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
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payments from '@/server/services/supplier-payment';
import { allocatePayment, postPayment } from '../actions';

/**
 * One Payment — Operations build, block 6.
 *
 *   Payments  Supplier Name; Supplier Code; Date; Bank/Cash Name; Bank/Cash
 *             Code; Amount; Reference; Supplier Invoice.
 *   Journal   Accounts Payable Dr. / Bank or Cash Cr.
 *
 * Wearing the Journal Entry's window, like every other document here. Its lines
 * are the supplier's open invoices: *"payments can be allocated to the related
 * supplier invoice, including partial payment"*, so each row carries its own
 * amount box, pre-filled with whatever is outstanding but editable. Partial is
 * the ordinary case, and a form that assumed the whole balance would make the
 * ordinary case the awkward one.
 */
export const dynamic = 'force-dynamic';

export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/purchasing/supplier-payments')) notFound();

  const [t, page, column, status, locale, context, outcome, { paymentNo }] = await Promise.all([
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
  if (!can(principal, 'view', payments.PERMISSION_OBJECT)) {
    return <Denied object={page('supplier_payments')} />;
  }

  const found = await withCurrentUser(async (tx) => {
    // `view` answers with the payment and what is left of it, because the two
    // are always wanted together and working the second out twice is how they
    // start to differ.
    const seen = await payments.viewByNo(tx, decodeURIComponent(paymentNo));
    if (!seen) return null;
    return {
      ...seen,
      open: await payments.openInvoicesFor(tx, seen.payment.supplierId),
      parties: await payments.partiesOf(tx, seen.payment.id),
    };
  });

  if (!found) notFound();
  const { payment, unallocated, open, parties } = found;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const mayAllocate = unallocated > 0n && can(principal, 'post', payments.PERMISSION_OBJECT);
  const mayPost =
    ['draft', 'approved'].includes(payment.status) &&
    can(principal, 'post', payments.PERMISSION_OBJECT);

  const fields: DocumentField[] = [
    // The number, not "Reference" — the reference is the field below, and two
    // boxes with one label read as one of them being wrong (and were one React
    // key, which is how the duplication was found).
    { label: column('document_no'), value: <bdi dir="ltr">{payment.paymentNo}</bdi> },
    { label: column('status'), value: status(payment.status), status: payment.status },
    // Who was paid and out of which account: the two things the form asked for
    // and the document did not say back. The printed copy has carried them all
    // along, so the screen was the odd one out.
    { label: column('supplier_code'), value: <bdi dir="ltr">{parties.supplierCode ?? '—'}</bdi> },
    { label: column('supplier_name'), value: <bdi dir="auto">{parties.supplierName ?? '—'}</bdi> },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(payment.paymentDate, locale as Locale)}</bdi>,
    },
    { label: column('bank_code'), value: <bdi dir="ltr">{parties.bankCode ?? '—'}</bdi> },
    { label: column('bank_name'), value: <bdi dir="auto">{parties.bankName ?? '—'}</bdi> },
    { label: column('branch_code'), value: <bdi dir="ltr">{payment.branchCode}</bdi> },
    {
      label: t('supplier_payments.amount'),
      value: <bdi dir="ltr">{money(payment.amountIqd)}</bdi>,
    },
    {
      label: t('supplier_payments.unallocated'),
      value: <bdi dir="ltr">{money(toDecimalString(unallocated, 4n))}</bdi>,
    },
    {
      label: t('supplier_payments.reference'),
      value: <bdi dir="auto">{payment.reference ?? '—'}</bdi>,
    },
  ];

  const sheet = await printSheet('supplier_payment', payment.paymentNo);

  return (
    <AdminPage
      actions={<ExportMenu exportKey="supplier_payment" id={payment.paymentNo} />}
      back={{ href: '/purchasing/supplier-payments', label: t('back') }}
      title={payment.paymentNo}
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
          mayPost ? (
            <form action={postPayment}>
              <input name="id" type="hidden" value={payment.id} />
              <input name="payment_no" type="hidden" value={payment.paymentNo} />
              <Submit label={t('supplier_payments.post')} variant="document" />
            </form>
          ) : null
        }
        auditHref="#audit-log"
        auditLabel={t('history')}
        documentType={page('supplier_payments')}
        fields={fields}
        id="payment-document"
        linesCount={open.length}
        linesTitle={t('supplier_payments.invoice')}
        number={payment.paymentNo}
        totals={[
          { label: t('supplier_payments.amount'), value: money(payment.amountIqd) },
          { label: t('supplier_payments.allocated'), value: money(payment.allocatedAmountIqd) },
        ]}
      >
        <table aria-labelledby="payment-document-lines-heading" className={s.sapTable}>
          <thead>
            <tr>
              <th scope="col">{column('reference')}</th>
              <th scope="col">{column('due_date')}</th>
              <th className={s.sapNum} scope="col">
                {t('supplier_payments.outstanding')}
              </th>
              {mayAllocate ? <th scope="col" /> : null}
            </tr>
          </thead>
          <tbody>
            {open.length === 0 ? (
              <tr>
                <td colSpan={mayAllocate ? 4 : 3}>{t('supplier_payments.no_open_invoices')}</td>
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
                    <form action={allocatePayment} className={s.fieldWithAction}>
                      <input name="id" type="hidden" value={payment.id} />
                      <input name="payment_no" type="hidden" value={payment.paymentNo} />
                      <input name="ap_invoice_id" type="hidden" value={invoice.id} />
                      <input
                        aria-label={`${t('supplier_payments.allocate')} ${invoice.invoiceNo}`}
                        className={s.sapCellField}
                        // Whatever is left of the payment, or the whole of what
                        // this invoice owes — whichever is smaller. A starting
                        // point, not a decision: the box is editable because
                        // partial payment is the ordinary case.
                        // A whole dinar. `toDecimalString(_, 4n)` put "50000.0000"
                        // in the box: the dinar has no minor unit, and four
                        // decimal places in a figure somebody is about to
                        // retype reads as a fault in the amount.
                        defaultValue={String(
                          Number(
                            toDecimalString(
                              invoice.outstanding < unallocated ? invoice.outstanding : unallocated,
                              4n,
                            ),
                          ),
                        )}
                        inputMode="decimal"
                        name="amount_iqd"
                      />
                      <Submit label={t('supplier_payments.allocate')} tone="secondary" variant="document" />
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </DocumentWindow>

      <RecordHistory objectId={payment.id} objectType={payments.PERMISSION_OBJECT} />
      {sheet ? <PrintSheet {...sheet} /> : null}
    </AdminPage>
  );
}
