/**
 * A/R Invoice — Phase 06.6, §7.4.
 *
 * > §7.4: *"Every inventory A/R Invoice shall be created from an approved
 * > Delivery Note. The A/R Invoice shall be issued on the same date as
 * > delivery."*
 *
 * Appendix B: **Draft, Approved, Posted, Partially Paid, Paid, Reversed**;
 * source **Delivery Note**; effect **A/R and revenue**.
 *
 * **The cost is not posted here.** Appendix B splits the sale in two: the
 * Delivery Note is *Inventory and COGS*, this is *A/R and revenue*. Appendix C's
 * single "Sales delivery and invoice" row describes the combined economic event
 * across both documents — it is not an instruction to post the cost twice.
 * There is no COGS column on this table, so the mistake cannot be recorded here.
 *
 * **Nothing on this document decides the money.** The price came from the
 * customer's price list and was locked on the Sales Order (§7.3, §7.4); the
 * quantity came from the Delivery Note. So the line has no editable price and no
 * free quantity: it names a delivery line and how much of it is being billed,
 * and every amount is computed from what those two already say. §7.7 requires
 * the price-list control to survive *"the UI or API"*, and a field that does not
 * exist survives both.
 */
import { sql } from 'drizzle-orm';
import {
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
import { businessPartner, warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { journalEntry } from './journal';
import { salesOrder, salesOrderLine } from './sales-order';
import { deliveryNote, deliveryNoteLine } from './delivery-note';
import { documentStatus } from './workflow';

export const arInvoice = pgTable(
  'ar_invoice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceNo: text('invoice_no').notNull(),

    /**
     * Appendix B: Draft, Approved, Posted, Partially Paid, Paid, Reversed —
     * onto §3.2's vocabulary:
     *
     *   draft · approved · posted · partially_executed · settled · reversed
     *
     * The same mapping the A/P Invoice uses (migration 0036), because they are
     * the same lifecycle seen from the two sides of a ledger.
     */
    status: documentStatus('status').notNull().default('draft'),

    /**
     * §7.4 — *"Every inventory A/R Invoice shall be created from an approved
     * Delivery Note."* NOT NULL is the control: an invoice with no delivery is
     * revenue for goods nobody shipped, and there is no column here in which to
     * record one.
     */
    /**
     * Null when the invoice was raised on its own — Operations block 5. The
     * reference stays and stays checked; it simply stops being compulsory, so
     * a sale can be invoiced without inventing an order and a delivery nobody
     * made.
     */
    deliveryNoteId: uuid('delivery_note_id').references(() => deliveryNote.id),
    salesOrderId: uuid('sales_order_id')
      .references(() => salesOrder.id),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * §7.4 — the same date as the delivery. Enforced by a trigger against the
     * Delivery Note rather than only by the service, because §7.7 says the
     * sales controls cannot be bypassed through the UI or the API and an import
     * is neither.
     */
    invoiceDate: date('invoice_date').notNull(),
    /** §4.3 — from the order's payment terms, so the ageing has a due date. */
    paymentTermsCode: text('payment_terms_code'),
    dueDate: date('due_date').notNull(),

    currency: text('currency').notNull().default('IQD'),

    grossIqd: numeric('gross_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    discountIqd: numeric('discount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    netIqd: numeric('net_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /**
     * How much has been settled by receipts and credit memos (§15). Maintained
     * by 06.9 and 06.10; here so that Appendix B's Partially Paid and Paid are
     * derived from money rather than declared by whoever recorded the receipt.
     */
    allocatedIqd: numeric('allocated_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /** The Dr A/R / Cr Revenue posting. Null until posted, never rewritten. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ar_invoice_no_uniq').on(t.invoiceNo),
    // One invoice per delivery, unless the first was reversed. §7.4 makes the
    // delivery the source of the invoice; two invoices from one delivery would
    // bill the customer twice for one shipment.
    uniqueIndex('ar_invoice_delivery_uniq')
      .on(t.deliveryNoteId)
      .where(sql`${t.status} <> 'reversed'`),
    index('ar_invoice_customer_idx').on(t.customerId, t.status),
    index('ar_invoice_due_idx').on(t.dueDate, t.status),
    index('ar_invoice_order_idx').on(t.salesOrderId),

    check(
      'ar_invoice_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),

    check(
      'ar_invoice_totals_consistent',
      sql`${t.netIqd} = ${t.grossIqd} - ${t.discountIqd}
          and ${t.discountIqd} >= 0 and ${t.grossIqd} >= 0`,
    ),

    // Money received against an invoice cannot exceed it. The excess is a
    // customer credit, which is a different thing with a different account.
    check(
      'ar_invoice_allocation_within_total',
      sql`${t.allocatedIqd} >= 0 and ${t.allocatedIqd} <= ${t.netIqd}`,
    ),

    // §4.3 — an invoice is never due before it is issued.
    check('ar_invoice_due_after_issue', sql`${t.dueDate} >= ${t.invoiceDate}`),

    // The posting and the posted status arrive together (§24).
    check(
      'ar_invoice_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),

    check(
      'ar_invoice_stamps_in_order',
      sql`(${t.postedAt} is null or ${t.approvedAt} is not null)
          and (${t.postedAt} is null or ${t.approvedAt} <= ${t.postedAt})
          and (${t.reversedAt} is null or ${t.postedAt} is not null)
          and (${t.reversedAt} is null or ${t.postedAt} <= ${t.reversedAt})`,
    ),
  ],
);

export const arInvoiceLine = pgTable(
  'ar_invoice_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    arInvoiceId: uuid('ar_invoice_id')
      .notNull()
      .references(() => arInvoice.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** What is being billed, and where its quantity came from. */
    /** Null on a directly-raised invoice — see the note on the header. */
    deliveryNoteLineId: uuid('delivery_note_line_id').references(() => deliveryNoteLine.id),
    salesOrderLineId: uuid('sales_order_line_id').references(() => salesOrderLine.id),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    description: text('description').notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),

    /**
     * §7.3 and §7.4 — the price the Sales Order locked. Stored so the invoice
     * says what was charged, and never accepted from the caller: the service
     * reads it from the order line, and a trigger refuses a row whose price is
     * not the one the order carries.
     */
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    discountPercent: numeric('discount_percent', { precision: 9, scale: 4 }),
    discountAmountIqd: numeric('discount_amount_iqd', { precision: 19, scale: 4 }),

    grossIqd: numeric('gross_iqd', { precision: 19, scale: 4 }).notNull(),
    netIqd: numeric('net_iqd', { precision: 19, scale: 4 }).notNull(),

    /**
     * Where this line takes its stock from, and whose stock it is —
     * Operations block 5. Both on the line, not the document: the sponsor is
     * explicit that one item can appear on separate lines under different
     * suppliers, and one invoice may ship from two warehouses.
     *
     * Null when a Delivery Note already shipped the goods. The database
     * refuses a line that has both, because that would move the same stock
     * twice.
     */
    warehouseCode: text('warehouse_code').references(() => warehouse.code),
    supplierId: uuid('supplier_id').references(() => businessPartner.id),
  },
  (t) => [
    uniqueIndex('ar_invoice_line_no_uniq').on(t.arInvoiceId, t.lineNo),
    uniqueIndex('ar_invoice_line_delivery_line_uniq').on(t.arInvoiceId, t.deliveryNoteLineId),
    index('ar_invoice_line_order_line_idx').on(t.salesOrderLineId),
    index('ar_invoice_line_item_idx').on(t.itemCode),

    check('ar_invoice_line_quantity_positive', sql`${t.quantity} > 0`),
    check('ar_invoice_line_price_not_negative', sql`${t.unitPrice} >= 0`),
    check(
      'ar_invoice_line_one_discount_form',
      sql`${t.discountPercent} is null or ${t.discountAmountIqd} is null`,
    ),
    check('ar_invoice_line_net_consistent', sql`${t.netIqd} <= ${t.grossIqd}`),
  ],
);
