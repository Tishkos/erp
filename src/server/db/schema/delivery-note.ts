/**
 * Delivery Note and Proof of Delivery.
 *
 * > §7.2: *"External Excel → Sales Order → Automatic Stock Reservation → Pick
 * > List → **Goods Issue / Delivery Note** → A/R Invoice on the same delivery
 * > date → Customer Receipt. Partial deliveries and multiple deliveries from one
 * > Sales Order are supported. Proof of Delivery shall capture recipient name,
 * > signature, attachments and delivery photos."*
 *
 * Appendix B: **Draft, Approved, Delivered, Reversed** — and no Cancelled. That
 * absence is honoured rather than filled in: a delivery is undone by reversing
 * it, because by then stock has moved and COGS has posted. A draft that is never
 * approved simply stays a draft.
 *
 * **Where the accounting happens.** At *Delivered*, not at Approved. Appendix C
 * gives one row for the whole event — *"Sales delivery and invoice … Same
 * delivery and invoice date"* — so there is one posting, made when the goods
 * reach the customer, and `delivery_date` is the date §7.4 then forces onto the
 * A/R Invoice.
 *
 * **What the note carries down from the pick.** The identified units.
 * `delivery_note_line_unit` is a copy rather than a join, because the pick list
 * is Completed once the delivery is made and a document must still say which
 * serials it moved ten years later (§9.9, §24) — a join to a mutable parent is
 * not evidence.
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
import { attachment } from './attachments';
import { journalEntry } from './journal';
import { salesOrder, salesOrderLine } from './sales-order';
import { pickList, pickListLine } from './pick-list';
import { documentStatus } from './workflow';

export const deliveryNote = pgTable(
  'delivery_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryNoteNo: text('delivery_note_no').notNull(),

    /**
     * Appendix B: Draft, Approved, Delivered, Reversed — onto §3.2's shared
     * vocabulary: draft · approved · executed (Delivered) · reversed.
     */
    status: documentStatus('status').notNull().default('draft'),

    /** §7.2 — the chain. Both links, both required. */
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrder.id),
    pickListId: uuid('pick_list_id')
      .notNull()
      .references(() => pickList.id),

    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /**
     * §7.4 — *"The A/R Invoice shall be issued on the same date as delivery"*,
     * so this is the date the invoice will be forced to. Set when the note is
     * raised and frozen at approval.
     */
    deliveryDate: date('delivery_date').notNull(),
    /** §7.2 — one order may deliver to several places; this is this note's. */
    deliveryLocation: text('delivery_location'),

    /** The posting made at Delivered. Null until then, and never rewritten. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    /** Dr COGS at FIFO cost — the sum of the lines, kept for the document. */
    cogsIqd: numeric('cogs_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    deliveredBy: uuid('delivered_by').references(() => appUser.id),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('delivery_note_no_uniq').on(t.deliveryNoteNo),
    index('delivery_note_order_idx').on(t.salesOrderId, t.status),
    index('delivery_note_pick_idx').on(t.pickListId),
    index('delivery_note_date_idx').on(t.deliveryDate, t.branchCode),

    check(
      'delivery_note_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),

    // A note cannot be delivered before it was approved, nor reversed before it
    // was delivered. The status machine refuses the transitions; this refuses a
    // stamp written round it.
    check(
      'delivery_note_stamps_in_order',
      sql`(${t.deliveredAt} is null or ${t.approvedAt} is not null)
          and (${t.deliveredAt} is null or ${t.approvedAt} <= ${t.deliveredAt})
          and (${t.reversedAt} is null or ${t.deliveredAt} is not null)
          and (${t.reversedAt} is null or ${t.deliveredAt} <= ${t.reversedAt})`,
    ),

    // The posting and the delivery arrive together or not at all (§24). A
    // journal on an undelivered note would be COGS for goods still on the shelf.
    check(
      'delivery_note_posting_matches_status',
      sql`(${t.journalEntryId} is null) = (${t.deliveredAt} is null)`,
    ),

    check('delivery_note_cogs_not_negative', sql`${t.cogsIqd} >= 0`),
  ],
);

export const deliveryNoteLine = pgTable(
  'delivery_note_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryNoteId: uuid('delivery_note_id')
      .notNull()
      .references(() => deliveryNote.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** §7.7 — every delivered quantity reconciles to an order line. */
    salesOrderLineId: uuid('sales_order_line_id')
      .notNull()
      .references(() => salesOrderLine.id),
    /** And to the pick that put the units in the van. */
    pickListLineId: uuid('pick_list_line_id')
      .notNull()
      .references(() => pickListLine.id),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    description: text('description').notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),

    /**
     * The FIFO cost of the layers this line consumed (Phase 04.2), recorded at
     * delivery. Not recomputed later: the layers it came out of may since have
     * been emptied by somebody else's sale, and a COGS figure that moves is not
     * a COGS figure.
     */
    cogsIqd: numeric('cogs_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /** The stock movement this line produced. One per line, at delivery. */
    inventoryMovementId: uuid('inventory_movement_id'),

    /** How much of this line has been invoiced (§7.4). Maintained by 06.6. */
    invoicedQuantity: numeric('invoiced_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
  },
  (t) => [
    uniqueIndex('delivery_note_line_no_uniq').on(t.deliveryNoteId, t.lineNo),
    uniqueIndex('delivery_note_line_pick_line_uniq').on(t.deliveryNoteId, t.pickListLineId),
    index('delivery_note_line_order_line_idx').on(t.salesOrderLineId),
    index('delivery_note_line_item_idx').on(t.itemCode),

    check('delivery_note_line_quantity_positive', sql`${t.quantity} > 0`),
    check('delivery_note_line_cogs_not_negative', sql`${t.cogsIqd} >= 0`),
    // Nothing is invoiced that was not delivered (§7.4).
    check(
      'delivery_note_line_invoiced_within_delivered',
      sql`${t.invoicedQuantity} >= 0 and ${t.invoicedQuantity} <= ${t.quantity}`,
    ),
  ],
);

/**
 * Which units went — copied down from the pick, not joined to it.
 *
 * §9.9 wants a serial followable from receipt to delivery, and the delivery is
 * the end of that chain inside the company. The row is the document's own record
 * of what it moved.
 */
export const deliveryNoteLineUnit = pgTable(
  'delivery_note_line_unit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryNoteLineId: uuid('delivery_note_line_id')
      .notNull()
      .references(() => deliveryNoteLine.id, { onDelete: 'cascade' }),

    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
  },
  (t) => [
    index('delivery_note_line_unit_line_idx').on(t.deliveryNoteLineId),
    index('delivery_note_line_unit_serial_idx')
      .on(t.serialNumber)
      .where(sql`${t.serialNumber} is not null`),
    index('delivery_note_line_unit_batch_idx')
      .on(t.batchNumber)
      .where(sql`${t.batchNumber} is not null`),

    check('delivery_note_line_unit_quantity_positive', sql`${t.quantity} > 0`),
    check(
      'delivery_note_line_unit_identifies_something',
      sql`coalesce(btrim(${t.serialNumber}), '') <> '' or coalesce(btrim(${t.batchNumber}), '') <> ''`,
    ),
    check(
      'delivery_note_line_unit_serial_is_one',
      sql`${t.serialNumber} is null or ${t.quantity} = 1`,
    ),
  ],
);

/**
 * §7.2 — *"Proof of Delivery shall capture recipient name, signature,
 * attachments and delivery photos."*
 *
 * Its own table, one row per delivery note, rather than four columns on the
 * note. Two reasons, and the second is the real one:
 *
 *   The POD is captured by a different person at a different time — the driver
 *   at the customer's door, not the warehouse clerk who raised the note.
 *
 *   And a row that exists only when the delivery was proved makes *"was this
 *   delivery proved?"* a question about existence rather than about four
 *   nullable columns none of which is individually conclusive.
 */
export const proofOfDelivery = pgTable(
  'proof_of_delivery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deliveryNoteId: uuid('delivery_note_id')
      .notNull()
      .references(() => deliveryNote.id, { onDelete: 'cascade' }),

    /** Who took the goods. A name, because that is what a signature is against. */
    recipientName: text('recipient_name').notNull(),
    /** Their relationship to the customer, where it matters — driver, guard. */
    recipientRole: text('recipient_role'),

    /**
     * The signature image, through the Phase 01 attachment service — so it is
     * scanned, versioned, retained and access-logged like every other document
     * (§21), rather than being a blob in a sales table.
     */
    signatureAttachmentId: uuid('signature_attachment_id')
      .notNull()
      .references(() => attachment.id),

    /** When the customer actually received it, which may not be today. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    capturedBy: uuid('captured_by')
      .notNull()
      .references(() => appUser.id),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),

    note: text('note'),
  },
  (t) => [
    // One proof per delivery. A second would be a second story about the same
    // event, and §24 has no way to say which is the true one.
    uniqueIndex('proof_of_delivery_note_uniq').on(t.deliveryNoteId),
    check('proof_of_delivery_recipient_named', sql`btrim(${t.recipientName}) <> ''`),
  ],
);

/**
 * The delivery photos — §7.2 names them separately from attachments, so they are
 * separate here.
 *
 * A photo is an attachment like any other; what this table adds is that it is a
 * photo *of this delivery*, which is the thing the clause asks for and which a
 * general attachment panel cannot assert.
 */
export const proofOfDeliveryPhoto = pgTable(
  'proof_of_delivery_photo',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proofOfDeliveryId: uuid('proof_of_delivery_id')
      .notNull()
      .references(() => proofOfDelivery.id, { onDelete: 'cascade' }),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachment.id),
    caption: text('caption'),
    sequence: integer('sequence').notNull().default(1),
  },
  (t) => [
    uniqueIndex('proof_of_delivery_photo_uniq').on(t.proofOfDeliveryId, t.attachmentId),
    index('proof_of_delivery_photo_pod_idx').on(t.proofOfDeliveryId, t.sequence),
  ],
);
