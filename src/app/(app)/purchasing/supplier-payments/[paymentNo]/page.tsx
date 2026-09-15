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
import * as payments from '@/server/services/supplier-payment';
import { allocatePayment, postPayment } from '../actions';

/**
 * One Payment — Operations build, block 6.
 *
 *   "Payments can be allocated to the related supplier invoice, including
 *    partial payment."
 *
 * Which is why the allocation is a row per invoice with its own amount box,
 * pre-filled with whatever is outstanding but editable. A partial payment is
 * the ordinary case rather than an exception, and a form that assumed the whole
 * balance would make the ordinary case the awkward one.
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
    return { ...seen, open: await payments.openInvoicesFor(tx, seen.payment.supplierId) };
  });

  if (!found) notFound();
  const { payment, unallocated, open } = found;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const mayAllocate = unallocated > 0n && can(principal, 'post', payments.PERMISSION_OBJECT);
  const mayPost =
    ['draft', 'approved'].includes(payment.status) &&
    can(principal, 'post', payments.PERMISSION_OBJECT);

  return (
    <AdminPage
      actions={
        <>
        mayPost ? (
          <form action={postPayment}>
            <input name="id" type="hidden" value={payment.id} />
            <input name="payment_no" type="hidden" value={payment.paymentNo} />
            <button className="action action--primary" type="submit">
              {t('supplier_payments.post')}
            </button>
          </form>
        ) : null
          <AuditLogButton label={t('history')} />
        </>
      }
      back={{ href: '/purchasing/supplier-payments', label: t('supplier_payments.title') }}
      tabs={<SectionTabs route="/purchasing/supplier-payments" />}
      subtitle={t('supplier_payments.subtitle')}
      title={payment.paymentNo}
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
            <span className={`status status--${payment.status}`} data-status={payment.status}>
              {status(payment.status)}
            </span>
          </dd>
        </div>
        <div>
          <dt>{column('posting_date')}</dt>
          <dd>
            <bdi dir="ltr">{formatBusinessDate(payment.paymentDate, locale as Locale)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('supplier_payments.amount')}</dt>
          <dd>
            <bdi dir="ltr">{money(payment.amountIqd)}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t('supplier_payments.unallocated')}</dt>
          <dd>
            <bdi dir="ltr">{money(toDecimalString(unallocated, 4n))}</bdi>
          </dd>
        </div>
        {payment.reference ? (
          <div>
            <dt>{t('supplier_payments.reference')}</dt>
            <dd>
              <bdi dir="auto">{payment.reference}</bdi>
            </dd>
          </div>
        ) : null}
      </dl>

      <h2 className={s.sapTitle}>
        <span>{t('supplier_payments.invoice')}</span>
      </h2>

      <div className={s.sapTableWrap}>
        <table className={s.sapTable}>
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
                <td className={s.sapEmptyRow} colSpan={mayAllocate ? 4 : 3}>
                  {t('supplier_payments.no_open_invoices')}
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
                    <form action={allocatePayment} className="row-form">
                      <input name="id" type="hidden" value={payment.id} />
                      <input name="payment_no" type="hidden" value={payment.paymentNo} />
                      <input name="ap_invoice_id" type="hidden" value={invoice.id} />
                      <input
                        aria-label={`${t('supplier_payments.allocate')} ${invoice.invoiceNo}`}
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
                        {t('supplier_payments.allocate')}
                      </button>
                    </form>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <RecordHistory objectId={payment.id} objectType={payments.PERMISSION_OBJECT} />
    </AdminPage>
  );
}
