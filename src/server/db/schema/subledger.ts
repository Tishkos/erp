/**
 * Subledger framework — Phase 02.9.
 *
 * §1.2: "The system shall maintain detailed customer, supplier, inventory,
 * fixed-asset, bank, project and service subledgers that reconcile to the
 * General Ledger."
 *
 * One table, not seven. A customer subledger and a bank subledger differ in
 * what the party *is*, not in how the entries behave: both are append-only
 * movements against a control account, and both must total to that account's
 * G/L balance. Seven tables would be seven chances for one of them to drift.
 *
 * §24: "Posted journals and subledger entries are append-only." · "Balances are
 * derived from immutable entries or controlled balance tables that reconcile to
 * them." There is no balance column here on purpose — a balance is a sum of
 * these rows, so it cannot disagree with them.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { branch } from './platform';
import { chartOfAccount, controlAccountKind } from './accounting';
import { journalEntry, journalLine } from './journal';

export const subledgerEntry = pgTable(
  'subledger_entry',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),

    /** Which subledger this belongs to — the same seven §1.2 names. */
    subledgerType: controlAccountKind('subledger_type').notNull(),

    /**
     * Who or what the entry is against: a customer code, a supplier code, a
     * warehouse, a bank account. Text rather than a foreign key because the
     * masters arrive across Phases 03, 04, 07, 11 and 12 — the framework must
     * not wait for the last of them.
     */
    partyCode: text('party_code').notNull(),

    /** The G/L account this subledger reconciles to (§1.2). */
    controlAccountId: uuid('control_account_id')
      .notNull()
      .references(() => chartOfAccount.id),

    /** Written in the same transaction as the journal — never separately. */
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id),
    journalLineId: uuid('journal_line_id')
      .notNull()
      .references(() => journalLine.id),

    postingDate: date('posting_date').notNull(),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    currency: char('currency', { length: 3 }).notNull(),
    debitTxn: numeric('debit_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    creditTxn: numeric('credit_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    debitIqd: numeric('debit_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    creditIqd: numeric('credit_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    debitUsd: numeric('debit_usd', { precision: 19, scale: 4 }).notNull().default('0'),
    creditUsd: numeric('credit_usd', { precision: 19, scale: 4 }).notNull().default('0'),

    /** §3.3 — drill-down back to the operational document. */
    sourceModule: text('source_module'),
    sourceDocId: text('source_doc_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subledger_entry_party_idx').on(t.subledgerType, t.partyCode, t.postingDate),
    index('subledger_entry_control_idx').on(t.controlAccountId, t.postingDate),
    index('subledger_entry_journal_idx').on(t.journalEntryId),

    // One line produces at most one subledger entry, so a reconciliation can
    // never double-count a movement.
    index('subledger_entry_line_idx').on(t.journalLineId),

    check(
      'subledger_entry_one_side',
      sql`(${t.debitIqd} > 0 and ${t.creditIqd} = 0) or (${t.creditIqd} > 0 and ${t.debitIqd} = 0)`,
    ),
    check('subledger_entry_party_present', sql`btrim(${t.partyCode}) <> ''`),
  ],
);
