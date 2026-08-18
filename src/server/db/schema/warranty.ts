/**
 * Warranty register — Phase 06.7, §7.4.
 *
 * > §7.4: *"Warranty starts on the A/R Invoice date. Warranty duration is
 * > maintained in Item Master and the end date is calculated automatically."*
 *
 * One row per covered unit, written when the invoice posts. Three decisions are
 * worth stating:
 *
 * **The end date is stored, not computed on read.** It looks like derived data
 * and is not: the item's warranty duration is master data and may change next
 * year, and a customer who bought a two-year warranty keeps it. Recomputing from
 * today's `item.warranty_months` would silently re-write history the first time
 * Product Management edited a row. So the duration is copied here with the
 * dates, and the register is a record of what was sold.
 *
 * **A row per serial where there is one.** §7.4's warranty lookup is *"by serial
 * number"*, which only works if a serial has its own row. An untracked item gets
 * one row for the line, because there is nothing finer to point at.
 *
 * **No row at all for an item without a duration.** §9.3 makes warranty fields
 * optional, and a zero-length record is not the same as no record: it says the
 * cover expired the day it was sold, which a counter would then have to argue
 * about. `domain/warranty.ts` returns `null` and this table simply has no row.
 */
import { sql } from 'drizzle-orm';
import {
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
import { businessPartner } from './organisation';
import { item } from './item';
import { arInvoice, arInvoiceLine } from './ar-invoice';

export const warrantyRegistration = pgTable(
  'warranty_registration',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** §7.4 — the warranty starts on the invoice date, so it starts here. */
    arInvoiceId: uuid('ar_invoice_id')
      .notNull()
      .references(() => arInvoice.id),
    arInvoiceLineId: uuid('ar_invoice_line_id')
      .notNull()
      .references(() => arInvoiceLine.id, { onDelete: 'cascade' }),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    /** The unit this covers. Null for an item tracked by neither. */
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    /** How many units this row covers — one, for a serial. */
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),

    /**
     * Copied from the Item Master at the moment of sale. See the note above:
     * the item's duration is master data and may change; what was sold may not.
     */
    warrantyMonths: smallint('warranty_months').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
  },
  (t) => [
    // §7.4's lookup is by serial, so that is the index that matters.
    uniqueIndex('warranty_registration_serial_uniq')
      .on(t.itemCode, t.serialNumber)
      .where(sql`${t.serialNumber} is not null`),
    index('warranty_registration_serial_idx')
      .on(t.serialNumber)
      .where(sql`${t.serialNumber} is not null`),
    index('warranty_registration_invoice_idx').on(t.arInvoiceId),
    index('warranty_registration_customer_idx').on(t.customerId, t.endsOn),
    index('warranty_registration_expiry_idx').on(t.endsOn, t.branchCode),

    check('warranty_registration_quantity_positive', sql`${t.quantity} > 0`),
    // A registration with no duration is the thing §9.3 says should not exist:
    // an item sold without cover has no row, not a row of zero months.
    check('warranty_registration_months_positive', sql`${t.warrantyMonths} > 0`),
    check('warranty_registration_ends_after_start', sql`${t.endsOn} > ${t.startsOn}`),
    // A serial identifies one unit, here as everywhere else (§9.3).
    check(
      'warranty_registration_serial_is_one',
      sql`${t.serialNumber} is null or ${t.quantity} = 1`,
    ),
  ],
);
