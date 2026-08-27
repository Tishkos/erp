/**
 * The Phase 0 invoice — the document the foundation is demonstrated with.
 *
 * It carries only what the rules need: a number from a series, the department
 * that decides its approver, the branch it belongs to, a status from the one
 * shared vocabulary, and who raised it. No lines, no tax, no posting — those
 * arrive with the accounting phases.
 */
import { sql } from 'drizzle-orm';
import {
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';
import { documentStatus } from './workflow';

export const invoice = pgTable(
  'invoice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Allocated from the INVOICE series; never reused (§4.3). */
    documentNo: text('document_no').notNull(),
    customerName: text('customer_name').notNull(),
    description: text('description'),
    amount: numeric('amount', { precision: 19, scale: 4 }).notNull(),
    currency: char('currency', { length: 3 }).notNull().default('IQD'),
    documentDate: date('document_date').notNull(),
    /** §5.2 — the department whose manager approves it. */
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    status: documentStatus('status').notNull().default('draft'),
    /** What the approver said when they sent it back; cleared on resubmission. */
    returnedReason: text('returned_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('invoice_document_no_uniq').on(t.documentNo),
    index('invoice_status_idx').on(t.status, t.documentDate),
    index('invoice_department_idx').on(t.departmentCode),
    check('invoice_amount_positive', sql`${t.amount} > 0`),
    check('invoice_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check('invoice_customer_present', sql`length(btrim(${t.customerName})) > 0`),
  ],
);
