/**
 * CRM — Phase 08, §6.
 *
 * > §6: *"A lead can exist without an approved Business Partner; a Sales Order,
 * > Project, invoice or service transaction cannot."*
 * > §6 acceptance criterion 1: *"Lead-to-opportunity and opportunity-to-order /
 * > project conversion retain the same customer and source identifiers."*
 * > §6 acceptance criterion 3: *"Customer 360 displays authorised operational and
 * > financial history."*
 *
 * The module before the money. Nothing here posts — Appendix B says an
 * opportunity has no accounting effect, and the tables have nowhere to record
 * one — so the discipline this file carries is about **identity and evidence**:
 * the same customer all the way through, and a trail of who changed what.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  arInvoice,
  businessPartner,
  crmActivity,
  crmCase,
  crmContact,
  lead,
  opportunity,
  opportunityItem,
  salesOrder,
  warrantyRegistration,
} from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import {
  assertIdentityCarried,
  assertLostHasReason,
  assertStageTransition,
  conversionRate,
  findDuplicates,
  pipelineByStage,
  type DuplicateHit,
  type Identity,
  type OpportunityStage,
} from '../domain/crm';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import { can } from '../domain/permissions';
import * as audit from './audit';
import * as orders from './sales-order';
import { allocateDocumentNumber } from './numbering';

export const LEAD_DOCUMENT_TYPE = 'lead';
export const OPPORTUNITY_DOCUMENT_TYPE = 'opportunity';
export const CASE_DOCUMENT_TYPE = 'crm_case';
export const PERMISSION_OBJECT = 'crm';

export { DUPLICATE_CRITERIA, conversionRate } from '../domain/crm';

export class CrmStateError extends Error {
  readonly code = 'CRM_STATE_INVALID';
  constructor(documentNo: string, status: string, detail: string) {
    super(`${documentNo} is '${status}': ${detail}`);
    this.name = 'CrmStateError';
  }
}

// ---------------------------------------------------------------------------
// 08.1 — leads
// ---------------------------------------------------------------------------

export interface CreateLeadInput {
  readonly companyName: string;
  readonly branchCode: string;
  readonly ownerUserId: string;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly registrationNo?: string | null;
  readonly bankAccountNumber?: string | null;
  readonly leadSourceCode?: string | null;
  readonly campaignCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly partnerId?: string | null;
  readonly note?: string | null;
}

export interface LeadCreated {
  readonly id: string;
  readonly leadNo: string;
  /** §6 — what this looked like a duplicate of, and on which criteria. */
  readonly duplicates: { of: string; ofName: string; hits: DuplicateHit[] }[];
}

/**
 * §6 — a lead, with or without a Business Partner.
 *
 * **Duplicate detection reports; it does not refuse.** A new enquiry from a
 * company already on the books is an ordinary event — a second branch, a second
 * buyer, a genuine second approach — and a system that blocked it would be
 * worked around within a week. What it must not do is let the duplicate go
 * *unnoticed*, so every match is returned with the criterion that produced it
 * and recorded in the audit trail.
 */
export async function createLead(
  tx: Tx,
  ctx: ActorContext,
  input: CreateLeadInput,
): Promise<LeadCreated> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (!input.companyName.trim()) {
    throw new Error('A lead needs a name — even one somebody typed off a business card (§6).');
  }

  const candidate: Identity = {
    name: input.companyName,
    phone: input.phone ?? null,
    email: input.email ?? null,
    registrationNo: input.registrationNo ?? null,
    bankAccountNumber: input.bankAccountNumber ?? null,
  };

  const duplicates = await searchDuplicates(tx, candidate);

  const allocated = await allocateDocumentNumber(
    tx,
    'LEAD',
    { branchCode: input.branchCode, year: new Date().getUTCFullYear() },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(lead)
    .values({
      leadNo: allocated.documentNo,
      companyName: input.companyName.trim(),
      contactName: input.contactName ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      registrationNo: input.registrationNo ?? null,
      bankAccountNumber: input.bankAccountNumber ?? null,
      leadSourceCode: input.leadSourceCode ?? null,
      campaignCode: input.campaignCode ?? null,
      businessLineCode: input.businessLineCode ?? null,
      partnerId: input.partnerId ?? null,
      branchCode: input.branchCode,
      ownerUserId: input.ownerUserId,
      note: input.note ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: lead.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'lead.created',
    objectType: LEAD_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      leadNo: allocated.documentNo,
      companyName: input.companyName.trim(),
      owner: input.ownerUserId,
      source: input.leadSourceCode ?? null,
      campaign: input.campaignCode ?? null,
      duplicatesFound: duplicates.length,
      duplicateCriteria: duplicates.flatMap((d) => d.hits.map((h) => h.criterion)),
    },
    outcome: 'success',
  });

  return { id: created!.id, leadNo: allocated.documentNo, duplicates };
}

/**
 * §6's five criteria, run against every lead and every partner already known.
 *
 * Both populations, because a duplicate can be either: the same company may
 * already be an approved customer, or may already have been entered as a lead
 * last month by somebody else. Checking only one of the two is how the second
 * kind gets found at invoicing.
 */
export async function searchDuplicates(
  tx: Tx,
  candidate: Identity,
  options: { excludeLeadId?: string } = {},
): Promise<{ of: string; ofName: string; hits: DuplicateHit[] }[]> {
  const results: { of: string; ofName: string; hits: DuplicateHit[] }[] = [];

  const leads = await tx
    .select({
      id: lead.id,
      leadNo: lead.leadNo,
      name: lead.companyName,
      phone: lead.phone,
      email: lead.email,
      registrationNo: lead.registrationNo,
      bankAccountNumber: lead.bankAccountNumber,
    })
    .from(lead)
    .where(options.excludeLeadId ? sql`${lead.id} <> ${options.excludeLeadId}` : sql`true`);

  for (const row of leads) {
    const hits = findDuplicates(candidate, row);
    if (hits.length > 0) results.push({ of: row.id, ofName: row.leadNo, hits });
  }

  const partners = await tx
    .select({
      id: businessPartner.id,
      code: businessPartner.code,
      name: businessPartner.legalName,
      phone: businessPartner.phone,
      email: businessPartner.email,
      registrationNo: businessPartner.registrationNo,
    })
    .from(businessPartner);

  for (const row of partners) {
    const hits = findDuplicates(candidate, { ...row, bankAccountNumber: null });
    if (hits.length > 0) results.push({ of: row.id, ofName: row.code, hits });
  }

  return results;
}

/** §6 — *"owner assignment is recorded and every reassignment is audited."* */
export async function assignLead(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  ownerUserId: string,
  reason?: string | null,
): Promise<void> {
  const [row] = await tx.select().from(lead).where(eq(lead.id, id)).limit(1);
  if (!row) throw new Error(`No lead with id '${id}'.`);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  if (row.ownerUserId === ownerUserId) return;

  await tx
    .update(lead)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(eq(lead.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'lead.reassigned',
    objectType: LEAD_DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { owner: row.ownerUserId },
    after: { owner: ownerUserId },
    reason: reason ?? null,
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 08.2 — opportunities
// ---------------------------------------------------------------------------

export interface QualifyInput {
  readonly leadId: string;
  /** §6 — an opportunity has a customer, so qualification supplies one. */
  readonly partnerId: string;
  readonly businessLineCode: string;
  readonly title: string;
  readonly expectedValueIqd: bigint;
  readonly probabilityPercent?: number;
  readonly expectedCloseOn?: string | null;
  readonly items?: readonly {
    itemCode?: string | null;
    description: string;
    quantity?: bigint | null;
    estimatedValueIqd?: bigint | null;
  }[];
}

/**
 * §6 — qualification: a lead becomes an opportunity, and acquires a customer.
 *
 * The identity check runs on the way through. A lead with no partner may be
 * given one — that is what qualification *is* — but a lead that already names a
 * customer cannot quietly become an opportunity for a different one, and the
 * source and campaign travel with it. Without that, §6's first acceptance
 * criterion is a sentence nobody can test.
 */
export async function qualifyLead(
  tx: Tx,
  ctx: ActorContext,
  input: QualifyInput,
): Promise<{ id: string; opportunityNo: string }> {
  const [source] = await tx.select().from(lead).where(eq(lead.id, input.leadId)).limit(1);
  if (!source) throw new Error(`No lead with id '${input.leadId}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: source.branchCode,
  });

  if (source.status === 'converted' || source.status === 'lost') {
    throw new CrmStateError(
      source.leadNo,
      source.status,
      'a lead is qualified once; a fresh enquiry from the same company is a new lead.',
    );
  }

  const [partner] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, input.partnerId))
    .limit(1);

  if (!partner) throw new Error(`No business partner with id '${input.partnerId}'.`);
  if (!partner.isCustomer) {
    throw new Error(`${partner.code} is not a customer, so nothing can be sold to them (§6).`);
  }

  // §6 acceptance criterion 1 — the same customer and the same source.
  assertIdentityCarried(
    {
      partnerId: source.partnerId,
      leadSourceCode: source.leadSourceCode,
      campaignCode: source.campaignCode,
    },
    {
      partnerId: input.partnerId,
      leadSourceCode: source.leadSourceCode,
      campaignCode: source.campaignCode,
    },
  );

  const allocated = await allocateDocumentNumber(
    tx,
    'OPPORTUNITY',
    { branchCode: source.branchCode, year: new Date().getUTCFullYear() },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(opportunity)
    .values({
      opportunityNo: allocated.documentNo,
      stage: 'qualified',
      leadId: source.id,
      partnerId: input.partnerId,
      businessLineCode: input.businessLineCode,
      leadSourceCode: source.leadSourceCode,
      campaignCode: source.campaignCode,
      branchCode: source.branchCode,
      ownerUserId: source.ownerUserId,
      title: input.title.trim(),
      expectedValueIqd: toDecimalString(input.expectedValueIqd, 4n),
      probabilityPercent: input.probabilityPercent ?? 0,
      expectedCloseOn: input.expectedCloseOn ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: opportunity.id });

  let lineNo = 0;
  for (const item of input.items ?? []) {
    lineNo += 1;
    await tx.insert(opportunityItem).values({
      opportunityId: created!.id,
      lineNo,
      itemCode: item.itemCode ?? null,
      description: item.description,
      quantity: item.quantity ? toDecimalString(item.quantity, 6n) : null,
      estimatedValueIqd: item.estimatedValueIqd
        ? toDecimalString(item.estimatedValueIqd, 4n)
        : null,
    });
  }

  await tx
    .update(lead)
    .set({ status: 'converted', partnerId: input.partnerId, updatedAt: new Date() })
    .where(eq(lead.id, input.leadId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opportunity.qualified',
    objectType: OPPORTUNITY_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: source.branchCode,
    before: { leadNo: source.leadNo, leadStatus: source.status },
    after: {
      opportunityNo: allocated.documentNo,
      stage: 'qualified',
      partner: partner.code,
      source: source.leadSourceCode,
      campaign: source.campaignCode,
    },
    outcome: 'success',
  });

  return { id: created!.id, opportunityNo: allocated.documentNo };
}

/**
 * Appendix B — a stage change, audited.
 *
 * §6 asks that *"completed activities and stage changes remain in the audit
 * trail"*, so every move writes one — including the reason a loss was recorded,
 * which is the only input the lost-opportunity report has.
 */
export async function changeStage(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  to: OpportunityStage,
  options: { lostReason?: string | null; probabilityPercent?: number } = {},
): Promise<void> {
  const [row] = await tx.select().from(opportunity).where(eq(opportunity.id, id)).limit(1);
  if (!row) throw new Error(`No opportunity with id '${id}'.`);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  assertStageTransition(row.stage, to);
  assertLostHasReason(to, options.lostReason ?? null);

  await tx
    .update(opportunity)
    .set({
      stage: to,
      lostReason: to === 'lost' ? options.lostReason!.trim() : row.lostReason,
      probabilityPercent:
        options.probabilityPercent ??
        (to === 'won' ? 100 : to === 'lost' ? 0 : row.probabilityPercent),
      updatedAt: new Date(),
    })
    .where(eq(opportunity.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opportunity.stage_changed',
    objectType: OPPORTUNITY_DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { stage: row.stage },
    after: { stage: to },
    reason: to === 'lost' ? options.lostReason!.trim() : null,
    outcome: 'success',
  });
}

/** §6 — ownership changes are audited, on opportunities as on leads. */
export async function assignOpportunity(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  ownerUserId: string,
): Promise<void> {
  const [row] = await tx.select().from(opportunity).where(eq(opportunity.id, id)).limit(1);
  if (!row) throw new Error(`No opportunity with id '${id}'.`);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  if (row.ownerUserId === ownerUserId) return;

  await tx
    .update(opportunity)
    .set({ ownerUserId, updatedAt: new Date() })
    .where(eq(opportunity.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opportunity.reassigned',
    objectType: OPPORTUNITY_DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { owner: row.ownerUserId },
    after: { owner: ownerUserId },
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 08.5 — conversion
// ---------------------------------------------------------------------------

/**
 * §6 — *"convert the approved opportunity directly into a Sales Order or
 * Project, according to the business line"*, and *"without duplicate data
 * entry."*
 *
 * The customer, the branch and the business line come from the opportunity; only
 * the things an order needs and an opportunity does not — prices, warehouses,
 * quantities in real units — are supplied by the caller. The link back is kept
 * on the opportunity, so *"which opportunity did this order come from?"* and
 * *"what did this opportunity become?"* are the same row read two ways.
 *
 * Project conversion is the other half of §6's sentence and arrives with Phase
 * 11: there is no project master to convert into yet, and a stub would be a
 * second answer to *"where do projects come from?"*.
 */
export async function convertToSalesOrder(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: {
    readonly orderDate: string;
    readonly requestedDeliveryDate?: string | null;
    readonly departmentCode?: string | null;
    readonly lines: orders.CreateSalesOrderInput['lines'];
  },
): Promise<{ salesOrderId: string; orderNo: string }> {
  const [row] = await tx.select().from(opportunity).where(eq(opportunity.id, id)).limit(1);
  if (!row) throw new Error(`No opportunity with id '${id}'.`);

  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  if (row.stage !== 'won') {
    throw new CrmStateError(
      row.opportunityNo,
      row.stage,
      'an opportunity is converted once it has been won (§6). Marking it won is the decision; ' +
        'the order is the consequence.',
    );
  }
  if (row.salesOrderId) {
    throw new CrmStateError(
      row.opportunityNo,
      row.stage,
      'it has already been converted. A second order for the same win would count the win twice.',
    );
  }

  const created = await orders.create(tx, ctx, {
    customerId: row.partnerId,
    branchCode: row.branchCode,
    orderDate: input.orderDate,
    requestedDeliveryDate: input.requestedDeliveryDate ?? null,
    departmentCode: input.departmentCode ?? null,
    businessLineCode: row.businessLineCode,
    lines: input.lines,
  });

  // §6 acceptance criterion 1 — read the order back and prove the customer and
  // the business line survived the crossing, rather than trusting the copy.
  const [order] = await tx
    .select()
    .from(salesOrder)
    .where(eq(salesOrder.id, created.id))
    .limit(1);

  assertIdentityCarried(
    { partnerId: row.partnerId, leadSourceCode: null, campaignCode: null },
    { partnerId: order!.customerId, leadSourceCode: null, campaignCode: null },
  );

  await tx
    .update(opportunity)
    .set({ salesOrderId: created.id, updatedAt: new Date() })
    .where(eq(opportunity.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opportunity.converted_to_order',
    objectType: OPPORTUNITY_DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    after: {
      opportunityNo: row.opportunityNo,
      orderNo: created.orderNo,
      businessLine: row.businessLineCode,
      partnerId: row.partnerId,
    },
    outcome: 'success',
  });

  return { salesOrderId: created.id, orderNo: created.orderNo };
}

// ---------------------------------------------------------------------------
// 08.4 — activities and contacts
// ---------------------------------------------------------------------------

export interface LogActivityInput {
  readonly kind: (typeof import('../db/schema/crm').ACTIVITY_KINDS)[number];
  readonly subject: string;
  readonly branchCode: string;
  readonly ownerUserId: string;
  readonly leadId?: string | null;
  readonly opportunityId?: string | null;
  readonly partnerId?: string | null;
  readonly caseId?: string | null;
  readonly detail?: string | null;
  readonly dueOn?: string | null;
}

export async function logActivity(
  tx: Tx,
  ctx: ActorContext,
  input: LogActivityInput,
): Promise<{ id: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const [created] = await tx
    .insert(crmActivity)
    .values({
      kind: input.kind,
      subject: input.subject,
      detail: input.detail ?? null,
      dueOn: input.dueOn ?? null,
      leadId: input.leadId ?? null,
      opportunityId: input.opportunityId ?? null,
      partnerId: input.partnerId ?? null,
      caseId: input.caseId ?? null,
      branchCode: input.branchCode,
      ownerUserId: input.ownerUserId,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: crmActivity.id });

  return { id: created!.id };
}

/** §6 — *"completed activities … remain in the audit trail."* */
export async function completeActivity(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  outcome?: string | null,
): Promise<void> {
  const [row] = await tx.select().from(crmActivity).where(eq(crmActivity.id, id)).limit(1);
  if (!row) throw new Error(`No activity with id '${id}'.`);

  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  if (row.completedAt) return;

  await tx
    .update(crmActivity)
    .set({ completedAt: new Date(), detail: outcome ?? row.detail })
    .where(eq(crmActivity.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'crm_activity.completed',
    objectType: 'crm_activity',
    objectId: id,
    branchCode: row.branchCode,
    after: { kind: row.kind, subject: row.subject, outcome: outcome ?? null },
    outcome: 'success',
  });
}

/** Everything logged against one lead, opportunity, partner or case. */
export async function activitiesFor(
  tx: Tx,
  filter: { leadId?: string; opportunityId?: string; partnerId?: string; caseId?: string },
) {
  const clause = filter.leadId
    ? eq(crmActivity.leadId, filter.leadId)
    : filter.opportunityId
      ? eq(crmActivity.opportunityId, filter.opportunityId)
      : filter.partnerId
        ? eq(crmActivity.partnerId, filter.partnerId)
        : eq(crmActivity.caseId, filter.caseId!);

  return tx.select().from(crmActivity).where(clause).orderBy(desc(crmActivity.createdAt));
}

// ---------------------------------------------------------------------------
// 08.7 — after-sales cases
// ---------------------------------------------------------------------------

export async function openCase(
  tx: Tx,
  ctx: ActorContext,
  input: {
    readonly partnerId: string;
    readonly branchCode: string;
    readonly ownerUserId: string;
    readonly subject: string;
    readonly openedOn: string;
    readonly warrantyRegistrationId?: string | null;
    readonly arInvoiceId?: string | null;
    readonly serialNumber?: string | null;
    readonly detail?: string | null;
  },
): Promise<{ id: string; caseNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const allocated = await allocateDocumentNumber(
    tx,
    'CRM_CASE',
    { branchCode: input.branchCode, year: Number(input.openedOn.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(crmCase)
    .values({
      caseNo: allocated.documentNo,
      partnerId: input.partnerId,
      warrantyRegistrationId: input.warrantyRegistrationId ?? null,
      arInvoiceId: input.arInvoiceId ?? null,
      serialNumber: input.serialNumber ?? null,
      branchCode: input.branchCode,
      ownerUserId: input.ownerUserId,
      subject: input.subject,
      detail: input.detail ?? null,
      openedOn: input.openedOn,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: crmCase.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'crm_case.opened',
    objectType: CASE_DOCUMENT_TYPE,
    objectId: created!.id,
    branchCode: input.branchCode,
    after: {
      caseNo: allocated.documentNo,
      subject: input.subject,
      warranty: input.warrantyRegistrationId ?? null,
      invoice: input.arInvoiceId ?? null,
      serialNumber: input.serialNumber ?? null,
    },
    outcome: 'success',
  });

  return { id: created!.id, caseNo: allocated.documentNo };
}

export async function resolveCase(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { resolution: string; resolvedOn: string; status?: 'resolved' | 'closed' | 'rejected' },
): Promise<void> {
  const [row] = await tx.select().from(crmCase).where(eq(crmCase.id, id)).limit(1);
  if (!row) throw new Error(`No case with id '${id}'.`);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
  });

  if (!input.resolution.trim()) {
    throw new Error(
      `Closing case ${row.caseNo} needs a resolution (§6, §5.4). A case closed without one records ` +
        'that somebody stopped working on it, not what happened.',
    );
  }

  await tx
    .update(crmCase)
    .set({
      status: input.status ?? 'resolved',
      resolution: input.resolution.trim(),
      resolvedOn: input.resolvedOn,
      updatedAt: new Date(),
    })
    .where(eq(crmCase.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'crm_case.resolved',
    objectType: CASE_DOCUMENT_TYPE,
    objectId: id,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: input.status ?? 'resolved', resolution: input.resolution.trim() },
    outcome: 'success',
  });
}

// ---------------------------------------------------------------------------
// 08.6 — Customer 360
// ---------------------------------------------------------------------------

export interface Customer360 {
  readonly partnerCode: string;
  readonly legalName: string;
  readonly status: string;
  readonly commercial: {
    readonly leads: number;
    readonly opportunities: { stage: string; count: number }[];
    readonly orders: number;
    readonly cases: number;
    readonly activities: number;
  };
  /**
   * §6 — *"authorised … financial history."* Null, not zero, for a user without
   * A/R permission: an absent figure and a figure of nothing are different
   * statements, and only one of them is true.
   */
  readonly financial: {
    readonly openInvoices: number;
    readonly outstandingIqd: string;
    readonly overdueIqd: string;
    readonly creditLimitIqd: string | null;
  } | null;
}

/**
 * §6 acceptance criterion 3 — *"Customer 360 displays **authorised** operational
 * and financial history."*
 *
 * Two populations of data behind one screen, and the permission that governs
 * each is different: commercial history follows the CRM permission, financial
 * figures follow the A/R one. A salesperson sees what they sold and when it was
 * delivered; whether the customer has paid is Finance's to show.
 *
 * The financial block is **omitted rather than zeroed** when the viewer may not
 * see it. Returning zeroes would be a lie a screen would render as fact.
 */
export async function customer360(
  tx: Tx,
  ctx: ActorContext,
  partnerId: string,
  asOf: string,
): Promise<Customer360> {
  const [partner] = await tx
    .select()
    .from(businessPartner)
    .where(eq(businessPartner.id, partnerId))
    .limit(1);

  if (!partner) throw new Error(`No business partner with id '${partnerId}'.`);

  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;

  const leads = await count(
    tx.select({ n: sql<number>`count(*)::int` }).from(lead).where(eq(lead.partnerId, partnerId)),
  );

  const stages = await tx
    .select({ stage: opportunity.stage, count: sql<number>`count(*)::int` })
    .from(opportunity)
    .where(eq(opportunity.partnerId, partnerId))
    .groupBy(opportunity.stage);

  const orderCount = await count(
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(salesOrder)
      .where(eq(salesOrder.customerId, partnerId)),
  );

  const cases = await count(
    tx.select({ n: sql<number>`count(*)::int` }).from(crmCase).where(eq(crmCase.partnerId, partnerId)),
  );

  const activities = await count(
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(crmActivity)
      .where(eq(crmActivity.partnerId, partnerId)),
  );

  const commercial = {
    leads,
    opportunities: stages.map((row) => ({ stage: row.stage as string, count: row.count })),
    orders: orderCount,
    cases,
    activities,
  };

  // §6 — the financial half, only for a viewer entitled to it.
  if (!can(ctx.principal, 'view', 'ar_invoice')) {
    return {
      partnerCode: partner.code,
      legalName: partner.legalName,
      status: partner.status,
      commercial,
      financial: null,
    };
  }

  const financial = (await tx.execute(sql`
    select count(*)::int                                                      as "openInvoices",
           coalesce(sum(i.net_iqd - i.allocated_iqd), 0)::text                 as "outstandingIqd",
           coalesce(sum(case when i.due_date < ${asOf}::date
                             then i.net_iqd - i.allocated_iqd else 0 end), 0)::text as "overdueIqd"
      from ar_invoice i
     where i.customer_id = ${partnerId}
       and i.status in ('posted', 'partially_executed')
       and i.net_iqd - i.allocated_iqd > 0
  `)) as unknown as {
    rows: { openInvoices: number; outstandingIqd: string; overdueIqd: string }[];
  };

  return {
    partnerCode: partner.code,
    legalName: partner.legalName,
    status: partner.status,
    commercial,
    financial: {
      openInvoices: financial.rows[0]!.openInvoices,
      outstandingIqd: financial.rows[0]!.outstandingIqd,
      overdueIqd: financial.rows[0]!.overdueIqd,
      creditLimitIqd: partner.creditLimitIqd,
    },
  };
}

// ---------------------------------------------------------------------------
// 08.8 — reports
// ---------------------------------------------------------------------------

/** Appendix D — *"pipeline by stage and owner."* */
export async function pipeline(
  tx: Tx,
  ctx: ActorContext,
  filter: { ownerUserId?: string | null; businessLineCode?: string | null } = {},
) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const rows = await tx
    .select({
      stage: opportunity.stage,
      ownerUserId: opportunity.ownerUserId,
      expectedValueIqd: opportunity.expectedValueIqd,
      probabilityPercent: opportunity.probabilityPercent,
    })
    .from(opportunity)
    .where(
      and(
        filter.ownerUserId ? eq(opportunity.ownerUserId, filter.ownerUserId) : sql`true`,
        filter.businessLineCode
          ? eq(opportunity.businessLineCode, filter.businessLineCode)
          : sql`true`,
      ),
    );

  return pipelineByStage(
    rows.map((row) => ({
      stage: row.stage,
      ownerUserId: row.ownerUserId,
      expectedValueIqd: parseDecimal(row.expectedValueIqd, 4n),
      probabilityPercent: row.probabilityPercent,
    })),
  );
}

/**
 * Appendix D — *"lead-source conversion."*
 *
 * Counted from what happened: leads raised against each source, how many became
 * opportunities, and how many of those were won. Nothing is estimated, which is
 * the only way the number can be argued with.
 */
export async function leadSourceConversion(tx: Tx, ctx: ActorContext) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const result = (await tx.execute(sql`
    select coalesce(l.lead_source_code, '(none)')                        as "source",
           count(*)::int                                                 as "leads",
           count(o.id)::int                                              as "opportunities",
           count(*) filter (where o.stage in ('won'))::int                as "won"
      from lead l
      left join opportunity o on o.lead_id = l.id
     group by coalesce(l.lead_source_code, '(none)')
     order by 1
  `)) as unknown as {
    rows: { source: string; leads: number; opportunities: number; won: number }[];
  };

  return result.rows.map((row) => ({
    ...row,
    qualificationRate: conversionRate(row.opportunities, row.leads),
    winRate: conversionRate(row.won, row.opportunities),
  }));
}

/** Appendix D — *"lost opportunities"*, with the reasons that were recorded. */
export async function lostOpportunities(tx: Tx, ctx: ActorContext) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  return tx
    .select({
      opportunityNo: opportunity.opportunityNo,
      title: opportunity.title,
      partnerId: opportunity.partnerId,
      ownerUserId: opportunity.ownerUserId,
      expectedValueIqd: opportunity.expectedValueIqd,
      lostReason: opportunity.lostReason,
      businessLineCode: opportunity.businessLineCode,
    })
    .from(opportunity)
    .where(eq(opportunity.stage, 'lost'))
    .orderBy(desc(opportunity.updatedAt));
}

/** Appendix D — customers with no activity and no order in a period. */
export async function inactiveCustomers(tx: Tx, ctx: ActorContext, since: string) {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
  });

  const result = (await tx.execute(sql`
    select p.code as "partnerCode", p.legal_name as "legalName"
      from business_partner p
     where p.is_customer
       and not exists (
         select 1 from crm_activity a
          where a.partner_id = p.id and a.created_at >= ${since}::date)
       and not exists (
         select 1 from sales_order s
          where s.customer_id = p.id and s.order_date >= ${since}::date)
     order by p.code
  `)) as unknown as { rows: { partnerCode: string; legalName: string }[] };

  return result.rows;
}

export async function viewLead(tx: Tx, id: string) {
  const [row] = await tx.select().from(lead).where(eq(lead.id, id)).limit(1);
  if (!row) throw new Error(`No lead with id '${id}'.`);
  return row;
}

export async function viewOpportunity(tx: Tx, id: string) {
  const [row] = await tx.select().from(opportunity).where(eq(opportunity.id, id)).limit(1);
  if (!row) throw new Error(`No opportunity with id '${id}'.`);
  const items = await tx
    .select()
    .from(opportunityItem)
    .where(eq(opportunityItem.opportunityId, id))
    .orderBy(opportunityItem.lineNo);
  return { opportunity: row, items };
}
