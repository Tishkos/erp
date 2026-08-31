'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as uom from '@/server/services/units-of-measure';

const LIST = '/master-data/uom';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

/** The service derives the code when nobody typed one, so it reports it back. */
const createdRecord = (value: unknown) => {
  const created = value as { code?: string } | null | undefined;
  return created?.code ? record(created.code) : LIST;
};

export async function createUom(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      uom.create(tx, ctx, {
        code: text(formData, 'code').trim().toUpperCase(),
        name: text(formData, 'name'),
      }),
    createdRecord,
  );
}

export async function updateUom(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => uom.update(tx, ctx, code, { name: text(formData, 'name') }),
    record(code),
  );
}

export async function setUomActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => uom.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}
