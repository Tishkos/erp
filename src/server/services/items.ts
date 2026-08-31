/**
 * Item master — Phase 2 requirement 4.
 *
 * *"Items can be created and maintained with an internal item code, item name,
 *  category and unit of measure. Each item can be linked to one or more
 *  suppliers, with one supplier identified as the default supplier. The same
 *  item record will be used later in Purchasing, Inventory and Sales."*
 *
 * "The same item record" is the whole requirement. Everything else follows
 * from it: the code is the identity §8.3 says every document selects by, the
 * base unit is what every quantity is stated in, and the supplier links are
 * what a purchase order will read instead of asking someone to remember.
 *
 * ── Two prohibitions that are not this file's to soften ────────────────────
 * §9.3 requires every *stock* item to track serial numbers, batch numbers or
 * both; the database refuses a stock item with neither. §9.2 makes FIFO the
 * only valuation method, and the enum has one value. A service that offered a
 * way around either would be offering a way around the blueprint.
 *
 * A service is different in kind: it has no stock, so it tracks nothing. That
 * is why `isStock` decides whether tracking is asked for at all rather than
 * being one more field on one long form.
 */
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  chartOfAccount,
  item,
  itemSupplier,
  unitOfMeasure,
} from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  codeFromName,
  normaliseCode,
  optionalText,
  permit,
  recordChange,
  requireText,
  uniqueCode,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'item';

export const ITEM_TRACKING = ['serial', 'batch', 'serial_and_batch'] as const;
export type ItemTracking = (typeof ITEM_TRACKING)[number];

export interface ItemInput {
  readonly name: string;
  readonly description?: string | null;
  readonly category?: string | null;
  readonly isStock: boolean;
  readonly baseUomCode: string;
  readonly tracking?: string | null;
  readonly salesAccountId?: string | null;
  readonly purchaseAccountId?: string | null;
  readonly warrantyMonths?: string | null;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      id: item.id,
      code: item.code,
      name: item.name,
      category: item.category,
      isStock: item.isStock,
      baseUomCode: item.baseUomCode,
      tracking: item.tracking,
      active: item.active,
      // How many suppliers can sell it — the column that tells a buyer whether
      // this item has been set up for purchasing at all.
      supplierCount: sql<number>`(
        select count(*) from item_supplier s where s.item_id = ${item.id}
      )::int`,
    })
    .from(item)
    .orderBy(asc(item.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(item).where(eq(item.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('item', code);
  return row;
}

/** Every supplier this item can be bought from, the default first. */
export async function suppliersOf(tx: Tx, itemId: string) {
  return tx
    .select({
      supplierId: itemSupplier.supplierId,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      supplierItemCode: itemSupplier.supplierItemCode,
      isDefault: itemSupplier.isDefault,
      active: itemSupplier.active,
    })
    .from(itemSupplier)
    .innerJoin(businessPartner, eq(businessPartner.id, itemSupplier.supplierId))
    .where(eq(itemSupplier.itemId, itemId))
    .orderBy(desc(itemSupplier.isDefault), asc(businessPartner.code));
}

export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [uom] = await tx
    .select({ name: unitOfMeasure.name })
    .from(unitOfMeasure)
    .where(eq(unitOfMeasure.code, row.baseUomCode))
    .limit(1);
  const [sales] = row.salesAccountId
    ? await tx
        .select({ code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(eq(chartOfAccount.id, row.salesAccountId))
        .limit(1)
    : [];
  const [purchase] = row.purchaseAccountId
    ? await tx
        .select({ code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(eq(chartOfAccount.id, row.purchaseAccountId))
        .limit(1)
    : [];

  return {
    ...row,
    baseUomName: uom?.name ?? null,
    salesAccount: sales ? `${sales.code} · ${sales.name}` : null,
    purchaseAccount: purchase ? `${purchase.code} · ${purchase.name}` : null,
    suppliers: await suppliersOf(tx, row.id),
  };
}

/** The categories already in use, so a second item can reuse one by picking it. */
export async function categories(tx: Tx) {
  const rows = await tx
    .selectDistinct({ category: item.category })
    .from(item)
    .orderBy(asc(item.category));
  return rows.map((row) => row.category).filter((c): c is string => Boolean(c));
}

function assertTracking(isStock: boolean, value: string | null | undefined): ItemTracking | null {
  if (!isStock) {
    // §9.3 — a service has no stock, so serial numbers on it would be noise.
    return null;
  }
  const tracking = (value ?? '').trim();
  if (!(ITEM_TRACKING as readonly string[]).includes(tracking)) {
    throw new AdminValidationError(
      'tracking',
      'must be serial, batch or both — a stock item cannot be untracked (§9.3)',
    );
  }
  return tracking as ItemTracking;
}

async function assertUom(tx: Tx, code: string): Promise<string> {
  const value = requireText(code, 'baseUomCode', 32);
  const [row] = await tx
    .select({ code: unitOfMeasure.code, active: unitOfMeasure.active })
    .from(unitOfMeasure)
    .where(eq(unitOfMeasure.code, value))
    .limit(1);
  if (!row) throw new AdminValidationError('baseUomCode', 'is not a known unit of measure');
  if (!row.active) throw new AdminValidationError('baseUomCode', 'is not an active unit of measure');
  return row.code;
}

/** A posting account of the expected type, or nothing. */
async function assertAccount(
  tx: Tx,
  id: string | null,
  field: string,
  expected: 'revenue' | 'expense',
): Promise<string | null> {
  if (!id) return null;
  const [account] = await tx
    .select({
      id: chartOfAccount.id,
      isGroup: chartOfAccount.isGroup,
      accountType: chartOfAccount.accountType,
    })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, id))
    .limit(1);
  if (!account) throw new AdminValidationError(field, 'is not a known account');
  if (account.isGroup) throw new AdminValidationError(field, 'is a header, not a posting account');
  if (account.accountType !== expected) {
    throw new AdminValidationError(field, `must be ${expected === 'revenue' ? 'a revenue' : 'an expense'} account`);
  }
  return account.id;
}

function assertMonths(value: string | null | undefined): number | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const months = Number(raw);
  if (!Number.isInteger(months) || months < 0 || months > 600) {
    throw new AdminValidationError('warrantyMonths', 'must be a whole number of months, 0 to 600');
  }
  return months;
}

async function valuesFor(tx: Tx, input: ItemInput) {
  return {
    name: requireText(input.name, 'name'),
    description: optionalText(input.description),
    category: optionalText(input.category, 100),
    isStock: input.isStock,
    baseUomCode: await assertUom(tx, input.baseUomCode),
    tracking: assertTracking(input.isStock, input.tracking),
    salesAccountId: await assertAccount(tx, input.salesAccountId ?? null, 'salesAccountId', 'revenue'),
    purchaseAccountId: await assertAccount(
      tx,
      input.purchaseAccountId ?? null,
      'purchaseAccountId',
      'expense',
    ),
    warrantyMonths: assertMonths(input.warrantyMonths),
  };
}

export async function create(tx: Tx, ctx: ActorContext, input: ItemInput & { readonly code?: string }) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(name), async (candidate) => {
        const [row] = await tx.select({ id: item.id }).from(item).where(eq(item.code, candidate));
        return Boolean(row);
      });

  const [existing] = await tx.select({ id: item.id }).from(item).where(eq(item.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already an item`);

  const values = await valuesFor(tx, input);
  const [created] = await tx
    .insert(item)
    .values({ code, ...values, createdBy: ctx.principal.userId })
    .returning({ id: item.id });

  await recordChange(tx, ctx, {
    action: 'item.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, ...values },
  });
  return { id: created!.id, code };
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: ItemInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const values = await valuesFor(tx, input);

  await tx.update(item).set({ ...values, updatedAt: new Date() }).where(eq(item.code, code));
  await recordChange(tx, ctx, {
    action: 'item.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: {
      name: before.name,
      category: before.category,
      isStock: before.isStock,
      baseUomCode: before.baseUomCode,
      tracking: before.tracking,
    },
    after: values,
  });
  return get(tx, code);
}

export async function setActive(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  active: boolean,
  reason: string | null,
) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  if (before.active === active) return before;
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate an item');
  }
  await tx.update(item).set({ active, updatedAt: new Date() }).where(eq(item.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'item.reactivated' : 'item.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}

// ---------------------------------------------------------------------------
// The suppliers an item can be bought from
// ---------------------------------------------------------------------------

/** Partners holding the supplier role — what the "add a supplier" picker offers. */
export async function selectableSuppliers(tx: Tx) {
  return tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(and(eq(businessPartner.isSupplier, true), eq(businessPartner.active, true)))
    .orderBy(asc(businessPartner.code));
}

/**
 * Links a supplier to an item, or updates the link if it is already there.
 *
 * `makeDefault` clears the previous default first. Both statements are in the
 * caller's transaction, so the partial unique index never sees two defaults —
 * which is exactly why the index can be trusted as the rule rather than as a
 * hopeful assertion.
 */
export async function linkSupplier(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  input: {
    readonly supplierId: string;
    readonly supplierItemCode?: string | null;
    readonly makeDefault: boolean;
  },
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const row = await get(tx, code);

  const [supplier] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, isSupplier: businessPartner.isSupplier })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.supplierId))
    .limit(1);
  if (!supplier) throw new AdminValidationError('supplierId', 'is not a known partner');
  if (!supplier.isSupplier) {
    throw new AdminValidationError('supplierId', 'does not hold the supplier role');
  }

  const existing = await tx
    .select({ supplierId: itemSupplier.supplierId })
    .from(itemSupplier)
    .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, supplier.id)))
    .limit(1);

  // The first supplier an item gets is its default: an item with suppliers but
  // no default would make a purchase order ask a question with no answer.
  const anyExisting = await tx
    .select({ supplierId: itemSupplier.supplierId })
    .from(itemSupplier)
    .where(eq(itemSupplier.itemId, row.id))
    .limit(1);
  const isDefault = input.makeDefault || anyExisting.length === 0;

  if (isDefault) {
    await tx
      .update(itemSupplier)
      .set({ isDefault: false })
      .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.isDefault, true)));
  }

  const values = {
    itemId: row.id,
    supplierId: supplier.id,
    supplierItemCode: optionalText(input.supplierItemCode, 100),
    isDefault,
    active: true,
  };
  if (existing.length > 0) {
    await tx
      .update(itemSupplier)
      .set(values)
      .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, supplier.id)));
  } else {
    await tx.insert(itemSupplier).values(values);
  }

  await recordChange(tx, ctx, {
    action: existing.length > 0 ? 'item.supplier_updated' : 'item.supplier_linked',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { supplier: supplier.code, supplierItemCode: values.supplierItemCode, isDefault },
  });
}

/**
 * Unlinks a supplier. If it was the default and others remain, the next one by
 * code takes over — an item is never left with suppliers and no default.
 */
export async function unlinkSupplier(tx: Tx, ctx: ActorContext, code: string, supplierId: string) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const row = await get(tx, code);

  const [link] = await tx
    .select({ isDefault: itemSupplier.isDefault, supplierId: itemSupplier.supplierId })
    .from(itemSupplier)
    .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, supplierId)))
    .limit(1);
  if (!link) throw new AdminValidationError('supplierId', 'is not linked to this item');

  await tx
    .delete(itemSupplier)
    .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, supplierId)));

  if (link.isDefault) {
    const remaining = await tx
      .select({ supplierId: itemSupplier.supplierId, code: businessPartner.code })
      .from(itemSupplier)
      .innerJoin(businessPartner, eq(businessPartner.id, itemSupplier.supplierId))
      .where(eq(itemSupplier.itemId, row.id))
      .orderBy(asc(businessPartner.code))
      .limit(1);
    if (remaining[0]) {
      await tx
        .update(itemSupplier)
        .set({ isDefault: true })
        .where(
          and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, remaining[0].supplierId)),
        );
    }
  }

  await recordChange(tx, ctx, {
    action: 'item.supplier_unlinked',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { supplierId, wasDefault: link.isDefault },
  });
}
