/**
 * Payables — REQ-AP-001 Stage 7, the landed cost (§20.2). Migration 0236.
 *
 * A **lock** allocates an import's unlocked charges (freight, customs, the
 * loan's commission …) over the FIFO layers its container receipts created,
 * by the chosen basis. For each layer the share still on hand restates its
 * unit cost (Dr Inventory); the share already sold is cost of sales (Dr COGS);
 * the share moved on by a transfer follows the stock to the layer it went to.
 * The clearing account the charges were parked on is credited with the total.
 *
 * The first lock is the lock; a charge that arrives later is allocated by a
 * dated adjustment lock, never by an edit. Locks and their layer adjustments
 * are append-only.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
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
import { warehouse } from './organisation';
import { item } from './item';
import { journalEntry } from './journal';
import { costLayer } from './inventory';
import { payable } from './payables';

export const landedCostBasis = pgTable('landed_cost_basis', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: smallint('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

export const landedCostLock = pgTable(
  'landed_cost_lock',
  {
    id: uuid('id').primaryKey(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    sequence: smallint('sequence').notNull(),
    lockDate: date('lock_date', { mode: 'string' }).notNull(),
    basisCode: text('basis_code')
      .notNull()
      .references(() => landedCostBasis.code),
    totalIqd: numeric('total_iqd', { precision: 19, scale: 4 }).notNull(),
    inventoryIqd: numeric('inventory_iqd', { precision: 19, scale: 4 }).notNull(),
    cogsIqd: numeric('cogs_iqd', { precision: 19, scale: 4 }).notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id),
    note: text('note'),
    lockedBy: uuid('locked_by')
      .notNull()
      .references(() => appUser.id),
    lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('landed_cost_lock_sequence_uniq').on(t.payableId, t.sequence),
    check('landed_cost_lock_sequence_positive', sql`${t.sequence} > 0`),
  ],
);

export const landedCostLayerAdjustment = pgTable(
  'landed_cost_layer_adjustment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lockId: uuid('lock_id')
      .notNull()
      .references(() => landedCostLock.id),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    costLayerId: uuid('cost_layer_id')
      .notNull()
      .references(() => costLayer.id),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    allocatedIqd: numeric('allocated_iqd', { precision: 19, scale: 4 }).notNull(),
    onHandQty: numeric('on_hand_qty', { precision: 24, scale: 6 }).notNull(),
    unitCostBefore: numeric('unit_cost_before', { precision: 19, scale: 4 }).notNull(),
    unitCostAfter: numeric('unit_cost_after', { precision: 19, scale: 4 }).notNull(),
    inventoryIqd: numeric('inventory_iqd', { precision: 19, scale: 4 }).notNull(),
    cogsIqd: numeric('cogs_iqd', { precision: 19, scale: 4 }).notNull(),
    viaLayerId: uuid('via_layer_id').references(() => costLayer.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('landed_cost_layer_adjustment_lock_idx').on(t.lockId),
    index('landed_cost_layer_adjustment_layer_idx').on(t.costLayerId),
  ],
);
