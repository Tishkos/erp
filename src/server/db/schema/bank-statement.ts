/**
 * Bank statements — Phase 07.6, §17, §23 and Appendix B.
 *
 * > Appendix B, Bank Statement Line: *"Unique import key; match status;
 * > book-to-bank reconciliation."*
 * > §17: *"Import or manual entry of bank statements, per the statement format
 * > on the account master."*
 *
 * **The statement is evidence, not a transaction.** Nothing here posts to the
 * ledger and nothing here has a journal link, because a bank statement records
 * what the bank did — the company's own entries were made when the payments and
 * receipts were raised. A statement line that posted would be the second
 * recording of a movement already recorded, which is how a bank account comes to
 * be double-counted.
 *
 * **Immutability is deliberate and comes later.** §17 requires reconciled lines
 * to be immutable, with corrections going through a reopen workflow; that
 * belongs to the reconciliation (07.7) and is enforced there, on the `match_status`
 * this table carries.
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
import { MATCH_STATES } from '../../domain/bank-statement';
import { appUser, branch } from './platform';
import { bankCashAccount } from './item';
import { importBatch } from './import';
import { documentStatus } from './workflow';

export const statementMatchStatus = pgEnum('statement_match_status', MATCH_STATES);

export const bankStatement = pgTable(
  'bank_statement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statementNo: text('statement_no').notNull(),

    /** draft while lines are arriving; `closed` once it has been reconciled. */
    status: documentStatus('status').notNull().default('draft'),

    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** The bank's own reference for this statement, where it gives one. */
    bankReference: text('bank_reference'),

    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    currency: text('currency').notNull().default('IQD'),

    /**
     * §17 — the two figures the reconciliation is judged against.
     *
     * Both are the bank's, taken from the statement and never computed: a
     * closing balance the system worked out for itself would agree with the
     * lines by construction, and agreeing with the lines is precisely what has
     * to be *proved*.
     */
    openingBalanceIqd: numeric('opening_balance_iqd', { precision: 19, scale: 4 }).notNull(),
    closingBalanceIqd: numeric('closing_balance_iqd', { precision: 19, scale: 4 }).notNull(),

    /** §23 — which file this came from, when it came from a file. */
    importBatchId: uuid('import_batch_id').references(() => importBatch.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_statement_no_uniq').on(t.statementNo),
    index('bank_statement_account_idx').on(t.bankCashAccountId, t.periodTo),
    // The bank's own statement reference is unique per account where given.
    uniqueIndex('bank_statement_bank_ref_uniq')
      .on(t.bankCashAccountId, t.bankReference)
      .where(sql`bank_reference is not null`),
    // One statement per account per period. Two would double-count in the
    // reconciliation, and the second is almost always the same file arriving
    // twice — which is the duplicate this catches before any line is read.
    uniqueIndex('bank_statement_period_uniq')
      .on(t.bankCashAccountId, t.periodFrom, t.periodTo)
      .where(sql`status <> 'cancelled'`),

    check('bank_statement_period_ordered', sql`${t.periodTo} >= ${t.periodFrom}`),
  ],
);

export const bankStatementLine = pgTable(
  'bank_statement_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatement.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /**
     * Appendix B — *"unique import key"*. Unique across the whole table rather
     * than within a statement: the same transaction arriving in two overlapping
     * downloads is exactly the duplicate this prevents, and those are two
     * different statements.
     */
    importKey: text('import_key').notNull(),

    bookingDate: date('booking_date').notNull(),
    /** §17 — when the money actually became available. Not always the same day. */
    valueDate: date('value_date').notNull(),

    /** Signed. Positive is money into the account; there is no separate column. */
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    reference: text('reference'),
    counterparty: text('counterparty'),
    description: text('description'),

    /** Appendix B — *"match status"*. Driven by 07.7, never by the import. */
    matchStatus: statementMatchStatus('match_status').notNull().default('unmatched'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_statement_line_import_key_uniq').on(t.importKey),
    uniqueIndex('bank_statement_line_no_uniq').on(t.statementId, t.lineNo),
    index('bank_statement_line_match_idx').on(t.matchStatus, t.bookingDate),
    index('bank_statement_line_amount_idx').on(t.amountIqd, t.bookingDate),

    check('bank_statement_line_amount_not_zero', sql`${t.amountIqd} <> 0`),
    check('bank_statement_line_value_date_not_before', sql`${t.valueDate} >= ${t.bookingDate}`),
  ],
);

/**
 * §17 and §23 — a row of the file that could not be read.
 *
 * The 07.6 gate: *"an unparseable line is reported rather than silently
 * dropped."* Keeping the raw text is the point — the person fixing it needs to
 * see what the bank actually sent, not the system's summary of why it failed.
 */
export const bankStatementRejectedLine = pgTable(
  'bank_statement_rejected_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatement.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),
    rawText: text('raw_text').notNull(),
    problem: text('problem').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bank_statement_rejected_statement_idx').on(t.statementId),
    check('bank_statement_rejected_problem_present', sql`btrim(${t.problem}) <> ''`),
  ],
);
