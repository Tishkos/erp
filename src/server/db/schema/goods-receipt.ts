/**
 * Goods Receipt — Phase 05.2, §8.4.
 *
 * §8.4: *"Receipt against PO with partial receipts, multiple receipts,
 * over-receipt, under-receipt and configurable quantity tolerance … manager
 * approval for tolerance override, with mandatory reason … receipt into a
 * different warehouse allowed, remaining visible as a variance from the source
 * line."*
 *
 * Three decisions shape this table, and each removes a rule that would
 * otherwise have to be remembered:
 *
 * **A receipt cannot exist without a purchase order.** `purchase_order_id` is
 * NOT NULL on the header and `purchase_order_line_id` is NOT NULL on the line.
 * §8.2's flow starts at the PO; a receipt with no order is stock arriving that
 * nobody agreed to buy, and Appendix C's three-way match has nothing to match.
 * Expressed as a foreign key, "a receipt without a PO is impossible" is a fact
 * about the schema rather than a check somebody could route around.
 *
 * **Quarantine is a place, not a flag.** §8.4's *"Received in Quarantine"* is
 * modelled by receiving into a warehouse whose type is `quarantine` — the same
 * mechanism Phase 04 already uses to keep quarantine stock out of Available
 * (§9.5, migration 0027). A `is_quarantine` boolean beside the warehouse could
 * disagree with it, and then two truths would exist about the same stock.
 *
 * **The receipt warehouse is the line's own.** It defaults from the PO line but
 * may differ (§8.4), and the difference is the variance the warehouse manager
 * needs to see. Storing both is what makes it visible; overwriting the PO line
 * would erase the question.
 *
 * Appendix C: *"Purchase Goods Receipt | Inventory | GRNI | PO and warehouse
 * receipt required; FIFO layer created."* The posting is made by the Phase 02
 * engine through `inventory.receive`, in the same transaction as the movement.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { documentStatus } from './workflow';
import { purchaseOrder, purchaseOrderLine } from './purchase-order';
import { inventoryMovement } from './inventory';

/**
 * §8.4 — the tolerance an over-receipt is judged against, as configuration.
 *
 * One row per item, plus one row with a null item as the default. "Configurable"
 * in §8.4 means someone sets it, so it is data; a constant in the code would be
 * the implementation team choosing a commercial tolerance, which §28.1 forbids.
 *
 * A tolerance of zero — the default until Purchasing says otherwise — means
 * every over-receipt needs a manager. That is the safe direction to be wrong in.
 */
export const purchaseReceiptTolerance = pgTable(
  'purchase_receipt_tolerance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null is the company-wide default. */
    itemCode: text('item_code').references(() => item.code),
    /** Percentage of the ordered quantity that may be received over it. */
    overReceiptPercent: numeric('over_receipt_percent', { precision: 9, scale: 4 })
      .notNull()
      .default('0'),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One row per item and exactly one default. A second default would make
    // "the tolerance" depend on which row was read first.
    uniqueIndex('purchase_receipt_tolerance_item_uniq')
      .on(t.itemCode)
      .where(sql`item_code is not null`),
    uniqueIndex('purchase_receipt_tolerance_default_uniq')
      .on(sql`(true)`)
      .where(sql`item_code is null`),
    check(
      'purchase_receipt_tolerance_range',
      sql`${t.overReceiptPercent} >= 0 and ${t.overReceiptPercent} <= 100`,
    ),
  ],
);

export const goodsReceipt = pgTable(
  'goods_receipt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptNo: text('receipt_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    /** §8.4 — no receipt without an order. Not nullable, ever. */
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id),

    /** The receiving branch. §14.3 — one branch per accounting entry. */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    receiptDate: date('receipt_date').notNull(),
    /** The supplier's delivery note, so the paper and the record can be tied. */
    supplierDeliveryNote: text('supplier_delivery_note'),
    note: text('note'),

    /**
     * §8.4 — the manager's override of the quantity tolerance, and the reason
     * for it. All three move together or none do; a stored override with no
     * reason records that a rule was bypassed without recording why.
     */
    toleranceOverrideBy: uuid('tolerance_override_by').references(() => appUser.id),
    toleranceOverrideAt: timestamp('tolerance_override_at', { withTimezone: true }),
    toleranceOverrideReason: text('tolerance_override_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('goods_receipt_no_uniq').on(t.receiptNo),
    index('goods_receipt_order_idx').on(t.purchaseOrderId, t.status),
    index('goods_receipt_date_idx').on(t.receiptDate, t.branchCode),

    check(
      'goods_receipt_override_complete',
      sql`(${t.toleranceOverrideBy} is null and ${t.toleranceOverrideAt} is null
           and ${t.toleranceOverrideReason} is null)
          or (${t.toleranceOverrideBy} is not null and ${t.toleranceOverrideAt} is not null
              and coalesce(btrim(${t.toleranceOverrideReason}), '') <> '')`,
    ),

    check(
      'goods_receipt_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

export const goodsReceiptLine = pgTable(
  'goods_receipt_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    goodsReceiptId: uuid('goods_receipt_id')
      .notNull()
      .references(() => goodsReceipt.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** §8.4 — every received line answers to an ordered line. */
    purchaseOrderLineId: uuid('purchase_order_line_id')
      .notNull()
      .references(() => purchaseOrderLine.id),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /**
     * Where the goods actually went. Defaults from the PO line and may differ
     * (§8.4); `purchase_order_line.warehouse_code` stays as ordered so the
     * variance can be seen rather than inferred.
     */
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),

    /**
     * True when this line was received somewhere other than the ordered
     * warehouse. Derivable, and stored anyway: the variance report is read far
     * more often than it is written, and a receipt is a historical fact — if
     * the PO line's warehouse were ever corrected, a derived answer would
     * change retrospectively and a stored one would not.
     */
    warehouseVariance: boolean('warehouse_variance').notNull().default(false),

    /** §9.3 — identity, for a tracked item. */
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    expiryDate: date('expiry_date'),
    manufacturedOn: date('manufactured_on'),

    /** The stock movement this line created. Written when the receipt posts. */
    movementId: uuid('movement_id').references(() => inventoryMovement.id),
  },
  (t) => [
    uniqueIndex('goods_receipt_line_no_uniq').on(t.goodsReceiptId, t.lineNo),
    index('goods_receipt_line_po_line_idx').on(t.purchaseOrderLineId),
    index('goods_receipt_line_item_idx').on(t.itemCode, t.warehouseCode),
    check('goods_receipt_line_quantity_positive', sql`${t.quantity} > 0`),
  ],
);
