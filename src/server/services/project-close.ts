/**
 * The Project System — REQ-PM-001 Stage PM-6: what stands between a project
 * and its close, the settlement (§12, D-PM-7) and labour from timesheets
 * (§8, D-PM-8).
 *
 * Settlement is one document per project, drafted at technical completion by
 * one person and posted by another:
 *
 *   investment → the asset under construction: every expense account the
 *                project's cost was posted to (the `project` dimension) is
 *                credited its net, and `project_auc` debited the whole;
 *   customer   → the result: the recognition run still standing is reversed
 *   / internal   on the settlement's date, so WIP and deferred revenue are
 *                clear and the P&L holds the costs and the billed revenue.
 *
 * Either way every cost row to the date is marked settled, which is what
 * Phase 11's closeout reads as "accounted for", and the project refuses any
 * further cost.
 *
 * Labour: hours are booked by one person and approved by another; a month's
 * approved hours are posted by Finance at the employee's base salary in force
 * ÷ the calendar's working days in the month ÷ 8 — the rate is read only by
 * somebody who may see compensation, at the moment of posting.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, employee, journalEntry, project, projectCost, projectCostCode, projectSettlement, projectTimesheet, projectTimesheetRun, projectType, projectWbs } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { PostingLineRequest } from '../domain/posting';
import { closeoutFindings } from '../domain/projects';
import { hourlyRate, labourAmount, monthBounds, pmCloseFindings, settlementKindOf, workingDaysIn, type SettlementKind } from '../domain/project-close';
import { ProjectSystemError } from '../domain/project-system';
import { AdminNotFoundError, optionalText, permit, recordChange, requireText } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import { allocateDocumentNumber } from './numbering';
import * as posting from './posting';
import * as billing from './project-billing';
import * as schedule from './project-schedule';
import * as projects from './projects';

/** Literals, as in `project-budget.ts`: the project modules import each other. */
export const PERMISSION_OBJECT = 'project';
export const SETTLEMENT_DOCUMENT_TYPE = 'project_settlement';
export const TIMESHEET_DOCUMENT_TYPE = 'project_timesheet';
export const SETTLEMENT_SEQUENCE_KEY = 'PROJECT_SETTLEMENT';
const COMPENSATION_OBJECT = 'employee_compensation';

const MONEY = 4n;
const HOURS = 2n;
const money = (value: bigint) => toDecimalString(value, MONEY);

const day = (value: string | null | undefined, field: string): string => {
  const text = (value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) throw new ProjectSystemError(field, text ? `'${text}' is not a date` : 'is required');
  return text;
};

async function load(tx: Tx, projectCode: string) {
  const [row] = await tx
    .select({ project, kind: projectType.kind })
    .from(project)
    .innerJoin(projectType, eq(projectType.code, project.typeCode))
    .where(eq(project.code, projectCode))
    .limit(1);
  if (!row) throw new AdminNotFoundError('project', projectCode);
  return { ...row.project, kind: row.kind };
}

const rows = async <T>(tx: Tx, query: ReturnType<typeof sql>) => ((await tx.execute(query)) as unknown as { rows: T[] }).rows;

// ---------------------------------------------------------------------------
// What stands between the project and its close (§12, §13 Close)
// ---------------------------------------------------------------------------

export interface CloseCheck {
  readonly code: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** Phase 11's five, then PM-6's five — every one named, passed or not. */
export async function closeChecks(tx: Tx, projectCode: string): Promise<CloseCheck[]> {
  await load(tx, projectCode);
  const phase11 = closeoutFindings(await projects.closeoutState(tx, projectCode));
  const [counts] = await rows<{ billing: number; drafts: number; timesheets: number; settled: number }>(
    tx,
    sql`
      select (select count(*)::int from project_billing_plan_line where project_code = ${projectCode} and status in ('planned', 'due')) as billing,
             (select count(*)::int from project_certificate where project_code = ${projectCode} and status = 'draft') as drafts,
             (select count(*)::int from project_timesheet where project_code = ${projectCode} and status in ('draft', 'approved')) as timesheets,
             (select count(*)::int from project_settlement where project_code = ${projectCode} and status = 'posted') as settled`,
  );
  const pm = pmCloseFindings({
    openActivities: await schedule.openActivities(tx, projectCode),
    openBillingLines: counts?.billing ?? 0,
    draftCertificates: counts?.drafts ?? 0,
    unpostedTimesheets: counts?.timesheets ?? 0,
    settlementPosted: (counts?.settled ?? 0) > 0,
  });
  const phase11Codes = ['open_purchase_orders', 'unreturned_stock', 'unbilled_costs', 'unapproved_variations', 'unresolved_advances_or_retention'] as const;
  const pmCodes = ['open_activities', 'open_billing_lines', 'draft_certificates', 'unposted_timesheets', 'settlement_not_posted'] as const;
  return [
    ...phase11Codes.map((code) => {
      const f = phase11.find((x) => x.blocker === code);
      return { code, passed: !f, detail: f?.detail ?? '' };
    }),
    ...pmCodes.map((code) => {
      const f = pm.find((x) => x.blocker === code);
      return { code, passed: !f, detail: f?.detail ?? '' };
    }),
  ];
}

/** CLSD — every check passed, then Phase 11's close (which reads its five again). */
export async function close(tx: Tx, ctx: ActorContext, projectCode: string, note: string): Promise<void> {
  const failed = (await closeChecks(tx, projectCode)).filter((c) => !c.passed);
  if (failed.length > 0) throw new ProjectSystemError('close', `${projectCode} cannot be closed: ${failed.map((f) => f.detail).join('; ')}`);
  await projects.close(tx, ctx, projectCode, requireText(note, 'note', 500));
}

// ---------------------------------------------------------------------------
// Settlement (§12, D-PM-7)
// ---------------------------------------------------------------------------

export interface SettlementFigures {
  readonly kind: SettlementKind;
  /** The cost rows to the date not yet settled — the project's own index. */
  readonly costIqd: bigint;
  /** The project's expense in the ledger to the date — what the asset settlement moves. */
  readonly glCostIqd: bigint;
  readonly byAccount: readonly { readonly accountId: string; readonly accountCode: string; readonly departmentCode: string | null; readonly businessLineCode: string | null; readonly amountIqd: bigint }[];
  /** Revenue the posted certificates billed to the date. */
  readonly billedIqd: bigint;
  /** A recognition run still standing (to be reversed). */
  readonly openRecognition: { readonly periodEnd: string; readonly adjustmentIqd: bigint } | null;
}

export async function settlementFigures(tx: Tx, projectCode: string, on: string): Promise<SettlementFigures> {
  const row = await load(tx, projectCode);
  const [index] = await rows<{ total: string }>(tx, sql`select coalesce(sum(amount_iqd), 0)::text as total from project_cost where project_code = ${projectCode} and settlement_id is null and incurred_on <= ${on}::date`);
  const accounts = await rows<{ account_id: string; code: string; department_code: string | null; business_line_code: string | null; amount: string }>(
    tx,
    sql`
      select l.account_id, a.code, l.department_code, l.business_line_code, sum(l.debit_iqd - l.credit_iqd)::text as amount
        from journal_line l
        join journal_entry j on j.id = l.journal_entry_id
        join chart_of_account a on a.id = l.account_id
       where l.project_code = ${projectCode} and j.status in ('posted', 'reversed')
         and a.account_type = 'expense' and j.posting_date <= ${on}::date
       group by l.account_id, a.code, l.department_code, l.business_line_code
      having sum(l.debit_iqd - l.credit_iqd) <> 0
       order by a.code, l.department_code nulls first`,
  );
  const byAccount = accounts.map((a) => ({ accountId: a.account_id, accountCode: a.code, departmentCode: a.department_code, businessLineCode: a.business_line_code, amountIqd: parseDecimal(a.amount, MONEY) }));
  const [billed] = await rows<{ total: string }>(tx, sql`select coalesce(sum(gross_iqd), 0)::text as total from project_certificate where project_code = ${projectCode} and status = 'posted' and certified_on <= ${on}::date`);
  const [open] = await rows<{ period_end: string; adjustment: string }>(
    tx,
    sql`select period_end::text, adjustment_iqd::text as adjustment from project_recognition where project_code = ${projectCode} and reversed_on is null and journal_entry_id is not null order by period_end desc limit 1`,
  );
  return {
    kind: settlementKindOf(row.kind),
    costIqd: parseDecimal(index?.total ?? '0', MONEY),
    glCostIqd: byAccount.reduce((sum, a) => sum + a.amountIqd, 0n),
    byAccount,
    billedIqd: parseDecimal(billed?.total ?? '0', MONEY),
    openRecognition: open ? { periodEnd: open.period_end, adjustmentIqd: parseDecimal(open.adjustment, MONEY) } : null,
  };
}

/** Nothing may still be on its way into the cost: an open order, a draft issue, hours not yet posted. */
async function assertNothingPending(tx: Tx, projectCode: string): Promise<void> {
  const [pending] = await rows<{ commitments: number; issues: number; timesheets: number }>(
    tx,
    sql`
      select (select count(*)::int from project_commitment where project_code = ${projectCode} and released_on is null and consumed_iqd < amount_iqd) as commitments,
             (select count(*)::int from project_material_issue where project_code = ${projectCode} and status = 'draft') as issues,
             (select count(*)::int from project_timesheet where project_code = ${projectCode} and status in ('draft', 'approved')) as timesheets`,
  );
  const reasons: string[] = [];
  if (pending?.commitments) reasons.push(`${pending.commitments} open commitment(s)`);
  if (pending?.issues) reasons.push(`${pending.issues} draft material issue(s)`);
  if (pending?.timesheets) reasons.push(`${pending.timesheets} timesheet line(s) not yet posted or cancelled`);
  if (reasons.length) throw new ProjectSystemError('settlement', `${projectCode} still has cost on its way — ${reasons.join(', ')}; settle once it has arrived or been released`);
}

export async function createSettlement(tx: Tx, ctx: ActorContext, projectCode: string, input: { settledOn: string; note?: string | null }): Promise<{ settlementNo: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'create', PERMISSION_OBJECT, projectCode);
  if (row.status !== 'closing') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; a project is settled once it is technically complete`);
  const on = day(input.settledOn, 'settled_on');
  if (on > businessToday()) throw new ProjectSystemError('settled_on', 'a settlement is dated on a day that has come');
  const [existing] = await tx
    .select({ settlementNo: projectSettlement.settlementNo, status: projectSettlement.status })
    .from(projectSettlement)
    .where(and(eq(projectSettlement.projectCode, projectCode), sql`${projectSettlement.status} <> 'cancelled'`))
    .limit(1);
  if (existing) throw new ProjectSystemError('settlement', `${projectCode} already has settlement ${existing.settlementNo} (${existing.status}); one per project (D-PM-7)`);
  await assertNothingPending(tx, projectCode);
  const figures = await settlementFigures(tx, projectCode, on);
  const branchCode = row.branchCode ?? ctx.branchCode;
  const allocated = await allocateDocumentNumber(tx, SETTLEMENT_SEQUENCE_KEY, { branchCode, year: Number(on.slice(0, 4)) }, ctx.principal.userId);
  await tx.insert(projectSettlement).values({
    settlementNo: allocated.documentNo,
    projectCode,
    branchCode,
    kind: figures.kind,
    settledOn: on,
    costIqd: money(figures.costIqd),
    glCostIqd: money(figures.glCostIqd),
    billedIqd: money(figures.billedIqd),
    note: optionalText(input.note),
    createdBy: ctx.principal.userId,
  });
  await recordChange(tx, ctx, {
    action: 'project_settlement.created',
    objectType: SETTLEMENT_DOCUMENT_TYPE,
    objectId: allocated.documentNo,
    branchCode,
    after: { projectCode, kind: figures.kind, settledOn: on, costIqd: money(figures.costIqd), glCostIqd: money(figures.glCostIqd), billedIqd: money(figures.billedIqd) },
  });
  return { settlementNo: allocated.documentNo };
}

/**
 * Posted by somebody other than its drafter (D-PM-6: the accounting
 * manager): the figures read again at its date, the journal written, every
 * cost row to the date marked settled.
 */
export async function postSettlement(tx: Tx, ctx: ActorContext, settlementNo: string): Promise<{ journalEntryId: string | null; recognitionReversalEntryId: string | null }> {
  const [locked] = await rows<{ id: string }>(tx, sql`select id from project_settlement where settlement_no = ${settlementNo} for update`);
  if (!locked) throw new AdminNotFoundError('project_settlement', settlementNo);
  const [doc] = await tx.select().from(projectSettlement).where(eq(projectSettlement.id, locked.id)).limit(1);
  const row = await load(tx, doc!.projectCode);
  await permit(ctx, 'approve', PERMISSION_OBJECT, doc!.projectCode);
  if (doc!.status !== 'draft') throw new ProjectSystemError('status', `${settlementNo} is ${doc!.status}; a draft is posted`);
  if (doc!.createdBy === ctx.principal.userId) throw new ProjectSystemError('approver', `${settlementNo} was drafted by you; somebody else posts it`);
  if (row.status !== 'closing') throw new ProjectSystemError('status', `${doc!.projectCode} is ${row.status}; a project is settled while technically complete`);
  await assertNothingPending(tx, doc!.projectCode);
  const figures = await settlementFigures(tx, doc!.projectCode, doc!.settledOn);
  const criteria = { branchCode: doc!.branchCode, projectCode: doc!.projectCode };

  let journalEntryId: string | null = null;
  let recognitionReversalEntryId: string | null = null;
  if (figures.kind === 'asset' && figures.glCostIqd !== 0n) {
    if (figures.glCostIqd < 0n) throw new ProjectSystemError('settlement', `${doc!.projectCode}'s cost in the ledger is ${money(figures.glCostIqd)}; a negative cost is not capitalised`);
    const dimensions = (a: SettlementFigures['byAccount'][number]) => ({ branch: doc!.branchCode, project: doc!.projectCode, department: a.departmentCode, business_line: a.businessLineCode });
    const lines: PostingLineRequest[] = [
      { role: 'project_auc', debit: money(figures.glCostIqd), criteria, dimensions: { branch: doc!.branchCode, project: doc!.projectCode, department: row.departmentCode ?? null, business_line: row.businessLineCode ?? null } },
      ...figures.byAccount.map((a): PostingLineRequest =>
        a.amountIqd > 0n
          ? { role: 'project_cost', accountId: a.accountId, credit: money(a.amountIqd), criteria, dimensions: dimensions(a) }
          : { role: 'project_cost', accountId: a.accountId, debit: money(-a.amountIqd), criteria, dimensions: dimensions(a) },
      ),
    ];
    const result = await posting.post(tx, ctx, {
      eventType: 'projects.settlement',
      documentTypeCode: SETTLEMENT_DOCUMENT_TYPE,
      source: { module: 'projects', documentId: doc!.id, event: 'posted' },
      branchCode: doc!.branchCode,
      documentDate: doc!.settledOn,
      postingDate: doc!.settledOn,
      description: `Settlement ${settlementNo} — ${doc!.projectCode} to the asset under construction`,
      lines,
    });
    journalEntryId = result.journalEntryId;
  }
  if (figures.openRecognition) {
    recognitionReversalEntryId = await billing.reverseOpenRecognition(tx, ctx, doc!.projectCode, doc!.settledOn);
  }

  await tx
    .update(projectCost)
    .set({ settlementId: doc!.id })
    .where(and(eq(projectCost.projectCode, doc!.projectCode), sql`${projectCost.settlementId} is null`, sql`${projectCost.incurredOn} <= ${doc!.settledOn}::date`));
  const now = new Date();
  await tx
    .update(projectSettlement)
    .set({
      status: 'posted',
      postedBy: ctx.principal.userId,
      postedAt: now,
      costIqd: money(figures.costIqd),
      glCostIqd: money(figures.glCostIqd),
      billedIqd: money(figures.billedIqd),
      journalEntryId,
      recognitionReversalEntryId,
    })
    .where(eq(projectSettlement.id, doc!.id));
  await recordChange(tx, ctx, {
    action: 'project_settlement.posted',
    objectType: SETTLEMENT_DOCUMENT_TYPE,
    objectId: settlementNo,
    branchCode: doc!.branchCode,
    before: { status: 'draft' },
    after: { status: 'posted', kind: figures.kind, glCostIqd: money(figures.glCostIqd), costIqd: money(figures.costIqd), billedIqd: money(figures.billedIqd), journalEntryId, recognitionReversalEntryId },
  });
  return { journalEntryId, recognitionReversalEntryId };
}

export async function cancelSettlement(tx: Tx, ctx: ActorContext, settlementNo: string, reason: string): Promise<void> {
  const [doc] = await tx.select().from(projectSettlement).where(eq(projectSettlement.settlementNo, settlementNo)).for('update');
  if (!doc) throw new AdminNotFoundError('project_settlement', settlementNo);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, doc.projectCode);
  const why = requireText(reason, 'reason', 500);
  if (doc.status !== 'draft') throw new ProjectSystemError('status', `${settlementNo} is ${doc.status}; only a draft is cancelled`);
  const now = new Date();
  await tx.update(projectSettlement).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: now, cancelReason: why }).where(eq(projectSettlement.id, doc.id));
  await recordChange(tx, ctx, { action: 'project_settlement.cancelled', objectType: SETTLEMENT_DOCUMENT_TYPE, objectId: settlementNo, branchCode: doc.branchCode, before: { status: 'draft' }, after: { status: 'cancelled' }, reason: why });
}

export async function settlements(tx: Tx, projectCode: string) {
  const list = await tx
    .select({ settlement: projectSettlement, entryNo: journalEntry.entryNo, createdByName: appUser.displayName })
    .from(projectSettlement)
    .leftJoin(journalEntry, eq(journalEntry.id, projectSettlement.journalEntryId))
    .leftJoin(appUser, eq(appUser.id, projectSettlement.createdBy))
    .where(eq(projectSettlement.projectCode, projectCode))
    .orderBy(desc(projectSettlement.createdAt));
  const reversals = await rows<{ id: string; entry_no: string }>(
    tx,
    sql`select s.id, j.entry_no from project_settlement s join journal_entry j on j.id = s.recognition_reversal_entry_id where s.project_code = ${projectCode}`,
  );
  return list.map((r) => ({ ...r.settlement, entryNo: r.entryNo, createdByName: r.createdByName, recognitionEntryNo: reversals.find((x) => x.id === r.settlement.id)?.entry_no ?? null }));
}

// ---------------------------------------------------------------------------
// Labour: timesheets (§8, D-PM-8)
// ---------------------------------------------------------------------------

export interface HoursInput {
  readonly wbsCode: string;
  readonly employeeId: string;
  readonly workDate: string;
  readonly hours: string;
  readonly costCode?: string | null;
  readonly note?: string | null;
}

export async function bookHours(tx: Tx, ctx: ActorContext, projectCode: string, input: HoursInput): Promise<{ id: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'create', PERMISSION_OBJECT, projectCode);
  if (row.status !== 'active' && row.status !== 'closing') throw new ProjectSystemError('status', `${projectCode} is ${row.status}; hours are booked on a released project`);
  const wbsCode = requireText(input.wbsCode, 'wbs_code', 80);
  await projects.assertAccountAssignmentElement(tx, projectCode, wbsCode);
  const [person] = await tx.select({ id: employee.id, status: employee.status, employeeNo: employee.employeeNo }).from(employee).where(eq(employee.id, requireText(input.employeeId, 'employee'))).limit(1);
  if (!person) throw new ProjectSystemError('employee', 'names no employee');
  if (person.status !== 'active') throw new ProjectSystemError('employee', `${person.employeeNo} is ${person.status}`);
  const on = day(input.workDate, 'work_date');
  if (on > businessToday()) throw new ProjectSystemError('work_date', 'hours are booked for a day that has come');
  const text = (input.hours ?? '').trim();
  let hours: bigint;
  try {
    hours = parseDecimal(text, HOURS);
  } catch {
    throw new ProjectSystemError('hours', `'${text}' is not a number of hours`);
  }
  if (hours <= 0n || hours > 2400n) throw new ProjectSystemError('hours', 'a day holds more than 0 and at most 24 hours');
  const costCode = (input.costCode ?? '').trim().toUpperCase() || 'LAB';
  const [code] = await tx.select({ active: projectCostCode.active }).from(projectCostCode).where(eq(projectCostCode.code, costCode)).limit(1);
  if (!code) throw new ProjectSystemError('cost_code', `there is no cost code '${costCode}'`);
  if (!code.active) throw new ProjectSystemError('cost_code', `cost code ${costCode} is deactivated`);
  const [created] = await tx
    .insert(projectTimesheet)
    .values({ projectCode, wbsCode, costCode, employeeId: person.id, workDate: on, hours: toDecimalString(hours, HOURS), note: optionalText(input.note), createdBy: ctx.principal.userId })
    .returning({ id: projectTimesheet.id });
  await recordChange(tx, ctx, { action: 'project_timesheet.booked', objectType: 'project', objectId: projectCode, branchCode: row.branchCode, after: { wbsCode, employeeNo: person.employeeNo, workDate: on, hours: toDecimalString(hours, HOURS), costCode } });
  return { id: created!.id };
}

async function lockSheet(tx: Tx, id: string) {
  const [sheet] = await tx.select().from(projectTimesheet).where(eq(projectTimesheet.id, id)).for('update');
  if (!sheet) throw new AdminNotFoundError('project_timesheet', id);
  return sheet;
}

export async function approveHours(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const sheet = await lockSheet(tx, id);
  await permit(ctx, 'approve', PERMISSION_OBJECT, sheet.projectCode);
  if (sheet.status !== 'draft') throw new ProjectSystemError('status', `the line is ${sheet.status}; a draft is approved`);
  if (sheet.createdBy === ctx.principal.userId) throw new ProjectSystemError('approver', 'you booked these hours; somebody else approves them');
  await tx.update(projectTimesheet).set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: new Date() }).where(eq(projectTimesheet.id, id));
  await recordChange(tx, ctx, { action: 'project_timesheet.approved', objectType: 'project', objectId: sheet.projectCode, after: { id, workDate: sheet.workDate, hours: sheet.hours } });
}

export async function cancelHours(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const sheet = await lockSheet(tx, id);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, sheet.projectCode);
  const why = requireText(reason, 'reason', 500);
  if (sheet.status === 'posted' || sheet.status === 'cancelled') throw new ProjectSystemError('status', `the line is ${sheet.status}`);
  await tx.update(projectTimesheet).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: new Date(), cancelReason: why }).where(eq(projectTimesheet.id, id));
  await recordChange(tx, ctx, { action: 'project_timesheet.cancelled', objectType: 'project', objectId: sheet.projectCode, before: { status: sheet.status }, after: { status: 'cancelled' }, reason: why });
}

export async function timesheets(tx: Tx, projectCode: string) {
  return tx
    .select({
      id: projectTimesheet.id,
      wbsCode: projectTimesheet.wbsCode,
      elementName: projectWbs.name,
      costCode: projectTimesheet.costCode,
      employeeNo: employee.employeeNo,
      employeeName: employee.fullNameEn,
      employeeNameAr: employee.fullNameAr,
      workDate: projectTimesheet.workDate,
      hours: projectTimesheet.hours,
      status: projectTimesheet.status,
      note: projectTimesheet.note,
      createdBy: projectTimesheet.createdBy,
      amountIqd: projectTimesheet.amountIqd,
      cancelReason: projectTimesheet.cancelReason,
    })
    .from(projectTimesheet)
    .innerJoin(employee, eq(employee.id, projectTimesheet.employeeId))
    .leftJoin(projectWbs, and(eq(projectWbs.projectCode, projectTimesheet.projectCode), eq(projectWbs.code, projectTimesheet.wbsCode)))
    .where(eq(projectTimesheet.projectCode, projectCode))
    .orderBy(desc(projectTimesheet.workDate), asc(employee.employeeNo));
}

/** The people hours can be booked for: active employees the reader can see. */
export async function bookable(tx: Tx) {
  return tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, fullNameAr: employee.fullNameAr })
    .from(employee)
    .where(eq(employee.status, 'active'))
    .orderBy(asc(employee.employeeNo));
}

/**
 * D-PM-8 — a month's approved hours on the project, posted at the month's
 * end: each employee's rate is the base salary in force at the month's end ÷
 * the project calendar's working days in the month ÷ 8; the element's cost
 * rows and one journal — Dr the cost code's account (or `project_labour`),
 * Cr `labour_absorption` — the employee and the project on every line.
 */
export async function postLabour(tx: Tx, ctx: ActorContext, projectCode: string, month: string): Promise<{ runId: string; hours: string; amountIqd: string; journalEntryId: string }> {
  const row = await load(tx, projectCode);
  await permit(ctx, 'post', PERMISSION_OBJECT, projectCode);
  await authz.authorize(ctx.principal, 'view', COMPENSATION_OBJECT, { branchCode: row.branchCode ?? ctx.branchCode, objectId: projectCode });
  const { first, last } = monthBounds(month);
  if (last > businessToday()) throw new ProjectSystemError('month', `${month} has not ended; its hours are posted at its end`);
  const sheets = (
    await tx.execute(sql`
      select t.id, t.wbs_code, t.cost_code, t.hours::text as hours, e.id as employee_id, e.employee_no, e.department_code
        from project_timesheet t join employee e on e.id = t.employee_id
       where t.project_code = ${projectCode} and t.status = 'approved' and t.work_date between ${first}::date and ${last}::date
       order by e.employee_no, t.work_date
       for update of t`)
  ).rows as { id: string; wbs_code: string; cost_code: string; hours: string; employee_id: string; employee_no: string; department_code: string | null }[];
  if (sheets.length === 0) throw new ProjectSystemError('month', `${projectCode} has no approved hours in ${month} waiting to be posted`);

  const calendar = await schedule.calendarOf(tx, projectCode);
  const workingDays = workingDaysIn(month, calendar);
  const rates = new Map<string, bigint>();
  for (const s of sheets) {
    if (rates.has(s.employee_id)) continue;
    const [pay] = await rows<{ base: string }>(
      tx,
      sql`select base_salary_iqd::text as base from employee_compensation where employee_id = ${s.employee_id}::uuid and effective_from <= ${last}::date order by effective_from desc, recorded_at desc limit 1`,
    );
    if (!pay) throw new ProjectSystemError('compensation', `${s.employee_no} has no compensation in force by ${last}; HR records it before the hours are posted`);
    rates.set(s.employee_id, hourlyRate(parseDecimal(pay.base, MONEY), workingDays));
  }

  const runId = randomUUID();
  const amounts = sheets.map((s) => ({ ...s, rate: rates.get(s.employee_id)!, amount: labourAmount(parseDecimal(s.hours, HOURS), rates.get(s.employee_id)!) }));
  const total = amounts.reduce((sum, a) => sum + a.amount, 0n);
  const totalHours = amounts.reduce((sum, a) => sum + parseDecimal(a.hours, HOURS), 0n);
  if (total <= 0n) throw new ProjectSystemError('month', 'the hours come to nothing at the rates in force');

  // The element's cost, through availability control — a month of labour is spending like any other.
  const byElement = new Map<string, bigint>();
  for (const a of amounts) byElement.set(`${a.wbs_code}|${a.cost_code}`, (byElement.get(`${a.wbs_code}|${a.cost_code}`) ?? 0n) + a.amount);
  const costIds: string[] = [];
  for (const [key, amount] of byElement) {
    const [wbsCode, costCode] = key.split('|') as [string, string];
    const made = await projects.recordCost(tx, ctx, projectCode, { costCode, kind: 'labour', description: `Labour ${month}`, incurredOn: last, amountIqd: amount, wbsCode, sourceType: 'project_timesheet_run', sourceId: runId });
    costIds.push(made.id);
  }

  // The journal: per employee and cost code, the cost against the absorption.
  const codes = await tx.select({ code: projectCostCode.code, accountId: projectCostCode.accountId }).from(projectCostCode).where(inArray(projectCostCode.code, [...new Set(amounts.map((a) => a.cost_code))]));
  const criteria = { branchCode: row.branchCode ?? ctx.branchCode, projectCode };
  const lines: PostingLineRequest[] = [];
  const byPerson = new Map<string, { employeeNo: string; department: string | null; costCode: string; amount: bigint }>();
  for (const a of amounts) {
    const key = `${a.employee_no}|${a.cost_code}`;
    const prior = byPerson.get(key);
    byPerson.set(key, { employeeNo: a.employee_no, department: a.department_code, costCode: a.cost_code, amount: (prior?.amount ?? 0n) + a.amount });
  }
  for (const p of byPerson.values()) {
    // The employee dimension has no master data registered yet (§4.2); the hours keep the person, the line says who.
    const dimensions = { branch: criteria.branchCode, project: projectCode, department: p.department ?? row.departmentCode ?? null, business_line: row.businessLineCode ?? null };
    const account = codes.find((c) => c.code === p.costCode)?.accountId ?? null;
    const description = `Labour ${month} — ${p.employeeNo}`;
    lines.push({ role: 'project_labour', ...(account ? { accountId: account } : {}), debit: money(p.amount), criteria, dimensions, description });
    // The absorption is the employee's department's, not the project's: with the project on it the
    // project's expense would net to nothing and the settlement would find no labour to move.
    lines.push({ role: 'labour_absorption', credit: money(p.amount), criteria, dimensions: { branch: criteria.branchCode, department: p.department ?? row.departmentCode ?? null }, description });
  }
  const result = await posting.post(tx, ctx, {
    eventType: 'projects.timesheet',
    documentTypeCode: TIMESHEET_DOCUMENT_TYPE,
    source: { module: 'projects', documentId: runId, event: 'posted' },
    branchCode: criteria.branchCode,
    documentDate: last,
    postingDate: last,
    description: `Labour ${month} — ${projectCode} (${toDecimalString(totalHours, HOURS)} h)`,
    lines,
  });

  await tx.insert(projectTimesheetRun).values({ id: runId, projectCode, month: first, postedOn: last, hours: toDecimalString(totalHours, HOURS), amountIqd: money(total), journalEntryId: result.journalEntryId, createdBy: ctx.principal.userId });
  for (const a of amounts) {
    await tx.update(projectTimesheet).set({ status: 'posted', runId, rateIqd: money(a.rate), amountIqd: money(a.amount) }).where(eq(projectTimesheet.id, a.id));
  }
  await tx.update(projectCost).set({ journalEntryId: result.journalEntryId }).where(inArray(projectCost.id, costIds));
  await recordChange(tx, ctx, {
    action: 'project_timesheet.month_posted',
    objectType: 'project',
    objectId: projectCode,
    branchCode: row.branchCode,
    after: { month, lines: amounts.length, hours: toDecimalString(totalHours, HOURS), amountIqd: money(total), workingDays, journalEntryId: result.journalEntryId },
  });
  return { runId, hours: toDecimalString(totalHours, HOURS), amountIqd: money(total), journalEntryId: result.journalEntryId };
}

export async function labourRuns(tx: Tx, projectCode: string) {
  return tx
    .select({ id: projectTimesheetRun.id, month: projectTimesheetRun.month, postedOn: projectTimesheetRun.postedOn, hours: projectTimesheetRun.hours, amountIqd: projectTimesheetRun.amountIqd, entryNo: journalEntry.entryNo })
    .from(projectTimesheetRun)
    .innerJoin(journalEntry, eq(journalEntry.id, projectTimesheetRun.journalEntryId))
    .where(eq(projectTimesheetRun.projectCode, projectCode))
    .orderBy(desc(projectTimesheetRun.month), desc(projectTimesheetRun.createdAt));
}
