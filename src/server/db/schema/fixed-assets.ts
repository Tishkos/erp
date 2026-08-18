/**
 * Fixed assets — Phase 12, §18, Appendix B, C and E (IAS 16).
 *
 * > §18.2: *"The document shall include Asset Code, Description, Category,
 * > Branch, Department, Cost Centre, Location, Custodian, Acquisition Cost,
 * > Useful Life, Residual Value, Depreciation Method and **mandatory Available
 * > for Use Date**."*
 * > §18.2: *"**No Asset Clearing Account is required** by the approved company
 * > workflow."*
 *
 * **There is no clearing account, and that is a decision already made.** §18.2
 * says the approved company workflow does not use one: Finance creates the Fixed
 * Asset Document directly from approved purchasing evidence, and recognition
 * posts Dr Fixed Asset Cost / Cr the source account with nothing in between.
 * Introducing one because other ERPs have one would be an unapproved change
 * under §28 — so there is no column for it and no account role that could hold
 * it.
 *
 * **Available for Use is a column, not a status derived from a date.** §18.5
 * makes it the earliest date depreciation may begin, and it is separate from the
 * acquisition date on purpose: the gap between buying a machine and commissioning
 * it is a real fact about the asset, and a single date would erase it.
 */
import { sql } from 'drizzle-orm';
import {
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
import { DEPRECIATION_METHODS } from '../../domain/fixed-assets';
import { appUser, branch, department } from './platform';
import { costCentre } from './organisation';
import { chartOfAccount } from './accounting';
import { apInvoice } from './ap-invoice';
import { journalEntry } from './journal';

export const depreciationMethod = pgEnum('depreciation_method', DEPRECIATION_METHODS);

/** Appendix B — the asset lifecycle, in §18.3's own order. */
export const ASSET_STATES = [
  'draft',
  'approved',
  'available_for_use',
  'active',
  'disposed',
  'closed',
  'reversed',
] as const;
export const assetStatus = pgEnum('fixed_asset_status', ASSET_STATES);

// ---------------------------------------------------------------------------
// 12.1 — categories
// ---------------------------------------------------------------------------

/**
 * §18.1 — the category master, carrying the defaults an asset inherits.
 *
 * The account **roles** live here rather than account ids: §3.3's posting
 * profile resolves a role to an account, and hardcoding the account on the
 * category would put a second mapping table beside the one the engine already
 * uses. A category names what kind of account it needs; the profile says which.
 */
export const assetCategory = pgTable(
  'asset_category',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),

    defaultUsefulLifeMonths: integer('default_useful_life_months'),
    defaultResidualPercent: numeric('default_residual_percent', { precision: 9, scale: 4 }),
    defaultMethod: depreciationMethod('default_method').notNull().default('straight_line'),

    /** §3.3 — the roles the posting profile resolves for this category. */
    costAccountRole: text('cost_account_role').notNull().default('fixed_asset_cost'),
    depreciationExpenseRole: text('depreciation_expense_role')
      .notNull()
      .default('depreciation_expense'),
    accumulatedDepreciationRole: text('accumulated_depreciation_role')
      .notNull()
      .default('accumulated_depreciation'),
    impairmentRole: text('impairment_role').notNull().default('impairment_loss'),
    disposalGainRole: text('disposal_gain_role').notNull().default('disposal_gain'),
    disposalLossRole: text('disposal_loss_role').notNull().default('disposal_loss'),

    active: text('active').notNull().default('true'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('asset_category_code_shape', sql`${t.code} ~ '^[A-Z0-9_-]+$'`),
    check('asset_category_name_present', sql`btrim(${t.name}) <> ''`),
    check(
      'asset_category_life_positive',
      sql`${t.defaultUsefulLifeMonths} is null or ${t.defaultUsefulLifeMonths} > 0`,
    ),
    check(
      'asset_category_residual_range',
      sql`${t.defaultResidualPercent} is null
          or (${t.defaultResidualPercent} >= 0 and ${t.defaultResidualPercent} < 100)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 12.2 — the Fixed Asset Document and the register
// ---------------------------------------------------------------------------

/**
 * §18.2 — the Fixed Asset Document, with every field §18.2 names.
 *
 * Thirteen fields, and the thirteenth — Available for Use Date — is the one §18.2
 * calls mandatory. It is `NOT NULL` here, which is the strongest form of that
 * word: an asset with no commissioning date cannot exist, so no depreciation run
 * has to decide what to do about one.
 */
export const fixedAsset = pgTable(
  'fixed_asset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** §18.2 field 1. Issued through the Phase 01 numbering service. */
    assetCode: text('asset_code').notNull(),
    status: assetStatus('status').notNull().default('draft'),

    /** §18.2 field 2. */
    description: text('description').notNull(),
    /** §18.2 field 3. */
    categoryCode: text('category_code')
      .notNull()
      .references(() => assetCategory.code),
    /** §18.2 fields 4–6 — the dimensions depreciation will carry. */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    departmentCode: text('department_code').references(() => department.code),
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),
    /** §18.2 field 7. */
    location: text('location'),
    /** §18.2 field 8 — who holds it, for §20's offboarding clearance. */
    custodianUserId: uuid('custodian_user_id').references(() => appUser.id),

    /** §18.2 field 9. */
    acquisitionCostIqd: numeric('acquisition_cost_iqd', { precision: 19, scale: 4 }).notNull(),
    acquiredOn: date('acquired_on').notNull(),
    /** §18.2 field 10. */
    usefulLifeMonths: integer('useful_life_months').notNull(),
    /** §18.2 field 11. */
    residualValueIqd: numeric('residual_value_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    /** §18.2 field 12. */
    depreciationMethod: depreciationMethod('depreciation_method').notNull(),
    /**
     * §18.2 field 13 — **mandatory.** The earliest date depreciation may begin
     * (§18.5), and deliberately separate from `acquired_on`: the gap between
     * buying a machine and commissioning it is a fact about the asset.
     */
    availableForUseOn: date('available_for_use_on').notNull(),

    /** §18.2 — the purchasing evidence Finance created the document from. */
    apInvoiceId: uuid('ap_invoice_id').references(() => apInvoice.id),
    supplierReference: text('supplier_reference'),

    /** Dr Fixed Asset Cost / Cr the source account. No clearing account (§18.2). */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    disposedOn: date('disposed_on'),
    disposalProceedsIqd: numeric('disposal_proceeds_iqd', { precision: 19, scale: 4 }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('fixed_asset_code_uniq').on(t.assetCode),
    index('fixed_asset_category_idx').on(t.categoryCode, t.status),
    index('fixed_asset_branch_idx').on(t.branchCode, t.status),
    index('fixed_asset_custodian_idx').on(t.custodianUserId),

    check('fixed_asset_description_present', sql`btrim(${t.description}) <> ''`),
    check('fixed_asset_cost_positive', sql`${t.acquisitionCostIqd} > 0`),
    check('fixed_asset_life_positive', sql`${t.usefulLifeMonths} > 0`),
    // §18 — a residual above cost would make the asset appreciate.
    check(
      'fixed_asset_residual_below_cost',
      sql`${t.residualValueIqd} >= 0 and ${t.residualValueIqd} < ${t.acquisitionCostIqd}`,
    ),
    // §18.5 — an asset cannot be available before it was bought.
    check('fixed_asset_available_after_acquired', sql`${t.availableForUseOn} >= ${t.acquiredOn}`),
    check(
      'fixed_asset_disposal_complete',
      sql`(${t.disposedOn} is null) = (${t.disposalProceedsIqd} is null)`,
    ),
    check(
      'fixed_asset_disposed_has_date',
      sql`${t.status} <> 'disposed' or ${t.disposedOn} is not null`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 12.3 — depreciation
// ---------------------------------------------------------------------------

/**
 * §18.4 — one row per asset per period, and the reason a run is idempotent.
 *
 * The unique index on (asset, period end) is what makes running the job twice
 * post once: the second attempt collides rather than charging again. A guard in
 * the job would work until somebody ran two copies of it.
 */
export const assetDepreciation = pgTable(
  'asset_depreciation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => fixedAsset.id, { onDelete: 'cascade' }),

    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    chargeIqd: numeric('charge_iqd', { precision: 19, scale: 4 }).notNull(),
    accumulatedAfterIqd: numeric('accumulated_after_iqd', { precision: 19, scale: 4 }).notNull(),

    /** The dimensions the charge carried — the asset's at the time (§18.4). */
    branchCode: text('branch_code').references(() => branch.code),
    departmentCode: text('department_code').references(() => department.code),
    costCentreCode: text('cost_centre_code').references(() => costCentre.code),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    postedBy: uuid('posted_by')
      .notNull()
      .references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // §18 — one charge per asset per period. This is the idempotence.
    uniqueIndex('asset_depreciation_period_uniq').on(t.assetId, t.periodEnd),
    index('asset_depreciation_period_idx').on(t.periodEnd),
    check('asset_depreciation_charge_not_negative', sql`${t.chargeIqd} >= 0`),
    check('asset_depreciation_period_ordered', sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

// ---------------------------------------------------------------------------
// 12.4 — transfers
// ---------------------------------------------------------------------------

/**
 * §18.5 — *"transfer and disposal retain complete approval and document
 * history."*
 *
 * Both the old and the new dimensions are stored on the transfer, so the history
 * reads without reconstructing it: future depreciation carries the new
 * dimensions and past depreciation keeps the old, which is only checkable if
 * both are written down.
 */
export const assetTransfer = pgTable(
  'asset_transfer',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => fixedAsset.id, { onDelete: 'cascade' }),
    transferredOn: date('transferred_on').notNull(),

    fromBranchCode: text('from_branch_code').references(() => branch.code),
    fromDepartmentCode: text('from_department_code').references(() => department.code),
    fromCostCentreCode: text('from_cost_centre_code').references(() => costCentre.code),
    fromLocation: text('from_location'),
    fromCustodianUserId: uuid('from_custodian_user_id').references(() => appUser.id),

    toBranchCode: text('to_branch_code').references(() => branch.code),
    toDepartmentCode: text('to_department_code').references(() => department.code),
    toCostCentreCode: text('to_cost_centre_code').references(() => costCentre.code),
    toLocation: text('to_location'),
    toCustodianUserId: uuid('to_custodian_user_id').references(() => appUser.id),

    reason: text('reason').notNull(),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_transfer_asset_idx').on(t.assetId, t.transferredOn),
    check('asset_transfer_reason_present', sql`btrim(${t.reason}) <> ''`),
    // §5.2 — the person who asked is not the person who agreed.
    check('asset_transfer_approver_is_another', sql`${t.approvedBy} <> ${t.requestedBy}`),
  ],
);

// ---------------------------------------------------------------------------
// 12.5 — impairment
// ---------------------------------------------------------------------------

/** §18 — impairment, kept apart from depreciation because it reconciles apart. */
export const assetImpairment = pgTable(
  'asset_impairment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => fixedAsset.id, { onDelete: 'cascade' }),

    impairedOn: date('impaired_on').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    carryingValueBeforeIqd: numeric('carrying_value_before_iqd', { precision: 19, scale: 4 })
      .notNull(),
    reason: text('reason').notNull(),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    approvedBy: uuid('approved_by')
      .notNull()
      .references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_impairment_asset_idx').on(t.assetId, t.impairedOn),
    check('asset_impairment_amount_positive', sql`${t.amountIqd} > 0`),
    check('asset_impairment_reason_present', sql`btrim(${t.reason}) <> ''`),
    // §18 — an impairment cannot take an asset below nothing.
    check(
      'asset_impairment_within_carrying_value',
      sql`${t.amountIqd} <= ${t.carryingValueBeforeIqd}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 12.7 — physical verification
// ---------------------------------------------------------------------------

export const assetVerification = pgTable(
  'asset_verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    assetId: uuid('asset_id')
      .notNull()
      .references(() => fixedAsset.id, { onDelete: 'cascade' }),
    verifiedOn: date('verified_on').notNull(),

    /** What the verifier found, against what the register said. */
    found: text('found').notNull(),
    foundLocation: text('found_location'),
    foundCustodianUserId: uuid('found_custodian_user_id').references(() => appUser.id),
    note: text('note'),

    verifiedBy: uuid('verified_by')
      .notNull()
      .references(() => appUser.id),
    /** §18.7 — a variance is approved before the register is touched. */
    varianceApprovedBy: uuid('variance_approved_by').references(() => appUser.id),
    varianceApprovedAt: timestamp('variance_approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('asset_verification_asset_idx').on(t.assetId, t.verifiedOn),
    check('asset_verification_found_shape', sql`${t.found} in ('present', 'missing', 'moved')`),
    check(
      'asset_verification_variance_complete',
      sql`(${t.varianceApprovedBy} is null) = (${t.varianceApprovedAt} is null)`,
    ),
    // A variance needs a note saying what was wrong; a clean verification does not.
    check(
      'asset_verification_variance_is_explained',
      sql`${t.found} = 'present' or coalesce(btrim(${t.note}), '') <> ''`,
    ),
  ],
);
