'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as warehouses from '@/server/services/warehouses';

const LIST = '/master-data/warehouses';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

export async function createWarehouse(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      // No code: the system mints it (Critical Rule 1).
      warehouses.create(tx, ctx, { name: text(formData, 'name') }),
    LIST,
  );
}

export async function renameWarehouse(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => warehouses.rename(tx, ctx, text(formData, 'code'), text(formData, 'name')),
    record(text(formData, 'code')),
  );
}

export async function setWarehouseActive(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      warehouses.setActive(
        tx,
        ctx,
        text(formData, 'code'),
        flag(formData, 'active'),
        text(formData, 'reason') || null,
      ),
    record(text(formData, 'code')),
  );
}
