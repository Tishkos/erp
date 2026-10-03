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
  jsonb,
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

/**
 * IMPROVEMENT-002 (0280) — where every dinar of a lock went that did not stay
 * in stock: one row per lock × layer × departed movement, posted to the
 * destination of the business event that took the units (a sale's cost of
 * sales, a project issue's project cost, a write-off's loss …). A unit that
 * comes back writes a negative `return` row pointing at the departure it
 * undoes; a rounding residue with no movement behind it is a `rounding` row.
 * Generic: it names the inventory movement, never the business module.
 */
export const landedCostDeparture = pgTable(
  'landed_cost_departure',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lockId: uuid('lock_id')
      .notNull()
      .references(() => landedCostLock.id),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    kind: text('kind').$type<'departure' | 'return' | 'rounding'>().notNull(),
    costLayerId: uuid('cost_layer_id')
      .notNull()
      .references(() => costLayer.id),
    movementId: uuid('movement_id'),
    movementKind: text('movement_kind'),
    sourceDocumentType: text('source_document_type'),
    sourceDocumentId: text('source_document_id'),
    sourceLineId: text('source_line_id'),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    destinationRole: text('destination_role').notNull(),
    accountId: uuid('account_id').notNull(),
    dimensions: jsonb('dimensions').$type<Record<string, string | null>>().notNull().default({}),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id),
    returnsDepartureId: uuid('returns_departure_id'),
    toLayerId: uuid('to_layer_id'),
    postSettlement: boolean('post_settlement').notNull().default(false),
    departedOn: date('departed_on', { mode: 'string' }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('landed_cost_departure_lock_idx').on(t.lockId),
    index('landed_cost_departure_payable_idx').on(t.payableId),
    index('landed_cost_departure_movement_idx').on(t.movementId),
    index('landed_cost_departure_returns_idx').on(t.returnsDepartureId),
    index('landed_cost_departure_layer_idx').on(t.costLayerId),
  ],
);
