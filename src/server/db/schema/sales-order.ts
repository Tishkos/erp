/**
 * Sales Order — Phase 06.2, §7.2, §7.3 and §7.4.
 *
 * > §7.2: *"External Excel → Sales Order → Automatic Stock Reservation → Pick
 * > List → Goods Issue / Delivery Note → A/R Invoice on the same delivery date
 * > → Customer Receipt."*
 * > §7.4: *"Stock is reserved automatically when the Sales Order is approved. The
 * > system shall not approve a Sales Order when Available Stock is
 * > insufficient."*
 *
 * Three things this table does **not** have, each on purpose:
 *
 * **No unit-price input.** §7.3 says the price *"cannot be edited in the Sales
 * Order"* and §7.7 says the control *"cannot be bypassed through the UI or
 * API"*. The price *is* stored — the order has to record what was agreed — but
 * the service resolves it from the customer's price list, effective on the order
 * date, and the line input type has no price field to submit. A validated field
 * can be bypassed by whatever route the validation was not written for; a field
 * that does not exist cannot.
 *
 * **No header discount.** §7.3: *"discounts are allowed only at line level."* A
 * header discount would be a second way to change the money, applied after the
 * line prices were locked, and the price-list control would mean very little.
 *
 * **No line type.** §7.2: *"the normal product-sale process contains product
 * items only"* — installation, transport and other services are not part of this
 * workflow. So there is no service line to choose: `item_code` is NOT NULL and a
 * trigger refuses an item that is not stocked. A `line_type` column with one
 * legal value would only invite a second.
 *
 * Appendix B gives the effect as **stock reservation** — no accounting entry, and
 * no journal column here to write one into.
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
import { businessLine, businessPartner, costCentre, warehouse } from './organisation';
import { item, unitOfMeasure } from './item';
import { priceList } from './pricing';
import { documentStatus } from './workflow';

export const salesOrder = pgTable(
  'sales_order',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderNo: text('order_no').notNull(),

    /**
     * Appendix B: Draft, Pending Approval, Approved, Partially Delivered,
     * Delivered, Closed, Cancelled — onto §3.2's shared vocabulary:
     *
     *   draft · submitted · approved · partially_executed · executed ·
     *   closed · cancelled
     */
    status: documentStatus('status').notNull().default('draft'),

    customerId: uuid('customer_id')
      .notNull()
      .references(() => businessPartner.id),

    /**
     * The price list the order was priced from, and the date it was priced on.
     *
     * Recorded rather than looked up again later: §7.4's *"Price List locked"*
     * means the customer is charged what they were quoted, and a price list that
     * changes next week must not change an order approved this week.
     */
    priceListCode: text('price_list_code')
      .notNull()
      .references(() => priceList.code),

    /** The branch that owns the order. Lines may deliver from others (§7.2). */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    orderDate: date('order_date').notNull(),
    requestedDeliveryDate: date('requested_delivery_date'),
    currency: text('currency').notNull().default('IQD'),
    /** §4.3 — decides the due date of the invoices this order produces. */
    paymentTermsCode: text('payment_terms_code'),
    customerReference: text('customer_reference'),

    /**
     * §4.2 — the dimensions this sale is attributed to.
     *
     * On the order because that is where somebody knows the answer: which line
     * of business a sale belongs to is decided when it is taken, not when the
     * van arrives. The Delivery Note's COGS posting and the A/R Invoice's
     * revenue posting both read them, so the two cannot disagree about which
     * P&L the sale lands in.
     */
    departmentCode: text('department_code').references(() => department.code),
    businessLineCode: text('business_line_code').references(() => businessLine.code),
    note: text('note'),

    /** The document total, fixed at approval. Lines are the authority. */
    grossIqd: numeric('gross_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    discountIqd: numeric('discount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    netIqd: numeric('net_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    /**
     * §7.3 — the credit-limit override in force when this order was approved.
     *
     * Held on the order, not only on the customer: the question a year later is
     * *"who let this one through?"*, and a customer-level override that has since
     * expired cannot answer it.
     */
    creditOverrideBy: uuid('credit_override_by').references(() => appUser.id),
    creditOverrideAt: timestamp('credit_override_at', { withTimezone: true }),
    creditOverrideReason: text('credit_override_reason'),
    creditOverrideAmountIqd: numeric('credit_override_amount_iqd', { precision: 19, scale: 4 }),
    creditOverrideExpiresOn: date('credit_override_expires_on'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancellationReason: text('cancellation_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('sales_order_no_uniq').on(t.orderNo),
    index('sales_order_customer_idx').on(t.customerId, t.status),
    index('sales_order_status_idx').on(t.status, t.branchCode),

    check(
      'sales_order_cancellation_has_reason',
      sql`(${t.cancelledBy} is null and ${t.cancelledAt} is null)
          or (${t.cancelledBy} is not null and ${t.cancelledAt} is not null
              and coalesce(btrim(${t.cancellationReason}), '') <> '')`,
    ),

    // §16 — an override needs reason, amount, expiry and approver, together.
    // Any subset is a control that was bypassed without a record of who or why.
    check(
      'sales_order_credit_override_complete',
      sql`(${t.creditOverrideBy} is null and ${t.creditOverrideAt} is null
           and ${t.creditOverrideReason} is null and ${t.creditOverrideAmountIqd} is null
           and ${t.creditOverrideExpiresOn} is null)
          or (${t.creditOverrideBy} is not null and ${t.creditOverrideAt} is not null
              and coalesce(btrim(${t.creditOverrideReason}), '') <> ''
              and ${t.creditOverrideAmountIqd} is not null and ${t.creditOverrideAmountIqd} > 0
              and ${t.creditOverrideExpiresOn} is not null)`,
    ),

    check(
      'sales_order_totals_consistent',
      sql`${t.netIqd} = ${t.grossIqd} - ${t.discountIqd}
          and ${t.discountIqd} >= 0 and ${t.grossIqd} >= 0`,
    ),
  ],
);

export const salesOrderLine = pgTable(
  'sales_order_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    salesOrderId: uuid('sales_order_id')
      .notNull()
      .references(() => salesOrder.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** §7.2 — product items only. Not nullable, and stocked (trigger). */
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    description: text('description').notNull(),

    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /**
     * §7.3 — from the price list, resolved by the service. Stored so the order
     * records what was quoted; never accepted from the caller.
     */
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    /** Which price-list row it came from, so the quote can be traced. */
    priceListItemId: uuid('price_list_item_id'),

    /** §7.3 — the discount, and only here. One of the two, never both. */
    discountPercent: numeric('discount_percent', { precision: 9, scale: 4 }),
    discountAmountIqd: numeric('discount_amount_iqd', { precision: 19, scale: 4 }),

    grossIqd: numeric('gross_iqd', { precision: 19, scale: 4 }).notNull(),
    netIqd: numeric('net_iqd', { precision: 19, scale: 4 }).notNull(),

    /**
     * §7.2 — one order may span several branches, warehouses and delivery
     * locations, so all three live on the line.
     */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    deliveryLocation: text('delivery_location'),
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),

    /** Running totals, maintained by delivery and invoicing. */
    reservedQuantity: numeric('reserved_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
    deliveredQuantity: numeric('delivered_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
    invoicedQuantity: numeric('invoiced_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
    closedQuantity: numeric('closed_quantity', { precision: 24, scale: 6 })
      .notNull()
      .default('0'),
  },
  (t) => [
    uniqueIndex('sales_order_line_no_uniq').on(t.salesOrderId, t.lineNo),
    index('sales_order_line_item_idx').on(t.itemCode, t.warehouseCode),

    check('sales_order_line_quantity_positive', sql`${t.quantity} > 0`),
    check('sales_order_line_price_not_negative', sql`${t.unitPrice} >= 0`),

    // §7.3 — a percentage or an amount, not both. Two ways of expressing the
    // same discount leaves the order of application undecided, and the two
    // orders give different answers.
    check(
      'sales_order_line_one_discount_form',
      sql`${t.discountPercent} is null or ${t.discountAmountIqd} is null`,
    ),
    check(
      'sales_order_line_discount_range',
      sql`(${t.discountPercent} is null or (${t.discountPercent} >= 0 and ${t.discountPercent} <= 100))
          and (${t.discountAmountIqd} is null
               or (${t.discountAmountIqd} >= 0 and ${t.discountAmountIqd} <= ${t.grossIqd}))`,
    ),

    check('sales_order_line_net_consistent', sql`${t.netIqd} <= ${t.grossIqd}`),

    // Nothing can be delivered that was not ordered, and nothing invoiced that
    // was not delivered (§7.4).
    check(
      'sales_order_line_progress_ordered',
      sql`${t.deliveredQuantity} >= 0 and ${t.invoicedQuantity} >= 0
          and ${t.closedQuantity} >= 0
          and ${t.invoicedQuantity} <= ${t.deliveredQuantity}
          and ${t.deliveredQuantity} <= ${t.quantity}`,
    ),
  ],
);
