import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s, Submit} from '@/components/admin';
import { DocumentWindow, type DocumentField } from '@/components/admin/document-window';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { ProfileLink } from '@/components/admin/profile-link';
import { DueDateText } from '@/components/admin/due-date-text';
import { Denied } from '@/components/denied';
import { PrintSheet } from '@/components/print/print-sheet';
import { printSheet } from '@/server/print/sheet';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { businessDateOf } from '@/server/domain/business-date';
import { visibleRoute } from '@/server/delivered';
import { requireContext, withCurrentUser } from '@/server/session';
import * as payments from '@/server/services/supplier-payment';
import * as paymentApplications from '@/server/services/payment-applications';
import { allocateOldestFirstPayment, allocatePayment, postPayment } from '../actions';
import { PurchaseDoors, readDoors } from '../../record-doors';

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
 *
 * REQ-PAY-001 (2026-10-04): the four doors in the title bar from the draft
 * on; the supplier and the account as links to their profiles; and, under
 * the document, what this payment has been put against — the allocation
 * lives here, on the payment, not on the payment application (which is the
 * request to the bank; owner's decision 4.6).
 */
export const dynamic = 'force-dynamic';

export default async function PaymentPage({
  params,
  searchParams,
}: {
  params: Promise<{ paymentNo: string }>;
  searchParams: SearchParams;
}) {
  if (!visibleRoute('/payables/supplier-payments')) notFound();

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
      // What oldest-first would give each invoice. The boxes used to offer
      // every row the whole of the payment, so two rows offered the same money
      // twice and the second submit was refused as an over-allocation.
      plan: await payments.planFor(tx, seen.payment),
      parties: await payments.partiesOf(tx, seen.payment.id),
      // REQ-AP-001 §21.13 — a payment confirmed from a payment application
      // links back to it.
      application: await paymentApplications.forSupplierPayment(tx, seen.payment.id),
      // What it has been put against, live allocations only.
      allocations: await payments.allocationsOf(tx, seen.payment.id),
      doors: await readDoors(tx, principal, { object: payments.PERMISSION_OBJECT, recordId: seen.payment.id }),
    };
  });

  if (!found) notFound();
  const { payment, unallocated, open, plan, parties, application, allocations, doors } = found;
  const self = `/payables/supplier-payments/${encodeURIComponent(payment.paymentNo)}`;
  const accountKind = parties.accountType === 'cash' ? 'cash_account' : 'bank_account';

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
    { label: column('supplier_code'), value: <ProfileLink code={parties.supplierCode} kind="supplier">{parties.supplierCode ?? '—'}</ProfileLink> },
    {
      label: column('supplier_name'),
      value: (
        <ProfileLink code={parties.supplierCode} dir="auto" kind="supplier">
          {parties.supplierName ?? '—'}
        </ProfileLink>
      ),
    },
    {
      label: column('posting_date'),
      value: <bdi dir="ltr">{formatBusinessDate(payment.paymentDate, locale as Locale)}</bdi>,
    },
    { label: column('bank_code'), value: <ProfileLink code={parties.bankCode} kind={accountKind}>{parties.bankCode ?? '—'}</ProfileLink> },
    {
      label: column('bank_name'),
      value: (
        <ProfileLink code={parties.bankCode} dir="auto" kind={accountKind}>
          {parties.bankName ?? '—'}
        </ProfileLink>
      ),
    },
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
    ...(application
      ? [
          {
            label: t('payment_applications.document_type'),
            value: <ProfileLink code={application.applicationNo} kind="payment_application" />,
          },
        ]
      : []),
    ...(payment.amountTxn && payment.currency !== 'IQD'
      ? [
          {
            label: t('payment_applications.col_amount'),
            value: <bdi dir="ltr">{formatMoney(payment.amountTxn, payment.currency, locale as Locale)}</bdi>,
          },
        ]
      : []),
  ];

  const sheet = await printSheet('supplier_payment', payment.paymentNo);

  return (
    <AdminPage
      back={{ href: '/payables/supplier-payments', label: t('back') }}
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
          <>
            {mayPost ? (
              <form action={postPayment}>
                <input name="id" type="hidden" value={payment.id} />
                <input name="payment_no" type="hidden" value={payment.paymentNo} />
                <Submit label={t('supplier_payments.post')} variant="document" />
              </form>
            ) : null}
            {/* The whole plan in one press, for the ordinary case where a
                payment clears whatever is oldest. */}
            {mayAllocate && plan.size > 0 ? (
              <form action={allocateOldestFirstPayment}>
                <input name="id" type="hidden" value={payment.id} />
                <input name="payment_no" type="hidden" value={payment.paymentNo} />
                <Submit
                  label={t('supplier_payments.allocate_oldest_first')}
                  tone="secondary"
                  variant="document"
                />
              </form>
            ) : null}
          </>
        }
        documentType={page('supplier_payments')}
        fields={fields}
        id="payment-document"
        titleActions={
          <PurchaseDoors
            doors={doors}
            exportId={payment.paymentNo}
            exportKey="supplier_payment"
            object={payments.PERMISSION_OBJECT}
            recordId={payment.id}
            returnTo={self}
            title={`${page('supplier_payments')} ${payment.paymentNo}`}
          />
        }
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
                  <ProfileLink code={invoice.invoiceNo} kind="purchase_invoice" />
                </td>
                <td>
                  {/* Only once set on purpose — an advance's balance waits for its SWIFT (2026-10-07). */}
                  <DueDateText date={invoice.dueDateSet ? invoice.dueDate : null} locale={locale} waiting={t('balance_due.waiting')} />
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
                        // This invoice's share under oldest-first, so the
                        // amounts down the column add up to the payment.
                        defaultValue={String(Number(toDecimalString(plan.get(invoice.id) ?? 0n, 4n)))}
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

      {/* Where the money went — the allocation is the payment's own (4.6). */}
      <section aria-labelledby="payment-allocations-title" className={s.sapDoc}>
        <div className={s.sapWindow}>
          <h2 className={s.sapTitle} id="payment-allocations-title">
            <span>{t('supplier_payments.allocated')}</span>
            <span className={s.sapTitleMeta}>{t('payables_orders.rows', { count: allocations.length })}</span>
          </h2>
          <p className={`${s.sapNote} m-0 px-4 py-3 sm:px-5`}>{t('payables_record.allocation_note')}</p>
          <div className={s.sapTableWrap}>
            <table className={s.sapTable}>
              <thead>
                <tr>
                  <th scope="col">{column('invoice_no')}</th>
                  <th scope="col">{column('due_date')}</th>
                  <th scope="col">{column('date')}</th>
                  <th className={s.sapNum} scope="col">
                    {t('supplier_payments.allocated')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {allocations.length === 0 ? (
                  <tr>
                    <td className={s.sapEmptyRow} colSpan={4}>
                      {t('payables_record.no_allocations')}
                    </td>
                  </tr>
                ) : null}
                {allocations.map((row) => (
                  <tr key={`${row.invoiceNo}-${String(row.allocatedAt)}`}>
                    <td className={s.sapAccountCell}>
                      <ProfileLink code={row.invoiceNo} kind="purchase_invoice" />
                    </td>
                    <td>
                      <DueDateText date={row.dueDate} locale={locale} waiting={t('balance_due.waiting')} />
                    </td>
                    <td>
                      <bdi dir="ltr">{formatBusinessDate(businessDateOf(new Date(row.allocatedAt)), locale as Locale)}</bdi>
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
