'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as warehouses from '@/server/services/warehouses';

const LIST = '/master-data/warehouses';

export async function createWarehouse(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      warehouses.create(tx, ctx, {
        code: text(formData, 'code'),
        name: text(formData, 'name'),
      }),
    LIST,
  );
}

export async function renameWarehouse(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => warehouses.rename(tx, ctx, text(formData, 'code'), text(formData, 'name')),
    LIST,
  );
}

export async function setWarehouseActive(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => warehouses.setActive(tx, ctx, text(formData, 'code'), flag(formData, 'active')),
    LIST,
  );
}
