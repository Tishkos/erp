/**
 * Customer Payment and Expense Payment (0428, 2026-10-26).
 *
 * By direction: "a customer account … the only transactions should be receipts and payments … for
 * payments I don't want to use bank transfers or material returns … and general expenses".
 *
 * * A **Customer Payment** pays money out to a customer from a bank or cash account: Dr the customer's
 *   receivable (naming them) / Cr the account — the Customer Receipt's mirror, so a customer's
 *   statement can hold receipts and payments and nothing else.
 * * An **Expense Payment** pays a general expense straight from a bank or cash account, with no
 *   supplier invoice: Dr the expense account named / Cr the account — the Other Receipt's mirror. A
 *   trigger refuses a subledger control account, as the Other Receipt's does.
 *
 * Both are written in the account's own currency (`amount`, `currency`); `amount_iqd` is worked out
 * at the payment date's rate and fixed when it posts. Draft → Approved (four eyes; a super user alone
 * excepted) → Posted → Reversed; Draft or Approved → Cancelled. The road, the frozen fields and
 * "never deleted" are the migration's triggers.
 */
import { date, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';
import { businessLine, businessPartner } from './organisation';
import { bankCashAccount } from './item';
import { chartOfAccount } from './accounting';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { paymentMethod } from './pricing';

const shared = () => ({
  id: uuid('id').primaryKey().defaultRandom(),
  paymentNo: text('payment_no').notNull(),
  status: documentStatus('status').notNull().default('draft'),
  bankCashAccountId: uuid('bank_cash_account_id')
    .notNull()
    .references(() => bankCashAccount.id),
  branchCode: text('branch_code')
    .notNull()
    .references(() => branch.code),
  paymentDate: date('payment_date').notNull(),
  /** The account's own currency, and the amount in it. */
  currency: text('currency').notNull(),
  amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
  /** Dinars at the payment date's rate; fixed when it posts. */
  amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
  paymentMethodCode: text('payment_method_code').references(() => paymentMethod.code),
  /** What it is for — said by whoever writes it, read by whoever approves it. */
  purpose: text('purpose').notNull(),
  reference: text('reference'),
  note: text('note'),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
  reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntry.id),
  reversalReason: text('reversal_reason'),
  cancelReason: text('cancel_reason'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUser.id),
  approvedBy: uuid('approved_by').references(() => appUser.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  postedBy: uuid('posted_by').references(() => appUser.id),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  /** Who reversed or cancelled it, and when. */
  closedBy: uuid('closed_by').references(() => appUser.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const customerPayment = pgTable('customer_payment', {
  ...shared(),
  customerId: uuid('customer_id')
    .notNull()
    .references(() => businessPartner.id),
});

export const expensePayment = pgTable('expense_payment', {
  ...shared(),
  expenseAccountId: uuid('expense_account_id')
    .notNull()
    .references(() => chartOfAccount.id),
  departmentCode: text('department_code').references(() => department.code),
  businessLineCode: text('business_line_code').references(() => businessLine.code),
  /** Who was paid. Free text: they are not a business partner by definition. */
  payee: text('payee').notNull(),
});
