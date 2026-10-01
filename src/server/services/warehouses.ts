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
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { branch, warehouse } from '../db/schema';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import { allocateFreeCode } from './numbering';

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

/** Block 7's Warehouse Setup asks for a name; the code is the system's (0208). */
export interface WarehouseInput {
  readonly name: string;
}

export async function create(tx: Tx, ctx: ActorContext, input: WarehouseInput) {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const name = input.name.trim();
  if (!name) throw new WarehouseError('A warehouse needs a name.');

  // Minted, never typed — Critical Rule 1. Every stock movement names the
  // warehouse by this code, so it must be one nobody else holds.
  const code = await allocateFreeCode(
    tx,
    'WAREHOUSE_CODE',
    async (candidate) => Boolean(await get(tx, candidate)),
    ctx.principal.userId,
  );

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
export async function setActive(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  active: boolean,
  reason: string | null = null,
) {
  const existing = await get(tx, code);
  if (!existing) throw new WarehouseError(`No warehouse with code '${code}'.`);

  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: existing.branchCode,
  });

  // Closing one needs a reason, as deactivating a branch does. A warehouse that
  // went quiet is a warehouse whose stock reports change meaning from that day,
  // and "why" is the question somebody asks a year later.
  if (!active && !reason?.trim()) {
    throw new WarehouseError('Say why this warehouse is being closed.');
  }

  await tx.update(warehouse).set({ active }).where(eq(warehouse.code, code));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: active ? 'warehouse.reopened' : 'warehouse.closed',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    branchCode: existing.branchCode,
    before: { active: existing.active },
    after: { active },
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// Block 8's stage warehouses
// ---------------------------------------------------------------------------

/**
 * The three stages of an inbound shipment that hold stock of their own.
 *
 * Block 7's Warehouse Setup asks for a name and nothing else, so which stage a
 * warehouse holds is not on that form and never will be. But block 8 reads
 * `shipment_stage` to decide where goods at sea are booked, and until a
 * warehouse claims each stage `warehouseForStage` answers nothing, a posted
 * purchase invoice opens no tracking, and the Invoice Status Tracking screen
 * is empty with nothing on it to say why. The three are configuration the
 * company does not choose — block 8 names them — so they are made rather than
 * asked for.
 *
 * `main`, not `transit`: the purchase invoice has to be able to name the In
 * Process warehouse on a line, and the pickers only offer main warehouses.
 * Goods at sea are kept out of reach by the stage they are in, not by a type.
 */
export const SHIPMENT_STAGE_WAREHOUSES = [
  { stage: 'in_process', name: 'In Process' },
  { stage: 'on_board', name: 'On Board' },
  { stage: 'on_port', name: 'On Port' },
] as const;

export type ShipmentStage = (typeof SHIPMENT_STAGE_WAREHOUSES)[number]['stage'];

export interface StageWarehouse {
  readonly stage: ShipmentStage;
  readonly code: string;
  readonly name: string;
  /** False when it was already there — the second run of the same script. */
  readonly created: boolean;
}

/** Which warehouse holds each stage, for anybody who needs to see the setup. */
export async function stageWarehouses(tx: Tx) {
  return tx
    .select({
      code: warehouse.code,
      name: warehouse.name,
      branchCode: warehouse.branchCode,
      shipmentStage: warehouse.shipmentStage,
      active: warehouse.active,
    })
    .from(warehouse)
    .where(isNotNull(warehouse.shipmentStage))
    .orderBy(asc(warehouse.code));
}

/**
 * Makes sure each stage has its warehouse, and says what it found.
 *
 * Idempotent on the stage rather than on the name or the code: a company that
 * renamed "On Port" to something of its own still has an On Port warehouse,
 * and running this again must not give it a second one. The database holds the
 * same rule — one warehouse per stage, by unique index — so this cannot drift
 * from it by being called twice.
 */
export async function ensureStageWarehouses(
  tx: Tx,
  ctx: ActorContext,
): Promise<readonly StageWarehouse[]> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const result: StageWarehouse[] = [];

  for (const { stage, name } of SHIPMENT_STAGE_WAREHOUSES) {
    const [existing] = await tx
      .select({ code: warehouse.code, name: warehouse.name })
      .from(warehouse)
      .where(eq(warehouse.shipmentStage, stage))
      .limit(1);

    if (existing) {
      result.push({ stage, code: existing.code, name: existing.name, created: false });
      continue;
    }

    const code = await allocateFreeCode(
      tx,
      'WAREHOUSE_CODE',
      async (candidate) => Boolean(await get(tx, candidate)),
      ctx.principal.userId,
    );

    await tx.insert(warehouse).values({
      code,
      name,
      branchCode: ctx.branchCode,
      warehouseType: 'main',
      shipmentStage: stage,
    });

    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'warehouse.created',
      objectType: PERMISSION_OBJECT,
      objectId: code,
      branchCode: ctx.branchCode,
      after: { code, name, branchCode: ctx.branchCode, shipmentStage: stage },
      outcome: 'success',
    });

    result.push({ stage, code, name, created: true });
  }

  return result;
}
