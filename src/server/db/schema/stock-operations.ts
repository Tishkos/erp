/**
 * Transfer and Item Reconciliation — Operations build, block 7.
 *
 * One record each, written when the stock moves. The movements themselves are
 * in `inventory_movement` like every other; these are what a person looks the
 * transfer or the adjustment up by. See migration 0207.
 */
import { date, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { warehouse } from './organisation';
import { item } from './item';
import { journalEntry } from './journal';

export const stockTransfer = pgTable('stock_transfer', {
  id: uuid('id').primaryKey().defaultRandom(),
  transferNo: text('transfer_no').notNull().unique(),
  itemCode: text('item_code')
    .notNull()
    .references(() => item.code),
  fromWarehouseCode: text('from_warehouse_code')
    .notNull()
    .references(() => warehouse.code),
  toWarehouseCode: text('to_warehouse_code')
    .notNull()
    .references(() => warehouse.code),
  quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
  costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull(),
  transferDate: date('transfer_date').notNull(),
  branchCode: text('branch_code')
    .notNull()
    .references(() => branch.code),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const stockAdjustment = pgTable('stock_adjustment', {
  id: uuid('id').primaryKey().defaultRandom(),
  adjustmentNo: text('adjustment_no').notNull().unique(),
  itemCode: text('item_code')
    .notNull()
    .references(() => item.code),
  warehouseCode: text('warehouse_code')
    .notNull()
    .references(() => warehouse.code),
  direction: text('direction').notNull(),
  quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
  costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull(),
  adjustmentDate: date('adjustment_date').notNull(),
  journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
  branchCode: text('branch_code')
    .notNull()
    .references(() => branch.code),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
