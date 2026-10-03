/**
 * Purchase Orders — Phase 05.1, §8.3.
 *
 * §8.2 is unusually explicit about where purchasing starts: *"purchasing begins
 * directly with a Purchase Order"*. Quotation and price collection happen
 * outside the system, and Purchase Requisition, RFQ, Supplier Quotation and
 * Quotation Comparison are **excluded, not deferred**. There is deliberately no
 * table here for any of them.
 *
 * Two decisions shape this:
 *
 * **One supplier per order**, expressed as a column on the header rather than a
 * rule in a service. §8.3's first bullet. A supplier on the line would make a
 * two-supplier order representable, and then the question "who do we owe?" has
 * an answer per line and none for the document.
 *
 * **Branch, warehouse and cost centre live on the line.** §8.3 again: *"one PO
 * can cover several branches and warehouses"*. That is the opposite of the
 * journal rule (§14.3, one branch per entry), and for a good reason: a purchase
 * is one commercial agreement with one supplier that may deliver to three
 * cities, while a journal is one accounting event. Putting the branch on the PO
 * header would force three orders and three negotiations.
 *
 * Appendix B: the effect of an approved PO is **commitment only** — no
 * accounting entry. There is no journal link on this table, which is how that
 * is enforced rather than remembered.
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
import { businessPartner, costCentre } from './organisation';
import { item, unitOfMeasure } from './item';
import { documentStatus } from './workflow';

/**
 * Appendix B, Purchase Order: *"Draft, Pending Approval, Approved, Partially
 * Received, Received, Closed, Cancelled"* — mapped onto §3.2's vocabulary,
 * which is the one status machine §24 requires every document to use.
 *
 *   draft              Draft
 *   submitted          Pending Approval
 *   approved           Approved
 *   partially_executed Partially Received
 *   executed           Received
 *   closed             Closed
 *   cancelled          Cancelled
 */

/** §8.3 — the four line types a purchase order may carry. */
export const PURCHASE_LINE_TYPES = ['inventory_item', 'service', 'fixed_asset', 'expense'] as const;
export const purchaseLineType = pgEnum('purchase_line_type', PURCHASE_LINE_TYPES);

export const purchaseOrder = pgTable(
  'purchase_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderNo: text('order_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    /** §8.3 — one supplier per order. On the header, so two is unrepresentable. */
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    /**
     * The branch that owns the order — for scope and for the approval route.
     * Line-level branches say where the goods go; this says whose order it is.
     */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    orderDate: date('order_date').notNull(),
    expectedDate: date('expected_date'),
    currency: text('currency').notNull().default('IQD'),
    /** §4.3 — the terms the resulting invoices fall due on. */
    paymentTermsCode: text('payment_terms_code'),
    reference: text('reference'),
    note: text('note'),
    /** REQ-PM-001 §8 — the project, the element and the cost code the purchase is assigned to; the three together, or none. */
    projectCode: text('project_code'),
    wbsCode: text('wbs_code'),
    costCode: text('cost_code'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    /** §3.2 and §8.7 — cancellation states its reason. */
    cancellationReason: text('cancellation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_order_no_uniq').on(t.orderNo),
    index('purchase_order_supplier_idx').on(t.supplierId, t.status),
    index('purchase_order_status_idx').on(t.status, t.branchCode),
    // §5.4 — a cancellation without a reason is a record that something
    // happened, not a record of a decision.
    check(
      'purchase_order_cancellation_has_reason',
      sql`(${t.cancelledBy} is null and ${t.cancelledAt} is null)
          or (${t.cancelledBy} is not null and ${t.cancelledAt} is not null
              and coalesce(btrim(${t.cancellationReason}), '') <> '')`,
    ),
  ],
);

export const purchaseOrderLine = pgTable(
  'purchase_order_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    lineType: purchaseLineType('line_type').notNull(),
    /** Null for a service or expense line that names no catalogued item. */
    itemCode: text('item_code').references(() => item.code),
    description: text('description').notNull(),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),

    /**
     * §8.3 — branch, destination warehouse and cost centre at line level, so
     * one order can cover several of each.
     */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    warehouseCode: text('warehouse_code').references(() => warehouse.code),
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),

    /** Running totals, maintained as receipts arrive (§8.4). */
    receivedQuantity: numeric('received_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
    invoicedQuantity: numeric('invoiced_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
    /** Set when the open balance is closed by cancellation (§8.7). */
    closedQuantity: numeric('closed_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
  },
  (t) => [
    uniqueIndex('purchase_order_line_no_uniq').on(t.purchaseOrderId, t.lineNo),
    index('purchase_order_line_item_idx').on(t.itemCode),
    check('purchase_order_line_quantity_positive', sql`${t.quantity} > 0`),
    // A price of zero is legitimate — a free-of-charge replacement line — but a
    // negative one is not a price.
    check('purchase_order_line_price_not_negative', sql`${t.unitPrice} >= 0`),
    check('purchase_order_line_received_not_negative', sql`${t.receivedQuantity} >= 0`),
    // §8.3 — stock has to go somewhere. A service does not.
    check(
      'purchase_order_line_stock_needs_warehouse',
      sql`${t.lineType} <> 'inventory_item' or ${t.warehouseCode} is not null`,
    ),
    // An inventory line names an item; the item master is what makes the
    // receipt, the FIFO layer and the trace possible (§9.3).
    check(
      'purchase_order_line_stock_needs_item',
      sql`${t.lineType} <> 'inventory_item' or ${t.itemCode} is not null`,
    ),
  ],
);
