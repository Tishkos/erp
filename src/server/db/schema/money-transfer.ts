/**
 * Money Transfer — Phase 09.2 to 09.9, §12.
 *
 * ── The one rule this file exists to make unrepresentable ───────────────────
 * §12.3: *"After Initiate Transfer creates the transfer entry, the transaction
 * is locked. Correction requires full reversal and a new transaction."* §12.7
 * makes it an acceptance criterion in its own right. It is enforced by a trigger
 * in the migration that compares the whole row rather than a list of columns, so
 * a field added to this table in a later phase is locked from the moment it
 * exists. A lock that has to be remembered is not a lock.
 *
 * ── Rates are referenced, never typed ───────────────────────────────────────
 * §14.3: *"Rates are maintained only in the Finance Exchange Rate section."*
 * The transfer points at two `exchange_rate` rows — the `accounting` rate (§12.2's
 * "official") and the `client` rate — and carries a snapshot of each that a
 * trigger writes *from* those rows. Whatever a caller supplies in the snapshot
 * columns is overwritten. So the value on the document cannot disagree with the
 * published rate, and it cannot be edited into agreement with something else.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { exchangeRate } from './fiscal';
import { bankCashAccount } from './item';
import { moneyTransferClientAccount } from './money-transfer-client';
import { clientImportFile } from './client-import';

// ---------------------------------------------------------------------------
// 09.2 — client deposits
// ---------------------------------------------------------------------------

/**
 * §12.3, verbatim: *"by cash deposit into the company bank account or by bank
 * transfer"*. Two ways, and the blueprint names both. An enum rather than free
 * text so a third cannot appear without someone deciding it should.
 */
export const clientDepositMethod = pgEnum('client_deposit_method', ['cash', 'bank_transfer']);

export const moneyTransferDeposit = pgTable(
  'money_transfer_deposit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    depositNo: text('deposit_no').notNull(),

    /** §12.3 — *"one or several partial deposits"*, all against one account. */
    clientAccountId: uuid('client_account_id')
      .notNull()
      .references(() => moneyTransferClientAccount.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * Appendix B gives Draft, Posted, Available, Partially Used, Used, Refunded,
     * Reversed. Mapped onto §3.2's vocabulary:
     *
     *   draft               Draft
     *   posted              Posted *and* Available
     *   partially_executed  Partially Used
     *   settled             Used
     *   closed              Refunded
     *   reversed            Reversed
     *
     * Posted and Available collapse into one state because §12.3 admits only
     * cash paid into the company account and bank transfers received — both are
     * cleared funds by the time they are recorded, so there is no moment at
     * which the money has reached client clearing and is not yet usable. If
     * Finance means something narrower by "Available" (uncleared cheques, a
     * compliance hold), that is a business decision and is raised in
     * docs/open-questions-phase-09.md rather than guessed at here.
     */
    status: documentStatus('status').notNull().default('draft'),

    /** §12.2 — *"Actual IQD deposits and deposit dates."* */
    depositDate: date('deposit_date').notNull(),
    method: clientDepositMethod('method').notNull(),

    /** §12.4 — the deposit is debited to the Company Bank Account. */
    companyBankAccountId: uuid('company_bank_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /** Maintained from the usage history below, never set directly. */
    usedAmountIqd: numeric('used_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    refundedAmountIqd: numeric('refunded_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    /** The bank slip or transfer reference the money arrived with. */
    bankReference: text('bank_reference'),
    note: text('note'),

    /** §12.4 — Dr Company Bank Account / Cr Client Clearing. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('money_transfer_deposit_no_uniq').on(t.depositNo),
    index('money_transfer_deposit_account_idx').on(t.clientAccountId, t.status),
    index('money_transfer_deposit_date_idx').on(t.depositDate, t.branchCode),

    check('money_transfer_deposit_amount_positive', sql`${t.amountIqd} > 0`),
    check('money_transfer_deposit_used_non_negative', sql`${t.usedAmountIqd} >= 0`),
    check('money_transfer_deposit_refunded_non_negative', sql`${t.refundedAmountIqd} >= 0`),

    // 09.2 gate — the clearing balance is deposits less usage, so usage can
    // reach the deposit and never pass it. Bounded together because a transfer
    // and a refund draw on the same money.
    check(
      'money_transfer_deposit_not_over_used',
      sql`${t.usedAmountIqd} + ${t.refundedAmountIqd} <= ${t.amountIqd}`,
    ),
    check(
      'money_transfer_deposit_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 09.4 / 09.5 — the transfer instruction
// ---------------------------------------------------------------------------

export const moneyTransfer = pgTable(
  'money_transfer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transferNo: text('transfer_no').notNull(),

    /**
     * Appendix B: Draft, Funded, Initiated, Sent, Completed, Returned, Refunded,
     * Reversed — carried on §3.2's vocabulary. The mapping and the reasoning are
     * in `src/server/domain/money-transfer.ts`; it is stated once, there, so the
     * database and the domain cannot come to hold different versions of it.
     */
    status: documentStatus('status').notNull().default('draft'),

    /** §12.2 element 1 — the client, through their account. */
    clientAccountId: uuid('client_account_id')
      .notNull()
      .references(() => moneyTransferClientAccount.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    transferDate: date('transfer_date').notNull(),

    /**
     * §12.2 element 2 — *"Requested USD equivalent for pricing and reference."*
     *
     * 09.4 gate: *"the requested USD equivalent is stored for reference and does
     * not become the ledger amount"*. Nothing posts from this column; the ledger
     * amount is `transfer_amount_iqd` below (§1.1 — IQD is the ledger currency).
     */
    requestedUsd: numeric('requested_usd', { precision: 19, scale: 4 }).notNull(),

    /**
     * §12.2 element 3 — the two rates, as references to published Phase 02 rows.
     * `official` is Phase 02's `accounting` rate type; `client` is its `client`
     * type, which §4.3 created for exactly this (§12 money transfer pricing).
     */
    officialRateId: uuid('official_rate_id')
      .notNull()
      .references(() => exchangeRate.id),
    clientRateId: uuid('client_rate_id')
      .notNull()
      .references(() => exchangeRate.id),

    /**
     * The historical snapshot §22 requires so a reprint reproduces. Written by
     * trigger from the two rate rows above — never by a caller, which is how
     * 09.3's *"rates cannot be edited on the transfer document itself"* is made
     * true rather than merely asked for.
     */
    officialRateIqdPerUsd: numeric('official_rate_iqd_per_usd', { precision: 18, scale: 8 })
      .notNull()
      .default('0'),
    clientRateIqdPerUsd: numeric('client_rate_iqd_per_usd', { precision: 18, scale: 8 })
      .notNull()
      .default('0'),

    /** §12.2 element 5 — and §1.1: this is the ledger amount. */
    transferAmountIqd: numeric('transfer_amount_iqd', { precision: 19, scale: 4 }).notNull(),
    companyBankAccountId: uuid('company_bank_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    beneficiaryName: text('beneficiary_name').notNull(),
    beneficiaryBank: text('beneficiary_bank'),
    beneficiaryAccount: text('beneficiary_account'),
    beneficiaryCountry: text('beneficiary_country'),
    /** Known when the bank executes; required to move to Sent (trigger). */
    bankReference: text('bank_reference'),

    /**
     * §12.2 element 7 — *"Related Client Import File and Logistics Job where the
     * approved process requires it."* Both optional, because "where required" is
     * the blueprint's own qualifier.
     *
     * The logistics job is text and not a foreign key: the Logistics module is
     * Phase 10 and its table does not exist yet. Same reasoning `subledger_entry`
     * gives for `party_code` — the framework must not wait for the last master to
     * arrive. Phase 10 adds the constraint when there is something to point at.
     */
    clientImportFileId: uuid('client_import_file_id').references(() => clientImportFile.id),
    logisticsJobRef: text('logistics_job_ref'),

    /** §12.4 — Dr Client Clearing / Cr Company Bank Account, at initiation. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    initiatedBy: uuid('initiated_by').references(() => appUser.id),
    initiatedAt: timestamp('initiated_at', { withTimezone: true }),

    sentBy: uuid('sent_by').references(() => appUser.id),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => appUser.id),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    /**
     * §12.6 — the return. The reversing journal is held here and the permanent
     * link between it and the original is Phase 02's (`journal_entry.reverses_id`,
     * migration 0023), so this module does not re-implement it.
     */
    returnedBy: uuid('returned_by').references(() => appUser.id),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnReason: text('return_reason'),
    returnJournalEntryId: uuid('return_journal_entry_id').references(() => journalEntry.id),

    /** §12.6 — *"The client receives a full refund."* */
    refundedBy: uuid('refunded_by').references(() => appUser.id),
    refundedAt: timestamp('refunded_at', { withTimezone: true }),
    refundAmountIqd: numeric('refund_amount_iqd', { precision: 19, scale: 4 }),
    refundJournalEntryId: uuid('refund_journal_entry_id').references(() => journalEntry.id),

    /**
     * §12.6 — *"The system reverses the transfer **and recognised service
     * result**."* The recognition is an explicit act by Finance, bounded by the
     * computed Net Service Margin; how much and when is policy (§22 — *"according
     * to finance policy"*), so the amount is supplied rather than assumed.
     */
    recognisedResultIqd: numeric('recognised_result_iqd', { precision: 19, scale: 4 }),
    recognitionJournalEntryId: uuid('recognition_journal_entry_id').references(
      () => journalEntry.id,
    ),
    recognisedBy: uuid('recognised_by').references(() => appUser.id),
    recognisedAt: timestamp('recognised_at', { withTimezone: true }),

    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    /** §12.3 — the new transaction that replaces a reversed one. */
    replacedByTransferId: uuid('replaced_by_transfer_id').references((): any => moneyTransfer.id),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('money_transfer_no_uniq').on(t.transferNo),
    index('money_transfer_account_idx').on(t.clientAccountId, t.status),
    index('money_transfer_date_idx').on(t.transferDate, t.branchCode),
    index('money_transfer_import_file_idx').on(t.clientImportFileId),
    index('money_transfer_logistics_idx').on(t.logisticsJobRef),

    check('money_transfer_requested_usd_positive', sql`${t.requestedUsd} > 0`),
    check('money_transfer_amount_positive', sql`${t.transferAmountIqd} > 0`),
    check('money_transfer_beneficiary_present', sql`btrim(${t.beneficiaryName}) <> ''`),
    check(
      'money_transfer_rates_positive',
      sql`${t.officialRateIqdPerUsd} > 0 and ${t.clientRateIqdPerUsd} > 0`,
    ),
    // The two rates are different published rows: pointing both at the same row
    // would report a spread of zero on a transfer that priced one.
    check('money_transfer_rates_distinct', sql`${t.officialRateId} <> ${t.clientRateId}`),

    check('money_transfer_refund_positive', sql`${t.refundAmountIqd} is null or ${t.refundAmountIqd} > 0`),
    check(
      'money_transfer_return_has_reason',
      sql`(${t.returnedBy} is null and ${t.returnedAt} is null)
          or (${t.returnedBy} is not null and ${t.returnedAt} is not null
              and coalesce(btrim(${t.returnReason}), '') <> '')`,
    ),
    check(
      'money_transfer_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
    check(
      'money_transfer_recognition_complete',
      sql`(${t.recognisedResultIqd} is null and ${t.recognitionJournalEntryId} is null
           and ${t.recognisedBy} is null and ${t.recognisedAt} is null)
          or (${t.recognisedResultIqd} is not null and ${t.recognisedBy} is not null
              and ${t.recognisedAt} is not null)`,
    ),
  ],
);

/**
 * Which deposit funded which transfer — the middle of the 09.8 drill-down
 * *"client → case → deposit → settlement → journal"*.
 *
 * A running total on the deposit would answer "how much is left" but not "left
 * after what", and Appendix B's Partially Used status is meaningless without the
 * second answer. The totals on `money_transfer_deposit` are maintained from
 * these rows, so they cannot disagree with them.
 */
export const moneyTransferDepositUsage = pgTable(
  'money_transfer_deposit_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    depositId: uuid('deposit_id')
      .notNull()
      .references(() => moneyTransferDeposit.id),
    moneyTransferId: uuid('money_transfer_id')
      .notNull()
      .references(() => moneyTransfer.id),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    appliedOn: date('applied_on').notNull(),

    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live application of a deposit to a transfer. A second would consume
    // the same client money twice, which is the failure the whole segregation
    // model exists to prevent.
    uniqueIndex('money_transfer_deposit_usage_pair_uniq')
      .on(t.depositId, t.moneyTransferId)
      .where(sql`reversed_at is null`),
    index('money_transfer_deposit_usage_transfer_idx').on(t.moneyTransferId),
    check('money_transfer_deposit_usage_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'money_transfer_deposit_usage_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 09.7 — bank fees and direct expenses
// ---------------------------------------------------------------------------

/** §12.2 — *"Direct bank charges and other transfer expenses."* Exactly two kinds. */
export const moneyTransferExpenseType = pgEnum('money_transfer_expense_type', [
  'bank_charge',
  'other',
]);

/**
 * §12.4 — Dr Bank Fees / Money Transfer Direct Expense, Cr Company Bank Account.
 *
 * 09.7 gate: *"An unlinked fee cannot be posted to the Money Transfer expense
 * account."* `money_transfer_id` is NOT NULL, so an unlinked fee has nowhere to
 * exist. Appendix C's *"linked to transfer"* is the column, not a rule.
 *
 * Expenses stay addable after the transfer locks, and deliberately: the bank
 * charges after it executes, so a lock that froze them too would make the real
 * cost of a transfer permanently unrecordable. The lock in §12.3 is on the
 * *instruction*; an expense is its own document with its own posting and its own
 * reversal, which is why it can be one.
 */
export const moneyTransferExpense = pgTable(
  'money_transfer_expense',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expenseNo: text('expense_no').notNull(),

    moneyTransferId: uuid('money_transfer_id')
      .notNull()
      .references(() => moneyTransfer.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    status: documentStatus('status').notNull().default('draft'),

    expenseDate: date('expense_date').notNull(),
    expenseType: moneyTransferExpenseType('expense_type').notNull(),
    description: text('description'),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /**
     * Who bears it. No default, on purpose: §12.6 makes the company absorb all
     * bank charges on a returned transfer, so the answer changes the client's
     * refund. A default would let silence decide it, and silence is not a
     * decision anybody could be shown to have made.
     */
    chargedToClient: boolean('charged_to_client').notNull(),

    companyBankAccountId: uuid('company_bank_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('money_transfer_expense_no_uniq').on(t.expenseNo),
    index('money_transfer_expense_transfer_idx').on(t.moneyTransferId, t.status),
    index('money_transfer_expense_date_idx').on(t.expenseDate, t.branchCode),

    check('money_transfer_expense_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'money_transfer_expense_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);
