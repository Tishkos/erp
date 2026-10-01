/**
 * Supplier payment — Phase 05.10, §15 and Appendix C.
 *
 * > Appendix C: *"Supplier payment | Supplier A/P | Bank/Cash | Allocated to
 * > approved open items."*
 * > §15: *"Payment amount cannot exceed approved available invoice/advance
 * > balance."* · *"Blocked suppliers cannot be paid without an authorised
 * > override."*
 *
 * **Deliberately the minimum.** Payment *proposal*, payment *batch*,
 * maker-checker on the bank file and bank reconciliation are Phase 07 (§17);
 * this closes the procure-to-pay loop and proves the ledger reconciles, and
 * nothing more. The phase plan says so in terms, and building the Phase 07
 * machinery here would mean building it twice.
 *
 * **Allocation is a table, not a total.** §15 asks for credit notes and
 * advances to be *"allocated transparently"*, and Appendix C for allocation
 * history. A payment of ten million against forty invoices is one bank
 * movement and forty facts, and only the forty facts can answer "was invoice
 * 3312 paid, and by which payment?"
 *
 * **The blocked-supplier override is a column, not a policy.** §15 allows the
 * payment *with* an authorised override; a system that simply refused would be
 * ignored the first time a blocked supplier held a delivery hostage, and one
 * that allowed it silently would make the block pointless. So it is allowed,
 * named, reasoned and audited.
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
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { apInvoice } from './ap-invoice';

export const supplierPayment = pgTable(
  'supplier_payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentNo: text('payment_no').notNull(),

    /** draft → approved → posted → reversed. Phase 07 adds the batch states. */
    status: documentStatus('status').notNull().default('draft'),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    /** §17 — which account the money left. Its currency must match the payment. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    paymentDate: date('payment_date').notNull(),
    currency: text('currency').notNull().default('IQD'),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** REQ-AP-001 §15.4 — the amount in its own currency (the SWIFT amount); the journal stays IQD. */
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }),
    /** How much of the payment has been put against invoices. */
    allocatedAmountIqd: numeric('allocated_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    reference: text('reference'),
    note: text('note'),

    /**
     * §15 — *"Blocked suppliers cannot be paid without an authorised
     * override."* All three move together: an override with no reason records
     * that a control was bypassed without recording why, which is worse than
     * not recording it at all.
     */
    blockedOverrideBy: uuid('blocked_override_by').references(() => appUser.id),
    blockedOverrideAt: timestamp('blocked_override_at', { withTimezone: true }),
    blockedOverrideReason: text('blocked_override_reason'),

    /** Appendix C — Dr Supplier A/P / Cr Bank, written when it posts. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

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
    uniqueIndex('supplier_payment_no_uniq').on(t.paymentNo),
    index('supplier_payment_supplier_idx').on(t.supplierId, t.status),
    index('supplier_payment_date_idx').on(t.paymentDate, t.branchCode),

    check('supplier_payment_amount_positive', sql`${t.amountIqd} > 0`),
    // §15 — a payment cannot allocate more than it paid.
    check(
      'supplier_payment_not_over_allocated',
      sql`${t.allocatedAmountIqd} >= 0 and ${t.allocatedAmountIqd} <= ${t.amountIqd}`,
    ),

    check(
      'supplier_payment_override_complete',
      sql`(${t.blockedOverrideBy} is null and ${t.blockedOverrideAt} is null
           and ${t.blockedOverrideReason} is null)
          or (${t.blockedOverrideBy} is not null and ${t.blockedOverrideAt} is not null
              and coalesce(btrim(${t.blockedOverrideReason}), '') <> '')`,
    ),

    check(
      'supplier_payment_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

/**
 * §15 and Appendix C — which invoice each part of a payment settled.
 *
 * One row per (payment, invoice), so the same payment cannot be applied twice
 * to the same invoice — the same rule, and the same reason, as the supplier
 * advance settlement. Reversed rows keep their place in the history and are
 * excluded from the index.
 */
export const supplierPaymentAllocation = pgTable(
  'supplier_payment_allocation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    supplierPaymentId: uuid('supplier_payment_id')
      .notNull()
      .references(() => supplierPayment.id),
    apInvoiceId: uuid('ap_invoice_id')
      .notNull()
      .references(() => apInvoice.id),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: uuid('allocated_by')
      .notNull()
      .references(() => appUser.id),

    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
  },
  (t) => [
    uniqueIndex('supplier_payment_allocation_pair_uniq')
      .on(t.supplierPaymentId, t.apInvoiceId)
      .where(sql`reversed_at is null`),
    index('supplier_payment_allocation_invoice_idx').on(t.apInvoiceId),
    check('supplier_payment_allocation_amount_positive', sql`${t.amountIqd} > 0`),
  ],
);
