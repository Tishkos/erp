/**
 * Warehouse transfers and in-transit stock — Phase 04.6, §9.4.
 *
 * §9.4's workflow: *"Inventory Transfer Request → Goods Issue from Source →
 * In Transit → Goods Receipt at Destination"*, with the destination confirming
 * actual receipt, and differences remaining in **Transit under Investigation**.
 *
 * The shape follows from one decision: stock that has left the source and not
 * arrived at the destination is in neither warehouse. It is not "still at the
 * source but flagged", and it is not "already at the destination but pending" —
 * either of those makes it available somewhere it physically is not, which is
 * how a warehouse promises stock that is on a lorry.
 *
 * So a transfer is two movements per line, minutes or days apart, and the gap
 * between them is the in-transit position. The line carries what was issued and
 * what was received; the difference is the investigation, and §9.4 is explicit
 * that it stays visible rather than becoming a silent loss.
 */
import { sql } from 'drizzle-orm';
import {
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

/**
 * Appendix B, Warehouse Transfer: *"Requested, Approved, Issued, In Transit,
 * Partially Received, Received, Investigating, Closed"* — verbatim, in order.
 *
 * `investigating` is not a failure state. §9.4 requires the difference to
 * remain visible until it is resolved, so it is a place a transfer sits, with
 * its own exits: found (complete the receipt) or not found (approve the loss).
 */
export const TRANSFER_STATUSES = [
  'requested',
  'approved',
  'issued',
  'in_transit',
  'partially_received',
  'received',
  'investigating',
  'closed',
  'cancelled',
] as const;

export const transferStatus = pgEnum('warehouse_transfer_status', TRANSFER_STATUSES);

export const warehouseTransfer = pgTable(
  'warehouse_transfer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferNo: text('transfer_no').notNull(),
    status: transferStatus('status').notNull().default('requested'),

    sourceWarehouseCode: text('source_warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    destinationWarehouseCode: text('destination_warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    /** The branch the transfer belongs to, for scope and reporting (§4.1). */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    requestedOn: date('requested_on').notNull(),
    issuedOn: date('issued_on'),
    receivedOn: date('received_on'),
    reason: text('reason'),

    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    issuedBy: uuid('issued_by').references(() => appUser.id),
    receivedBy: uuid('received_by').references(() => appUser.id),
    /** §9.4 — the Warehouse Manager who approved a loss for stock not found. */
    lossApprovedBy: uuid('loss_approved_by').references(() => appUser.id),
    lossApprovedAt: timestamp('loss_approved_at', { withTimezone: true }),
    lossReason: text('loss_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('warehouse_transfer_no_uniq').on(t.transferNo),
    index('warehouse_transfer_status_idx').on(t.status, t.branchCode),
    // Stock does not move by staying still, and a transfer to the same
    // warehouse is almost always a typed mistake that would post two journals
    // cancelling each other out.
    check(
      'warehouse_transfer_distinct_warehouses',
      sql`${t.sourceWarehouseCode} <> ${t.destinationWarehouseCode}`,
    ),
  ],
);

/**
 * One item on a transfer.
 *
 * Three quantities, because §9.4 needs all three to be separable: what was
 * asked for, what actually left, and what actually arrived. Collapsing them
 * into one figure is what turns a short receipt into a silent loss.
 */
export const warehouseTransferLine = pgTable(
  'warehouse_transfer_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferId: uuid('transfer_id')
      .notNull()
      .references(() => warehouseTransfer.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),

    requestedQuantity: numeric('requested_quantity', { precision: 24, scale: 6 }).notNull(),
    issuedQuantity: numeric('issued_quantity', { precision: 24, scale: 6 }).notNull().default('0'),
    receivedQuantity: numeric('received_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),

    /** §9.3 identity, where the item is tracked. */
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),

    /** The movements this line produced, for drill-down (Appendix B). */
    issueMovementId: uuid('issue_movement_id'),
    receiptMovementId: uuid('receipt_movement_id'),
    lossMovementId: uuid('loss_movement_id'),
  },
  (t) => [
    uniqueIndex('warehouse_transfer_line_no_uniq').on(t.transferId, t.lineNo),
    check('warehouse_transfer_line_requested_positive', sql`${t.requestedQuantity} > 0`),
    check('warehouse_transfer_line_issued_not_negative', sql`${t.issuedQuantity} >= 0`),
    check('warehouse_transfer_line_received_not_negative', sql`${t.receivedQuantity} >= 0`),
    // More cannot arrive than left. A destination counting more than the source
    // sent is a counting error or a mixed-up delivery, and either way it is not
    // this transfer.
    check(
      'warehouse_transfer_line_received_within_issued',
      sql`${t.receivedQuantity} <= ${t.issuedQuantity}`,
    ),
  ],
);
