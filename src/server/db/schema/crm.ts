/**
 * CRM — Phase 08, §6 and Appendix B.
 *
 * > §6: *"A lead can exist without an approved Business Partner; a Sales Order,
 * > Project, invoice or service transaction cannot."*
 * > Appendix B, Opportunity: Open, Qualified, Won, Lost, Closed · effect:
 * > **No posting.**
 *
 * **Nothing in this file has a journal link, and that is the design.** Appendix
 * B says an opportunity has no accounting effect; the way to say that so it
 * stays true is to give these tables nowhere to record one. A `journal_entry_id`
 * column that was always null would be an invitation.
 *
 * **The lead's partner is nullable and the opportunity's is not.** That single
 * difference is §6's rule: interest can exist before a customer does, but the
 * moment somebody puts a value and a probability on it, the company needs to
 * know who they are talking to.
 *
 * **There is no CRM-local customer.** §6 requires *"the same Business Partner
 * record"* as Sales, Finance, Projects, Logistics and Money Transfer, so every
 * table here points at `business_partner`. A CRM copy would be the second
 * version of a customer, and the first thing that would happen is that the two
 * addresses would differ.
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
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { OPPORTUNITY_STAGES } from '../../domain/crm';
import { appUser, branch } from './platform';
import { businessLine, businessPartner } from './organisation';
import { salesOrder } from './sales-order';
import { arInvoice } from './ar-invoice';
import { warrantyRegistration } from './warranty';

export const opportunityStage = pgEnum('opportunity_stage', OPPORTUNITY_STAGES);

export const LEAD_STATES = ['new', 'working', 'qualified', 'converted', 'lost'] as const;
export const leadStatus = pgEnum('lead_status', LEAD_STATES);

// ---------------------------------------------------------------------------
// Catalogues — §6's "campaign and lead source"
// ---------------------------------------------------------------------------

export const leadSource = pgTable(
  'lead_source',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    active: text('active').notNull().default('true'),
  },
  (t) => [check('lead_source_code_shape', sql`${t.code} ~ '^[A-Z0-9_]+$'`)],
);

export const crmCampaign = pgTable(
  'crm_campaign',
  {
    code: text('code').primaryKey(),
    name: text('name').notNull(),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    /** What was spent on it — so a conversion rate can be read against a cost. */
    budgetIqd: numeric('budget_iqd', { precision: 19, scale: 4 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('crm_campaign_code_shape', sql`${t.code} ~ '^[A-Z0-9_-]+$'`),
    check(
      'crm_campaign_dates_ordered',
      sql`${t.startsOn} is null or ${t.endsOn} is null or ${t.endsOn} >= ${t.startsOn}`,
    ),
    check('crm_campaign_budget_not_negative', sql`${t.budgetIqd} is null or ${t.budgetIqd} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 08.1 — leads
// ---------------------------------------------------------------------------

export const lead = pgTable(
  'lead',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    leadNo: text('lead_no').notNull(),
    status: leadStatus('status').notNull().default('new'),

    /**
     * §6 — *"a lead can exist without an approved Business Partner."* Nullable,
     * and that is the whole of the rule: interest before a customer.
     */
    partnerId: uuid('partner_id').references(() => businessPartner.id),

    /** What the lead calls itself, before anybody has approved a partner record. */
    companyName: text('company_name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),
    registrationNo: text('registration_no'),
    /** §6 — one of the five duplicate-detection criteria. */
    bankAccountNumber: text('bank_account_number'),

    leadSourceCode: text('lead_source_code').references(() => leadSource.code),
    campaignCode: text('campaign_code').references(() => crmCampaign.code),
    businessLineCode: text('business_line_code').references(() => businessLine.code),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id),

    note: text('note'),
    /** §6 — a lost lead says why, like a lost opportunity. */
    lostReason: text('lost_reason'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lead_no_uniq').on(t.leadNo),
    index('lead_owner_idx').on(t.ownerUserId, t.status),
    index('lead_partner_idx').on(t.partnerId),
    // The duplicate search reads these, so they are indexed in the shape it
    // compares them in rather than as typed.
    index('lead_phone_idx').on(sql`regexp_replace(${t.phone}, '\\D', '', 'g')`),
    index('lead_email_idx').on(sql`lower(${t.email})`),
    index('lead_registration_idx').on(t.registrationNo),

    check('lead_company_name_present', sql`btrim(${t.companyName}) <> ''`),
    check(
      'lead_lost_has_reason',
      sql`${t.status} <> 'lost' or coalesce(btrim(${t.lostReason}), '') <> ''`,
    ),
    // A converted lead became something, and that something needs a customer.
    check('lead_converted_has_partner', sql`${t.status} <> 'converted' or ${t.partnerId} is not null`),
  ],
);

// ---------------------------------------------------------------------------
// 08.2 — opportunities
// ---------------------------------------------------------------------------

export const opportunity = pgTable(
  'opportunity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityNo: text('opportunity_no').notNull(),
    stage: opportunityStage('stage').notNull().default('open'),

    /** Where it came from, when it came from a lead. */
    leadId: uuid('lead_id').references(() => lead.id),

    /**
     * §6 — an opportunity has a customer. Not nullable, which is the other half
     * of the lead's nullable column and the reason qualification is a real step
     * rather than a label.
     */
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartner.id),

    /** §6 — the business line decides whether this becomes an order or a project. */
    businessLineCode: text('business_line_code')
      .notNull()
      .references(() => businessLine.code),

    leadSourceCode: text('lead_source_code').references(() => leadSource.code),
    campaignCode: text('campaign_code').references(() => crmCampaign.code),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id),

    title: text('title').notNull(),
    expectedValueIqd: numeric('expected_value_iqd', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
    probabilityPercent: smallint('probability_percent').notNull().default(0),
    expectedCloseOn: date('expected_close_on'),
    nextAction: text('next_action'),
    nextActionOn: date('next_action_on'),

    lostReason: text('lost_reason'),
    /** Where it went, once it was won. One of the two, never both. */
    salesOrderId: uuid('sales_order_id').references(() => salesOrder.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('opportunity_no_uniq').on(t.opportunityNo),
    index('opportunity_stage_idx').on(t.stage, t.ownerUserId),
    index('opportunity_partner_idx').on(t.partnerId),
    index('opportunity_lead_idx').on(t.leadId),
    // One opportunity becomes one order. Two would double-count the win.
    uniqueIndex('opportunity_sales_order_uniq')
      .on(t.salesOrderId)
      .where(sql`sales_order_id is not null`),

    check('opportunity_title_present', sql`btrim(${t.title}) <> ''`),
    check('opportunity_value_not_negative', sql`${t.expectedValueIqd} >= 0`),
    check(
      'opportunity_probability_range',
      sql`${t.probabilityPercent} between 0 and 100`,
    ),
    check(
      'opportunity_lost_has_reason',
      sql`${t.stage} <> 'lost' or coalesce(btrim(${t.lostReason}), '') <> ''`,
    ),
    // §6 — a won opportunity became something. Until Phase 11 that is a sales
    // order; the project link arrives with the project master.
    check(
      'opportunity_converted_only_when_won',
      sql`${t.salesOrderId} is null or ${t.stage} in ('won', 'closed')`,
    ),
  ],
);

/** What the customer asked for — §6's *"requested products"*. */
export const opportunityItem = pgTable(
  'opportunity_item',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => opportunity.id, { onDelete: 'cascade' }),
    lineNo: integer('line_no').notNull(),

    /** Free text as well as a code: a customer asks before we have an item. */
    itemCode: text('item_code'),
    description: text('description').notNull(),
    quantity: numeric('quantity', { precision: 24, scale: 6 }),
    estimatedValueIqd: numeric('estimated_value_iqd', { precision: 19, scale: 4 }),
  },
  (t) => [
    uniqueIndex('opportunity_item_line_uniq').on(t.opportunityId, t.lineNo),
    check('opportunity_item_description_present', sql`btrim(${t.description}) <> ''`),
    check('opportunity_item_quantity_positive', sql`${t.quantity} is null or ${t.quantity} > 0`),
  ],
);

// ---------------------------------------------------------------------------
// 08.4 — activities and contacts
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['call', 'meeting', 'email', 'visit', 'note', 'task'] as const;
export const activityKind = pgEnum('crm_activity_kind', ACTIVITY_KINDS);

/**
 * §6 — *"completed activities and stage changes remain in the audit trail."*
 *
 * An activity points at exactly one of a lead, an opportunity, a partner or a
 * case. Four nullable columns with a check, rather than a polymorphic pair, so
 * *"what happened with this customer?"* stays a join and a deleted opportunity
 * cannot leave an activity pointing at nothing.
 */
export const crmActivity = pgTable(
  'crm_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: activityKind('kind').notNull(),

    leadId: uuid('lead_id').references(() => lead.id),
    opportunityId: uuid('opportunity_id').references(() => opportunity.id),
    partnerId: uuid('partner_id').references(() => businessPartner.id),
    caseId: uuid('case_id'),

    subject: text('subject').notNull(),
    detail: text('detail'),
    dueOn: date('due_on'),
    completedAt: timestamp('completed_at', { withTimezone: true }),

    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('crm_activity_lead_idx').on(t.leadId),
    index('crm_activity_opportunity_idx').on(t.opportunityId),
    index('crm_activity_partner_idx').on(t.partnerId),
    index('crm_activity_case_idx').on(t.caseId),
    index('crm_activity_owner_idx').on(t.ownerUserId, t.dueOn),

    check('crm_activity_subject_present', sql`btrim(${t.subject}) <> ''`),
    check(
      'crm_activity_has_one_subject_record',
      sql`(case when ${t.leadId} is not null then 1 else 0 end
           + case when ${t.opportunityId} is not null then 1 else 0 end
           + case when ${t.partnerId} is not null then 1 else 0 end
           + case when ${t.caseId} is not null then 1 else 0 end) = 1`,
    ),
  ],
);

export const crmContact = pgTable(
  'crm_contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartner.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    jobTitle: text('job_title'),
    phone: text('phone'),
    email: text('email'),
    isPrimary: text('is_primary').notNull().default('false'),
    active: text('active').notNull().default('true'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('crm_contact_partner_idx').on(t.partnerId),
    // One primary contact per partner: "who do we call?" cannot have two answers.
    uniqueIndex('crm_contact_primary_uniq')
      .on(t.partnerId)
      .where(sql`is_primary = 'true' and active = 'true'`),
    check('crm_contact_name_present', sql`btrim(${t.name}) <> ''`),
  ],
);

// ---------------------------------------------------------------------------
// 08.7 — after-sales and warranty cases
// ---------------------------------------------------------------------------

export const CASE_STATES = ['open', 'in_progress', 'resolved', 'closed', 'rejected'] as const;
export const caseStatus = pgEnum('crm_case_status', CASE_STATES);

/**
 * §6 — after-sales cases, against the warranty register Phase 06.7 built.
 *
 * **The warranty is referenced, never restated.** Whether cover is still valid
 * is 06.7's calculation from the registration's own dates; a case that carried
 * its own expiry date would be a second answer to the same question, and the two
 * would disagree the first time a warranty was extended.
 */
export const crmCase = pgTable(
  'crm_case',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseNo: text('case_no').notNull(),
    status: caseStatus('status').notNull().default('open'),

    partnerId: uuid('partner_id')
      .notNull()
      .references(() => businessPartner.id),
    /** The registration this case is about, where there is one. */
    warrantyRegistrationId: uuid('warranty_registration_id').references(
      () => warrantyRegistration.id,
    ),
    /** §6 — the case links back to what was sold. */
    arInvoiceId: uuid('ar_invoice_id').references(() => arInvoice.id),
    serialNumber: text('serial_number'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id),

    subject: text('subject').notNull(),
    detail: text('detail'),
    openedOn: date('opened_on').notNull(),
    resolvedOn: date('resolved_on'),
    resolution: text('resolution'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('crm_case_no_uniq').on(t.caseNo),
    index('crm_case_partner_idx').on(t.partnerId, t.status),
    index('crm_case_warranty_idx').on(t.warrantyRegistrationId),

    check('crm_case_subject_present', sql`btrim(${t.subject}) <> ''`),
    check(
      'crm_case_resolved_is_explained',
      sql`${t.status} not in ('resolved', 'closed', 'rejected')
          or (${t.resolvedOn} is not null and coalesce(btrim(${t.resolution}), '') <> '')`,
    ),
    check(
      'crm_case_resolved_not_before_opened',
      sql`${t.resolvedOn} is null or ${t.resolvedOn} >= ${t.openedOn}`,
    ),
  ],
);
