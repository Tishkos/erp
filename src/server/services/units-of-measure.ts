/**
 * Units of measure — the vocabulary every item's quantity is stated in.
 *
 * Phase 2 requirement 4 asks for items with "a unit of measure". A unit is not
 * free text: PCS, PC and PIECE typed into three item records is three units as
 * far as any later report is concerned, and no amount of care at data entry
 * fixes it afterwards. So the list is a master of its own, and the item picks
 * from it.
 *
 * The code *is* the identity — there is no surrogate key — which is why a code
 * is never renamed. Renaming would silently restate every quantity ever
 * recorded against it.
 */
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { item, unitOfMeasure } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  codeFromName,
  normaliseCode,
  permit,
  recordChange,
  requireText,
  uniqueCode,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'uom';

export async function listAll(tx: Tx) {
  return tx
    .select({ code: unitOfMeasure.code, name: unitOfMeasure.name, active: unitOfMeasure.active })
    .from(unitOfMeasure)
    .orderBy(asc(unitOfMeasure.code));
}

/** The active units, for the item form's picker. */
export async function listActive(tx: Tx) {
  return tx
    .select({ code: unitOfMeasure.code, name: unitOfMeasure.name })
    .from(unitOfMeasure)
    .where(eq(unitOfMeasure.active, true))
    .orderBy(asc(unitOfMeasure.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('unit of measure', code);
  return row;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly code?: string; readonly name: string },
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(name), async (candidate) => {
        const [row] = await tx
          .select({ code: unitOfMeasure.code })
          .from(unitOfMeasure)
          .where(eq(unitOfMeasure.code, candidate));
        return Boolean(row);
      });

  const [existing] = await tx
    .select({ code: unitOfMeasure.code })
    .from(unitOfMeasure)
    .where(eq(unitOfMeasure.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already a unit of measure`);

  await tx.insert(unitOfMeasure).values({ code, name, active: true });
  await recordChange(tx, ctx, {
    action: 'uom.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, name },
  });
  return get(tx, code);
}

export async function update(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  input: { readonly name: string },
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const name = requireText(input.name, 'name');
  await tx.update(unitOfMeasure).set({ name }).where(eq(unitOfMeasure.code, code));
  await recordChange(tx, ctx, {
    action: 'uom.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name },
    after: { name },
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
    throw new AdminValidationError('reason', 'is required to deactivate a unit of measure');
  }
  // A unit still carrying items cannot be retired: the items would name a unit
  // no picker offers, and the next person to edit one could not save it back.
  if (!active) {
    const using = await tx.select({ id: item.id }).from(item).where(eq(item.baseUomCode, code)).limit(1);
    if (using.length > 0) {
      throw new AdminValidationError('code', 'is the base unit of at least one item');
    }
  }
  await tx.update(unitOfMeasure).set({ active }).where(eq(unitOfMeasure.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'uom.reactivated' : 'uom.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}

/** How many items name this unit as their base — shown on the record page. */
export async function itemsUsing(tx: Tx, code: string) {
  return tx
    .select({ id: item.id, code: item.code, name: item.name })
    .from(item)
    .where(eq(item.baseUomCode, code))
    .orderBy(asc(item.code));
}
