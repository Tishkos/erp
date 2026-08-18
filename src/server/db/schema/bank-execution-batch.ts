/**
 * Bank Execution Batch — Phase 09.6, §12.5.
 *
 * > *"One bank debit can combine several internally separate transactions, such
 * > as a client transfer and a company import payment. Bank Execution Batch shall
 * > contain separate source lines that retain their own document, client/vendor,
 * > branch, cost centre, accounting and margin. The batch total shall reconcile
 * > to the single bank-statement amount."*
 *
 * The phase notes call this the single most bespoke mechanism in the blueprint,
 * and the reason is the word *separate*. The bank sees one debit; the ledger must
 * see several unrelated transactions. A design that posted the batch would
 * destroy that separation at the moment of posting, so **the batch posts
 * nothing**. Each line carries its own journal entry, its own counterparty, its
 * own branch and cost centre and its own margin; the batch is the grouping that
 * ties them to one bank movement and nothing more.
 *
 * That is also what makes the 09.6 gate *"reversing one line does not corrupt
 * the others"* true by construction rather than by care: there is no shared
 * journal to corrupt.
 *
 * ── Where the total comes from ──────────────────────────────────────────────
 * `total_iqd` is the amount the **bank** debited, taken from the bank advice —
 * not a sum this system computes. If it were computed it could never disagree
 * with the lines, and §12.7's *"lines sum exactly to the bank execution total"*
 * would be a tautology instead of a control. Execution is refused while the two
 * differ, which is the only arrangement in which the check can ever catch
 * anything.
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
import { appUser, branch } from './platform';
import { businessPartner, costCentre } from './organisation';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { bankCashAccount } from './item';
import { moneyTransfer } from './money-transfer';
import { clientImportPayment } from './client-import';
import { bankStatementLine } from './bank-statement';

export const bankExecutionBatch = pgTable(
  'bank_execution_batch',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchNo: text('batch_no').notNull(),

    /**
     * Appendix B: Draft, Approved, Executed, Reconciled, Reversed.
     *
     *   draft     Draft
     *   approved  Approved — the composition is agreed, the bank has not paid
     *   executed  Executed — the bank has debited the account
     *   settled   Reconciled — matched to one bank statement line (Phase 07.7)
     *   reversed  Reversed
     */
    status: documentStatus('status').notNull().default('draft'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** §12.5 — *one* bank debit, so one bank account. */
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),

    executionDate: date('execution_date').notNull(),

    /** The single amount the bank debited, from the bank advice. */
    totalIqd: numeric('total_iqd', { precision: 19, scale: 4 }).notNull(),
    bankReference: text('bank_reference'),

    /**
     * §12.5 — *"The batch total shall reconcile to the single bank-statement
     * amount."*
     *
     * This was text until 2026-08-18, because Phase 07.7 did not exist on the
     * branch Phase 09 was built on. It does now, and §12.7's acceptance criterion
     * — Transfer-to-Bank Statement Reconciliation — turns on the reference being
     * *right*, which a text column cannot promise: nothing stopped it naming a
     * line on another account, or none at all.
     *
     * `bank_execution_batch_line_is_same_account` checks both halves of §12.5:
     * the line belongs to this batch's bank account, and its amount equals the
     * batch total **exactly**. Not a tolerance — the blueprint's word is "shall".
     */
    statementLineId: uuid('statement_line_id').references(() => bankStatementLine.id),
    reconciledBy: uuid('reconciled_by').references(() => appUser.id),
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),

    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    executedBy: uuid('executed_by').references(() => appUser.id),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_execution_batch_no_uniq').on(t.batchNo),
    index('bank_execution_batch_account_idx').on(t.bankCashAccountId, t.executionDate),
    index('bank_execution_batch_status_idx').on(t.status, t.executionDate),
    // One statement line matches one batch: §12.5's whole purpose is that the
    // bank's single movement has a single explanation on this side.
    uniqueIndex('bank_execution_batch_statement_uniq')
      .on(t.statementLineId)
      .where(sql`statement_line_id is not null and reversed_at is null`),

    check('bank_execution_batch_total_positive', sql`${t.totalIqd} > 0`),
    check(
      'bank_execution_batch_reconciliation_complete',
      sql`(${t.reconciledAt} is null and ${t.reconciledBy} is null)
          or (${t.reconciledAt} is not null and ${t.reconciledBy} is not null
              and ${t.statementLineId} is not null)`,
    ),
    check(
      'bank_execution_batch_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

/**
 * §12.5 — *"separate source lines that retain their own document, client/vendor,
 * branch, cost centre, accounting and margin."*
 *
 * All six are columns here, and each is on the line rather than the batch. The
 * branch in particular: §12.5's own example combines a client transfer with a
 * company import payment, and there is no reason those share a branch. A batch
 * whose lines inherited the header's branch would silently move one of them.
 */
export const bankExecutionBatchLine = pgTable(
  'bank_execution_batch_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => bankExecutionBatch.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /**
     * The source document. Exactly one of the two references is set — the CHECK
     * below says so — and `source_document_type` names which, so a report can
     * group by kind without knowing every kind.
     *
     * Two typed references rather than one polymorphic (type, id) pair, because
     * a polymorphic reference cannot be a foreign key, and a batch line pointing
     * at a deleted or non-existent document is precisely the corruption §12.5
     * exists to prevent.
     */
    sourceDocumentType: text('source_document_type').notNull(),
    moneyTransferId: uuid('money_transfer_id').references(() => moneyTransfer.id),
    clientImportPaymentId: uuid('client_import_payment_id').references(
      () => clientImportPayment.id,
    ),

    /** §12.5 — *"client/vendor"*. The client on a transfer; the vendor on a payment. */
    counterpartyPartnerId: uuid('counterparty_partner_id').references(() => businessPartner.id),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /**
     * §12.5 — *"their own … accounting"*. One journal per line, never one per
     * batch: the accounting separation the section demands is exactly this
     * column being on the line.
     */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    /**
     * §12.5 — *"their own … margin"*. Recorded on the line as at execution, so
     * the batch reconciliation can show what each transaction contributed
     * without recomputing six months of rates.
     */
    marginIqd: numeric('margin_iqd', { precision: 19, scale: 4 }),

    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntry.id),

    note: text('note'),
  },
  (t) => [
    uniqueIndex('bank_execution_batch_line_no_uniq').on(t.batchId, t.lineNo),
    index('bank_execution_batch_line_transfer_idx').on(t.moneyTransferId),
    index('bank_execution_batch_line_payment_idx').on(t.clientImportPaymentId),
    index('bank_execution_batch_line_partner_idx').on(t.counterpartyPartnerId),

    // A batch line is one document's share of one bank debit. Naming none of
    // them leaves company money unexplained; naming two makes the share
    // ambiguous, and §12.5's separation depends on it not being.
    check(
      'bank_execution_batch_line_one_source',
      sql`num_nonnulls(${t.moneyTransferId}, ${t.clientImportPaymentId}) = 1`,
    ),
    check('bank_execution_batch_line_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'bank_execution_batch_line_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);
