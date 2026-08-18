/**
 * Posting engine tables — Phase 02.7.
 *
 * §3.3: "Posting accounts shall be selected through configurable accounting
 * mappings, not hard-coded account numbers."
 *
 * `posting_rule` is that mapping. It is the reason no module in this system
 * ever names an account: a module says what happened, and this table says which
 * account that is.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser } from './platform';
import { chartOfAccount } from './accounting';

export const postingRule = pgTable(
  'posting_rule',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The business event, e.g. 'sales_invoice.posted'. */
    eventType: text('event_type').notNull(),
    /** What the line is: 'revenue', 'receivable', 'inventory', 'cogs', … */
    lineRole: text('line_role').notNull(),

    /**
     * §3.3's discriminators. Null means "any" — so a chart starts with one
     * general rule per role and grows exceptions above it, without either
     * knowing about the other.
     */
    itemGroup: text('item_group'),
    partnerGroup: text('partner_group'),
    warehouseCode: text('warehouse_code'),
    projectCode: text('project_code'),
    branchCode: text('branch_code'),

    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccount.id),

    isActive: boolean('is_active').notNull().default(true),
    description: text('description'),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same event, role and criteria may not be mapped twice: that is the
    // ambiguity the resolver refuses, caught at configuration time instead.
    uniqueIndex('posting_rule_criteria_uniq').on(
      t.eventType,
      t.lineRole,
      sql`coalesce(${t.itemGroup}, '')`,
      sql`coalesce(${t.partnerGroup}, '')`,
      sql`coalesce(${t.warehouseCode}, '')`,
      sql`coalesce(${t.projectCode}, '')`,
      sql`coalesce(${t.branchCode}, '')`,
    ),
    index('posting_rule_lookup_idx').on(t.eventType, t.lineRole),
  ],
);

/**
 * §24 — the failed-posting queue.
 *
 * "Failed postings land in the failed-posting queue with a root cause and can
 * be reprocessed." Written on its own connection, because the posting
 * transaction that failed is being rolled back and a row written inside it
 * would roll back too — leaving a failure nobody can see. Same reasoning as the
 * refused-request audit in 01.4.
 */
export const postingFailure = pgTable(
  'posting_failure',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),

    eventType: text('event_type').notNull(),
    sourceModule: text('source_module').notNull(),
    sourceDocId: text('source_doc_id').notNull(),
    sourceEvent: text('source_event').notNull(),

    /** The request as received, so it can be replayed exactly. */
    request: jsonb('request').notNull(),

    /** The root cause, kept apart so failures can be grouped by kind. */
    errorCode: text('error_code').notNull(),
    errorMessage: text('error_message').notNull(),

    attemptedBy: uuid('attempted_by').references(() => appUser.id),
    branchCode: text('branch_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    retryCount: integer('retry_count').notNull().default(0),
    /** Set when a replay succeeded, with the journal it produced. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedJournalId: uuid('resolved_journal_id'),
  },
  (t) => [
    index('posting_failure_source_idx').on(t.sourceModule, t.sourceDocId, t.sourceEvent),
    index('posting_failure_open_idx').on(t.occurredAt).where(sql`${t.resolvedAt} is null`),
  ],
);

/**
 * §24 — the posting log.
 *
 * One row per successful posting, recording what produced what. The journal
 * itself carries the source reference; this is the operational view: how long
 * it took, who triggered it, which event it was.
 */
export const postingLog = pgTable(
  'posting_log',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    eventType: text('event_type').notNull(),
    sourceModule: text('source_module').notNull(),
    sourceDocId: text('source_doc_id').notNull(),
    sourceEvent: text('source_event').notNull(),
    journalEntryId: uuid('journal_entry_id').notNull(),
    /** True when the request was a replay that found the journal already there. */
    wasDuplicate: boolean('was_duplicate').notNull().default(false),
    postedBy: uuid('posted_by').references(() => appUser.id),
    branchCode: text('branch_code'),
    durationMs: integer('duration_ms'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('posting_log_source_idx').on(t.sourceModule, t.sourceDocId, t.sourceEvent),
    index('posting_log_event_idx').on(t.eventType, t.occurredAt),
    check('posting_log_duration_non_negative', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
  ],
);
