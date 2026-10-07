'use server';

import { revalidatePath } from 'next/cache';
import { getLocale, getTranslations } from 'next-intl/server';
import { runAdmin, text } from '@/server/admin-action';
import { formatBusinessDate, type Locale } from '@/i18n/config';
import * as balanceDue from '@/server/services/balance-due';

/**
 * The balance's due date, from the import application's dialog (2026-10-07,
 * by direction: "a dialog comes up: enter the due date, and it marks it").
 *
 * One action for the import page's dialog and the invoice record's "Set due
 * date": the date goes on every invoice of the import still waiting for one,
 * each through `ap-invoice.setDueDate` (audited, logged on the import). It
 * answers rather than redirects, so a refusal — a date before an invoice's own
 * date — is read in the dialog, in the reader's language, beside the field.
 */
export async function setBalanceDueDateAction(formData: FormData): Promise<{ readonly ok: boolean; readonly error?: string }> {
  const payableId = text(formData, 'payable_id').trim();
  const dueDate = text(formData, 'due_date').trim();
  let refusal: balanceDue.BalanceDueRefusal | null = null;
  const outcome = await runAdmin(async (tx, ctx) => {
    try {
      return await balanceDue.setForImport(tx, ctx, payableId, dueDate);
    } catch (error) {
      if (error instanceof balanceDue.BalanceDueRefusal) refusal = error;
      throw error;
    }
  });
  if (outcome.ok) {
    // Every screen that shows the date — the import, its invoices, the registers, Home.
    revalidatePath('/', 'layout');
    return { ok: true };
  }
  const found = refusal as balanceDue.BalanceDueRefusal | null;
  if (!found) return { ok: false, error: outcome.error ?? '' };
  const [t, locale] = await Promise.all([getTranslations('admin.balance_due'), getLocale()]);
  const day = (value: string | undefined) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatBusinessDate(value, locale as Locale) : (value ?? ''));
  return {
    ok: false,
    error: t(found.code, {
      dueDate: day(found.params.dueDate),
      invoiceNo: found.params.invoiceNo ?? '',
      invoiceDate: day(found.params.invoiceDate),
    }),
  };
}
