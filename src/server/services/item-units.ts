/**
 * An item's units of measure — REQ-FIX-001 FIX-4.
 *
 * Every item has a base unit — the one its stock is counted in — and may be
 * bought or sold in others: a carton of 24, a roll of 100 m. A unit is a
 * fraction of the base (`1 carton = 24/1 EA`); the arithmetic is
 * `domain/uom.ts` and is exact or refused (`toBaseExact`). Every document
 * line keeps the unit it was written in; stock is moved in the base, so the
 * conversion happens at the movement and nowhere else.
 *
 * Units are deactivated with a reason, never deleted (a document written in
 * one must stay readable); the base unit stays active (0254), and an item has
 * one purchase default and one sales default among its active units.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { item, itemUom, unitOfMeasure } from '../db/schema';
import { formatQuantity, toBaseExact, type UomConversion } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import { AdminNotFoundError, AdminValidationError, permit, recordChange, requireText } from './administration';

export const PERMISSION_OBJECT = 'item';

export class UnknownUnitError extends Error {
  readonly code = 'UNKNOWN_UNIT';
  constructor(itemCode: string, uomCode: string) {
    super(`${itemCode} is not kept in ${uomCode}. Add ${uomCode} to the item's units (Items → ${itemCode} → Units), or choose one of its units.`);
    this.name = 'UnknownUnitError';
  }
}

export interface ItemUnit {
  readonly uomCode: string;
  readonly uomName: string;
  readonly numerator: bigint;
  readonly denominator: bigint;
  readonly isBase: boolean;
  readonly isPurchaseDefault: boolean;
  readonly isSalesDefault: boolean;
  readonly active: boolean;
  readonly deactivatedReason: string | null;
}

async function itemOf(tx: Tx, itemCode: string) {
  const [row] = await tx.select({ id: item.id, code: item.code, baseUomCode: item.baseUomCode }).from(item).where(eq(item.code, itemCode)).limit(1);
  if (!row) throw new AdminNotFoundError('item', itemCode);
  return row;
}

/** Every unit of the item, the base first, then the others by code. */
export async function unitsOf(tx: Tx, itemCode: string): Promise<ItemUnit[]> {
  const owner = await itemOf(tx, itemCode);
  const rows = await tx
    .select({ unit: itemUom, name: unitOfMeasure.name })
    .from(itemUom)
    .innerJoin(unitOfMeasure, eq(unitOfMeasure.code, itemUom.uomCode))
    .where(eq(itemUom.itemId, owner.id))
    .orderBy(asc(itemUom.uomCode));
  return rows
    .map(({ unit, name }) => ({
      uomCode: unit.uomCode,
      uomName: name,
      numerator: unit.conversionNumerator,
      denominator: unit.conversionDenominator,
      isBase: unit.uomCode === owner.baseUomCode,
      isPurchaseDefault: unit.isPurchaseDefault,
      isSalesDefault: unit.isSalesDefault,
      active: unit.active,
      deactivatedReason: unit.deactivatedReason,
    }))
    .sort((a, b) => Number(b.isBase) - Number(a.isBase));
}

/** The conversion a document line's unit is moved through. Refuses a unit the item does not keep. */
export async function conversionOf(tx: Tx, itemCode: string, uomCode: string): Promise<UomConversion> {
  const owner = await itemOf(tx, itemCode);
  if (uomCode === owner.baseUomCode) return { uomCode, numerator: 1n, denominator: 1n };
  const [unit] = await tx
    .select()
    .from(itemUom)
    .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, uomCode), eq(itemUom.active, true)))
    .limit(1);
  if (!unit) throw new UnknownUnitError(itemCode, uomCode);
  return { uomCode, numerator: unit.conversionNumerator, denominator: unit.conversionDenominator };
}

/** A quantity in a line's unit, in the item's base unit — exact, or refused. */
export async function toBaseQuantity(tx: Tx, itemCode: string, uomCode: string, quantity: bigint): Promise<bigint> {
  const owner = await itemOf(tx, itemCode);
  return toBaseExact(quantity, await conversionOf(tx, itemCode, uomCode), owner.baseUomCode);
}

/** Refuses a unit the item does not keep (or keeps no longer); the base unit when none is named. */
export async function assertLineUnit(tx: Tx, itemCode: string, uomCode: string | null | undefined): Promise<string> {
  const owner = await itemOf(tx, itemCode);
  const chosen = uomCode?.trim() || owner.baseUomCode;
  await conversionOf(tx, itemCode, chosen);
  return chosen;
}

/** The unit a new purchase line starts in: the item's purchase default, else its base. */
export async function purchaseDefaultOf(tx: Tx, itemCode: string): Promise<string> {
  const units = await unitsOf(tx, itemCode);
  return units.find((unit) => unit.active && unit.isPurchaseDefault)?.uomCode ?? units.find((unit) => unit.isBase)?.uomCode ?? 'EA';
}

/** The active units of many items at once — the document grids' pickers. */
export async function pickerUnits(tx: Tx, itemIds: readonly string[]) {
  if (itemIds.length === 0) return new Map<string, { code: string; numerator: string; denominator: string; isPurchaseDefault: boolean; isSalesDefault: boolean }[]>();
  const rows = await tx
    .select({
      itemId: itemUom.itemId,
      code: itemUom.uomCode,
      numerator: itemUom.conversionNumerator,
      denominator: itemUom.conversionDenominator,
      isPurchaseDefault: itemUom.isPurchaseDefault,
      isSalesDefault: itemUom.isSalesDefault,
    })
    .from(itemUom)
    .where(and(inArray(itemUom.itemId, [...itemIds]), eq(itemUom.active, true)))
    .orderBy(asc(itemUom.uomCode));
  const byItem = new Map<string, { code: string; numerator: string; denominator: string; isPurchaseDefault: boolean; isSalesDefault: boolean }[]>();
  for (const row of rows) {
    const unit = { code: row.code, numerator: row.numerator.toString(), denominator: row.denominator.toString(), isPurchaseDefault: row.isPurchaseDefault, isSalesDefault: row.isSalesDefault };
    const list = byItem.get(row.itemId);
    if (list) list.push(unit);
    else byItem.set(row.itemId, [unit]);
  }
  return byItem;
}

export interface UnitInput {
  readonly uomCode: string;
  /** 1 of this unit = numerator / denominator base units. */
  readonly numerator: bigint;
  readonly denominator?: bigint;
  readonly isPurchaseDefault?: boolean;
  readonly isSalesDefault?: boolean;
  readonly barcode?: string | null;
}

/** Adds a unit to an item, or brings a deactivated one back with its new conversion. */
export async function addUnit(tx: Tx, ctx: ActorContext, itemCode: string, input: UnitInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, itemCode);
  const owner = await itemOf(tx, itemCode);
  const uomCode = requireText(input.uomCode, 'uomCode');
  const [uom] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, uomCode)).limit(1);
  if (!uom || !uom.active) throw new AdminValidationError('uomCode', 'is not an active unit of measure');
  if (uomCode === owner.baseUomCode) throw new AdminValidationError('uomCode', `is ${itemCode}'s base unit, which it already has at one`);
  const denominator = input.denominator ?? 1n;
  if (input.numerator <= 0n || denominator <= 0n) throw new AdminValidationError('numerator', 'must be more than nothing: one unit holds some of the base');
  if (input.numerator === denominator) throw new AdminValidationError('numerator', 'equals one base unit — that is the base unit under another name');

  const [existing] = await tx
    .select()
    .from(itemUom)
    .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, uomCode)))
    .limit(1);
  if (existing?.active) throw new AdminValidationError('uomCode', `is already one of ${itemCode}'s units`);

  if (input.isPurchaseDefault) await tx.update(itemUom).set({ isPurchaseDefault: false }).where(eq(itemUom.itemId, owner.id));
  if (input.isSalesDefault) await tx.update(itemUom).set({ isSalesDefault: false }).where(eq(itemUom.itemId, owner.id));

  const values = {
    conversionNumerator: input.numerator,
    conversionDenominator: denominator,
    isPurchaseDefault: input.isPurchaseDefault ?? false,
    isSalesDefault: input.isSalesDefault ?? false,
    barcode: input.barcode?.trim() || null,
    active: true,
    deactivatedReason: null,
    deactivatedAt: null,
    deactivatedBy: null,
  };
  if (existing)
    await tx
      .update(itemUom)
      .set(values)
      .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, uomCode)));
  else await tx.insert(itemUom).values({ itemId: owner.id, uomCode, ...values });

  await recordChange(tx, ctx, {
    action: existing ? 'item.unit_reactivated' : 'item.unit_added',
    objectType: PERMISSION_OBJECT,
    objectId: itemCode,
    after: { uomCode, oneUnitIs: `${formatFraction(input.numerator, denominator)} ${owner.baseUomCode}`, purchaseDefault: values.isPurchaseDefault, salesDefault: values.isSalesDefault },
    branchCode: ctx.branchCode,
  });
}

/** Makes one active unit the purchase (or sales) default; the others stop being it. */
export async function setDefault(tx: Tx, ctx: ActorContext, itemCode: string, uomCode: string, kind: 'purchase' | 'sales') {
  await permit(ctx, 'configure', PERMISSION_OBJECT, itemCode);
  const owner = await itemOf(tx, itemCode);
  await conversionOf(tx, itemCode, uomCode);
  const column = kind === 'purchase' ? { isPurchaseDefault: false } : { isSalesDefault: false };
  await tx.update(itemUom).set(column).where(eq(itemUom.itemId, owner.id));
  await tx
    .update(itemUom)
    .set(kind === 'purchase' ? { isPurchaseDefault: true } : { isSalesDefault: true })
    .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, uomCode)));
  await recordChange(tx, ctx, { action: `item.unit_${kind}_default`, objectType: PERMISSION_OBJECT, objectId: itemCode, after: { uomCode }, branchCode: ctx.branchCode });
}

/** Stops offering a unit. Documents written in it keep it; the base cannot go. */
export async function deactivate(tx: Tx, ctx: ActorContext, itemCode: string, uomCode: string, reason: string) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, itemCode);
  const owner = await itemOf(tx, itemCode);
  const why = requireText(reason, 'reason');
  if (uomCode === owner.baseUomCode) throw new AdminValidationError('uomCode', `is ${itemCode}'s base unit, which every quantity is converted through`);
  const [unit] = await tx
    .select()
    .from(itemUom)
    .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, uomCode), eq(itemUom.active, true)))
    .limit(1);
  if (!unit) throw new UnknownUnitError(itemCode, uomCode);
  await tx
    .update(itemUom)
    .set({ active: false, isPurchaseDefault: false, isSalesDefault: false, deactivatedReason: why, deactivatedAt: new Date(), deactivatedBy: ctx.principal.userId })
    .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, uomCode)));
  // A default that went with it falls back to the base.
  if (unit.isPurchaseDefault)
    await tx
      .update(itemUom)
      .set({ isPurchaseDefault: true })
      .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, owner.baseUomCode)));
  if (unit.isSalesDefault)
    await tx
      .update(itemUom)
      .set({ isSalesDefault: true })
      .where(and(eq(itemUom.itemId, owner.id), eq(itemUom.uomCode, owner.baseUomCode)));
  await recordChange(tx, ctx, { action: 'item.unit_deactivated', objectType: PERMISSION_OBJECT, objectId: itemCode, after: { uomCode }, reason: why, branchCode: ctx.branchCode });
}

/** "24", "1/2", "12.5" — how a conversion is said back to a person. */
export function formatFraction(numerator: bigint, denominator: bigint): string {
  if (denominator === 1n) return numerator.toString();
  if ((numerator * 1_000_000n) % denominator === 0n) return formatQuantity((numerator * 1_000_000n) / denominator);
  return `${numerator}/${denominator}`;
}
