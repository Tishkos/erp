/**
 * A/P Invoice and the three-way match — Phase 05.4 and 05.5, §8.4 and §15.
 *
 * > §8.4: *"Every A/P Invoice must be created from both a Purchase Order and
 * > Goods Receipt, or from a Purchase Order and Service Receipt / Expense
 * > Confirmation. Three-Way Matching is mandatory. Quantity, price and value
 * > variances are allowed only after manager approval."*
 *
 * **Match status is its own axis, not a document status.** Appendix B lists the
 * invoice's statuses as *Draft, Matched, Exception, Pending Approval, Posted,
 * Partially Paid, Paid, Reversed* — but "Matched" and "Exception" answer a
 * different question from the rest. The others say where the document is in its
 * approval; these say whether the three documents agree. An invoice can be a
 * *draft in exception* or a *submitted match*, and squeezing both onto one
 * column would make those unrepresentable.
 *
 * So §3.2's shared vocabulary carries the workflow —
 *
 *   draft · submitted (Pending Approval) · posted · partially_executed
 *   (Partially Paid) · settled (Paid) · reversed
 *
 * — and `match_status` carries the match, recomputed whenever a line changes
 * and **visible at all times**, which is the 05.4 gate's own requirement.
 *
 * **The variance posts to a variance account, never into inventory** (§8.4,
 * Appendix C). Inventory was valued at the PO price when the goods arrived
 * (05.2); letting an invoice quietly restate that would make the FIFO layers
 * and the inventory control account disagree, and §9.9's reconciliation is
 * built on their agreeing.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner, costCentre, warehouse } from './organisation';
import { bankCashAccount, item, unitOfMeasure } from './item';
import { documentStatus } from './workflow';
import { chartOfAccount } from './accounting';
import { journalEntry } from './journal';
import { purchaseOrder, purchaseOrderLine } from './purchase-order';
import { expenseCategory, payable } from './payables';
import { recurringContract } from './payables-contracts';
import { currency } from './fiscal';
// (charged_to_payable_id on the line also references payable — §9.2, §20.2.)

/** Appendix B's Matched / Exception, on its own axis. */
export const MATCH_STATUSES = ['matched', 'exception'] as const;
export const matchStatus = pgEnum('match_status', MATCH_STATUSES);

/** §8.4 — the three variances a match can raise. */
export const VARIANCE_KINDS = ['quantity', 'price', 'value'] as const;
export const varianceKind = pgEnum('variance_kind', VARIANCE_KINDS);

/**
 * §8.4's match tolerance, as configuration.
 *
 * Separate from `purchase_receipt_tolerance`: that one governs what the
 * *warehouse* may accept at the gate, this one governs what *Finance* may pay
 * without asking. They are set by different people for different reasons, and a
 * single figure serving both would be wrong for one of them.
 *
 * All three default to zero, because §8.4 allows no variance without a manager.
 */
export const apMatchTolerance = pgTable(
  'ap_match_tolerance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Null is the company-wide default. */
    supplierId: uuid('supplier_id').references(() => businessPartner.id),
    quantityPercent: numeric('quantity_percent', { precision: 9, scale: 4 })
      .notNull()
      .default('0'),
    pricePercent: numeric('price_percent', { precision: 9, scale: 4 }).notNull().default('0'),
    valuePercent: numeric('value_percent', { precision: 9, scale: 4 }).notNull().default('0'),
    note: text('note'),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ap_match_tolerance_supplier_uniq')
      .on(t.supplierId)
      .where(sql`supplier_id is not null`),
    uniqueIndex('ap_match_tolerance_default_uniq')
      .on(sql`(true)`)
      .where(sql`supplier_id is null`),
    check(
      'ap_match_tolerance_range',
      sql`${t.quantityPercent} between 0 and 100
          and ${t.pricePercent} between 0 and 100
          and ${t.valuePercent} between 0 and 100`,
    ),
  ],
);

export const apInvoice = pgTable(
  'ap_invoice',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Our number. Allocated by the Phase 01.5 sequence service. */
    invoiceNo: text('invoice_no').notNull(),
    /**
     * §15 — *"Supplier invoice number is unique per supplier unless a
     * controlled duplicate exception is approved."* Theirs, as printed.
     */
    supplierInvoiceNo: text('supplier_invoice_no').notNull(),

    status: documentStatus('status').notNull().default('draft'),
    /** 05.4 gate — *"Match status is visible on the invoice at all times."* */
    matchStatus: matchStatus('match_status').notNull().default('exception'),

    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    /**
     * §8.4 makes this mandatory; §15 allows the exception —
     * *"Non-PO invoices require stronger approval and expense evidence."*
     * Nullable for that route alone, and the CHECK below makes the exception
     * cost something: no order means a justification and an approver.
     */
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrder.id),

    /**
     * REQ-AP-001 §5.1 — the payable this invoice belongs to. One invoice
     * belongs to at most one payable; one payable may hold several invoices
     * (a rent paid in two, an import invoiced -A / -B). Nullable: an invoice
     * outside the payables module carries nothing.
     */
    payableId: uuid('payable_id').references(() => payable.id),

    /**
     * REQ-AP-001 §8, D13 — the accountant ticks *Import* on the supplier's
     * invoice and the import application is created behind it in the same
     * transaction. The CHECK in migration 0231 holds the pairing: an import
     * invoice always has its application.
     */
    isImport: boolean('is_import').notNull().default(false),

    /**
     * D12 — expenses are purchase invoices. The type of fee (rent, freight
     * forwarding, customs brokerage …) is the expense category; it carries the
     * default expense account the line posts to.
     */
    expenseCategoryCode: text('expense_category_code').references(() => expenseCategory.code),

    /**
     * §10, D12 — a contract period is an invoice that knows its contract and
     * its period. One invoice per contract per period (partial unique index).
     */
    recurringContractId: uuid('recurring_contract_id').references(() => recurringContract.id),
    periodStart: date('period_start'),
    periodEnd: date('period_end'),
    /** REQ-PM-001 §8 — the project, the element and the cost code the purchase is assigned to; the three together, or none. */
    projectCode: text('project_code'),
    wbsCode: text('wbs_code'),
    costCode: text('cost_code'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    invoiceDate: date('invoice_date').notNull(),
    /** §4.3 — from the supplier's payment terms. */
    dueDate: date('due_date').notNull(),
    /**
     * When somebody set the due date on purpose (0272).
     *
     * The column above cannot be empty, so an invoice entered on advance terms
     * carries the day it was entered. Until this is stamped — by
     * `setDueDate` and by nothing else — the invoice has no due date to show.
     */
    dueDateSetAt: timestamp('due_date_set_at', { withTimezone: true }),

    /*
     * The accounts this invoice names for itself — by direction, 2026-09-22.
     *
     * Null means "as configured": the supplier payable mapping for the
     * statement side, and the expense mapping for a service line. A stock
     * line is not covered — its debit is the item's inventory account, so the
     * warehouse and the ledger hold one figure rather than two.
     */
    payableAccountId: uuid('payable_account_id').references(() => chartOfAccount.id),
    expenseAccountId: uuid('expense_account_id').references(() => chartOfAccount.id),
    currency: text('currency').notNull().default('IQD'),
    /**
     * What the supplier's invoice was actually agreed in, and what one unit of
     * it was worth in dinars on the invoice's own date (0272).
     *
     * A record of where the dinars on the lines came from — null when they
     * were typed as dinars, which is the ordinary case. `currency` above is
     * the invoice's ledger currency and the posting reads it; these two are a
     * different fact and keep their own columns.
     */
    agreedCurrency: text('agreed_currency').references(() => currency.code),
    agreedRate: numeric('agreed_rate', { precision: 19, scale: 8 }),
    note: text('note'),

    /**
     * What the supplier is owed, in IQD — the sum of the lines, fixed when the
     * invoice posts.
     *
     * Stored rather than summed on demand because it is the denominator of
     * every A/P question: the ageing, the payment run, and what an advance may
     * settle against (§8.5). A total that could drift from the lines would make
     * all three disagree, so the lines are frozen at the same moment.
     */
    totalIqd: numeric('total_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /**
     * The advance paid in front, as a percentage of this invoice — §15.3, by
     * direction 2026-10-03.
     *
     * Not a commission: a commission is what a bank charges for its own
     * service, an advance is part of the price of the goods paid early, and
     * they post to different places. The field the sponsor described was
     * called the wrong thing and the name was worth correcting.
     *
     * The account and the method are here for the same reason the percent is:
     * a payment application cannot exist without saying where the money
     * leaves from and how it travels, so the invoice asks once and the
     * application is raised without a second form.
     */
    advancePercent: numeric('advance_percent', { precision: 9, scale: 4 }),
    advancePaidFromAccountId: uuid('advance_paid_from_account_id').references(() => bankCashAccount.id),
    advancePaymentMethodCode: text('advance_payment_method_code'),
    /** The application it raised, so a second posting raises no second advance. */
    advanceApplicationId: uuid('advance_application_id'),

    /**
     * How much of the total has been discharged — by supplier advances (§8.5)
     * and, from 05.9, by payments. `total_iqd − settled_amount_iqd` is what is
     * still owed.
     */
    settledAmountIqd: numeric('settled_amount_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),

    /** §8.4 — the money the match found, which posts to the variance account. */
    varianceValueIqd: numeric('variance_value_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    /** A manager accepting the variance, and why (§8.4). */
    varianceApprovedBy: uuid('variance_approved_by').references(() => appUser.id),
    varianceApprovedAt: timestamp('variance_approved_at', { withTimezone: true }),
    varianceApprovalReason: text('variance_approval_reason'),

    /** §15 — the controlled duplicate exception. */
    duplicateApprovedBy: uuid('duplicate_approved_by').references(() => appUser.id),
    duplicateApprovedAt: timestamp('duplicate_approved_at', { withTimezone: true }),
    duplicateApprovalReason: text('duplicate_approval_reason'),

    /** §15 — the non-PO route's evidence and stronger approval. */
    /**
     * True when every line names a warehouse, so the invoice is itself the
     * receipt and §15's non-PO evidence is the document being approved —
     * Operations block 4. Set by the service from the lines it just wrote.
     */
    receivesOwnStock: boolean('receives_own_stock').notNull().default(false),
    nonPoJustification: text('non_po_justification'),
    nonPoApprovedBy: uuid('non_po_approved_by').references(() => appUser.id),
    nonPoApprovedAt: timestamp('non_po_approved_at', { withTimezone: true }),

    /** Appendix C — written when the invoice posts, in the same transaction. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ap_invoice_no_uniq').on(t.invoiceNo),
    index('ap_invoice_supplier_idx').on(t.supplierId, t.status),
    index('ap_invoice_match_idx').on(t.matchStatus, t.status),
    index('ap_invoice_order_idx').on(t.purchaseOrderId),

    // §15 — one invoice number per supplier. A *partial* unique index, so an
    // approved duplicate exception is the only way a second one exists, and
    // "approved" is a column rather than a promise.
    uniqueIndex('ap_invoice_supplier_number_uniq')
      .on(t.supplierId, t.supplierInvoiceNo)
      .where(sql`duplicate_approved_by is null`),

    check(
      'ap_invoice_variance_approval_complete',
      sql`(${t.varianceApprovedBy} is null and ${t.varianceApprovedAt} is null
           and ${t.varianceApprovalReason} is null)
          or (${t.varianceApprovedBy} is not null and ${t.varianceApprovedAt} is not null
              and coalesce(btrim(${t.varianceApprovalReason}), '') <> '')`,
    ),

    check(
      'ap_invoice_duplicate_approval_complete',
      sql`(${t.duplicateApprovedBy} is null and ${t.duplicateApprovedAt} is null
           and ${t.duplicateApprovalReason} is null)
          or (${t.duplicateApprovedBy} is not null and ${t.duplicateApprovedAt} is not null
              and coalesce(btrim(${t.duplicateApprovalReason}), '') <> '')`,
    ),

    // §15 — an invoice with no purchase order takes the stronger route: it
    // states why, and somebody other than the raiser has approved that.
    //
    // Unless it receives its own stock, when the receipt §15 wants evidence of
    // is this document. The charge is then held by block 4's own control: "the
    // invoice is not posted until CEO approval", which is a separate verb.
    check(
      'ap_invoice_non_po_needs_justification',
      sql`${t.purchaseOrderId} is not null
          or ${t.receivesOwnStock}
          or (coalesce(btrim(${t.nonPoJustification}), '') <> ''
              and ${t.nonPoApprovedBy} is not null
              and ${t.nonPoApprovedAt} is not null)`,
    ),

    check(
      'ap_invoice_reversal_has_reason',
      sql`(${t.reversedBy} is null and ${t.reversedAt} is null)
          or (${t.reversedBy} is not null and ${t.reversedAt} is not null
              and coalesce(btrim(${t.reversalReason}), '') <> '')`,
    ),

    check('ap_invoice_due_not_before_invoice', sql`${t.dueDate} >= ${t.invoiceDate}`),

    // §8.5 — an invoice can be settled down to zero and no further. Settling
    // past it would create a credit balance on a debt, which is a supplier
    // credit memo (05.7) and a different document.
    check(
      'ap_invoice_not_over_settled',
      sql`${t.settledAmountIqd} >= 0 and ${t.settledAmountIqd} <= ${t.totalIqd}`,
    ),
  ],
);

export const apInvoiceLine = pgTable(
  'ap_invoice_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apInvoiceId: uuid('ap_invoice_id')
      .notNull()
      .references(() => apInvoice.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** Null only on the §15 non-PO route. */
    purchaseOrderLineId: uuid('purchase_order_line_id').references(() => purchaseOrderLine.id),

    /**
     * REQ-AP-001 §9.2, §20.2 — a line whose cost belongs to an import. The
     * expense parks in the landed-cost clearing account instead of P&L, and
     * the line becomes a landed-cost charge of that import at posting.
     */
    chargedToPayableId: uuid('charged_to_payable_id').references(() => payable.id),

    itemCode: text('item_code').references(() => item.code),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),

    /** True when this line's cost is stock (Dr GRNI) rather than expense. */
    isInventory: boolean('is_inventory').notNull().default(false),

    /**
     * Where this line receives stock — Operations block 4.
     *
     * Null when the line is not stock, and null when a Goods Receipt already
     * brought the goods in: receiving them again would double the warehouse.
     * A column on the line rather than a setting on the document, because one
     * invoice can carry both kinds.
     */
    warehouseCode: text('warehouse_code').references(() => warehouse.code),

    /**
     * Money off this line. An amount, never a percentage — a percentage has to
     * be multiplied out before it can be posted, and the rounding of that is
     * then a fact nobody recorded. The total is quantity x unit price less
     * this, and is not stored: a stored total is one more thing that can
     * disagree with its own parts.
     */
    discountIqd: numeric('discount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),

    /** The match, per line, so the exception queue can point at one row. */
    matchStatus: matchStatus('match_status').notNull().default('exception'),
    /** The quantity the receipt evidence supports, at match time. */
    receivedQuantity: numeric('received_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
    varianceValueIqd: numeric('variance_value_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (t) => [
    uniqueIndex('ap_invoice_line_no_uniq').on(t.apInvoiceId, t.lineNo),
    index('ap_invoice_line_po_line_idx').on(t.purchaseOrderLineId),
    check('ap_invoice_line_quantity_positive', sql`${t.quantity} > 0`),
    check('ap_invoice_line_price_not_negative', sql`${t.unitPrice} >= 0`),
  ],
);

/**
 * §8.4 — the match exception queue.
 *
 * *"Match exceptions appear in the exception queue with the reason."* A row per
 * variance rather than per invoice, because a manager works through them one
 * decision at a time and an invoice with a quantity problem *and* a price
 * problem is two conversations, often with two different people.
 *
 * Append-only in spirit: an exception is resolved by recording the resolution,
 * never by deleting the row. What was queried and why is part of the audit
 * trail (§5.4) — and a supplier whose invoices raise the same exception every
 * month is a fact worth being able to see.
 */
export const apMatchException = pgTable(
  'ap_match_exception',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apInvoiceId: uuid('ap_invoice_id')
      .notNull()
      .references(() => apInvoice.id, { onDelete: 'cascade' }),
    apInvoiceLineId: uuid('ap_invoice_line_id').references(() => apInvoiceLine.id, {
      onDelete: 'cascade',
    }),

    kind: varianceKind('kind').notNull(),
    /** What the order and receipt say, and what the invoice says. */
    expected: numeric('expected', { precision: 24, scale: 6 }).notNull(),
    actual: numeric('actual', { precision: 24, scale: 6 }).notNull(),
    difference: numeric('difference', { precision: 24, scale: 6 }).notNull(),
    /** §25 — the sentence the manager reads. */
    reason: text('reason').notNull(),

    resolvedBy: uuid('resolved_by').references(() => appUser.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** 'approved' — accepted with a reason; 'corrected' — the invoice changed. */
    resolution: text('resolution'),
    resolutionReason: text('resolution_reason'),

    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('ap_match_exception_invoice_idx').on(t.apInvoiceId),
    index('ap_match_exception_open_idx').on(t.resolvedAt, t.kind),
    check(
      'ap_match_exception_resolution_complete',
      sql`(${t.resolvedBy} is null and ${t.resolvedAt} is null and ${t.resolution} is null)
          or (${t.resolvedBy} is not null and ${t.resolvedAt} is not null
              and ${t.resolution} in ('approved', 'corrected')
              and coalesce(btrim(${t.resolutionReason}), '') <> '')`,
    ),
  ],
);

/**
 * D12 — "Overdue — add a note". A dated, signed line on an invoice that is
 * never edited (append-only by trigger, migration 0231): the whole of "where
 * is it stopped and why" for an expense.
 */
export const apInvoiceNote = pgTable(
  'ap_invoice_note',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    apInvoiceId: uuid('ap_invoice_id')
      .notNull()
      .references(() => apInvoice.id),
    note: text('note').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ap_invoice_note_invoice_idx').on(t.apInvoiceId, t.createdAt)],
);
