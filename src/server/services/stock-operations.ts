/**
 * Transfer, Item Reconciliation and Stock Movement — Operations build, block 7.
 *
 *   Transfer             Items can be transferred between warehouses.
 *   Item Reconciliation  Item Name; Warehouse; In/Out; Adjustment Quantity —
 *                        entered as In or Out to match the actual quantity.
 *   Stock Movement       Purchases are stock In; sales are stock Out;
 *                        transfers are Out of one warehouse and In to
 *                        another; reconciliation is In or Out.
 *
 * Every write goes through the inventory service, so the rules every other
 * movement lives under hold here too: no warehouse goes negative (block 11,
 * checked here, in `inventory` and by the deferred trigger in the database),
 * and nothing is valued twice — a transfer carries each layer's own cost,
 * supplier and FIFO date to where it goes.
 *
 * A transfer posts nothing. The item names its inventory account (block 1), so
 * the same goods in another warehouse are the same balance in the same account.
 * A reconciliation does post: stock found or lost changes what the company
 * owns, against the account set for it on Posting Mappings.
 */
import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  costLayer,
  item as itemTable,
  stockAdjustment,
  stockTransfer,
  warehouse,
} from '../db/schema';
import { availableQuantity } from '../domain/inventory';
import { costOf } from '../domain/fifo';
import { formatQuantity } from '../domain/uom';
import { toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as posting from './posting';
import { allocateDocumentNumber, allocateFreeDocumentNumber } from './numbering';

export const TRANSFER_OBJECT = 'warehouse_transfer';
export const RECONCILIATION_OBJECT = 'stock_reconciliation';
export const MOVEMENT_OBJECT = 'stock_movement';

const TRANSFER_SEQUENCE = 'WAREHOUSE_TRANSFER';
const ADJUSTMENT_SEQUENCE = 'STOCK_ADJUSTMENT';

export type AdjustmentDirection = 'in' | 'out';

export class StockOperationError extends Error {
  readonly code = 'STOCK_OPERATION';
  constructor(detail: string) {
    super(detail);
    this.name = 'StockOperationError';
  }
}

async function stockItem(tx: Tx, itemCode: string) {
  const [row] = await tx
    .select({
      code: itemTable.code,
      isStock: itemTable.isStock,
      active: itemTable.active,
      inventoryAccountId: itemTable.inventoryAccountId,
    })
    .from(itemTable)
    .where(eq(itemTable.code, itemCode))
    .limit(1);
  if (!row) throw new StockOperationError(`No item '${itemCode}'. Choose an item from the list.`);
  if (!row.isStock) throw new inventory.ItemNotStockedError(itemCode);
  return row;
}

/** A warehouse the current branch can move stock in and out of. */
async function usableWarehouse(tx: Tx, ctx: ActorContext, code: string, label: string) {
  const [row] = await tx
    .select({ code: warehouse.code, branchCode: warehouse.branchCode, active: warehouse.active })
    .from(warehouse)
    .where(eq(warehouse.code, code))
    .limit(1);
  if (!row) throw new StockOperationError(`Choose the ${label} warehouse.`);
  if (!row.active) throw new StockOperationError(`${code} is inactive, so no stock can move through it.`);
  if (row.branchCode !== ctx.branchCode) {
    throw new StockOperationError(`${code} belongs to another branch. Choose a warehouse of this branch.`);
  }
  return row;
}

function assertPositive(quantity: bigint): void {
  if (quantity <= 0n) {
    throw new StockOperationError('Enter a quantity above zero.');
  }
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new StockOperationError('Enter the date.');
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface TransferInput {
  readonly itemCode: string;
  readonly fromWarehouseCode: string;
  readonly toWarehouseCode: string;
  readonly quantity: bigint;
  readonly transferDate: string;
}

/**
 * Moves stock from one warehouse to another — Out of the first, In to the
 * second, in one transaction. What leaves is what arrives: the same quantity,
 * and the same layers at the same cost. The oldest stock goes first.
 */
export async function transfer(
  tx: Tx,
  ctx: ActorContext,
  input: TransferInput,
): Promise<{ id: string; transferNo: string }> {
  await authz.authorize(ctx.principal, 'create', TRANSFER_OBJECT, { branchCode: ctx.branchCode });

  assertPositive(input.quantity);
  assertDate(input.transferDate);
  if (input.fromWarehouseCode === input.toWarehouseCode) {
    throw new StockOperationError('Stock moves between two different warehouses. Choose another destination.');
  }
  await stockItem(tx, input.itemCode);
  await usableWarehouse(tx, ctx, input.fromWarehouseCode, 'source');
  await usableWarehouse(tx, ctx, input.toWarehouseCode, 'destination');

  // Block 11, said before anything is written so the message names the
  // warehouse and the figure. `inventory` and the database refuse it again.
  const position = await inventory.positionOf(
    tx,
    input.itemCode,
    input.fromWarehouseCode,
    ctx.branchCode,
  );
  const available = availableQuantity(position);
  if (available < input.quantity) {
    throw new StockOperationError(
      `${input.fromWarehouseCode} holds ${formatQuantity(available > 0n ? available : 0n)} of ${input.itemCode}, ` +
        `so ${formatQuantity(input.quantity)} cannot be transferred. Negative stock is not allowed.`,
    );
  }

  const documentNo = await allocateFreeDocumentNumber(
    tx,
    TRANSFER_SEQUENCE,
    { branchCode: ctx.branchCode, year: Number(input.transferDate.slice(0, 4)) },
    async (candidate) => {
      const [existing] = await tx
        .select({ id: stockTransfer.id })
        .from(stockTransfer)
        .where(eq(stockTransfer.transferNo, candidate))
        .limit(1);
      return existing !== undefined;
    },
    ctx.principal.userId,
  );
  const id = randomUUID();

  const moved = await inventory.relocate(tx, ctx, {
    itemCode: input.itemCode,
    fromWarehouseCode: input.fromWarehouseCode,
    toWarehouseCode: input.toWarehouseCode,
    branchCode: ctx.branchCode,
    quantity: input.quantity,
    movementDate: input.transferDate,
    layers: await inventory.layersOf(tx, input.itemCode, input.fromWarehouseCode),
    sourceDocumentType: 'stock_transfer',
    sourceDocumentId: id,
  });

  if (moved.moved !== input.quantity) {
    throw new StockOperationError(
      `Only ${formatQuantity(moved.moved)} of ${input.itemCode} in ${input.fromWarehouseCode} has a cost to carry. ` +
        'Nothing was transferred.',
    );
  }

  await tx.insert(stockTransfer).values({
    id,
    transferNo: documentNo,
    itemCode: input.itemCode,
    fromWarehouseCode: input.fromWarehouseCode,
    toWarehouseCode: input.toWarehouseCode,
    quantity: formatQuantity(input.quantity),
    costIqd: toDecimalString(moved.costIqd, 4n),
    transferDate: input.transferDate,
    branchCode: ctx.branchCode,
    createdBy: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'stock_transfer.created',
    objectType: TRANSFER_OBJECT,
    objectId: id,
    branchCode: ctx.branchCode,
    after: {
      transferNo: documentNo,
      itemCode: input.itemCode,
      from: input.fromWarehouseCode,
      to: input.toWarehouseCode,
      quantity: formatQuantity(input.quantity),
      costIqd: toDecimalString(moved.costIqd, 4n),
    },
    outcome: 'success',
  });

  return { id, transferNo: documentNo };
}

function transferRows(tx: Tx) {
  return tx
    .select({
      id: stockTransfer.id,
      transferNo: stockTransfer.transferNo,
      transferDate: stockTransfer.transferDate,
      itemCode: stockTransfer.itemCode,
      itemName: itemTable.name,
      fromWarehouseCode: stockTransfer.fromWarehouseCode,
      toWarehouseCode: stockTransfer.toWarehouseCode,
      quantity: stockTransfer.quantity,
      costIqd: stockTransfer.costIqd,
      branchCode: stockTransfer.branchCode,
    })
    .from(stockTransfer)
    .innerJoin(itemTable, eq(itemTable.code, stockTransfer.itemCode));
}

export async function listTransfers(tx: Tx) {
  return transferRows(tx).orderBy(desc(stockTransfer.transferDate), desc(stockTransfer.transferNo));
}

/** One transfer by its number — the row the list shows, for its printed copy. */
export async function transferByNo(tx: Tx, transferNo: string) {
  const [row] = await transferRows(tx).where(eq(stockTransfer.transferNo, transferNo)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Item Reconciliation
// ---------------------------------------------------------------------------

export interface AdjustmentInput {
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly direction: AdjustmentDirection;
  readonly quantity: bigint;
  readonly adjustmentDate: string;
}

/**
 * What one unit found on the shelf is worth.
 *
 * The build's reconciliation carries no price, so the stock found is valued at
 * what the same item already costs: the average of what is left of it in that
 * warehouse, else anywhere, else the last price it was bought at. An item that
 * has never had a cost is refused rather than brought in at nothing — its
 * first stock belongs on Opening Stock or a Purchase Invoice, which say what
 * it cost.
 */
async function unitCostForFound(tx: Tx, itemCode: string, warehouseCode: string): Promise<bigint> {
  const averageOf = async (where: ReturnType<typeof and>) => {
    const [row] = await tx
      .select({
        quantity: sql<string>`coalesce(sum(${costLayer.remainingQuantity}), 0)`,
        value: sql<string>`coalesce(sum(${costLayer.remainingQuantity} * ${costLayer.unitCostIqd}), 0)`,
      })
      .from(costLayer)
      .where(where);
    const quantity = Number(row?.quantity ?? 0);
    if (!quantity) return null;
    return BigInt(Math.round((Number(row!.value) / quantity) * 10_000));
  };

  const here = await averageOf(
    and(
      eq(costLayer.itemCode, itemCode),
      eq(costLayer.warehouseCode, warehouseCode),
      sql`${costLayer.remainingQuantity} > 0`,
    ),
  );
  if (here !== null) return here;

  const anywhere = await averageOf(
    and(eq(costLayer.itemCode, itemCode), sql`${costLayer.remainingQuantity} > 0`),
  );
  if (anywhere !== null) return anywhere;

  const [last] = await tx
    .select({ unitCostIqd: costLayer.unitCostIqd })
    .from(costLayer)
    .where(eq(costLayer.itemCode, itemCode))
    .orderBy(desc(costLayer.layerDate), desc(costLayer.sequence))
    .limit(1);
  if (last) return BigInt(last.unitCostIqd.replace('.', ''));

  throw new StockOperationError(
    `${itemCode} has never had a cost, so stock found of it cannot be valued. ` +
      'Enter its first stock on Opening Stock or a Purchase Invoice.',
  );
}

/**
 * Brings the system's quantity to the shelf's — In adds what was found, Out
 * takes away what is missing — and posts the difference in value.
 *
 *   In   Dr the item's inventory account / Cr Inventory Adjustment
 *   Out  Dr Inventory Adjustment / Cr the item's inventory account
 *
 * An Out takes the oldest stock first, at what it cost, and is refused if it
 * would take the warehouse below zero (block 11).
 */
export async function adjust(
  tx: Tx,
  ctx: ActorContext,
  input: AdjustmentInput,
): Promise<{ id: string; adjustmentNo: string }> {
  await authz.authorize(ctx.principal, 'create', RECONCILIATION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  if (input.direction !== 'in' && input.direction !== 'out') {
    throw new StockOperationError('Choose In or Out.');
  }
  assertPositive(input.quantity);
  assertDate(input.adjustmentDate);
  const stocked = await stockItem(tx, input.itemCode);
  await usableWarehouse(tx, ctx, input.warehouseCode, 'the');
  if (!stocked.inventoryAccountId) {
    throw new StockOperationError(
      `${input.itemCode} names no inventory account, so the adjustment has nowhere to post. Set one on the item.`,
    );
  }

  const { documentNo } = await allocateDocumentNumber(
    tx,
    ADJUSTMENT_SEQUENCE,
    { branchCode: ctx.branchCode, year: Number(input.adjustmentDate.slice(0, 4)) },
    ctx.principal.userId,
  );
  const id = randomUUID();
  const movement = {
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
    branchCode: ctx.branchCode,
    quantity: input.quantity,
    movementDate: input.adjustmentDate,
    kind: 'count_adjustment' as const,
    // The adjustment is its own batch: it is the document that put these
    // units on the system, which is what a batch traces (§9.3).
    batchNumber: documentNo,
    sourceDocumentType: 'stock_adjustment',
    sourceDocumentId: id,
  };

  let costIqd: bigint;
  if (input.direction === 'out') {
    const position = await inventory.positionOf(
      tx,
      input.itemCode,
      input.warehouseCode,
      ctx.branchCode,
    );
    const available = availableQuantity(position);
    if (available < input.quantity) {
      throw new StockOperationError(
        `${input.warehouseCode} holds ${formatQuantity(available > 0n ? available : 0n)} of ${input.itemCode}, ` +
          `so ${formatQuantity(input.quantity)} cannot be taken out. Negative stock is not allowed.`,
      );
    }
    // The oldest layers, whichever batch they carry: take them one by one so
    // each movement names the batch it actually took (§9.3).
    let outstanding = input.quantity;
    costIqd = 0n;
    for (const layer of await inventory.layersOf(tx, input.itemCode, input.warehouseCode)) {
      if (outstanding === 0n) break;
      if (layer.remainingQuantity <= 0n) continue;
      const take = layer.remainingQuantity < outstanding ? layer.remainingQuantity : outstanding;
      const [origin] = await tx.execute(sql`
        select m.batch_number
          from cost_layer l join inventory_movement m on m.id = l.created_by_movement_id
         where l.id = ${layer.id}
      `).then((result) => (result as unknown as { rows: { batch_number: string | null }[] }).rows);
      const issued = await inventory.issueFromLayer(tx, ctx, {
        ...movement,
        quantity: take,
        costLayerId: layer.id,
        batchNumber: origin?.batch_number ?? null,
      });
      costIqd += issued.costIqd ?? 0n;
      outstanding -= take;
    }
  } else {
    const unitCostIqd = await unitCostForFound(tx, input.itemCode, input.warehouseCode);
    await inventory.receive(tx, ctx, { ...movement, unitCostIqd, supplierId: null });
    // The same arithmetic the layer is valued with, so the ledger and the
    // warehouse agree to the last fils.
    costIqd = costOf(input.quantity, unitCostIqd);
  }

  let journalEntryId: string | null = null;
  if (costIqd > 0n) {
    const amount = toDecimalString(costIqd, 4n);
    const criteria = { branchCode: ctx.branchCode, warehouseCode: input.warehouseCode };
    const dimensions = { branch: ctx.branchCode, warehouse: input.warehouseCode };
    const stockLine = {
      role: 'inventory',
      accountId: stocked.inventoryAccountId,
      criteria,
      dimensions,
    };
    const offsetLine = { role: 'inventory_adjustment', criteria, dimensions };
    const result = await posting.post(tx, ctx, {
      eventType: 'inventory.stock_adjustment',
      documentTypeCode: 'stock_adjustment',
      source: { module: 'inventory', documentId: id, event: 'adjusted' },
      branchCode: ctx.branchCode,
      documentDate: input.adjustmentDate,
      postingDate: input.adjustmentDate,
      description: `Item reconciliation ${documentNo} — ${input.itemCode} ${input.direction} in ${input.warehouseCode}`,
      lines:
        input.direction === 'in'
          ? [
              { ...stockLine, debit: amount },
              { ...offsetLine, credit: amount },
            ]
          : [
              { ...offsetLine, debit: amount },
              { ...stockLine, credit: amount },
            ],
    });
    journalEntryId = result.journalEntryId;
  }

  await tx.insert(stockAdjustment).values({
    id,
    adjustmentNo: documentNo,
    itemCode: input.itemCode,
    warehouseCode: input.warehouseCode,
    direction: input.direction,
    quantity: formatQuantity(input.quantity),
    costIqd: toDecimalString(costIqd, 4n),
    adjustmentDate: input.adjustmentDate,
    journalEntryId,
    branchCode: ctx.branchCode,
    createdBy: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'stock_adjustment.created',
    objectType: RECONCILIATION_OBJECT,
    objectId: id,
    branchCode: ctx.branchCode,
    after: {
      adjustmentNo: documentNo,
      itemCode: input.itemCode,
      warehouseCode: input.warehouseCode,
      direction: input.direction,
      quantity: formatQuantity(input.quantity),
      costIqd: toDecimalString(costIqd, 4n),
      journalEntryId,
    },
    outcome: 'success',
  });

  return { id, adjustmentNo: documentNo };
}

function adjustmentRows(tx: Tx) {
  return tx
    .select({
      id: stockAdjustment.id,
      adjustmentNo: stockAdjustment.adjustmentNo,
      adjustmentDate: stockAdjustment.adjustmentDate,
      itemCode: stockAdjustment.itemCode,
      itemName: itemTable.name,
      warehouseCode: stockAdjustment.warehouseCode,
      warehouseName: warehouse.name,
      direction: stockAdjustment.direction,
      quantity: stockAdjustment.quantity,
      costIqd: stockAdjustment.costIqd,
      branchCode: stockAdjustment.branchCode,
    })
    .from(stockAdjustment)
    .innerJoin(itemTable, eq(itemTable.code, stockAdjustment.itemCode))
    .innerJoin(warehouse, eq(warehouse.code, stockAdjustment.warehouseCode));
}

export async function listAdjustments(tx: Tx) {
  return adjustmentRows(tx).orderBy(desc(stockAdjustment.adjustmentDate), desc(stockAdjustment.adjustmentNo));
}

/** One Item Reconciliation by its number, for its printed copy. */
export async function adjustmentByNo(tx: Tx, adjustmentNo: string) {
  const [row] = await adjustmentRows(tx).where(eq(stockAdjustment.adjustmentNo, adjustmentNo)).limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Stock Movement
// ---------------------------------------------------------------------------

/** What a movement was, in the build's words. */
export type MovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'transfer'
  | 'shipment'
  | 'reconciliation'
  | 'sales_return'
  | 'purchase_return'
  | 'other';

function movementType(kind: string, sourceType: string | null): MovementType {
  if (kind === 'opening_stock') return 'opening';
  if (kind === 'goods_receipt') return 'purchase';
  if (kind === 'delivery') return 'sale';
  if (kind === 'sales_return') return 'sales_return';
  if (kind === 'goods_return') return 'purchase_return';
  if (kind === 'count_adjustment') return 'reconciliation';
  if (kind === 'transfer_issue' || kind === 'transfer_receipt') {
    return sourceType === 'supplier_shipment' ? 'shipment' : 'transfer';
  }
  return 'other';
}

export interface MovementFilter {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly itemCode?: string | null;
  /**
   * What a person typed into the item box, matched against the item's name and
   * its code, anywhere in either.
   *
   * A drop-down cannot serve a catalogue of thousands — a person cannot pick an
   * item out of a list that long, they have to search for it. Written to meet
   * the trigram indexes from migration 0212: `lower(...)` on both sides, or the
   * planner reads every item instead.
   */
  readonly itemSearch?: string | null;
  readonly warehouseCode?: string | null;
}

/**
 * Every movement of stock, In or Out, with the document that made it.
 *
 * Read straight from the movements, so it cannot disagree with the Warehouses
 * Report: that report is these rows summed.
 */
export async function movements(tx: Tx, ctx: ActorContext, filter: MovementFilter = {}) {
  await authz.authorize(ctx.principal, 'view', MOVEMENT_OBJECT, { branchCode: ctx.branchCode });

  const result = await tx.execute(sql`
    select m.id,
           m.movement_date::text as movement_date,
           -- When it was entered, not only the day it is dated: two movements on
           -- one date are read in the order they happened.
           m.created_at::text    as created_at,
           m.item_code, i.name as item_name,
           m.warehouse_code, w.name as warehouse_name,
           -- Where the stock came from and where it went.
           --
           -- Anything that carries stock between warehouses -- a Transfer, and
           -- every stage of Invoice Status Tracking -- goes through
           -- inventory.relocate, which writes a transfer_issue where the goods
           -- left and a transfer_receipt where they arrived. Each row therefore
           -- has a counterpart, and the pair is found rather than read off one
           -- document type: an earlier version joined stock_transfer, so a
           -- shipment moving from In Process to On Board showed no origin.
           --
           -- The pair is the same source document and line at the same instant.
           -- created_at defaults to now(), which Postgres holds still for the
           -- length of a transaction, so both sides of one move share it exactly
           -- while a later stage of the same invoice does not. Several cost
           -- layers may be carried in one move; they all share the one origin
           -- and destination, so any counterpart answers.
           case when m.kind = 'transfer_issue'   then m.warehouse_code
                when m.kind = 'transfer_receipt' then pair.warehouse_code end as from_warehouse_code,
           case when m.kind = 'transfer_issue'   then w.name
                when m.kind = 'transfer_receipt' then pair.warehouse_name end as from_warehouse_name,
           case when m.kind = 'transfer_issue'   then pair.warehouse_code
                when m.kind = 'transfer_receipt' then m.warehouse_code end as to_warehouse_code,
           case when m.kind = 'transfer_issue'   then pair.warehouse_name
                when m.kind = 'transfer_receipt' then w.name end as to_warehouse_name,
           -- Who entered it.
           coalesce(u.display_name, u.email) as raised_by,
           m.kind, m.source_document_type, m.quantity::text as quantity,
           coalesce(
             (select invoice_no from ap_invoice where id::text = m.source_document_id
                and m.source_document_type in ('ap_invoice', 'supplier_shipment')),
             (select invoice_no from ar_invoice where id::text = m.source_document_id
                and m.source_document_type = 'ar_invoice'),
             (select return_no from sales_return where id::text = m.source_document_id
                and m.source_document_type = 'sales_return'),
             (select return_no from goods_return where id::text = m.source_document_id
                and m.source_document_type = 'goods_return'),
             (select transfer_no from stock_transfer where id::text = m.source_document_id
                and m.source_document_type = 'stock_transfer'),
             (select adjustment_no from stock_adjustment where id::text = m.source_document_id
                and m.source_document_type = 'stock_adjustment'),
             (select document_no from opening_stock where id::text = m.source_document_id
                and m.source_document_type = 'opening_stock')
           ) as document_no
      from inventory_movement m
      join item i on i.code = m.item_code
      join warehouse w on w.code = m.warehouse_code
      left join app_user u on u.id = m.created_by
      left join lateral (
        select o.warehouse_code, pw.name as warehouse_name
          from inventory_movement o
          join warehouse pw on pw.code = o.warehouse_code
         where m.kind in ('transfer_issue', 'transfer_receipt')
           -- Compared as text: kind is an enum, and an enum does not compare
           -- to the text a CASE returns without being told to.
           and o.kind::text = case when m.kind::text = 'transfer_issue' then 'transfer_receipt'
                                   else 'transfer_issue' end
           and o.item_code = m.item_code
           and o.created_at = m.created_at
           and o.source_document_type is not distinct from m.source_document_type
           and o.source_document_id   is not distinct from m.source_document_id
           and o.source_line_id       is not distinct from m.source_line_id
         limit 1
      ) pair on true
     where m.branch_code = ${ctx.branchCode}
       ${filter.from ? sql`and m.movement_date >= ${filter.from}::date` : sql``}
       ${filter.to ? sql`and m.movement_date <= ${filter.to}::date` : sql``}
       ${filter.itemCode ? sql`and m.item_code = ${filter.itemCode}` : sql``}
       ${
         filter.itemSearch?.trim()
           ? sql`and (lower(i.name) like ${
               '%' + filter.itemSearch.trim().toLowerCase().replace(/([%_\\])/g, '\\$1') + '%'
             } escape '\\' or lower(m.item_code) like ${
               '%' + filter.itemSearch.trim().toLowerCase().replace(/([%_\\])/g, '\\$1') + '%'
             } escape '\\')`
           : sql``
       }
       ${filter.warehouseCode ? sql`and m.warehouse_code = ${filter.warehouseCode}` : sql``}
     order by m.movement_date desc, m.created_at desc, m.id desc
     limit 1000
  `);

  return (result as unknown as { rows: Record<string, string | null>[] }).rows.map((row) => {
    const quantity = row.quantity!;
    const negative = quantity.startsWith('-');
    return {
      id: row.id!,
      movementDate: row.movement_date!,
      itemCode: row.item_code!,
      itemName: row.item_name!,
      warehouseCode: row.warehouse_code!,
      warehouseName: row.warehouse_name!,
      createdAt: row.created_at,
      raisedBy: row.raised_by,
      /* A transfer knows both ends. Read from the row's own side so the two
         movements of one transfer each say where the stock came from and where
         it went, rather than only naming the warehouse they touched. */
      fromWarehouseCode: row.from_warehouse_code,
      fromWarehouseName: row.from_warehouse_name,
      toWarehouseCode: row.to_warehouse_code,
      toWarehouseName: row.to_warehouse_name,
      type: movementType(row.kind!, row.source_document_type ?? null),
      direction: negative ? ('out' as const) : ('in' as const),
      quantity: negative ? quantity.slice(1) : quantity,
      documentNo: row.document_no,
    };
  });
}
