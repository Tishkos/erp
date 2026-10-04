import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { admin as s } from '@/components/admin';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { withCurrentUser } from '@/server/session';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '@domain/money';
import * as openItems from '@/server/services/open-items';
import * as notes from '@/server/services/customer-notes';
import { businessToday } from '@/server/domain/business-date';

/**
 * What rests on a sales invoice — Receivables, 2026-10-04.
 *
 * > "From an Invoice, the user should be able to see: receipts applied,
 * > credit notes, sales returns, remaining balance."
 *
 * A register stacked under the invoice in the supplier-statement manner. The
 * receipts and credits are the open item's own (`open-items.ts`, the service
 * the ageing reads), so the invoice and the ageing cannot disagree about what
 * settled it; the notes and returns raised against it are listed with their
 * own status, because a return still being inspected has credited nothing yet
 * and should say so.
 */
export async function ReceivableInvoiceActivity({
  invoiceId,
  invoiceNo,
  customerCode,
}: {
  readonly invoiceId: string;
  readonly invoiceNo: string;
  /** Narrows the read to this customer's items rather than the whole book. */
  readonly customerCode: string | null;
}) {
  const [t, column, status, locale] = await Promise.all([
    getTranslations('admin.receivables_ageing'),
    getTranslations('column'),
    getTranslations('status'),
    getLocale(),
  ]);

  const found = await withCurrentUser(async (tx, request) => {
    const items = await openItems
      .openItems(tx, request.principal, 'customer', businessToday(), {
        branchCode: null,
        ...(customerCode ? { partyCode: customerCode } : {}),
      })
      .catch(() => []);
    return {
      item: items.find((row) => row.invoiceId === invoiceId) ?? null,
      raised: await notes.againstInvoice(tx, invoiceId),
    };
  }).catch(() => null);
  // A draft is not a debt: nothing rests on it yet, and an empty register
  // would imply the question had been asked.
  if (!found?.item) return null;
  const { item, raised } = found;

  const money = (amount: string) => formatMoney(amount, 'IQD', locale as Locale);
  const day = (value: string) => formatBusinessDate(value, locale as Locale);
  const statusLabel = (value: string) => (status.has(value) ? status(value) : value);

  interface Row {
    readonly key: string;
    readonly date: string;
    /** Already translated — what the row is. */
    readonly what: string;
    readonly href: string;
    readonly number: string;
    readonly amount: string | null;
    readonly status: string | null;
  }
  const rows: Row[] = [
    ...item.payments.map((payment, index) => ({
      key: `receipt-${index}`,
      date: payment.paidOn,
      what: t('applied_receipt'),
      href: `/sales/customer-receipts/${encodeURIComponent(payment.documentNo ?? '')}`,
      number: payment.documentNo ?? '—',
      amount: payment.amountIqd,
      status: null,
    })),
    ...item.credits.map((credit, index) => ({
      key: `credit-${index}`,
      date: credit.appliedOn,
      what: t(credit.kind === 'credit_memo' ? 'applied_credit_memo' : 'applied_credit_note'),
      href: `/sales/credit-notes/${encodeURIComponent(credit.documentNo)}`,
      number: credit.documentNo,
      amount: credit.amountIqd,
      status: null,
    })),
    ...raised.notes
      .filter((note) => note.kind === 'debit')
      .map((note) => ({
        key: `debit-${note.noteNo}`,
        date: note.noteDate,
        what: t('raised_debit_note'),
        href: `/sales/credit-notes/${encodeURIComponent(note.noteNo)}`,
        number: note.noteNo,
        amount: note.amountIqd,
        status: note.status,
      })),
    ...raised.notes
      .filter((note) => note.kind === 'credit' && !item.credits.some((credit) => credit.documentNo === note.noteNo))
      .map((note) => ({
        key: `credit-note-${note.noteNo}`,
        date: note.noteDate,
        what: t('raised_credit_note'),
        href: `/sales/credit-notes/${encodeURIComponent(note.noteNo)}`,
        number: note.noteNo,
        amount: note.amountIqd,
        status: note.status,
      })),
    ...raised.returns.map((row) => ({
      key: `return-${row.returnNo}`,
      date: row.requestedOn,
      what: t('sales_return'),
      href: `/sales/sales-returns/${encodeURIComponent(row.returnNo)}`,
      number: row.returnNo,
      amount: null,
      status: row.status,
    })),
  ].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <section aria-labelledby="invoice-activity-title" className={s.sapDoc}>
      <div className={s.sapWindow}>
        <h2 className={s.sapTitle} id="invoice-activity-title">
          <span>{t('activity_title')}</span>
          <span className={s.sapTitleMeta}>{invoiceNo}</span>
        </h2>
        <div className={s.sapTableWrap}>
          <table aria-labelledby="invoice-activity-title" className={s.sapTable}>
            <thead>
              <tr>
                <th scope="col">{column('date')}</th>
                <th scope="col">{t('activity_kind')}</th>
                <th scope="col">{column('reference')}</th>
                <th scope="col">{column('status')}</th>
                <th className={s.sapNum} scope="col">{column('amount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td className={s.sapEmptyRow} colSpan={5}>
                    {t('activity_none')}
                  </td>
                </tr>
              ) : null}
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>
                    <bdi dir="ltr">{day(row.date)}</bdi>
                  </td>
                  <td>{row.what}</td>
                  <td className={s.sapAccountCell}>
                    <Link className={s.sapLink} href={row.href}>
                      <bdi dir="ltr">{row.number}</bdi>
                    </Link>
                  </td>
                  <td>
                    {row.status ? (
                      <span className={`status status--${row.status}`} data-status={row.status}>
                        {statusLabel(row.status)}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className={s.sapNum}>
                    <bdi dir="ltr">{row.amount ? money(row.amount) : '—'}</bdi>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={s.sapTotalRow}>
                <td colSpan={4}>{column('total_price')}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">{money(item.totalIqd)}</bdi>
                </td>
              </tr>
              <tr className={s.sapTotalRow}>
                <td colSpan={4}>{t('paid_and_credited')}</td>
                <td className={s.sapNum}>
                  <bdi dir="ltr">
                    {money(
                      toDecimalString(
                        parseDecimal(item.paidIqd, MONEY_SCALE) +
                          parseDecimal(item.creditsAppliedIqd, MONEY_SCALE) +
                          parseDecimal(item.otherAppliedIqd, MONEY_SCALE),
                        MONEY_SCALE,
                      ),
                    )}
                  </bdi>
                </td>
              </tr>
              <tr className={s.sapTotalRow} data-rule="double">
                <td colSpan={4}>
                  <strong>{t('remaining_balance')}</strong>
                </td>
                <td className={s.sapNum}>
                  <strong>
                    <bdi dir="ltr">{money(item.outstandingIqd)}</bdi>
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
  );
}
