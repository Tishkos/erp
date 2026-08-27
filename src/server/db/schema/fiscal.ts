/**
 * Fiscal calendar and exchange rates — Phase 02.2 and 02.3.
 *
 * Two tables answer the two questions every posting asks before it is allowed
 * to exist: *may I post on this date?* and *at what rate?* Neither answer is
 * ever supplied by the document being posted — §14.3 and §14.6 both put the
 * answer somewhere the person posting does not control.
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { PERIOD_STATUSES } from '../../domain/periods';
import { RATE_TYPES } from '../../domain/exchange-rates';
import { appUser } from './platform';

export const periodStatus = pgEnum('period_status', PERIOD_STATUSES);
export const rateType = pgEnum('rate_type', RATE_TYPES);

// ---------------------------------------------------------------------------
// 02.2 — the fiscal calendar
// ---------------------------------------------------------------------------

export const fiscalYear = pgTable(
  'fiscal_year',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Business dates, not timestamps — TECHSTACK A10. Both inclusive. */
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: periodStatus('status').notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fiscal_year_code_uniq').on(t.code),
    check('fiscal_year_dates_ordered', sql`${t.endsOn} > ${t.startsOn}`),
  ],
);

/**
 * The periods a year is divided into. They tile the year exactly: no gap, so
 * every date has a period, and no overlap, so every date has only one. Both are
 * enforced in the migration by an exclusion constraint rather than by hope.
 */
export const fiscalPeriod = pgTable(
  'fiscal_period',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fiscalYearId: uuid('fiscal_year_id')
      .notNull()
      .references(() => fiscalYear.id, { onDelete: 'cascade' }),
    periodNo: smallint('period_no').notNull(),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    /** §14.6 — soft close is the model. */
    status: periodStatus('status').notNull().default('open'),
    statusChangedBy: uuid('status_changed_by').references(() => appUser.id),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('fiscal_period_no_uniq').on(t.fiscalYearId, t.periodNo),
    index('fiscal_period_range_idx').on(t.startsOn, t.endsOn),
    check('fiscal_period_dates_ordered', sql`${t.endsOn} >= ${t.startsOn}`),
    check('fiscal_period_no_positive', sql`${t.periodNo} >= 1`),
  ],
);

/**
 * §24 — "Period-lock override and back-dated posting report."
 *
 * One row per posting that entered a soft-closed period. Append-only: the value
 * of this table is that nobody can tidy it up afterwards.
 */
export const periodOverride = pgTable(
  'period_override',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    fiscalPeriodId: uuid('fiscal_period_id')
      .notNull()
      .references(() => fiscalPeriod.id),
    actorUserId: uuid('actor_user_id')
      .notNull()
      .references(() => appUser.id),
    /** What was posted. Free text until Phase 02.5 gives journals their ids. */
    documentType: text('document_type').notNull(),
    documentId: text('document_id'),
    postingDate: date('posting_date').notNull(),
    reason: text('reason').notNull(),
    branchCode: text('branch_code'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('period_override_period_idx').on(t.fiscalPeriodId, t.occurredAt),
    check('period_override_reason_present', sql`btrim(${t.reason}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 02.3 — currency and rates
// ---------------------------------------------------------------------------

export const currency = pgTable(
  'currency',
  {
    code: char('code', { length: 3 }).primaryKey(),
    name: text('name').notNull(),
    /** Minor units the currency is quoted in. IQD is quoted whole. */
    decimals: smallint('decimals').notNull().default(2),
    /** Display glyph — €, £ — optional; formatting still goes by code. */
    symbol: text('symbol'),
    /** §1.1 — IQD, and only IQD. Enforced by a partial unique index. */
    isLedger: boolean('is_ledger').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
  },
  (t) => [
    check('currency_code_shape', sql`${t.code} ~ '^[A-Z]{3}$'`),
    check('currency_decimals_range', sql`${t.decimals} between 0 and 6`),
  ],
);

/**
 * A published rate, in IQD per one unit of the currency.
 *
 * Immutable. §14.3 keeps rate maintenance in one place; keeping the rows
 * immutable keeps *history* in one state. A mistyped rate is superseded, never
 * edited, so a posting that already used it can still explain itself.
 *
 * numeric(18,8), not the money scale: storing the inverse at 4dp would round
 * 0.000763 to 0.0008 — a ~5% error on every USD reporting figure (§1.1).
 */
export const exchangeRate = pgTable(
  'exchange_rate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    currencyCode: char('currency_code', { length: 3 })
      .notNull()
      .references(() => currency.code),
    rateType: rateType('rate_type').notNull(),
    iqdPerUnit: numeric('iqd_per_unit', { precision: 18, scale: 8 }).notNull(),
    /** Inclusive. Applies until a later effective date supersedes it. */
    effectiveFrom: date('effective_from').notNull(),
    /** §4.3 — where the rate came from, and who entered it. */
    source: text('source'),
    enteredBy: uuid('entered_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when a later correction replaces this row. Never deleted. */
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    supersededBy: uuid('superseded_by').references((): any => exchangeRate.id),
  },
  (t) => [
    // One live rate per currency, type and date. Superseded rows stay, so the
    // partial index is what keeps resolution unambiguous.
    uniqueIndex('exchange_rate_live_uniq')
      .on(t.currencyCode, t.rateType, t.effectiveFrom)
      .where(sql`${t.supersededAt} is null`),
    index('exchange_rate_lookup_idx').on(t.currencyCode, t.rateType, t.effectiveFrom),
    check('exchange_rate_positive', sql`${t.iqdPerUnit} > 0`),
  ],
);
