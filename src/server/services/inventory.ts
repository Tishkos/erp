/**
 * The inventory service — Phase 04.1, 04.2, 04.3, 04.4.
 *
 * Every write to stock goes through here. §9.9 requires that *"no UI, import or
 * API transaction can create negative stock"*, and the way to be sure of that
 * is for there to be one function that writes a movement, with the check inside
 * it — plus the deferred trigger in migration 0025, which holds when someone
 * finds a way round this file.
 *
 * The service is deliberately thin over `domain/fifo.ts` and
 * `domain/inventory.ts`: the arithmetic that decides a margin is pure and
 * hand-checkable, and this layer's job is to read the layers, apply the
 * decision and write both halves in one transaction. A partial application —
 * consumption rows written without the matching remaining quantities — is what
 * the deferred trigger in 0025 refuses.
 */
import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  costLayer,
  costLayerConsumption,
  inventoryMovement,
  item as itemTable,
  stockReservation,
  warehouse,
} from '../db/schema';
import {
  assertCanIssue,
  assertCanReserve,
  assertCanSell,
  availableQuantity,
  type StockPosition,
} from '../domain/inventory';
import {
  issue as planIssue,
  issueFromLayer as planReturn,
  receive as buildLayer,
  restore as restoreLayers,
  totalRemaining,
  valuation as valueLayers,
  type CostLayer,
  type LayerConsumption,
} from '../domain/fifo';
import { MOVEMENT_KINDS } from '../db/schema/inventory';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as posting from './posting';
import type { PostingRequest } from '../domain/posting';
import { costOf as fifoCostOf } from '../domain/fifo';

export const PERMISSION_OBJECT = 'inventory_movement';

export type MovementKind = (typeof MOVEMENT_KINDS)[number];

/**
 * The movements that take stock to a customer.
 *
 * These are the ones that need the stock to be *available*, not merely present:
 * §8.4 keeps quarantined stock out of sale and §9.8 keeps damaged stock out of
 * it. Every other movement — a release, a transfer, a write-off — is internal,
 * and needs only that the stock is physically there and not already promised.
 */
const SALE_KINDS: ReadonlySet<string> = new Set(['delivery']);

export class ItemNotStockedError extends Error {
  readonly code = 'ITEM_NOT_STOCKED';
  constructor(readonly itemCode: string) {
    super(
      `${itemCode} is a service, not a stock item, so it has no inventory. ` +
        'Services are consumed on receipt and never held (§9.1).',
    );
    this.name = 'ItemNotStockedError';
  }
}

export class TrackingRequiredError extends Error {
  readonly code = 'TRACKING_REQUIRED';
  constructor(
    readonly itemCode: string,
    readonly tracking: string,
    readonly missing: readonly string[],
  ) {
    // §25 — the field, the reason, the corrective action.
    super(
      `${itemCode} is tracked by ${tracking.replace(/_/g, ' ')}, so this movement needs ${missing.join(' and ')}. ` +
        'Tracking is what makes a recall or a warranty claim answerable (§9.3, §9.9). ' +
        'Supply the missing identification, or correct the item if it should not be tracked.',
    );
    this.name = 'TrackingRequiredError';
  }
}

export class SerialAlreadyOnHandError extends Error {
  readonly code = 'SERIAL_ALREADY_ON_HAND';
  constructor(
    readonly itemCode: string,
    readonly serialNumber: string,
    readonly warehouseCode: string,
  ) {
    super(
      `Serial ${serialNumber} of ${itemCode} is already on hand in ${warehouseCode}. ` +
        'A serial number identifies one physical unit, so it cannot be received twice without being issued in between (§9.3). ' +
        'Check the serial, or issue the existing unit first.',
    );
    this.name = 'SerialAlreadyOnHandError';
  }
}

// ---------------------------------------------------------------------------
// Reading the position
// ---------------------------------------------------------------------------

/**
 * The §9.5 position for one item in one warehouse.
 *
 * Read from the `stock_position` view, so it is the movements summed rather
 * than a stored figure that could have drifted from them.
 */
export async function positionOf(
  tx: Tx,
  itemCode: string,
  warehouseCode: string,
  branchCode: string,
): Promise<StockPosition> {
  // The view groups by branch as well as by item and warehouse. A warehouse
  // belongs to one branch, so this is one row — unless a movement was ever
  // written under another branch code, and then it is two, and reading the
  // first would show part of the stock and hide the rest. The negative-stock
  // trigger and the Stock Movement page both read the warehouse whole, so the
  // position does too: whatever rows there are, summed. `reserved` is not
  // summed, because the view already counts it once per row.
  const result = await tx.execute(sql`
    select sum(on_hand)::text        as on_hand,
           max(reserved)::text       as reserved,
           sum(in_quarantine)::text  as in_quarantine,
           sum(damaged)::text        as damaged,
           sum(returns_stock)::text  as returns_stock,
           max(in_transit)::text     as in_transit
      from stock_position
     where item_code = ${itemCode} and warehouse_code = ${warehouseCode}
  `);

  const row = (result as unknown as { rows: Record<string, string | null>[] }).rows[0];

  // No movements yet is a real position of zero, not a missing record — a
  // caller asking "how much do we have?" must never get null.
  if (!row || row.on_hand === null) {
    return {
      itemCode,
      warehouseCode,
      branchCode,
      onHand: 0n,
      reserved: 0n,
      inQuarantine: 0n,
      damaged: 0n,
      returnsStock: 0n,
      inTransit: 0n,
      orderedFromSuppliers: 0n,
      committedToCustomers: 0n,
    };
  }

  return {
    itemCode,
    warehouseCode,
    branchCode,
    onHand: parseQuantity(row.on_hand!),
    reserved: parseQuantity(row.reserved!),
    inQuarantine: parseQuantity(row.in_quarantine!),
    damaged: parseQuantity(row.damaged!),
    returnsStock: parseQuantity(row.returns_stock!),
    inTransit: parseQuantity(row.in_transit!),
    orderedFromSuppliers: 0n,
    committedToCustomers: 0n,
  };
}

/** Every position for an item, across warehouses — §9.5's four view levels. */
export async function positionsOf(tx: Tx, itemCode: string): Promise<StockPosition[]> {
  // One row per warehouse, whatever branch codes its movements carry — see
  // `positionOf`. The branch is the warehouse's own, not a movement's.
  const result = await tx.execute(sql`
    select p.warehouse_code,
           w.branch_code,
           sum(p.on_hand)::text        as on_hand,
           max(p.reserved)::text       as reserved,
           sum(p.in_quarantine)::text  as in_quarantine,
           sum(p.damaged)::text        as damaged,
           sum(p.returns_stock)::text  as returns_stock,
           max(p.in_transit)::text     as in_transit
      from stock_position p
      join warehouse w on w.code = p.warehouse_code
     where p.item_code = ${itemCode}
     group by p.warehouse_code, w.branch_code
     order by p.warehouse_code
  `);

  return (result as unknown as { rows: Record<string, string>[] }).rows.map((row) => ({
    itemCode,
    warehouseCode: row.warehouse_code!,
    branchCode: row.branch_code!,
    onHand: parseQuantity(row.on_hand!),
    reserved: parseQuantity(row.reserved!),
    inQuarantine: parseQuantity(row.in_quarantine!),
    damaged: parseQuantity(row.damaged!),
    returnsStock: parseQuantity(row.returns_stock!),
    inTransit: parseQuantity(row.in_transit!),
    orderedFromSuppliers: 0n,
    committedToCustomers: 0n,
  }));
}

/** A FIFO layer as the service reads it: the domain's layer, and whose stock it is. */
export type StockLayer = CostLayer & { readonly supplierId: string | null };

/** The FIFO layers with stock left, oldest first. */
export async function layersOf(
  tx: Tx,
  itemCode: string,
  warehouseCode: string,
  /**
   * Narrow to one supplier's stock — Operations block 5. Omitted, every layer
   * is read, which is the behaviour that came before.
   */
  supplierId?: string | null,
): Promise<StockLayer[]> {
  const rows = await tx
    .select()
    .from(costLayer)
    .where(
      and(
        eq(costLayer.itemCode, itemCode),
        eq(costLayer.warehouseCode, warehouseCode),
        supplierId ? eq(costLayer.supplierId, supplierId) : undefined,
      ),
    )
    .orderBy(asc(costLayer.layerDate), asc(costLayer.sequence));

  return rows.map((row) => ({
    id: row.id,
    itemCode: row.itemCode,
    warehouseCode: row.warehouseCode,
    layerDate: row.layerDate,
    sequence: row.sequence,
    originalQuantity: parseQuantity(row.originalQuantity),
    remainingQuantity: parseQuantity(row.remainingQuantity),
    unitCostIqd: BigInt(row.unitCostIqd.replace('.', '')),
    supplierId: row.supplierId,
  }));
}

/**
 * The value of what is on hand, from the layers.
 *
 * 04.2's gate requires this to equal the inventory G/L control account balance.
 * Both are derived from the same movements, so it can — and the integration
 * test checks that it does rather than assuming it.
 */
export async function valuationOf(
  tx: Tx,
  itemCode: string,
  warehouseCode: string,
): Promise<bigint> {
  return valueLayers(await layersOf(tx, itemCode, warehouseCode));
}

// ---------------------------------------------------------------------------
// §9.3 — tracking
// ---------------------------------------------------------------------------

async function loadItem(tx: Tx, itemCode: string) {
  const [row] = await tx.select().from(itemTable).where(eq(itemTable.code, itemCode)).limit(1);
  if (!row) throw new Error(`No item '${itemCode}'.`);
  return row;
}

export class WarehouseBranchMismatchError extends Error {
  readonly code = 'WAREHOUSE_BRANCH_MISMATCH';
  constructor(
    readonly warehouseCode: string,
    readonly warehouseBranch: string,
    readonly requestedBranch: string,
  ) {
    super(
      `${warehouseCode} belongs to branch ${warehouseBranch}, and this movement was raised under ${requestedBranch}. ` +
        'Stock is recorded under the branch of the warehouse that holds it, so the two must agree. ' +
        'Choose a warehouse of the current branch, or switch branch first.',
    );
    this.name = 'WarehouseBranchMismatchError';
  }
}

/**
 * The branch a movement is recorded under is the warehouse's, not the actor's.
 *
 * `stock_position` groups by branch, row-level security scopes by branch, and
 * a warehouse belongs to exactly one. A movement written under any other
 * branch code would be stock that the warehouse's own branch cannot see and
 * that the position view splits into two rows. Rather than quietly rewriting
 * the caller's branch, the mismatch is refused: a caller that names the wrong
 * branch has usually chosen the wrong warehouse (2026-09-27). Migration 0215
 * holds the same rule in the database for anything that does not come through
 * here.
 */
async function branchOfWarehouse(tx: Tx, warehouseCode: string, requested: string): Promise<string> {
  const [house] = await tx
    .select({ branchCode: warehouse.branchCode })
    .from(warehouse)
    .where(eq(warehouse.code, warehouseCode))
    .limit(1);
  if (!house) throw new Error(`No warehouse '${warehouseCode}'.`);
  if (house.branchCode !== requested) {
    throw new WarehouseBranchMismatchError(warehouseCode, house.branchCode, requested);
  }
  return house.branchCode;
}

/**
 * §9.3 — *"tracking is mandatory; no-tracking is not allowed"* for stock items.
 *
 * Checked per movement rather than per document, because a movement is the
 * thing that has to be traceable: §9.9 requires serial/batch traceability
 * "from receipt to transfer, delivery, return and write-off", and every one of
 * those is a movement.
 */
export function assertTrackingSupplied(
  itemCode: string,
  tracking: string | null,
  supplied: { serialNumber?: string | null; batchNumber?: string | null },
): void {
  if (!tracking) return;

  const missing: string[] = [];
  if (tracking === 'serial' || tracking === 'serial_and_batch') {
    if (!supplied.serialNumber?.trim()) missing.push('a serial number');
  }
  if (tracking === 'batch' || tracking === 'serial_and_batch') {
    if (!supplied.batchNumber?.trim()) missing.push('a batch number');
  }

  if (missing.length > 0) throw new TrackingRequiredError(itemCode, tracking, missing);
}

/** Whether this serial is currently on hand somewhere — §9.3. */
async function serialOnHand(
  tx: Tx,
  itemCode: string,
  serialNumber: string,
): Promise<string | null> {
  const result = await tx.execute(sql`
    select warehouse_code, sum(quantity) as quantity
      from inventory_movement
     where item_code = ${itemCode} and serial_number = ${serialNumber}
     group by warehouse_code
    having sum(quantity) > 0
     limit 1
  `);

  const row = (result as unknown as { rows: { warehouse_code: string }[] }).rows[0];
  return row?.warehouse_code ?? null;
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

export interface ReceiveInput {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  /** IQD cost of one base unit, scaled at MONEY_SCALE. */
  readonly unitCostIqd: bigint;
  /**
   * Who supplied this stock — Operations block 5.
   *
   * Recorded on the layer so a later sale can consume one supplier's stock and
   * not another's. Null where the stock arrived without one: opening stock, a
   * transfer, a reconciliation.
   */
  readonly supplierId?: string | null;
  readonly movementDate: string;
  readonly kind?: MovementKind;
  /**
   * §9.7 — opening stock may state a cost-layer date earlier than the movement
   * date, because that stock genuinely is older and must be consumed first.
   */
  readonly layerDate?: string;
  readonly sourceDocumentType?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly sourceLineId?: string | null;
  readonly journalEntryId?: string | null;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly expiryDate?: string | null;
  readonly manufacturedOn?: string | null;
  /**
   * Post the accounting effect through the Phase 02 engine, in this
   * transaction (Appendix C). Off by default: a movement that is part of a
   * larger document posts once, with the document, rather than line by line.
   */
  readonly post?: boolean;
  /** Analytical dimensions for the posting (§4.2) — the source document's. */
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

export interface MovementResult {
  readonly movementId: string;
  readonly layerId?: string;
  readonly consumptions?: readonly LayerConsumption[];
  readonly costIqd?: bigint;
}

/**
 * Stock arrives: one movement, one cost layer.
 *
 * The layer's sequence is allocated from a per-item, per-warehouse, per-date
 * counter, so two receipts on the same day consume in the order they happened
 * rather than in whatever order the planner returns them (04.2's determinism
 * gate).
 */
export async function receive(
  tx: Tx,
  ctx: ActorContext,
  input: ReceiveInput,
): Promise<MovementResult> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const stockItem = await loadItem(tx, input.itemCode);
  if (!stockItem.isStock) throw new ItemNotStockedError(input.itemCode);
  await branchOfWarehouse(tx, input.warehouseCode, input.branchCode);

  assertTrackingSupplied(input.itemCode, stockItem.tracking, input);

  if (input.serialNumber) {
    const held = await serialOnHand(tx, input.itemCode, input.serialNumber);
    if (held) {
      throw new SerialAlreadyOnHandError(input.itemCode, input.serialNumber, held);
    }
  }

  const layerDate = input.layerDate ?? input.movementDate;

  // The id is generated here rather than by the database, because the posting
  // needs it as its source reference and the movement needs the journal id —
  // and the ledger is append-only, so neither row can be updated to point at
  // the other afterwards. Both are written knowing both.
  const movementId = randomUUID();
  const journalEntryId = input.post
    ? (
        await postMovement(tx, ctx, {
          kind: input.kind ?? 'goods_receipt',
          movementId,
          itemCode: input.itemCode,
          warehouseCode: input.warehouseCode,
          branchCode: input.branchCode,
          movementDate: input.movementDate,
          costIqd: fifoCostOf(input.quantity, input.unitCostIqd),
          sourceDocumentType: input.sourceDocumentType ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          dimensions: input.dimensions,
        })
      )?.journalEntryId ?? null
    : (input.journalEntryId ?? null);

  const [movement] = await tx
    .insert(inventoryMovement)
    .values({
      id: movementId,
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      branchCode: input.branchCode,
      kind: input.kind ?? 'goods_receipt',
      quantity: formatQuantity(input.quantity),
      movementDate: input.movementDate,
      sourceDocumentType: input.sourceDocumentType ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceLineId: input.sourceLineId ?? null,
      journalEntryId,
      serialNumber: input.serialNumber ?? null,
      batchNumber: input.batchNumber ?? null,
      expiryDate: input.expiryDate ?? null,
      manufacturedOn: input.manufacturedOn ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: inventoryMovement.id });

  const sequence = await nextLayerSequence(tx, input.itemCode, input.warehouseCode, layerDate);

  // Built through the domain so the receipt rules (positive quantity, no
  // negative cost) are the same ones the pure tests cover.
  const layer = buildLayer({
    id: crypto.randomUUID(),
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
    layerDate,
    sequence,
    quantity: input.quantity,
    unitCostIqd: input.unitCostIqd,
  });

  await tx.insert(costLayer).values({
    id: layer.id,
    itemCode: layer.itemCode,
    warehouseCode: layer.warehouseCode,
    branchCode: input.branchCode,
    layerDate: layer.layerDate,
    sequence: layer.sequence,
    originalQuantity: formatQuantity(layer.originalQuantity),
    remainingQuantity: formatQuantity(layer.remainingQuantity),
    unitCostIqd: toDecimalString(layer.unitCostIqd, 4n),
    supplierId: input.supplierId ?? null,
    createdByMovementId: movement!.id,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.received',
    objectType: PERMISSION_OBJECT,
    objectId: movement!.id,
    branchCode: input.branchCode,
    after: {
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      quantity: formatQuantity(input.quantity),
      unitCostIqd: toDecimalString(input.unitCostIqd, 4n),
      layerDate,
    },
    outcome: 'success',
  });

  return { movementId: movement!.id, layerId: layer.id };
}

/** Negates a stored money string, keeping its precision. */
function formatSignedMoney(value: string): string {
  return value.startsWith('-') ? value.slice(1) : `-${value}`;
}

async function nextLayerSequence(
  tx: Tx,
  itemCode: string,
  warehouseCode: string,
  layerDate: string,
): Promise<number> {
  const [row] = await tx
    .select({ sequence: costLayer.sequence })
    .from(costLayer)
    .where(
      and(
        eq(costLayer.itemCode, itemCode),
        eq(costLayer.warehouseCode, warehouseCode),
        eq(costLayer.layerDate, layerDate),
      ),
    )
    .orderBy(desc(costLayer.sequence))
    .limit(1);

  return (row?.sequence ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssueInput {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly movementDate: string;
  readonly kind?: MovementKind;
  readonly sourceDocumentType?: string | null;
  readonly sourceDocumentId?: string | null;
  readonly sourceLineId?: string | null;
  readonly journalEntryId?: string | null;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  /**
   * Take the cost from one supplier's stock only — Operations block 5.
   *
   * The availability check narrows with it: selling ten of a supplier's panels
   * when only six of theirs are on hand is short, however much of another
   * supplier's stock is sitting beside it.
   */
  readonly supplierId?: string | null;
  /** Post the accounting effect in this transaction (Appendix C). */
  readonly post?: boolean;
  /** Analytical dimensions for the posting (§4.2) — the source document's. */
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * Stock leaves: availability is checked, the oldest layers are consumed, and
 * the movement, the consumption rows and the new remaining quantities are
 * written together.
 *
 * The order matters. The availability check happens against the position
 * *before* the write, and the FIFO plan is computed from the layers as they
 * are; if either were done after, a concurrent issue could pass both checks
 * and leave the warehouse negative. The row lock below is what makes that
 * impossible rather than unlikely.
 */
export async function issue(
  tx: Tx,
  ctx: ActorContext,
  input: IssueInput,
): Promise<MovementResult> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const stockItem = await loadItem(tx, input.itemCode);
  if (!stockItem.isStock) throw new ItemNotStockedError(input.itemCode);
  await branchOfWarehouse(tx, input.warehouseCode, input.branchCode);
  assertTrackingSupplied(input.itemCode, stockItem.tracking, input);

  // §9.2 — the layers for this item and warehouse are locked for the duration
  // of the transaction, so two concurrent issues serialise rather than both
  // reading the same remaining quantities. 04.4's gate: "Two concurrent issues
  // that individually fit but jointly exceed available stock cannot both
  // succeed."
  await tx.execute(sql`
    select id from cost_layer
     where item_code = ${input.itemCode} and warehouse_code = ${input.warehouseCode}
     for update
  `);

  const position = await positionOf(tx, input.itemCode, input.warehouseCode, input.branchCode);

  // Which rule applies is decided by what the movement *is*. Shipping stock to
  // a customer needs it to be available for sale (§8.4, §9.8); releasing it from
  // quarantine or writing it off needs only that it is physically there. Both
  // refuse to leave the warehouse negative.
  if (SALE_KINDS.has(input.kind ?? 'delivery')) {
    assertCanSell(position, input.quantity);
  } else {
    assertCanIssue(position, input.quantity);
  }

  const layers = await layersOf(tx, input.itemCode, input.warehouseCode, input.supplierId);
  const plan = planIssue(layers, input.quantity, {
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
  });

  // As in `receive`: the id is known before either row is written, because the
  // posting references the movement and the movement records the journal, and
  // neither can be updated afterwards.
  const movementId = randomUUID();
  const journalEntryId = input.post
    ? (
        await postMovement(tx, ctx, {
          kind: input.kind ?? 'delivery',
          movementId,
          itemCode: input.itemCode,
          warehouseCode: input.warehouseCode,
          branchCode: input.branchCode,
          movementDate: input.movementDate,
          // The FIFO cost of what actually left — §9.2's single valuation
          // method is what lets the G/L and the layers agree.
          costIqd: plan.totalCostIqd,
          sourceDocumentType: input.sourceDocumentType ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          dimensions: input.dimensions,
        })
      )?.journalEntryId ?? null
    : (input.journalEntryId ?? null);

  const [movement] = await tx
    .insert(inventoryMovement)
    .values({
      id: movementId,
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      branchCode: input.branchCode,
      kind: input.kind ?? 'delivery',
      quantity: formatQuantity(-input.quantity),
      movementDate: input.movementDate,
      sourceDocumentType: input.sourceDocumentType ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceLineId: input.sourceLineId ?? null,
      journalEntryId,
      serialNumber: input.serialNumber ?? null,
      batchNumber: input.batchNumber ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: inventoryMovement.id });

  for (const consumption of plan.consumptions) {
    await tx.insert(costLayerConsumption).values({
      movementId: movement!.id,
      layerId: consumption.layerId,
      quantity: formatQuantity(consumption.quantity),
      unitCostIqd: toDecimalString(consumption.unitCostIqd, 4n),
      costIqd: toDecimalString(consumption.costIqd, 4n),
    });
  }

  for (const layer of plan.layers) {
    await tx
      .update(costLayer)
      .set({ remainingQuantity: formatQuantity(layer.remainingQuantity) })
      .where(eq(costLayer.id, layer.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.issued',
    objectType: PERMISSION_OBJECT,
    objectId: movement!.id,
    branchCode: input.branchCode,
    after: {
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      quantity: formatQuantity(input.quantity),
      costIqd: toDecimalString(plan.totalCostIqd, 4n),
      layers: plan.consumptions.map((c) => ({
        layerId: c.layerId,
        quantity: formatQuantity(c.quantity),
      })),
    },
    outcome: 'success',
  });

  return {
    movementId: movement!.id,
    consumptions: plan.consumptions,
    costIqd: plan.totalCostIqd,
  };
}

export interface IssueFromLayerInput extends Omit<IssueInput, 'quantity'> {
  /** The layer the goods came in on — usually a goods receipt's own layer. */
  readonly costLayerId: string;
  readonly quantity: bigint;
}

/**
 * §8.7 — stock leaving against an identified cost layer.
 *
 * Used by the Goods Return: the goods going back to a supplier are the ones
 * that supplier delivered, so they come out of the layer that receipt created
 * rather than out of the oldest. `issueFromLayer` in the domain explains why
 * that is not a departure from FIFO.
 *
 * Everything else is `issue`: the same lock, the same availability rule, the
 * same consumption rows. Only the choice of layer differs, and it is the
 * caller's rather than the order's.
 */
export async function issueFromLayer(
  tx: Tx,
  ctx: ActorContext,
  input: IssueFromLayerInput,
): Promise<MovementResult> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const stockItem = await loadItem(tx, input.itemCode);
  if (!stockItem.isStock) throw new ItemNotStockedError(input.itemCode);
  await branchOfWarehouse(tx, input.warehouseCode, input.branchCode);
  assertTrackingSupplied(input.itemCode, stockItem.tracking, input);

  await tx.execute(sql`
    select id from cost_layer
     where item_code = ${input.itemCode} and warehouse_code = ${input.warehouseCode}
     for update
  `);

  const position = await positionOf(tx, input.itemCode, input.warehouseCode, input.branchCode);
  // A return is a physical movement, not a sale: quarantined or damaged goods
  // are precisely the ones most likely to be going back (§8.4, §9.8).
  assertCanIssue(position, input.quantity);

  const layers = await layersOf(tx, input.itemCode, input.warehouseCode);
  const plan = planReturn(layers, input.costLayerId, input.quantity, {
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
  });

  const movementId = randomUUID();
  const journalEntryId = input.post
    ? (
        await postMovement(tx, ctx, {
          kind: input.kind ?? 'goods_return',
          movementId,
          itemCode: input.itemCode,
          warehouseCode: input.warehouseCode,
          branchCode: input.branchCode,
          movementDate: input.movementDate,
          costIqd: plan.totalCostIqd,
          sourceDocumentType: input.sourceDocumentType ?? null,
          sourceDocumentId: input.sourceDocumentId ?? null,
          dimensions: input.dimensions,
        })
      )?.journalEntryId ?? null
    : (input.journalEntryId ?? null);

  const [movement] = await tx
    .insert(inventoryMovement)
    .values({
      id: movementId,
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      branchCode: input.branchCode,
      kind: input.kind ?? 'goods_return',
      quantity: formatQuantity(-input.quantity),
      movementDate: input.movementDate,
      sourceDocumentType: input.sourceDocumentType ?? null,
      sourceDocumentId: input.sourceDocumentId ?? null,
      sourceLineId: input.sourceLineId ?? null,
      journalEntryId,
      serialNumber: input.serialNumber ?? null,
      batchNumber: input.batchNumber ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: inventoryMovement.id });

  for (const consumption of plan.consumptions) {
    await tx.insert(costLayerConsumption).values({
      movementId: movement!.id,
      layerId: consumption.layerId,
      quantity: formatQuantity(consumption.quantity),
      unitCostIqd: toDecimalString(consumption.unitCostIqd, 4n),
      costIqd: toDecimalString(consumption.costIqd, 4n),
    });
  }

  for (const layer of plan.layers) {
    await tx
      .update(costLayer)
      .set({ remainingQuantity: formatQuantity(layer.remainingQuantity) })
      .where(eq(costLayer.id, layer.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.returned',
    objectType: PERMISSION_OBJECT,
    objectId: movement!.id,
    branchCode: input.branchCode,
    after: {
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      quantity: formatQuantity(input.quantity),
      costLayerId: input.costLayerId,
      costIqd: toDecimalString(plan.totalCostIqd, 4n),
    },
    outcome: 'success',
  });

  return {
    movementId: movement!.id,
    consumptions: plan.consumptions,
    costIqd: plan.totalCostIqd,
  };
}

/** The layer a goods receipt created, for a return to draw on (§8.7). */
export async function layerForMovement(tx: Tx, movementId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: costLayer.id })
    .from(costLayer)
    .where(eq(costLayer.createdByMovementId, movementId))
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Posting — Appendix C, §24
// ---------------------------------------------------------------------------

/**
 * The accounting effect of a movement, as Appendix C states it.
 *
 * Line **roles**, never accounts. §3.3: *"Posting accounts shall be selected
 * through configurable accounting mappings, not hard-coded account numbers."*
 * The engine resolves each role through the mapping, so changing which account
 * inventory sits in is configuration — and the 02.7 gate that "no account
 * number is hardcoded anywhere" keeps holding as this module grows.
 *
 * A movement kind absent from this table posts nothing, which is a real answer:
 * a transfer *request* moves no stock and has no accounting effect until the
 * goods are issued.
 */
const POSTING_EFFECTS: Readonly<
  Record<string, { readonly debit: string; readonly credit: string } | undefined>
> = Object.freeze({
  // "Purchase Goods Receipt | Inventory | GRNI | PO and warehouse receipt
  // required; FIFO layer created."
  goods_receipt: { debit: 'inventory', credit: 'grni' },
  // "Sales delivery and invoice | Customer A/R; COGS | Sales Revenue; Inventory"
  // — the inventory half of it; the revenue half belongs to the invoice.
  delivery: { debit: 'cogs', credit: 'inventory' },
  // "Warehouse transfer issue | Inventory in Transit | Source Warehouse Inventory"
  transfer_issue: { debit: 'inventory_in_transit', credit: 'inventory' },
  // "Warehouse transfer receipt | Destination Warehouse Inventory | Inventory in Transit"
  transfer_receipt: { debit: 'inventory', credit: 'inventory_in_transit' },
  // "Inventory loss | Inventory Loss Expense | Inventory / Inventory in Transit"
  write_off: { debit: 'inventory_loss', credit: 'inventory' },
  damage: { debit: 'inventory_loss', credit: 'inventory' },
  count_adjustment: { debit: 'inventory_loss', credit: 'inventory' },
  opening_stock: { debit: 'inventory', credit: 'opening_balance' },
  sales_return: { debit: 'inventory', credit: 'cogs' },
  // Appendix C: "Goods Return | Dr Return Clearing / Supplier position |
  // Cr Inventory". Return Clearing rather than GRNI because §8.2's flow puts
  // the return *after* the invoice — the debt is already in payables by then,
  // and crediting GRNI would clear a liability that the receipt has already
  // discharged. The clearing account holds the gap between the stock leaving
  // and the supplier agreeing to credit it, and the Supplier Credit Memo empties
  // it (Dr Supplier A/P / Cr Return Clearing).
  goods_return: { debit: 'return_clearing', credit: 'inventory' },
});

/** Whether a movement of this kind posts at all. */
export function postsToLedger(kind: MovementKind): boolean {
  return POSTING_EFFECTS[kind] !== undefined;
}

/**
 * Builds the posting request for a movement.
 *
 * The value is the FIFO cost — what the goods actually cost, not what they are
 * worth or what they were priced at. That is the whole point of §9.2's single
 * valuation method: the G/L and the layers describe the same stock, so the
 * 04.2 gate ("valuation from layers equals the inventory control account
 * balance") can hold rather than approximately hold.
 */
export function postingRequestFor(input: {
  kind: MovementKind;
  movementId: string;
  itemCode: string;
  warehouseCode: string;
  branchCode: string;
  movementDate: string;
  costIqd: bigint;
  sourceDocumentType?: string | null;
  sourceDocumentId?: string | null;
  /**
   * The analytical dimensions the source document carries (§4.2). Supplied by
   * the caller rather than invented here: a delivery knows its department and
   * business line, and a movement on its own does not.
   */
  dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}): PostingRequest | null {
  const effect = POSTING_EFFECTS[input.kind];
  if (!effect || input.costIqd === 0n) return null;

  const amount = toDecimalString(input.costIqd < 0n ? -input.costIqd : input.costIqd, 4n);
  const dimensions = {
    warehouse: input.warehouseCode,
    branch: input.branchCode,
    ...(input.dimensions ?? {}),
  };
  const criteria = { warehouseCode: input.warehouseCode, branchCode: input.branchCode };

  return {
    eventType: `inventory.${input.kind}`,
    // The document that moved the stock decides which dimensions it must
    // carry (§4.2's document-type layer) — a sales return's credit to COGS is
    // judged as a sales return, not as a bare movement.
    ...(input.sourceDocumentType ? { documentTypeCode: input.sourceDocumentType } : {}),
    source: {
      module: 'inventory',
      // The movement, not the document that caused it: a goods receipt with ten
      // lines makes ten movements, and each posts once. Keying on the document
      // would make the second line look like a duplicate of the first (§23).
      documentId: input.movementId,
      event: input.kind,
    },
    branchCode: input.branchCode,
    documentDate: input.movementDate,
    postingDate: input.movementDate,
    description: `${input.kind.replace(/_/g, ' ')} — ${input.itemCode} in ${input.warehouseCode}`,
    lines: [
      { role: effect.debit, debit: amount, criteria, dimensions },
      { role: effect.credit, credit: amount, criteria, dimensions },
    ],
  };
}

/**
 * Posts a movement's accounting effect, in the caller's transaction.
 *
 * §24: *"either all journal/subledger/inventory records commit, or none do."*
 * The caller's transaction is used, never a new one, so a movement and its
 * journal are one act — and the journal id goes back onto the movement, which
 * is Appendix B's "posting journal" field.
 */
export async function postMovement(
  tx: Tx,
  ctx: ActorContext,
  input: Parameters<typeof postingRequestFor>[0],
): Promise<{ journalEntryId: string } | null> {
  const planned = postingRequestFor(input);
  if (!planned) return null;

  // The item's own accounts answer the inventory and cost-of-sales lines —
  // block 1 puts an Inventory Account and a COGS Account on every item, and the
  // invoices already post to them. A movement that asked a mapping instead
  // would hold the same goods in a second account, or refuse for want of a
  // mapping nobody can set. A rule narrowed to this warehouse still wins
  // (`resolveLineAccount`); a plain mapping does not.
  const [accounts] = await tx
    .select({ inventory: itemTable.inventoryAccountId, cogs: itemTable.cogsAccountId })
    .from(itemTable)
    .where(eq(itemTable.code, input.itemCode))
    .limit(1);
  const request: PostingRequest = {
    ...planned,
    lines: planned.lines.map((line) =>
      line.role === 'inventory' && accounts?.inventory
        ? { ...line, itemAccountId: accounts.inventory }
        : line.role === 'cogs' && accounts?.cogs
          ? { ...line, itemAccountId: accounts.cogs }
          : line,
    ),
  };

  const result = await posting.post(tx, ctx, request);

  // The movement is append-only, so the journal link is written by the same
  // statement that inserts it — see `receive` and `issue`, which pass the
  // journal in. This path exists for callers that post after the fact, and it
  // returns the id rather than updating the row.
  return { journalEntryId: result.journalEntryId };
}

// ---------------------------------------------------------------------------
// Reversal — §9.2
// ---------------------------------------------------------------------------

/**
 * Undoes a movement, restoring the exact layers it consumed.
 *
 * A reversal is a new movement pointing at the original, never an edit: the
 * ledger is append-only, and "what happened" includes the mistake.
 */
export async function reverseMovement(
  tx: Tx,
  ctx: ActorContext,
  movementId: string,
  reason: string,
): Promise<MovementResult> {
  const [original] = await tx
    .select()
    .from(inventoryMovement)
    .where(eq(inventoryMovement.id, movementId))
    .limit(1);

  if (!original) throw new Error(`No inventory movement '${movementId}'.`);

  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: original.branchCode,
  });

  if (!reason.trim()) {
    throw new Error(
      'A reversal needs a reason, and it is kept with the movement (§5.4). State why the stock is being put back.',
    );
  }

  const consumptions = await tx
    .select()
    .from(costLayerConsumption)
    .where(eq(costLayerConsumption.movementId, movementId));

  // A receipt made a layer, and reversing the receipt must take the layer
  // back out — or the Warehouses Report, which values the layers, would keep
  // showing stock the ledger says has gone. Only a layer nobody has drawn on
  // can go: goods already issued from it are somewhere, and the correction
  // for that is a return or a reconciliation, not an undo.
  const layerId = await layerForMovement(tx, movementId);
  const [layer] = layerId
    ? await tx.select().from(costLayer).where(eq(costLayer.id, layerId)).limit(1).for('update')
    : [];
  if (layer && parseQuantity(layer.remainingQuantity) !== parseQuantity(layer.originalQuantity)) {
    throw new Error(
      `Movement ${movementId} received ${formatQuantity(parseQuantity(layer.originalQuantity))} of ${original.itemCode} ` +
        `into ${original.warehouseCode}, and ${formatQuantity(parseQuantity(layer.originalQuantity) - parseQuantity(layer.remainingQuantity))} ` +
        'of that has since been issued. A receipt that stock has left cannot be reversed (§9.2); ' +
        'take the rest out with a return or a reconciliation.',
    );
  }

  const [reversal] = await tx
    .insert(inventoryMovement)
    .values({
      itemCode: original.itemCode,
      warehouseCode: original.warehouseCode,
      branchCode: original.branchCode,
      kind: 'reversal',
      quantity: formatQuantity(-parseQuantity(original.quantity)),
      movementDate: original.movementDate,
      sourceDocumentType: original.sourceDocumentType,
      sourceDocumentId: original.sourceDocumentId,
      sourceLineId: original.sourceLineId,
      serialNumber: original.serialNumber,
      batchNumber: original.batchNumber,
      reversesMovementId: movementId,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: inventoryMovement.id });

  if (consumptions.length > 0) {
    // The original layers are restored — not a new layer at the issue's cost,
    // which would sit in the wrong place in the FIFO order and make the next
    // issue cost differently (§9.2).
    const layers = await layersOf(tx, original.itemCode, original.warehouseCode);
    const restored = restoreLayers(
      layers,
      consumptions.map((c) => ({
        layerId: c.layerId,
        quantity: parseQuantity(c.quantity),
        unitCostIqd: BigInt(c.unitCostIqd.replace('.', '')),
        costIqd: BigInt(c.costIqd.replace('.', '')),
      })),
    );

    // The restoration is recorded as a negative consumption against the
    // reversal movement, not as a silent adjustment to the layer. Two reasons:
    // the layer's remaining quantity stays reconcilable to its history for the
    // life of the layer (the deferred trigger in 0025 checks exactly that), and
    // "this reversal put 100 back into that layer" becomes a fact someone can
    // read rather than one they have to infer from two numbers not matching.
    for (const consumption of consumptions) {
      await tx.insert(costLayerConsumption).values({
        movementId: reversal!.id,
        layerId: consumption.layerId,
        quantity: formatQuantity(-parseQuantity(consumption.quantity)),
        unitCostIqd: consumption.unitCostIqd,
        costIqd: formatSignedMoney(consumption.costIqd),
      });
    }

    for (const layer of restored) {
      await tx
        .update(costLayer)
        .set({ remainingQuantity: formatQuantity(layer.remainingQuantity) })
        .where(eq(costLayer.id, layer.id));
    }
  }

  if (layer) {
    // The whole layer, consumed by the reversal and recorded as such, so that
    // remaining = original − consumed still holds (0025's deferred trigger) and
    // the layers agree with the ledger they value.
    const quantity = parseQuantity(layer.originalQuantity);
    const unitCostIqd = BigInt(layer.unitCostIqd.replace('.', ''));
    await tx.insert(costLayerConsumption).values({
      movementId: reversal!.id,
      layerId: layer.id,
      quantity: formatQuantity(quantity),
      unitCostIqd: layer.unitCostIqd,
      costIqd: toDecimalString(fifoCostOf(quantity, unitCostIqd), 4n),
    });
    await tx
      .update(costLayer)
      .set({ remainingQuantity: formatQuantity(0n) })
      .where(eq(costLayer.id, layer.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'inventory.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: reversal!.id,
    branchCode: original.branchCode,
    before: { movementId, quantity: original.quantity },
    after: { reversalId: reversal!.id },
    reason,
    outcome: 'success',
  });

  return { movementId: reversal!.id };
}

// ---------------------------------------------------------------------------
// Reservations — §9.5, consumed by Phase 06
// ---------------------------------------------------------------------------

export interface ReserveInput {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly quantity: bigint;
  readonly documentType: string;
  readonly documentId: string;
  readonly documentLineId?: string | null;
}

/**
 * Promises stock to a document.
 *
 * Checked against Available, not On Hand: promising stock that is quarantined,
 * damaged or already promised is how two customers are told the same unit is
 * theirs (§9.8, §8.4).
 */
export async function reserve(
  tx: Tx,
  ctx: ActorContext,
  input: ReserveInput,
): Promise<{ reservationId: string }> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  await tx.execute(sql`
    select id from stock_reservation
     where item_code = ${input.itemCode} and warehouse_code = ${input.warehouseCode}
     for update
  `);

  const position = await positionOf(tx, input.itemCode, input.warehouseCode, input.branchCode);
  assertCanReserve(position, input.quantity);

  const [row] = await tx
    .insert(stockReservation)
    .values({
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      branchCode: input.branchCode,
      quantity: formatQuantity(input.quantity),
      documentType: input.documentType,
      documentId: input.documentId,
      documentLineId: input.documentLineId ?? null,
      reservedBy: ctx.principal.userId,
    })
    .returning({ id: stockReservation.id });

  return { reservationId: row!.id };
}

/**
 * Ends a promise.
 *
 * The row is kept and marked released, never deleted: who promised this stock
 * and when it was let go is an audit question (§5.4).
 */
export async function releaseReservation(
  tx: Tx,
  ctx: ActorContext,
  reservationId: string,
  reason: string,
): Promise<void> {
  const [row] = await tx
    .select()
    .from(stockReservation)
    .where(eq(stockReservation.id, reservationId))
    .limit(1);

  if (!row) throw new Error(`No reservation '${reservationId}'.`);

  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  await tx
    .update(stockReservation)
    .set({ releasedAt: new Date(), releaseReason: reason })
    .where(and(eq(stockReservation.id, reservationId), isNull(stockReservation.releasedAt)));
}

/** Live reservations against a document — for the record page and for release. */
export async function reservationsFor(tx: Tx, documentType: string, documentId: string) {
  return tx
    .select()
    .from(stockReservation)
    .where(
      and(
        eq(stockReservation.documentType, documentType),
        eq(stockReservation.documentId, documentId),
        isNull(stockReservation.releasedAt),
      ),
    );
}

// ---------------------------------------------------------------------------
// Traceability — §9.9
// ---------------------------------------------------------------------------

/**
 * Every movement of one serial or batch, oldest first.
 *
 * 04.3's gate: *"A serial number can be traced end to end: receipt → transfer →
 * delivery → return → write-off."* That is this query, and it works because
 * every movement carries the identity rather than only the document that
 * caused it.
 */
export async function traceIdentity(
  tx: Tx,
  itemCode: string,
  identity: { serialNumber?: string; batchNumber?: string },
) {
  const conditions = [eq(inventoryMovement.itemCode, itemCode)];
  if (identity.serialNumber) {
    conditions.push(eq(inventoryMovement.serialNumber, identity.serialNumber));
  }
  if (identity.batchNumber) {
    conditions.push(eq(inventoryMovement.batchNumber, identity.batchNumber));
  }

  return tx
    .select({
      id: inventoryMovement.id,
      kind: inventoryMovement.kind,
      warehouseCode: inventoryMovement.warehouseCode,
      quantity: inventoryMovement.quantity,
      movementDate: inventoryMovement.movementDate,
      sourceDocumentType: inventoryMovement.sourceDocumentType,
      sourceDocumentId: inventoryMovement.sourceDocumentId,
    })
    .from(inventoryMovement)
    .where(and(...conditions))
    .orderBy(asc(inventoryMovement.movementDate), asc(inventoryMovement.createdAt));
}

/** The layers an issue consumed — 04.2's traceability gate, as a query. */
export async function consumptionsOf(tx: Tx, movementId: string) {
  return tx
    .select({
      layerId: costLayerConsumption.layerId,
      quantity: costLayerConsumption.quantity,
      unitCostIqd: costLayerConsumption.unitCostIqd,
      costIqd: costLayerConsumption.costIqd,
      layerDate: costLayer.layerDate,
      createdByMovementId: costLayer.createdByMovementId,
    })
    .from(costLayerConsumption)
    .innerJoin(costLayer, eq(costLayer.id, costLayerConsumption.layerId))
    .where(eq(costLayerConsumption.movementId, movementId))
    .orderBy(asc(costLayer.layerDate), asc(costLayer.sequence));
}

/** Convenience for callers that want the availability figure directly. */
export async function availableOf(
  tx: Tx,
  itemCode: string,
  warehouseCode: string,
  branchCode: string,
): Promise<bigint> {
  return availableQuantity(await positionOf(tx, itemCode, warehouseCode, branchCode));
}

/** The advisory figure an invoice line can show before posting checks it again. */
export async function invoiceAvailability(
  tx: Tx,
  ctx: ActorContext,
  permissionObject: 'ap_invoice' | 'ar_invoice',
  input: { itemCode: string; warehouseCode: string; supplierId?: string | null },
): Promise<{ onHand: string; available: string }> {
  await authz.authorize(ctx.principal, 'view', permissionObject, { branchCode: ctx.branchCode });
  const [house] = await tx
    .select({ code: warehouse.code, branchCode: warehouse.branchCode, active: warehouse.active })
    .from(warehouse)
    .where(eq(warehouse.code, input.warehouseCode))
    .limit(1);
  if (!house || !house.active || house.branchCode !== ctx.branchCode) {
    throw new Error('Choose an active warehouse in the current branch.');
  }
  const stockItem = await loadItem(tx, input.itemCode);
  if (!stockItem.isStock) throw new ItemNotStockedError(input.itemCode);
  const position = await positionOf(tx, input.itemCode, house.code, house.branchCode);
  const usable = availableQuantity(position);
  const pool = (await layersOf(tx, input.itemCode, house.code, input.supplierId)).reduce(
    (sum, layer) => sum + layer.remainingQuantity,
    0n,
  );
  const available = usable < pool ? usable : pool;
  return {
    onHand: formatQuantity(position.onHand),
    available: formatQuantity(available > 0n ? available : 0n),
  };
}

/** Total remaining across an item's layers — used to reconcile against the ledger. */
export async function layerQuantityOf(
  tx: Tx,
  itemCode: string,
  warehouseCode: string,
): Promise<bigint> {
  return totalRemaining(await layersOf(tx, itemCode, warehouseCode));
}

// ---------------------------------------------------------------------------
// Relocating stock between warehouses — Operations blocks 7 and 8
// ---------------------------------------------------------------------------

export interface RelocateInput {
  readonly itemCode: string;
  readonly fromWarehouseCode: string;
  readonly toWarehouseCode: string;
  readonly branchCode: string;
  /** At most this much moves. Less moves when the layers given hold less. */
  readonly quantity: bigint;
  readonly movementDate: string;
  /** The layers at the source to move from, in the order to take them. */
  readonly layers: readonly StockLayer[];
  readonly sourceDocumentType: string;
  readonly sourceDocumentId: string;
  readonly sourceLineId?: string | null;
}

/**
 * Moves stock from one warehouse to another and changes nothing else about it.
 *
 * Each layer taken at the source arrives at the destination as the same layer
 * would have been: the same unit cost, the same supplier, the same FIFO date.
 * Block 5 sells by "item, supplier and warehouse stock", so a move that dropped
 * the supplier — or that restamped the goods as bought today — would put stock
 * where a sale that names its supplier cannot find it, or make the newest
 * goods look like the oldest.
 *
 * No posting. The item carries its inventory account (block 1), so the same
 * goods standing in another warehouse are the same balance in the same
 * account; a journal here would debit and credit one account with one figure.
 *
 * Returns how much moved. Whether moving less than asked is an error is the
 * caller's question: a transfer refuses it, a shipment moves what is left.
 */
export async function relocate(
  tx: Tx,
  ctx: ActorContext,
  input: RelocateInput,
): Promise<{ moved: bigint; costIqd: bigint }> {
  if (input.fromWarehouseCode === input.toWarehouseCode) {
    throw new Error('Stock moves between two different warehouses. Choose another destination.');
  }

  let outstanding = input.quantity;
  let costIqd = 0n;

  for (const layer of input.layers) {
    if (outstanding === 0n) break;
    if (layer.remainingQuantity <= 0n) continue;

    const take = layer.remainingQuantity < outstanding ? layer.remainingQuantity : outstanding;

    // The batch the goods carry is the one the movement that created the layer
    // named — the same trace a sale reads (§9.3).
    const [origin] = await tx
      .select({ batchNumber: inventoryMovement.batchNumber })
      .from(costLayer)
      .innerJoin(inventoryMovement, eq(inventoryMovement.id, costLayer.createdByMovementId))
      .where(eq(costLayer.id, layer.id))
      .limit(1);
    const batchNumber = origin?.batchNumber ?? null;

    const issued = await issueFromLayer(tx, ctx, {
      costLayerId: layer.id,
      itemCode: input.itemCode,
      warehouseCode: input.fromWarehouseCode,
      branchCode: input.branchCode,
      quantity: take,
      movementDate: input.movementDate,
      kind: 'transfer_issue',
      batchNumber,
      sourceDocumentType: input.sourceDocumentType,
      sourceDocumentId: input.sourceDocumentId,
      sourceLineId: input.sourceLineId ?? null,
    });

    await receive(tx, ctx, {
      itemCode: input.itemCode,
      warehouseCode: input.toWarehouseCode,
      branchCode: input.branchCode,
      quantity: take,
      unitCostIqd: layer.unitCostIqd,
      supplierId: layer.supplierId,
      movementDate: input.movementDate,
      layerDate: layer.layerDate,
      kind: 'transfer_receipt',
      batchNumber,
      sourceDocumentType: input.sourceDocumentType,
      sourceDocumentId: input.sourceDocumentId,
      sourceLineId: input.sourceLineId ?? null,
    });

    costIqd += issued.costIqd ?? 0n;
    outstanding -= take;
  }

  return { moved: input.quantity - outstanding, costIqd };
}
