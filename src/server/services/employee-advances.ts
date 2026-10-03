/**
 * Employee advances and loans — REQ-HR-001 Stage HR-4 (§10, D-HR-1).
 *
 *     draft ──submit──▶ submitted ──endorse──▶ endorsed ──approve──▶ approved ──pay──▶ paid ──recovered──▶ settled
 *                          │ refuse (note)        │ refuse (note)
 *     draft / submitted / endorsed / approved ──cancel (reason)──▶ cancelled
 *
 * Asked for by HR or by the person (R5); endorsed by the person's manager
 * through the employee record's link, or by an HR manager; approved by the
 * accounting manager; paid by Finance from a bank or cash account
 * (`hr.employee_advance`: Dr the advances account, Cr the account it left).
 * Neither the requester nor the person endorses or approves it, and the
 * approver is not the endorser (database checks).
 *
 * It comes back two ways, each an append-only recovery row: the payroll's
 * ADVANCE deduction — what the schedule has due by the month, written when the
 * run posts and written back when it is reversed — or cash handed in
 * (`hr.employee_advance_repayment`). More than is owed is refused (H6). An
 * advance whose recoveries are behind its schedule is aged and raised by the
 * morning sweep.
 *
 * Payroll imports this module; this module never imports payroll.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, bankCashAccount, employee, employeeAdvance, employeeAdvanceRecovery, journalEntry, userRole } from '../db/schema';
import {
  ADVANCE_KINDS,
  AdvanceError,
  allocateRecovery,
  assertAdvanceTransition,
  assertWholeDinars,
  behindSince,
  dueBy,
  instalmentPlan,
  nextMonth,
  recoveryFor,
  type AdvanceKind,
  type AdvanceStatus,
  type Schedule,
} from '../domain/advances';
import { businessToday } from '../domain/business-date';
import { bucketFor, type AdvanceBucket } from '../domain/cash-advance';
import { HrValidationError, assertDay } from '../domain/hr';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { can, type PermissionVerb } from '../domain/permissions';
import { AdminNotFoundError, optionalText, recordChange, requireText } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import * as posting from './posting';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'employee_advance';
const SEQUENCE_KEY = 'EMPLOYEE_ADVANCE';
const DOCUMENT_TYPE = 'employee_advance';
const REPAYMENT_DOCUMENT_TYPE = 'employee_advance_repayment';

export { AdvanceError };

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const scaled = (value: string | null | undefined) => parseDecimal((value ?? '0').trim() || '0', MONEY_SCALE);

type AdvanceRow = typeof employeeAdvance.$inferSelect;

const scheduleOf = (row: Pick<AdvanceRow, 'amountIqd' | 'instalments' | 'firstRecoveryMonth'>): Schedule => ({
  amount: scaled(row.amountIqd),
  instalments: row.instalments,
  firstRecoveryMonth: row.firstRecoveryMonth,
});

async function load(tx: Tx, advanceNo: string, options: { lock?: boolean } = {}): Promise<AdvanceRow> {
  const query = tx.select().from(employeeAdvance).where(eq(employeeAdvance.advanceNo, advanceNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('advance', advanceNo);
  return row;
}

interface Person {
  readonly id: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly branchCode: string;
  readonly status: string;
  readonly appUserId: string | null;
  readonly managerUserId: string | null;
}

async function personOf(tx: Tx, employeeId: string): Promise<Person> {
  const [row] = await tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      branchCode: employee.branchCode,
      status: employee.status,
      appUserId: employee.appUserId,
      managerUserId: sql<string | null>`(select m.app_user_id from employee m where m.id = "employee"."manager_employee_id")`,
    })
    .from(employee)
    .where(eq(employee.id, employeeId))
    .limit(1);
  if (!row) throw new HrValidationError('employee', 'names nobody you may see');
  return row;
}

/** HR acts by its grant; the person may act for themself (R5), as with leave. */
async function permitFor(ctx: ActorContext, person: Person, verb: PermissionVerb): Promise<void> {
  if (person.appUserId && person.appUserId === ctx.principal.userId) return;
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode: person.branchCode, objectId: person.employeeNo, requestId: ctx.requestId ?? null });
}

async function tell(
  tx: Tx,
  recipients: Iterable<string | null>,
  row: { advanceNo: string; branchCode: string },
  event: string,
  occurrence: string,
  subject: string,
  body: string,
  except: readonly (string | null)[] = [],
) {
  const skip = new Set(except.filter(Boolean));
  for (const recipientUserId of new Set([...recipients].filter((id): id is string => Boolean(id) && !skip.has(id)))) {
    await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: event,
      objectType: PERMISSION_OBJECT,
      objectId: row.advanceNo,
      recipientUserId,
      subject,
      body,
      context: { advanceNo: row.advanceNo },
      dedupeKey: `${event}:${row.advanceNo}:${occurrence}:${recipientUserId}`,
      branchCode: row.branchCode,
    });
  }
}

/** The active people who hold a verb on advances in a branch. */
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

// ---------------------------------------------------------------------------
// The request and its approvals
// ---------------------------------------------------------------------------

export interface AdvanceInput {
  readonly employeeId: string;
  readonly kind: string;
  /** Dinars, as typed. */
  readonly amount: string;
  readonly instalments?: number | string | null;
  /** "YYYY-MM"; the month after today when left out. */
  readonly firstRecoveryMonth?: string | null;
  readonly reason: string;
}

function valuesOf(input: AdvanceInput) {
  if (!(ADVANCE_KINDS as readonly string[]).includes(input.kind)) throw new HrValidationError('kind', 'must be an advance or a loan');
  const kind = input.kind as AdvanceKind;
  const amountText = (input.amount ?? '').trim();
  if (!/^\d{1,16}(\.\d{1,4})?$/.test(amountText)) throw new HrValidationError('amount', `'${amountText}' is not an amount in dinars`);
  const amount = scaled(amountText);
  assertWholeDinars(amount, 'The amount');
  const instalments = Number(input.instalments ?? 1) || 1;
  if (kind === 'advance' && instalments !== 1) throw new AdvanceError('A salary advance comes back in one instalment; several instalments make it a loan.');
  instalmentPlan(amount, instalments);
  const month = (input.firstRecoveryMonth ?? '').trim();
  let first: string;
  if (month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HrValidationError('first_recovery_month', 'is a month, written YYYY-MM');
    first = `${month}-01`;
  } else first = nextMonth(businessToday());
  return { kind, amount, instalments, firstRecoveryMonth: first, reason: requireText(input.reason, 'reason', 500) };
}

/** A request: by HR, or by the person for themself. */
export async function create(tx: Tx, ctx: ActorContext, input: AdvanceInput): Promise<{ id: string; advanceNo: string }> {
  const person = await personOf(tx, input.employeeId);
  await permitFor(ctx, person, 'create');
  if (person.status !== 'active') throw new AdvanceError(`${person.employeeNo} is ${person.status}; an advance is lent to somebody still working.`);
  const values = valuesOf(input);
  const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode: person.branchCode, year: Number(businessToday().slice(0, 4)) }, ctx.principal.userId);
  const id = randomUUID();
  await tx.insert(employeeAdvance).values({
    id,
    advanceNo: allocated.documentNo,
    employeeId: person.id,
    branchCode: person.branchCode,
    kind: values.kind,
    amountIqd: money(values.amount),
    instalments: values.instalments,
    firstRecoveryMonth: values.firstRecoveryMonth,
    reason: values.reason,
    requestedBy: ctx.principal.userId,
  });
  await recordChange(tx, ctx, {
    action: 'employee_advance.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode: person.branchCode,
    after: { employeeNo: person.employeeNo, kind: values.kind, amountIqd: money(values.amount), instalments: values.instalments, firstRecoveryMonth: values.firstRecoveryMonth },
  });
  return { id, advanceNo: allocated.documentNo };
}

/** Who endorses: the person's manager by the link when they sign in, else the HR managers. */
async function endorsers(tx: Tx, person: Person, row: AdvanceRow): Promise<string[]> {
  if (person.managerUserId && person.managerUserId !== row.requestedBy && person.managerUserId !== person.appUserId) return [person.managerUserId];
  const rows = await tx
    .select({ userId: userRole.userId })
    .from(userRole)
    .innerJoin(appUser, eq(appUser.id, userRole.userId))
    .where(and(eq(userRole.roleCode, 'hr_manager'), eq(appUser.isActive, true)));
  return rows.map((r) => r.userId);
}

export async function submit(tx: Tx, ctx: ActorContext, advanceNo: string): Promise<void> {
  const row = await load(tx, advanceNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  await permitFor(ctx, person, 'edit_draft');
  assertAdvanceTransition(row.advanceNo, row.status, 'submitted');
  const now = new Date();
  await tx.update(employeeAdvance).set({ status: 'submitted', submittedAt: now, updatedAt: now }).where(eq(employeeAdvance.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_advance.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'submitted' },
  });
  await tell(
    tx,
    await endorsers(tx, person, row),
    row,
    'hr.advance_submitted',
    now.toISOString(),
    `${row.advanceNo}: ${person.fullNameEn} asks for ${money(scaled(row.amountIqd))} IQD`,
    `${row.kind === 'loan' ? `A loan in ${row.instalments} instalments` : 'A salary advance'} — ${row.reason}`,
    [ctx.principal.userId, row.requestedBy, person.appUserId],
  );
}

/** Whether this reader may take the next step, and if not, why — for the screen. */
export function stepRefusal(
  ctx: { principal: ActorContext['principal'] },
  person: { appUserId: string | null; managerUserId: string | null },
  row: Pick<AdvanceRow, 'status' | 'requestedBy' | 'endorsedBy'>,
): string | null {
  const me = ctx.principal.userId;
  if (row.status === 'submitted') {
    if (me === row.requestedBy || me === person.appUserId) return 'maker';
    if (person.managerUserId === me || can(ctx.principal, 'approve', PERMISSION_OBJECT)) return null;
    return 'grant';
  }
  if (row.status === 'endorsed') {
    if (me === row.requestedBy || me === person.appUserId || me === row.endorsedBy) return 'maker';
    return can(ctx.principal, 'post', PERMISSION_OBJECT) ? null : 'grant';
  }
  return 'status';
}

/** Endorsed by the person's manager (the link) or an HR manager — never the requester or the person. */
export async function endorse(tx: Tx, ctx: ActorContext, advanceNo: string, note?: string | null): Promise<void> {
  const row = await load(tx, advanceNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  assertAdvanceTransition(row.advanceNo, row.status, 'endorsed');
  const refusal = stepRefusal(ctx, person, row);
  if (refusal === 'grant') await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.advanceNo });
  if (refusal === 'maker') throw new AdvanceError(`${row.advanceNo} was asked by you or is yours; somebody else endorses it.`);
  const now = new Date();
  await tx
    .update(employeeAdvance)
    .set({ status: 'endorsed', endorsedBy: ctx.principal.userId, endorsedAt: now, decisionNote: optionalText(note), updatedAt: now })
    .where(eq(employeeAdvance.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_advance.endorsed',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'endorsed' },
    reason: optionalText(note),
  });
  await tell(
    tx,
    await holders(tx, 'post', row.branchCode),
    row,
    'hr.advance_endorsed',
    now.toISOString(),
    `${row.advanceNo} is endorsed — approve it`,
    `${person.employeeNo} · ${money(scaled(row.amountIqd))} IQD`,
    [ctx.principal.userId, row.requestedBy, person.appUserId],
  );
}

/** Approved by Finance — never the requester, the person or the endorser. */
export async function approve(tx: Tx, ctx: ActorContext, advanceNo: string): Promise<void> {
  const row = await load(tx, advanceNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  assertAdvanceTransition(row.advanceNo, row.status, 'approved');
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.advanceNo });
  if (stepRefusal(ctx, person, row) === 'maker') throw new AdvanceError(`You asked for, endorsed or are the person on ${row.advanceNo}; somebody else approves it.`);
  const now = new Date();
  await tx.update(employeeAdvance).set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt: now, updatedAt: now }).where(eq(employeeAdvance.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_advance.approved',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'approved' },
  });
  await tell(
    tx,
    [person.appUserId, row.requestedBy, ...(await holders(tx, 'execute', row.branchCode))],
    row,
    'hr.advance_approved',
    now.toISOString(),
    `${row.advanceNo} is approved`,
    `${money(scaled(row.amountIqd))} IQD — to be paid`,
    [ctx.principal.userId],
  );
}

/** Refused with a note, by whoever may take the step it waits on. */
export async function refuse(tx: Tx, ctx: ActorContext, advanceNo: string, note: string): Promise<void> {
  const row = await load(tx, advanceNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  assertAdvanceTransition(row.advanceNo, row.status, 'refused');
  const refusal = stepRefusal(ctx, person, row);
  if (refusal === 'grant') await authz.authorize(ctx.principal, row.status === 'endorsed' ? 'post' : 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.advanceNo });
  if (refusal === 'maker') throw new AdvanceError(`${row.advanceNo} was asked by you or is yours; somebody else decides it.`);
  const text = requireText(note, 'note', 500);
  const now = new Date();
  await tx.update(employeeAdvance).set({ status: 'refused', refusedBy: ctx.principal.userId, refusedAt: now, decisionNote: text, updatedAt: now }).where(eq(employeeAdvance.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_advance.refused',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'refused' },
    reason: text,
  });
  await tell(tx, [person.appUserId, row.requestedBy], row, 'hr.advance_refused', now.toISOString(), `${row.advanceNo} was refused`, text, [ctx.principal.userId]);
}

/** Cancelled before it is paid, with a reason — by the requester, the person, or HR. */
export async function cancel(tx: Tx, ctx: ActorContext, advanceNo: string, reason: string): Promise<void> {
  const row = await load(tx, advanceNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  if (ctx.principal.userId !== row.requestedBy) await permitFor(ctx, person, 'edit_draft');
  assertAdvanceTransition(row.advanceNo, row.status, 'cancelled');
  const text = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(employeeAdvance).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: now, cancelReason: text, updatedAt: now }).where(eq(employeeAdvance.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_advance.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'cancelled' },
    reason: text,
  });
}

// ---------------------------------------------------------------------------
// Money out and money back
// ---------------------------------------------------------------------------

async function accountFor(tx: Tx, id: string) {
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, (id ?? '').trim()))
    .limit(1);
  if (!account) throw new HrValidationError('account', 'choose the bank or cash account the money moves through');
  if (!account.active) throw new AdvanceError(`${account.code} is deactivated.`);
  if (account.currency !== 'IQD') throw new AdvanceError(`${account.code} holds ${account.currency}; advances are lent in dinars (D-HR-2).`);
  return account;
}

export interface MoneyInput {
  readonly bankCashAccountId: string;
  readonly on: string;
  readonly reference?: string | null;
}

/** Paid: the money leaves the account; the person owes it (Dr advances, Cr the account). */
export async function pay(tx: Tx, ctx: ActorContext, advanceNo: string, input: MoneyInput): Promise<{ entryNo: string }> {
  const row = await load(tx, advanceNo, { lock: true });
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.advanceNo });
  assertAdvanceTransition(row.advanceNo, row.status, 'paid');
  const on = assertDay((input.on ?? '').trim(), 'paid_on');
  if (on > businessToday()) throw new HrValidationError('paid_on', `${on} has not come yet; record the payment the day the money leaves`);
  const account = await accountFor(tx, input.bankCashAccountId);
  const person = await personOf(tx, row.employeeId);
  const reference = optionalText(input.reference, 120);
  const amount = money(scaled(row.amountIqd));
  const criteria = { branchCode: row.branchCode };
  const description = `${row.advanceNo} — ${row.kind === 'loan' ? 'loan' : 'advance'} to ${person.employeeNo}${reference ? ` (${reference})` : ''}`;
  const result = await posting.post(tx, ctx, {
    eventType: 'hr.employee_advance',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'hr', documentId: row.id, event: 'paid' },
    branchCode: row.branchCode,
    documentDate: on,
    postingDate: on,
    description,
    lines: [
      { role: 'employee_advance', debit: amount, criteria, dimensions: { branch: row.branchCode }, description },
      { role: 'bank', accountId: account.glAccountId, credit: amount, criteria, dimensions: { branch: row.branchCode }, bankAccountCode: account.code, description },
    ],
  });
  const now = new Date();
  await tx
    .update(employeeAdvance)
    .set({ status: 'paid', paidBy: ctx.principal.userId, paidAt: now, paidOn: on, bankCashAccountId: account.id, paymentReference: reference, journalEntryId: result.journalEntryId, updatedAt: now })
    .where(eq(employeeAdvance.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_advance.paid',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'paid', paidOn: on, account: account.code, entryNo: result.entryNo },
  });
  await tell(tx, [person.appUserId], row, 'hr.advance_paid', now.toISOString(), `${row.advanceNo} is paid`, `${amount} IQD; recovered from ${row.firstRecoveryMonth.slice(0, 7)}`, [
    ctx.principal.userId,
  ]);
  return { entryNo: result.entryNo };
}

async function settleIfDone(tx: Tx, row: AdvanceRow, recovered: bigint): Promise<AdvanceStatus> {
  const done = recovered >= scaled(row.amountIqd);
  const status: AdvanceStatus = done ? 'settled' : 'paid';
  await tx
    .update(employeeAdvance)
    .set({ recoveredIqd: money(recovered), status, settledAt: done ? new Date() : null, updatedAt: new Date() })
    .where(eq(employeeAdvance.id, row.id));
  return status;
}

/** Cash handed back: never more than is owed (H6). Dr the account, Cr advances. */
export async function repayInCash(tx: Tx, ctx: ActorContext, advanceNo: string, input: MoneyInput & { readonly amount: string }): Promise<{ entryNo: string; status: AdvanceStatus }> {
  const row = await load(tx, advanceNo, { lock: true });
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.advanceNo });
  if (row.status !== 'paid') throw new AdvanceError(`${row.advanceNo} is ${row.status}; only a paid advance is repaid.`);
  const on = assertDay((input.on ?? '').trim(), 'repaid_on');
  if (on > businessToday()) throw new HrValidationError('repaid_on', `${on} has not come yet`);
  const amountText = (input.amount ?? '').trim();
  if (!/^\d{1,16}(\.\d{1,4})?$/.test(amountText)) throw new HrValidationError('amount', `'${amountText}' is not an amount in dinars`);
  const amount = scaled(amountText);
  const owed = scaled(row.amountIqd) - scaled(row.recoveredIqd);
  if (amount <= 0n) throw new AdvanceError('A repayment of nothing repays nothing.');
  if (amount > owed) throw new AdvanceError(`${row.advanceNo} has ${money(owed)} IQD still owed; ${money(amount)} IQD is more than remains (H6).`);
  const account = await accountFor(tx, input.bankCashAccountId);
  const reference = optionalText(input.reference, 120);
  const criteria = { branchCode: row.branchCode };
  const description = `${row.advanceNo} — repaid in cash${reference ? ` (${reference})` : ''}`;
  const id = randomUUID();
  const result = await posting.post(tx, ctx, {
    eventType: 'hr.employee_advance_repayment',
    documentTypeCode: REPAYMENT_DOCUMENT_TYPE,
    source: { module: 'hr', documentId: id, event: 'repaid' },
    branchCode: row.branchCode,
    documentDate: on,
    postingDate: on,
    description,
    lines: [
      { role: 'bank', accountId: account.glAccountId, debit: money(amount), criteria, dimensions: { branch: row.branchCode }, bankAccountCode: account.code, description },
      { role: 'employee_advance', credit: money(amount), criteria, dimensions: { branch: row.branchCode }, description },
    ],
  });
  await tx.insert(employeeAdvanceRecovery).values({
    id,
    advanceId: row.id,
    source: 'cash',
    month: `${on.slice(0, 7)}-01`,
    amountIqd: money(amount),
    bankCashAccountId: account.id,
    journalEntryId: result.journalEntryId,
    reference,
    recordedBy: ctx.principal.userId,
  });
  const status = await settleIfDone(tx, row, scaled(row.recoveredIqd) + amount);
  await recordChange(tx, ctx, {
    action: 'employee_advance.repaid',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    after: { amountIqd: money(amount), account: account.code, on, status, entryNo: result.entryNo },
  });
  return { entryNo: result.entryNo, status };
}

// ---------------------------------------------------------------------------
// Payroll's side (HR-3 calls these; nothing here calls payroll)
// ---------------------------------------------------------------------------

async function openOf(tx: Tx, employeeIds: readonly string[], options: { lock?: boolean } = {}) {
  if (employeeIds.length === 0) return [];
  const query = tx
    .select()
    .from(employeeAdvance)
    .where(and(inArray(employeeAdvance.employeeId, [...employeeIds]), eq(employeeAdvance.status, 'paid')))
    .orderBy(asc(employeeAdvance.firstRecoveryMonth), asc(employeeAdvance.advanceNo));
  return options.lock ? query.for('update') : query;
}

/** What each person's paid advances have due by a month (first day): the payroll's ADVANCE deduction. */
export async function dueForMonth(tx: Tx, employeeIds: readonly string[], month: string): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const row of await openOf(tx, employeeIds)) {
    const due = recoveryFor(scheduleOf(row), scaled(row.recoveredIqd), month);
    if (due > 0n) out.set(row.employeeId, (out.get(row.employeeId) ?? 0n) + due);
  }
  return out;
}

/** A posted run's ADVANCE deductions, spread over each person's advances (oldest first) as recovery rows. */
export async function recordPayrollRecovery(
  tx: Tx,
  ctx: ActorContext,
  run: { id: string; runNo: string; periodMonth: string },
  lines: readonly { lineId: string; employeeId: string; amount: bigint }[],
): Promise<number> {
  const wanted = lines.filter((l) => l.amount > 0n);
  if (wanted.length === 0) return 0;
  const advances = await openOf(
    tx,
    wanted.map((l) => l.employeeId),
    { lock: true },
  );
  let written = 0;
  for (const line of wanted) {
    const own = advances.filter((a) => a.employeeId === line.employeeId).map((a) => ({ id: a.id, row: a, schedule: scheduleOf(a), recovered: scaled(a.recoveredIqd) }));
    const shares = allocateRecovery(own, line.amount, run.periodMonth);
    // The run recovers what it computed; if an advance moved since (cash handed in), the run is computed again.
    if (shares.reduce((sum, s) => sum + s.amount, 0n) !== line.amount) {
      throw new AdvanceError(`${run.runNo}: the advances of one of its people changed after it was computed; send it back to draft and compute it again.`);
    }
    for (const share of shares) {
      const advance = own.find((a) => a.id === share.id)!;
      await tx.insert(employeeAdvanceRecovery).values({
        advanceId: share.id,
        source: 'payroll',
        month: run.periodMonth,
        amountIqd: money(share.amount),
        runId: run.id,
        lineId: line.lineId,
        reference: run.runNo,
        recordedBy: ctx.principal.userId,
      });
      await settleIfDone(tx, advance.row, advance.recovered + share.amount);
      written += 1;
    }
  }
  return written;
}

/**
 * HR-6 — what a trip's advance still owes, locked for the claim that may
 * settle it. Only a paid advance owes anything; one not yet paid out (or
 * cancelled) is settled by nothing.
 */
export async function owedForClaim(tx: Tx, advanceId: string): Promise<{ advanceNo: string; owed: bigint }> {
  const [row] = await tx.select().from(employeeAdvance).where(eq(employeeAdvance.id, advanceId)).for('update');
  if (!row) throw new AdminNotFoundError('advance', advanceId);
  return { advanceNo: row.advanceNo, owed: row.status === 'paid' ? scaled(row.amountIqd) - scaled(row.recoveredIqd) : 0n };
}

/** HR-6 — a reimbursed claim settles part or all of its trip's advance: a recovery row naming the claim and its journal. */
export async function recordClaimRecovery(
  tx: Tx,
  ctx: ActorContext,
  advanceId: string,
  amount: bigint,
  claim: { readonly id: string; readonly requestNo: string; readonly journalEntryId: string; readonly paidOn: string },
): Promise<AdvanceStatus> {
  const [row] = await tx.select().from(employeeAdvance).where(eq(employeeAdvance.id, advanceId)).for('update');
  if (!row) throw new AdminNotFoundError('advance', advanceId);
  const owed = scaled(row.amountIqd) - scaled(row.recoveredIqd);
  if (row.status !== 'paid' || amount <= 0n || amount > owed) throw new AdvanceError(`${row.advanceNo} owes ${money(owed)} IQD; ${claim.requestNo} cannot settle ${money(amount)} IQD of it.`);
  await tx.insert(employeeAdvanceRecovery).values({
    advanceId: row.id,
    source: 'claim',
    month: `${claim.paidOn.slice(0, 7)}-01`,
    amountIqd: money(amount),
    requestId: claim.id,
    journalEntryId: claim.journalEntryId,
    reference: claim.requestNo,
    recordedBy: ctx.principal.userId,
  });
  const status = await settleIfDone(tx, row, scaled(row.recoveredIqd) + amount);
  await recordChange(tx, ctx, {
    action: 'employee_advance.claim_settled',
    objectType: PERMISSION_OBJECT,
    objectId: row.advanceNo,
    branchCode: row.branchCode,
    before: { recoveredIqd: row.recoveredIqd, status: row.status },
    after: { recoveredIqd: money(scaled(row.recoveredIqd) + amount), status, claim: claim.requestNo },
  });
  return status;
}

/** A reversed run gives back what it recovered: a negative row for each, the advance owed again. */
export async function reversePayrollRecovery(tx: Tx, ctx: ActorContext, run: { id: string; runNo: string }): Promise<number> {
  const rows = await tx
    .select()
    .from(employeeAdvanceRecovery)
    .where(and(eq(employeeAdvanceRecovery.runId, run.id), eq(employeeAdvanceRecovery.source, 'payroll')));
  for (const recovery of rows) {
    const [advance] = await tx.select().from(employeeAdvance).where(eq(employeeAdvance.id, recovery.advanceId)).for('update');
    await tx.insert(employeeAdvanceRecovery).values({
      advanceId: recovery.advanceId,
      source: 'payroll_reversal',
      month: recovery.month,
      amountIqd: money(-scaled(recovery.amountIqd)),
      runId: run.id,
      lineId: recovery.lineId,
      reference: `${run.runNo} reversed`,
      recordedBy: ctx.principal.userId,
    });
    await settleIfDone(tx, advance!, scaled(advance!.recoveredIqd) - scaled(recovery.amountIqd));
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AdvanceListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: AdvanceListFilter) {
  const view = filter.view && ['draft', 'submitted', 'endorsed', 'approved', 'paid', 'settled', 'refused', 'cancelled'].includes(filter.view) ? filter.view : null;
  const where = whereOf([view ? sql`a.status = ${view}` : null, searchOf([sql`a.advance_no`, sql`e.employee_no`, sql`e.full_name_en`, sql`e.full_name_ar`], filter.search)]);
  const from = sql`from employee_advance a join employee e on e.id = a.employee_id ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select a.id, a.advance_no as "advanceNo", a.kind, a.status, a.amount_iqd::text as "amountIqd", a.recovered_iqd::text as "recoveredIqd",
                 (a.amount_iqd - a.recovered_iqd)::text as "owedIqd", a.instalments, to_char(a.first_recovery_month, 'YYYY-MM') as "firstMonth",
                 e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", e.full_name_ar as "fullNameAr"
            ${from}
           order by case a.status when 'submitted' then 0 when 'endorsed' then 1 when 'approved' then 2 when 'draft' then 3 when 'paid' then 4 else 5 end, a.created_at desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        advanceNo: string;
        kind: AdvanceKind;
        status: AdvanceStatus;
        amountIqd: string;
        recoveredIqd: string;
        owedIqd: string;
        instalments: number;
        firstMonth: string;
        employeeNo: string;
        fullNameEn: string;
        fullNameAr: string | null;
      }[],
  });
}

const userName = (column: string) => sql<string | null>`(select u.display_name from app_user u where u.id = ${sql.raw(`"employee_advance"."${column}"`)})`;

/** The advance, its person, its schedule month by month, and what came back. */
export async function byNo(tx: Tx, advanceNo: string) {
  const [found] = await tx
    .select({
      row: employeeAdvance,
      requestedByName: userName('requested_by'),
      endorsedByName: userName('endorsed_by'),
      approvedByName: userName('approved_by'),
      refusedByName: userName('refused_by'),
      paidByName: userName('paid_by'),
      cancelledByName: userName('cancelled_by'),
      entryNo: sql<string | null>`(select j.entry_no from journal_entry j where j.id = "employee_advance"."journal_entry_id")`,
      accountCode: sql<string | null>`(select b.code from bank_cash_account b where b.id = "employee_advance"."bank_cash_account_id")`,
    })
    .from(employeeAdvance)
    .where(eq(employeeAdvance.advanceNo, advanceNo))
    .limit(1);
  if (!found) return null;
  const person = await personOf(tx, found.row.employeeId);
  const [named] = await tx.select({ fullNameAr: employee.fullNameAr }).from(employee).where(eq(employee.id, person.id)).limit(1);
  const recoveries = await tx
    .select({
      id: employeeAdvanceRecovery.id,
      source: employeeAdvanceRecovery.source,
      month: employeeAdvanceRecovery.month,
      amountIqd: employeeAdvanceRecovery.amountIqd,
      reference: employeeAdvanceRecovery.reference,
      recordedAt: employeeAdvanceRecovery.recordedAt,
      entryNo: journalEntry.entryNo,
    })
    .from(employeeAdvanceRecovery)
    .leftJoin(journalEntry, eq(journalEntry.id, employeeAdvanceRecovery.journalEntryId))
    .where(eq(employeeAdvanceRecovery.advanceId, found.row.id))
    .orderBy(asc(employeeAdvanceRecovery.recordedAt));
  const schedule = scheduleOf(found.row);
  const plan = instalmentPlan(schedule.amount, schedule.instalments);
  const [y, m] = schedule.firstRecoveryMonth.split('-').map(Number) as [number, number];
  let cumulative = 0n;
  const months = plan.map((amount, i) => {
    cumulative += amount;
    const month = new Date(Date.UTC(y, m - 1 + i, 1)).toISOString().slice(0, 10);
    const back = recoveries.filter((r) => r.month === month).reduce((sum, r) => sum + scaled(r.amountIqd), 0n);
    return { month, instalmentIqd: money(amount), dueByIqd: money(cumulative), recoveredIqd: money(back) };
  });
  const today = businessToday();
  const behind = found.row.status === 'paid' ? behindSince(schedule, scaled(found.row.recoveredIqd), `${today.slice(0, 7)}-01`) : null;
  return {
    ...found,
    person: { ...person, fullNameAr: named?.fullNameAr ?? null },
    months,
    recoveries,
    owedIqd: money(scaled(found.row.amountIqd) - scaled(found.row.recoveredIqd)),
    behind: behind ? { since: behind, bucket: bucketFor(lastDayOf(behind), today) as AdvanceBucket } : null,
  };
}

const lastDayOf = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/** A person's advances, newest first — for their record and the clearance. */
export async function ofEmployee(tx: Tx, employeeId: string) {
  return tx
    .select({
      advanceNo: employeeAdvance.advanceNo,
      kind: employeeAdvance.kind,
      status: employeeAdvance.status,
      amountIqd: employeeAdvance.amountIqd,
      recoveredIqd: employeeAdvance.recoveredIqd,
      owedIqd: sql<string>`("employee_advance"."amount_iqd" - "employee_advance"."recovered_iqd")::text`,
      instalments: employeeAdvance.instalments,
      firstRecoveryMonth: employeeAdvance.firstRecoveryMonth,
    })
    .from(employeeAdvance)
    .where(eq(employeeAdvance.employeeId, employeeId))
    .orderBy(desc(employeeAdvance.createdAt));
}

/** Who may be lent to: active people the reader can see. */
export async function borrowers(tx: Tx) {
  return tx.select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn }).from(employee).where(eq(employee.status, 'active')).orderBy(asc(employee.employeeNo));
}

export interface AdvanceWaiting {
  readonly advanceNo: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly amountIqd: string;
  readonly action: 'endorse' | 'approve' | 'pay';
}

/** The advances waiting on this reader. */
export async function waitingFor(tx: Tx, ctx: { principal: ActorContext['principal'] }): Promise<AdvanceWaiting[]> {
  const rows = (
    await tx.execute(sql`
      select a.advance_no as "advanceNo", a.status, a.requested_by as "requestedBy", a.endorsed_by as "endorsedBy", a.amount_iqd::text as "amountIqd",
             e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", e.app_user_id as "appUserId",
             (select m.app_user_id from employee m where m.id = e.manager_employee_id) as "managerUserId"
        from employee_advance a join employee e on e.id = a.employee_id
       where a.status in ('submitted', 'endorsed', 'approved')
       order by a.submitted_at`)
  ).rows as {
    advanceNo: string;
    status: string;
    requestedBy: string;
    endorsedBy: string | null;
    amountIqd: string;
    employeeNo: string;
    fullNameEn: string;
    appUserId: string | null;
    managerUserId: string | null;
  }[];
  const out: AdvanceWaiting[] = [];
  for (const r of rows) {
    const base = { advanceNo: r.advanceNo, employeeNo: r.employeeNo, fullNameEn: r.fullNameEn, amountIqd: r.amountIqd };
    if (r.status === 'approved') {
      if (can(ctx.principal, 'execute', PERMISSION_OBJECT)) out.push({ ...base, action: 'pay' });
      continue;
    }
    if (stepRefusal(ctx, { appUserId: r.appUserId, managerUserId: r.managerUserId }, { status: r.status, requestedBy: r.requestedBy, endorsedBy: r.endorsedBy }) === null)
      out.push({ ...base, action: r.status === 'submitted' ? 'endorse' : 'approve' });
  }
  return out;
}

/** Paid advances behind their schedule as at a day — the sweep raises each once a month. */
export async function behindAsOf(tx: Tx, asOf: string) {
  const rows = await tx.select().from(employeeAdvance).where(eq(employeeAdvance.status, 'paid'));
  const month = `${asOf.slice(0, 7)}-01`;
  // The month in progress is not behind yet: its payroll has not run.
  const [y, m] = month.split('-').map(Number) as [number, number];
  const previous = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  return rows
    .map((row) => {
      const since = behindSince(scheduleOf(row), scaled(row.recoveredIqd), previous);
      if (!since) return null;
      const due = dueBy(scheduleOf(row), previous) - scaled(row.recoveredIqd);
      return { advanceNo: row.advanceNo, branchCode: row.branchCode, employeeId: row.employeeId, since, behindIqd: money(due), bucket: bucketFor(lastDayOf(since), asOf) };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
