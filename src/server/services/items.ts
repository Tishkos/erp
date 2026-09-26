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
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  businessPartner,
  chartOfAccount,
  item,
  itemSupplier,
  itemUom,
  unitOfMeasure,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  AdminNotFoundError,
  AdminValidationError,
  optionalText,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'item';

/** Where an item's code comes from — configurable on the Numbering screen. */
const ITEM_CODE_SEQUENCE = 'ITEM_CODE';

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
  readonly inventoryAccountId?: string | null;
  readonly cogsAccountId?: string | null;
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
      sellingPriceIqd: item.sellingPriceIqd,
      active: item.active,
      // How many suppliers can sell it — the column that tells a buyer whether
      // this item has been set up for purchasing at all.
      supplierCount: sql<number>`(
        select count(*) from item_supplier s where s.item_id = ${item.id}
      )::int`,
      // What is actually on the shelf, added up across every warehouse.
      //
      // Read from `stock_position`, which is a view over the stock movements
      // rather than a number kept on the item. That is the whole point: a
      // quantity stored on the master is a second opinion, and the day it
      // disagrees with the movements there is no way to tell which is right.
      // Summed from the movements it cannot disagree with them.
      onHand: sql<string>`coalesce((
        select sum(p.on_hand) from stock_position p where p.item_code = ${item.code}
      ), 0)::text`,
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
      purchasePriceIqd: itemSupplier.purchasePriceIqd,
      isDefault: itemSupplier.isDefault,
      active: itemSupplier.active,
    })
    .from(itemSupplier)
    .innerJoin(businessPartner, eq(businessPartner.id, itemSupplier.supplierId))
    .where(eq(itemSupplier.itemId, itemId))
    .orderBy(desc(itemSupplier.isDefault), asc(businessPartner.code));
}

function priceOrNull(value: string | null): string | null {
  if (value === null || !value.trim()) return null;
  const amount = parseDecimal(value.trim(), 4n);
  if (amount < 0n) throw new AdminValidationError('price', 'must not be negative');
  return toDecimalString(amount, 4n);
}

export async function setSellingPrice(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  value: string | null,
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const price = priceOrNull(value);
  await tx
    .update(item)
    .set({ sellingPriceIqd: price, updatedAt: new Date() })
    .where(eq(item.id, before.id));
  await recordChange(tx, ctx, {
    action: 'item.selling_price_changed',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { sellingPriceIqd: before.sellingPriceIqd },
    after: { sellingPriceIqd: price },
  });
}

export async function setSupplierPrice(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  supplierId: string,
  value: string | null,
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const row = await get(tx, code);
  const [before] = await tx
    .select()
    .from(itemSupplier)
    .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, supplierId)))
    .limit(1);
  if (!before) throw new AdminValidationError('supplierId', 'is not linked to this item');
  const price = priceOrNull(value);
  await tx
    .update(itemSupplier)
    .set({ purchasePriceIqd: price })
    .where(and(eq(itemSupplier.itemId, row.id), eq(itemSupplier.supplierId, supplierId)));
  await recordChange(tx, ctx, {
    action: 'item.supplier_price_changed',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { supplierId, purchasePriceIqd: before.purchasePriceIqd },
    after: { supplierId, purchasePriceIqd: price },
  });
}

/** The stock items and supplier links an invoice grid needs in one read. */
export async function invoiceChoices(tx: Tx, mode: 'purchase' | 'sale') {
  const rows = (await listAll(tx)).filter((row) => row.isStock && row.active);
  if (rows.length === 0) return [];

  const linked = await tx
    .select({
      itemId: itemSupplier.itemId,
      supplierId: itemSupplier.supplierId,
      supplierCode: businessPartner.code,
      legalName: businessPartner.legalName,
      purchasePriceIqd: itemSupplier.purchasePriceIqd,
    })
    .from(itemSupplier)
    .innerJoin(businessPartner, eq(businessPartner.id, itemSupplier.supplierId))
    .where(
      and(
        inArray(
          itemSupplier.itemId,
          rows.map((row) => row.id),
        ),
        eq(itemSupplier.active, true),
        eq(businessPartner.active, true),
        eq(businessPartner.isSupplier, true),
      ),
    )
    .orderBy(desc(itemSupplier.isDefault), asc(businessPartner.code));

  const byItem = new Map<string, typeof linked>();
  for (const link of linked) {
    const existing = byItem.get(link.itemId);
    if (existing) existing.push(link);
    else byItem.set(link.itemId, [link]);
  }

  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    uomCode: row.baseUomCode,
    defaultUnitPriceIqd: mode === 'sale' ? row.sellingPriceIqd : null,
    suppliers: (byItem.get(row.id) ?? []).map((link) => ({
      id: link.supplierId,
      label: `${link.supplierCode} · ${link.legalName}`,
      ...(mode === 'purchase' ? { purchasePriceIqd: link.purchasePriceIqd } : {}),
    })),
  }));
}

export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [uom] = await tx
    .select({ name: unitOfMeasure.name })
    .from(unitOfMeasure)
    .where(eq(unitOfMeasure.code, row.baseUomCode))
    .limit(1);
  /** "A000004 · Inventory", or nothing when the item names no such account. */
  const named = async (id: string | null) => {
    if (!id) return null;
    const [account] = await tx
      .select({ code: chartOfAccount.code, name: chartOfAccount.name })
      .from(chartOfAccount)
      .where(eq(chartOfAccount.id, id))
      .limit(1);
    return account ? `${account.code} · ${account.name}` : null;
  };

  return {
    ...row,
    baseUomName: uom?.name ?? null,
    salesAccount: await named(row.salesAccountId),
    purchaseAccount: await named(row.purchaseAccountId),
    inventoryAccount: await named(row.inventoryAccountId),
    cogsAccount: await named(row.cogsAccountId),
    suppliers: await suppliersOf(tx, row.id),
    stock: await stockOf(tx, row.code),
  };
}

export interface StockLine {
  readonly warehouseCode: string;
  readonly warehouseName: string | null;
  /** Scaled at QUANTITY_SCALE, like every quantity in the system. */
  readonly onHand: string;
  readonly reserved: string;
}

/**
 * Where this item physically is, warehouse by warehouse.
 *
 * Nothing here is stored against the item: it is the movements — receipts,
 * issues, transfers, counts — summed by the `stock_position` view. An item
 * with no movements has a real position of zero rather than no position, so a
 * reader asking "how many do we have?" is never answered with a blank.
 */
export async function stockOf(tx: Tx, itemCode: string): Promise<StockLine[]> {
  const result = await tx.execute(sql`
    select p.warehouse_code as "warehouseCode",
           w.name           as "warehouseName",
           p.on_hand::text  as "onHand",
           p.reserved::text as "reserved"
      from stock_position p
      left join warehouse w on w.code = p.warehouse_code
     where p.item_code = ${itemCode}
       and (p.on_hand <> 0 or p.reserved <> 0)
     order by p.warehouse_code
  `);
  return result.rows as unknown as StockLine[];
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
      'must be serial, batch or both — a stock item cannot be untracked',
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
  expected: 'revenue' | 'expense' | 'asset',
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
    const article = expected === 'expense' ? 'an' : 'a';
    throw new AdminValidationError(field, `must be ${article} ${expected} account`);
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
    inventoryAccountId: await assertAccount(
      tx,
      input.inventoryAccountId ?? null,
      'inventoryAccountId',
      'asset',
    ),
    cogsAccountId: await assertAccount(tx, input.cogsAccountId ?? null, 'cogsAccountId', 'expense'),
    warrantyMonths: assertMonths(input.warrantyMonths),
  };
}

/**
 * Registers the base unit among the item's units.
 *
 * An item's conversions are all stated *relative to its base*, so the base has
 * to be one of them — converting to itself at one. The database says so with a
 * deferred constraint that fires at COMMIT, which is why forgetting it surfaced
 * as "that could not be saved" at the end rather than as a complaint about the
 * field: by the time the check runs, the statement that caused it is long past.
 *
 * Phase 2 asks only for a base unit, so this is the single row every item gets.
 * When the module that edits conversions arrives it will add the others around
 * this one.
 */
async function registerBaseUnit(tx: Tx, itemId: string, baseUomCode: string) {
  const rows = await tx
    .select({ uomCode: itemUom.uomCode })
    .from(itemUom)
    .where(eq(itemUom.itemId, itemId));

  if (rows.some((row) => row.uomCode === baseUomCode)) return;

  // Changing the base while other units hang off it would silently restate
  // every one of their conversions, so it is refused rather than guessed at.
  if (rows.length > 1) {
    throw new AdminValidationError(
      'baseUomCode',
      'cannot change while the item has other units — their conversions are stated relative to the base',
    );
  }
  if (rows[0]) {
    await tx
      .delete(itemUom)
      .where(and(eq(itemUom.itemId, itemId), eq(itemUom.uomCode, rows[0].uomCode)));
  }

  await tx.insert(itemUom).values({
    itemId,
    uomCode: baseUomCode,
    conversionNumerator: 1n,
    conversionDenominator: 1n,
    isPurchaseDefault: true,
    isSalesDefault: true,
  });
}

/**
 * The next item code nothing already holds.
 *
 * Bounded the way the chart of accounts bounds its own: if a hundred
 * consecutive numbers are all taken, the counter is not merely behind and
 * somebody should look at it rather than the loop spinning. In practice it
 * returns on the first attempt — the migration set the counter past anything
 * already in the minted shape.
 */
async function allocateFreeCode(tx: Tx, userId: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { documentNo } = await allocateDocumentNumber(tx, ITEM_CODE_SEQUENCE, {}, userId);
    const [taken] = await tx
      .select({ code: item.code })
      .from(item)
      .where(eq(item.code, documentNo))
      .limit(1);
    if (!taken) return documentNo;
  }
  throw new Error(
    'The item counter is a hundred numbers behind the catalogue. ' +
      'Set it past the highest code in use on the Numbering screen before adding another item.',
  );
}

/**
 * A new item. Its code is minted, never given.
 *
 * By direction (2026-09-26): *"All Item Codes must be automatically generated
 * by the system... because we need to completely avoid duplicate codes,
 * incorrect entries, and human errors."* So `create` takes no code, and there
 * is no argument a caller could pass one through — a screen, an import or a
 * script all reach the same allocator.
 *
 * What it replaced was a slug of the name with a suffix when the slug was
 * taken: SOLAR, then SOLAR_2. Two people entering the same panel produced two
 * codes for one thing, which is the duplicate §3.1 exists to prevent.
 */
export async function create(tx: Tx, ctx: ActorContext, input: ItemInput) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  requireText(input.name, 'name');
  const code = await allocateFreeCode(tx, ctx.principal.userId);

  const values = await valuesFor(tx, input);
  const [created] = await tx
    .insert(item)
    .values({ code, ...values, createdBy: ctx.principal.userId })
    .returning({ id: item.id });

  // In the same transaction: the deferred check runs at COMMIT and needs it.
  await registerBaseUnit(tx, created!.id, values.baseUomCode);

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
  if (values.baseUomCode !== before.baseUomCode) {
    await registerBaseUnit(tx, before.id, values.baseUomCode);
  }
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
