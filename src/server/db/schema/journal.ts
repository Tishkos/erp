/**
 * Journal Entry — Phase 02.5 and 02.6.
 *
 * §14.2 lists the header and line fields; they are here in that order, so the
 * table can be read against the blueprint page.
 *
 * The two guarantees that matter are not columns:
 *   · a journal balances in IQD  — a DEFERRED constraint trigger, because lines
 *     arrive one at a time and only the finished entry can be judged
 *   · a posted journal is immutable — §14.4: "A posted Journal Entry cannot be
 *     edited or deleted"
 * Both are in the migration, because neither can be expressed here.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  integer,
} from 'drizzle-orm/pg-core';
import { JOURNAL_SOURCES, JOURNAL_TYPES } from '../../domain/journal';
import { appUser, branch } from './platform';
import { documentStatus } from './workflow';
import { chartOfAccount } from './accounting';
import { exchangeRate, fiscalPeriod } from './fiscal';

/** §14.3 — Standard Journal is the only manual type. */
export const journalType = pgEnum('journal_type', JOURNAL_TYPES);

/** Manual entry, or the posting engine acting on a source document (§3.3). */
export const journalSource = pgEnum('journal_source', JOURNAL_SOURCES);

export const journalEntry = pgTable(
  'journal_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** §14.2 — "Generated automatically and never reused." From the 01.5 service. */
    entryNo: text('entry_no').notNull(),

    /** §24, A10 — business dates, distinct from system timestamps. */
    documentDate: date('document_date').notNull(),
    postingDate: date('posting_date').notNull(),

    /** Resolved once, at creation, so a later calendar change cannot move it. */
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriod.id),

    /** §14.3 — one branch per entry. On the header, so it cannot vary by line. */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    description: text('description'),
    journalType: journalType('journal_type').notNull().default('standard'),
    source: journalSource('source').notNull().default('manual'),

    status: documentStatus('status').notNull().default('draft'),

    /** Totals, maintained by trigger. The balance constraint reads them. */
    totalDebitIqd: numeric('total_debit_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    totalCreditIqd: numeric('total_credit_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    /**
     * §24 — the deterministic source reference that prevents duplicate posting.
     * Null for a manual journal; set by the posting engine (02.7) for every
     * journal it raises from an operational document.
     */
    sourceModule: text('source_module'),
    sourceDocId: text('source_doc_id'),
    sourceEvent: text('source_event'),

    /** §14.3 — full reversal only. Both directions, permanently linked (02.8). */
    reversesId: uuid('reverses_id'),
    reversedById: uuid('reversed_by_id'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('journal_entry_no_uniq').on(t.entryNo),
    index('journal_entry_posting_date_idx').on(t.postingDate, t.branchCode),
    index('journal_entry_status_idx').on(t.status, t.postingDate),

    // §24 / A5 — the same source event posts exactly once. Partial, so manual
    // journals (which have no source reference) are unaffected.
    uniqueIndex('journal_entry_source_uniq')
      .on(t.sourceModule, t.sourceDocId, t.sourceEvent)
      .where(sql`${t.sourceModule} is not null`),

    // A source reference is all three parts or none of them.
    check(
      'journal_entry_source_complete',
      sql`(${t.sourceModule} is null) = (${t.sourceDocId} is null)
          and (${t.sourceModule} is null) = (${t.sourceEvent} is null)`,
    ),

    // A manual journal has no source reference; an automatic one must have it.
    check(
      'journal_entry_source_matches_kind',
      sql`(${t.source} = 'manual') = (${t.sourceModule} is null)`,
    ),

    check('journal_entry_dates_ordered', sql`${t.postingDate} >= ${t.documentDate}`),
    check('journal_entry_totals_non_negative', sql`${t.totalDebitIqd} >= 0 and ${t.totalCreditIqd} >= 0`),

    // Posted means posted: the timestamp and the status cannot disagree.
    check(
      'journal_entry_posted_at_matches_status',
      sql`(${t.status} in ('posted','reversed')) = (${t.postedAt} is not null)`,
    ),
  ],
);

export const journalLine = pgTable(
  'journal_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id, { onDelete: 'cascade' }),
    lineNo: smallint('line_no').notNull(),

    /** §14.2 — G/L Account. */
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccount.id),

    /** §14.2 — Debit, Credit, in the transaction currency. */
    debitTxn: numeric('debit_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    creditTxn: numeric('credit_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    currency: char('currency', { length: 3 }).notNull(),

    /** §14.2 — IQD amount. The balancing figures. */
    debitIqd: numeric('debit_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    creditIqd: numeric('credit_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /** §14.2 — USD reporting equivalent, at the historical rate. */
    debitUsd: numeric('debit_usd', { precision: 19, scale: 4 }).notNull().default('0'),
    creditUsd: numeric('credit_usd', { precision: 19, scale: 4 }).notNull().default('0'),

    /** §24 — the rate rows used, so a reprint reproduces exactly (§22). */
    txnRateId: uuid('txn_rate_id').references(() => exchangeRate.id),
    usdRateId: uuid('usd_rate_id').references(() => exchangeRate.id),

    /** §14.2 — the dimension columns, and §4.2's seven. */
    branchCode: text('branch_code').references(() => branch.code),
    departmentCode: text('department_code'),
    businessLineCode: text('business_line_code'),
    projectCode: text('project_code'),
    warehouseCode: text('warehouse_code'),
    businessPartnerCode: text('business_partner_code'),
    employeeCode: text('employee_code'),

    /** §14.2 — Bank Account. Its master arrives in Phase 07. */
    bankAccountCode: text('bank_account_code'),

    /**
     * REQ-AP-001 §15.7 — the loan subledger's party: the loan a line on a
     * `loan` control account is against, as `bank_account_code` is the bank
     * subledger's. Migration 0235.
     */
    loanNo: text('loan_no'),

    lineDescription: text('line_description'),

    /**
     * §3.3 — "Each posting shall retain the source module, document and line
     * identifiers for complete drill-down."
     *
     * The header carries the module and document; the line carries the line.
     * Null on a manual journal, which has no source document to drill to.
     */
    sourceLineId: text('source_line_id'),

    /**
     * Which accounting mapping chose this account (§02.7 traceability gate).
     * Answers "why is this posting here?" with a row rather than an opinion.
     */
    postingRuleId: uuid('posting_rule_id'),

    /** What the line is, in the posting engine's terms: 'revenue', 'cogs', … */
    lineRole: text('line_role'),
  },
  (t) => [
    uniqueIndex('journal_line_no_uniq').on(t.journalEntryId, t.lineNo),
    index('journal_line_account_idx').on(t.accountId),
    index('journal_line_partner_idx').on(t.businessPartnerCode),

    // Exactly one side carries a value, and it is positive.
    check(
      'journal_line_one_side_txn',
      sql`(${t.debitTxn} > 0 and ${t.creditTxn} = 0) or (${t.creditTxn} > 0 and ${t.debitTxn} = 0)`,
    ),
    check(
      'journal_line_one_side_iqd',
      sql`(${t.debitIqd} > 0 and ${t.creditIqd} = 0) or (${t.creditIqd} > 0 and ${t.debitIqd} = 0)`,
    ),
    // The IQD side follows the transaction side. Without this a journal could
    // balance while meaning the opposite of what was entered.
    check(
      'journal_line_sides_agree',
      sql`(${t.debitTxn} > 0) = (${t.debitIqd} > 0)`,
    ),
    check(
      'journal_line_amounts_non_negative',
      sql`${t.debitTxn} >= 0 and ${t.creditTxn} >= 0 and ${t.debitIqd} >= 0
          and ${t.creditIqd} >= 0 and ${t.debitUsd} >= 0 and ${t.creditUsd} >= 0`,
    ),
    check('journal_line_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('journal_line_no_positive', sql`${t.lineNo} >= 1`),
  ],
);
