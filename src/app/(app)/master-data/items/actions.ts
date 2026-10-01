'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as items from '@/server/services/items';

const LIST = '/inventory/items';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

const createdRecord = (value: unknown) => {
  const created = value as { code?: string } | null | undefined;
  return created?.code ? record(created.code) : LIST;
};

function inputFrom(formData: FormData) {
  return {
    name: text(formData, 'name'),
    description: text(formData, 'description') || null,
    // The category picker offers what is already in use; the field beside it
    // takes a new one. A typed category wins, so the list never traps anybody.
    category: (text(formData, 'newCategory') || text(formData, 'category')) || null,
    isStock: text(formData, 'isStock') !== 'service',
    baseUomCode: text(formData, 'baseUomCode'),
    tracking: text(formData, 'tracking') || null,
    salesAccountId: text(formData, 'salesAccountId') || null,
    purchaseAccountId: text(formData, 'purchaseAccountId') || null,
    inventoryAccountId: text(formData, 'inventoryAccountId') || null,
    cogsAccountId: text(formData, 'cogsAccountId') || null,
    warrantyMonths: text(formData, 'warrantyMonths') || null,
  };
}

/**
 * A new item. The form carries no code and this reads none.
 *
 * By direction (2026-09-26) the Item Code is the system's to mint. Reading a
 * `code` field here would be the one line that let a hand-typed code back in —
 * through a form somebody had altered, or a request made directly — so it is
 * not read at all rather than read and ignored.
 */
export async function createItem(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => items.create(tx, ctx, inputFrom(formData)), createdRecord);
}

export async function updateItem(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn((tx, ctx) => items.update(tx, ctx, code, inputFrom(formData)), record(code));
}

export async function setItemActive(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => items.setActive(tx, ctx, code, flag(formData, 'active'), text(formData, 'reason')),
    record(code),
  );
}

/** Requirement 4 — an item is linked to one or more suppliers. */
export async function linkItemSupplier(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      items.linkSupplier(tx, ctx, code, {
        supplierId: text(formData, 'supplierId'),
        supplierItemCode: text(formData, 'supplierItemCode') || null,
        makeDefault: flag(formData, 'makeDefault'),
      }),
    record(code),
  );
}

/** Requirement 4 — one of them is the default. */
export async function makeDefaultSupplier(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      items.linkSupplier(tx, ctx, code, {
        supplierId: text(formData, 'supplierId'),
        supplierItemCode: text(formData, 'supplierItemCode') || null,
        makeDefault: true,
      }),
    record(code),
  );
}

export async function setItemSellingPrice(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => items.setSellingPrice(tx, ctx, code, text(formData, 'price') || null),
    record(code),
  );
}

export async function setItemSupplierPrice(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      items.setSupplierPrice(
        tx,
        ctx,
        code,
        text(formData, 'supplierId'),
        text(formData, 'price') || null,
      ),
    record(code),
  );
}

export async function unlinkItemSupplier(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => items.unlinkSupplier(tx, ctx, code, text(formData, 'supplierId')),
    record(code),
  );
}
