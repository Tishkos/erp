/**
 * Price lists, tax codes and payment terms — Phase 03.6 and 03.7.
 *
 * §4.4: "Effective dates are used for exchange rates, prices, tax rates and
 * approval roles." All three masters here are effective-dated, and all three
 * resolve by the **document's** date rather than by today's — the same rule the
 * exchange-rate engine follows, for the same reason: reprinting a March
 * document must reproduce March.
 */
import { sql } from 'drizzle-orm';
import {
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
import { DUE_DATE_BASIS } from '../../domain/payment-terms';
import { chartOfAccount } from './accounting';
import { item, unitOfMeasure } from './item';

// ---------------------------------------------------------------------------
// 03.6 — price lists
// ---------------------------------------------------------------------------

export const priceList = pgTable(
  'price_list',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    currency: char('currency', { length: 3 }).notNull().default('IQD'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('price_list_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`)],
);

/**
 * §7.3 — a price per item **and unit**, effective-dated.
 *
 * Per unit because a box and a piece are different prices, and a price list
 * that priced only the base unit would have every order doing arithmetic that
 * nobody could reproduce.
 */
export const priceListItem = pgTable(
  'price_list_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    priceListCode: text('price_list_code')
      .notNull()
      .references(() => priceList.code, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => item.id),
    uomCode: text('uom_code')
      .notNull()
      .references(() => unitOfMeasure.code),

    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One price per list, item, unit and start date. Two prices starting the
    // same day would make "the price on this date" a matter of which row was
    // read first.
    uniqueIndex('price_list_item_effective_uniq').on(
      t.priceListCode,
      t.itemId,
      t.uomCode,
      t.effectiveFrom,
    ),
    index('price_list_item_lookup_idx').on(t.priceListCode, t.itemId, t.effectiveFrom),
    check('price_list_item_price_non_negative', sql`${t.unitPrice} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 03.7 — tax and charge codes
// ---------------------------------------------------------------------------

export const taxCode = pgTable(
  'tax_code',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    /**
     * §4.3 — recoverable tax is an asset that is reclaimed; non-recoverable tax
     * is a cost. They post to different accounts, and a trigger refuses to let
     * one account serve both.
     */
    isRecoverable: boolean('is_recoverable').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => chartOfAccount.id),
    active: boolean('active').notNull().default(true),
  },
);

/** Effective-dated, so a rate change cannot alter a return already filed. */
export const taxRate = pgTable(
  'tax_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taxCodeRef: text('tax_code')
      .notNull()
      .references(() => taxCode.code, { onDelete: 'cascade' }),
    /** Percentage: 15 is fifteen per cent. Six places for fractional rates. */
    ratePercent: numeric('rate_percent', { precision: 9, scale: 6 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
  },
  (t) => [
    uniqueIndex('tax_rate_effective_uniq').on(t.taxCodeRef, t.effectiveFrom),
    check('tax_rate_non_negative', sql`${t.ratePercent} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 03.7 — payment terms and methods
// ---------------------------------------------------------------------------

export const dueDateBasis = pgEnum('due_date_basis', DUE_DATE_BASIS);

export const paymentTerms = pgTable(
  'payment_terms',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    /** Whether the clock starts at the document date or at month end. */
    basis: dueDateBasis('basis').notNull().default('document_date'),
    /** For a single-payment term. Ignored when instalments exist. */
    dueDays: smallint('due_days').notNull().default(0),

    /**
     * §15 and Appendix D — the early-settlement discount, as *"discount
     * opportunities"*.
     *
     * Both columns or neither: a percentage with no deadline is a discount that
     * never expires, and a deadline with no percentage is worth nothing. The
     * payment proposal reports what an early settlement would save and ranks by
     * it; it does **not** deduct it. Taking a discount means paying less than
     * the invoice says, and where that difference lands is an accounting
     * treatment §28.1 reserves to Finance (D14).
     */
    discountPercent: numeric('discount_percent', { precision: 9, scale: 4 }),
    discountDays: smallint('discount_days'),

    active: boolean('active').notNull().default(true),
  },
  (t) => [
    check('payment_terms_due_days_non_negative', sql`${t.dueDays} >= 0`),
    check(
      'payment_terms_discount_complete',
      sql`(${t.discountPercent} is null and ${t.discountDays} is null)
          or (${t.discountPercent} > 0 and ${t.discountPercent} <= 100 and ${t.discountDays} >= 0)`,
    ),
  ],
);

/**
 * §16 — instalments.
 *
 * The percentages must total 100, checked at commit: the rows arrive one at a
 * time and only the finished set can be judged. Without it a term could leave
 * part of an invoice never falling due.
 */
export const paymentTermInstalment = pgTable(
  'payment_term_instalment',
  {
    termsCode: text('terms_code')
      .notNull()
      .references(() => paymentTerms.code, { onDelete: 'cascade' }),
    sequence: smallint('sequence').notNull(),
    daysAfter: smallint('days_after').notNull(),
    percentage: numeric('percentage', { precision: 5, scale: 2 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.termsCode, t.sequence] }),
    check('payment_term_instalment_sequence_positive', sql`${t.sequence} >= 1`),
    check('payment_term_instalment_days_non_negative', sql`${t.daysAfter} >= 0`),
    check(
      'payment_term_instalment_percentage_range',
      sql`${t.percentage} > 0 and ${t.percentage} <= 100`,
    ),
  ],
);

/** §4.3 — "bank/cash/transfer method, fees". */
export const paymentMethodKind = pgEnum('payment_method_kind', ['bank', 'cash', 'transfer']);

export const paymentMethod = pgTable(
  'payment_method',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    kind: paymentMethodKind('kind').notNull(),
    /** A fee charged for using this method, as a percentage of the amount. */
    feePercent: numeric('fee_percent', { precision: 9, scale: 6 }).notNull().default('0'),
    /** Where the fee posts. Null when no fee is charged. */
    feeAccountId: uuid('fee_account_id').references(() => chartOfAccount.id),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    check('payment_method_fee_non_negative', sql`${t.feePercent} >= 0`),
    // A fee with nowhere to post is a fee nobody accounts for.
    check(
      'payment_method_fee_needs_account',
      sql`${t.feePercent} = 0 or ${t.feeAccountId} is not null`,
    ),
  ],
);
