/**
 * Service Receipt / Expense Confirmation — Phase 05.3, §8.6.
 *
 * §8.2's second purchasing flow: *"Service or expense purchase: Purchase Order
 * → Service Receipt / Expense Confirmation → A/P Invoice → Supplier Payment."*
 *
 * The document exists to answer one question that a warehouse receipt answers
 * for goods and nothing else answers for services: **did we actually get it?**
 * A consultancy month, a haulage run or an office repair leaves no stock behind,
 * so without this document the A/P Invoice would be matched against a purchase
 * order alone — which records what was *agreed*, not what was *delivered*.
 *
 * **Owned by the benefiting department** (§8.6, Appendix B). Not by Purchasing,
 * who agreed the price, and not by Finance, who will pay it. The department that
 * asked for the work is the only one that knows whether it was done, and making
 * anyone else the owner would turn the confirmation into a formality.
 *
 * **It posts nothing.** Appendix C lists every posting in the system and has no
 * row for this document: the expense reaches the ledger at the A/P Invoice —
 * *"A/P Invoice – service/expense | Expense / Service Cost | Supplier A/P | PO
 * and Service Receipt required."* Appendix B calls the effect *"receipt evidence
 * / accrual"*, and whether a period-end accrual is also required for confirmed
 * but uninvoiced services is an open question for the Business Process Owner
 * (D11) — not one the implementation team may answer by writing a journal.
 * Expressed here as a table property: there is no journal link to fill in.
 *
 * **It moves no stock**, for the same reason and by the same means: no movement
 * column, and lines may only reference non-inventory purchase order lines.
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
import { appUser, branch, department } from './platform';
import { costCentre } from './organisation';
import { unitOfMeasure } from './item';
import { documentStatus } from './workflow';
import { purchaseOrder, purchaseOrderLine } from './purchase-order';
import { payable } from './payables';

export const serviceReceipt = pgTable(
  'service_receipt',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    receiptNo: text('receipt_no').notNull(),
    /**
     * Appendix B: Draft, Pending Approval, Approved, Reversed — mapped onto
     * §3.2's shared vocabulary as draft, submitted, approved, reversed.
     */
    status: documentStatus('status').notNull().default('draft'),

    /**
     * §8.2 — a confirmation always answers to an order — or, since
     * REQ-AP-001 Stage 2, to the payable it confirms (§9.2): a rent or a
     * consultant's month has no ordered line to answer to. The CHECK below
     * holds the widened rule; the service requires the line references
     * whenever an order is named.
     */
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrder.id),
    payableId: uuid('payable_id').references(() => payable.id),

    /**
     * §8.6 — the benefiting department owns this document. Not nullable: a
     * confirmation with no owner is one nobody is accountable for, which is the
     * failure this document exists to prevent.
     */
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    /** When the service was performed — not when it was typed in. */
    serviceDate: date('service_date').notNull(),
    /** The supplier's timesheet, report or completion note. */
    supplierReference: text('supplier_reference'),
    note: text('note'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('service_receipt_no_uniq').on(t.receiptNo),
    index('service_receipt_order_idx').on(t.purchaseOrderId, t.status),
    check(
      'service_receipt_answers_to_something',
      sql`${t.purchaseOrderId} is not null or ${t.payableId} is not null`,
    ),
    index('service_receipt_department_idx').on(t.departmentCode, t.status),

    check(
      'service_receipt_approval_complete',
      sql`(${t.approvedBy} is null and ${t.approvedAt} is null)
          or (${t.approvedBy} is not null and ${t.approvedAt} is not null)`,
    ),

    // §3.2 and §5.4 — a reversal states its reason, or it is not a record of a
    // decision.
    check(
      'service_receipt_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),
  ],
);

export const serviceReceiptLine = pgTable(
  'service_receipt_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serviceReceiptId: uuid('service_receipt_id')
      .notNull()
      .references(() => serviceReceipt.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** The ordered line being confirmed — when an order exists (§8.2, §9.2). */
    purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLine.id),

    description: text('description').notNull(),
    /**
     * How much of the ordered line was delivered — hours, months, one whole
     * job. The unit is the order's, because a confirmation that could restate
     * the unit could not be matched against what was agreed.
     */
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /** §4.2 — which cost centre benefits, when the order named one. */
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),
  },
  (t) => [
    uniqueIndex('service_receipt_line_no_uniq').on(t.serviceReceiptId, t.lineNo),
    index('service_receipt_line_po_line_idx').on(t.purchaseOrderLineId),
    check('service_receipt_line_quantity_positive', sql`${t.quantity} > 0`),
  ],
);
