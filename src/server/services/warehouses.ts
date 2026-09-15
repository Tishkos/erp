/**
 * Warehouse Setup — Operations build, block 7.
 *
 *   Warehouse Setup   Warehouse Name; Warehouse Code.
 *
 * Two fields, and the sponsor asks for no others, so no others are asked for.
 * The branch is not among them and cannot be omitted — §9.1 says a warehouse
 * belongs to exactly one branch and the column is NOT NULL — so it is taken
 * from whoever is making it rather than put on the form. A person creating a
 * warehouse is creating it where they work.
 *
 * Until now warehouses only came into being as part of creating a branch,
 * which meant a company could have exactly as many warehouses as branches.
 * Every screen that receives or issues stock has to name one, so that limit was
 * the whole of block 7 blocked behind it.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { branch, warehouse } from '../db/schema';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';

export const PERMISSION_OBJECT = 'warehouse';

export class WarehouseError extends Error {
  readonly code = 'WAREHOUSE_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'WarehouseError';
  }
}

/** Every warehouse the caller's branch scope reaches. Row level security decides. */
export async function list(tx: Tx) {
  return tx
    .select({
      code: warehouse.code,
      name: warehouse.name,
      branchCode: warehouse.branchCode,
      branchName: branch.name,
      warehouseType: warehouse.warehouseType,
      active: warehouse.active,
    })
    .from(warehouse)
    .leftJoin(branch, eq(branch.code, warehouse.branchCode))
    .orderBy(asc(warehouse.code));
}

/** The ones stock can actually be put into or taken out of, for a picker. */
export async function listActive(tx: Tx) {
  return tx
    .select({ code: warehouse.code, name: warehouse.name, branchCode: warehouse.branchCode })
    .from(warehouse)
    .where(and(eq(warehouse.active, true), eq(warehouse.warehouseType, 'main')))
    .orderBy(asc(warehouse.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(warehouse).where(eq(warehouse.code, code)).limit(1);
  return row ?? null;
}

export interface WarehouseInput {
  readonly code: string;
  readonly name: string;
}

export async function create(tx: Tx, ctx: ActorContext, input: WarehouseInput) {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();

  if (!code) throw new WarehouseError('A warehouse needs a code.');
  if (!name) throw new WarehouseError('A warehouse needs a name.');

  const existing = await get(tx, code);
  if (existing) {
    throw new WarehouseError(
      `Warehouse ${code} already exists — it is '${existing.name}'. Codes are what every stock ` +
        'movement names, so two warehouses cannot share one.',
    );
  }

  await tx.insert(warehouse).values({
    code,
    name,
    branchCode: ctx.branchCode,
    // The ordinary kind. Transit, quarantine and damaged-goods warehouses are
    // not part of block 7 and are not offered here, because a person choosing
    // one by accident would have stock they cannot sell and no way to see why.
    warehouseType: 'main',
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    branchCode: ctx.branchCode,
    after: { code, name, branchCode: ctx.branchCode },
    outcome: 'success',
  });

  return { code, name };
}

export async function rename(tx: Tx, ctx: ActorContext, code: string, name: string) {
  const existing = await get(tx, code);
  if (!existing) throw new WarehouseError(`No warehouse with code '${code}'.`);

  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: existing.branchCode,
  });

  const trimmed = name.trim();
  if (!trimmed) throw new WarehouseError('A warehouse needs a name.');

  await tx.update(warehouse).set({ name: trimmed }).where(eq(warehouse.code, code));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'warehouse.renamed',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    branchCode: existing.branchCode,
    before: { name: existing.name },
    after: { name: trimmed },
    outcome: 'success',
  });
}

/**
 * Closing a warehouse hides it from the pickers without touching what it holds.
 *
 * Deliberately not a deletion: the movements that put stock there point at this
 * row, and a warehouse that has ever held anything is part of the record of
 * where it was.
 */
export async function setActive(tx: Tx, ctx: ActorContext, code: string, active: boolean) {
  const existing = await get(tx, code);
  if (!existing) throw new WarehouseError(`No warehouse with code '${code}'.`);

  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: existing.branchCode,
  });

  await tx.update(warehouse).set({ active }).where(eq(warehouse.code, code));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: active ? 'warehouse.reopened' : 'warehouse.closed',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    branchCode: existing.branchCode,
    before: { active: existing.active },
    after: { active },
    outcome: 'success',
  });
}
