/**
 * Petty cash advances — Phase 07.5, §17 and Appendix D.
 *
 * > §17 scope: *"Petty Cash, Cash Advance and Cash Count."*
 * > Appendix D: *"Petty cash advances, ageing and cash count variances."*
 *
 * **The advance is a receivable, not an expense.** Money handed to someone who
 * has not yet said what it was for has not been spent; it has been lent. The
 * expense arrives with the receipts, on the account the receipts name — which is
 * why settlement lines carry their own account and dimensions rather than
 * everything landing in one "petty cash expenses" bucket that tells nobody
 * anything.
 *
 * **Two ways to close it, and only two.** Every dinar is accounted for with a
 * receipt or handed back. The arithmetic will not let it be neither, and the
 * closing rule will not let an advance be filed while it is.
 *
 * **There is no `custodian` table.** §17 already puts the custodian on the cash
 * account (`bank_cash_account.custodian_user_id`), so the balance a custodian
 * holds is the balance of their accounts — read from the G/L, like every other
 * balance in this phase. A second place to record it would be a second thing to
 * reconcile.
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
import { appUser, branch, department } from './platform';
import { businessLine } from './organisation';
import { bankCashAccount } from './item';
import { chartOfAccount } from './accounting';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';

export const cashAdvance = pgTable(
  'cash_advance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advanceNo: text('advance_no').notNull(),

    /** draft → approved → posted (issued) → partially_executed → settled/closed. */
    status: documentStatus('status').notNull().default('draft'),

    /** Which float the cash came out of. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * Who is holding the money and owes an account of it.
     *
     * A user rather than an employee: Phase 15 brings the employee master, and
     * an advance is held by whoever took it out of the drawer — which the system
     * knows about today, and can be linked to an employee record later.
     */
    holderUserId: uuid('holder_user_id')
      .notNull()
      .references(() => appUser.id),

    issueDate: date('issue_date').notNull(),
    /** §17 — when it must be accounted for. The date the ageing runs from. */
    dueDate: date('due_date').notNull(),
    /** Required. An advance for an unrecorded reason is untraceable. */
    purpose: text('purpose').notNull(),

    currency: text('currency').notNull().default('IQD'),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    settledAmountIqd: numeric('settled_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    returnedAmountIqd: numeric('returned_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    /** Dr Cash Advance / Cr Cash, written when the money is handed over. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    issuedBy: uuid('issued_by').references(() => appUser.id),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cash_advance_no_uniq').on(t.advanceNo),
    index('cash_advance_holder_idx').on(t.holderUserId, t.status),
    index('cash_advance_account_idx').on(t.bankCashAccountId, t.issueDate),
    index('cash_advance_due_idx').on(t.dueDate, t.status),

    check('cash_advance_amount_positive', sql`${t.amountIqd} > 0`),
    check('cash_advance_purpose_present', sql`btrim(${t.purpose}) <> ''`),
    check('cash_advance_due_not_before_issue', sql`${t.dueDate} >= ${t.issueDate}`),
    check(
      'cash_advance_amounts_not_negative',
      sql`${t.settledAmountIqd} >= 0 and ${t.returnedAmountIqd} >= 0`,
    ),
    // §17 — receipts and returns draw on the same money. Bounded together
    // rather than separately: an advance of 1,000 settled 700 can be returned
    // 300, not 1,000.
    check(
      'cash_advance_not_over_accounted',
      sql`${t.settledAmountIqd} + ${t.returnedAmountIqd} <= ${t.amountIqd}`,
    ),
    // Issued means the cash left, and cash leaving means a journal.
    check(
      'cash_advance_issue_matches_posting',
      sql`(${t.journalEntryId} is null) = (${t.issuedAt} is null)`,
    ),
    // Nothing is accounted for before the money has been handed over.
    check(
      'cash_advance_accounted_after_issue',
      sql`${t.issuedAt} is not null
          or (${t.settledAmountIqd} = 0 and ${t.returnedAmountIqd} = 0)`,
    ),
    // "Settled" means every dinar is accounted for. Without this, an advance
    // could be filed away with money still out — which is the one outcome the
    // whole document exists to prevent.
    check(
      'cash_advance_settled_means_settled',
      sql`${t.status} <> 'settled'
          or ${t.settledAmountIqd} + ${t.returnedAmountIqd} = ${t.amountIqd}`,
    ),
    check(
      'cash_advance_closed_when_settled',
      sql`(${t.closedAt} is null) = (${t.status} <> 'settled')`,
    ),
  ],
);

/**
 * What the money was actually spent on — one row per receipt.
 *
 * The account and the §4.2 dimensions live on the line rather than the header,
 * because one advance buys several unrelated things. A single expense account
 * for the whole advance would put fuel, stationery and a courier fee in the same
 * place and make the department analysis §4.2 requires impossible.
 */
export const cashAdvanceSettlement = pgTable(
  'cash_advance_settlement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cashAdvanceId: uuid('cash_advance_id')
      .notNull()
      .references(() => cashAdvance.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** The expense account the receipt belongs to. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccount.id),
    departmentCode: text('department_code').references(() => department.code),
    businessLineCode: text('business_line_code').references(() => businessLine.code),

    spentOn: date('spent_on').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    description: text('description').notNull(),
    /** The receipt or voucher number, where there is one. */
    receiptReference: text('receipt_reference'),

    /** The journal this line was part of — Dr Expense / Cr Cash Advance. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('cash_advance_settlement_line_uniq').on(t.cashAdvanceId, t.lineNo),
    index('cash_advance_settlement_account_idx').on(t.accountId, t.spentOn),

    check('cash_advance_settlement_amount_positive', sql`${t.amountIqd} > 0`),
    check('cash_advance_settlement_description_present', sql`btrim(${t.description}) <> ''`),
  ],
);
