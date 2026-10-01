/**
 * Payables — REQ-AP-001 Stage 3, payments & bank (§15.1–§15.6). Migration 0232.
 *
 * **The payment application** is the company's request to its bank or cashier
 * to pay the supplier. It is not a journal: the journal is posted when the
 * money leaves, by the existing supplier payment or supplier advance, created
 * in the transaction that confirms the application (§15.4). Until then the
 * amount is *reserved* on the account it will leave from — and a reservation
 * is nothing but an application in `approved` or `sent`, so a reservation can
 * never exist without the document that explains it (§15.6).
 *
 * **The instalment plan** is the structured form of the terms ("TT 10%
 * deposit, 90% against B/L in 60 days" is two rows). Re-planning supersedes;
 * nothing is rewritten (R3).
 *
 * Applied / Paid / Remaining are SQL over these rows, never stored (§15.5).
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner, partnerBankAccount } from './organisation';
import { bankCashAccount } from './item';
import { paymentMethod } from './pricing';
import { exchangeRate } from './fiscal';
import { bankStatementLine } from './bank-statement';
import { supplierPayment } from './supplier-payment';
import { supplierAdvance } from './supplier-advance';
import { payable } from './payables';

/** §15.2 — what makes an instalment due. Configurable (R4). */
export const instalmentTrigger = pgTable('instalment_trigger', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  /** The `days_after_*` triggers take a number of days. */
  needsDays: boolean('needs_days').notNull().default(false),
  sortOrder: smallint('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/** §15.2 — one row per instalment of an import's terms. */
export const payableInstalment = pgTable(
  'payable_instalment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    sequence: smallint('sequence').notNull(),
    label: text('label').notNull(),
    /** `percent` of the invoice amount, or a fixed `amount`. */
    basis: text('basis').notNull(),
    percent: numeric('percent', { precision: 9, scale: 4 }),
    /** In the payable's currency, fixed when planned; the last row absorbs rounding. */
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    triggerCode: text('trigger_code')
      .notNull()
      .references(() => instalmentTrigger.code),
    triggerDays: integer('trigger_days'),
    expectedDate: date('expected_date'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references(() => appUser.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payable_instalment_live_uniq')
      .on(t.payableId, t.sequence)
      .where(sql`${t.supersededAt} is null`),
    index('payable_instalment_payable_idx').on(t.payableId),
    check('payable_instalment_basis', sql`${t.basis} in ('percent', 'amount')`),
    check('payable_instalment_amount_positive', sql`${t.amountTxn} > 0`),
  ],
);

/** §15.3 — own funds or a bank loan; extensible. */
export const fundingSource = pgTable('funding_source', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  requiresLoan: boolean('requires_loan').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

export const PAYMENT_APPLICATION_STATUSES = [
  'draft',
  'approved',
  'sent',
  'confirmed',
  'debited',
  'rejected',
  'cancelled',
] as const;
export type PaymentApplicationStatus = (typeof PAYMENT_APPLICATION_STATUSES)[number];

/** §15.3 — the payment application. */
export const paymentApplication = pgTable(
  'payment_application',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationNo: text('application_no').notNull(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    instalmentId: uuid('instalment_id').references(() => payableInstalment.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    paymentMethodCode: text('payment_method_code')
      .notNull()
      .references(() => paymentMethod.code),
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    payeeBankAccountId: uuid('payee_bank_account_id').references(() => partnerBankAccount.id),
    fundingSourceCode: text('funding_source_code')
      .notNull()
      .default('own_funds')
      .references(() => fundingSource.code),
    /** Stage 6 adds the loan register and its foreign key. */
    loanId: uuid('loan_id'),

    currency: char('currency', { length: 3 }).notNull(),
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    rateId: uuid('rate_id').references(() => exchangeRate.id),

    status: text('status').$type<PaymentApplicationStatus>().notNull().default('draft'),
    /** The date the file went to the bank. */
    applicationDate: date('application_date'),
    bankReference: text('bank_reference'),
    /** SWIFT date / transfer date / voucher date / cheque date. */
    confirmedOn: date('confirmed_on'),
    /** MT103 reference / bank reference / voucher no / cheque no. */
    confirmationReference: text('confirmation_reference'),
    debitDate: date('debit_date'),
    statementLineId: uuid('statement_line_id').references(() => bankStatementLine.id),

    supplierPaymentId: uuid('supplier_payment_id').references(() => supplierPayment.id),
    supplierAdvanceId: uuid('supplier_advance_id').references(() => supplierAdvance.id),
    /** Stage 4 adds the PD register and its foreign key. */
    pdId: uuid('pd_id'),

    overriddenChecks: text('overridden_checks').array().notNull().default(sql`'{}'::text[]`),
    overrideReason: text('override_reason'),
    overrideBy: uuid('override_by').references(() => appUser.id),
    overrideAt: timestamp('override_at', { withTimezone: true }),

    note: text('note'),
    closedReason: text('closed_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentBy: uuid('sent_by').references(() => appUser.id),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by').references(() => appUser.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => appUser.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('payment_application_no_uniq').on(t.applicationNo),
    index('payment_application_payable_idx').on(t.payableId),
    index('payment_application_status_idx').on(t.status, t.applicationDate),
  ],
);

/** §15.3 — the status machine, seeded, editable. */
export const paymentApplicationTransition = pgTable(
  'payment_application_transition',
  {
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    active: boolean('active').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);
