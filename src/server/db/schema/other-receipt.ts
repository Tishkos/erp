/**
 * Other Receipt — Phase 07.4, §17.
 *
 * > §17 scope: *"Customer Receipt and Other Receipt."*
 *
 * Money arriving that is not a customer paying an invoice: a refund from a
 * supplier, interest, the sale of something small, an insurance settlement.
 *
 * **It is a different document from a Customer Receipt on purpose.** A customer
 * receipt settles a receivable and belongs to the A/R subledger; this one credits
 * an account somebody names and belongs to nothing. Letting one document do both
 * would mean a receipt could be allocated to an invoice *or* to an income
 * account depending on how it was filled in, and the A/R control account would
 * stop tying to the subledger the first time somebody chose wrongly.
 *
 * The refusal is structural rather than procedural: there is no customer column
 * here and no allocation table, and a trigger refuses a credit to any control
 * account — so an Other Receipt cannot touch a subledger even by accident.
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
import { appUser, branch, department } from './platform';
import { businessLine } from './organisation';
import { bankCashAccount } from './item';
import { chartOfAccount } from './accounting';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';

export const otherReceipt = pgTable(
  'other_receipt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptNo: text('receipt_no').notNull(),

    status: documentStatus('status').notNull().default('draft'),

    /** §17 — which account the money arrived in. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    receiptDate: date('receipt_date').notNull(),
    currency: text('currency').notNull().default('IQD'),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /**
     * What the money was for. Named on the document rather than resolved
     * through a §3.3 mapping, because there is no rule that could pick it: an
     * insurance settlement and a scrap sale are both "other".
     */
    creditAccountId: uuid('credit_account_id')
      .notNull()
      .references(() => chartOfAccount.id),

    /** §4.2 — carried on the receipt, because the account will require them. */
    departmentCode: text('department_code').references(() => department.code),
    businessLineCode: text('business_line_code').references(() => businessLine.code),

    /** Who paid it in. Free text: they are not a business partner by definition. */
    payer: text('payer').notNull(),
    reference: text('reference'),
    note: text('note'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('other_receipt_no_uniq').on(t.receiptNo),
    index('other_receipt_account_idx').on(t.bankCashAccountId, t.receiptDate),
    index('other_receipt_status_idx').on(t.status, t.branchCode),

    check('other_receipt_amount_positive', sql`${t.amountIqd} > 0`),
    check('other_receipt_payer_present', sql`btrim(${t.payer}) <> ''`),
    check(
      'other_receipt_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
    check(
      'other_receipt_posted_after_approval',
      sql`${t.postedAt} is null
          or (${t.approvedAt} is not null and ${t.approvedAt} <= ${t.postedAt})`,
    ),
  ],
);
