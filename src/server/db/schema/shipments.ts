/**
 * Payables — REQ-AP-001 Stage 5, shipment & warehouse (§17, §18). Migration 0234.
 *
 * Every container on its own. An import has any number of B/Ls; a B/L lists
 * its containers; each container keeps its own ETA, its own dated stages
 * (never overwritten — a re-dated stage is a history row), and the models it
 * carries. A container is received by one container receipt, which moves the
 * invoice's goods out of transit into the warehouse that received them; the
 * receipt's id is the form's one-time document id.
 */
import { sql } from 'drizzle-orm';
import { boolean, char, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { payable } from './payables';

export const port = pgTable('port', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  locode: text('locode'),
  country: char('country', { length: 2 }),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

export const containerStatus = pgTable('container_status', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  sequence: smallint('sequence').notNull(),
  countsAsReceived: boolean('counts_as_received').notNull().default(false),
  isException: boolean('is_exception').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
});

export const billOfLading = pgTable(
  'bill_of_lading',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    blNo: text('bl_no').notNull(),
    blDate: date('bl_date').notNull(),
    shippingLine: text('shipping_line'),
    vessel: text('vessel'),
    voyage: text('voyage'),
    portOfLoading: text('port_of_loading'),
    portOfDischargeCode: text('port_of_discharge_code').references(() => port.code),
    eta: date('eta'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelReason: text('cancel_reason'),
    source: text('source').notNull().default('erp'),
    sourceRow: text('source_row'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('bill_of_lading_no_uniq').on(t.blNo), index('bill_of_lading_payable_idx').on(t.payableId)],
);

export const shipmentContainer = pgTable(
  'shipment_container',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    blId: uuid('bl_id')
      .notNull()
      .references(() => billOfLading.id),
    payableId: uuid('payable_id')
      .notNull()
      .references(() => payable.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    containerNo: text('container_no').notNull(),
    sizeType: text('size_type'),
    statusCode: text('status_code')
      .notNull()
      .default('not_loaded')
      .references(() => containerStatus.code),
    statusDate: date('status_date'),
    eta: date('eta'),
    departedOn: date('departed_on'),
    arrivedPortOn: date('arrived_port_on'),
    customsClearedOn: date('customs_cleared_on'),
    portFileSentOn: date('port_file_sent_on'),
    receivedOn: date('received_on'),
    warehouseCode: text('warehouse_code').references(() => warehouse.code),
    containerReceiptId: uuid('container_receipt_id'),
    linesEstimated: boolean('lines_estimated').notNull().default(false),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelReason: text('cancel_reason'),
    source: text('source').notNull().default('erp'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shipment_container_live_no_uniq')
      .on(t.containerNo)
      .where(sql`${t.receivedOn} is null and ${t.cancelledAt} is null`),
    index('shipment_container_bl_idx').on(t.blId),
    index('shipment_container_payable_idx').on(t.payableId),
  ],
);

export const shipmentContainerStatusHistory = pgTable('shipment_container_status_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  containerId: uuid('container_id')
    .notNull()
    .references(() => shipmentContainer.id),
  statusCode: text('status_code')
    .notNull()
    .references(() => containerStatus.code),
  effectiveDate: date('effective_date').notNull(),
  note: text('note'),
  source: text('source').notNull().default('user'),
  recordedBy: uuid('recorded_by').references(() => appUser.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const shipmentContainerLine = pgTable('shipment_container_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  containerId: uuid('container_id')
    .notNull()
    .references(() => shipmentContainer.id),
  lineNo: integer('line_no').notNull(),
  itemCode: text('item_code').references(() => item.code),
  description: text('description').notNull(),
  plannedQty: numeric('planned_qty', { precision: 24, scale: 6 }).notNull(),
  uomCode: text('uom_code').references(() => unitOfMeasure.code),
  receivedQty: numeric('received_qty', { precision: 24, scale: 6 }),
  damagedQty: numeric('damaged_qty', { precision: 24, scale: 6 }),
  shortQty: numeric('short_qty', { precision: 24, scale: 6 }),
  warehouseCode: text('warehouse_code').references(() => warehouse.code),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  supersededBy: uuid('superseded_by').references(() => appUser.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const containerReceipt = pgTable('container_receipt', {
  id: uuid('id').primaryKey(),
  receiptNo: text('receipt_no').notNull(),
  containerId: uuid('container_id')
    .notNull()
    .references(() => shipmentContainer.id),
  payableId: uuid('payable_id')
    .notNull()
    .references(() => payable.id),
  branchCode: text('branch_code')
    .notNull()
    .references(() => branch.code),
  warehouseCode: text('warehouse_code')
    .notNull()
    .references(() => warehouse.code),
  receiptDate: date('receipt_date').notNull(),
  varianceReason: text('variance_reason'),
  note: text('note'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const containerReceiptLine = pgTable('container_receipt_line', {
  id: uuid('id').primaryKey().defaultRandom(),
  receiptId: uuid('receipt_id')
    .notNull()
    .references(() => containerReceipt.id),
  containerLineId: uuid('container_line_id')
    .notNull()
    .references(() => shipmentContainerLine.id),
  lineNo: integer('line_no').notNull(),
  itemCode: text('item_code').references(() => item.code),
  plannedQty: numeric('planned_qty', { precision: 24, scale: 6 }).notNull(),
  receivedQty: numeric('received_qty', { precision: 24, scale: 6 }).notNull(),
  damagedQty: numeric('damaged_qty', { precision: 24, scale: 6 }).notNull().default('0'),
  shortQty: numeric('short_qty', { precision: 24, scale: 6 }).notNull().default('0'),
  movedQty: numeric('moved_qty', { precision: 24, scale: 6 }).notNull().default('0'),
  costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
});
