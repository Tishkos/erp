/**
 * Bank reconciliation workspace — Phase 07.7, §17.
 *
 * > §17: *"Automatic matching by amount, date, reference and counterparty, with
 * > manual confirmation."* · *"Statement lines are immutable after
 * > reconciliation; corrections use reopen/adjustment workflow."* ·
 * > *"Reconciliation cannot be finalised with unexplained differences unless an
 * > authorised adjustment is posted."*
 *
 * **A match is a set against a set, not a pair.** §12.5's Bank Execution Batch
 * puts one bank debit against several internally separate transfers — each
 * keeping its own document, client, branch and margin — and requires the batch
 * total to reconcile to the single statement amount. A one-to-one match cannot
 * say that, and Phase 09 would have to rebuild this workspace to add it. So the
 * model is a match with lines on both sides, and the rule is that the two sides
 * total the same.
 *
 * **The reconciliation stores its own arithmetic.** Closing balance, deposits in
 * transit, unpresented payments and the difference are all columns, because a
 * reconciliation somebody signed is a statement about figures that were true at
 * that moment. Recomputing them later would answer a different question — a
 * useful one, but not the one the signature was against.
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { bankCashAccount } from './item';
import { bankStatement, bankStatementLine } from './bank-statement';
import { journalLine } from './journal';
import { documentStatus } from './workflow';

export const MATCH_STATES = ['suggested', 'confirmed'] as const;
export const matchState = pgEnum('reconciliation_match_state', MATCH_STATES);

export const bankReconciliation = pgTable(
  'bank_reconciliation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reconciliationNo: text('reconciliation_no').notNull(),

    /** draft while it is worked; approved once it balances and is signed. */
    status: documentStatus('status').notNull().default('draft'),

    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** One reconciliation per statement. Two would each agree half the period. */
    statementId: uuid('statement_id')
      .notNull()
      .references(() => bankStatement.id),

    asOfDate: date('as_of_date').notNull(),

    /**
     * §17 acceptance criterion 3 — the four figures the agreement is made of.
     *
     * ```text
     *   statement closing
     * + deposits in transit
     * − unpresented payments
     * = reconciled balance, which must equal the G/L
     * ```
     */
    statementClosingIqd: numeric('statement_closing_iqd', { precision: 19, scale: 4 }).notNull(),
    ledgerBalanceIqd: numeric('ledger_balance_iqd', { precision: 19, scale: 4 }).notNull(),
    depositsInTransitIqd: numeric('deposits_in_transit_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    unpresentedPaymentsIqd: numeric('unpresented_payments_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    /** Reconciled balance less the G/L. Must be zero to finalise. */
    differenceIqd: numeric('difference_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    preparedBy: uuid('prepared_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    /** §17 — the reopen workflow, and why it was used. */
    reopenedBy: uuid('reopened_by').references(() => appUser.id),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenReason: text('reopen_reason'),
    reopenCount: smallint('reopen_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_reconciliation_no_uniq').on(t.reconciliationNo),
    uniqueIndex('bank_reconciliation_statement_uniq').on(t.statementId),
    index('bank_reconciliation_account_idx').on(t.bankCashAccountId, t.asOfDate),

    // §17 — an approved reconciliation is one that balanced. Written here so
    // that no code path, present or future, can sign one that did not.
    check(
      'bank_reconciliation_approved_means_balanced',
      sql`${t.approvedAt} is null or ${t.differenceIqd} = 0`,
    ),
    check(
      'bank_reconciliation_approval_complete',
      sql`(${t.approvedBy} is null) = (${t.approvedAt} is null)`,
    ),
    check(
      'bank_reconciliation_reopen_has_reason',
      sql`(${t.reopenedBy} is null and ${t.reopenedAt} is null)
          or (${t.reopenedBy} is not null and ${t.reopenedAt} is not null
              and coalesce(btrim(${t.reopenReason}), '') <> '')`,
    ),
    check('bank_reconciliation_reopen_count_not_negative', sql`${t.reopenCount} >= 0`),
  ],
);

/**
 * §17 — *"automatic matching … with manual confirmation."*
 *
 * A suggestion and a confirmation are the same row in two states, so the
 * evidence the system offered and the decision a person made stay attached to
 * each other. Splitting them would lose the answer to *"why did we agree this?"*
 * the moment somebody clicked.
 */
export const bankReconciliationMatch = pgTable(
  'bank_reconciliation_match',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reconciliationId: uuid('reconciliation_id')
      .notNull()
      .references(() => bankReconciliation.id, { onDelete: 'cascade' }),
    matchNo: integer('match_no').notNull(),

    state: matchState('state').notNull().default('suggested'),
    /** 0–100. What the system thought of its own proposal. */
    confidence: smallint('confidence'),
    /** The evidence, in words: amount, reference, counterparty, days apart. */
    why: text('why'),

    /** True when the match exists because an adjustment was posted for it. */
    fromAdjustment: text('from_adjustment'),

    confirmedBy: uuid('confirmed_by').references(() => appUser.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_reconciliation_match_no_uniq').on(t.reconciliationId, t.matchNo),
    index('bank_reconciliation_match_state_idx').on(t.reconciliationId, t.state),

    check(
      'bank_reconciliation_match_confidence_range',
      sql`${t.confidence} is null or (${t.confidence} between 0 and 100)`,
    ),
    // §17 — a confirmation is somebody's, at a moment. Never one without the
    // other, and never a confirmed match with nobody behind it.
    check(
      'bank_reconciliation_match_confirmation_complete',
      sql`(${t.state} = 'confirmed') = (${t.confirmedBy} is not null and ${t.confirmedAt} is not null)`,
    ),
  ],
);

/**
 * One side of one match — a statement line, or a ledger entry, never both.
 *
 * Two nullable foreign keys with a check rather than a polymorphic pair, so the
 * database still knows what each row points at and *"which reconciliation used
 * this journal line?"* stays a join.
 */
export const bankReconciliationMatchLine = pgTable(
  'bank_reconciliation_match_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => bankReconciliationMatch.id, { onDelete: 'cascade' }),

    statementLineId: uuid('statement_line_id').references(() => bankStatementLine.id),
    journalLineId: uuid('journal_line_id').references(() => journalLine.id),

    /** Signed the same way on both sides: positive is money into the account. */
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
  },
  (t) => [
    index('bank_reconciliation_match_line_match_idx').on(t.matchId),
    // Neither side may be claimed twice — a statement line matched into two
    // reconciliations, or a journal line matched twice, would agree the same
    // money to two different things.
    uniqueIndex('bank_reconciliation_match_line_statement_uniq')
      .on(t.statementLineId)
      .where(sql`statement_line_id is not null`),
    uniqueIndex('bank_reconciliation_match_line_journal_uniq')
      .on(t.journalLineId)
      .where(sql`journal_line_id is not null`),

    check(
      'bank_reconciliation_match_line_one_side',
      sql`(${t.statementLineId} is not null and ${t.journalLineId} is null)
          or (${t.statementLineId} is null and ${t.journalLineId} is not null)`,
    ),
    check('bank_reconciliation_match_line_amount_not_zero', sql`${t.amountIqd} <> 0`),
  ],
);
