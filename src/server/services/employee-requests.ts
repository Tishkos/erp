/**
 * Employee requests — REQ-HR-001 Stage HR-6 (§10, §11a "Employee Requests").
 *
 *     draft ──submit──▶ submitted ──approve──▶ approved ──pay (a claim)──▶ paid
 *                          │ refuse (note)       └──issue (a letter)──▶ issued
 *     draft / submitted / approved ──cancel (reason)──▶ cancelled
 *
 * One register, four kinds, each in its own series: an expense claim (ECLM),
 * a trip (TRV), a letter (LTR), anything else (ERQ). Asked by HR or by the
 * person (R5, as leave); decided by the person's manager through the employee
 * record's link or by an HR manager — never by the asker or the person (a
 * check and a trigger).
 *
 * A claim's lines name payables' expense categories; a category that wants
 * its receipt wants a file on the claim before it is submitted. Finance
 * reimburses an approved claim from a bank or cash account (`hr.expense_claim`:
 * Dr each line's expense — the category's own account, else the mapped
 * `employee_expense` — by the person's department; Cr the account). A claim
 * that names its trip settles what the trip's advance still owes first
 * (Cr `employee_advance`, a recovery row on the advance) and pays the rest.
 *
 * An approved trip may open an advance through `employee-advances.create`,
 * recovered from pay from the second month after the trip if no claim has
 * settled it. An approved letter is issued by HR with its text, kept as
 * issued and printed from what was kept.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { bankCashAccount, employee, employeeRequest, employeeRequestLine, expenseCategory } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { HrValidationError, assertDay } from '../domain/hr';
import {
  LETTER_TYPES,
  REQUEST_DOCUMENT_TYPE,
  REQUEST_SERIES,
  RequestError,
  assertRequestTransition,
  claimSettlement,
  isRequestKind,
  letterText,
  tripAdvanceFirstMonth,
  wholeDinarsUp,
  type LetterType,
  type RequestKind,
  type RequestStatus,
} from '../domain/hr-requests';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { can, type PermissionVerb } from '../domain/permissions';
import { AdminNotFoundError, optionalText, recordChange, requireText } from './administration';
import * as attachments from './attachments';
import * as authz from './authorization';
import * as companyService from './company';
import type { ActorContext } from './chart-of-accounts';
import * as advances from './employee-advances';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import * as posting from './posting';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'employee_request';
const ADVANCE_OBJECT = 'employee_advance';

export { RequestError };

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const scaled = (value: string | null | undefined) => parseDecimal((value ?? '0').trim() || '0', MONEY_SCALE);

type RequestRow = typeof employeeRequest.$inferSelect;
type Reader = { principal: ActorContext['principal'] };

async function load(tx: Tx, requestNo: string, options: { lock?: boolean } = {}): Promise<RequestRow> {
  const query = tx.select().from(employeeRequest).where(eq(employeeRequest.requestNo, requestNo)).limit(1);
  const [row] = await (options.lock ? query.for('update') : query);
  if (!row) throw new AdminNotFoundError('request', requestNo);
  return row;
}

const kindOf = (row: Pick<RequestRow, 'kind'>) => row.kind as RequestKind;

export interface Person {
  readonly id: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly fullNameAr: string | null;
  readonly branchCode: string;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly positionTitle: string | null;
  readonly status: string;
  readonly hireDate: string;
  readonly endDate: string | null;
  readonly appUserId: string | null;
  readonly managerUserId: string | null;
}

async function personOf(tx: Tx, employeeId: string): Promise<Person> {
  const [row] = await tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      branchCode: employee.branchCode,
      departmentCode: employee.departmentCode,
      departmentName: sql<string>`(select d.name from department d where d.code = "employee"."department_code")`,
      positionTitle: sql<string | null>`(select p.title_en from position p where p.code = "employee"."position_code")`,
      status: employee.status,
      hireDate: employee.hireDate,
      endDate: employee.endDate,
      appUserId: employee.appUserId,
      managerUserId: sql<string | null>`(select m.app_user_id from employee m where m.id = "employee"."manager_employee_id")`,
    })
    .from(employee)
    .where(eq(employee.id, employeeId))
    .limit(1);
  if (!row) throw new HrValidationError('employee', 'names nobody you may see');
  return row;
}

/** HR acts by its grant; the person may act for themself (R5), as with leave and advances. */
async function permitFor(ctx: ActorContext, person: Person, verb: PermissionVerb): Promise<void> {
  if (person.appUserId && person.appUserId === ctx.principal.userId) return;
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode: person.branchCode, objectId: person.employeeNo, requestId: ctx.requestId ?? null });
}

async function tell(
  tx: Tx,
  recipients: Iterable<string | null>,
  row: { requestNo: string; branchCode: string },
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
      objectId: row.requestNo,
      recipientUserId,
      subject,
      body,
      context: { requestNo: row.requestNo },
      dedupeKey: `${event}:${row.requestNo}:${occurrence}:${recipientUserId}`,
      branchCode: row.branchCode,
    });
  }
}

/** The active people who hold a verb on requests in a branch. */
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
// Asking
// ---------------------------------------------------------------------------

export interface ClaimLineInput {
  readonly spentOn: string;
  readonly categoryCode: string;
  readonly description: string;
  /** Dinars, as typed. */
  readonly amount: string;
}

export interface RequestInput {
  readonly employeeId: string;
  readonly kind: string;
  readonly subject: string;
  readonly details?: string | null;
  readonly destination?: string | null;
  readonly travelFrom?: string | null;
  readonly travelTo?: string | null;
  readonly estimated?: string | null;
  readonly letterType?: string | null;
  readonly addressedTo?: string | null;
  /** A claim's trip — the TRV it settles. */
  readonly travelRequestNo?: string | null;
  readonly lines?: readonly ClaimLineInput[];
}

const amountOf = (text: string | null | undefined, field: string): bigint => {
  const value = (text ?? '').trim().replace(/,/g, '');
  if (!/^\d{1,16}(\.\d{1,4})?$/.test(value)) throw new HrValidationError(field, `'${value}' is not an amount in dinars`);
  return scaled(value);
};

async function valuesOf(tx: Tx, kind: RequestKind, person: Person, input: RequestInput) {
  const base = {
    subject: requireText(input.subject, 'subject', 200),
    details: optionalText(input.details, 4000),
    destination: null as string | null,
    travelFrom: null as string | null,
    travelTo: null as string | null,
    estimatedIqd: null as string | null,
    letterType: null as string | null,
    addressedTo: null as string | null,
    travelRequestId: null as string | null,
  };
  if (kind === 'travel') {
    base.destination = requireText(input.destination, 'destination', 200);
    base.travelFrom = assertDay((input.travelFrom ?? '').trim(), 'travel_from');
    base.travelTo = assertDay((input.travelTo ?? '').trim(), 'travel_to');
    if (base.travelTo < base.travelFrom) throw new HrValidationError('travel_to', `cannot be before ${base.travelFrom}`);
    base.estimatedIqd = (input.estimated ?? '').trim() ? money(amountOf(input.estimated, 'estimated')) : null;
  }
  if (kind === 'letter') {
    const type = (input.letterType ?? '').trim() || 'employment';
    if (!(LETTER_TYPES as readonly string[]).includes(type)) throw new HrValidationError('letter_type', `must be one of ${LETTER_TYPES.join(', ')}`);
    base.letterType = type;
    base.addressedTo = optionalText(input.addressedTo, 200);
  }
  if (kind === 'expense_claim' && (input.travelRequestNo ?? '').trim()) {
    const [trip] = await tx
      .select({ id: employeeRequest.id, kind: employeeRequest.kind, status: employeeRequest.status, employeeId: employeeRequest.employeeId })
      .from(employeeRequest)
      .where(eq(employeeRequest.requestNo, input.travelRequestNo!.trim()))
      .limit(1);
    if (!trip || trip.kind !== 'travel') throw new HrValidationError('travel_request', `${input.travelRequestNo} is not a trip`);
    if (trip.employeeId !== person.id) throw new HrValidationError('travel_request', `${input.travelRequestNo} is somebody else's trip`);
    if (trip.status !== 'approved') throw new HrValidationError('travel_request', `${input.travelRequestNo} is ${trip.status}; a claim settles an approved trip`);
    base.travelRequestId = trip.id;
  }
  return base;
}

async function linesOf(tx: Tx, input: readonly ClaimLineInput[]) {
  const kept = input.filter((l) => (l.description ?? '').trim() || (l.amount ?? '').trim() || (l.categoryCode ?? '').trim());
  if (kept.length > 50) throw new RequestError('A claim has at most 50 lines.');
  const codes = [...new Set(kept.map((l) => (l.categoryCode ?? '').trim()))];
  const categories = codes.length ? await tx.select().from(expenseCategory).where(inArray(expenseCategory.code, codes)) : [];
  return kept.map((l, i) => {
    const category = categories.find((c) => c.code === (l.categoryCode ?? '').trim());
    if (!category) throw new HrValidationError('category', `line ${i + 1} names no expense category '${l.categoryCode}'`);
    if (!category.active) throw new HrValidationError('category', `line ${i + 1}: ${category.name} is deactivated`);
    const spentOn = assertDay((l.spentOn ?? '').trim(), 'spent_on');
    if (spentOn > businessToday()) throw new HrValidationError('spent_on', `line ${i + 1}: ${spentOn} has not come yet`);
    const amount = amountOf(l.amount, 'amount');
    if (amount <= 0n) throw new HrValidationError('amount', `line ${i + 1} claims nothing`);
    return { lineNo: i + 1, spentOn, expenseCategoryCode: category.code, description: requireText(l.description, 'description', 300), amountIqd: money(amount) };
  });
}

/** A request: by HR, or by the person for themself. */
export async function create(tx: Tx, ctx: ActorContext, input: RequestInput): Promise<{ id: string; requestNo: string }> {
  const person = await personOf(tx, input.employeeId);
  await permitFor(ctx, person, 'create');
  if (!isRequestKind(input.kind)) throw new HrValidationError('kind', 'must be an expense claim, a trip, a letter or another request');
  const kind = input.kind;
  if (person.status === 'ended' && kind !== 'letter') throw new RequestError(`${person.employeeNo} has left; only a letter is asked for a leaver.`);
  const values = await valuesOf(tx, kind, person, input);
  const lines = kind === 'expense_claim' ? await linesOf(tx, input.lines ?? []) : [];
  const total = lines.reduce((sum, l) => sum + scaled(l.amountIqd), 0n);
  const allocated = await allocateDocumentNumber(tx, REQUEST_SERIES[kind], { branchCode: person.branchCode, year: Number(businessToday().slice(0, 4)) }, ctx.principal.userId);
  const [made] = await tx
    .insert(employeeRequest)
    .values({ requestNo: allocated.documentNo, kind, employeeId: person.id, branchCode: person.branchCode, ...values, amountIqd: money(total), requestedBy: ctx.principal.userId })
    .returning({ id: employeeRequest.id });
  if (lines.length) await tx.insert(employeeRequestLine).values(lines.map((l) => ({ ...l, requestId: made!.id })));
  await recordChange(tx, ctx, {
    action: 'employee_request.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode: person.branchCode,
    after: { kind, employeeNo: person.employeeNo, subject: values.subject, amountIqd: money(total), lines: lines.length },
  });
  return { id: made!.id, requestNo: allocated.documentNo };
}

/** A draft changed — its kind stays; a claim's lines are replaced as the form sends them. */
export async function updateDraft(tx: Tx, ctx: ActorContext, requestNo: string, input: Omit<RequestInput, 'employeeId' | 'kind'>): Promise<void> {
  const row = await load(tx, requestNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  if (row.requestedBy !== ctx.principal.userId) await permitFor(ctx, person, 'edit_draft');
  if (row.status !== 'draft') throw new RequestError(`${requestNo} is ${row.status}; only a draft is changed.`);
  const kind = kindOf(row);
  const values = await valuesOf(tx, kind, person, { ...input, employeeId: row.employeeId, kind });
  let total = 0n;
  if (kind === 'expense_claim') {
    const lines = await linesOf(tx, input.lines ?? []);
    await tx.delete(employeeRequestLine).where(eq(employeeRequestLine.requestId, row.id));
    if (lines.length) await tx.insert(employeeRequestLine).values(lines.map((l) => ({ ...l, requestId: row.id })));
    total = lines.reduce((sum, l) => sum + scaled(l.amountIqd), 0n);
  }
  await tx
    .update(employeeRequest)
    .set({ ...values, amountIqd: money(total), updatedAt: new Date() })
    .where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_request.updated',
    objectType: PERMISSION_OBJECT,
    objectId: requestNo,
    branchCode: row.branchCode,
    before: { subject: row.subject, amountIqd: row.amountIqd },
    after: { subject: values.subject, amountIqd: money(total) },
  });
}

/** Who decides: the person's manager by the link when they sign in, else the HR managers. */
async function deciders(tx: Tx, person: Person, row: RequestRow): Promise<string[]> {
  if (person.managerUserId && person.managerUserId !== row.requestedBy && person.managerUserId !== person.appUserId) return [person.managerUserId];
  return holders(tx, 'approve', row.branchCode);
}

export async function submit(tx: Tx, ctx: ActorContext, requestNo: string): Promise<void> {
  const row = await load(tx, requestNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  if (row.requestedBy !== ctx.principal.userId) await permitFor(ctx, person, 'edit_draft');
  const kind = kindOf(row);
  assertRequestTransition(requestNo, kind, row.status, 'submitted');
  if (kind === 'expense_claim') {
    const lines = await tx
      .select({ code: employeeRequestLine.expenseCategoryCode, name: expenseCategory.name, requiresReceipt: expenseCategory.requiresReceipt })
      .from(employeeRequestLine)
      .innerJoin(expenseCategory, eq(expenseCategory.code, employeeRequestLine.expenseCategoryCode))
      .where(eq(employeeRequestLine.requestId, row.id));
    if (lines.length === 0) throw new RequestError(`${requestNo} claims nothing; add what was spent.`);
    const wanting = lines.find((l) => l.requiresReceipt);
    if (wanting && (await attachments.currentFor(tx, PERMISSION_OBJECT, row.id)).length === 0) {
      throw new RequestError(`${requestNo}: ${wanting.name} wants its receipt — attach it before sending the claim.`);
    }
  }
  const now = new Date();
  await tx.update(employeeRequest).set({ status: 'submitted', submittedAt: now, updatedAt: now }).where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, { action: 'employee_request.submitted', objectType: PERMISSION_OBJECT, objectId: requestNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: 'submitted' } });
  await tell(
    tx,
    await deciders(tx, person, row),
    row,
    'hr.request_submitted',
    now.toISOString(),
    `${requestNo}: ${person.fullNameEn} asks — ${row.subject}`,
    kind === 'expense_claim' ? `${money(scaled(row.amountIqd))} IQD` : row.details ?? '',
    [ctx.principal.userId, row.requestedBy, person.appUserId],
  );
}

/** Whether this reader may decide, and if not, why — for the screen. */
export function decisionRefusal(ctx: Reader, person: { appUserId: string | null; managerUserId: string | null }, row: Pick<RequestRow, 'status' | 'requestedBy'>): 'status' | 'maker' | 'grant' | null {
  if (row.status !== 'submitted') return 'status';
  const me = ctx.principal.userId;
  if (me === row.requestedBy || me === person.appUserId) return 'maker';
  if (person.managerUserId === me || can(ctx.principal, 'approve', PERMISSION_OBJECT)) return null;
  return 'grant';
}

async function decide(tx: Tx, ctx: ActorContext, requestNo: string, to: 'approved' | 'refused', note: string | null): Promise<void> {
  const row = await load(tx, requestNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  const kind = kindOf(row);
  assertRequestTransition(requestNo, kind, row.status, to);
  const refusal = decisionRefusal(ctx, person, row);
  if (refusal === 'grant') await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: requestNo });
  if (refusal === 'maker') throw new RequestError(`${requestNo} was asked by you or is yours; somebody else decides it.`);
  if (to === 'refused' && !note) throw new RequestError(`Say why ${requestNo} is refused.`);
  const now = new Date();
  await tx.update(employeeRequest).set({ status: to, decidedBy: ctx.principal.userId, decidedAt: now, decisionNote: note, updatedAt: now }).where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, { action: `employee_request.${to}`, objectType: PERMISSION_OBJECT, objectId: requestNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: to }, reason: note });
  await tell(tx, [person.appUserId, row.requestedBy], row, `hr.request_${to}`, now.toISOString(), `${requestNo} is ${to}`, note ?? row.subject, [ctx.principal.userId]);
  // What comes next is somebody else's: Finance reimburses a claim, HR issues a letter.
  if (to === 'approved' && kind === 'expense_claim') {
    await tell(tx, await holders(tx, 'execute', row.branchCode), row, 'hr.request_to_pay', now.toISOString(), `${requestNo} is approved — reimburse ${person.fullNameEn}`, `${money(scaled(row.amountIqd))} IQD`, [
      ctx.principal.userId,
      person.appUserId,
    ]);
  }
  if (to === 'approved' && kind === 'letter') {
    await tell(tx, await holders(tx, 'edit_draft', row.branchCode), row, 'hr.request_to_issue', now.toISOString(), `${requestNo} is approved — issue the letter`, row.subject, [ctx.principal.userId, person.appUserId]);
  }
}

export const approve = (tx: Tx, ctx: ActorContext, requestNo: string, note?: string | null) => decide(tx, ctx, requestNo, 'approved', optionalText(note, 1000));
export const refuse = (tx: Tx, ctx: ActorContext, requestNo: string, note: string) => decide(tx, ctx, requestNo, 'refused', optionalText(note, 1000));

/** Called off with a reason: by whoever asked or HR until it is decided; by an HR manager once approved. */
export async function cancel(tx: Tx, ctx: ActorContext, requestNo: string, reason: string): Promise<void> {
  const row = await load(tx, requestNo, { lock: true });
  const person = await personOf(tx, row.employeeId);
  assertRequestTransition(requestNo, kindOf(row), row.status, 'cancelled');
  if (row.status === 'approved') await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: requestNo });
  else if (row.requestedBy !== ctx.principal.userId) await permitFor(ctx, person, 'edit_draft');
  if (row.advanceId) throw new RequestError(`${requestNo} opened an advance; cancel the advance first.`);
  const why = requireText(reason, 'reason', 500);
  const now = new Date();
  await tx.update(employeeRequest).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: now, cancelReason: why, updatedAt: now }).where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, { action: 'employee_request.cancelled', objectType: PERMISSION_OBJECT, objectId: requestNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: 'cancelled' }, reason: why });
}

// ---------------------------------------------------------------------------
// After the approval
// ---------------------------------------------------------------------------

async function accountFor(tx: Tx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test((id ?? '').trim())) throw new HrValidationError('account', 'choose the bank or cash account the money leaves');
  const [account] = await tx
    .select()
    .from(bankCashAccount)
    .where(eq(bankCashAccount.id, (id ?? '').trim()))
    .limit(1);
  if (!account) throw new HrValidationError('account', 'choose the bank or cash account the money leaves');
  if (!account.active) throw new RequestError(`${account.code} is deactivated.`);
  if (account.currency !== 'IQD') throw new RequestError(`${account.code} holds ${account.currency}; claims are reimbursed in dinars (D-HR-2).`);
  return account;
}

export interface PayInput {
  /** Not needed when the trip's advance takes the whole claim. */
  readonly bankCashAccountId?: string | null;
  readonly on: string;
  readonly reference?: string | null;
}

/**
 * Reimbursed by Finance: the trip's advance settled first, the rest paid from
 * the account — one journal (`hr.expense_claim`).
 */
export async function pay(tx: Tx, ctx: ActorContext, requestNo: string, input: PayInput): Promise<{ entryNo: string; offsetIqd: string; paidIqd: string }> {
  const row = await load(tx, requestNo, { lock: true });
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: requestNo });
  assertRequestTransition(requestNo, kindOf(row), row.status, 'paid');
  const person = await personOf(tx, row.employeeId);
  if (person.appUserId === ctx.principal.userId) throw new RequestError(`${requestNo} is yours; somebody else reimburses it.`);
  const on = assertDay((input.on ?? '').trim(), 'paid_on');
  if (on > businessToday()) throw new HrValidationError('paid_on', `${on} has not come yet; record the payment the day the money leaves`);
  const total = scaled(row.amountIqd);
  // The trip's advance, when it has one still owing, is settled first.
  const [trip] = row.travelRequestId ? await tx.select({ advanceId: employeeRequest.advanceId }).from(employeeRequest).where(eq(employeeRequest.id, row.travelRequestId)).limit(1) : [];
  const owing = trip?.advanceId ? await advances.owedForClaim(tx, trip.advanceId) : null;
  const { offset, cash } = claimSettlement(total, owing?.owed ?? 0n);
  const account = cash > 0n ? await accountFor(tx, input.bankCashAccountId ?? '') : null;
  const reference = optionalText(input.reference, 120);
  const lines = await tx
    .select({
      lineNo: employeeRequestLine.lineNo,
      description: employeeRequestLine.description,
      amountIqd: employeeRequestLine.amountIqd,
      categoryName: expenseCategory.name,
      accountId: expenseCategory.defaultExpenseAccountId,
    })
    .from(employeeRequestLine)
    .innerJoin(expenseCategory, eq(expenseCategory.code, employeeRequestLine.expenseCategoryCode))
    .where(eq(employeeRequestLine.requestId, row.id))
    .orderBy(asc(employeeRequestLine.lineNo));
  const criteria = { branchCode: row.branchCode };
  const dimensions = { branch: row.branchCode, department: person.departmentCode };
  const description = `${requestNo} — ${person.employeeNo} ${row.subject}${reference ? ` (${reference})` : ''}`;
  const result = await posting.post(tx, ctx, {
    eventType: 'hr.expense_claim',
    documentTypeCode: REQUEST_DOCUMENT_TYPE.expense_claim,
    source: { module: 'hr', documentId: row.id, event: 'paid' },
    branchCode: row.branchCode,
    documentDate: on,
    postingDate: on,
    description,
    lines: [
      ...lines.map((l) => ({
        role: 'employee_expense',
        ...(l.accountId ? { accountId: l.accountId } : {}),
        debit: money(scaled(l.amountIqd)),
        criteria,
        dimensions,
        description: `${requestNo} — ${l.categoryName}: ${l.description}`,
      })),
      ...(offset > 0n ? [{ role: 'employee_advance', credit: money(offset), criteria, dimensions: { branch: row.branchCode }, description: `${requestNo} — settles ${owing!.advanceNo}` }] : []),
      ...(account ? [{ role: 'bank', accountId: account.glAccountId, credit: money(cash), criteria, dimensions: { branch: row.branchCode }, bankAccountCode: account.code, description }] : []),
    ],
  });
  if (offset > 0n) await advances.recordClaimRecovery(tx, ctx, trip!.advanceId!, offset, { id: row.id, requestNo, journalEntryId: result.journalEntryId, paidOn: on });
  const now = new Date();
  await tx
    .update(employeeRequest)
    .set({
      status: 'paid',
      paidBy: ctx.principal.userId,
      paidAt: now,
      paidOn: on,
      bankCashAccountId: account?.id ?? null,
      paymentReference: reference,
      advanceOffsetIqd: money(offset),
      journalEntryId: result.journalEntryId,
      updatedAt: now,
    })
    .where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, {
    action: 'employee_request.paid',
    objectType: PERMISSION_OBJECT,
    objectId: requestNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'paid', paidOn: on, entryNo: result.entryNo, paidIqd: money(cash), advanceOffsetIqd: money(offset), account: account?.code ?? null },
  });
  await tell(
    tx,
    [person.appUserId],
    row,
    'hr.request_paid',
    now.toISOString(),
    `${requestNo} is reimbursed`,
    offset > 0n ? `${money(cash)} IQD paid; ${money(offset)} IQD settled ${owing!.advanceNo}` : `${money(cash)} IQD`,
    [ctx.principal.userId],
  );
  return { entryNo: result.entryNo, offsetIqd: money(offset), paidIqd: money(cash) };
}

/** The text an approved letter is offered with: composed from the person's record. */
export async function draftLetter(tx: Tx, row: Pick<RequestRow, 'employeeId' | 'letterType' | 'addressedTo'>): Promise<string> {
  const person = await personOf(tx, row.employeeId);
  const company = (await companyService.current(tx))?.legalName ?? 'the company';
  return letterText((row.letterType ?? 'other') as LetterType, {
    fullName: person.fullNameEn,
    employeeNo: person.employeeNo,
    position: person.positionTitle,
    department: person.departmentName,
    hireDate: person.hireDate,
    endDate: person.endDate,
    addressedTo: row.addressedTo,
    company,
  });
}

/** Issued by HR — never by the person — with the text as it goes out; what is kept is what prints. */
export async function issue(tx: Tx, ctx: ActorContext, requestNo: string, text: string): Promise<void> {
  const row = await load(tx, requestNo, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: requestNo });
  assertRequestTransition(requestNo, kindOf(row), row.status, 'issued');
  const person = await personOf(tx, row.employeeId);
  if (person.appUserId === ctx.principal.userId) throw new RequestError(`${requestNo} is about you; somebody else issues it.`);
  const body = requireText(text, 'text', 8000);
  const now = new Date();
  await tx.update(employeeRequest).set({ status: 'issued', issuedBy: ctx.principal.userId, issuedAt: now, issuedText: body, updatedAt: now }).where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, { action: 'employee_request.issued', objectType: PERMISSION_OBJECT, objectId: requestNo, branchCode: row.branchCode, before: { status: row.status }, after: { status: 'issued' } });
  await tell(tx, [person.appUserId, row.requestedBy], row, 'hr.request_issued', now.toISOString(), `${requestNo}: your letter is issued`, row.subject, [ctx.principal.userId]);
}

/**
 * An approved trip's advance: an employee advance for its estimate (whole
 * dinars, rounded up), recovered from pay from the second month after the
 * trip unless a claim settles it first. It goes through the advance's own
 * approvals; the trip names it.
 */
export async function openTravelAdvance(tx: Tx, ctx: ActorContext, requestNo: string): Promise<{ advanceNo: string }> {
  const row = await load(tx, requestNo, { lock: true });
  if (row.kind !== 'travel') throw new RequestError(`${requestNo} is not a trip.`);
  if (row.status !== 'approved') throw new RequestError(`${requestNo} is ${row.status}; an advance is opened for an approved trip.`);
  if (row.advanceId) throw new RequestError(`${requestNo} already has its advance.`);
  const estimate = scaled(row.estimatedIqd);
  if (estimate <= 0n) throw new RequestError(`${requestNo} has no estimated cost to advance.`);
  const made = await advances.create(tx, ctx, {
    employeeId: row.employeeId,
    kind: 'advance',
    amount: money(wholeDinarsUp(estimate)),
    instalments: 1,
    firstRecoveryMonth: tripAdvanceFirstMonth(row.travelTo!).slice(0, 7),
    reason: `Travel ${requestNo}: ${row.destination}`,
  });
  await tx.update(employeeRequest).set({ advanceId: made.id, updatedAt: new Date() }).where(eq(employeeRequest.id, row.id));
  await recordChange(tx, ctx, { action: 'employee_request.advance_opened', objectType: PERMISSION_OBJECT, objectId: requestNo, branchCode: row.branchCode, after: { advanceNo: made.advanceNo } });
  return { advanceNo: made.advanceNo };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface RequestListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly kind?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: RequestListFilter) {
  const view = filter.view && ['draft', 'submitted', 'approved', 'refused', 'paid', 'issued', 'cancelled'].includes(filter.view) ? filter.view : null;
  const kind = filter.kind && isRequestKind(filter.kind) ? filter.kind : null;
  const where = whereOf([
    view ? sql`r.status = ${view}` : null,
    kind ? sql`r.kind = ${kind}` : null,
    searchOf([sql`r.request_no`, sql`r.subject`, sql`e.employee_no`, sql`e.full_name_en`, sql`e.full_name_ar`], filter.search),
  ]);
  const from = sql`from employee_request r join employee e on e.id = r.employee_id ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select r.id, r.request_no as "requestNo", r.kind, r.status, r.subject, r.amount_iqd::text as "amountIqd", r.estimated_iqd::text as "estimatedIqd",
                 to_char(r.created_at at time zone 'Asia/Baghdad', 'YYYY-MM-DD') as "askedOn",
                 e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", e.full_name_ar as "fullNameAr"
            ${from}
           order by case r.status when 'submitted' then 0 when 'approved' then 1 when 'draft' then 2 else 3 end, r.created_at desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        requestNo: string;
        kind: RequestKind;
        status: RequestStatus;
        subject: string;
        amountIqd: string;
        estimatedIqd: string | null;
        askedOn: string;
        employeeNo: string;
        fullNameEn: string;
        fullNameAr: string | null;
      }[],
  });
}

const userName = (column: string) => sql<string | null>`(select u.display_name from app_user u where u.id = ${sql.raw(`"employee_request"."${column}"`)})`;

/** The request, its person, its lines, and the trip, advance and journal it names. */
export async function byNo(tx: Tx, requestNo: string) {
  const [found] = await tx
    .select({
      row: employeeRequest,
      requestedByName: userName('requested_by'),
      decidedByName: userName('decided_by'),
      paidByName: userName('paid_by'),
      issuedByName: userName('issued_by'),
      cancelledByName: userName('cancelled_by'),
      entryNo: sql<string | null>`(select j.entry_no from journal_entry j where j.id = "employee_request"."journal_entry_id")`,
      accountCode: sql<string | null>`(select b.code from bank_cash_account b where b.id = "employee_request"."bank_cash_account_id")`,
      tripNo: sql<string | null>`(select t.request_no from employee_request t where t.id = "employee_request"."travel_request_id")`,
      advanceNo: sql<string | null>`(select a.advance_no from employee_advance a where a.id = "employee_request"."advance_id")`,
      advanceStatus: sql<string | null>`(select a.status from employee_advance a where a.id = "employee_request"."advance_id")`,
    })
    .from(employeeRequest)
    .where(eq(employeeRequest.requestNo, requestNo))
    .limit(1);
  if (!found) return null;
  const person = await personOf(tx, found.row.employeeId);
  const lines = await tx
    .select({
      id: employeeRequestLine.id,
      lineNo: employeeRequestLine.lineNo,
      spentOn: employeeRequestLine.spentOn,
      categoryCode: employeeRequestLine.expenseCategoryCode,
      categoryName: expenseCategory.name,
      requiresReceipt: expenseCategory.requiresReceipt,
      description: employeeRequestLine.description,
      amountIqd: employeeRequestLine.amountIqd,
    })
    .from(employeeRequestLine)
    .innerJoin(expenseCategory, eq(expenseCategory.code, employeeRequestLine.expenseCategoryCode))
    .where(eq(employeeRequestLine.requestId, found.row.id))
    .orderBy(asc(employeeRequestLine.lineNo));
  // A trip's claims, for the trip's record.
  const claims =
    found.row.kind === 'travel'
      ? await tx
          .select({ requestNo: employeeRequest.requestNo, status: employeeRequest.status, amountIqd: employeeRequest.amountIqd })
          .from(employeeRequest)
          .where(eq(employeeRequest.travelRequestId, found.row.id))
          .orderBy(asc(employeeRequest.createdAt))
      : [];
  return { ...found, person, lines, claims };
}

/** A person's requests, newest first — for their record. */
export async function ofEmployee(tx: Tx, employeeId: string) {
  return tx
    .select({ requestNo: employeeRequest.requestNo, kind: employeeRequest.kind, status: employeeRequest.status, subject: employeeRequest.subject, amountIqd: employeeRequest.amountIqd, createdAt: employeeRequest.createdAt })
    .from(employeeRequest)
    .where(eq(employeeRequest.employeeId, employeeId))
    .orderBy(desc(employeeRequest.createdAt));
}

/** Approved trips of a person a claim may settle. */
export async function tripsOf(tx: Tx, employeeId: string) {
  return tx
    .select({ requestNo: employeeRequest.requestNo, destination: employeeRequest.destination, travelFrom: employeeRequest.travelFrom })
    .from(employeeRequest)
    .where(and(eq(employeeRequest.employeeId, employeeId), eq(employeeRequest.kind, 'travel'), eq(employeeRequest.status, 'approved')))
    .orderBy(desc(employeeRequest.travelFrom));
}

/** The expense categories a claim's line may name: payables' own, active. */
export async function categories(tx: Tx) {
  return tx
    .select({ code: expenseCategory.code, name: expenseCategory.name, requiresReceipt: expenseCategory.requiresReceipt })
    .from(expenseCategory)
    .where(eq(expenseCategory.active, true))
    .orderBy(asc(expenseCategory.name));
}

/** Who a request may be for: the people the reader can see — or, for somebody without the grant, themself. */
export async function people(tx: Tx, ctx: Reader) {
  const query = tx.select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn }).from(employee);
  if (can(ctx.principal, 'create', PERMISSION_OBJECT)) return query.where(inArray(employee.status, ['active', 'suspended', 'ended'])).orderBy(asc(employee.employeeNo));
  return query.where(eq(employee.appUserId, ctx.principal.userId));
}

export interface RequestWaiting {
  readonly requestNo: string;
  readonly kind: RequestKind;
  readonly fullNameEn: string;
  readonly subject: string;
  readonly amountIqd: string;
  readonly action: 'decide' | 'pay' | 'issue';
}

/** The requests waiting on this reader: to decide, to reimburse, to issue. */
export async function waitingFor(tx: Tx, ctx: Reader): Promise<RequestWaiting[]> {
  const rows = (
    await tx.execute(sql`
      select r.request_no as "requestNo", r.kind, r.status, r.subject, r.amount_iqd::text as "amountIqd", r.requested_by as "requestedBy",
             e.full_name_en as "fullNameEn", e.app_user_id as "appUserId",
             (select m.app_user_id from employee m where m.id = e.manager_employee_id) as "managerUserId"
        from employee_request r join employee e on e.id = r.employee_id
       where r.status in ('submitted', 'approved')
       order by r.submitted_at
       limit 200`)
  ).rows as { requestNo: string; kind: RequestKind; status: string; subject: string; amountIqd: string; requestedBy: string; fullNameEn: string; appUserId: string | null; managerUserId: string | null }[];
  const out: RequestWaiting[] = [];
  for (const r of rows) {
    const base = { requestNo: r.requestNo, kind: r.kind, fullNameEn: r.fullNameEn, subject: r.subject, amountIqd: r.amountIqd };
    if (r.status === 'submitted') {
      if (decisionRefusal(ctx, r, { status: 'submitted', requestedBy: r.requestedBy }) === null) out.push({ ...base, action: 'decide' });
    } else if (r.kind === 'expense_claim' && r.appUserId !== ctx.principal.userId && can(ctx.principal, 'execute', PERMISSION_OBJECT)) out.push({ ...base, action: 'pay' });
    else if (r.kind === 'letter' && r.appUserId !== ctx.principal.userId && can(ctx.principal, 'edit_draft', PERMISSION_OBJECT)) out.push({ ...base, action: 'issue' });
  }
  return out;
}

/** What a reader may open of an advance a trip names (the advance's own page asks again). */
export const mayOpenAdvance = (ctx: Reader) => can(ctx.principal, 'view', ADVANCE_OBJECT);
