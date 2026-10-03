/**
 * Payroll — REQ-HR-001 Stage HR-3 (§6, §9).
 *
 * A run is one branch's month (PAY-{BRANCH}-{YYYY}-{SERIAL}, one live run per
 * branch per month). Its draft gathers everybody the branch employed in the
 * month and computes each line from facts (R2): the compensation row in force
 * at the month's end, the person's own component figures, the components'
 * defaults, and the month as the day sheet and the leave read it
 * (`attendance.summary`). Only a manual component is typed — on the line,
 * with its note — and a typed total is impossible: the line's figures are the
 * sum of its components, held by the database.
 *
 *     draft ──submit──▶ submitted ──approve──▶ approved ──post──▶ posted ──pay──▶ paid
 *       ▲                  │   ▲                  │                 │
 *       └──── return (note) ───┴──────────────────┘                 └─ reverse (reason) ─▶ reversed
 *     draft / submitted / approved ──cancel (reason)──▶ cancelled
 *
 * Whoever prepared or sent a run never approves it (a database check). The
 * run is a sheet of salaries, so it is prepared by a reader of compensation —
 * the HR manager — approved by the accounting manager or the CEO, and posted
 * and paid by Finance (B-HR-13).
 *
 * Posting writes one journal (`hr.payroll_run`, `domain/payroll.journalPlan`)
 * dated the month's last day and gives every line its payslip number; the
 * lines are then frozen by the database (R3). The net pay is owed on the
 * `net_pay` account until a payment of each pay method leaves a bank or cash
 * account (`hr.payroll_payment`) — the bank sub-ledger, the reconciliation and
 * the cash forecast read it as they read every other payment (B-HR-14). A
 * posted run nothing has been paid from is reversed whole — its journal
 * mirrored — and run again; never edited.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  bankCashAccount,
  employee,
  employeeCompensation,
  employeePayComponent,
  journalEntry,
  payComponent,
  payrollLine,
  payrollLineComponent,
  payrollPayment,
  payrollRun,
  position,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { HrValidationError, assertDay, isPayMethod, type PayCalculation, type PayComponentKind, type PayMethod } from '../domain/hr';
import { dayKind, daysBetween, daysText, yearOf } from '../domain/hr-time';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import {
  PayrollError,
  assertPayrollTransition,
  assertTypedEntries,
  computeLine,
  employedSpan,
  journalPlan,
  monthOf,
  planBalances,
  type ComponentAccounts,
  type ComponentRule,
  type PayrollStatus,
  type PersonalFigure,
  type TypedEntry,
} from '../domain/payroll';
import type { PostingLineRequest } from '../domain/posting';
import { can, type PermissionVerb } from '../domain/permissions';
import { AdminNotFoundError, optionalText, recordChange, requireText } from './administration';
import * as attendance from './attendance';
import * as advances from './employee-advances';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as journals from './journal';
import { calendarsFor } from './leave';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import * as posting from './posting';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'payroll_run';
const COMPENSATION_OBJECT = 'employee_compensation';
const SEQUENCE_KEY = 'PAYROLL_RUN';
const PAYSLIP_SEQUENCE_KEY = 'PAYSLIP';
export const DOCUMENT_TYPE = 'payroll_run';
const PAYMENT_DOCUMENT_TYPE = 'payroll_payment';

export { PayrollError };

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const scaled = (value: string | null | undefined) => parseDecimal((value ?? '0').trim() || '0', MONEY_SCALE);

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

type RunRow = typeof payrollRun.$inferSelect;

async function load(tx: Tx, runNo: string, options: { lock?: boolean } = {}): Promise<RunRow> {
  const query = tx.select().from(payrollRun).where(eq(payrollRun.runNo, runNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('payroll run', runNo);
  return row;
}

async function authorize(ctx: ActorContext, verb: PermissionVerb, run: { branchCode: string; runNo?: string }): Promise<void> {
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode: run.branchCode, objectId: run.runNo ?? null, requestId: ctx.requestId ?? null });
}

/** The active components, as the computation reads them, and where each posts. */
export async function componentRules(tx: Tx): Promise<{ rules: ComponentRule[]; accounts: Map<string, ComponentAccounts> }> {
  const rows = await tx.select().from(payComponent).where(eq(payComponent.active, true)).orderBy(asc(payComponent.sortOrder), asc(payComponent.code));
  return {
    rules: rows.map((r) => ({
      code: r.code,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      kind: r.kind as PayComponentKind,
      calculation: r.calculation as PayCalculation,
      defaultValue: scaled(r.defaultValue),
      sortOrder: r.sortOrder,
    })),
    accounts: new Map(rows.map((r) => [r.code, { expenseAccountId: r.expenseAccountId, liabilityAccountId: r.liabilityAccountId }])),
  };
}

/** The month's working days on the year's calendar. */
async function workingDaysOf(tx: Tx, first: string, last: string): Promise<number> {
  const calendar = await calendarsFor(tx, [yearOf(first)]);
  return daysBetween(first, last).filter((day) => dayKind(day, calendar(yearOf(day))) === 'working').length;
}

/** Who the branch employed in the month: hired by its end, not gone before it, not suspended. */
async function peopleOf(tx: Tx, branchCode: string, first: string, last: string) {
  return tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      departmentCode: employee.departmentCode,
      positionTitle: position.titleEn,
      hireDate: employee.hireDate,
      endDate: employee.endDate,
      status: employee.status,
    })
    .from(employee)
    .leftJoin(position, eq(position.code, employee.positionCode))
    .where(and(eq(employee.branchCode, branchCode), lte(employee.hireDate, last), sql`(${employee.endDate} is null or ${employee.endDate} >= ${first}::date)`, sql`${employee.status} <> 'suspended'`))
    .orderBy(asc(employee.employeeNo));
}

/** The compensation row in force at the month's end, per person. */
async function compensationAt(tx: Tx, ids: readonly string[], asOf: string) {
  if (ids.length === 0) return new Map<string, typeof employeeCompensation.$inferSelect>();
  const rows = await tx
    .selectDistinctOn([employeeCompensation.employeeId])
    .from(employeeCompensation)
    .where(and(inArray(employeeCompensation.employeeId, [...ids]), lte(employeeCompensation.effectiveFrom, asOf)))
    .orderBy(employeeCompensation.employeeId, desc(employeeCompensation.effectiveFrom), desc(employeeCompensation.recordedAt));
  return new Map(rows.map((r) => [r.employeeId, r]));
}

/** Each person's own component figures in force at the month's end. */
async function figuresAt(tx: Tx, ids: readonly string[], asOf: string): Promise<Map<string, PersonalFigure[]>> {
  const out = new Map<string, PersonalFigure[]>();
  if (ids.length === 0) return out;
  const rows = await tx
    .selectDistinctOn([employeePayComponent.employeeId, employeePayComponent.componentCode])
    .from(employeePayComponent)
    .where(and(inArray(employeePayComponent.employeeId, [...ids]), lte(employeePayComponent.effectiveFrom, asOf)))
    .orderBy(employeePayComponent.employeeId, employeePayComponent.componentCode, desc(employeePayComponent.effectiveFrom), desc(employeePayComponent.recordedAt));
  for (const r of rows) {
    const list = out.get(r.employeeId) ?? [];
    list.push({ componentCode: r.componentCode, amount: r.amount === null ? null : scaled(r.amount), stopped: r.stopped });
    out.set(r.employeeId, list);
  }
  return out;
}

/** What was typed on a draft's lines, kept across a recompute. */
async function typedOf(tx: Tx, runId: string): Promise<Map<string, TypedEntry[]>> {
  const rows = await tx
    .select({ employeeId: payrollLine.employeeId, componentCode: payrollLineComponent.componentCode, amount: payrollLineComponent.amountIqd, note: payrollLineComponent.note })
    .from(payrollLineComponent)
    .innerJoin(payrollLine, eq(payrollLine.id, payrollLineComponent.lineId))
    .where(and(eq(payrollLine.runId, runId), eq(payrollLineComponent.calculation, 'manual')));
  const out = new Map<string, TypedEntry[]>();
  for (const r of rows) {
    const list = out.get(r.employeeId) ?? [];
    list.push({ componentCode: r.componentCode, amount: scaled(r.amount), note: r.note });
    out.set(r.employeeId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Computing a draft
// ---------------------------------------------------------------------------

/**
 * The run's lines, computed afresh from the facts: the draft's lines are
 * replaced whole, the typed figures carried by person and component.
 */
async function computeRun(tx: Tx, run: RunRow, typed: Map<string, TypedEntry[]>): Promise<{ employees: number; missingCompensation: string[] }> {
  const { first, last } = { first: run.periodMonth, last: run.periodEnd };
  const [{ rules }, people, workingDays] = await Promise.all([componentRules(tx), peopleOf(tx, run.branchCode, first, last), workingDaysOf(tx, first, last)]);
  const ids = people.map((p) => p.id);
  const [pay, figures, owed] = await Promise.all([compensationAt(tx, ids, last), figuresAt(tx, ids, last), advances.dueForMonth(tx, ids, first)]);

  const existing = await tx.select({ id: payrollLine.id }).from(payrollLine).where(eq(payrollLine.runId, run.id));
  if (existing.length > 0) {
    await tx.delete(payrollLineComponent).where(
      inArray(
        payrollLineComponent.lineId,
        existing.map((l) => l.id),
      ),
    );
    await tx.delete(payrollLine).where(eq(payrollLine.runId, run.id));
  }

  let gross = 0n;
  let deductions = 0n;
  let net = 0n;
  let employerCost = 0n;
  const missingCompensation: string[] = [];
  for (const person of people) {
    const span = employedSpan(person, first, last);
    if (!span) continue;
    const month = await attendance.summary(tx, person.id, span.from, span.to);
    const compensation = pay.get(person.id) ?? null;
    if (!compensation) missingCompensation.push(person.employeeNo);
    const entries = typed.get(person.id) ?? [];
    const line = computeLine(
      {
        baseSalary: compensation ? scaled(compensation.baseSalaryIqd) : 0n,
        workingDays,
        employedDays: month.workingDays,
        absentDays: month.absent,
        unpaidLeave: month.unpaidLeave,
        // HR-4 — what the person's advances and loans have due by the month.
        advanceRecovery: owed.get(person.id) ?? 0n,
      },
      rules,
      figures.get(person.id) ?? [],
      entries,
    );
    const lineId = randomUUID();
    await tx.insert(payrollLine).values({
      id: lineId,
      runId: run.id,
      employeeId: person.id,
      branchCode: run.branchCode,
      employeeNo: person.employeeNo,
      fullNameEn: person.fullNameEn,
      fullNameAr: person.fullNameAr,
      departmentCode: person.departmentCode,
      positionTitle: person.positionTitle,
      compensationId: compensation?.id ?? null,
      payMethod: (compensation?.payMethod as PayMethod | undefined) ?? 'bank',
      bankCode: compensation?.bankCode ?? null,
      accountNumber: compensation?.accountNumber ?? null,
      iban: compensation?.iban ?? null,
      workingDays,
      employedDays: month.workingDays,
      presentDays: month.present,
      absentDays: month.absent,
      unrecordedDays: month.unrecorded,
      paidLeaveDays: daysText(month.paidLeave),
      unpaidLeaveDays: daysText(month.unpaidLeave),
      baseSalaryIqd: compensation ? compensation.baseSalaryIqd : '0',
      grossIqd: money(line.gross),
      deductionsIqd: money(line.deductions),
      netIqd: money(line.net),
      employerCostIqd: money(line.employerCost),
    });
    if (line.components.length > 0) {
      await tx.insert(payrollLineComponent).values(
        line.components.map((c) => ({
          lineId,
          componentCode: c.code,
          nameEn: c.nameEn,
          nameAr: c.nameAr,
          kind: c.kind,
          calculation: c.calculation,
          rate: c.rate === null ? null : money(c.rate),
          quantity: c.quantity === null ? null : daysText(c.quantity),
          amountIqd: money(c.amount),
          note: c.note,
          sortOrder: c.sortOrder,
        })),
      );
    }
    gross += line.gross;
    deductions += line.deductions;
    net += line.net;
    employerCost += line.employerCost;
  }
  const employees = people.filter((p) => employedSpan(p, first, last)).length;
  await tx
    .update(payrollRun)
    .set({ workingDays, employees, grossIqd: money(gross), deductionsIqd: money(deductions), netIqd: money(net), employerCostIqd: money(employerCost), computedAt: new Date(), updatedAt: new Date() })
    .where(eq(payrollRun.id, run.id));
  return { employees, missingCompensation };
}

export interface CreateRunInput {
  readonly branchCode: string;
  /** "YYYY-MM". */
  readonly month: string;
  /** When the people are paid; the month's last day when left out. */
  readonly payDate?: string | null;
  readonly note?: string | null;
}

/** A month's draft, computed: one live run per branch per month. */
export async function create(tx: Tx, ctx: ActorContext, input: CreateRunInput): Promise<{ id: string; runNo: string }> {
  const branchCode = requireText(input.branchCode, 'branch', 32);
  await authorize(ctx, 'create', { branchCode });
  // The run is a sheet of salaries: whoever prepares it reads compensation (D-HR-7).
  await authz.authorize(ctx.principal, 'view', COMPENSATION_OBJECT, { branchCode, objectId: input.month, requestId: ctx.requestId ?? null });
  const { first, last } = monthOf(input.month);
  if (first > businessToday()) throw new PayrollError(`${input.month} has not begun; a month's pay is prepared once it has.`);
  const payDate = input.payDate?.trim() ? assertDay(input.payDate.trim(), 'pay_date') : last;
  if (payDate < first) throw new HrValidationError('pay_date', `cannot be before the month it pays (${first})`);
  const [live] = await tx
    .select({ runNo: payrollRun.runNo, status: payrollRun.status })
    .from(payrollRun)
    .where(and(eq(payrollRun.branchCode, branchCode), eq(payrollRun.periodMonth, first), sql`${payrollRun.status} not in ('reversed', 'cancelled')`))
    .limit(1);
  if (live) throw new PayrollError(`${branchCode} already has ${live.runNo} (${live.status}) for ${input.month}; open it, or reverse or cancel it to run the month again.`);

  const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode, year: yearOf(first) }, ctx.principal.userId);
  const id = randomUUID();
  await tx.insert(payrollRun).values({
    id,
    runNo: allocated.documentNo,
    branchCode,
    periodMonth: first,
    periodEnd: last,
    payDate,
    workingDays: 0,
    note: optionalText(input.note),
    createdBy: ctx.principal.userId,
  });
  const run = await load(tx, allocated.documentNo);
  const computed = await computeRun(tx, run, new Map());
  await recordChange(tx, ctx, {
    action: 'payroll_run.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode,
    after: { month: input.month, payDate, employees: computed.employees, missingCompensation: computed.missingCompensation },
  });
  return { id, runNo: allocated.documentNo };
}

async function editableDraft(tx: Tx, ctx: ActorContext, runNo: string): Promise<RunRow> {
  const run = await load(tx, runNo, { lock: true });
  await authorize(ctx, 'edit_draft', run);
  await authz.authorize(ctx.principal, 'view', COMPENSATION_OBJECT, { branchCode: run.branchCode, objectId: run.runNo, requestId: ctx.requestId ?? null });
  if (run.status !== 'draft') throw new PayrollError(`${run.runNo} is ${run.status}; only a draft is computed again or typed on.`);
  return run;
}

/** The draft computed again from today's facts; what was typed stays. */
export async function recompute(tx: Tx, ctx: ActorContext, runNo: string): Promise<void> {
  const run = await editableDraft(tx, ctx, runNo);
  const computed = await computeRun(tx, run, await typedOf(tx, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.recomputed',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    after: { employees: computed.employees, missingCompensation: computed.missingCompensation },
  });
}

export interface DraftInput {
  readonly payDate: string;
  readonly note?: string | null;
}

export async function updateDraft(tx: Tx, ctx: ActorContext, runNo: string, input: DraftInput): Promise<void> {
  const run = await editableDraft(tx, ctx, runNo);
  const payDate = assertDay(input.payDate.trim(), 'pay_date');
  if (payDate < run.periodMonth) throw new HrValidationError('pay_date', `cannot be before the month it pays (${run.periodMonth})`);
  const note = optionalText(input.note);
  await tx.update(payrollRun).set({ payDate, note, updatedAt: new Date() }).where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.updated',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { payDate: run.payDate, note: run.note },
    after: { payDate, note },
  });
}

export interface TypedInput {
  readonly employeeId: string;
  readonly componentCode: string;
  /** Dinars, as typed. */
  readonly amount: string;
  readonly note?: string | null;
}

/**
 * The manual components typed on the draft's lines — overtime, the tax the
 * accountant worked out — each with its note (§9). The run is computed again
 * with them, so every total is still the sum of its parts.
 */
export async function saveTyped(tx: Tx, ctx: ActorContext, runNo: string, entries: readonly TypedInput[]): Promise<{ changed: number }> {
  const run = await editableDraft(tx, ctx, runNo);
  const { rules } = await componentRules(tx);
  const typed = await typedOf(tx, run.id);
  const lines = await tx.select({ employeeId: payrollLine.employeeId, employeeNo: payrollLine.employeeNo }).from(payrollLine).where(eq(payrollLine.runId, run.id));
  const changes: { employeeNo: string; componentCode: string; before: string; after: string }[] = [];
  for (const entry of entries) {
    const line = lines.find((l) => l.employeeId === entry.employeeId);
    if (!line) throw new PayrollError(`That person is not on ${run.runNo}.`);
    const amountText = (entry.amount ?? '').trim() || '0';
    if (!/^\d{1,16}(\.\d{1,4})?$/.test(amountText)) throw new HrValidationError(`${line.employeeNo} ${entry.componentCode}`, `'${amountText}' is not an amount in dinars`);
    const value: TypedEntry = { componentCode: entry.componentCode, amount: scaled(amountText), note: optionalText(entry.note) };
    assertTypedEntries(line.employeeNo, [value], rules);
    const list = typed.get(entry.employeeId) ?? [];
    const prior = list.find((t) => t.componentCode === entry.componentCode);
    if (prior && prior.amount === value.amount && (prior.note ?? null) === value.note) continue;
    if (!prior && value.amount === 0n && !value.note) continue;
    changes.push({ employeeNo: line.employeeNo, componentCode: entry.componentCode, before: money(prior?.amount ?? 0n), after: money(value.amount) });
    typed.set(entry.employeeId, [...list.filter((t) => t.componentCode !== entry.componentCode), value]);
  }
  if (changes.length === 0) return { changed: 0 };
  await computeRun(tx, run, typed);
  await recordChange(tx, ctx, { action: 'payroll_run.typed', objectType: PERMISSION_OBJECT, objectId: run.runNo, branchCode: run.branchCode, after: { changes } });
  return { changed: changes.length };
}

// ---------------------------------------------------------------------------
// Who is told
// ---------------------------------------------------------------------------

/** The active people who hold a verb on runs in the branch. */
async function holders(tx: Tx, verb: PermissionVerb, branchCode: string): Promise<string[]> {
  const rows = (
    await tx.execute(sql`
      select distinct u.id
        from app_user u
        join user_role ur on ur.user_id = u.id
        join role_grant g on g.role_code = ur.role_code
       where u.is_active and g.object = ${PERMISSION_OBJECT} and g.verb = ${verb}::permission_verb
         and exists (select 1 from user_branch_scope s where s.user_id = u.id and s.branch_code = ${branchCode})`)
  ).rows as { id: string }[];
  return rows.map((r) => r.id);
}

async function tell(
  tx: Tx,
  recipients: Iterable<string | null>,
  run: { runNo: string; branchCode: string },
  event: string,
  occurrence: string,
  subject: string,
  body: string,
  except: readonly (string | null)[] = [],
): Promise<void> {
  const skip = new Set(except.filter(Boolean));
  for (const recipientUserId of new Set([...recipients].filter((id): id is string => Boolean(id) && !skip.has(id)))) {
    await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: event,
      objectType: PERMISSION_OBJECT,
      objectId: run.runNo,
      recipientUserId,
      subject,
      body,
      context: { runNo: run.runNo },
      dedupeKey: `${event}:${run.runNo}:${occurrence}:${recipientUserId}`,
      branchCode: run.branchCode,
    });
  }
}

const monthLabel = (run: { periodMonth: string }) => run.periodMonth.slice(0, 7);

// ---------------------------------------------------------------------------
// The life of a run
// ---------------------------------------------------------------------------

/** Sent for approval: computed once more, refused while a line cannot be paid. */
export async function submit(tx: Tx, ctx: ActorContext, runNo: string): Promise<void> {
  const run = await load(tx, runNo, { lock: true });
  await authorize(ctx, 'submit', run);
  await authz.authorize(ctx.principal, 'view', COMPENSATION_OBJECT, { branchCode: run.branchCode, objectId: run.runNo, requestId: ctx.requestId ?? null });
  assertPayrollTransition(run.runNo, run.status, 'submitted');
  const computed = await computeRun(tx, run, await typedOf(tx, run.id));
  if (computed.employees === 0) throw new PayrollError(`${run.runNo} has nobody on it; ${run.branchCode} employed nobody in ${monthLabel(run)}.`);
  if (computed.missingCompensation.length > 0) {
    throw new PayrollError(
      `${computed.missingCompensation.join(', ')} ${computed.missingCompensation.length === 1 ? 'has' : 'have'} no salary in force by ${run.periodEnd}; record it on the employee, then send ${run.runNo}.`,
    );
  }
  const negative = await tx
    .select({ employeeNo: payrollLine.employeeNo })
    .from(payrollLine)
    .where(and(eq(payrollLine.runId, run.id), sql`${payrollLine.netIqd} < 0`));
  if (negative.length > 0) throw new PayrollError(`${negative.map((n) => n.employeeNo).join(', ')}: the deductions are more than the pay; correct the typed figures.`);
  const now = new Date();
  await tx.update(payrollRun).set({ status: 'submitted', submittedBy: ctx.principal.userId, submittedAt: now, updatedAt: now }).where(eq(payrollRun.id, run.id));
  const after = await load(tx, runNo);
  await recordChange(tx, ctx, {
    action: 'payroll_run.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status },
    after: { status: 'submitted', employees: after.employees, grossIqd: after.grossIqd, netIqd: after.netIqd },
  });
  await tell(
    tx,
    await holders(tx, 'approve', run.branchCode),
    run,
    'hr.payroll_submitted',
    now.toISOString(),
    `${run.runNo} waits for your approval`,
    `${run.branchCode} payroll for ${monthLabel(run)}: ${after.employees} people, net ${after.netIqd} IQD.`,
    [run.createdBy, ctx.principal.userId],
  );
}

/** Sent back to the draft with a note — by whoever may approve or post it. */
export async function returnToDraft(tx: Tx, ctx: ActorContext, runNo: string, note: string): Promise<void> {
  const run = await load(tx, runNo, { lock: true });
  const verb: PermissionVerb = run.status === 'approved' ? 'post' : 'approve';
  await authorize(ctx, verb, run);
  assertPayrollTransition(run.runNo, run.status, 'draft');
  const text = requireText(note, 'note', 500);
  const now = new Date();
  await tx
    .update(payrollRun)
    .set({ status: 'draft', returnedBy: ctx.principal.userId, returnedAt: now, returnNote: text, approvedBy: null, approvedAt: null, updatedAt: now })
    .where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.returned',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status },
    after: { status: 'draft' },
    reason: text,
  });
  await tell(tx, [run.createdBy, run.submittedBy], run, 'hr.payroll_returned', now.toISOString(), `${run.runNo} was sent back`, text, [ctx.principal.userId]);
}

/** Whether this reader may approve the run, and if not, why — for the screen. */
export function approvalRefusal(ctx: ActorContext, run: { status: string; createdBy: string; submittedBy: string | null; branchCode: string }): string | null {
  if (run.status !== 'submitted') return 'status';
  if (!can(ctx.principal, 'approve', PERMISSION_OBJECT)) return 'grant';
  // the super user approves alone, by direction 2026-10-03.
  if (!ctx.principal.isSuperUser && (run.createdBy === ctx.principal.userId || run.submittedBy === ctx.principal.userId)) return 'maker';
  return null;
}

/** Approved by somebody who neither prepared nor sent it (a database check too). */
export async function approve(tx: Tx, ctx: ActorContext, runNo: string): Promise<void> {
  const run = await load(tx, runNo, { lock: true });
  await authorize(ctx, 'approve', run);
  assertPayrollTransition(run.runNo, run.status, 'approved');
  // the super user approves alone, by direction 2026-10-03.
  if (!ctx.principal.isSuperUser && (run.createdBy === ctx.principal.userId || run.submittedBy === ctx.principal.userId)) {
    throw new PayrollError(`You prepared ${run.runNo}; somebody else approves it (maker-checker).`);
  }
  const now = new Date();
  await tx.update(payrollRun).set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: now, updatedAt: now }).where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.approved',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status },
    after: { status: 'approved' },
  });
  await tell(
    tx,
    await holders(tx, 'post', run.branchCode),
    run,
    'hr.payroll_approved',
    now.toISOString(),
    `${run.runNo} is approved — post it`,
    `${run.branchCode} payroll for ${monthLabel(run)}, net ${run.netIqd} IQD.`,
    [ctx.principal.userId],
  );
}

/** Lines with their components, for the journal and the payslips. */
async function linesWithComponents(tx: Tx, runId: string) {
  const lines = await tx.select().from(payrollLine).where(eq(payrollLine.runId, runId)).orderBy(asc(payrollLine.employeeNo));
  const components = lines.length
    ? await tx
        .select()
        .from(payrollLineComponent)
        .where(
          inArray(
            payrollLineComponent.lineId,
            lines.map((l) => l.id),
          ),
        )
        .orderBy(asc(payrollLineComponent.sortOrder), asc(payrollLineComponent.componentCode))
    : [];
  return lines.map((line) => ({ line, components: components.filter((c) => c.lineId === line.id) }));
}

/**
 * Posted: one journal dated the month's last day, every line a payslip
 * (PSL-…), the people told their payslip is issued. From here the lines do
 * not change.
 */
export async function post(tx: Tx, ctx: ActorContext, runNo: string): Promise<{ journalEntryId: string; entryNo: string }> {
  const run = await load(tx, runNo, { lock: true });
  await authorize(ctx, 'post', run);
  assertPayrollTransition(run.runNo, run.status, 'posted');
  const [{ accounts }, lines] = await Promise.all([componentRules(tx), linesWithComponents(tx, run.id)]);
  // A component deactivated since it was computed still posts where it said.
  const named = await tx.select({ code: payComponent.code, expenseAccountId: payComponent.expenseAccountId, liabilityAccountId: payComponent.liabilityAccountId }).from(payComponent);
  for (const n of named) if (!accounts.has(n.code)) accounts.set(n.code, { expenseAccountId: n.expenseAccountId, liabilityAccountId: n.liabilityAccountId });
  const plan = journalPlan(
    lines.map(({ line, components }) => ({
      departmentCode: line.departmentCode,
      net: scaled(line.netIqd),
      components: components.map((c) => ({ code: c.componentCode, kind: c.kind, calculation: c.calculation, amount: scaled(c.amountIqd) })),
    })),
    accounts,
  );
  if (plan.length === 0) throw new PayrollError(`${run.runNo} comes to nothing; there is nothing to post.`);
  if (!planBalances(plan)) throw new PayrollError(`${run.runNo} does not balance; compute it again before posting.`);
  const names = new Map(lines.flatMap(({ components }) => components.map((c) => [c.componentCode, c.nameEn] as const)));
  const criteria = { branchCode: run.branchCode };
  const requestLines: PostingLineRequest[] = plan.map((p) => ({
    role: p.role,
    ...(p.accountId ? { accountId: p.accountId } : {}),
    ...(p.side === 'debit' ? { debit: money(p.amount) } : { credit: money(p.amount) }),
    criteria,
    dimensions: p.departmentCode ? { branch: run.branchCode, department: p.departmentCode } : { branch: run.branchCode },
    description:
      p.role === 'net_pay'
        ? `${run.runNo} — net pay ${monthLabel(run)}`
        : `${run.runNo} — ${p.componentCode ? (names.get(p.componentCode) ?? p.componentCode) : ''}${p.departmentCode ? ` · ${p.departmentCode}` : ''}`,
  }));
  const result = await posting.post(tx, ctx, {
    eventType: 'hr.payroll_run',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'hr', documentId: run.id, event: 'posted' },
    branchCode: run.branchCode,
    documentDate: run.periodEnd,
    postingDate: run.periodEnd,
    description: `Payroll ${run.runNo} — ${run.branchCode} ${monthLabel(run)}`,
    lines: requestLines,
  });

  const issuedAt = new Date();
  const issued: { employeeId: string; payslipNo: string }[] = [];
  for (const { line } of lines) {
    const allocated = await allocateDocumentNumber(tx, PAYSLIP_SEQUENCE_KEY, { branchCode: run.branchCode, year: yearOf(run.periodMonth) }, ctx.principal.userId);
    await tx.update(payrollLine).set({ payslipNo: allocated.documentNo, issuedAt }).where(eq(payrollLine.id, line.id));
    issued.push({ employeeId: line.employeeId, payslipNo: allocated.documentNo });
  }
  // HR-4 — the ADVANCE deductions become recovery rows on the people's advances, the oldest first.
  await advances.recordPayrollRecovery(
    tx,
    ctx,
    run,
    lines.map(({ line, components }) => ({
      lineId: line.id,
      employeeId: line.employeeId,
      amount: components.filter((c) => c.calculation === 'advance_recovery').reduce((sum, c) => sum + scaled(c.amountIqd), 0n),
    })),
  );
  await tx
    .update(payrollRun)
    .set({ status: 'posted', postedBy: ctx.principal.userId, postedAt: issuedAt, journalEntryId: result.journalEntryId, updatedAt: issuedAt })
    .where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.posted',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status },
    after: { status: 'posted', journalEntryId: result.journalEntryId, entryNo: result.entryNo, payslips: issued.length, netIqd: run.netIqd },
  });

  // Each person with a sign-in is told their payslip is issued (R5).
  if (issued.length > 0) {
    const users = await tx
      .select({ id: employee.id, appUserId: employee.appUserId })
      .from(employee)
      .where(
        inArray(
          employee.id,
          issued.map((i) => i.employeeId),
        ),
      );
    for (const slip of issued) {
      const userId = users.find((u) => u.id === slip.employeeId)?.appUserId ?? null;
      if (!userId) continue;
      await notifications.insertNotification(tx, {
        ruleCode: null,
        eventType: 'hr.payslip_issued',
        objectType: 'payslip',
        objectId: slip.payslipNo,
        recipientUserId: userId,
        subject: `Your payslip ${slip.payslipNo} for ${monthLabel(run)} is issued`,
        body: `Open it under HR → Payroll → ${slip.payslipNo}.`,
        context: { payslipNo: slip.payslipNo, runNo: run.runNo },
        dedupeKey: `hr.payslip_issued:${slip.payslipNo}:${userId}`,
        branchCode: run.branchCode,
      });
    }
  }
  return { journalEntryId: result.journalEntryId, entryNo: result.entryNo };
}

export interface PayInput {
  readonly payMethod: string;
  readonly bankCashAccountId: string;
  readonly paidOn: string;
  readonly reference?: string | null;
}

/**
 * The net pay of one pay method leaves one bank or cash account: Dr the net
 * pay owed, Cr the account (its own G/L account and its bank sub-ledger). The
 * run is paid when every line is.
 */
export async function pay(tx: Tx, ctx: ActorContext, runNo: string, input: PayInput): Promise<{ paymentId: string; amountIqd: string; entryNo: string }> {
  const run = await load(tx, runNo, { lock: true });
  await authorize(ctx, 'execute', run);
  if (run.status !== 'posted') throw new PayrollError(`${run.runNo} is ${run.status}; a posted run is paid.`);
  if (!isPayMethod(input.payMethod)) throw new HrValidationError('pay_method', 'must be bank or cash');
  const payMethod: PayMethod = input.payMethod;
  const paidOn = assertDay((input.paidOn ?? '').trim(), 'paid_on');
  if (paidOn > businessToday()) throw new HrValidationError('paid_on', `${paidOn} has not come yet; record the payment the day the money leaves`);
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, (input.bankCashAccountId ?? '').trim()))
    .limit(1);
  if (!account) throw new HrValidationError('account', 'choose the bank or cash account the pay leaves');
  if (!account.active) throw new PayrollError(`${account.code} is deactivated.`);
  if (account.currency !== 'IQD') throw new PayrollError(`${account.code} holds ${account.currency}; salaries are paid in dinars (D-HR-2).`);
  if (account.accountType !== payMethod)
    throw new PayrollError(`${account.code} is a ${account.accountType} account; ${payMethod === 'bank' ? 'bank transfers leave a bank account' : 'cash is paid from a cash account'}.`);
  const unpaid = await tx
    .select({ id: payrollLine.id, net: payrollLine.netIqd })
    .from(payrollLine)
    .where(and(eq(payrollLine.runId, run.id), eq(payrollLine.payMethod, payMethod), isNull(payrollLine.paymentId)));
  const amount = unpaid.reduce((sum, l) => sum + scaled(l.net), 0n);
  if (unpaid.length === 0 || amount <= 0n) throw new PayrollError(`${run.runNo} has nothing left to pay by ${payMethod}.`);

  const paymentId = randomUUID();
  const reference = optionalText(input.reference, 120);
  const criteria = { branchCode: run.branchCode };
  const description = `${run.runNo} — net pay ${monthLabel(run)} (${payMethod}${reference ? `, ${reference}` : ''})`;
  const result = await posting.post(tx, ctx, {
    eventType: 'hr.payroll_payment',
    documentTypeCode: PAYMENT_DOCUMENT_TYPE,
    source: { module: 'hr', documentId: paymentId, event: 'paid' },
    branchCode: run.branchCode,
    documentDate: paidOn,
    postingDate: paidOn,
    description,
    lines: [
      { role: 'net_pay', debit: money(amount), criteria, dimensions: { branch: run.branchCode }, description },
      { role: 'bank', accountId: account.glAccountId, credit: money(amount), criteria, dimensions: { branch: run.branchCode }, bankAccountCode: account.code, description },
    ],
  });
  await tx.insert(payrollPayment).values({
    id: paymentId,
    runId: run.id,
    payMethod,
    bankCashAccountId: account.id,
    paidOn,
    reference,
    amountIqd: money(amount),
    lines: unpaid.length,
    journalEntryId: result.journalEntryId,
    paidBy: ctx.principal.userId,
  });
  await tx
    .update(payrollLine)
    .set({ paymentId })
    .where(
      inArray(
        payrollLine.id,
        unpaid.map((l) => l.id),
      ),
    );
  const paid = scaled(run.paidIqd) + amount;
  const done = paid >= scaled(run.netIqd);
  await tx
    .update(payrollRun)
    .set({ paidIqd: money(paid), status: done ? 'paid' : run.status, updatedAt: new Date() })
    .where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.paid',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status, paidIqd: run.paidIqd },
    after: { status: done ? 'paid' : run.status, payMethod, account: account.code, paidOn, amountIqd: money(amount), lines: unpaid.length, entryNo: result.entryNo },
  });
  return { paymentId, amountIqd: money(amount), entryNo: result.entryNo };
}

/**
 * Reversed whole (R3): the journal mirrored on the day it is done, the run
 * marked so the month may be run again. Refused once anything was paid from
 * it — the money has left and the payslips stand.
 */
export async function reverse(tx: Tx, ctx: ActorContext, runNo: string, reason: string): Promise<{ entryNo: string }> {
  const run = await load(tx, runNo, { lock: true });
  await authorize(ctx, 'reverse_cancel', run);
  const text = requireText(reason, 'reason', 500);
  if (run.status === 'paid' || scaled(run.paidIqd) > 0n) throw new PayrollError(`${run.runNo} has been paid from; a paid run is not reversed. Correct it in next month's run.`);
  assertPayrollTransition(run.runNo, run.status, 'reversed');
  const [payment] = await tx.select({ id: payrollPayment.id }).from(payrollPayment).where(eq(payrollPayment.runId, run.id)).limit(1);
  if (payment) throw new PayrollError(`${run.runNo} has been paid from; a paid run is not reversed.`);
  const reversal = await journals.reverse(tx, ctx, run.journalEntryId!, { reason: `${run.runNo}: ${text}`, postingDate: businessToday() });
  // HR-4 — what the run recovered on advances is owed again.
  await advances.reversePayrollRecovery(tx, ctx, run);
  const now = new Date();
  await tx
    .update(payrollRun)
    .set({ status: 'reversed', reversedBy: ctx.principal.userId, reversedAt: now, reversalReason: text, reversalJournalEntryId: reversal.id, updatedAt: now })
    .where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status },
    after: { status: 'reversed', reversalEntryNo: reversal.entryNo },
    reason: text,
  });
  await tell(tx, [run.createdBy, run.submittedBy, run.approvedBy], run, 'hr.payroll_reversed', now.toISOString(), `${run.runNo} was reversed`, text, [ctx.principal.userId]);
  return { entryNo: reversal.entryNo };
}

/** Cancelled before it posts, with a reason; the month may then be run again. */
export async function cancel(tx: Tx, ctx: ActorContext, runNo: string, reason: string): Promise<void> {
  const run = await load(tx, runNo, { lock: true });
  const verb: PermissionVerb = run.status === 'draft' ? 'edit_draft' : run.status === 'approved' ? 'post' : 'approve';
  await authorize(ctx, verb, run);
  assertPayrollTransition(run.runNo, run.status, 'cancelled');
  const text = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(payrollRun).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: now, cancelReason: text, updatedAt: now }).where(eq(payrollRun.id, run.id));
  await recordChange(tx, ctx, {
    action: 'payroll_run.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: run.runNo,
    branchCode: run.branchCode,
    before: { status: run.status },
    after: { status: 'cancelled' },
    reason: text,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RunListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: RunListFilter) {
  const view = filter.view && (['draft', 'submitted', 'approved', 'posted', 'paid', 'reversed', 'cancelled'] as const).includes(filter.view as PayrollStatus) ? filter.view : null;
  const where = whereOf([view ? sql`r.status = ${view}` : null, searchOf([sql`r.run_no`, sql`r.branch_code`, sql`to_char(r.period_month, 'YYYY-MM')`], filter.search)]);
  const from = sql`from payroll_run r ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select r.id, r.run_no as "runNo", r.branch_code as "branchCode", to_char(r.period_month, 'YYYY-MM') as month,
                 r.pay_date::text as "payDate", r.status, r.employees, r.gross_iqd::text as "grossIqd", r.deductions_iqd::text as "deductionsIqd",
                 r.net_iqd::text as "netIqd", r.paid_iqd::text as "paidIqd"
            ${from}
           order by case r.status when 'submitted' then 0 when 'approved' then 1 when 'draft' then 2 when 'posted' then 3 else 4 end, r.period_month desc, r.run_no desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        runNo: string;
        branchCode: string;
        month: string;
        payDate: string;
        status: PayrollStatus;
        employees: number;
        grossIqd: string;
        deductionsIqd: string;
        netIqd: string;
        paidIqd: string;
      }[],
  });
}

const userName = (column: string) => sql<string | null>`(select u.display_name from app_user u where u.id = ${sql.raw(`"payroll_run"."${column}"`)})`;
const entryNo = (column: string) => sql<string | null>`(select j.entry_no from journal_entry j where j.id = ${sql.raw(`"payroll_run"."${column}"`)})`;

/** The run, its lines with their components, what each component came to, and its payments. */
export async function byNo(tx: Tx, runNo: string) {
  const [run] = await tx
    .select({
      run: payrollRun,
      createdByName: userName('created_by'),
      submittedByName: userName('submitted_by'),
      returnedByName: userName('returned_by'),
      approvedByName: userName('approved_by'),
      postedByName: userName('posted_by'),
      reversedByName: userName('reversed_by'),
      cancelledByName: userName('cancelled_by'),
      entryNo: entryNo('journal_entry_id'),
      reversalEntryNo: entryNo('reversal_journal_entry_id'),
    })
    .from(payrollRun)
    .where(eq(payrollRun.runNo, runNo))
    .limit(1);
  if (!run) return null;
  const lines = await linesWithComponents(tx, run.run.id);
  const payments = await tx
    .select({
      id: payrollPayment.id,
      payMethod: payrollPayment.payMethod,
      paidOn: payrollPayment.paidOn,
      reference: payrollPayment.reference,
      amountIqd: payrollPayment.amountIqd,
      lines: payrollPayment.lines,
      accountCode: bankCashAccount.code,
      accountName: bankCashAccount.name,
      entryNo: journalEntry.entryNo,
      paidByName: appUser.displayName,
    })
    .from(payrollPayment)
    .innerJoin(bankCashAccount, eq(bankCashAccount.id, payrollPayment.bankCashAccountId))
    .innerJoin(journalEntry, eq(journalEntry.id, payrollPayment.journalEntryId))
    .innerJoin(appUser, eq(appUser.id, payrollPayment.paidBy))
    .where(eq(payrollPayment.runId, run.run.id))
    .orderBy(asc(payrollPayment.paidAt));
  // What each component came to over the run — what the journal is built from.
  const byComponent = new Map<string, { code: string; nameEn: string; nameAr: string | null; kind: string; calculation: string; sortOrder: number; amount: bigint; people: number }>();
  for (const { components } of lines) {
    for (const c of components) {
      const prior = byComponent.get(c.componentCode);
      byComponent.set(c.componentCode, {
        code: c.componentCode,
        nameEn: c.nameEn,
        nameAr: c.nameAr,
        kind: c.kind,
        calculation: c.calculation,
        sortOrder: c.sortOrder,
        amount: (prior?.amount ?? 0n) + scaled(c.amountIqd),
        people: (prior?.people ?? 0) + (scaled(c.amountIqd) > 0n ? 1 : 0),
      });
    }
  }
  const unpaidByMethod = new Map<string, bigint>();
  for (const { line } of lines) if (!line.paymentId) unpaidByMethod.set(line.payMethod, (unpaidByMethod.get(line.payMethod) ?? 0n) + scaled(line.netIqd));
  return {
    ...run,
    lines,
    payments,
    components: [...byComponent.values()].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)).map(({ amount, ...c }) => ({ ...c, amountIqd: money(amount) })),
    unpaid: [...unpaidByMethod.entries()].filter(([, amount]) => amount > 0n).map(([method, amount]) => ({ method: method as PayMethod, amountIqd: money(amount) })),
  };
}

/** One payslip: the line, its components and the run it belongs to — read by the payroll's readers or by the person (R5). */
export async function payslip(tx: Tx, payslipNo: string) {
  const [line] = await tx.select().from(payrollLine).where(eq(payrollLine.payslipNo, payslipNo)).limit(1);
  if (!line) return null;
  // Of the run, only what the payslip prints: the run's totals are the branch's whole pay.
  const [header] = (
    await tx.execute(sql`
      select run_no as "runNo", status, branch_code as "branchCode", period_month::text as "periodMonth", period_end::text as "periodEnd",
             pay_date::text as "payDate", paid_on::text as "paidOn", payment_reference as "paymentReference"
        from app_payslip_header(${line.id}::uuid)`)
  ).rows as { runNo: string; status: PayrollStatus; branchCode: string; periodMonth: string; periodEnd: string; payDate: string; paidOn: string | null; paymentReference: string | null }[];
  if (!header) return null;
  const components = await tx.select().from(payrollLineComponent).where(eq(payrollLineComponent.lineId, line.id)).orderBy(asc(payrollLineComponent.sortOrder), asc(payrollLineComponent.componentCode));
  return { line, run: header, components };
}

/** A person's payslips, newest first — for their record and their own page. */
export async function payslipsOf(tx: Tx, employeeId: string, limit = 24) {
  return tx
    .select({
      payslipNo: payrollLine.payslipNo,
      runNo: payrollRun.runNo,
      status: payrollRun.status,
      periodMonth: payrollRun.periodMonth,
      grossIqd: payrollLine.grossIqd,
      deductionsIqd: payrollLine.deductionsIqd,
      netIqd: payrollLine.netIqd,
      paid: sql<boolean>`${payrollLine.paymentId} is not null`,
    })
    .from(payrollLine)
    .innerJoin(payrollRun, eq(payrollRun.id, payrollLine.runId))
    .where(and(eq(payrollLine.employeeId, employeeId), sql`${payrollLine.payslipNo} is not null`))
    .orderBy(desc(payrollRun.periodMonth), desc(payrollLine.payslipNo))
    .limit(limit);
}

/** The accounts the net pay may leave, by pay method. */
export async function payingAccounts(tx: Tx) {
  return tx
    .select({ id: bankCashAccount.id, code: bankCashAccount.code, name: bankCashAccount.name, accountType: bankCashAccount.accountType })
    .from(bankCashAccount)
    .where(and(eq(bankCashAccount.active, true), eq(bankCashAccount.currency, 'IQD')))
    .orderBy(asc(bankCashAccount.code));
}

export interface PayrollWaiting {
  readonly runNo: string;
  readonly branchCode: string;
  readonly month: string;
  readonly status: PayrollStatus;
  readonly netIqd: string;
  readonly action: 'approve' | 'post' | 'pay';
}

/** The runs waiting on this reader: to approve (not their own), to post, to pay. */
export async function waitingFor(tx: Tx, ctx: { principal: ActorContext['principal'] }): Promise<PayrollWaiting[]> {
  const mayApprove = can(ctx.principal, 'approve', PERMISSION_OBJECT);
  const mayPost = can(ctx.principal, 'post', PERMISSION_OBJECT);
  const mayPay = can(ctx.principal, 'execute', PERMISSION_OBJECT);
  if (!mayApprove && !mayPost && !mayPay) return [];
  const rows = await tx
    .select({
      runNo: payrollRun.runNo,
      branchCode: payrollRun.branchCode,
      periodMonth: payrollRun.periodMonth,
      status: payrollRun.status,
      netIqd: payrollRun.netIqd,
      paidIqd: payrollRun.paidIqd,
      createdBy: payrollRun.createdBy,
      submittedBy: payrollRun.submittedBy,
    })
    .from(payrollRun)
    .where(inArray(payrollRun.status, ['submitted', 'approved', 'posted']))
    .orderBy(asc(payrollRun.periodMonth), asc(payrollRun.runNo));
  const out: PayrollWaiting[] = [];
  for (const r of rows) {
    const base = { runNo: r.runNo, branchCode: r.branchCode, month: r.periodMonth.slice(0, 7), status: r.status as PayrollStatus };
    if (r.status === 'submitted' && mayApprove && r.createdBy !== ctx.principal.userId && r.submittedBy !== ctx.principal.userId) out.push({ ...base, netIqd: r.netIqd, action: 'approve' });
    else if (r.status === 'approved' && mayPost) out.push({ ...base, netIqd: r.netIqd, action: 'post' });
    else if (r.status === 'posted' && mayPay) out.push({ ...base, netIqd: money(scaled(r.netIqd) - scaled(r.paidIqd)), action: 'pay' });
  }
  return out;
}
