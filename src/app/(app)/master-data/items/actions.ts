'use server';

import { flag, runAdminAndReturn, text } from '@/server/admin-action';
import * as items from '@/server/services/items';
import * as units from '@/server/services/item-units';

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

/**
 * REQ-FIX-001 FIX-4 — "1 carton = 24 EA". The person types how many base
 * units one of the new unit holds, as a decimal; it is kept as an exact
 * fraction (24/1, 0.5 → 1/2, 12.5 → 25/2).
 */
function fractionOf(value: string): { numerator: bigint; denominator: bigint } {
  const cleaned = value.replace(/[,\s]/g, '');
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(cleaned);
  if (!match) throw new Error(`"${value}" is not a quantity of the base unit. Say how many base units one of this unit holds, e.g. 24 or 0.5.`);
  const decimals = match[2] ?? '';
  let numerator = BigInt(`${match[1]}${decimals}`);
  let denominator = 10n ** BigInt(decimals.length);
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
  const common = gcd(numerator, denominator) || 1n;
  numerator /= common;
  denominator /= common;
  return { numerator, denominator };
}

export async function addItemUnit(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(async (tx, ctx) => {
    const { numerator, denominator } = fractionOf(text(formData, 'baseQuantity'));
    return units.addUnit(tx, ctx, code, {
      uomCode: text(formData, 'uomCode'),
      numerator,
      denominator,
      isPurchaseDefault: flag(formData, 'purchaseDefault'),
      isSalesDefault: flag(formData, 'salesDefault'),
      barcode: text(formData, 'barcode') || null,
    });
  }, record(code));
}

export async function setItemUnitDefault(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn(
    (tx, ctx) => units.setDefault(tx, ctx, code, text(formData, 'uomCode'), text(formData, 'kind') === 'sales' ? 'sales' : 'purchase'),
    record(code),
  );
}

export async function deactivateItemUnit(formData: FormData): Promise<void> {
  const code = text(formData, 'code');
  await runAdminAndReturn((tx, ctx) => units.deactivate(tx, ctx, code, text(formData, 'uomCode'), text(formData, 'reason')), record(code));
}
