/**
 * Sales Return and Customer Credit Memo — Phase 06.9, §7.5.
 *
 * > *"A/R Invoice → Sales Return / Goods Return from Customer → Inspection →
 * > Saleable Warehouse, Quarantine Warehouse or Damaged Goods Warehouse →
 * > Customer Credit Memo."*
 *
 * **There is no exchange.** §7.5: *"Product exchange is not supported.
 * Replacement requires a new Sales Order."* So there is no replacement item, no
 * exchange line type and no swap document anywhere below — the rule is enforced
 * by there being nothing to enforce it against. A validation that refused
 * exchanges could be routed around by whatever path the validation was not
 * written for; a concept with no column cannot be reached at all.
 *
 * **Two documents, because Appendix B gives two**, with different owners and
 * different effects:
 *
 *   Sales Return | Warehouse/Sales | Requested, Received, Inspected, Accepted,
 *   Rejected, Closed | source: A/R Invoice / Delivery | effect: inventory
 *   movement.
 *
 *   Customer Credit Memo | Finance | Draft, Approved, Posted, Allocated,
 *   Reversed | source: Sales Return / A/R Invoice | effect: A/R and revenue
 *   reversal.
 *
 * The split is not bureaucracy: the warehouse decides whether goods came back
 * and in what condition, and Finance decides what the customer is owed. §7.5
 * routes damaged goods to a warehouse where they cannot be sold *and* still
 * credits the customer, which only works if the two decisions are separable.
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
import { businessPartner, warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { journalEntry } from './journal';
import { arInvoice, arInvoiceLine } from './ar-invoice';
import { deliveryNoteLine } from './delivery-note';
import { documentStatus } from './workflow';

/** §7.5's three destinations, and no fourth. */
export const returnDisposition = pgEnum('return_disposition', [
  'saleable',
  'quarantine',
  'damaged',
]);

export const salesReturn = pgTable(
  'sales_return',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    returnNo: text('return_no').notNull(),

    /**
     * Appendix B: Requested, Received, Inspected, Accepted, Rejected, Closed —
     * onto §3.2's shared vocabulary:
     *
     *   submitted (Requested) · partially_executed (Received) ·
     *   executed (Inspected) · approved (Accepted) · rejected · closed
     *
     * The order looks odd at a glance — approval after execution — and is right:
     * the warehouse receives and inspects the goods *before* anyone can sensibly
     * decide whether the company accepts the return. Accepting first would be
     * agreeing to credit a customer for goods nobody has looked at.
     */
    status: documentStatus('status').notNull().default('submitted'),

    /**
     * Appendix C — *"accepted return and source invoice required."* NOT NULL,
     * so a return that credits a customer for something they were never billed
     * for is unrepresentable rather than refused.
     */
    arInvoiceId: uuid('ar_invoice_id')
      .notNull()
      .references(() => arInvoice.id),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    requestedOn: date('requested_on').notNull(),
    /** When the goods physically came back. Null until Received. */
    receivedOn: date('received_on'),
    /** Why the customer says they are returning them. */
    reason: text('reason').notNull(),

    /** Where the goods land on receipt, before inspection routes them (§7.5). */
    receivingWarehouseCode: text('receiving_warehouse_code').references(() => warehouse.code),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    receivedBy: uuid('received_by').references(() => appUser.id),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    inspectedBy: uuid('inspected_by').references(() => appUser.id),
    inspectedAt: timestamp('inspected_at', { withTimezone: true }),
    acceptedBy: uuid('accepted_by').references(() => appUser.id),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => appUser.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sales_return_no_uniq').on(t.returnNo),
    index('sales_return_invoice_idx').on(t.arInvoiceId),
    index('sales_return_customer_idx').on(t.customerId, t.status),
    index('sales_return_status_idx').on(t.status, t.branchCode),

    check('sales_return_reason_present', sql`btrim(${t.reason}) <> ''`),
    check(
      'sales_return_rejection_has_reason',
      sql`(${t.rejectedBy} is null and ${t.rejectedAt} is null)
          or (${t.rejectedBy} is not null and ${t.rejectedAt} is not null
              and coalesce(btrim(${t.rejectionReason}), '') <> '')`,
    ),
    // A return cannot be inspected before it arrived, nor accepted before it was
    // inspected. The status machine refuses the transitions; this refuses a
    // stamp written round it.
    check(
      'sales_return_stamps_in_order',
      sql`(${t.inspectedAt} is null or ${t.receivedAt} is not null)
          and (${t.inspectedAt} is null or ${t.receivedAt} <= ${t.inspectedAt})
          and (${t.acceptedAt} is null or ${t.inspectedAt} is not null)
          and (${t.acceptedAt} is null or ${t.inspectedAt} <= ${t.acceptedAt})`,
    ),
    // Accepted and rejected are the two ends of one decision.
    check(
      'sales_return_one_outcome',
      sql`${t.acceptedAt} is null or ${t.rejectedAt} is null`,
    ),
    check(
      'sales_return_received_date_with_stamp',
      sql`(${t.receivedOn} is null) = (${t.receivedAt} is null)`,
    ),
  ],
);

export const salesReturnLine = pgTable(
  'sales_return_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salesReturnId: uuid('sales_return_id')
      .notNull()
      .references(() => salesReturn.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** §7.5 — what the customer was billed for, and what carried it to them. */
    arInvoiceLineId: uuid('ar_invoice_line_id')
      .notNull()
      .references(() => arInvoiceLine.id),
    deliveryNoteLineId: uuid('delivery_note_line_id')
      .notNull()
      .references(() => deliveryNoteLine.id),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    description: text('description').notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /** What the customer says they are sending back. */
    requestedQuantity: numeric('requested_quantity', { precision: 24, scale: 6 }).notNull(),
    /** What actually arrived. Null until Received; may be less. */
    receivedQuantity: numeric('received_quantity', { precision: 24, scale: 6 }),
    /** What the inspection accepted back into stock. Null until Inspected. */
    acceptedQuantity: numeric('accepted_quantity', { precision: 24, scale: 6 }),

    /**
     * §9.9 — which units came back.
     *
     * Copied from the source Delivery Note's identified units, because that is
     * what the chain says left. A tracked item cannot move without one (§9.3),
     * and a return that invented its own identity would break the trace at its
     * last link.
     */
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),

    /** §7.5 — saleable, quarantine or damaged. Null until Inspected. */
    disposition: returnDisposition('disposition'),
    /** Where the accepted units went. Must match the disposition (trigger). */
    destinationWarehouseCode: text('destination_warehouse_code').references(() => warehouse.code),
    inspectionNote: text('inspection_note'),

    /**
     * The unit cost the goods left at — Appendix C values a return at the
     * *original* FIFO cost, not today's. Copied from the source Delivery Note,
     * which recorded what it cost the moment it left, precisely so this question
     * has an answer years later.
     */
    originalUnitCostIqd: numeric('original_unit_cost_iqd', { precision: 19, scale: 4 }),
    /** The stock movement the acceptance produced. */
    inventoryMovementId: uuid('inventory_movement_id'),

    /** How much of this line a credit memo has already credited. */
    creditedQuantity: numeric('credited_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
  },
  (t) => [
    uniqueIndex('sales_return_line_no_uniq').on(t.salesReturnId, t.lineNo),
    uniqueIndex('sales_return_line_invoice_line_uniq').on(t.salesReturnId, t.arInvoiceLineId),
    index('sales_return_line_item_idx').on(t.itemCode),

    check('sales_return_line_requested_positive', sql`${t.requestedQuantity} > 0`),
    check(
      'sales_return_line_received_within_requested',
      sql`${t.receivedQuantity} is null
          or (${t.receivedQuantity} >= 0 and ${t.receivedQuantity} <= ${t.requestedQuantity})`,
    ),
    check(
      'sales_return_line_accepted_within_received',
      sql`${t.acceptedQuantity} is null
          or (${t.acceptedQuantity} >= 0
              and ${t.receivedQuantity} is not null
              and ${t.acceptedQuantity} <= ${t.receivedQuantity})`,
    ),
    // An inspected line says where the goods went, and a line that says where
    // they went has been inspected. Neither half is meaningful alone.
    check(
      'sales_return_line_inspection_complete',
      sql`(${t.disposition} is null) = (${t.destinationWarehouseCode} is null)`,
    ),
    check(
      'sales_return_line_credited_within_accepted',
      sql`${t.creditedQuantity} >= 0
          and (${t.acceptedQuantity} is null or ${t.creditedQuantity} <= ${t.acceptedQuantity})`,
    ),
    check(
      'sales_return_line_cost_not_negative',
      sql`${t.originalUnitCostIqd} is null or ${t.originalUnitCostIqd} >= 0`,
    ),
  ],
);

/**
 * Customer Credit Memo — Appendix B: Finance, *"A/R and revenue reversal"*.
 *
 * Appendix C: *"Sales return and Credit Memo | Sales Returns; Inventory /
 * Inspection | Customer A/R; COGS | Accepted return and source invoice
 * required."* The inventory and COGS half is the Sales Return's movement; this
 * document is the money half — Dr Sales Returns / Cr Customer A/R.
 *
 * **Sales Returns, not Revenue.** A credit memo debits a contra-revenue account
 * rather than reversing the original sale, so that gross sales and returns are
 * both visible. Netting them off at source would hide the return rate, which is
 * one of the few numbers that tells a company something is wrong with a product.
 */
export const customerCreditMemo = pgTable(
  'customer_credit_memo',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memoNo: text('memo_no').notNull(),

    /** draft · approved · posted · settled (Allocated) · reversed. */
    status: documentStatus('status').notNull().default('draft'),

    /** Appendix C — *"accepted return and source invoice required."* Both. */
    salesReturnId: uuid('sales_return_id')
      .notNull()
      .references(() => salesReturn.id),
    arInvoiceId: uuid('ar_invoice_id')
      .notNull()
      .references(() => arInvoice.id),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    memoDate: date('memo_date').notNull(),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    /** How much of this credit has been applied to invoices (§15, §16). */
    allocatedIqd: numeric('allocated_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

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
    uniqueIndex('customer_credit_memo_no_uniq').on(t.memoNo),
    // One live memo per return: a second would credit the same goods twice.
    uniqueIndex('customer_credit_memo_return_uniq')
      .on(t.salesReturnId)
      .where(sql`${t.status} <> 'reversed'`),
    index('customer_credit_memo_customer_idx').on(t.customerId, t.status),
    index('customer_credit_memo_invoice_idx').on(t.arInvoiceId),

    check('customer_credit_memo_amount_not_negative', sql`${t.amountIqd} >= 0`),
    check(
      'customer_credit_memo_allocation_within_amount',
      sql`${t.allocatedIqd} >= 0 and ${t.allocatedIqd} <= ${t.amountIqd}`,
    ),
    check(
      'customer_credit_memo_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
    check(
      'customer_credit_memo_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
    check(
      'customer_credit_memo_stamps_in_order',
      sql`(${t.postedAt} is null or ${t.approvedAt} is not null)
          and (${t.postedAt} is null or ${t.approvedAt} <= ${t.postedAt})
          and (${t.reversedAt} is null or ${t.postedAt} is not null)
          and (${t.reversedAt} is null or ${t.postedAt} <= ${t.reversedAt})`,
    ),
  ],
);

export const customerCreditMemoLine = pgTable(
  'customer_credit_memo_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerCreditMemoId: uuid('customer_credit_memo_id')
      .notNull()
      .references(() => customerCreditMemo.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    salesReturnLineId: uuid('sales_return_line_id')
      .notNull()
      .references(() => salesReturnLine.id),
    arInvoiceLineId: uuid('ar_invoice_line_id')
      .notNull()
      .references(() => arInvoiceLine.id),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    description: text('description').notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    /** The price the customer paid — from the invoice, never re-priced. */
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
  },
  (t) => [
    uniqueIndex('customer_credit_memo_line_no_uniq').on(t.customerCreditMemoId, t.lineNo),
    uniqueIndex('customer_credit_memo_line_return_line_uniq').on(
      t.customerCreditMemoId,
      t.salesReturnLineId,
    ),
    index('customer_credit_memo_line_item_idx').on(t.itemCode),

    check('customer_credit_memo_line_quantity_positive', sql`${t.quantity} > 0`),
    check('customer_credit_memo_line_price_not_negative', sql`${t.unitPrice} >= 0`),
    check('customer_credit_memo_line_amount_not_negative', sql`${t.amountIqd} >= 0`),
  ],
);
