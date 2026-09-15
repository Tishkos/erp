import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminPage, Flash, admin as s } from '@/components/admin';
import { AuditLogButton, RecordHistory } from '@/components/admin/history';
import { outcomeOf, type SearchParams } from '@/components/admin/params';
import { Denied } from '@/components/denied';
import { SectionTabs } from '@/components/admin/section-tabs';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { can } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import { visibleRoute } from '@/server/phase-gate';
import { requireContext, withCurrentUser } from '@/server/session';
import * as receipts from '@/server/services/customer-receipt';
import { allocateReceipt, approveReceipt, postReceipt } from '../actions';

/**
 * One Payment — Operations build, block 6.
 *
 *   "Payments can be allocated to the related supplier invoice, including
 *    partial receipt."
 *
 * Which is why the allocation is a row per invoice with its own amount box,
 * pre-filled with whatever is outstanding but editable. A partial payment is
 * the ordinary case rather than an exception, and a form that assumed the whole
 * balance would make the ordinary case the awkward one.
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
    return { receipt: seen, open };
  });

  if (!found) notFound();
  const { receipt, open } = found;
  const unallocated = receipt.unappliedIqd;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  // Allocation waits for posting, and that is the service's rule rather than
  // this page's: until the money is in the ledger it has settled nothing. A
  // receipt with no named payer cannot settle anybody's debt at all (§16), so
  // it offers no invoices either.
  const mayAllocate =
    receipt.status === 'posted' &&
    unallocated > 0n &&
    Boolean(receipt.customerId) &&
    can(principal, 'execute', receipts.PERMISSION_OBJECT);
  const mayApprove =
    receipt.status === 'draft' && can(principal, 'approve', receipts.PERMISSION_OBJECT);
  const mayPost =
    receipt.status === 'approved' && can(principal, 'post', receipts.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        <>
          {mayApprove ? (
            <form action={approveReceipt}>
              <input name="id" type="hidden" value={receipt.id} />
              <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
              <button className="action action--primary" type="submit">
                {t('customer_receipts.approve')}
              </button>
            </form>
          ) : null}
          {mayPost ? (
            <form action={postReceipt}>
              <input name="id" type="hidden" value={receipt.id} />
              <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
              <button className="action action--primary" type="submit">
                {t('customer_receipts.post')}
              </button>
            </form>
          ) : null}
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{ href: '/sales/customer-receipts', label: t('customer_receipts.title') }}
      tabs={<SectionTabs route="/sales/customer-receipts" />}
      subtitle={t('customer_receipts.subtitle')}
      title={receipt.receiptNo}
      variant="sap"
    >
      <Flash
        error={outcome.error}
        errorTitle={t('error_title')}
        saved={outcome.saved}
        savedLabel={t('saved')}
      />

      <dl className={s.inboxFacts}>
        <div>
          <dt>{column('status')}</dt>
          <dd>
            <span className={`status status--${receipt.status}`} data-status={receipt.status}>
              {status(receipt.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{column('posting_date')}</dt>
          <dd>
            <bdi dir="ltr">{formatBusinessDate(receipt.receiptDate, locale as Locale)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('customer_receipts.amount')}</dt>
          <dd>
            <bdi dir="ltr">{money(receipt.amountIqd)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('customer_receipts.unallocated')}</dt>
          <dd>
            <bdi dir="ltr">{money(toDecimalString(unallocated, 4n))}</bdi>
          </dd>
        </div>
        {receipt.bankReference ? (
          <div>
            <dt>{t('customer_receipts.reference')}</dt>
            <dd>
              <bdi dir="auto">{receipt.bankReference}</bdi>
            </dd>
          </div>
        ) : null}
      </dl>

      <h2 className={s.sapTitle}>
        <span>{t('customer_receipts.invoice')}</span>
      </h2>

      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
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
                <td className={s.sapEmptyRow} colSpan={mayAllocate ? 4 : 3}>
                  {t('customer_receipts.no_open_invoices')}
                </td>
              </tr>
            ) : null}
            {open.map((invoice) => (
              <tr key={invoice.id}>
                <td>
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
                    <form action={allocateReceipt} className="row-form">
                      <input name="id" type="hidden" value={receipt.id} />
                      <input name="receipt_no" type="hidden" value={receipt.receiptNo} />
                      <input name="ar_invoice_id" type="hidden" value={invoice.id} />
                      <input
                        aria-label={`${t('customer_receipts.allocate')} ${invoice.invoiceNo}`}
                        className="list__search"
                        // Whatever is left of the payment, or the whole of what
                        // this invoice owes — whichever is smaller. A starting
                        // point, not a decision: the box is editable because
                        // partial payment is the ordinary case.
                        defaultValue={toDecimalString(
                          invoice.outstanding < unallocated ? invoice.outstanding : unallocated,
                          4n,
                        )}
                        inputMode="decimal"
                        name="amount_iqd"
                      />
                      <button className="action" type="submit">
                        {t('customer_receipts.allocate')}
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RecordHistory objectId={receipt.id} objectType={receipts.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
