/**
 * Opening stock — Phase 04.5, §9.7.
 *
 * §9.7 names the fields verbatim: *"item, branch, warehouse, quantity, UOM,
 * FIFO unit cost, cost-layer date, serial/batch information, manufacture,
 * expiry and warranty data"*, and states the effect: *"approval creates the
 * inventory ledger entries and the opening accounting entry"*.
 *
 * It is a controlled document rather than a bulk import for one reason: the
 * figures it carries become the FIFO layers every subsequent margin is computed
 * against. Getting them wrong is not a data-entry error that shows up next week
 * — it is a cost of goods sold that is quietly wrong for as long as the stock
 * lasts. So it is raised, checked and approved by someone who is not the raiser,
 * like every other document with an accounting effect (§14.4).
 *
 * The cost-layer date is the field that makes this more than a receipt. Stock
 * being brought onto the system was bought before the system existed; §9.7 lets
 * the document say when, so the FIFO order reflects when the goods were really
 * acquired rather than the day they were typed in.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
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
import { item, unitOfMeasure } from './item';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';

export const openingStock = pgTable(
  'opening_stock',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentNo: text('document_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),

    /** The business date the document is raised on. */
    documentDate: date('document_date').notNull(),
    description: text('description'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** §9.7 — approval produces the opening journal; this is the link to it. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('opening_stock_no_uniq').on(t.documentNo),
    index('opening_stock_status_idx').on(t.status, t.branchCode),
  ],
);

/** One item's opening position — §9.7's field list, in full. */
export const openingStockLine = pgTable(
  'opening_stock_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    openingStockId: uuid('opening_stock_id')
      .notNull()
      .references(() => openingStock.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),
    /** IQD cost of one base unit — the layer's cost, not a total. */
    unitCostIqd: numeric('unit_cost_iqd', { precision: 19, scale: 4 }).notNull(),

    /**
     * §9.7 — the date the FIFO layer is costed at.
     *
     * Not the approval date and not the document date: stock brought onto the
     * system was acquired before the system existed, and it must consume in the
     * order it was really bought.
     */
    costLayerDate: date('cost_layer_date').notNull(),

    /** §9.3 identity and §9.7's manufacture, expiry and warranty data. */
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    manufacturedOn: date('manufactured_on'),
    expiryDate: date('expiry_date'),
    warrantyMonths: smallint('warranty_months'),

    /** The movement approval produced, for drill-down (Appendix B). */
    movementId: uuid('movement_id'),
  },
  (t) => [
    uniqueIndex('opening_stock_line_no_uniq').on(t.openingStockId, t.lineNo),
    check('opening_stock_line_quantity_positive', sql`${t.quantity} > 0`),
    // Stock may be brought on at zero cost — a donation, or a fully written-down
    // asset — but never at a negative one, which is not a cost.
    check('opening_stock_line_cost_not_negative', sql`${t.unitCostIqd} >= 0`),
    // An expiry before manufacture is a typing error that would make the stock
    // expired on arrival and quietly unsellable.
    check(
      'opening_stock_line_expiry_after_manufacture',
      sql`${t.expiryDate} is null or ${t.manufacturedOn} is null or ${t.expiryDate} >= ${t.manufacturedOn}`,
    ),
  ],
);
