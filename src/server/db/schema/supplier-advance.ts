/**
 * Supplier advances — Phase 05.6, §8.5.
 *
 * > *"Supplier Advance Request and Supplier Advance Payment. Advance linked to a
 * > Purchase Order. Automatic or manual partial settlement against A/P Invoice.
 * > Supplier refund and reversal controls. Prevention of duplicate settlement."*
 *
 * An advance is money paid before anything has been delivered. Until it is
 * settled it is an **asset** — the supplier owes goods or a refund — which is
 * why Appendix C sends it to a Supplier Advance account rather than reducing
 * payables: reducing payables would net a debt the company is owed against
 * debts it owes, and the supplier statement would stop agreeing with the ledger.
 *
 * **Every advance names its purchase order.** §8.5's second bullet, and the
 * gate's first item. Not nullable, because an advance with no order is money
 * out of the door against nothing — the single control this document exists to
 * provide.
 *
 * **Settlement is its own table, not a running total.** *"Linked to PO and
 * settlement history"* (Appendix C): the history is the record of which invoice
 * consumed which advance and when, and it is what makes duplicate settlement
 * detectable rather than merely unlikely. The running balances on the header
 * are derived from it and kept in step by trigger.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner } from './organisation';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { purchaseOrder } from './purchase-order';
import { payable } from './payables';
import { apInvoice } from './ap-invoice';

export const supplierAdvance = pgTable(
  'supplier_advance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advanceNo: text('advance_no').notNull(),

    /**
     * Appendix B: Draft, Approved, Paid, Partially Settled, Settled, Refunded,
     * Reversed — mapped onto §3.2's shared vocabulary:
     *
     *   draft               Draft
     *   approved            Approved (the request is agreed, no money has moved)
     *   posted              Paid (the bank has paid it)
     *   partially_executed  Partially Settled
     *   settled             Settled
     *   closed              Refunded — the money came back rather than being consumed
     *   reversed            Reversed
     */
    status: documentStatus('status').notNull().default('draft'),

    /** §8.5 — an advance without an order is money out against nothing. */
    purchaseOrderId: uuid('purchase_order_id')
      .notNull()
      .references(() => purchaseOrder.id),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    /** REQ-AP-001 §12 — the advance payable this document pays. */
    payableId: uuid('payable_id').references(() => payable.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    requestDate: date('request_date').notNull(),
    /** When the bank actually paid it — the date the posting carries. */
    paidDate: date('paid_date'),
    currency: text('currency').notNull().default('IQD'),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** REQ-AP-001 §15.4 — the amount in its own currency (the SWIFT amount); the journal stays IQD. */
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }),
    /** Consumed by A/P invoices. Maintained from the settlement history. */
    settledAmountIqd: numeric('settled_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    /** §8.5 — given back rather than consumed. */
    refundedAmountIqd: numeric('refunded_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    reason: text('reason'),

    /** Appendix C — Dr Supplier Advance / Cr Bank or Cash, when it is paid. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => appUser.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_advance_no_uniq').on(t.advanceNo),
    index('supplier_advance_supplier_idx').on(t.supplierId, t.status),
    index('supplier_advance_order_idx').on(t.purchaseOrderId),

    check('supplier_advance_amount_positive', sql`${t.amountIqd} > 0`),
    check('supplier_advance_settled_not_negative', sql`${t.settledAmountIqd} >= 0`),
    check('supplier_advance_refunded_not_negative', sql`${t.refundedAmountIqd} >= 0`),

    // §8.5 — the balance can reach zero and cannot pass it. Settlement and
    // refund draw on the same money, so they are bounded together rather than
    // separately: an advance of 1,000 settled 700 can be refunded 300, not
    // 1,000.
    check(
      'supplier_advance_not_over_consumed',
      sql`${t.settledAmountIqd} + ${t.refundedAmountIqd} <= ${t.amountIqd}`,
    ),

    check(
      'supplier_advance_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

/**
 * §8.5 — the settlement history.
 *
 * One row per (advance, invoice) pair: *"prevention of duplicate settlement"* is
 * the gate's own wording, and a unique index is the only form of that rule that
 * cannot be raced. Two clerks settling the same advance against the same
 * invoice at the same moment is exactly the case a service-level check misses.
 *
 * Reversed settlements keep their row and are excluded from the index, so a
 * settlement made in error can be undone and remade without the history losing
 * the fact that it happened.
 */
export const supplierAdvanceSettlement = pgTable(
  'supplier_advance_settlement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierAdvanceId: uuid('supplier_advance_id')
      .notNull()
      .references(() => supplierAdvance.id),
    apInvoiceId: uuid('ap_invoice_id')
      .notNull()
      .references(() => apInvoice.id),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    settlementDate: date('settlement_date').notNull(),
    /** True when the settlement was made by the system rather than by hand. */
    automatic: text('automatic').notNull().default('manual'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    settledBy: uuid('settled_by')
      .notNull()
      .references(() => appUser.id),
    settledAt: timestamp('settled_at', { withTimezone: true }).notNull().defaultNow(),

    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    // §8.5 — the same advance cannot be settled twice against the same invoice.
    uniqueIndex('supplier_advance_settlement_pair_uniq')
      .on(t.supplierAdvanceId, t.apInvoiceId)
      .where(sql`reversed_at is null`),
    index('supplier_advance_settlement_invoice_idx').on(t.apInvoiceId),
    check('supplier_advance_settlement_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'supplier_advance_settlement_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);
