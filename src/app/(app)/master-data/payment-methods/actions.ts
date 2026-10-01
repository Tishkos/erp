'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as methods from '@/server/services/payment-methods';

const LIST = '/master-data/payment-methods';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

const createdRecord = (value: unknown) => {
  const created = value as { code?: string } | null | undefined;
  return created?.code ? record(created.code) : LIST;
};

export async function createPaymentMethod(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      methods.create(tx, ctx, {
        // No code: the system mints it (Critical Rule 1).
        name: text(formData, 'name'),
        kind: text(formData, 'kind'),
        confirmationKind: text(formData, 'confirmationKind') || null,
        feePercent: text(formData, 'feePercent') || null,
        feeAccountId: text(formData, 'feeAccountId') || null,
      }),
    createdRecord,
  );
}

export async function updatePaymentMethod(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      methods.update(tx, ctx, code, {
        name: text(formData, 'name'),
        kind: text(formData, 'kind'),
        confirmationKind: text(formData, 'confirmationKind') || null,
        feePercent: text(formData, 'feePercent') || null,
        feeAccountId: text(formData, 'feeAccountId') || null,
      }),
    record(code),
  );
}

export async function setPaymentMethodActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      methods.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}
