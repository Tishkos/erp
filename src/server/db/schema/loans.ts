/**
 * Payables — REQ-AP-001 Stage 6, loans (§15.7). Migration 0235.
 *
 * **One register for every lender.** A loan names its bank, the account its
 * proceeds land in (and its repayments leave from), the commission and how
 * the bank takes it, and a schedule. It moves
 *
 *     draft ──approve──▶ approved ──disburse──▶ active ──last instalment paid──▶ fully_repaid
 *       └──────── cancel (reason) ────┘
 *
 * The disbursement and every repayment post through the existing journal; the
 * liability sits on a `loan` control account whose subledger party is the
 * loan number (`journal_line.loan_no`), so it reconciles as AP does.
 *
 * **Allocations** say which payment applications the loan funded. The
 * commission share of each — commission × allocated / principal by default —
 * is a `bank_commission` landed-cost charge of the import it paid (D5).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { bank, bankCashAccount } from './item';
import { exchangeRate } from './fiscal';
import { journalEntry } from './journal';
import { payable } from './payables';
import { paymentApplication } from './payments';
import { landedCostCharge } from './payables-contracts';

export const loanCommissionTreatment = pgTable(
  'loan_commission_treatment',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    deducted: boolean('deducted').notNull().default(false),
    spread: boolean('spread').notNull().default(false),
    sortOrder: smallint('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
  },
  (t) => [check('loan_commission_treatment_one_way', sql`not (${t.deducted} and ${t.spread})`)],
);

export const bankLoan = pgTable(
  'bank_loan',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanNo: text('loan_no').notNull(),
    bankCode: text('bank_code')
      .notNull()
      .references(() => bank.code),
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    currency: char('currency', { length: 3 }).notNull(),
    principalTxn: numeric('principal_txn', { precision: 19, scale: 4 }).notNull(),
    principalIqd: numeric('principal_iqd', { precision: 19, scale: 4 }).notNull(),
    rateId: uuid('rate_id').references(() => exchangeRate.id),

    commissionPct: numeric('commission_pct', { precision: 9, scale: 4 }).notNull().default('0'),
    commissionTxn: numeric('commission_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    commissionTreatmentCode: text('commission_treatment_code')
      .notNull()
      .references(() => loanCommissionTreatment.code),
    commissionCapitalised: boolean('commission_capitalised').notNull().default(true),
    interestPctPa: numeric('interest_pct_pa', { precision: 9, scale: 4 }),
    netProceedsTxn: numeric('net_proceeds_txn', { precision: 19, scale: 4 }).notNull(),
    allocationMethod: text('allocation_method').notNull().default('by_amount_used'),

    instalmentCount: smallint('instalment_count').notNull(),
    frequency: text('frequency').notNull(),
    firstDueDate: date('first_due_date', { mode: 'string' }).notNull(),
    maturityDate: date('maturity_date', { mode: 'string' }),
    disbursementDate: date('disbursement_date', { mode: 'string' }),
    disbursementReference: text('disbursement_reference'),
    disbursementJournalEntryId: uuid('disbursement_journal_entry_id').references(() => journalEntry.id),
    commissionPaidOn: date('commission_paid_on', { mode: 'string' }),
    commissionReference: text('commission_reference'),
    commissionJournalEntryId: uuid('commission_journal_entry_id').references(() => journalEntry.id),

    status: text('status').notNull().default('draft'),
    purpose: text('purpose'),
    closedReason: text('closed_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    activatedBy: uuid('activated_by').references(() => appUser.id),
    activatedAt: timestamp('activated_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => appUser.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_loan_no_uniq').on(t.loanNo),
    index('bank_loan_account_idx').on(t.bankCashAccountId),
    index('bank_loan_status_idx').on(t.status),
  ],
);

export const bankLoanInstalment = pgTable(
  'bank_loan_instalment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => bankLoan.id),
    sequence: smallint('sequence').notNull(),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    principalTxn: numeric('principal_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    commissionTxn: numeric('commission_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    interestTxn: numeric('interest_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    totalTxn: numeric('total_txn', { precision: 19, scale: 4 }).notNull(),
    status: text('status').notNull().default('upcoming'),
    paidDate: date('paid_date', { mode: 'string' }),
    paidReference: text('paid_reference'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    paidBy: uuid('paid_by').references(() => appUser.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references(() => appUser.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_loan_instalment_live_uniq')
      .on(t.loanId, t.sequence)
      .where(sql`${t.supersededAt} is null`),
  ],
);

export const bankLoanAllocation = pgTable(
  'bank_loan_allocation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    loanId: uuid('loan_id')
      .notNull()
      .references(() => bankLoan.id),
    paymentApplicationId: uuid('payment_application_id')
      .notNull()
      .references(() => paymentApplication.id),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    commissionShareTxn: numeric('commission_share_txn', { precision: 19, scale: 4 }).notNull().default('0'),
    landedCostChargeId: uuid('landed_cost_charge_id').references(() => landedCostCharge.id),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by').references(() => appUser.id),
    releaseReason: text('release_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_loan_allocation_live_uniq')
      .on(t.paymentApplicationId)
      .where(sql`${t.releasedAt} is null`),
    index('bank_loan_allocation_loan_idx').on(t.loanId),
    index('bank_loan_allocation_payable_idx').on(t.payableId),
  ],
);
