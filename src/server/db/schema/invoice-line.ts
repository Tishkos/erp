/**
 * The lines of an invoice — Phase 00.
 *
 * What is being charged for, and how much of it. The line total is stored
 * rather than derived on read: it is a fact about what was invoiced, and a
 * rounding rule that changes later must not quietly restate history. The
 * invoice's own `amount` is the sum of these, kept by a database trigger so
 * that no path — service, migration or console — can leave the two disagreeing.
 */
import { index, numeric, pgTable, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { invoice } from './invoice';

export const invoiceLine = pgTable(
  'invoice_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => invoice.id),
    lineNo: integer('line_no').notNull(),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 6 }).notNull(),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 19, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoice_line_no_uniq').on(t.invoiceId, t.lineNo),
    index('invoice_line_invoice_idx').on(t.invoiceId, t.lineNo),
  ],
);
