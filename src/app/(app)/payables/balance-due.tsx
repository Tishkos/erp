import { getTranslations } from 'next-intl/server';
import { admin as s } from '@/components/admin';
import { BalanceDueDialog, type BalanceDueDialogProps } from '@/components/admin/balance-due-dialog';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { businessDateOf } from '@/server/domain/business-date';
import { owedOn } from '@/server/domain/balance-due';
import { MONEY_SCALE, toDecimalString } from '@/server/domain/money';
import type { ImportDuePrompt } from '@/server/services/balance-due';
import { setBalanceDueDateAction } from './due-date-action';

/**
 * The balance's due date on the import application and its invoices
 * (2026-10-07, by direction): the words and the dialog, put together once for
 * the import page's banner and the invoice record's "Set due date".
 */

type Dialog = Omit<BalanceDueDialogProps, 'autoOpen' | 'opener'>;

/** What the dialog says: the paid application, what is owed, the invoices the date goes on. */
export async function balanceDueDialogProps(prompt: ImportDuePrompt, locale: string): Promise<Dialog> {
  const [t, column, admin] = await Promise.all([getTranslations('admin.balance_due'), getTranslations('column'), getTranslations('admin')]);
  const day = (iso: string | null | undefined) => (iso ? formatBusinessDate(iso, locale as Locale) : '—');
  const money = (value: bigint) => formatMoney(toDecimalString(value, MONEY_SCALE), 'IQD', locale as Locale);
  return {
    payableId: prompt.payableId,
    paidLine: prompt.paid ? t('paid_line', { application: prompt.paid.applicationNo, date: day(prompt.paid.confirmedOn) }) : '',
    owedText: money(prompt.owedIqd),
    invoices: prompt.waiting.map((invoice) => ({
      invoiceNo: invoice.invoiceNo,
      invoiceDate: day(invoice.invoiceDate),
      owed: money(owedOn(invoice)),
      href: `/payables/invoices/${encodeURIComponent(invoice.invoiceNo)}`,
    })),
    labels: {
      title: t('dialog_title'),
      owed: t('owed'),
      invoices: t('invoices'),
      invoiceNo: column('invoice_no'),
      invoiceDate: column('invoice_date'),
      field: t('field'),
      fieldHint: t('field_hint'),
      save: t('save'),
      later: t('later'),
      close: admin('close'),
      errorTitle: admin('error_title'),
    },
    action: setBalanceDueDateAction,
  };
}

/** "Set by <name> on <date>" — or "Set on <date>" for a date written on the document as it was raised. */
export async function dueDateMarkText(mark: ImportDuePrompt['mark'], locale: string): Promise<string | null> {
  if (!mark) return null;
  const t = await getTranslations('admin.balance_due');
  const on = formatBusinessDate(businessDateOf(new Date(mark.at)), locale as Locale);
  return mark.byName ? t('set_by', { name: mark.byName, date: on }) : t('set_on', { date: on });
}

/**
 * The import page's banner while the SWIFT is in and the balance has no date:
 * with the button that opens the dialog for whoever may set it (the dialog
 * also opens by itself), "Waiting for the due date" for everybody else.
 */
export async function BalanceDueBanner({ prompt, locale }: { readonly prompt: ImportDuePrompt; readonly locale: string }) {
  if (!prompt.due || !prompt.paid) return null;
  const t = await getTranslations('admin.balance_due');
  const day = (iso: string | null | undefined) => (iso ? formatBusinessDate(iso, locale as Locale) : '—');
  const values = { application: prompt.paid.applicationNo, date: day(prompt.paid.confirmedOn) };
  const dialog = prompt.ask ? await balanceDueDialogProps(prompt, locale) : null;
  return (
    <div className={`${s.sapNote} flex flex-wrap items-center justify-between gap-3`} data-balance-due-banner="">
      <span>{prompt.ask ? t('banner', values) : t('banner_waiting', values)}</span>
      {dialog ? (
        <BalanceDueDialog {...dialog} autoOpen opener={{ label: t('set_button') }} />
      ) : (
        <strong data-balance-due-waiting="">{t('waiting_for_date')}</strong>
      )}
    </div>
  );
}
