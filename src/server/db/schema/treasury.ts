/**
 * Treasury operations — Phase 07, §17.
 *
 * > §17: Treasury is *"the execution layer for A/P, A/R, payroll, investments,
 * > projects and Money Transfer."*
 *
 * The account master itself is Phase 03's `bank_cash_account`, which already
 * carries the currency, the custodian, the cash limit, the approval limit and
 * the statement format §17 asks for. What Phase 07 adds is what *happens* to
 * those accounts: counts, transfers between them, statements arriving, and the
 * reconciliation that ties the two together.
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
import { bankCashAccount } from './item';
import { journalEntry } from './journal';
import { documentStatus } from './workflow';

/**
 * §17 — *"periodic cash counts."*
 *
 * A count is a document rather than a note because it produces an accounting
 * entry when it disagrees with the books, and somebody has to approve that. The
 * counted figure and the book figure are both stored: keeping only the variance
 * would lose the two numbers a later reader actually wants to compare.
 *
 * **A surplus is a variance too.** Cash found in a drawer is money the books
 * cannot explain, and the usual explanation is that something else was recorded
 * wrongly. There is no `is_shortfall` flag here, because treating "over" as the
 * innocent case is how a float slowly stops meaning anything.
 */
export const cashCount = pgTable(
  'cash_count',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    countNo: text('count_no').notNull(),

    /** draft · approved · posted — a count with no variance never posts. */
    status: documentStatus('status').notNull().default('draft'),

    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    countDate: date('count_date').notNull(),

    /** What was physically in the drawer. */
    countedIqd: numeric('counted_iqd', { precision: 19, scale: 4 }).notNull(),
    /** What the ledger said at that moment, captured with it. */
    bookIqd: numeric('book_iqd', { precision: 19, scale: 4 }).notNull(),
    /** Counted less book. Positive is a surplus. */
    varianceIqd: numeric('variance_iqd', { precision: 19, scale: 4 }).notNull(),

    /** §17 — the custodian at the time, copied: custody may change. */
    custodianUserId: uuid('custodian_user_id').references(() => appUser.id),
    /** Why the drawer disagreed, where anybody knows. */
    varianceReason: text('variance_reason'),
    note: text('note'),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    countedBy: uuid('counted_by')
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
    uniqueIndex('cash_count_no_uniq').on(t.countNo),
    index('cash_count_account_idx').on(t.bankCashAccountId, t.countDate),
    index('cash_count_status_idx').on(t.status, t.branchCode),

    check('cash_count_amounts_not_negative', sql`${t.countedIqd} >= 0 and ${t.bookIqd} >= 0`),
    // The variance is arithmetic, not an opinion. Storing it *and* deriving it
    // would be two answers to one question; this makes them the same answer.
    check('cash_count_variance_is_the_difference', sql`${t.varianceIqd} = ${t.countedIqd} - ${t.bookIqd}`),
    // §17 — a variance is explained by somebody or it is not approved.
    check(
      'cash_count_variance_has_a_reason',
      sql`${t.varianceIqd} = 0 or ${t.approvedAt} is null
          or coalesce(btrim(${t.varianceReason}), '') <> ''`,
    ),
    // A count that agreed has nothing to post; one that did not, posts.
    check(
      'cash_count_posting_matches_variance',
      sql`${t.journalEntryId} is null or ${t.varianceIqd} <> 0`,
    ),
    check(
      'cash_count_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
    check(
      'cash_count_stamps_in_order',
      sql`(${t.postedAt} is null or ${t.approvedAt} is not null)
          and (${t.postedAt} is null or ${t.approvedAt} <= ${t.postedAt})`,
    ),
  ],
);

/**
 * Money moved between the company's own accounts — Phase 07.4.
 *
 * > §17: *"An inter-account transfer debits one account and credits the other
 * > in a single balanced journal."*
 *
 * **One document, two legs, one journal.** The alternative — a payment out of
 * one account and a receipt into another — is two documents that can drift
 * apart, and the drift shows up as cash that exists in neither place for as long
 * as one of them is unposted.
 *
 * **Different currencies mean an explicit rate.** §17 allows a cross-currency
 * transfer *"using an approved FX conversion"*, and the rate is recorded on the
 * transfer rather than looked up at posting time — a transfer re-read next year
 * must show the rate it actually used (§2.3, §14.3).
 */
export const bankTransfer = pgTable(
  'bank_transfer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferNo: text('transfer_no').notNull(),

    /** draft · approved · posted · reversed. */
    status: documentStatus('status').notNull().default('draft'),

    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    toAccountId: uuid('to_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    transferDate: date('transfer_date').notNull(),

    /** What left the source account, in the source account's currency. */
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    fromCurrency: text('from_currency').notNull(),
    /** What arrived, in the destination's currency. Equal when they match. */
    receivedAmount: numeric('received_amount', { precision: 19, scale: 4 }).notNull(),
    toCurrency: text('to_currency').notNull(),
    /**
     * §17, §14.3 — the approved rate, recorded when the currencies differ.
     * Null when they do not, because there was no conversion to approve.
     */
    fxRate: numeric('fx_rate', { precision: 18, scale: 8 }),

    /** The bank's own reference, for the reconciliation to match on. */
    bankReference: text('bank_reference'),
    note: text('note'),

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
    uniqueIndex('bank_transfer_no_uniq').on(t.transferNo),
    index('bank_transfer_from_idx').on(t.fromAccountId, t.transferDate),
    index('bank_transfer_to_idx').on(t.toAccountId, t.transferDate),
    index('bank_transfer_status_idx').on(t.status, t.branchCode),

    check('bank_transfer_amounts_positive', sql`${t.amount} > 0 and ${t.receivedAmount} > 0`),
    // Money cannot be moved to where it already is. A transfer to the same
    // account is either a typing mistake or an attempt to manufacture a
    // reconciling item; neither is a transfer.
    check('bank_transfer_accounts_differ', sql`${t.fromAccountId} <> ${t.toAccountId}`),
    // §17 — a rate exists exactly when there was a conversion to rate.
    check(
      'bank_transfer_rate_matches_currencies',
      sql`(${t.fromCurrency} = ${t.toCurrency} and ${t.fxRate} is null
           and ${t.amount} = ${t.receivedAmount})
          or (${t.fromCurrency} <> ${t.toCurrency} and ${t.fxRate} is not null and ${t.fxRate} > 0)`,
    ),
    check(
      'bank_transfer_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
    check(
      'bank_transfer_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.postedAt} is null)`,
    ),
    check(
      'bank_transfer_stamps_in_order',
      sql`(${t.postedAt} is null or ${t.approvedAt} is not null)
          and (${t.postedAt} is null or ${t.approvedAt} <= ${t.postedAt})
          and (${t.reversedAt} is null or ${t.postedAt} is not null)`,
    ),
  ],
);
