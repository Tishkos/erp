/**
 * Projects and contracting — Phase 11, §10, §19 and Appendix B.
 *
 * > §10: *"Retention and advances are separate balances, not ordinary revenue or
 * > expense."*
 * > §10: *"Change orders are versioned and require commercial and budget
 * > approval … preserving baseline."*
 * > Appendix B, Project/Contract: *"Status, budget and change control; mandatory
 * > project dimension."*
 *
 * **The baseline columns are never written twice.** Contract value, budget and
 * the baseline dates are set when the contract is approved and are not touched
 * again; variations accumulate beside them. A project whose baseline moved with
 * each change order could not answer *"how far have we drifted?"*, which is the
 * only question a baseline exists to answer.
 *
 * **Retention and advances have their own tables.** §10 says they are separate
 * balances; giving them separate rows rather than columns on the invoice means
 * *"what is held?"* and *"what is still owed of the advance?"* are queries over
 * facts rather than arithmetic over a net figure somebody would have to unpick.
 *
 * **There is no recognition table.** §10 requires Finance to approve the
 * revenue-recognition policy before WIP and progress billing are developed, and
 * D1 is open. The configuration slot exists (`recognition_method` on the
 * project); nothing reads it yet, and no default is seeded.
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, branch } from './platform';
import { project, warehouse } from './organisation';
import { item } from './item';
import { inventoryMovement } from './inventory';
import { purchaseOrder } from './purchase-order';
import { arInvoice } from './ar-invoice';
import { documentStatus } from './workflow';
import { journalEntry } from './journal';
import { chartOfAccount } from './accounting';

/** §10 — the work breakdown structure. A tree; cycles refused by trigger. */
export const projectWbs = pgTable(
  'project_wbs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    parentCode: text('parent_code'),

    /** §10 — who is answerable for this element. */
    responsibleUserId: uuid('responsible_user_id').references(() => appUser.id),
    plannedStartsOn: date('planned_starts_on'),
    plannedEndsOn: date('planned_ends_on'),
    /** §10 — a milestone is a WBS element somebody bills against. */
    isMilestone: text('is_milestone').notNull().default('false'),

    // ---- REQ-PM-001 PM-1: where it sits, and what it may receive (§5) ----
    /** 1 at the top; the parent's plus one below, held by trigger. */
    level: smallint('level').notNull().default(1),
    /** Costs may be planned here. */
    isPlanning: boolean('is_planning').notNull().default(true),
    /** Costs, commitments and issues may be posted here. */
    isAccountAssignment: boolean('is_account_assignment').notNull().default(true),
    /** Certificates and the billing plan hang here. */
    isBilling: boolean('is_billing').notNull().default(false),
    active: boolean('active').notNull().default(true),
    /** PM-2 §7 — the stop line raised for this element, with its reason (D-PM-5). */
    stopPercentRaised: numeric('stop_percent_raised', { precision: 9, scale: 4 }),
    stopRaisedReason: text('stop_raised_reason'),
    stopRaisedBy: uuid('stop_raised_by').references(() => appUser.id),
    stopRaisedAt: timestamp('stop_raised_at', { withTimezone: true }),
    description: text('description'),
    createdBy: uuid('created_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_wbs_code_uniq').on(t.projectCode, t.code),
    index('project_wbs_parent_idx').on(t.projectCode, t.parentCode),
    check('project_wbs_name_present', sql`btrim(${t.name}) <> ''`),
    check('project_wbs_not_own_parent', sql`${t.parentCode} is distinct from ${t.code}`),
    check(
      'project_wbs_dates_ordered',
      sql`${t.plannedStartsOn} is null or ${t.plannedEndsOn} is null
          or ${t.plannedEndsOn} >= ${t.plannedStartsOn}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 11.2 — the budget, and §19's five amounts
// ---------------------------------------------------------------------------

/**
 * §10 — one row per cost code, carrying the baseline and the forecast.
 *
 * Committed and actual are **not** columns here. They are sums over the
 * commitments and the ledger, and a cached copy is the thing that drifts: §10
 * acceptance criterion 2 requires availability to update *immediately* after a
 * commitment or a posting, and the cheapest way to be sure of that is to have
 * nothing to update.
 */
export const projectBudgetLine = pgTable(
  'project_budget_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    costCode: text('cost_code').notNull(),
    description: text('description').notNull(),
    /** The WBS element this budget belongs to, where the project uses one. */
    wbsCode: text('wbs_code'),
    /** The G/L account costs on this code post to. */
    accountId: uuid('account_id').references(() => chartOfAccount.id),

    baselineIqd: numeric('baseline_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    /** §10 — the project manager's view of the final figure. Not availability. */
    forecastIqd: numeric('forecast_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_budget_line_code_uniq').on(t.projectCode, t.costCode),
    check('project_budget_line_description_present', sql`btrim(${t.description}) <> ''`),
    check('project_budget_line_amounts_not_negative', sql`${t.baselineIqd} >= 0 and ${t.forecastIqd} >= 0`),
  ],
);

/**
 * §19 — a commitment: money promised on an approved order, not yet spent.
 *
 * Released when the order closes or is cancelled, which is why the release is a
 * column on the row rather than a deletion: *"what did we commit and when was it
 * released?"* is a question the budget history has to answer.
 */
export const projectCommitment = pgTable(
  'project_commitment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    costCode: text('cost_code').notNull(),
    /** PM-2 §8 — the element the commitment stands on; availability is read there. */
    wbsCode: text('wbs_code'),
    purchaseOrderId: uuid('purchase_order_id').references(() => purchaseOrder.id),
    /** PM-3 §8 — a service or recurring payable without an order is a commitment of its own. */
    payableId: uuid('payable_id'),

    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    /** How much of the commitment has become an actual cost. */
    consumedIqd: numeric('consumed_iqd', { precision: 19, scale: 4 }).notNull().default('0'),

    committedOn: date('committed_on').notNull(),
    releasedOn: date('released_on'),
    releaseReason: text('release_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_commitment_project_idx').on(t.projectCode, t.costCode),
    index('project_commitment_order_idx').on(t.purchaseOrderId),
    check('project_commitment_amount_positive', sql`${t.amountIqd} > 0`),
    check(
      'project_commitment_consumed_within',
      sql`${t.consumedIqd} >= 0 and ${t.consumedIqd} <= ${t.amountIqd}`,
    ),
    check(
      'project_commitment_release_has_reason',
      sql`${t.releasedOn} is null or coalesce(btrim(${t.releaseReason}), '') <> ''`,
    ),
  ],
);

/**
 * Project actual cost — one row per posting that hit the project.
 *
 * Written alongside the journal rather than derived from it, because §10 asks
 * for cost by **WBS element and cost code**, and the ledger carries the project
 * dimension but not the WBS. The journal remains the authority on the money;
 * this is the analysis of it, and the two are written in one transaction.
 */
export const projectCost = pgTable(
  'project_cost',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    costCode: text('cost_code').notNull(),
    wbsCode: text('wbs_code'),

    kind: text('kind').notNull(),
    description: text('description').notNull(),
    incurredOn: date('incurred_on').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),

    /** Where the money is in the ledger — §3.3's drill-down. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    /** PM-3 §8 — the document behind the row (`ap_invoice`, `project_material_issue`, …) and its id. */
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    /** PM-3 — a reversal is a negative row naming the row it undoes; once. */
    reversesCostId: uuid('reverses_cost_id'),
    /** PM-3 — the commitment this cost consumed, given back when the cost is reversed. */
    consumedCommitmentId: uuid('consumed_commitment_id').references(() => projectCommitment.id),
    /** True once the cost has been included in a certificate. */
    billed: text('billed').notNull().default('false'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_cost_project_idx').on(t.projectCode, t.costCode),
    index('project_cost_wbs_idx').on(t.projectCode, t.wbsCode),
    index('project_cost_date_idx').on(t.incurredOn),
    check('project_cost_amount_not_zero', sql`${t.amountIqd} <> 0`),
    check('project_cost_description_present', sql`btrim(${t.description}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 11.7 and 11.8 — progress, certificates and billing
// ---------------------------------------------------------------------------

/** §10 — progress measured per WBS element, by somebody, and approved. */
export const projectProgress = pgTable(
  'project_progress',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    wbsCode: text('wbs_code').notNull(),
    measuredOn: date('measured_on').notNull(),
    percentComplete: numeric('percent_complete', { precision: 9, scale: 4 }).notNull(),

    measuredBy: uuid('measured_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    note: text('note'),
    /** PM-4 §10 — the progress milestone whose approval set this percent. */
    activityId: uuid('activity_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_progress_period_uniq').on(t.projectCode, t.wbsCode, t.measuredOn),
    index('project_progress_project_idx').on(t.projectCode),
    check('project_progress_percent_range', sql`${t.percentComplete} between 0 and 100`),
    check(
      'project_progress_approval_complete',
      sql`(${t.approvedBy} is null) = (${t.approvedAt} is null)`,
    ),
    // §5.2 — the person who measured is not the person who approves.
    check(
      'project_progress_approver_is_another',
      sql`${t.approvedBy} is null or ${t.approvedBy} <> ${t.measuredBy}`,
    ),
  ],
);

/**
 * §10 — the client certificate, and the three figures it produces.
 *
 * Retention and advance recovery are stored, not recomputed, because the terms
 * can change between certificates and each one was issued under the terms of its
 * day. The net is what the customer was asked for.
 */
export const projectCertificate = pgTable(
  'project_certificate',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    certificateNo: text('certificate_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    projectCode: text('project_code')
      .notNull()
      .references(() => project.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    certifiedOn: date('certified_on').notNull(),
    /** Cumulative percentage this certificate takes the project to. */
    percentComplete: numeric('percent_complete', { precision: 9, scale: 4 }).notNull(),

    grossIqd: numeric('gross_iqd', { precision: 19, scale: 4 }).notNull(),
    retentionIqd: numeric('retention_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    advanceRecoveredIqd: numeric('advance_recovered_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    netIqd: numeric('net_iqd', { precision: 19, scale: 4 }).notNull(),

    /** The A/R invoice this certificate became, once it was billed. */
    arInvoiceId: uuid('ar_invoice_id').references(() => arInvoice.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** PM-5 (D-PM-11) — the progress-billing journal the approval posted. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    /** PM-5 — raised from measured progress or from a billing-plan line. */
    basis: text('basis').notNull().default('progress'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_certificate_no_uniq').on(t.certificateNo),
    index('project_certificate_project_idx').on(t.projectCode, t.certifiedOn),

    check('project_certificate_gross_positive', sql`${t.grossIqd} > 0`),
    check('project_certificate_percent_range', sql`${t.percentComplete} between 0 and 100`),
    check(
      'project_certificate_deductions_not_negative',
      sql`${t.retentionIqd} >= 0 and ${t.advanceRecoveredIqd} >= 0`,
    ),
    // The arithmetic §10 asks for, held by the table rather than by the caller.
    check(
      'project_certificate_net_is_the_remainder',
      sql`${t.netIqd} = ${t.grossIqd} - ${t.retentionIqd} - ${t.advanceRecoveredIqd}`,
    ),
    check(
      'project_certificate_deductions_within_gross',
      sql`${t.retentionIqd} + ${t.advanceRecoveredIqd} <= ${t.grossIqd}`,
    ),
  ],
);

/**
 * §10 — *"retention and advances are separate balances, not ordinary revenue or
 * expense."*
 *
 * One row per movement, so the balance is a sum of facts rather than a figure
 * somebody maintains. Retention is withheld by certificates and released by an
 * explicit release; an advance is received and recovered. Both directions are
 * the same shape, which is why one table serves them with a `kind`.
 */
export const PROJECT_BALANCE_KINDS = ['retention', 'advance'] as const;
export const projectBalanceKind = pgEnum('project_balance_kind', PROJECT_BALANCE_KINDS);

export const projectBalanceMovement = pgTable(
  'project_balance_movement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    kind: projectBalanceKind('kind').notNull(),

    /** Positive increases the balance held or owed; negative reduces it. */
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    movedOn: date('moved_on').notNull(),
    description: text('description').notNull(),

    certificateId: uuid('certificate_id').references(() => projectCertificate.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('project_balance_movement_project_idx').on(t.projectCode, t.kind),
    check('project_balance_movement_amount_not_zero', sql`${t.amountIqd} <> 0`),
    check('project_balance_movement_description_present', sql`btrim(${t.description}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 11.9 — variations
// ---------------------------------------------------------------------------

/**
 * §10 — *"change orders are versioned and require commercial and budget
 * approval."*
 *
 * Two approvals, two columns, and both required before the variation counts.
 * Superseded versions are kept: §10 asks for versions to be retained, and a
 * variation that replaced another is only readable if the other is still there.
 */
export const projectVariation = pgTable(
  'project_variation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variationNo: text('variation_no').notNull(),
    status: documentStatus('status').notNull().default('draft'),

    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    version: smallint('version').notNull().default(1),
    /** The version this one replaces, where it replaces one. */
    supersedesId: uuid('supersedes_id'),

    raisedOn: date('raised_on').notNull(),
    description: text('description').notNull(),

    contractDeltaIqd: numeric('contract_delta_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    budgetDeltaIqd: numeric('budget_delta_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    revisedEndsOn: date('revised_ends_on'),

    /** PM-2 §7 — the scope and schedule effect. */
    scopeNote: text('scope_note'),
    scheduleDeltaDays: integer('schedule_delta_days').notNull().default(0),
    rejectedBy: uuid('rejected_by').references(() => appUser.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),

    /** §10 — commercial approval and budget approval, separately. */
    commercialApprovedBy: uuid('commercial_approved_by').references(() => appUser.id),
    commercialApprovedAt: timestamp('commercial_approved_at', { withTimezone: true }),
    budgetApprovedBy: uuid('budget_approved_by').references(() => appUser.id),
    budgetApprovedAt: timestamp('budget_approved_at', { withTimezone: true }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_variation_no_uniq').on(t.variationNo),
    index('project_variation_project_idx').on(t.projectCode, t.status),

    check('project_variation_description_present', sql`btrim(${t.description}) <> ''`),
    check('project_variation_version_positive', sql`${t.version} >= 1`),
    check(
      'project_variation_commercial_complete',
      sql`(${t.commercialApprovedBy} is null) = (${t.commercialApprovedAt} is null)`,
    ),
    check(
      'project_variation_budget_complete',
      sql`(${t.budgetApprovedBy} is null) = (${t.budgetApprovedAt} is null)`,
    ),
    // §10 — approved means *both* approvals are in. One is not enough, and the
    // table says so rather than trusting whoever writes the status.
    check(
      'project_variation_approved_needs_both',
      sql`${t.status} <> 'approved'
          or (${t.commercialApprovedBy} is not null and ${t.budgetApprovedBy} is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// REQ-PM-001 PM-1 — configuration as master data (R4)
// ---------------------------------------------------------------------------

export const PROJECT_KINDS = ['customer', 'internal', 'investment'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

/** §4 — what kind of project: decides the screens that apply and where it settles. */
export const projectType = pgTable(
  'project_type',
  {
    code: text('code').primaryKey(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    kind: text('kind').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('project_type_kind', sql`${t.kind} in ('customer', 'internal', 'investment')`)],
);

/** §7 — availability control: warn at one line, stop at the other. */
export const projectToleranceProfile = pgTable(
  'project_tolerance_profile',
  {
    code: text('code').primaryKey(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    warnPercent: numeric('warn_percent', { precision: 9, scale: 4 }).notNull().default('90'),
    stopPercent: numeric('stop_percent', { precision: 9, scale: 4 }).notNull().default('100'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('project_tolerance_profile_lines', sql`${t.warnPercent} > 0 and ${t.warnPercent} <= ${t.stopPercent} and ${t.stopPercent} <= 200`)],
);

/** §7 — the cost codes a budget line may use, each with the account it posts to. */
export const projectCostCode = pgTable('project_cost_code', {
  code: text('code').primaryKey(),
  nameEn: text('name_en').notNull(),
  nameAr: text('name_ar'),
  accountId: uuid('account_id').references(() => chartOfAccount.id),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').references(() => appUser.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// REQ-PM-001 PM-2 — planning, budget documents, availability control (§7)
// ---------------------------------------------------------------------------

export const BUDGET_DOCUMENT_KINDS = ['original', 'supplement', 'return', 'transfer'] as const;
export type BudgetDocumentKind = (typeof BUDGET_DOCUMENT_KINDS)[number];

/** §7 — the cost plan's versions: 0 the original, 1…n the re-plans; one current. */
export const projectPlanVersion = pgTable(
  'project_plan_version',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    version: smallint('version').notNull(),
    name: text('name').notNull(),
    note: text('note'),
    isCurrent: boolean('is_current').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_plan_version_uniq').on(t.projectCode, t.version),
    uniqueIndex('project_plan_version_current_uniq').on(t.projectCode).where(sql`${t.isCurrent}`),
    check('project_plan_version_number', sql`${t.version} >= 0`),
  ],
);

/** §7 — element × cost code × month: the spread BCWS reads (§10). */
export const projectPlanLine = pgTable(
  'project_plan_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => projectPlanVersion.id, { onDelete: 'cascade' }),
    wbsCode: text('wbs_code').notNull(),
    costCode: text('cost_code')
      .notNull()
      .references(() => projectCostCode.code),
    /** The first day of the month. */
    period: date('period').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_plan_line_uniq').on(t.versionId, t.wbsCode, t.costCode, t.period),
    index('project_plan_line_project_idx').on(t.projectCode, t.wbsCode, t.period),
    check('project_plan_line_amount_not_negative', sql`${t.amountIqd} >= 0`),
  ],
);

/**
 * §7 — the budget as a document: original, supplement, return, transfer.
 * Raised by one person, approved by another (the table holds it); the budget
 * by element is the sum of the approved ones. The original writes
 * `project_budget_line.baseline_iqd` once; nothing else does.
 */
export const projectBudgetDocument = pgTable(
  'project_budget_document',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentNo: text('document_no').notNull(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: documentStatus('status').notNull().default('draft'),
    raisedOn: date('raised_on').notNull(),
    description: text('description').notNull(),
    /** The change order this supplement came from, where it did. */
    variationId: uuid('variation_id').references(() => projectVariation.id),
    /** The sum of the lines: a supplement adds, a return takes, a transfer nets to zero. */
    totalIqd: numeric('total_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rejectedBy: uuid('rejected_by').references(() => appUser.id),
    rejectedAt: timestamp('rejected_at', { withTimezone: true }),
    rejectedReason: text('rejected_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_budget_document_no_uniq').on(t.documentNo),
    index('project_budget_document_project_idx').on(t.projectCode, t.status, t.kind),
    check('project_budget_document_kind', sql`${t.kind} in ('original', 'supplement', 'return', 'transfer')`),
    check('project_budget_document_four_eyes', sql`${t.approvedBy} is null or ${t.approvedBy} <> ${t.createdBy}`),
  ],
);

export const projectBudgetDocumentLine = pgTable(
  'project_budget_document_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => projectBudgetDocument.id, { onDelete: 'cascade' }),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    lineNo: smallint('line_no').notNull(),
    wbsCode: text('wbs_code').notNull(),
    costCode: text('cost_code')
      .notNull()
      .references(() => projectCostCode.code),
    /** Signed: positive adds budget to the element, negative takes it. */
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    description: text('description'),
  },
  (t) => [
    uniqueIndex('project_budget_document_line_uniq').on(t.documentId, t.lineNo),
    index('project_budget_document_line_element_idx').on(t.projectCode, t.wbsCode, t.costCode),
    check('project_budget_document_line_amount_nonzero', sql`${t.amountIqd} <> 0`),
  ],
);

/** §7 — what a change order moves, element by element: the supplement it raises. */
export const projectVariationLine = pgTable(
  'project_variation_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    variationId: uuid('variation_id')
      .notNull()
      .references(() => projectVariation.id, { onDelete: 'cascade' }),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    lineNo: smallint('line_no').notNull(),
    wbsCode: text('wbs_code').notNull(),
    costCode: text('cost_code')
      .notNull()
      .references(() => projectCostCode.code),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    description: text('description'),
  },
  (t) => [
    uniqueIndex('project_variation_line_uniq').on(t.variationId, t.lineNo),
    check('project_variation_line_amount_nonzero', sql`${t.amountIqd} <> 0`),
  ],
);

// ---------------------------------------------------------------------------
// REQ-PM-001 PM-3 — the Material Issues document (§9)
// ---------------------------------------------------------------------------

export const MATERIAL_ISSUE_KINDS = ['issue', 'return'] as const;
export type MaterialIssueKind = (typeof MATERIAL_ISSUE_KINDS)[number];

/**
 * Stock issued from a warehouse to one element at layer cost, or returned
 * at the cost it went out at. Posting the document moves the stock and
 * records the cost line by line, in one transaction (`projects.issueToProject`
 * / `returnFromProject`); each line names its movement and its cost row.
 */
export const projectMaterialIssue = pgTable(
  'project_material_issue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentNo: text('document_no').notNull(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code),
    wbsCode: text('wbs_code').notNull(),
    costCode: text('cost_code')
      .notNull()
      .references(() => projectCostCode.code),
    warehouseCode: text('warehouse_code')
      .notNull()
      .references(() => warehouse.code),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    kind: text('kind').notNull().default('issue'),
    status: documentStatus('status').notNull().default('draft'),
    movementDate: date('movement_date').notNull(),
    description: text('description'),
    totalCostIqd: numeric('total_cost_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_material_issue_no_uniq').on(t.documentNo),
    index('project_material_issue_project_idx').on(t.projectCode, t.status),
    check('project_material_issue_kind', sql`${t.kind} in ('issue', 'return')`),
  ],
);

export const projectMaterialIssueLine = pgTable(
  'project_material_issue_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => projectMaterialIssue.id, { onDelete: 'cascade' }),
    lineNo: smallint('line_no').notNull(),
    itemCode: text('item_code')
      .notNull()
      .references(() => item.code),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    serialNumber: text('serial_number'),
    batchNumber: text('batch_number'),
    /** A return goes back at the cost it went out at (§9): typed on the line, read from the last issue by default. */
    unitCostIqd: numeric('unit_cost_iqd', { precision: 19, scale: 4 }),
    /** Written at posting: the stock movement and the cost row the line became. */
    movementId: uuid('movement_id').references(() => inventoryMovement.id),
    costId: uuid('cost_id').references(() => projectCost.id),
    costIqd: numeric('cost_iqd', { precision: 19, scale: 4 }).notNull().default('0'),
  },
  (t) => [
    uniqueIndex('project_material_issue_line_uniq').on(t.issueId, t.lineNo),
    index('project_material_issue_line_movement_idx').on(t.movementId),
    check('project_material_issue_line_quantity_positive', sql`${t.quantity} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// REQ-PM-001 PM-4 — activities, milestones, the schedule's history (§5)
// ---------------------------------------------------------------------------

export const PROJECT_ACTIVITY_KINDS = ['activity', 'milestone'] as const;
export const MILESTONE_USAGES = ['billing', 'progress', 'date'] as const;
export type MilestoneUsage = (typeof MILESTONE_USAGES)[number];

/**
 * A dated piece of work under an element, or a milestone (zero duration)
 * with its usage. The earliest and latest dates, the float and the
 * critical mark are written by the critical-path pass; the actuals by the
 * people doing the work; a milestone is reached by one person and approved
 * by another.
 */
export const projectActivity = pgTable(
  'project_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    wbsCode: text('wbs_code').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('activity'),
    milestoneUsage: text('milestone_usage'),
    progressPercent: numeric('progress_percent', { precision: 9, scale: 4 }),
    durationDays: integer('duration_days').notNull().default(1),
    notBefore: date('not_before'),
    responsibleUserId: uuid('responsible_user_id').references(() => appUser.id),
    earliestStart: date('earliest_start'),
    earliestFinish: date('earliest_finish'),
    latestStart: date('latest_start'),
    latestFinish: date('latest_finish'),
    totalFloat: integer('total_float'),
    freeFloat: integer('free_float'),
    isCritical: boolean('is_critical').notNull().default(false),
    actualStart: date('actual_start'),
    actualFinish: date('actual_finish'),
    percentComplete: numeric('percent_complete', { precision: 9, scale: 4 }).notNull().default('0'),
    status: text('status').notNull().default('open'),
    reachedOn: date('reached_on'),
    reachedBy: uuid('reached_by').references(() => appUser.id),
    reachedApprovedBy: uuid('reached_approved_by').references(() => appUser.id),
    reachedApprovedAt: timestamp('reached_approved_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_activity_code_uniq').on(t.projectCode, t.code),
    index('project_activity_element_idx').on(t.projectCode, t.wbsCode, t.status),
    check('project_activity_kind', sql`${t.kind} in ('activity', 'milestone')`),
    check('project_activity_status', sql`${t.status} in ('open', 'done', 'cancelled')`),
  ],
);

export const projectActivityDependency = pgTable(
  'project_activity_dependency',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    predecessorId: uuid('predecessor_id')
      .notNull()
      .references(() => projectActivity.id, { onDelete: 'cascade' }),
    successorId: uuid('successor_id')
      .notNull()
      .references(() => projectActivity.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull().default('FS'),
    lagDays: integer('lag_days').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deactivatedBy: uuid('deactivated_by').references(() => appUser.id),
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('project_activity_dependency_uniq').on(t.predecessorId, t.successorId).where(sql`${t.active}`),
    check('project_activity_dependency_kind', sql`${t.kind} in ('FS', 'SS')`),
  ],
);

/** Each milestone's date as it stood at every schedule run — the trend analysis. Append-only. */
export const projectMilestoneHistory = pgTable(
  'project_milestone_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    activityId: uuid('activity_id')
      .notNull()
      .references(() => projectActivity.id, { onDelete: 'cascade' }),
    scheduleRun: integer('schedule_run').notNull(),
    scheduledOn: date('scheduled_on').notNull(),
    reason: text('reason'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_milestone_history_uniq').on(t.activityId, t.scheduleRun)],
);

// ---------------------------------------------------------------------------
// REQ-PM-001 PM-5 — billing plan, recognition, forecast (§11)
// ---------------------------------------------------------------------------

/** A customer project's billing plan: due on a billing milestone or a date, for a share of the contract or an amount. */
export const projectBillingPlanLine = pgTable(
  'project_billing_plan_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    wbsCode: text('wbs_code').notNull(),
    lineNo: smallint('line_no').notNull(),
    description: text('description').notNull(),
    dueTrigger: text('due_trigger').notNull(),
    activityId: uuid('activity_id').references(() => projectActivity.id),
    dueOn: date('due_on'),
    basis: text('basis').notNull(),
    percentOfContract: numeric('percent_of_contract', { precision: 9, scale: 4 }),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }),
    status: text('status').notNull().default('planned'),
    dueSince: date('due_since'),
    certificateId: uuid('certificate_id').references(() => projectCertificate.id),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_billing_plan_line_no_uniq').on(t.projectCode, t.lineNo)],
);

/** D-PM-1 — the method Finance ratifies before any recognition posts. */
export const projectRecognitionPolicy = pgTable('project_recognition_policy', {
  code: text('code').primaryKey(),
  method: text('method').notNull(),
  description: text('description').notNull(),
  ratifiedBy: uuid('ratified_by').references(() => appUser.id),
  ratifiedAt: timestamp('ratified_at', { withTimezone: true }),
  ratifiedNote: text('ratified_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One project and period end: the figures, the journal, and its reversal next period. */
export const projectRecognition = pgTable(
  'project_recognition',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    periodEnd: date('period_end').notNull(),
    contractValueIqd: numeric('contract_value_iqd', { precision: 19, scale: 4 }).notNull(),
    actualIqd: numeric('actual_iqd', { precision: 19, scale: 4 }).notNull(),
    eacIqd: numeric('eac_iqd', { precision: 19, scale: 4 }).notNull(),
    percentComplete: numeric('percent_complete', { precision: 9, scale: 4 }).notNull(),
    recognisedIqd: numeric('recognised_iqd', { precision: 19, scale: 4 }).notNull(),
    billedIqd: numeric('billed_iqd', { precision: 19, scale: 4 }).notNull(),
    adjustmentIqd: numeric('adjustment_iqd', { precision: 19, scale: 4 }).notNull(),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntry.id),
    reversedOn: date('reversed_on'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_recognition_period_uniq').on(t.projectCode, t.periodEnd)],
);

/** §11 — the manager's estimate to complete for an element, dated and reasoned; the latest one counts. */
export const projectEtc = pgTable(
  'project_etc',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectCode: text('project_code')
      .notNull()
      .references(() => project.code, { onDelete: 'cascade' }),
    wbsCode: text('wbs_code').notNull(),
    asOf: date('as_of').notNull(),
    etcIqd: numeric('etc_iqd', { precision: 19, scale: 4 }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_etc_element_idx').on(t.projectCode, t.wbsCode, t.asOf)],
);
