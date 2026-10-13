/**
 * Project Initiation — the company's Project Guide (2026-10-12, by direction).
 * Migration 0421 holds the rest: the road one stage at a time
 * (`project_initiation_guard`), the frozen lines, the append-only activities,
 * the four eyes at the contract, the row security by branch and the grants.
 *
 * One record per prospective customer project: a direct sale or a tender
 * (`kind`, the guide's Main Project Initiation Selector), the stage it stands
 * at, and what each stage recorded. Converted, it names its project in
 * `project_code`; the project's page reads the Pre-Sales Form, the drawings
 * and the approved BOQ from here.
 */
import { boolean, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { leadSource } from './crm';
import { item } from './item';
import { businessPartner, project } from './organisation';
import { appUser, branch } from './platform';

export const projectInitiation = pgTable(
  'project_initiation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    initiationNo: text('initiation_no').notNull(),
    kind: text('kind').notNull(),
    stage: text('stage').notNull(),
    status: text('status').notNull().default('open'),
    title: text('title').notNull(),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id),

    /** The customer as first heard of — a tender's issuing entity. */
    customerName: text('customer_name').notNull(),
    customerPhone: text('customer_phone'),
    /** The approved business partner, once there is one; a project needs it. */
    partnerId: uuid('partner_id').references(() => businessPartner.id),
    leadSourceCode: text('lead_source_code').references(() => leadSource.code),
    initialContactOn: date('initial_contact_on'),
    leadNote: text('lead_note'),

    // The Pre-Sales Form.
    siteLatitude: numeric('site_latitude', { precision: 9, scale: 6 }),
    siteLongitude: numeric('site_longitude', { precision: 9, scale: 6 }),
    siteGovernorate: text('site_governorate'),
    siteArea: text('site_area'),
    siteKind: text('site_kind'),
    contactName: text('contact_name'),
    contactJobTitle: text('contact_job_title'),
    contactPhone: text('contact_phone'),
    contactPhoneAlt: text('contact_phone_alt'),
    contactEmail: text('contact_email'),
    systemType: text('system_type'),

    surveyOn: date('survey_on'),
    siteVerified: boolean('site_verified').notNull().default(false),
    surveyNote: text('survey_note'),

    boqApprovedBy: uuid('boq_approved_by').references(() => appUser.id),
    boqApprovedAt: timestamp('boq_approved_at', { withTimezone: true }),

    proposalRef: text('proposal_ref'),
    proposalOn: date('proposal_on'),
    proposalValueIqd: numeric('proposal_value_iqd', { precision: 19, scale: 4 }),
    proposalStatus: text('proposal_status'),

    tenderRef: text('tender_ref'),
    tenderDocumentsUrl: text('tender_documents_url'),
    submissionDeadline: date('submission_deadline'),
    qualificationRequirements: text('qualification_requirements'),
    bidBondIqd: numeric('bid_bond_iqd', { precision: 19, scale: 4 }),
    goDecision: text('go_decision'),
    goDecidedBy: uuid('go_decided_by').references(() => appUser.id),
    goDecidedAt: timestamp('go_decided_at', { withTimezone: true }),
    goNote: text('go_note'),
    siteVisitOn: date('site_visit_on'),
    siteVisitMinutes: text('site_visit_minutes'),
    clarifications: text('clarifications'),
    bidPriceIqd: numeric('bid_price_iqd', { precision: 19, scale: 4 }),
    guaranteeBank: text('guarantee_bank'),
    guaranteeNo: text('guarantee_no'),
    guaranteeIqd: numeric('guarantee_iqd', { precision: 19, scale: 4 }),
    guaranteeExpiresOn: date('guarantee_expires_on'),
    guaranteeStatus: text('guarantee_status'),
    submittedOn: date('submitted_on'),
    submissionRef: text('submission_ref'),
    awardStatus: text('award_status'),
    awardedOn: date('awarded_on'),

    contractRef: text('contract_ref'),
    contractSignedOn: date('contract_signed_on'),
    contractValueIqd: numeric('contract_value_iqd', { precision: 19, scale: 4 }),
    paymentTerms: text('payment_terms'),

    /** The project it became. */
    projectCode: text('project_code').references(() => project.code),
    convertedBy: uuid('converted_by').references(() => appUser.id),
    convertedAt: timestamp('converted_at', { withTimezone: true }),
    lostReason: text('lost_reason'),
    lostBy: uuid('lost_by').references(() => appUser.id),
    lostAt: timestamp('lost_at', { withTimezone: true }),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('project_initiation_no_uniq').on(t.initiationNo),
    index('project_initiation_status_idx').on(t.status, t.kind, t.stage, t.branchCode),
    index('project_initiation_partner_idx').on(t.partnerId),
    index('project_initiation_tender_ref_idx').on(t.tenderRef),
  ],
);

/** The bill of quantities: material, shipping and installation costs. */
export const projectInitiationBoqLine = pgTable(
  'project_initiation_boq_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    initiationId: uuid('initiation_id')
      .notNull()
      .references(() => projectInitiation.id),
    lineNo: integer('line_no').notNull(),
    category: text('category').notNull(),
    itemCode: text('item_code').references(() => item.code),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 6 }).notNull(),
    unit: text('unit'),
    unitCostIqd: numeric('unit_cost_iqd', { precision: 19, scale: 4 }).notNull(),
    amountIqd: numeric('amount_iqd', { precision: 19, scale: 4 }).notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_initiation_boq_line_no_uniq').on(t.initiationId, t.lineNo)],
);

/** The tender's technical Compliance Matrix. */
export const projectInitiationComplianceLine = pgTable(
  'project_initiation_compliance_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    initiationId: uuid('initiation_id')
      .notNull()
      .references(() => projectInitiation.id),
    lineNo: integer('line_no').notNull(),
    clause: text('clause'),
    requirement: text('requirement').notNull(),
    response: text('response'),
    remark: text('remark'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('project_initiation_compliance_line_no_uniq').on(t.initiationId, t.lineNo)],
);

/** Follow-ups, site-visit notes, clarifications and addenda — append-only. */
export const projectInitiationActivity = pgTable(
  'project_initiation_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    initiationId: uuid('initiation_id')
      .notNull()
      .references(() => projectInitiation.id),
    kind: text('kind').notNull(),
    stage: text('stage').notNull(),
    happenedOn: date('happened_on').notNull(),
    summary: text('summary').notNull(),
    nextAction: text('next_action'),
    nextActionOn: date('next_action_on'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('project_initiation_activity_idx').on(t.initiationId, t.happenedOn, t.createdAt)],
);
