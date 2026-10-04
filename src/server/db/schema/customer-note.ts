/**
 * Customer Credit / Debit Note and the application of customer credits —
 * Receivables, 2026-10-04 (migration 0280).
 *
 * **A note is not a memo.** The Credit Memo (`sales-return.ts`) is the money
 * half of an accepted return, and Appendix C makes the return compulsory —
 * that NOT NULL is a control and stays one. A note answers what a return
 * cannot: a price allowance after the sale (credit), or a charge the invoice
 * missed (debit). Neither has goods behind it, so neither moves stock.
 *
 *   Credit note   Dr Sales Returns & Allowances / Cr Customer A/R
 *   Debit note    Dr Customer A/R / Cr Revenue
 *
 * Both post through the posting engine under their own events, whose rules
 * 0280 copied from the memo's and the invoice's, and both land on the customer
 * subledger like any other document — so the statement, the ageing and the
 * reconciliation read them without being told they exist.
 *
 * **Application.** A customer's credit — what is left on a receipt, a memo or
 * a credit note — is put against what they owe through
 * `customer_credit_application`. A receipt against an invoice keeps its own
 * table (`customer_receipt_allocation`) and is refused here by a CHECK, so
 * every settlement is recorded in exactly one place.
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
import { chartOfAccount } from './accounting';
import { journalEntry } from './journal';
import { arInvoice } from './ar-invoice';
import { customerReceipt } from './customer-receipt';
import { customerCreditMemo } from './sales-return';
import { paymentTerms } from './pricing';
import { documentStatus } from './workflow';

export const CUSTOMER_NOTE_KINDS = ['credit', 'debit'] as const;
export type CustomerNoteKind = (typeof CUSTOMER_NOTE_KINDS)[number];

export const customerNote = pgTable(
  'customer_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    noteNo: text('note_no').notNull(),
    kind: text('kind').$type<CustomerNoteKind>().notNull(),
    /** draft · approved · posted · partially_executed · settled · reversed · cancelled. */
    status: documentStatus('status').notNull().default('draft'),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    /** The invoice it corrects, when it corrects one. */
    arInvoiceId: uuid('ar_invoice_id').references(() => arInvoice.id),
    noteDate: date('note_date').notNull(),
    /** A debit note ages from it; a credit note's is its own date. */
    dueDate: date('due_date').notNull(),
    paymentTermsCode: text('payment_terms_code').references(() => paymentTerms.code),
    currency: text('currency').notNull().default('IQD'),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** Credit: how much has been applied. Debit: how much has been settled. */
    allocatedIqd: numeric('allocated_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    reason: text('reason').notNull(),
    description: text('description'),
    /** The other side of the entry when named; null is "as configured". */
    accountId: uuid('account_id').references(() => chartOfAccount.id),
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
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntry.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_note_no_uniq').on(t.noteNo),
    index('customer_note_customer_idx').on(t.customerId, t.status),
    index('customer_note_invoice_idx').on(t.arInvoiceId),
    index('customer_note_due_idx').on(t.dueDate, t.status),
    index('customer_note_journal_idx').on(t.journalEntryId),
    check('customer_note_kind', sql`${t.kind} in ('credit', 'debit')`),
    check('customer_note_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'customer_note_allocation_within_amount',
      sql`${t.allocatedIqd} >= 0 and ${t.allocatedIqd} <= ${t.amountIqd}`,
    ),
    check('customer_note_reason_present', sql`btrim(${t.reason}) <> ''`),
    check('customer_note_due_after_issue', sql`${t.dueDate} >= ${t.noteDate}`),
    check('customer_note_credit_due_on_issue', sql`${t.kind} = 'debit' or ${t.dueDate} = ${t.noteDate}`),
    check(
      'customer_note_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
  ],
);

export const customerCreditApplication = pgTable(
  'customer_credit_application',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    /** The credit being used — exactly one of the three. */
    customerReceiptId: uuid('customer_receipt_id').references(() => customerReceipt.id),
    customerCreditMemoId: uuid('customer_credit_memo_id').references(() => customerCreditMemo.id),
    creditNoteId: uuid('credit_note_id').references(() => customerNote.id),
    /** What it settles — exactly one of the two. */
    arInvoiceId: uuid('ar_invoice_id').references(() => arInvoice.id),
    debitNoteId: uuid('debit_note_id').references(() => customerNote.id),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    appliedOn: date('applied_on').notNull(),
    appliedBy: uuid('applied_by')
      .notNull()
      .references(() => appUser.id),
    appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
    note: text('note'),
  },
  (t) => [
    index('customer_credit_application_customer_idx').on(t.customerId),
    index('customer_credit_application_receipt_idx').on(t.customerReceiptId),
    index('customer_credit_application_memo_idx').on(t.customerCreditMemoId),
    index('customer_credit_application_credit_note_idx').on(t.creditNoteId),
    index('customer_credit_application_invoice_idx').on(t.arInvoiceId),
    index('customer_credit_application_debit_note_idx').on(t.debitNoteId),
    check('customer_credit_application_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'customer_credit_application_one_source',
      sql`num_nonnulls(${t.customerReceiptId}, ${t.customerCreditMemoId}, ${t.creditNoteId}) = 1`,
    ),
    check(
      'customer_credit_application_one_target',
      sql`num_nonnulls(${t.arInvoiceId}, ${t.debitNoteId}) = 1`,
    ),
    check(
      'customer_credit_application_receipt_invoice_elsewhere',
      sql`${t.customerReceiptId} is null or ${t.arInvoiceId} is null`,
    ),
  ],
);
