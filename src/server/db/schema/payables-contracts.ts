/**
 * Recurring contracts and landed-cost capture — REQ-AP-001 Stage 2 (§10, §20.2).
 *
 * A contract is the standing agreement; each period it generates one payable
 * of type `recurring` (never two — the partial unique on the payable holds
 * it). Amendments are append-only rows: the rent in force on a date is the
 * newest amendment at or before it, and the contract's own words never change.
 *
 * Landed-cost charges are captured here (a forwarder's invoice line charged
 * to an import, §9.2) and allocated in build Stage 7; a wrong charge is
 * cancelled with a reason, never edited or deleted.
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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';
import { businessPartner } from './organisation';
import { expenseCategory, payable } from './payables';

export const recurringContract = pgTable(
  'recurring_contract',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractNo: text('contract_no').notNull(),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),
    /** §10.1 — the department that occupies / uses; it confirms the periods. */
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    expenseCategoryCode: text('expense_category_code')
      .notNull()
      .references(() => expenseCategory.code),
    description: text('description').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountPerPeriodTxn: numeric('amount_per_period_txn', { precision: 19, scale: 4 }).notNull(),
    frequency: text('frequency', { enum: ['monthly', 'quarterly', 'yearly'] }).notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date'),
    noticeDays: integer('notice_days'),
    /** `day_of_period:<n>` · `days_before_period_start:<n>` · `days_after_invoice:<n>`. */
    dueRule: text('due_rule').notNull().default('day_of_period:1'),
    generateDaysAhead: integer('generate_days_ahead').notNull().default(30),
    /** D8 — a lease is its own receipt evidence; a metered bill is confirmed. */
    autoConfirm: boolean('auto_confirm').notNull().default(false),
    invoiceExpected: boolean('invoice_expected').notNull().default(true),
    /** A security deposit is an `advance` payable linked here (§10.1). */
    depositPayableId: uuid('deposit_payable_id').references(() => payable.id),
    status: text('status', { enum: ['draft', 'active', 'ended', 'cancelled'] })
      .notNull()
      .default('draft'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedBy: uuid('ended_by').references(() => appUser.id),
    endReason: text('end_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('recurring_contract_no_uniq').on(t.contractNo),
    index('recurring_contract_supplier_idx').on(t.supplierId, t.status),
    check('recurring_contract_amount_positive', sql`${t.amountPerPeriodTxn} > 0`),
    check('recurring_contract_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'recurring_contract_dates_ordered',
      sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`,
    ),
  ],
);

/** §10.1 — escalations and renegotiations, as dated rows. Append-only. */
export const recurringContractAmendment = pgTable(
  'recurring_contract_amendment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contractId: uuid('contract_id')
      .notNull()
      .references(() => recurringContract.id),
    effectiveFrom: date('effective_from').notNull(),
    amountPerPeriodTxn: numeric('amount_per_period_txn', { precision: 19, scale: 4 }),
    note: text('note').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('recurring_contract_amendment_idx').on(t.contractId, t.effectiveFrom)],
);

/** §20.2 — the kinds of cost an import really carries. Master, extensible. */
export const landedCostType = pgTable('landed_cost_type', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

/**
 * One row per cost that belongs to an import — created from documents (§20.2),
 * captured now, allocated when the landed cost locks (build Stage 7).
 */
export const landedCostCharge = pgTable(
  'landed_cost_charge',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    chargeTypeCode: text('charge_type_code')
      .notNull()
      .references(() => landedCostType.code),
    amountTxn: numeric('amount_txn', { precision: 19, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** The document that carries the cost — never typed free (§20.2). */
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceNo: text('source_no'),
    note: text('note'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('landed_cost_charge_payable_idx').on(t.payableId),
    uniqueIndex('landed_cost_charge_source_uniq')
      .on(t.sourceType, t.sourceId)
      .where(sql`cancelled_at is null`),
    check('landed_cost_charge_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check(
      'landed_cost_charge_cancel_has_reason',
      sql`(${t.cancelledAt} is null and ${t.cancelledBy} is null)
          or (${t.cancelledAt} is not null and ${t.cancelledBy} is not null
              and coalesce(btrim(${t.cancelReason}), '') <> '')`,
    ),
  ],
);
