/**
 * The Project System — REQ-PM-001 Stage PM-5: the billing plan, the
 * certificates it raises and their posting, revenue recognition by
 * percentage of completion at period end (D-PM-1), and the forecast at
 * completion element by element.
 *
 * Over `services/projects.ts` (Phase 11): `certify` keeps the certificate's
 * arithmetic — retention withheld, the advance recovered, each into its own
 * balance — and this module raises it from a due plan line or from measured
 * progress, has it approved by somebody else, and posts it (D-PM-11): the
 * AR invoice is a stock document (an item and a warehouse on every line), so
 * a certificate posts its own progress-billing journal instead —
 *
 *   Dr customer receivable   gross − retention   (the customer's subledger)
 *   Dr retention receivable  retention
 *   Cr project revenue       gross
 *
 * with the project and the customer on every line. The advance recovered is
 * not a line: the advance arrived as a receipt on the customer's account, and
 * its credit there is what the recovery offsets — the customer's balance after
 * the certificate is the certificate's net.
 *
 * Recognition posts the difference between revenue earned by cost and revenue
 * billed by certificates: Dr WIP / Cr revenue when earned runs ahead, Dr
 * revenue / Cr deferred revenue when billing does; reversed on the first day
 * of the next run and posted again whole. Nothing posts until Finance has
 * ratified the policy; until then the screen shows what would post.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  businessPartner,
  journalEntry,
  project,
  projectActivity,
  projectBalanceMovement,
  projectBillingPlanLine,
  projectCertificate,
  projectEtc,
  projectPlanLine,
  projectPlanVersion,
  projectRecognition,
  projectRecognitionPolicy,
  projectType,
  projectWbs,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { PostingLineRequest } from '../domain/posting';
import {
  HUNDRED_PERCENT,
  assertWithinContract,
  cumulativePercent,
  dueSince,
  etcOf,
  lineState,
  planLineGross,
  recognitionOf,
  type DueTrigger,
  type PlanBasis,
  type PlanLineStatus,
  type RecognitionFigures,
} from '../domain/project-billing';
import { ProjectSystemError, treeOrder } from '../domain/project-system';
import { AdminNotFoundError, optionalText, permit, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';
import * as periods from './periods';
import * as posting from './posting';
import * as projects from './projects';
import * as schedule from './project-schedule';
import * as statuses from './statuses';

/** Literals, as in `project-budget.ts`: the project modules import each other. */
export const PERMISSION_OBJECT = 'project';
export const SETTINGS_OBJECT = 'project_setting';
export const CERTIFICATE_DOCUMENT_TYPE = 'project_certificate';
export const RECOGNITION_DOCUMENT_TYPE = 'project_recognition';
export const POLICY_CODE = 'DEFAULT';

const MONEY = 4n;
const PERCENT = 4n;
const PAGE_SIZE = 50;

const money = (value: bigint) => toDecimalString(value, MONEY);
const amountOf = (value: string | number | null | undefined, field: string): bigint => {
  const text = String(value ?? '').trim().replace(/,/g, '');
  if (!text) throw new ProjectSystemError(field, 'is required');
  let parsed: bigint;
  try {
    parsed = parseDecimal(text, MONEY);
  } catch {
    throw new ProjectSystemError(field, `'${text}' is not an amount`);
  }
  return parsed;
};
const percentOf = (value: string | number | null | undefined, field: string): bigint => {
  const text = String(value ?? '').trim();
  if (!text) throw new ProjectSystemError(field, 'is required');
  let parsed: bigint;
  try {
    parsed = parseDecimal(text, PERCENT);
  } catch {
    throw new ProjectSystemError(field, `'${text}' is not a percentage`);
  }
  if (parsed <= 0n || parsed > HUNDRED_PERCENT) throw new ProjectSystemError(field, 'a percentage is above 0 and at most 100');
  return parsed;
};
const day = (value: string | null | undefined, field: string): string => {
  const text = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new ProjectSystemError(field, text ? `'${text}' is not a date` : 'is required');
  return text;
};

async function load(tx: Tx, projectCode: string) {
  const [row] = await tx
    .select({ project, kind: projectType.kind, customerCode: businessPartner.code, customerName: businessPartner.legalName })
    .from(project)
    .innerJoin(projectType, eq(projectType.code, project.typeCode))
    .leftJoin(businessPartner, eq(businessPartner.id, project.partnerId))
    .where(eq(project.code, projectCode))
    .limit(1);
  if (!row) throw new AdminNotFoundError('project', projectCode);
  return { ...row.project, kind: row.kind, customerCode: row.customerCode, customerName: row.customerName };
}

/** A customer project with its customer: the only kind that is billed or recognises revenue (§4, §11). */
async function loadCustomerProject(tx: Tx, projectCode: string) {
  const row = await load(tx, projectCode);
  if (row.kind !== 'customer') throw new ProjectSystemError('project', `${projectCode} is an ${row.kind} project; only a customer project is billed`);
  if (!row.partnerId || !row.customerCode) throw new ProjectSystemError('customer', `${projectCode} names no customer; the contract needs one before it is billed`);
  return row;
}

/** The contract value as it stands: the baseline plus every approved change order. */
async function contractValue(tx: Tx, projectCode: string): Promise<bigint> {
  return (await projects.position(tx, projectCode)).revisedContractValueIqd;
}

/** What the certificates not cancelled have certified, gross. */
async function certifiedGross(tx: Tx, projectCode: string): Promise<bigint> {
  const [row] = (
    await tx.execute(sql`
      select coalesce(sum(gross_iqd), 0)::text as total from project_certificate
       where project_code = ${projectCode} and status <> 'cancelled'`)
  ).rows as { total: string }[];
  return parseDecimal(row?.total ?? '0', MONEY);
}

/** What the posted certificates have billed, gross, to a day. */
async function billedGross(tx: Tx, projectCode: string, asOf: string): Promise<bigint> {
  const [row] = (
    await tx.execute(sql`
      select coalesce(sum(gross_iqd), 0)::text as total from project_certificate
       where project_code = ${projectCode} and status = 'posted' and certified_on <= ${asOf}::date`)
  ).rows as { total: string }[];
  return parseDecimal(row?.total ?? '0', MONEY);
}

// ---------------------------------------------------------------------------
// The billing plan (§11)
// ---------------------------------------------------------------------------

export interface PlanLineInput {
  readonly wbsCode: string;
  readonly description: string;
  readonly dueTrigger: string;
  /** For a milestone line: the code of a billing milestone of the project. */
  readonly activityCode?: string | null;
  /** For a date line. */
  readonly dueOn?: string | null;
  readonly basis: string;
  readonly percentOfContract?: string | null;
  readonly amountIqd?: string | null;
}

/**
 * A plan line on a billing element: due on a billing milestone (one line per
 * milestone) or on a date, for a share of the contract or an amount. The
 * plan as a whole never bills more than the contract value as it stands.
 */
export async function addPlanLine(tx: Tx, ctx: ActorContext, projectCode: string, input: PlanLineInput): Promise<{ id: string; lineNo: number }> {
  const row = await loadCustomerProject(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (row.status === 'closed') throw new ProjectSystemError('status', `${projectCode} is closed; its billing plan is final`);

  const wbsCode = requireText(input.wbsCode, 'wbs_code', 80);
  const [element] = await tx
    .select({ active: projectWbs.active, isBilling: projectWbs.isBilling })
    .from(projectWbs)
    .where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, wbsCode)))
    .limit(1);
  if (!element) throw new ProjectSystemError('wbs', `${projectCode} has no element '${wbsCode}'`);
  if (!element.active) throw new ProjectSystemError('wbs', `${wbsCode} is deactivated`);
  if (!element.isBilling) throw new ProjectSystemError('wbs', `${wbsCode} is not a billing element; the billing plan hangs on billing elements (§5)`);

  const description = requireText(input.description, 'description', 200);
  const trigger = input.dueTrigger as DueTrigger;
  if (trigger !== 'milestone' && trigger !== 'date') throw new ProjectSystemError('due_trigger', 'a line falls due on a milestone or on a date');
  let activityId: string | null = null;
  let dueOn: string | null = null;
  if (trigger === 'milestone') {
    const code = requireText(input.activityCode, 'activity_code', 20);
    const [milestone] = await tx.select().from(projectActivity).where(and(eq(projectActivity.projectCode, projectCode), eq(projectActivity.code, code))).limit(1);
    if (!milestone) throw new ProjectSystemError('activity_code', `${projectCode} has no activity '${code}'`);
    if (milestone.kind !== 'milestone' || milestone.milestoneUsage !== 'billing') throw new ProjectSystemError('activity_code', `${code} is not a billing milestone`);
    if (milestone.status === 'cancelled') throw new ProjectSystemError('activity_code', `${code} is cancelled`);
    const [taken] = await tx
      .select({ lineNo: projectBillingPlanLine.lineNo })
      .from(projectBillingPlanLine)
      .where(and(eq(projectBillingPlanLine.activityId, milestone.id), ne(projectBillingPlanLine.status, 'cancelled')))
      .limit(1);
    if (taken) throw new ProjectSystemError('activity_code', `${code} already bills line ${taken.lineNo}; one line per milestone`);
    activityId = milestone.id;
  } else {
    dueOn = day(input.dueOn, 'due_on');
  }

  const basis = input.basis as PlanBasis;
  if (basis !== 'percent' && basis !== 'amount') throw new ProjectSystemError('basis', 'a line bills a share of the contract or an amount');
  const percent = basis === 'percent' ? percentOf(input.percentOfContract, 'percent_of_contract') : null;
  const amount = basis === 'amount' ? amountOf(input.amountIqd, 'amount') : null;
  if (amount !== null && amount <= 0n) throw new ProjectSystemError('amount', 'an amount line bills more than nothing');

  const contract = await contractValue(tx, projectCode);
  const gross = planLineGross({ basis, percentOfContract: percent, amountIqd: amount }, contract);
  const planned = await plannedTotal(tx, projectCode, contract);
  if (planned + gross > contract) {
    throw new ProjectSystemError('billing_plan', `the plan bills ${money(planned)} and this line ${money(gross)}, above the contract value of ${money(contract)}`);
  }

  const [last] = (await tx.execute(sql`select coalesce(max(line_no), 0)::int as n from project_billing_plan_line where project_code = ${projectCode}`)).rows as { n: number }[];
  const lineNo = (last?.n ?? 0) + 1;
  const [created] = await tx
    .insert(projectBillingPlanLine)
    .values({
      projectCode,
      wbsCode,
      lineNo,
      description,
      dueTrigger: trigger,
      activityId,
      dueOn,
      basis,
      percentOfContract: percent === null ? null : toDecimalString(percent, PERCENT),
      amountIqd: amount === null ? null : money(amount),
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectBillingPlanLine.id });
  await recordChange(tx, ctx, {
    action: 'project.billing_line_added',
    objectType: 'project',
    objectId: projectCode,
    branchCode: row.branchCode,
    after: { lineNo, wbsCode, dueTrigger: trigger, activityCode: input.activityCode ?? null, dueOn, basis, percentOfContract: percent === null ? null : toDecimalString(percent, PERCENT), amountIqd: amount === null ? null : money(amount) },
  });
  await refreshDue(tx, projectCode);
  return { id: created!.id, lineNo };
}

/** The plan's lines not cancelled, at the contract value given; a billed line counts at what it billed. */
async function plannedTotal(tx: Tx, projectCode: string, contract: bigint): Promise<bigint> {
  const rows = await tx
    .select({ basis: projectBillingPlanLine.basis, percent: projectBillingPlanLine.percentOfContract, amount: projectBillingPlanLine.amountIqd, status: projectBillingPlanLine.status, gross: projectCertificate.grossIqd })
    .from(projectBillingPlanLine)
    .leftJoin(projectCertificate, eq(projectCertificate.id, projectBillingPlanLine.certificateId))
    .where(and(eq(projectBillingPlanLine.projectCode, projectCode), ne(projectBillingPlanLine.status, 'cancelled')));
  let total = 0n;
  for (const r of rows) {
    total += r.gross
      ? parseDecimal(r.gross, MONEY)
      : planLineGross({ basis: r.basis as PlanBasis, percentOfContract: r.percent ? parseDecimal(r.percent, PERCENT) : null, amountIqd: r.amount ? parseDecimal(r.amount, MONEY) : null }, contract);
  }
  return total;
}

export async function cancelPlanLine(tx: Tx, ctx: ActorContext, projectCode: string, lineNo: number, reason: string): Promise<void> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  const why = requireText(reason, 'reason', 500);
  const [line] = (
    await tx.execute(sql`select id, status from project_billing_plan_line where project_code = ${projectCode} and line_no = ${lineNo} for update`)
  ).rows as { id: string; status: PlanLineStatus }[];
  if (!line) throw new AdminNotFoundError('project_billing_plan_line', `${projectCode}:${lineNo}`);
  if (line.status === 'billed' || line.status === 'cancelled') throw new ProjectSystemError('status', `line ${lineNo} is ${line.status}`);
  const now = new Date();
  await tx
    .update(projectBillingPlanLine)
    .set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: now, cancelReason: why, updatedAt: now })
    .where(eq(projectBillingPlanLine.id, line.id));
  await recordChange(tx, ctx, { action: 'project.billing_line_cancelled', objectType: 'project', objectId: projectCode, branchCode: row.branchCode, before: { lineNo, status: line.status }, after: { status: 'cancelled' }, reason: why });
}

/**
 * Planned lines whose milestone has been reached and approved, or whose
 * date has come, become due — with the day they fell due. Run on every
 * change that can make a line due (adding it, approving its milestone,
 * raising from it) and by the billing workspace's actions.
 */
export async function refreshDue(tx: Tx, projectCode: string, today: string = businessToday()): Promise<number> {
  const rows = await tx
    .select({ id: projectBillingPlanLine.id, dueTrigger: projectBillingPlanLine.dueTrigger, dueOn: projectBillingPlanLine.dueOn, reachedOn: projectActivity.reachedOn, reachedApprovedAt: projectActivity.reachedApprovedAt })
    .from(projectBillingPlanLine)
    .leftJoin(projectActivity, eq(projectActivity.id, projectBillingPlanLine.activityId))
    .where(and(eq(projectBillingPlanLine.projectCode, projectCode), eq(projectBillingPlanLine.status, 'planned')));
  let changed = 0;
  for (const r of rows) {
    const since = dueSince({ dueTrigger: r.dueTrigger as DueTrigger, dueOn: r.dueOn }, r.dueTrigger === 'milestone' ? { reachedOn: r.reachedOn, reachedApprovedAt: r.reachedApprovedAt } : null, today);
    if (!since) continue;
    await tx.update(projectBillingPlanLine).set({ status: 'due', dueSince: since, updatedAt: new Date() }).where(eq(projectBillingPlanLine.id, r.id));
    changed += 1;
  }
  return changed;
}

export interface PlanLineRow {
  readonly lineNo: number;
  readonly wbsCode: string;
  readonly elementName: string | null;
  readonly description: string;
  readonly dueTrigger: DueTrigger;
  readonly activityCode: string | null;
  readonly activityName: string | null;
  readonly dueOn: string | null;
  readonly basis: PlanBasis;
  readonly percentOfContract: string | null;
  readonly grossIqd: string;
  /** Stored status, with a planned line whose day has come read as due. */
  readonly state: PlanLineStatus;
  readonly dueSince: string | null;
  readonly certificateNo: string | null;
  readonly cancelReason: string | null;
}

export async function planLines(tx: Tx, projectCode: string, today: string = businessToday()): Promise<PlanLineRow[]> {
  const contract = await contractValue(tx, projectCode);
  const rows = await tx
    .select({
      line: projectBillingPlanLine,
      elementName: projectWbs.name,
      activityCode: projectActivity.code,
      activityName: projectActivity.name,
      reachedOn: projectActivity.reachedOn,
      reachedApprovedAt: projectActivity.reachedApprovedAt,
      certificateNo: projectCertificate.certificateNo,
      certificateGross: projectCertificate.grossIqd,
    })
    .from(projectBillingPlanLine)
    .leftJoin(projectWbs, and(eq(projectWbs.projectCode, projectBillingPlanLine.projectCode), eq(projectWbs.code, projectBillingPlanLine.wbsCode)))
    .leftJoin(projectActivity, eq(projectActivity.id, projectBillingPlanLine.activityId))
    .leftJoin(projectCertificate, eq(projectCertificate.id, projectBillingPlanLine.certificateId))
    .where(eq(projectBillingPlanLine.projectCode, projectCode))
    .orderBy(asc(projectBillingPlanLine.lineNo));
  return rows.map(({ line, ...r }) => {
    const trigger = line.dueTrigger as DueTrigger;
    const since = line.dueSince ?? dueSince({ dueTrigger: trigger, dueOn: line.dueOn }, trigger === 'milestone' ? { reachedOn: r.reachedOn, reachedApprovedAt: r.reachedApprovedAt } : null, today);
    const gross = r.certificateGross
      ? parseDecimal(r.certificateGross, MONEY)
      : planLineGross({ basis: line.basis as PlanBasis, percentOfContract: line.percentOfContract ? parseDecimal(line.percentOfContract, PERCENT) : null, amountIqd: line.amountIqd ? parseDecimal(line.amountIqd, MONEY) : null }, contract);
    return {
      lineNo: line.lineNo,
      wbsCode: line.wbsCode,
      elementName: r.elementName,
      description: line.description,
      dueTrigger: trigger,
      activityCode: r.activityCode,
      activityName: r.activityName,
      dueOn: line.dueOn,
      basis: line.basis as PlanBasis,
      percentOfContract: line.percentOfContract,
      grossIqd: money(gross),
      state: lineState(line.status as PlanLineStatus, since),
      dueSince: line.status === 'cancelled' ? null : since,
      certificateNo: r.certificateNo,
      cancelReason: line.cancelReason,
    };
  });
}

// ---------------------------------------------------------------------------
// Certificates (§11, D-PM-11)
// ---------------------------------------------------------------------------

/**
 * A certificate from a due plan line: the line's amount, or its share of the
 * contract value as it stands; Phase 11's arithmetic withholds retention and
 * recovers the advance; the line is billed by it.
 */
export async function raiseFromLine(tx: Tx, ctx: ActorContext, projectCode: string, lineNo: number, certifiedOn: string = businessToday()): Promise<{ certificateNo: string }> {
  const row = await loadCustomerProject(tx, projectCode);
  await refreshDue(tx, projectCode);
  const [line] = (
    await tx.execute(sql`
      select id, status, basis, percent_of_contract::text as percent, amount_iqd::text as amount, due_since::text as due_since
        from project_billing_plan_line where project_code = ${projectCode} and line_no = ${lineNo} for update`)
  ).rows as { id: string; status: PlanLineStatus; basis: PlanBasis; percent: string | null; amount: string | null; due_since: string | null }[];
  if (!line) throw new AdminNotFoundError('project_billing_plan_line', `${projectCode}:${lineNo}`);
  if (line.status !== 'due') throw new ProjectSystemError('status', `line ${lineNo} is ${line.status}; a certificate is raised from a due line`);
  const on = day(certifiedOn, 'certified_on');
  if (on > businessToday()) throw new ProjectSystemError('certified_on', 'a certificate is dated on a day that has come');
  if (line.due_since && on < line.due_since) throw new ProjectSystemError('certified_on', `line ${lineNo} fell due on ${line.due_since}; the certificate is not dated before it`);

  const contract = await contractValue(tx, projectCode);
  const gross = planLineGross({ basis: line.basis, percentOfContract: line.percent ? parseDecimal(line.percent, PERCENT) : null, amountIqd: line.amount ? parseDecimal(line.amount, MONEY) : null }, contract);
  const certified = await certifiedGross(tx, projectCode);
  assertWithinContract(certified, gross, contract);

  const made = await projects.certify(tx, ctx, projectCode, {
    certifiedOn: on,
    percentComplete: cumulativePercent(certified + gross, contract),
    grossIqd: gross,
    basis: 'billing_plan',
  });
  await tx.update(projectBillingPlanLine).set({ status: 'billed', certificateId: made.id, updatedAt: new Date() }).where(eq(projectBillingPlanLine.id, line.id));
  await recordChange(tx, ctx, { action: 'project.billing_line_billed', objectType: 'project', objectId: projectCode, branchCode: row.branchCode, after: { lineNo, certificateNo: made.certificateNo, grossIqd: money(gross) } });
  return { certificateNo: made.certificateNo };
}

/**
 * A certificate from measured progress (Phase 11's way): the cumulative
 * percentage of the contract, never beyond what was measured and approved,
 * bills what that percentage reaches less what is already certified.
 */
export async function certifyProgress(tx: Tx, ctx: ActorContext, projectCode: string, input: { certifiedOn: string; percentComplete: string }): Promise<{ certificateNo: string }> {
  await loadCustomerProject(tx, projectCode);
  const on = day(input.certifiedOn, 'certified_on');
  if (on > businessToday()) throw new ProjectSystemError('certified_on', 'a certificate is dated on a day that has come');
  const percent = percentOf(input.percentComplete, 'percent_complete');
  const contract = await contractValue(tx, projectCode);
  const certified = await certifiedGross(tx, projectCode);
  const reached = (contract * percent + HUNDRED_PERCENT / 2n) / HUNDRED_PERCENT;
  const gross = reached - certified;
  if (gross <= 0n) throw new ProjectSystemError('percent_complete', `${toDecimalString(percent, PERCENT)} % of the contract is ${money(reached)}, and ${money(certified)} is already certified`);
  assertWithinContract(certified, gross, contract);
  const made = await projects.certify(tx, ctx, projectCode, { certifiedOn: on, percentComplete: percent, grossIqd: gross, basis: 'progress' });
  return { certificateNo: made.certificateNo };
}

async function lockCertificate(tx: Tx, certificateNo: string) {
  const [locked] = (await tx.execute(sql`select id from project_certificate where certificate_no = ${certificateNo} for update`)).rows as { id: string }[];
  if (!locked) throw new AdminNotFoundError('project_certificate', certificateNo);
  const [row] = await tx.select().from(projectCertificate).where(eq(projectCertificate.id, locked.id)).limit(1);
  return row!;
}

/**
 * The certificate approved by somebody other than its raiser, and posted
 * (D-PM-11) on its own date: the receivable on the customer's account, the
 * retention on its own, the revenue gross — the project on every line.
 */
export async function approveCertificate(tx: Tx, ctx: ActorContext, certificateNo: string): Promise<{ journalEntryId: string }> {
  const cert = await lockCertificate(tx, certificateNo);
  const row = await loadCustomerProject(tx, cert.projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, cert.projectCode);
  if (cert.status !== 'draft') throw new ProjectSystemError('status', `${certificateNo} is ${cert.status}; only a draft certificate is approved`);
  if (cert.createdBy === ctx.principal.userId) throw new ProjectSystemError('approver', `${certificateNo} was raised by you; somebody else approves it`);
  if (row.status === 'closed') throw new ProjectSystemError('status', `${cert.projectCode} is closed`);
  await statuses.assertTransitionAllowed(tx, CERTIFICATE_DOCUMENT_TYPE, 'draft', 'approved');
  await statuses.assertTransitionAllowed(tx, CERTIFICATE_DOCUMENT_TYPE, 'approved', 'posted');

  const gross = parseDecimal(cert.grossIqd, MONEY);
  const retention = parseDecimal(cert.retentionIqd, MONEY);
  const criteria = { branchCode: cert.branchCode, projectCode: cert.projectCode };
  const dimensions = {
    branch: cert.branchCode,
    project: cert.projectCode,
    business_partner: row.customerCode,
    department: row.departmentCode ?? null,
    business_line: row.businessLineCode ?? null,
  };
  const lines: PostingLineRequest[] = [{ role: 'customer_receivable', debit: money(gross - retention), criteria, dimensions }];
  if (retention > 0n) lines.push({ role: 'project_retention_receivable', debit: money(retention), criteria, dimensions });
  lines.push({ role: 'project_revenue', credit: money(gross), criteria, dimensions });

  const result = await posting.post(tx, ctx, {
    eventType: 'projects.certificate',
    documentTypeCode: CERTIFICATE_DOCUMENT_TYPE,
    source: { module: 'projects', documentId: cert.id, event: 'posted' },
    branchCode: cert.branchCode,
    documentDate: cert.certifiedOn,
    postingDate: cert.certifiedOn,
    description: `Progress certificate ${cert.certificateNo} — ${cert.projectCode} — ${row.customerCode}`,
    lines,
  });
  const now = new Date();
  await tx
    .update(projectCertificate)
    .set({ status: 'posted', approvedBy: ctx.principal.userId, approvedAt: now, journalEntryId: result.journalEntryId })
    .where(eq(projectCertificate.id, cert.id));
  await recordChange(tx, ctx, {
    action: 'project_certificate.posted',
    objectType: CERTIFICATE_DOCUMENT_TYPE,
    objectId: cert.certificateNo,
    branchCode: cert.branchCode,
    before: { status: cert.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId, grossIqd: cert.grossIqd, retentionIqd: cert.retentionIqd, advanceRecoveredIqd: cert.advanceRecoveredIqd, netIqd: cert.netIqd },
  });
  return { journalEntryId: result.journalEntryId };
}

/**
 * A draft certificate withdrawn with a reason: the retention it withheld and
 * the advance it recovered are given back to their balances, and the plan
 * line it billed is due again.
 */
export async function cancelCertificate(tx: Tx, ctx: ActorContext, certificateNo: string, reason: string): Promise<void> {
  const cert = await lockCertificate(tx, certificateNo);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, cert.projectCode);
  const why = requireText(reason, 'reason', 500);
  if (cert.status !== 'draft') throw new ProjectSystemError('status', `${certificateNo} is ${cert.status}; only a draft certificate is cancelled`);
  await statuses.assertTransitionAllowed(tx, CERTIFICATE_DOCUMENT_TYPE, 'draft', 'cancelled', why);
  const moves = await tx.select().from(projectBalanceMovement).where(eq(projectBalanceMovement.certificateId, cert.id));
  for (const m of moves) {
    await tx.insert(projectBalanceMovement).values({
      projectCode: m.projectCode,
      kind: m.kind,
      amountIqd: money(-parseDecimal(m.amountIqd, MONEY)),
      movedOn: businessToday(),
      description: `Certificate ${cert.certificateNo} cancelled`,
      certificateId: cert.id,
      createdBy: ctx.principal.userId,
    });
  }
  await tx.update(projectCertificate).set({ status: 'cancelled' }).where(eq(projectCertificate.id, cert.id));
  await tx
    .update(projectBillingPlanLine)
    .set({ status: 'due', certificateId: null, updatedAt: new Date() })
    .where(eq(projectBillingPlanLine.certificateId, cert.id));
  await recordChange(tx, ctx, { action: 'project_certificate.cancelled', objectType: CERTIFICATE_DOCUMENT_TYPE, objectId: cert.certificateNo, branchCode: cert.branchCode, before: { status: cert.status }, after: { status: 'cancelled' }, reason: why });
}

export async function certificates(tx: Tx, filter: { projectCode?: string | null; status?: string | null; page?: number } = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const where = and(
    filter.projectCode ? eq(projectCertificate.projectCode, filter.projectCode) : undefined,
    filter.status ? sql`${projectCertificate.status}::text = ${filter.status}` : undefined,
  );
  const rows = await tx
    .select({
      certificateNo: projectCertificate.certificateNo,
      projectCode: projectCertificate.projectCode,
      certifiedOn: projectCertificate.certifiedOn,
      basis: projectCertificate.basis,
      percentComplete: projectCertificate.percentComplete,
      grossIqd: projectCertificate.grossIqd,
      retentionIqd: projectCertificate.retentionIqd,
      advanceRecoveredIqd: projectCertificate.advanceRecoveredIqd,
      netIqd: projectCertificate.netIqd,
      status: projectCertificate.status,
      entryNo: journalEntry.entryNo,
    })
    .from(projectCertificate)
    .leftJoin(journalEntry, eq(journalEntry.id, projectCertificate.journalEntryId))
    .where(where)
    .orderBy(desc(projectCertificate.certifiedOn), desc(projectCertificate.certificateNo))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);
  return { rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE, page };
}

export async function certificate(tx: Tx, certificateNo: string) {
  const [cert] = await tx.select().from(projectCertificate).where(eq(projectCertificate.certificateNo, certificateNo)).limit(1);
  if (!cert) throw new AdminNotFoundError('project_certificate', certificateNo);
  const owner = await load(tx, cert.projectCode);
  const people = (
    await tx.execute(sql`
      select (select display_name from app_user where id = ${cert.createdBy}::uuid) as "createdBy",
             (select display_name from app_user where id = ${cert.approvedBy}::uuid) as "approvedBy"`)
  ).rows[0] as { createdBy: string | null; approvedBy: string | null };
  const [entry] = cert.journalEntryId ? await tx.select({ entryNo: journalEntry.entryNo }).from(journalEntry).where(eq(journalEntry.id, cert.journalEntryId)).limit(1) : [];
  const [line] = await tx
    .select({ lineNo: projectBillingPlanLine.lineNo, description: projectBillingPlanLine.description, wbsCode: projectBillingPlanLine.wbsCode })
    .from(projectBillingPlanLine)
    .where(eq(projectBillingPlanLine.certificateId, cert.id))
    .limit(1);
  const movements = await tx
    .select({ kind: projectBalanceMovement.kind, amountIqd: projectBalanceMovement.amountIqd, movedOn: projectBalanceMovement.movedOn, description: projectBalanceMovement.description })
    .from(projectBalanceMovement)
    .where(eq(projectBalanceMovement.certificateId, cert.id))
    .orderBy(asc(projectBalanceMovement.createdAt));
  return {
    certificate: cert,
    project: { code: owner.code, name: owner.name, customerCode: owner.customerCode, customerName: owner.customerName, status: owner.status },
    people,
    entryNo: entry?.entryNo ?? null,
    planLine: line ?? null,
    movements,
  };
}

/** The contract's balances: value, certified, billed, retention held, advance outstanding. */
export async function balances(tx: Tx, projectCode: string) {
  const position = await projects.position(tx, projectCode);
  return {
    contractIqd: money(position.revisedContractValueIqd),
    baselineContractIqd: money(parseDecimal((await load(tx, projectCode)).contractValueIqd, MONEY)),
    certifiedIqd: money(await certifiedGross(tx, projectCode)),
    billedIqd: money(await billedGross(tx, projectCode, '9999-12-31')),
    retentionHeldIqd: money(await projects.balanceOf(tx, projectCode, 'retention')),
    advanceOutstandingIqd: money(await projects.balanceOf(tx, projectCode, 'advance')),
  };
}

// ---------------------------------------------------------------------------
// The recognition policy (D-PM-1)
// ---------------------------------------------------------------------------

export async function policy(tx: Tx) {
  const [row] = await tx
    .select({ policy: projectRecognitionPolicy, ratifiedByName: appUser.displayName })
    .from(projectRecognitionPolicy)
    .leftJoin(appUser, eq(appUser.id, projectRecognitionPolicy.ratifiedBy))
    .where(eq(projectRecognitionPolicy.code, POLICY_CODE))
    .limit(1);
  if (!row) throw new AdminNotFoundError('project_recognition_policy', POLICY_CODE);
  return { ...row.policy, ratifiedByName: row.ratifiedByName, ratified: row.policy.ratifiedAt !== null };
}

/** Finance ratifies the method (D-PM-1), with its note; from then on recognition posts. */
export async function ratifyPolicy(tx: Tx, ctx: ActorContext, note: string): Promise<void> {
  await permit(ctx, 'configure', SETTINGS_OBJECT, POLICY_CODE);
  const why = requireText(note, 'note', 500);
  const before = await policy(tx);
  if (before.ratified) throw new ProjectSystemError('policy', `the recognition method was ratified on ${before.ratifiedAt!.toISOString()}`);
  await tx
    .update(projectRecognitionPolicy)
    .set({ ratifiedBy: ctx.principal.userId, ratifiedAt: new Date(), ratifiedNote: why })
    .where(eq(projectRecognitionPolicy.code, POLICY_CODE));
  await recordChange(tx, ctx, { action: 'project.recognition_policy_ratified', objectType: SETTINGS_OBJECT, objectId: POLICY_CODE, before: { ratified: false }, after: { method: before.method, ratified: true }, reason: why });
}

// ---------------------------------------------------------------------------
// Revenue recognition at period end (§11, D-PM-1)
// ---------------------------------------------------------------------------

/** The figures recognition reads at a period end: contract, actual and EAC by cost, billed by posted certificates. */
export async function recognitionFigures(tx: Tx, projectCode: string, periodEnd: string): Promise<RecognitionFigures> {
  const contract = await contractValue(tx, projectCode);
  const rows = await forecast(tx, projectCode, periodEnd);
  const root = rows.find((r) => r.level === 1);
  const actual = root ? parseDecimal(root.actualIqd, MONEY) : 0n;
  const eac = root ? parseDecimal(root.eacIqd, MONEY) : 0n;
  return recognitionOf({ contractIqd: contract, actualIqd: actual, eacIqd: eac, billedIqd: await billedGross(tx, projectCode, periodEnd) });
}

function recognitionLines(
  adjustment: bigint,
  reverse: boolean,
  criteria: { branchCode: string; projectCode: string },
  dimensions: Record<string, string | null>,
): PostingLineRequest[] {
  const value = money(adjustment < 0n ? -adjustment : adjustment);
  const earnedAhead = adjustment > 0n;
  // Earned ahead of billing: Dr WIP / Cr revenue. Billed ahead: Dr revenue / Cr deferred revenue. A reversal swaps the sides.
  const [debitRole, creditRole] = earnedAhead ? ['project_wip', 'project_revenue'] : ['project_revenue', 'project_deferred_revenue'];
  const [dr, cr] = reverse ? [creditRole, debitRole] : [debitRole, creditRole];
  return [
    { role: dr, debit: value, criteria, dimensions },
    { role: cr, credit: value, criteria, dimensions },
  ];
}

/**
 * The period's recognition for one customer project: refused before the
 * policy is ratified and in a closed period; the earlier run not yet
 * reversed is reversed on the first day of this period; then the
 * difference between recognised and billed posts at the period's end.
 */
export async function runRecognition(tx: Tx, ctx: ActorContext, projectCode: string, periodEnd: string): Promise<{ id: string; figures: RecognitionFigures; journalEntryId: string | null; reversed: number }> {
  const row = await loadCustomerProject(tx, projectCode);
  await permit(ctx, 'post', PERMISSION_OBJECT, projectCode);
  const end = day(periodEnd, 'period_end');
  const rule = await policy(tx);
  if (!rule.ratified) throw new ProjectSystemError('policy', 'the recognition method is not ratified by Finance (D-PM-1); nothing posts until it is — the figures show what would post');
  if (row.status === 'draft') throw new ProjectSystemError('status', `${projectCode} is not released; it has nothing to recognise`);
  const [settled] = (await tx.execute(sql`select settlement_no from project_settlement where project_code = ${projectCode} and status = 'posted' limit 1`)).rows as { settlement_no: string }[];
  if (settled) throw new ProjectSystemError('status', `${projectCode} is settled (${settled.settlement_no}); its result stands and nothing more is recognised`);
  const period = await periods.periodFor(tx, end);
  if (period.endsOn !== end) throw new ProjectSystemError('period_end', `${end} is not the last day of a period (${period.name} ends ${period.endsOn})`);
  if (period.status === 'closed') throw new ProjectSystemError('period_end', `period_is_closed: ${period.name} is closed; recognition is posted before the close`);

  // One run per project and period, in order.
  await tx.execute(sql`select code from project where code = ${projectCode} for update`);
  const later = await tx
    .select({ periodEnd: projectRecognition.periodEnd })
    .from(projectRecognition)
    .where(and(eq(projectRecognition.projectCode, projectCode), sql`${projectRecognition.periodEnd} >= ${end}::date`))
    .orderBy(desc(projectRecognition.periodEnd))
    .limit(1);
  if (later[0]) throw new ProjectSystemError('period_end', later[0].periodEnd === end ? `${projectCode} is already recognised to ${end}` : `${projectCode} is recognised to ${later[0].periodEnd}; an earlier period is not run after a later one`);

  const criteria = { branchCode: row.branchCode ?? ctx.branchCode, projectCode };
  const dimensions = { branch: criteria.branchCode, project: projectCode, department: row.departmentCode ?? null, business_line: row.businessLineCode ?? null };

  // The earlier run, reversed on the first day of this period.
  const reversed = await reverseOpen(tx, ctx, projectCode, period.startsOn, criteria, dimensions);

  const figures = await recognitionFigures(tx, projectCode, end);
  const id = randomUUID();
  let journalEntryId: string | null = null;
  if (figures.adjustmentIqd !== 0n) {
    const result = await posting.post(tx, ctx, {
      eventType: 'projects.recognition',
      documentTypeCode: RECOGNITION_DOCUMENT_TYPE,
      source: { module: 'projects', documentId: id, event: 'posted' },
      branchCode: criteria.branchCode,
      documentDate: end,
      postingDate: end,
      description: `Revenue recognition ${projectCode} to ${end} — ${toDecimalString(figures.percent, PERCENT)} % by cost`,
      lines: recognitionLines(figures.adjustmentIqd, false, criteria, dimensions),
    });
    journalEntryId = result.journalEntryId;
  }
  await tx.insert(projectRecognition).values({
    id,
    projectCode,
    periodEnd: end,
    contractValueIqd: money(figures.contractIqd),
    actualIqd: money(figures.actualIqd),
    eacIqd: money(figures.eacIqd),
    percentComplete: toDecimalString(figures.percent, PERCENT),
    recognisedIqd: money(figures.recognisedIqd),
    billedIqd: money(figures.billedIqd),
    adjustmentIqd: money(figures.adjustmentIqd),
    journalEntryId,
    createdBy: ctx.principal.userId,
  });
  await recordChange(tx, ctx, {
    action: 'project.revenue_recognised',
    objectType: RECOGNITION_DOCUMENT_TYPE,
    objectId: `${projectCode}:${end}`,
    branchCode: criteria.branchCode,
    after: {
      periodEnd: end,
      percentComplete: toDecimalString(figures.percent, PERCENT),
      recognisedIqd: money(figures.recognisedIqd),
      billedIqd: money(figures.billedIqd),
      adjustmentIqd: money(figures.adjustmentIqd),
      journalEntryId,
      reversedEarlier: reversed.length,
    },
  });
  return { id, figures, journalEntryId, reversed: reversed.length };
}

/** Every run not yet reversed, reversed on a day by its own journal through the same event. */
async function reverseOpen(
  tx: Tx,
  ctx: ActorContext,
  projectCode: string,
  on: string,
  criteria: { branchCode: string; projectCode: string },
  dimensions: Record<string, string | null>,
): Promise<string[]> {
  const open = await tx
    .select()
    .from(projectRecognition)
    .where(and(eq(projectRecognition.projectCode, projectCode), isNull(projectRecognition.reversedOn), sql`${projectRecognition.journalEntryId} is not null`));
  const journals: string[] = [];
  for (const prior of open) {
    const adjustment = parseDecimal(prior.adjustmentIqd, MONEY);
    const reversal = await posting.post(tx, ctx, {
      eventType: 'projects.recognition',
      documentTypeCode: RECOGNITION_DOCUMENT_TYPE,
      source: { module: 'projects', documentId: prior.id, event: 'reversed' },
      branchCode: criteria.branchCode,
      documentDate: on,
      postingDate: on,
      description: `Revenue recognition ${projectCode} to ${prior.periodEnd} — reversed`,
      lines: recognitionLines(adjustment, true, criteria, dimensions),
    });
    await tx.update(projectRecognition).set({ reversalJournalEntryId: reversal.journalEntryId, reversedOn: on }).where(eq(projectRecognition.id, prior.id));
    journals.push(reversal.journalEntryId);
  }
  return journals;
}

/**
 * PM-6 §12 — settlement clears WIP and deferred revenue: the run still
 * standing is reversed on the settlement's date, leaving the billed revenue
 * and the costs as the result. The journal, or null when nothing stood.
 */
export async function reverseOpenRecognition(tx: Tx, ctx: ActorContext, projectCode: string, on: string): Promise<string | null> {
  const row = await load(tx, projectCode);
  const criteria = { branchCode: row.branchCode ?? ctx.branchCode, projectCode };
  const dimensions = { branch: criteria.branchCode, project: projectCode, department: row.departmentCode ?? null, business_line: row.businessLineCode ?? null };
  const journals = await reverseOpen(tx, ctx, projectCode, on, criteria, dimensions);
  return journals[journals.length - 1] ?? null;
}

export async function recognitionHistory(tx: Tx, projectCode: string) {
  const rows = (
    await tx.execute(sql`
      select r.id, r.period_end::text as "periodEnd", r.percent_complete::text as "percentComplete", r.contract_value_iqd::text as "contractIqd",
             r.actual_iqd::text as "actualIqd", r.eac_iqd::text as "eacIqd", r.recognised_iqd::text as "recognisedIqd", r.billed_iqd::text as "billedIqd",
             r.adjustment_iqd::text as "adjustmentIqd", j.entry_no as "entryNo", rj.entry_no as "reversalEntryNo", r.reversed_on::text as "reversedOn"
        from project_recognition r
        left join journal_entry j on j.id = r.journal_entry_id
        left join journal_entry rj on rj.id = r.reversal_journal_entry_id
       where r.project_code = ${projectCode}
       order by r.period_end desc`)
  ).rows as {
    id: string;
    periodEnd: string;
    percentComplete: string;
    contractIqd: string;
    actualIqd: string;
    eacIqd: string;
    recognisedIqd: string;
    billedIqd: string;
    adjustmentIqd: string;
    entryNo: string | null;
    reversalEntryNo: string | null;
    reversedOn: string | null;
  }[];
  return rows;
}

/**
 * The close checklist's warning (§11): customer projects released by the
 * period's end, not yet closed before it, with cost or billing to the day,
 * and no recognition run to that day. Before the policy is ratified nothing
 * can be run, and the check says so instead of naming every project.
 */
export async function missingRecognition(tx: Tx, periodEnd: string): Promise<{ ratified: boolean; projects: string[] }> {
  const rule = await policy(tx);
  if (!rule.ratified) return { ratified: false, projects: [] };
  const rows = (
    await tx.execute(sql`
      select p.code from project p
        join project_type t on t.code = p.type_code and t.kind = 'customer'
       where p.status in ('active', 'on_hold', 'closing', 'closed')
         and (p.closed_at is null or p.closed_at::date > ${periodEnd}::date)
         and (exists (select 1 from project_cost k where k.project_code = p.code and k.incurred_on <= ${periodEnd}::date)
              or exists (select 1 from project_certificate c where c.project_code = p.code and c.status = 'posted' and c.certified_on <= ${periodEnd}::date))
         and not exists (select 1 from project_recognition r where r.project_code = p.code and r.period_end = ${periodEnd}::date)
         -- PM-6 — a settled project's result stands; it is not recognised again.
         and not exists (select 1 from project_settlement s where s.project_code = p.code and s.status = 'posted' and s.settled_on <= ${periodEnd}::date)
       order by p.code`)
  ).rows as { code: string }[];
  return { ratified: true, projects: rows.map((r) => r.code) };
}

// ---------------------------------------------------------------------------
// The forecast at completion (§11)
// ---------------------------------------------------------------------------

export interface ForecastRow {
  readonly code: string;
  readonly parentCode: string | null;
  readonly level: number;
  readonly name: string;
  readonly planIqd: string;
  readonly budgetIqd: string;
  readonly committedIqd: string;
  readonly actualIqd: string;
  readonly etcIqd: string;
  readonly eacIqd: string;
  readonly vacIqd: string;
  /** The typed ETC the element's own figure came from, when one did. */
  readonly typedEtc: { readonly asOf: string; readonly etcIqd: string; readonly reason: string } | null;
}

/**
 * Per element to a day: the whole current plan, the budget, the open
 * commitment, the actual; the ETC (typed, or the formula of §10) and EAC =
 * actual + ETC, VAC = budget − EAC — each element's own figures summed up
 * its subtree, so the root's EAC is every element's.
 */
export async function forecast(tx: Tx, projectCode: string, asOf: string = businessToday()): Promise<ForecastRow[]> {
  const { elements, own } = await schedule.ownFigures(tx, projectCode, asOf);
  const root = elements.find((e) => e.level === 1)?.code ?? null;
  const [version] = await tx
    .select({ id: projectPlanVersion.id })
    .from(projectPlanVersion)
    .where(and(eq(projectPlanVersion.projectCode, projectCode), eq(projectPlanVersion.isCurrent, true)))
    .limit(1);
  const plan = version ? await tx.select({ wbsCode: projectPlanLine.wbsCode, amountIqd: projectPlanLine.amountIqd }).from(projectPlanLine).where(eq(projectPlanLine.versionId, version.id)) : [];
  const commitments = (
    await tx.execute(sql`
      select wbs_code, coalesce(sum(amount_iqd - consumed_iqd), 0)::text as open
        from project_commitment
       where project_code = ${projectCode} and released_on is null and committed_on <= ${asOf}::date
       group by wbs_code`)
  ).rows as { wbs_code: string | null; open: string }[];
  const typed = (
    await tx.execute(sql`
      select distinct on (wbs_code) wbs_code, as_of::text as as_of, etc_iqd::text as etc, reason
        from project_etc
       where project_code = ${projectCode} and as_of <= ${asOf}::date
       order by wbs_code, as_of desc, created_at desc`)
  ).rows as { wbs_code: string; as_of: string; etc: string; reason: string }[];
  const typedBy = new Map(typed.map((t) => [t.wbs_code, t] as const));

  interface Sums {
    plan: bigint;
    budget: bigint;
    committed: bigint;
    actual: bigint;
    etc: bigint;
  }
  const totals = new Map<string, Sums>();
  for (const e of elements) {
    const o = own.get(e.code)!;
    const t = typedBy.get(e.code);
    totals.set(e.code, {
      plan: 0n,
      budget: o.budget,
      committed: 0n,
      actual: o.actual,
      etc: etcOf({ budgetIqd: o.budget, earnedIqd: o.earned, actualIqd: o.actual, typedIqd: t ? parseDecimal(t.etc, MONEY) : null }),
    });
  }
  for (const l of plan) {
    const s = totals.get(l.wbsCode);
    if (s) s.plan += parseDecimal(l.amountIqd, MONEY);
  }
  for (const c of commitments) {
    const key = c.wbs_code ?? root;
    const s = key ? totals.get(key) : undefined;
    if (s) s.committed += parseDecimal(c.open, MONEY);
  }
  for (const e of [...elements].sort((a, b) => b.level - a.level)) {
    if (!e.parentCode) continue;
    const parent = totals.get(e.parentCode);
    const child = totals.get(e.code)!;
    if (!parent) continue;
    parent.plan += child.plan;
    parent.budget += child.budget;
    parent.committed += child.committed;
    parent.actual += child.actual;
    parent.etc += child.etc;
  }
  const rows = elements.map((e): ForecastRow => {
    const s = totals.get(e.code)!;
    const eac = s.actual + s.etc;
    const t = typedBy.get(e.code);
    return {
      code: e.code,
      parentCode: e.parentCode,
      level: e.level,
      name: e.name,
      planIqd: money(s.plan),
      budgetIqd: money(s.budget),
      committedIqd: money(s.committed),
      actualIqd: money(s.actual),
      etcIqd: money(s.etc),
      eacIqd: money(eac),
      vacIqd: money(s.budget - eac),
      typedEtc: t ? { asOf: t.as_of, etcIqd: t.etc, reason: t.reason } : null,
    };
  });
  return treeOrder(rows);
}

/** The manager's estimate to complete for one element, dated and reasoned; the latest one to a day counts. */
export async function setEtc(tx: Tx, ctx: ActorContext, projectCode: string, input: { wbsCode: string; asOf: string; etcIqd: string; reason: string }): Promise<{ id: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, projectCode);
  if (row.status === 'draft' || row.status === 'closed') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; the forecast is kept while it runs`);
  const wbsCode = requireText(input.wbsCode, 'wbs_code', 80);
  const [element] = await tx.select({ active: projectWbs.active }).from(projectWbs).where(and(eq(projectWbs.projectCode, projectCode), eq(projectWbs.code, wbsCode))).limit(1);
  if (!element) throw new ProjectSystemError('wbs', `${projectCode} has no element '${wbsCode}'`);
  const asOf = day(input.asOf, 'as_of');
  if (asOf > businessToday()) throw new ProjectSystemError('as_of', 'an estimate is dated on a day that has come');
  const etc = amountOf(input.etcIqd, 'etc');
  if (etc < 0n) throw new ProjectSystemError('etc', 'an estimate to complete is not below zero');
  const reason = requireText(input.reason, 'reason', 500);
  const [created] = await tx
    .insert(projectEtc)
    .values({ projectCode, wbsCode, asOf, etcIqd: money(etc), reason, createdBy: ctx.principal.userId })
    .returning({ id: projectEtc.id });
  await recordChange(tx, ctx, { action: 'project.etc_set', objectType: 'project', objectId: projectCode, branchCode: row.branchCode, after: { wbsCode, asOf, etcIqd: money(etc) }, reason });
  return { id: created!.id };
}

export async function etcHistory(tx: Tx, projectCode: string) {
  return tx
    .select({ id: projectEtc.id, wbsCode: projectEtc.wbsCode, asOf: projectEtc.asOf, etcIqd: projectEtc.etcIqd, reason: projectEtc.reason, createdByName: appUser.displayName, createdAt: projectEtc.createdAt })
    .from(projectEtc)
    .leftJoin(appUser, eq(appUser.id, projectEtc.createdBy))
    .where(eq(projectEtc.projectCode, projectCode))
    .orderBy(desc(projectEtc.asOf), desc(projectEtc.createdAt));
}

/** The customer projects a recognition run can be made for, with the figures it would post to the period end. */
export async function recognitionCandidates(tx: Tx, periodEnd: string) {
  const rows = await tx
    .select({ code: project.code, name: project.name, status: project.status })
    .from(project)
    .innerJoin(projectType, eq(projectType.code, project.typeCode))
    .where(and(eq(projectType.kind, 'customer'), inArray(project.status, ['active', 'on_hold', 'closing'])))
    .orderBy(asc(project.code));
  const out: { code: string; name: string; status: string; figures: RecognitionFigures; recognised: boolean }[] = [];
  for (const r of rows) {
    const [done] = await tx.select({ id: projectRecognition.id }).from(projectRecognition).where(and(eq(projectRecognition.projectCode, r.code), eq(projectRecognition.periodEnd, periodEnd))).limit(1);
    out.push({ ...r, figures: await recognitionFigures(tx, r.code, periodEnd), recognised: Boolean(done) });
  }
  return out;
}

