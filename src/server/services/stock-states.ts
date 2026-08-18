/**
 * Quarantine, damage and write-off — Phase 04.7 and 04.9, §8.4 and §9.8.
 *
 * Both are the same shape: stock moves to a warehouse where it cannot be sold,
 * something is decided about it, and it either comes back or leaves permanently.
 * §9.1 gives those warehouses their own types, so "can this be sold?" is a
 * question about where the stock is standing rather than a flag someone has to
 * remember to check — see migration 0027.
 *
 * What both share, and what makes this module worth having rather than two
 * copies of it, is the move itself: stock changes warehouse **at its own FIFO
 * cost**. Goods do not become cheaper by being quarantined or dearer by being
 * inspected. §9.2's single valuation method holds across the whole lifecycle,
 * so `moveAtCost` below is the one place a warehouse-to-warehouse move is
 * written, and quarantine, release, damage and write-off all go through it.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { warehouse as warehouseTable } from '../db/schema';
import { parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';

export const PERMISSION_OBJECT = 'inventory_movement';

export class WrongWarehouseTypeError extends Error {
  readonly code = 'WRONG_WAREHOUSE_TYPE';
  constructor(
    readonly warehouseCode: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    // §25 — the field, the reason, the corrective action.
    super(
      `${warehouseCode} is a '${actual}' warehouse, and this needs a '${expected}' one. ` +
        `Section 9.1 gives each warehouse a type so that stock which cannot be sold is somewhere it cannot be sold from. ` +
        `Choose a ${expected} warehouse, or change this one's type if that is what it is.`,
    );
    this.name = 'WrongWarehouseTypeError';
  }
}

async function assertWarehouseType(
  tx: Tx,
  warehouseCode: string,
  expected: string,
): Promise<void> {
  const [row] = await tx
    .select({ type: warehouseTable.warehouseType })
    .from(warehouseTable)
    .where(eq(warehouseTable.code, warehouseCode))
    .limit(1);

  if (!row) throw new Error(`No warehouse '${warehouseCode}'.`);
  if (row.type !== expected) {
    throw new WrongWarehouseTypeError(warehouseCode, expected, row.type);
  }
}

export interface MoveInput {
  readonly itemCode: string;
  readonly fromWarehouseCode: string;
  readonly toWarehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly movementDate: string;
  readonly issueKind: inventory.MovementKind;
  readonly receiptKind: inventory.MovementKind;
  readonly sourceDocumentType?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * Moves stock between warehouses at its own FIFO cost.
 *
 * The layers consumed at the source are recreated at the destination with the
 * same unit costs — the same rule as a warehouse transfer (04.6's gate), for
 * the same reason: goods are worth what they cost, wherever they are standing.
 * A move that recomputed cost would let quarantining stock change the margin on
 * it.
 */
export async function moveAtCost(
  tx: Tx,
  ctx: ActorContext,
  input: MoveInput,
): Promise<{ issueMovementId: string; receiptMovementIds: readonly string[] }> {
  const issued = await inventory.issue(tx, ctx, {
    itemCode: input.itemCode,
    warehouseCode: input.fromWarehouseCode,
    branchCode: input.branchCode,
    quantity: input.quantity,
    movementDate: input.movementDate,
    kind: input.issueKind,
    sourceDocumentType: input.sourceDocumentType ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
    post: input.post ?? false,
    dimensions: input.dimensions,
  });

  const consumed = await inventory.consumptionsOf(tx, issued.movementId);
  const receiptMovementIds: string[] = [];

  for (const consumption of consumed) {
    const received = await inventory.receive(tx, ctx, {
      itemCode: input.itemCode,
      warehouseCode: input.toWarehouseCode,
      branchCode: input.branchCode,
      quantity: parseQuantity(consumption.quantity),
      // The layer's own cost, carried across untouched.
      unitCostIqd: BigInt(consumption.unitCostIqd.replace('.', '')),
      movementDate: input.movementDate,
      kind: input.receiptKind,
      sourceDocumentType: input.sourceDocumentType ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      serialNumber: input.serialNumber ?? null,
      batchNumber: input.batchNumber ?? null,
      post: input.post ?? false,
      dimensions: input.dimensions,
    });
    receiptMovementIds.push(received.movementId);
  }

  return { issueMovementId: issued.movementId, receiptMovementIds };
}

// ---------------------------------------------------------------------------
// §8.4 — quarantine
// ---------------------------------------------------------------------------

export interface QuarantineInput {
  readonly itemCode: string;
  readonly quarantineWarehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly unitCostIqd: bigint;
  readonly movementDate: string;
  readonly sourceDocumentType?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
}

/**
 * §8.4 — *"Received in Quarantine."*
 *
 * Stock arrives into a quarantine warehouse rather than into stores. It is on
 * hand — the company owns it and it is on the premises — and it is not
 * available, because nobody has inspected it.
 */
export async function receiveIntoQuarantine(
  tx: Tx,
  ctx: ActorContext,
  input: QuarantineInput,
): Promise<{ movementId: string }> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });
  await assertWarehouseType(tx, input.quarantineWarehouseCode, 'quarantine');

  const movement = await inventory.receive(tx, ctx, {
    itemCode: input.itemCode,
    warehouseCode: input.quarantineWarehouseCode,
    branchCode: input.branchCode,
    quantity: input.quantity,
    unitCostIqd: input.unitCostIqd,
    movementDate: input.movementDate,
    kind: 'quarantine_in',
    sourceDocumentType: input.sourceDocumentType ?? null,
    sourceDocumentId: input.sourceDocumentId ?? null,
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.quarantined',
    objectType: PERMISSION_OBJECT,
    objectId: movement.movementId,
    branchCode: input.branchCode,
    after: { itemCode: input.itemCode, warehouse: input.quarantineWarehouseCode },
    outcome: 'success',
  });

  return { movementId: movement.movementId };
}

export interface ReleaseInput {
  readonly itemCode: string;
  readonly quarantineWarehouseCode: string;
  readonly targetWarehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly movementDate: string;
  readonly reason: string;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
}

/**
 * §8.4 — *"Inspected → Released to Warehouse."*
 *
 * The stock passed inspection and becomes saleable. Its FIFO layer goes with
 * it: inspection is not a cost event, and stock that sat in quarantine for a
 * week did not become worth more or less for having waited.
 */
export async function releaseFromQuarantine(
  tx: Tx,
  ctx: ActorContext,
  input: ReleaseInput,
): Promise<{ issueMovementId: string }> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (!input.reason.trim()) {
    throw new Error(
      'Releasing stock from quarantine is an inspection decision, and §5.4 keeps the reason with it. State what was inspected and found.',
    );
  }

  await assertWarehouseType(tx, input.quarantineWarehouseCode, 'quarantine');

  const moved = await moveAtCost(tx, ctx, {
    itemCode: input.itemCode,
    fromWarehouseCode: input.quarantineWarehouseCode,
    toWarehouseCode: input.targetWarehouseCode,
    branchCode: input.branchCode,
    quantity: input.quantity,
    movementDate: input.movementDate,
    issueKind: 'quarantine_release',
    receiptKind: 'transfer_receipt',
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.quarantine_released',
    objectType: PERMISSION_OBJECT,
    objectId: moved.issueMovementId,
    branchCode: input.branchCode,
    after: { itemCode: input.itemCode, to: input.targetWarehouseCode },
    reason: input.reason,
    outcome: 'success',
  });

  return { issueMovementId: moved.issueMovementId };
}

export interface RejectInput {
  readonly itemCode: string;
  readonly quarantineWarehouseCode: string;
  readonly returnsWarehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly movementDate: string;
  readonly reason: string;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
}

/**
 * §8.4 — *"Rejected for Return."*
 *
 * The stock failed inspection and goes to the returns warehouse, where Phase
 * 05's Goods Return picks it up. 04.7's gate is that this happens *without a
 * separate manual movement*: the rejection is the movement, and the return
 * document finds the stock already where it belongs rather than asking a
 * warehouse clerk to move it again and hope the two agree.
 */
export async function rejectFromQuarantine(
  tx: Tx,
  ctx: ActorContext,
  input: RejectInput,
): Promise<{ issueMovementId: string }> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (!input.reason.trim()) {
    throw new Error(
      'Rejecting stock is an inspection decision with a supplier consequence, and §5.4 keeps the reason with it. State what was wrong.',
    );
  }

  await assertWarehouseType(tx, input.quarantineWarehouseCode, 'quarantine');
  await assertWarehouseType(tx, input.returnsWarehouseCode, 'returns');

  const moved = await moveAtCost(tx, ctx, {
    itemCode: input.itemCode,
    fromWarehouseCode: input.quarantineWarehouseCode,
    toWarehouseCode: input.returnsWarehouseCode,
    branchCode: input.branchCode,
    quantity: input.quantity,
    movementDate: input.movementDate,
    issueKind: 'quarantine_reject',
    receiptKind: 'goods_return',
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.quarantine_rejected',
    objectType: PERMISSION_OBJECT,
    objectId: moved.issueMovementId,
    branchCode: input.branchCode,
    after: { itemCode: input.itemCode, to: input.returnsWarehouseCode },
    reason: input.reason,
    outcome: 'success',
  });

  return { issueMovementId: moved.issueMovementId };
}

// ---------------------------------------------------------------------------
// §9.8 — damage and write-off
// ---------------------------------------------------------------------------

export interface DamageInput {
  readonly itemCode: string;
  readonly fromWarehouseCode: string;
  readonly damagedWarehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly movementDate: string;
  readonly reason: string;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.8 — *"Damage Report → Warehouse Manager Approval → Transfer to Damaged
 * Warehouse."*
 *
 * The `approve` verb, not `execute`: moving stock out of saleable inventory
 * reduces what the company can sell and eventually writes off money, so §5.3's
 * separation applies. A warehouse clerk reports damage; a manager approves it.
 *
 * The stock keeps its cost on the way in, so the write-off that follows is at
 * what the goods actually cost rather than at a figure invented on the way.
 */
export async function approveDamage(
  tx: Tx,
  ctx: ActorContext,
  input: DamageInput,
): Promise<{ issueMovementId: string }> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (!input.reason.trim()) {
    throw new Error(
      'Approving damage takes stock out of saleable inventory and commits the company to a loss. §5.4 keeps the reason with it — state what was damaged and how.',
    );
  }

  await assertWarehouseType(tx, input.damagedWarehouseCode, 'damaged_goods');

  const moved = await moveAtCost(tx, ctx, {
    itemCode: input.itemCode,
    fromWarehouseCode: input.fromWarehouseCode,
    toWarehouseCode: input.damagedWarehouseCode,
    branchCode: input.branchCode,
    quantity: input.quantity,
    movementDate: input.movementDate,
    issueKind: 'transfer_issue',
    receiptKind: 'damage',
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.damage_approved',
    objectType: PERMISSION_OBJECT,
    objectId: moved.issueMovementId,
    branchCode: input.branchCode,
    after: { itemCode: input.itemCode, to: input.damagedWarehouseCode },
    reason: input.reason,
    outcome: 'success',
  });

  return { issueMovementId: moved.issueMovementId };
}

export interface WriteOffInput {
  readonly itemCode: string;
  readonly damagedWarehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly movementDate: string;
  readonly reason: string;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.8 — *"Inventory Write-Off."*
 *
 * The stock leaves the books at its FIFO cost, and Appendix C posts the loss:
 * *Dr Inventory Loss Expense / Cr Inventory*. This is the only way stock leaves
 * a damaged warehouse — migration 0027 refuses a move back into saleable stock,
 * so "returned to saleable after final damage approval" is unreachable rather
 * than merely forbidden.
 */
export async function writeOff(
  tx: Tx,
  ctx: ActorContext,
  input: WriteOffInput,
): Promise<{ movementId: string; costIqd: bigint }> {
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (!input.reason.trim()) {
    throw new Error(
      'A write-off removes value from the balance sheet. §5.4 keeps the reason with it — state why the stock is being written off.',
    );
  }

  await assertWarehouseType(tx, input.damagedWarehouseCode, 'damaged_goods');

  const written = await inventory.issue(tx, ctx, {
    itemCode: input.itemCode,
    warehouseCode: input.damagedWarehouseCode,
    branchCode: input.branchCode,
    quantity: input.quantity,
    movementDate: input.movementDate,
    kind: 'write_off',
    serialNumber: input.serialNumber ?? null,
    batchNumber: input.batchNumber ?? null,
    post: input.post ?? false,
    dimensions: input.dimensions,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.written_off',
    objectType: PERMISSION_OBJECT,
    objectId: written.movementId,
    branchCode: input.branchCode,
    after: {
      itemCode: input.itemCode,
      warehouse: input.damagedWarehouseCode,
      costIqd: written.costIqd?.toString() ?? '0',
    },
    reason: input.reason,
    outcome: 'success',
  });

  return { movementId: written.movementId, costIqd: written.costIqd ?? 0n };
}
