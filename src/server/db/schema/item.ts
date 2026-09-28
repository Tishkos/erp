/**
 * Item / Service master and Bank / Cash accounts — Phase 03.3 and 03.5.
 *
 * Two masters, one file, because both are §4.3 catalogue entries that hang off
 * the accounting kernel: an item resolves to sales and purchase accounts, a
 * bank account resolves to exactly one G/L account.
 *
 * ── The two prohibitions §9 states outright ─────────────────────────────────
 *   §9.3 "Every stock item shall use Serial Number Tracking, Batch Number
 *         Tracking, or both … No-tracking is not allowed."
 *   §9.2 "FIFO is the single valuation method for every item and warehouse."
 *
 * Both are expressed so that the prohibited state cannot be represented. The
 * costing enum has one value; no-tracking is refused by a check. A rule that
 * can be configured away is not a prohibition, it is a default.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { businessPartner } from './organisation';
import { chartOfAccount } from './accounting';

// ---------------------------------------------------------------------------
// 03.3 — units of measure
// ---------------------------------------------------------------------------

export const unitOfMeasure = pgTable('unit_of_measure', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),
});

/** §9.3 — serial, batch, or both. There is no fourth option. */
export const itemTracking = pgEnum('item_tracking', ['serial', 'batch', 'serial_and_batch']);

/**
 * §9.2 — "FIFO is the single valuation method for every item and warehouse."
 *
 * An enum with one value. The column exists because §4.3 lists costing method
 * as an item attribute, and it can hold nothing else — not by validation, but
 * because no other value exists to hold.
 */
export const costingMethod = pgEnum('costing_method', ['fifo']);

export const item = pgTable(
  'item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** §8.3 — "Item selection uses the internal item code." */
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),

    /** Stock item or service. A service has no tracking and no stock. */
    isStock: boolean('is_stock').notNull().default(true),

    /** §9.3 — the base unit everything converts through. */
    baseUomCode: text('base_uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /** §9.3 — mandatory for a stock item, meaningless for a service. */
    tracking: itemTracking('tracking'),
    costingMethod: costingMethod('costing_method').notNull().default('fifo'),

    /** §3.3 — account determination. The posting engine may override by rule. */
    salesAccountId: uuid('sales_account_id').references(() => chartOfAccount.id),
    purchaseAccountId: uuid('purchase_account_id').references(() => chartOfAccount.id),

    /**
     * Where the stock is held, and what it costs when it leaves.
     *
     * Held on the item rather than worked out, because two items on one
     * invoice can belong to different stock and cost accounts and the journal
     * has to know which for each line. Optional here — an item may be raised
     * before Finance has decided — and the document that needs them is what
     * refuses to post without them.
     */
    inventoryAccountId: uuid('inventory_account_id').references(() => chartOfAccount.id),
    cogsAccountId: uuid('cogs_account_id').references(() => chartOfAccount.id),

    /** §7.4 — warranty end date is calculated from the A/R Invoice date. */
    warrantyMonths: smallint('warranty_months'),
    sellingPriceIqd: numeric('selling_price_iqd', { precision: 19, scale: 4 }),
    /** §8.3 — retrieved from the master, never typed on a purchase order. */
    supplierItemCode: text('supplier_item_code'),

    active: boolean('active').notNull().default(true),
    /** Appendix B — "inactive-date enforcement". No document after this date. */
    inactiveFrom: date('inactive_from'),

    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('item_code_uniq').on(t.code),
    index('item_name_idx').on(sql`lower(${t.name})`),
    index('item_supplier_code_idx').on(t.supplierItemCode),

    // §9.3 — no-tracking is not allowed for a stock item.
    check('item_stock_requires_tracking', sql`not ${t.isStock} or ${t.tracking} is not null`),
    // A service tracks nothing: serial numbers on a consultancy hour are noise.
    check('item_service_has_no_tracking', sql`${t.isStock} or ${t.tracking} is null`),
    check(
      'item_warranty_non_negative',
      sql`${t.warrantyMonths} is null or ${t.warrantyMonths} >= 0`,
    ),
    check('item_selling_price_non_negative', sql`${t.sellingPriceIqd} is null or ${t.sellingPriceIqd} >= 0`),
  ],
);

/**
 * §9.3 — "Base UOM, Purchase UOM, Sales UOM, conversion factors, barcodes by
 * UOM."
 *
 * ── Why the conversion is a fraction ────────────────────────────────────────
 * The 03.3 gate requires a conversion to round-trip with no drift: convert to
 * the purchase UOM and back, and get the original quantity. A decimal factor
 * cannot promise that — a box of 3 would store 0.333333 and lose a unit every
 * few thousand. Held as a numerator and denominator, the conversion is exact in
 * both directions because it is never evaluated as a decimal at all.
 */
export const itemUom = pgTable(
  'item_uom',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => item.id, { onDelete: 'cascade' }),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    /** One unit of this UOM equals numerator/denominator base units. */
    conversionNumerator: bigint('conversion_numerator', { mode: 'bigint' }).notNull(),
    // The default is written as SQL rather than as a BigInt literal: the schema
    // generator serialises defaults to JSON, and JSON has no bigint.
    conversionDenominator: bigint('conversion_denominator', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),

    /** §9.3 — barcodes are per UOM: a box and a piece scan differently. */
    barcode: text('barcode'),

    isPurchaseDefault: boolean('is_purchase_default').notNull().default(false),
    isSalesDefault: boolean('is_sales_default').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.uomCode] }),
    // A barcode identifies one item *and one UOM* — scanning a box must not
    // resolve to a piece.
    uniqueIndex('item_uom_barcode_uniq').on(t.barcode).where(sql`${t.barcode} is not null`),
    check('item_uom_conversion_positive', sql`${t.conversionNumerator} > 0 and ${t.conversionDenominator} > 0`),
  ],
);

/**
 * Which suppliers an item can be bought from — Phase 2 requirement 4.
 *
 * *"Each item can be linked to one or more suppliers, with one supplier
 *  identified as the default supplier."*
 *
 * A link table rather than a column on the item, because "one or more" is not
 * something a column can hold, and because the supplier's own code for the
 * item belongs to the *pairing*: the same item has a different code at every
 * supplier who sells it.
 *
 * `item.supplier_item_code` predates this and stays. It is the code of the one
 * supplier an item was first set up against, and Phase 05 reads it; a link row
 * that names the same supplier carries the same string. Nothing is migrated
 * automatically — guessing which supplier an unattributed code belonged to is
 * exactly the kind of invention a master data file should not contain.
 *
 * "One default" is a partial unique index, not a rule in a service. Two rows
 * claiming to be the default is a state the purchase order cannot resolve, so
 * it is a state the database does not permit.
 */
export const itemSupplier = pgTable(
  'item_supplier',
  {
    itemId: uuid('item_id')
      .notNull()
      .references(() => item.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => businessPartner.id),

    /** §8.3 — the supplier's code, retrieved from here rather than typed. */
    supplierItemCode: text('supplier_item_code'),

    /** The supplier a purchase proposes first. At most one per item. */
    isDefault: boolean('is_default').notNull().default(false),
    purchasePriceIqd: numeric('purchase_price_iqd', { precision: 19, scale: 4 }),

    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.itemId, t.supplierId] }),
    // At most one default per item — see the note above.
    uniqueIndex('item_supplier_default_uniq').on(t.itemId).where(sql`${t.isDefault}`),
    index('item_supplier_supplier_idx').on(t.supplierId),
    check(
      'item_supplier_purchase_price_non_negative',
      sql`${t.purchasePriceIqd} is null or ${t.purchasePriceIqd} >= 0`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 03.5 — bank and cash accounts
// ---------------------------------------------------------------------------

export const cashAccountType = pgEnum('cash_account_type', ['bank', 'cash']);

/**
 * §4.3 — "bank, account number, currency, G/L account, branch, statement
 * format, approval limits". §17 — "Cash accounts have custodians, limits and
 * periodic cash counts."
 *
 * Exactly one G/L account each, and no two accounts share one: a bank statement
 * reconciles against a G/L balance, and that is only a reconciliation if the
 * balance belongs to one account.
 */
export const bankCashAccount = pgTable(
  'bank_cash_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    accountType: cashAccountType('account_type').notNull(),

    bankName: text('bank_name'),
    accountNumber: text('account_number'),
    iban: text('iban'),
    swift: text('swift'),
    /** §17 — "Bank account currency must match payment currency." */
    currency: char('currency', { length: 3 }).notNull().default('IQD'),

    /** The G/L account this cash position is carried in. */
    glAccountId: uuid('gl_account_id')
      .notNull()
      .references(() => chartOfAccount.id),

    /** §17 — a cash account without a custodian is nobody's responsibility. */
    custodianUserId: uuid('custodian_user_id').references(() => appUser.id),
    /** §17 — the ceiling a cash float may hold. */
    cashLimitIqd: numeric('cash_limit_iqd', { precision: 19, scale: 4 }),
    /** §4.3 — the payment approval ceiling for this account. Phase 07 enforces. */
    approvalLimitIqd: numeric('approval_limit_iqd', { precision: 19, scale: 4 }),

    /** §17 — the format its statements arrive in, for Phase 07 import. */
    statementFormat: text('statement_format'),

    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('bank_cash_account_code_uniq').on(t.code),
    // One G/L account, one cash position.
    uniqueIndex('bank_cash_account_gl_uniq').on(t.glAccountId),
    // §4.4 — duplicate account numbers are caught before they are saved, not
    // discovered when a payment goes to the wrong place.
    uniqueIndex('bank_cash_account_number_uniq')
      .on(t.accountNumber)
      .where(sql`${t.accountNumber} is not null`),

    check('bank_cash_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // §17 — custody is what makes a cash float auditable.
    check(
      'bank_cash_cash_needs_custodian',
      sql`${t.accountType} <> 'cash' or ${t.custodianUserId} is not null`,
    ),
    // A bank account without a number cannot be reconciled to a statement.
    check(
      'bank_cash_bank_needs_number',
      sql`${t.accountType} <> 'bank' or ${t.accountNumber} is not null`,
    ),
    check(
      'bank_cash_limits_non_negative',
      sql`(${t.cashLimitIqd} is null or ${t.cashLimitIqd} >= 0)
          and (${t.approvalLimitIqd} is null or ${t.approvalLimitIqd} >= 0)`,
    ),
  ],
);
