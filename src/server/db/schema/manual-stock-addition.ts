/**
 * Manual Stock Addition — stock put onto the books without a purchase
 * (2026-10-06, by direction). Migration 0415 holds the rest: the road
 * (`manual_stock_addition_guard`), the frozen lines, the four eyes, the row
 * security by branch and the grants.
 *
 * One warehouse per document; each line names the item, the unit it was
 * written in, the quantity and the cost of one of that unit. Approval receives
 * every line into the warehouse in the item's base unit at the cost of one
 * base unit (`base_quantity`, `base_unit_cost_iqd`, `movement_id`) and posts
 * the journal named by `journal_entry_id`.
 */
import {
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
import { warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { chartOfAccount } from './accounting';
import { inventoryMovement } from './inventory';

export const manualStockAddition = pgTable(
  'manual_stock_addition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    additionNo: text('addition_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    postingDate: date('posting_date').notNull(),
    /** Why the stock is added — the note the audit keeps. */
    reason: text('reason').notNull(),
    /** Null: the inventory adjustment mapping answers. */
    offsetAccountId: uuid('offset_account_id').references(() => chartOfAccount.id),
    /** 0416 — the department the journal is analysed by, when the accounts ask for one. */
    departmentCode: text('department_code').references(() => department.code),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => appUser.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectionReason: text('rejection_reason'),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('manual_stock_addition_no_uniq').on(t.additionNo),
    index('manual_stock_addition_status_idx').on(t.status, t.branchCode),
  ],
);

export const manualStockAdditionLine = pgTable(
  'manual_stock_addition_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    additionId: uuid('addition_id')
      .notNull()
      .references(() => manualStockAddition.id),
    lineNo: integer('line_no').notNull(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),
    /** In the line's unit, scaled at 1e6. */
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    /** IQD for one of the line's unit. */
    unitCostIqd: numeric('unit_cost_iqd', { precision: 19, scale: 4 }).notNull(),
    lineValueIqd: numeric('line_value_iqd', { precision: 19, scale: 4 }).notNull(),
    baseQuantity: numeric('base_quantity', { precision: 24, scale: 6 }),
    baseUnitCostIqd: numeric('base_unit_cost_iqd', { precision: 19, scale: 4 }),
    movementId: uuid('movement_id').references(() => inventoryMovement.id),
  },
  (t) => [uniqueIndex('manual_stock_addition_line_no_uniq').on(t.additionId, t.lineNo)],
);
