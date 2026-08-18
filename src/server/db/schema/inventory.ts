/**
 * Inventory ledger and FIFO cost layers — Phase 04.1 and 04.2.
 *
 * §9.9 requires inventory to reconcile: to the G/L, to the layers, and to
 * itself. That is a property of how the tables are shaped, not of a nightly
 * job, so three decisions are made here and everything else follows:
 *
 *   1. **Movements are the truth, and they are append-only.** A position is
 *      derived by summing them (`stock_position` below is a view, not a table).
 *      A stored quantity is a number that drifts from its movements, and the
 *      drift is silent until a count finds it.
 *
 *   2. **Cost layers are separate from quantities.** §9.2 makes FIFO the single
 *      valuation method; a layer records what one receipt cost, and issues
 *      record which layers they consumed. Merging cost into the movement row
 *      would make "which receipt did this unit come from?" unanswerable, and
 *      that question is 04.2's traceability gate.
 *
 *   3. **Consumption is a row, not a subtraction.** `cost_layer_consumption`
 *      is what lets an issue name the layers it took from, and what makes a
 *      reversal restorable exactly (§9.2) rather than approximately.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { warehouse } from './organisation';
import { item } from './item';
import { journalEntry } from './journal';

/**
 * Why stock moved. Every movement names one.
 *
 * Closed list: a movement whose reason is not on it is a movement nobody
 * designed the accounting for (Appendix C maps each of these to a posting).
 */
export const MOVEMENT_KINDS = [
  'opening_stock',
  'goods_receipt',
  'goods_return',
  'transfer_issue',
  'transfer_receipt',
  'delivery',
  'sales_return',
  'quarantine_in',
  'quarantine_release',
  'quarantine_reject',
  'damage',
  'write_off',
  'count_adjustment',
  'reversal',
] as const;

export const movementKind = pgEnum('inventory_movement_kind', MOVEMENT_KINDS);

/**
 * The inventory ledger — Appendix B, Inventory Movement: *"Item, warehouse/bin
 * from/to, quantity, cost layer, source line and posting journal."*
 *
 * Quantity is signed: positive into this warehouse, negative out of it. A
 * transfer is two rows, not one with two warehouses, because the stock is
 * genuinely in neither place in between — and §9.4's in-transit state is that
 * gap made visible rather than hidden inside a single row.
 */
export const inventoryMovement = pgTable(
  'inventory_movement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    kind: movementKind('kind').notNull(),

    /** Scaled at QUANTITY_SCALE (1e6). Signed. Never zero — see the check. */
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),

    /** The business date the movement is effective on (§9.7 for opening stock). */
    movementDate: date('movement_date').notNull(),

    /** Appendix B — "source line": the document and line that caused this. */
    sourceDocumentType: text('source_document_type'),
    sourceDocumentId: text('source_document_id'),
    sourceLineId: text('source_line_id'),

    /** Appendix B — "posting journal". Null only for movements that do not post. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    /** §9.3 — tracking identity, where the item requires it. */
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    expiryDate: date('expiry_date'),
    manufacturedOn: date('manufactured_on'),

    /** The movement this one reverses, if any (§9.2). */
    reversesMovementId: uuid('reverses_movement_id'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('inventory_movement_position_idx').on(t.itemCode, t.warehouseCode, t.movementDate),
    index('inventory_movement_source_idx').on(t.sourceDocumentType, t.sourceDocumentId),
    index('inventory_movement_journal_idx').on(t.journalEntryId),
    index('inventory_movement_serial_idx').on(t.itemCode, t.serialNumber),
    index('inventory_movement_batch_idx').on(t.itemCode, t.batchNumber),
    // A movement of nothing is not a movement; it is a row that makes a report
    // longer without changing a figure.
    check('inventory_movement_quantity_not_zero', sql`${t.quantity} <> 0`),
  ],
);

/**
 * A FIFO cost layer — §9.2.
 *
 * `remaining_quantity` is the one mutable number in the inventory model, and it
 * moves only through `cost_layer_consumption` rows written in the same
 * transaction. The check below makes the invariant a property of the row rather
 * than a rule someone has to remember.
 */
export const costLayer = pgTable(
  'cost_layer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * The date the layer is costed at — §9.7 allows opening stock to state a
     * date earlier than the day it was entered, and that stock is genuinely
     * older, so it must be consumed first.
     */
    layerDate: date('layer_date').notNull(),
    /** Orders layers created on the same date: the receipt order that day. */
    sequence: integer('sequence').notNull(),

    originalQuantity: numeric('original_quantity', { precision: 24, scale: 6 }).notNull(),
    remainingQuantity: numeric('remaining_quantity', { precision: 24, scale: 6 }).notNull(),
    /** IQD cost of one base unit. Money precision, not quantity precision. */
    unitCostIqd: numeric('unit_cost_iqd', { precision: 19, scale: 4 }).notNull(),

    /** The movement that created it — every layer comes from a receipt. */
    createdByMovementId: uuid('created_by_movement_id')
      .notNull()
      .references(() => inventoryMovement.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The consumption order, as an index: "oldest with stock left" is the
    // hottest query in the module.
    index('cost_layer_fifo_idx').on(
      t.itemCode,
      t.warehouseCode,
      t.layerDate,
      t.sequence,
    ),
    uniqueIndex('cost_layer_sequence_uniq').on(
      t.itemCode,
      t.warehouseCode,
      t.layerDate,
      t.sequence,
    ),
    check('cost_layer_original_positive', sql`${t.originalQuantity} > 0`),
    check('cost_layer_cost_not_negative', sql`${t.unitCostIqd} >= 0`),
    // §9.2 — a layer can be emptied but never over-consumed, and never restored
    // beyond what it started with.
    check(
      'cost_layer_remaining_within_original',
      sql`${t.remainingQuantity} >= 0 and ${t.remainingQuantity} <= ${t.originalQuantity}`,
    ),
  ],
);

/**
 * What an issue took from which layer — 04.2's traceability gate.
 *
 * Append-only. This is the record that makes a reversal exact: §9.2 requires a
 * reversal to restore "the original quantity and cost relationship", and the
 * only way to restore a relationship is to have written it down.
 */
export const costLayerConsumption = pgTable(
  'cost_layer_consumption',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    movementId: uuid('movement_id')
      .notNull()
      .references(() => inventoryMovement.id),
    layerId: uuid('layer_id')
      .notNull()
      .references(() => costLayer.id),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    /** Copied from the layer, so the cost stays readable if the layer is later emptied. */
    unitCostIqd: numeric('unit_cost_iqd', { precision: 19, scale: 4 }).notNull(),
    costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cost_layer_consumption_movement_idx').on(t.movementId),
    index('cost_layer_consumption_layer_idx').on(t.layerId),
    // Signed. A positive row is an issue taking stock out of the layer; a
    // negative one is a reversal putting it back (§9.2). Recording a
    // restoration as a row rather than as a silent adjustment is what keeps
    // `remaining = original − sum(quantity)` true for the life of the layer —
    // and what lets someone ask "why does this layer still have stock?" and get
    // an answer. Zero is refused: a row that changes nothing is not a record.
    check('cost_layer_consumption_quantity_not_zero', sql`${t.quantity} <> 0`),
  ],
);

/**
 * A promise of stock to a document — §9.5's Reserved bucket.
 *
 * Built here, consumed by Phase 06's sales orders. A reservation is released
 * when its document is delivered or cancelled; it is not a movement, because
 * nothing has physically moved.
 */
export const stockReservation = pgTable(
  'stock_reservation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),

    /** What the stock is promised to. */
    documentType: text('document_type').notNull(),
    documentId: text('document_id').notNull(),
    documentLineId: text('document_line_id'),

    reservedBy: uuid('reserved_by')
      .notNull()
      .references(() => appUser.id),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when the promise ends — delivered, cancelled or expired. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (t) => [
    // The Reserved figure reads only live rows, so this index is the one that
    // matters for availability.
    index('stock_reservation_live_idx')
      .on(t.itemCode, t.warehouseCode)
      .where(sql`${t.releasedAt} is null`),
    index('stock_reservation_document_idx').on(t.documentType, t.documentId),
    check('stock_reservation_quantity_positive', sql`${t.quantity} > 0`),
  ],
);
