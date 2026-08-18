/**
 * Pick List — Phase 06.4, §7.2.
 *
 * > §7.2: *"External Excel → Sales Order → Automatic Stock Reservation → **Pick
 * > List** → Goods Issue / Delivery Note → A/R Invoice on the same delivery date
 * > → Customer Receipt."*
 *
 * The one step in that chain with no financial and no inventory effect —
 * Appendix B gives it as **Operational**. Stock has not moved: it is still in
 * the warehouse, still owned by the company, still reserved to the same order.
 * What has happened is that somebody has been told which units to take, and has
 * come back and said which ones they took.
 *
 * **There is no journal column, and no movement column.** That is how "creates
 * no accounting entry and no stock movement" is built rather than promised: not
 * a rule that a posting must not be written, but no field to write one into. The
 * 06.4 gate can be met by a service that forgets, only if the table lets it.
 *
 * **One pick list, one warehouse.** §7.2 allows one Sales Order to span branches
 * and warehouses, and a picker walks one building. So the warehouse is on the
 * header, and an order that spans three warehouses produces three pick lists.
 * The alternative — one pick list with a warehouse per line — describes a job
 * nobody can be handed.
 *
 * **The identities are the point.** `pick_list_line_unit` records which serials
 * and which batches were taken. §9.9 wants a serial followable from receipt to
 * delivery, and the pick is the first moment a *particular* unit is committed to
 * a *particular* customer. Capture it late — at the Delivery Note — and the
 * warehouse has already put the box on the van.
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
import { warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { salesOrder, salesOrderLine } from './sales-order';
import { documentStatus } from './workflow';

export const pickList = pgTable(
  'pick_list',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pickListNo: text('pick_list_no').notNull(),

    /**
     * Appendix B: Draft, Released, Picked, Completed, Cancelled — onto §3.2's
     * shared vocabulary:
     *
     *   draft · approved (Released) · executed (Picked) · closed (Completed) ·
     *   cancelled
     *
     * Appendix B gives the Pick List no partial state, and §3.2 says a document
     * type uses "only the states applicable to its effect", so a short pick is
     * still *Picked*. The shortfall is a quantity on the line — see
     * `domain/picking.ts` — not a state of the document. Inventing
     * `partially_executed` here would be amending Appendix B in code.
     */
    status: documentStatus('status').notNull().default('draft'),

    /** §7.2 — a pick list exists to serve one order. Never free-standing. */
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrder.id),

    /** One building, one job. See the note above. */
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    pickDate: date('pick_date').notNull(),

    /** Owned by Warehouse (§7.2) — the person the job is handed to. */
    assignedTo: uuid('assigned_to').references(() => appUser.id),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    releasedBy: uuid('released_by').references(() => appUser.id),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    pickedBy: uuid('picked_by').references(() => appUser.id),
    pickedAt: timestamp('picked_at', { withTimezone: true }),
    completedBy: uuid('completed_by').references(() => appUser.id),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pick_list_no_uniq').on(t.pickListNo),
    index('pick_list_order_idx').on(t.salesOrderId, t.status),
    index('pick_list_warehouse_idx').on(t.warehouseCode, t.status),

    check(
      'pick_list_cancellation_has_reason',
      sql`(${t.cancelledBy} is null and ${t.cancelledAt} is null)
          or (${t.cancelledBy} is not null and ${t.cancelledAt} is not null
              and coalesce(btrim(${t.cancellationReason}), '') <> '')`,
    ),

    // A picker cannot have picked before the list was released to them, and it
    // cannot be completed before it was picked. Times, not statuses: the status
    // machine already refuses the transitions, and this refuses a backdated
    // stamp written round it.
    check(
      'pick_list_stamps_in_order',
      sql`(${t.pickedAt} is null or ${t.releasedAt} is not null)
          and (${t.pickedAt} is null or ${t.releasedAt} <= ${t.pickedAt})
          and (${t.completedAt} is null or ${t.pickedAt} is not null)
          and (${t.completedAt} is null or ${t.pickedAt} <= ${t.completedAt})`,
    ),
  ],
);

export const pickListLine = pgTable(
  'pick_list_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pickListId: uuid('pick_list_id')
      .notNull()
      .references(() => pickList.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /**
     * The order line being picked against. NOT NULL: a picked quantity that
     * belongs to no order line is stock leaving the building for no reason.
     */
    salesOrderLineId: uuid('sales_order_line_id')
      .notNull()
      .references(() => salesOrderLine.id),

    /** Copied from the order line so the pick sheet reads without a join. */
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    description: text('description').notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /** What the picker was asked for, and what they came back with. */
    requestedQuantity: numeric('requested_quantity', { precision: 24, scale: 6 }).notNull(),
    pickedQuantity: numeric('picked_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),

    /** Free text from the floor: "two damaged", "shelf empty". */
    shortfallReason: text('shortfall_reason'),
  },
  (t) => [
    uniqueIndex('pick_list_line_no_uniq').on(t.pickListId, t.lineNo),
    // One order line, once per pick list. Two rows for the same order line on
    // one sheet is a picker being asked for the same thing twice.
    uniqueIndex('pick_list_line_order_line_uniq').on(t.pickListId, t.salesOrderLineId),
    index('pick_list_line_item_idx').on(t.itemCode),

    check('pick_list_line_requested_positive', sql`${t.requestedQuantity} > 0`),
    check(
      'pick_list_line_picked_within_request',
      sql`${t.pickedQuantity} >= 0 and ${t.pickedQuantity} <= ${t.requestedQuantity}`,
    ),
  ],
);

/**
 * Which units were taken — the payload the Delivery Note inherits.
 *
 * A serial row is one unit; a batch row is a quantity out of one batch. Both
 * shapes live here rather than in two tables, because the Delivery Note reads
 * them as one list and §9.9 traces them the same way.
 */
export const pickListLineUnit = pgTable(
  'pick_list_line_unit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    pickListLineId: uuid('pick_list_line_id')
      .notNull()
      .references(() => pickListLine.id, { onDelete: 'cascade' }),

    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    /** The cost layer the unit came off, so the Delivery Note costs it (04.2). */
    costLayerId: uuid('cost_layer_id'),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
  },
  (t) => [
    index('pick_list_line_unit_line_idx').on(t.pickListLineId),
    index('pick_list_line_unit_serial_idx').on(t.serialNumber).where(sql`${t.serialNumber} is not null`),
    index('pick_list_line_unit_batch_idx').on(t.batchNumber).where(sql`${t.batchNumber} is not null`),

    check('pick_list_line_unit_quantity_positive', sql`${t.quantity} > 0`),

    // A selection identifies something, or it is not a selection. An untracked
    // item has no rows here at all rather than a row that names nothing.
    check(
      'pick_list_line_unit_identifies_something',
      sql`coalesce(btrim(${t.serialNumber}), '') <> '' or coalesce(btrim(${t.batchNumber}), '') <> ''`,
    ),

    // A serial is one unit, by definition. Two units are two serials, and the
    // check is here as well as in the domain because an import writes rows.
    check(
      'pick_list_line_unit_serial_is_one',
      sql`${t.serialNumber} is null or ${t.quantity} = 1`,
    ),
  ],
);
