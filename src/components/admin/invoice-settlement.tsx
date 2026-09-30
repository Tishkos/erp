import { getLocale, getTranslations } from 'next-intl/server';
import { Panel } from '@/components/ui';
import { admin as s } from '@/components/admin';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { withCurrentUser } from '@/server/session';
import * as openItems from '@/server/services/open-items';

/**
 * How an invoice stands against its payment terms.
 *
 * The invoice already says what it is for and what it came to. What it did not
 * say is the part a person chasing money actually needs: which terms set the
 * due date, how much has arrived, what is left, whether it is late and by how
 * much — and, once paid, whether it was paid on time.
 *
 * Read through `open-items.ts`, the same service the Receivables and Payables
 * reports use, so an invoice and the report listing it can never disagree
 * about its own due date or what is left on it. A panel that queried the
 * invoice itself would be a second opinion, and the first time the two
 * differed nobody would know which to believe.
 *
 * The payment history is every allocation, not a total: three payments against
 * one invoice are three rows, each with its date, its amount and the receipt
 * or payment that carried it. Partial payment is the ordinary case, and a
 * screen that collapsed it into one number would lose the story.
 */
export async function InvoiceSettlement({
  side,
  invoiceNo,
}: {
  readonly side: openItems.Side;
  readonly invoiceNo: string;
}) {
  const [t, column, locale] = await Promise.all([
    getTranslations('admin'),
    getTranslations('column'),
    getLocale(),
  ]);

  const asOf = new Date().toISOString().slice(0, 10);
  const items = await withCurrentUser((tx, request) =>
    openItems.openItems(tx, request.principal, side, asOf, {
      branchCode: request.scope.branchCode,
    }),
  ).catch(() => []);

  const item = items.find((row) => row.invoiceNo === invoiceNo);
  // A draft invoice is not a debt and has no position against terms. Saying
  // nothing is right: an empty panel would imply the question was asked.
  if (!item) return null;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const settled = Number(item.outstandingIqd) <= 0;

  const standing = settled
    ? item.daysLateAtLastPayment && item.daysLateAtLastPayment > 0
      ? { text: t('open_items.paid_late', { days: item.daysLateAtLastPayment }), warn: true }
      : { text: t('open_items.paid_on_time'), warn: false }
    : item.daysOverdue > 0
      ? { text: t('open_items.overdue_by', { days: item.daysOverdue }), warn: true }
      : { text: t('open_items.due_in', { days: item.daysUntilDue }), warn: false };

  return (
    <Panel title={t('open_items.settlement')}>
      <div className={s.sapFields}>
        {(
          [
            [t('open_items.terms'), item.paymentTermsName ?? item.paymentTermsCode ?? '—', false],
            [column('invoice_date'), day(item.invoiceDate), false],
            [column('due_date'), day(item.dueDate), false],
            [column('total_price'), money(item.totalIqd), false],
            [t('open_items.paid'), money(item.paidIqd), false],
            [t('open_items.outstanding'), money(item.outstandingIqd), false],
            [
              t('open_items.last_payment'),
              item.lastPaymentDate ? day(item.lastPaymentDate) : '—',
              false,
            ],
            [t('open_items.lateness'), standing.text, standing.warn],
          ] as const
        ).map(([label, value, warn]) => (
          <div className={s.sapField} key={label}>
            <span className={s.sapLabel}>{label}</span>
            <span className={warn ? `${s.sapBox} ${s.sapWarn}` : s.sapBox}>
              <bdi dir="auto">{value}</bdi>
            </span>
          </div>
        ))}
      </div>

      {item.payments.length > 0 ? (
        <div className={s.sapTableWrap}>
          <table className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{column('date')}</th>
                <th scope="col">{column('reference')}</th>
                <th className={s.sapNum} scope="col">
                  {t('open_items.paid')}
                </th>
              </tr>
            </thead>
            <tbody>
              {item.payments.map((payment, index) => (
                <tr key={`${payment.documentNo}-${index}`}>
                  <td>
                    <bdi dir="ltr">{day(payment.paidOn)}</bdi>
                  </td>
                  <td className={s.sapAccountCell}>
                    <bdi dir="ltr">{payment.documentNo ?? '—'}</bdi>
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{money(payment.amountIqd)}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
