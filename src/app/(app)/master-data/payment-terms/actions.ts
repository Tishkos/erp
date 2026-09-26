'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as terms from '@/server/services/payment-terms';

const LIST = '/master-data/payment-terms';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

const createdRecord = (value: unknown) => {
  const created = value as { code?: string } | null | undefined;
  return created?.code ? record(created.code) : LIST;
};

/**
 * The instalment rows, read out of the form.
 *
 * The form posts them as parallel arrays — `daysAfter` and `percentage`, one
 * entry per row — so a row is whatever sits at the same index in both. Blank
 * rows are dropped by the service, which is what lets the form draw a few
 * spare rows without them meaning anything.
 */
function instalmentsFrom(formData: FormData) {
  const days = formData.getAll('daysAfter').map(String);
  const percentages = formData.getAll('percentage').map(String);
  return percentages
    .map((percentage, index) => ({
      daysAfter: Number(days[index] ?? '0'),
      percentage: percentage.trim(),
    }))
    .filter((row) => row.percentage !== '');
}

export async function createPaymentTerm(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      // No code: the system mints it (Critical Rule 1).
      terms.create(tx, ctx, {
        name: text(formData, 'name'),
        basis: text(formData, 'basis'),
        dueDays: Number(text(formData, 'dueDays') || '0'),
        discountPercent: text(formData, 'discountPercent') || null,
        discountDays: text(formData, 'discountDays') ? Number(text(formData, 'discountDays')) : null,
        instalments: instalmentsFrom(formData),
      }),
    createdRecord,
  );
}

export async function updatePaymentTerm(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      terms.update(tx, ctx, code, {
        name: text(formData, 'name'),
        basis: text(formData, 'basis'),
        dueDays: Number(text(formData, 'dueDays') || '0'),
        discountPercent: text(formData, 'discountPercent') || null,
        discountDays: text(formData, 'discountDays') ? Number(text(formData, 'discountDays')) : null,
        instalments: instalmentsFrom(formData),
      }),
    record(code),
  );
}

export async function setPaymentTermActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => terms.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}
