/**
 * Organisation hierarchy and master data — Phase 03.1, 03.2 and 03.4.
 *
 * §3.1: "one authoritative record and a unique system identifier" per master.
 * §4.1 lists the entities; §2.1 and §2.2 fix which ones exist.
 *
 * Branch and Department were created in Phase 01 because §5.1 scopes every user
 * by them and authorisation could not be built or tested without them. This
 * file gives them the §4.1 attributes they were always going to need, and adds
 * the masters that had nowhere to live until the accounting kernel existed.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch, department } from './platform';
import { chartOfAccount } from './accounting';
import { paymentTerms, priceList } from './pricing';
import { documentStatus } from './workflow';

// ---------------------------------------------------------------------------
// 03.1 — organisation
// ---------------------------------------------------------------------------

/**
 * §2.1 — one legal entity, multiple branches.
 *
 * Exactly one row, enforced by a unique index on a constant. Consolidation
 * across entities is a Phase 16 question and a structural change; making it
 * impossible to add a second entity by accident is the point.
 */
export const company = pgTable(
  'company',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    legalName: text('legal_name').notNull(),
    tradeName: text('trade_name'),
    registrationNo: text('registration_no'),
    taxIdentifier: text('tax_identifier'),
    /** §1.1 — IQD. Held here so the entity states it rather than implying it. */
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('IQD'),
    /** Head office address, as shown on documents (Phase 0 Company Setup). */
    address: text('address'),
    /**
     * Which palette the application wears — one of the presets the stylesheet
     * defines. A company decision rather than a personal one: two people
     * describing the same screen should be looking at the same screen.
     */
    uiPalette: text('ui_palette').notNull().default('sand'),
    /** The highlight colour — pressed, selected, actionable. 0171. */
    uiAccent: text('ui_accent').notNull().default('gold'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('company_code_uniq').on(t.code),
    uniqueIndex('company_singleton').on(sql`(true)`),
    check('company_base_currency_shape', sql`${t.baseCurrency} ~ '^[A-Z]{3}$'`),
    // A palette with no definition renders an unstyled application, and the
    // failure shows on every screen at once with nothing to explain it.
    check(
      'company_ui_palette_known',
      sql`${t.uiPalette} in ('sand', 'classic', 'slate', 'graphite', 'pearl', 'midnight', 'carbon', 'ocean', 'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate', 'ivory_linen', 'glacier', 'sage_white', 'porcelain_rose', 'dune_bronze', 'harbor_mist')`,
    ),
    check(
      'company_ui_accent_known',
      sql`${t.uiAccent} in ('gold', 'red', 'blue', 'green', 'purple')`,
    ),
  ],
);

/**
 * §2.2 — the six business lines. The dimension of the same name reads from here.
 *
 * Revenue and cost accounts sit on the line so that §4.2's "Business Line
 * mandatory for revenue and direct cost accounts" has something to resolve
 * against, and so the posting engine can discriminate on it (§3.3).
 */
export const businessLine = pgTable(
  'business_line',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('business_line_code_shape', sql`${t.code} ~ '^[A-Z0-9_]+$'`)],
);

/**
 * §2.1 — cost centres are independent of departments.
 *
 * Deliberately not a child of department: §2.1 requires them to be reportable
 * separately, and a cost centre that is structurally a department cannot be.
 */
export const costCentre = pgTable(
  'cost_centre',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    /** §4.1 — budget responsibility rests with a person, not a box. */
    ownerUserId: uuid('owner_user_id').references(() => appUser.id),
    branchCode: text('branch_code').references(() => branch.code),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
);

// ---------------------------------------------------------------------------
// 03.4 — warehouses and bins
// ---------------------------------------------------------------------------

/** §9.1 — the six warehouse types. Closed list. */
export const warehouseType = pgEnum('warehouse_type', [
  'main',
  'branch',
  'transit',
  'quarantine',
  'damaged_goods',
  'returns',
]);

export const warehouse = pgTable(
  'warehouse',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    /** §9.1 — a warehouse belongs to exactly one branch; a branch may hold many. */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    warehouseType: warehouseType('warehouse_type').notNull(),
    /**
     * Which stage of an inbound shipment this warehouse holds — Operations
     * block 8. Null for an ordinary warehouse. A property of the warehouse the
     * way being a transit warehouse already is.
     */
    shipmentStage: text('shipment_stage', { enum: ['in_process', 'on_board', 'on_port'] }),
    /** §9.1 — transit stock is owned but not available for sale. */
    isTransit: boolean('is_transit').notNull().default(false),
    /**
     * §9.2 — "Negative inventory is prohibited without exception."
     *
     * The field exists because §4.3 lists it, and is constrained to false so
     * that the exception cannot be granted by configuration. A policy that can
     * be switched off in a screen is not a prohibition.
     */
    allowNegativeStock: boolean('allow_negative_stock').notNull().default(false),
    responsibleUserId: uuid('responsible_user_id').references(() => appUser.id),
    address: text('address'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('warehouse_branch_idx').on(t.branchCode),
    check('warehouse_no_negative_stock', sql`${t.allowNegativeStock} = false`),
    // A transit warehouse is of type transit, and only that type is transit.
    check('warehouse_transit_consistent', sql`${t.isTransit} = (${t.warehouseType} = 'transit')`),
    // At most one warehouse per shipment stage — Operations block 8. The
    // sponsor writes "the On Board warehouse" as though there is exactly one,
    // and this is what makes that true rather than conventional.
    uniqueIndex('warehouse_shipment_stage_uniq')
      .on(t.shipmentStage)
      .where(sql`${t.shipmentStage} is not null`),
  ],
);

export const bin = pgTable(
  'bin',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    code: text('code').notNull(),
    name: text('name'),
    active: boolean('active').notNull().default(true),
  },
  (t) => [uniqueIndex('bin_code_uniq').on(t.warehouseCode, t.code)],
);

// ---------------------------------------------------------------------------
// 03.2 — Business Partner
// ---------------------------------------------------------------------------

/** §6 — the five statuses a partner may hold. */
export const partnerStatus = pgEnum('partner_status', [
  'prospect',
  'active',
  'on_hold',
  'blocked',
  'inactive',
]);

/**
 * §6 — "one record serves CRM, Sales, Finance, Projects, Logistics and Money
 * Transfer", and §3.1 — "one authoritative record and a unique system
 * identifier".
 *
 * Customer and supplier are **roles on one record**, not two records. A company
 * that both buys from you and sells to you is one legal person, and netting
 * their balances is only possible if the system agrees.
 */
export const businessPartner = pgTable(
  'business_partner',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(),
    legalName: text('legal_name').notNull(),
    tradeName: text('trade_name'),

    /** §6 — either, or both. Never neither. */
    isCustomer: boolean('is_customer').notNull().default(false),
    isSupplier: boolean('is_supplier').notNull().default(false),

    status: partnerStatus('status').notNull().default('prospect'),

    registrationNo: text('registration_no'),
    taxIdentifier: text('tax_identifier'),
    email: text('email'),
    phone: text('phone'),
    address: text('address'),

    /** §16 — credit control. Enforced in Phase 06; held here. */
    creditLimitIqd: numeric('credit_limit_iqd', { precision: 19, scale: 4 }),
    creditTermsDays: numeric('credit_terms_days', { precision: 5, scale: 0 }),

    /**
     * §16 acceptance criterion 3 — *"a credit hold immediately affects order
     * confirmation."*
     *
     * Separate from `credit_limit_iqd = 0` and from `status = 'blocked'`, because
     * it says a third thing. A zero limit is a customer with no credit *yet*; a
     * blocked partner cannot be traded with at all; a credit hold is a customer
     * we still sell to for cash but will not supply on credit. Collapsing any two
     * of them would lose a decision somebody made.
     *
     * A credit-limit override does not lift it — only lifting the hold does.
     */
    onCreditHold: boolean('on_credit_hold').notNull().default(false),
    creditHoldReason: text('credit_hold_reason'),
    creditHoldBy: uuid('credit_hold_by').references(() => appUser.id),
    creditHoldAt: timestamp('credit_hold_at', { withTimezone: true }),

    /**
     * §7.3 — "Each Business Partner shall be linked to one designated Price
     * List." One column, so "which price list?" cannot have two answers.
     */
    priceListCode: text('price_list_code').references(() => priceList.code),
    /** §4.3 — the terms their invoices fall due on. */
    paymentTermsCode: text('payment_terms_code').references(() => paymentTerms.code),

    /**
     * §15 — the *"priority"* a payment proposal ranks by. 1 is the most urgent.
     *
     * The mechanism, seeded neutral. §15 names priority as an input to the
     * proposal and never says what the scale means or how it trades against a
     * due date, which makes the scale a business decision (D14). Until it is
     * answered every supplier sits at 5, and the proposal ranks by due date in
     * practice — which is the behaviour nobody has to be told about.
     */
    paymentPriority: smallint('payment_priority').notNull().default(5),

    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('business_partner_code_uniq').on(t.code),
    index('business_partner_name_idx').on(sql`lower(${t.legalName})`),
    index('business_partner_registration_idx').on(t.registrationNo),
    index('business_partner_contact_idx').on(t.email, t.phone),

    // A partner that is neither customer nor supplier is a record with no
    // purpose — §6 gives exactly these two roles.
    check('business_partner_has_role', sql`${t.isCustomer} or ${t.isSupplier}`),
    check('business_partner_payment_priority_range', sql`${t.paymentPriority} between 1 and 9`),
    check(
      'business_partner_credit_limit_non_negative',
      sql`${t.creditLimitIqd} is null or ${t.creditLimitIqd} >= 0`,
    ),
  ],
);

/**
 * §4.4 and §15 — "Supplier bank detail changes require independent verification
 * and approval before payment."
 *
 * Bank details are a separate table for one reason: they need their own
 * approval lifecycle. A change to a supplier's account number is the single
 * highest-value fraud target in an ERP, so a new set of details is *added* in
 * draft and only becomes payable once approved — the previous set stays until
 * then, and stays afterwards as history.
 */
export const partnerBankAccount = pgTable(
  'partner_bank_account',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartner.id, { onDelete: 'cascade' }),

    bankName: text('bank_name').notNull(),
    accountNumber: text('account_number').notNull(),
    iban: text('iban'),
    swift: text('swift'),
    currency: char('currency', { length: 3 }).notNull().default('IQD'),
    accountHolder: text('account_holder'),

    /** Runs through the shared status machine and workflow engine (01.6, 01.7). */
    approvalStatus: documentStatus('approval_status').notNull().default('draft'),
    /** Only an approved, active set of details may be paid to. */
    isActive: boolean('is_active').notNull().default(false),

    /**
     * §15 — bumped by the database whenever a payable field changes, and never
     * by the application.
     *
     * A payment is approved against an account number. If the number moves
     * between approval and execution, the approval no longer covers where the
     * money is about to go — and the only way to notice is to have recorded
     * which version was approved. Phase 07.3 stores this on the batch line and
     * compares it before it sends.
     */
    revision: integer('revision').notNull().default(1),

    createdBy: uuid('created_by').references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('partner_bank_account_partner_idx').on(t.partnerId),
    index('partner_bank_account_number_idx').on(t.accountNumber),
    check('partner_bank_currency_shape', sql`${t.currency} ~ '^[A-Z]{3}$'`),
    // Nothing is payable until it is approved.
    check(
      'partner_bank_active_requires_approval',
      sql`not (${t.isActive} and ${t.approvalStatus} <> 'approved')`,
    ),
  ],
);

/**
 * Appendix B — "role-specific mandatory fields".
 *
 * Which fields a customer must carry, and which a supplier must, is a business
 * decision (§28). The mechanism is built here and seeded empty; the Business
 * Process Owner fills it. Building the rule instead of the mechanism would be
 * the implementation team choosing a business outcome.
 */
export const partnerRoleRequiredField = pgTable(
  'partner_role_required_field',
  {
    role: text('role').notNull(),
    fieldName: text('field_name').notNull(),
  },
  (t) => [
    uniqueIndex('partner_role_required_field_uniq').on(t.role, t.fieldName),
    check('partner_role_required_field_role', sql`${t.role} in ('customer','supplier')`),
  ],
);

// ---------------------------------------------------------------------------
// Project — the master shell only (§4.3). Phase 11 gives it a lifecycle.
// ---------------------------------------------------------------------------

export const PROJECT_STATES = [
  'draft',
  'active',
  'on_hold',
  'closing',
  'closed',
] as const;
export const projectStatus = pgEnum('project_status', PROJECT_STATES);

export const BILLING_METHODS = ['milestone', 'progress', 'time_and_material', 'lump_sum'] as const;
export const billingMethod = pgEnum('project_billing_method', BILLING_METHODS);

/**
 * §4.2's project dimension **and** §10's project master — one record.
 *
 * Phase 02 created this as a dimension so that a posting could be tagged with a
 * project; Phase 11 gave it the contract that makes it a project. They are
 * deliberately the same row: a second table would mean a posting's project and a
 * contract's project were two records that had to be kept in step, and the first
 * time somebody renamed one the reports would disagree.
 *
 * **The baseline columns are written once.** Contract value, budget and the
 * baseline dates are set when the contract is approved and never touched again;
 * variations accumulate in `project_variation` beside them. A baseline that
 * moved with each change order could not answer "how far have we drifted?",
 * which is the only question it exists to answer (§10 acceptance criterion 3).
 */
export const project = pgTable(
  'project',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    /** §10 — the customer the work is for. */
    partnerId: uuid('partner_id').references(() => businessPartner.id),
    branchCode: text('branch_code').references(() => branch.code),
    businessLineCode: text('business_line_code').references(() => businessLine.code),
    active: boolean('active').notNull().default(true),

    // ---- §10, Phase 11: the contract ------------------------------------
    status: projectStatus('status').notNull().default('draft'),
    departmentCode: text('department_code'),
    costCentreCode: text('cost_centre_code'),
    managerUserId: uuid('manager_user_id').references(() => appUser.id),

    /** §10 — where it came from, when it came from an approved opportunity. */
    opportunityId: uuid('opportunity_id'),

    contractValueIqd: numeric('contract_value_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    baselineBudgetIqd: numeric('baseline_budget_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    baselineStartsOn: date('baseline_starts_on'),
    baselineEndsOn: date('baseline_ends_on'),

    billingMethod: billingMethod('billing_method').notNull().default('progress'),
    retentionPercent: numeric('retention_percent', { precision: 9, scale: 4 })
      .notNull()
      .default('0'),
    advanceRecoveryPercent: numeric('advance_recovery_percent', { precision: 9, scale: 4 })
      .notNull()
      .default('0'),
    /**
     * §10 — configuration only, and nothing reads it.
     *
     * Finance must approve the revenue-recognition policy before WIP and
     * progress billing are developed, and §10 forbids IT from inventing the
     * treatment. **D1 is open**, so this column exists to be filled in and no
     * default is seeded — not even a percentage-of-completion one "to be
     * changed later", which is the exact shape of the mistake §28 prevents.
     */
    recognitionMethod: text('recognition_method'),
    /** §10 — whether project spending must name a valid cost code. */
    requiresCostCode: boolean('requires_cost_code').notNull().default(true),

    // ---- REQ-PM-001 PM-1: the definition's type and status profile --------
    /** customer / internal / investment, by its master row (§4). */
    typeCode: text('type_code').notNull().default('CUSTOMER'),
    /** Availability control's warn and stop lines (§7). */
    toleranceProfileCode: text('tolerance_profile_code').notNull().default('STANDARD'),
    description: text('description'),
    /** Where scheduling says the project now stands; the baseline is above. */
    forecastStartsOn: date('forecast_starts_on'),
    forecastEndsOn: date('forecast_ends_on'),
    heldAt: timestamp('held_at', { withTimezone: true }),
    heldBy: uuid('held_by').references(() => appUser.id),
    heldReason: text('held_reason'),
    technicallyCompleteAt: timestamp('technically_complete_at', { withTimezone: true }),
    technicallyCompleteBy: uuid('technically_complete_by').references(() => appUser.id),
    /** One reopen after technical completion, with its reason (§6). */
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenedBy: uuid('reopened_by').references(() => appUser.id),
    reopenedReason: text('reopened_reason'),

    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => appUser.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeNote: text('close_note'),

    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_customer_idx').on(t.partnerId, t.status),
    // One project per opportunity: two would count the same win twice.
    uniqueIndex('project_opportunity_uniq')
      .on(t.opportunityId)
      .where(sql`opportunity_id is not null`),

    check('project_contract_value_not_negative', sql`${t.contractValueIqd} >= 0`),
    check('project_baseline_budget_not_negative', sql`${t.baselineBudgetIqd} >= 0`),
    check(
      'project_percentages_in_range',
      sql`${t.retentionPercent} between 0 and 100
          and ${t.advanceRecoveryPercent} between 0 and 100`,
    ),
    check(
      'project_baseline_dates_ordered',
      sql`${t.baselineStartsOn} is null or ${t.baselineEndsOn} is null
          or ${t.baselineEndsOn} >= ${t.baselineStartsOn}`,
    ),
    check('project_approval_complete', sql`(${t.approvedBy} is null) = (${t.approvedAt} is null)`),
    check(
      'project_closed_is_explained',
      sql`${t.status} <> 'closed'
          or (${t.closedBy} is not null and ${t.closedAt} is not null
              and coalesce(btrim(${t.closeNote}), '') <> '')`,
    ),
  ],
);

/**
 * Extensions to the Phase 01 organisation tables, declared here so the §4.1
 * attributes live with the rest of the organisation.
 *
 * These are additional columns on `branch` and `department`; the tables
 * themselves stay in `platform.ts`, where authorisation depends on them.
 */
export const organisationExtensions = {
  branch,
  department,
  chartOfAccount,
} as const;
