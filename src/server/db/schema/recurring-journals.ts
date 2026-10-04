/**
 * Recurring Journals — REQ-ACC-001 Part D-7, migration 0291.
 *
 * A template that raises the same draft journal on a schedule. It never
 * posts: each journal it raises is an ordinary draft through `journal.ts`,
 * approved and posted as any other. The run table holds one row per template
 * and due date, so the same month is never raised twice.
 */
import { sql } from 'drizzle-orm';
import { check, date, index, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { chartOfAccount } from './accounting';
import { journalEntry } from './journal';
import { appUser, branch, department } from './platform';

export const RECURRING_FREQUENCIES = ['monthly', 'quarterly', 'yearly'] as const;
export const RECURRING_STATUSES = ['draft', 'active', 'paused', 'ended'] as const;

export const recurringJournal = pgTable(
  'recurring_journal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateNo: text('template_no').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    frequency: text('frequency').notNull(),
    intervalCount: smallint('interval_count').notNull().default(1),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on'),
    /** The next date a journal is due; null once the schedule has run out. */
    nextDueOn: date('next_due_on'),
    status: text('status').notNull().default('draft'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    activatedBy: uuid('activated_by').references(() => appUser.id),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    endedBy: uuid('ended_by').references(() => appUser.id),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
  },
  (t) => [
    uniqueIndex('recurring_journal_no_uniq').on(t.templateNo),
    index('recurring_journal_due_idx').on(t.status, t.nextDueOn),
    check('recurring_journal_frequency', sql`${t.frequency} in ('monthly', 'quarterly', 'yearly')`),
    check('recurring_journal_interval', sql`${t.intervalCount} between 1 and 12`),
    check('recurring_journal_status', sql`${t.status} in ('draft', 'active', 'paused', 'ended')`),
    check('recurring_journal_dates', sql`${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`),
  ],
);

export const recurringJournalLine = pgTable(
  'recurring_journal_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recurringJournalId: uuid('recurring_journal_id')
      .notNull()
      .references(() => recurringJournal.id, { onDelete: 'cascade' }),
    lineNo: smallint('line_no').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccount.id),
    debit: numeric('debit', { precision: 19, scale: 4 }).notNull().default('0'),
    credit: numeric('credit', { precision: 19, scale: 4 }).notNull().default('0'),
    departmentCode: text('department_code').references(() => department.code),
    description: text('description'),
  },
  (t) => [
    uniqueIndex('recurring_journal_line_no_uniq').on(t.recurringJournalId, t.lineNo),
    check('recurring_journal_line_one_side', sql`(${t.debit} > 0 and ${t.credit} = 0) or (${t.credit} > 0 and ${t.debit} = 0)`),
  ],
);

export const recurringJournalRun = pgTable(
  'recurring_journal_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recurringJournalId: uuid('recurring_journal_id')
      .notNull()
      .references(() => recurringJournal.id),
    dueOn: date('due_on').notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id),
    raisedBy: uuid('raised_by')
      .notNull()
      .references(() => appUser.id),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recurring_journal_run_due_uniq').on(t.recurringJournalId, t.dueOn),
    uniqueIndex('recurring_journal_run_journal_uniq').on(t.journalEntryId),
  ],
);
