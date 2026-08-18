/**
 * Customer Receipt — Phase 06.10, §16. Appendix B's *"Customer Receipt / Cash
 * Sale Receipt"*.
 *
 * One document type for both, because Appendix B gives one: a cash sale's
 * settlement is a receipt that happens to be posted in the same transaction as
 * its invoice (06.8). Building a second document for the cash case would be
 * exactly the duplication §24 warns about — *"duplicating these mechanisms
 * inside each module will create inconsistent controls"* — and the control that
 * would drift is the one that stops a customer being over-credited.
 *
 * **The customer is nullable, and that is the §16 rule, not laziness.**
 * *"Unidentified receipts remain in a clearing account until resolved."* Money
 * in the bank is a fact whatever else is unknown; who it belongs to may not be.
 * So the debit is always the bank and the *credit* is what moves: Customer A/R
 * when the payer is known, a clearing account when they are not. A receipt that
 * forced a customer would be a receipt somebody guessed at, and the guess would
 * be in the subledger.
 *
 * Appendix B: **Draft, Approved, Posted, Allocated, Reversed** — and no partial
 * state, so a half-applied receipt is still Posted and the unapplied balance is
 * a figure rather than a status.
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
import { bankCashAccount } from './item';
import { journalEntry } from './journal';
import { arInvoice } from './ar-invoice';
import { documentStatus } from './workflow';

export const customerReceipt = pgTable(
  'customer_receipt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptNo: text('receipt_no').notNull(),

    /** draft · approved · posted · settled (Allocated) · reversed. */
    status: documentStatus('status').notNull().default('draft'),

    /**
     * §16 — null until somebody works out whose money this is. The credit sits
     * in the clearing account meanwhile, and moves when it is identified.
     */
    customerId: uuid('customer_id').references(() => businessPartner.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    receiptDate: date('receipt_date').notNull(),

    /** §16 — *"currency and bank reference identification."* */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    currency: text('currency').notNull().default('IQD'),
    /** The transfer reference, cheque number or slip the bank shows. */
    bankReference: text('bank_reference'),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    allocatedIqd: numeric('allocated_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    /**
     * Set when this receipt was raised by a cash sale (06.8) rather than typed
     * by Treasury. Recorded because §7.4's *"immediate cash or bank
     * settlement"* is a fact about the sale, and a receipt that cannot say where
     * it came from makes the cash-sale report a reconciliation exercise.
     */
    cashSaleInvoiceId: uuid('cash_sale_invoice_id').references(() => arInvoice.id),

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
    uniqueIndex('customer_receipt_no_uniq').on(t.receiptNo),
    index('customer_receipt_customer_idx').on(t.customerId, t.status),
    index('customer_receipt_date_idx').on(t.receiptDate, t.branchCode),
    // The unapplied report, and the clearing account's own list.
    index('customer_receipt_unidentified_idx')
      .on(t.branchCode, t.receiptDate)
      .where(sql`${t.customerId} is null`),
    uniqueIndex('customer_receipt_cash_sale_uniq')
      .on(t.cashSaleInvoiceId)
      .where(sql`${t.cashSaleInvoiceId} is not null`),

    check('customer_receipt_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'customer_receipt_allocation_within_amount',
      sql`${t.allocatedIqd} >= 0 and ${t.allocatedIqd} <= ${t.amountIqd}`,
    ),
    // §16 — money cannot be applied to an invoice before anyone knows whose it
    // is. Unrepresentable rather than validated.
    check(
      'customer_receipt_unidentified_is_unapplied',
      sql`${t.customerId} is not null or ${t.allocatedIqd} = 0`,
    ),
    check(
      'customer_receipt_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
    check(
      'customer_receipt_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
    check(
      'customer_receipt_stamps_in_order',
      sql`(${t.postedAt} is null or ${t.approvedAt} is not null)
          and (${t.postedAt} is null or ${t.approvedAt} <= ${t.postedAt})
          and (${t.reversedAt} is null or ${t.postedAt} is not null)
          and (${t.reversedAt} is null or ${t.postedAt} <= ${t.reversedAt})`,
    ),
  ],
);

/**
 * §16 acceptance 2 — *"Receipt allocation supports one-to-many and many-to-one
 * matching."*
 *
 * Which needs no special case: an allocation is one row joining one receipt to
 * one invoice with an amount. One receipt across five invoices is five rows;
 * five receipts against one invoice is five rows. Modelling the two shapes
 * separately would invent a distinction the accounting does not have.
 *
 * §5.4 — kept, never deleted. An allocation that could be removed is one whose
 * history could be edited, and "why was this invoice marked paid in March?" is
 * exactly the question an audit asks. Undoing one is a reversal, which is a new
 * row with the opposite sign.
 */
export const customerReceiptAllocation = pgTable(
  'customer_receipt_allocation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerReceiptId: uuid('customer_receipt_id')
      .notNull()
      .references(() => customerReceipt.id),
    arInvoiceId: uuid('ar_invoice_id')
      .notNull()
      .references(() => arInvoice.id),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    allocatedBy: uuid('allocated_by')
      .notNull()
      .references(() => appUser.id),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (t) => [
    index('customer_receipt_allocation_receipt_idx').on(t.customerReceiptId),
    index('customer_receipt_allocation_invoice_idx').on(t.arInvoiceId),

    check('customer_receipt_allocation_amount_positive', sql`${t.amountIqd} > 0`),
  ],
);
