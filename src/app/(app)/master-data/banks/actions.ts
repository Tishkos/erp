'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as banks from '@/server/services/banks';

const LIST = '/master-data/banks';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

const createdRecord = (value: unknown) => {
  const created = value as { code?: string } | null | undefined;
  return created?.code ? record(created.code) : LIST;
};

export async function createBank(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      banks.create(tx, ctx, {
        // No code: the system mints it (Critical Rule 1).
        name: text(formData, 'name'),
        swiftBic: text(formData, 'swiftBic') || null,
        country: text(formData, 'country') || null,
      }),
    createdRecord,
  );
}

export async function updateBank(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      banks.update(tx, ctx, code, {
        name: text(formData, 'name'),
        swiftBic: text(formData, 'swiftBic') || null,
        country: text(formData, 'country') || null,
      }),
    record(code),
  );
}

export async function setBankActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => banks.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}
