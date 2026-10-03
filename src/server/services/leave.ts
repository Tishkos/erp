/**
 * Leave — REQ-HR-001 Stage HR-2 (§7, §8).
 *
 * A request is counted on the year's working calendar (rest days and public
 * holidays inside the span are not taken), checked against the balance of
 * its type and decided by the person's manager — through the employee
 * record's manager link — or by the HR manager (D-HR-1). Whoever asked never
 * decides, and neither does the person on leave (maker-checker). An approved
 * request is the fact the day reads (B-HR-9): nothing is written to the
 * attendance sheet, so a cancellation deletes nothing.
 *
 * Balances derive (R2): entitlement by year from the hire date, the carry
 * capped by the type, opening balances and adjustments as dated rows,
 * approved days taken by the year they fall in.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, employee, leaveBalanceEntry, leaveRequest, leaveType, userRole, workingCalendar, workingCalendarHoliday } from '../db/schema';
import { HrValidationError, assertDay } from '../domain/hr';
import {
  DEFAULT_CALENDAR,
  assertWithinBalance,
  balanceFor,
  calendarOf,
  countLeave,
  daysFrom,
  daysText,
  isBalanceLimited,
  showDays,
  yearOf,
  type Balance,
  type Calendar,
  type LeaveStatus,
} from '../domain/hr-time';
import { can } from '../domain/permissions';
import { AdminNotFoundError, optionalText, recordChange, requireText } from './administration';
import * as attachments from './attachments';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as notifications from './notifications';
import { allocateDocumentNumber } from './numbering';
import { countOf, registerPage, searchOf, whereOf, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'leave_request';
const SEQUENCE_KEY = 'LEAVE_REQUEST';

export class LeaveError extends Error {
  readonly code = 'LEAVE';
  constructor(message: string) {
    super(message);
    this.name = 'LeaveError';
  }
}

/**
 * A sick note is filed on its request (§8): readable and attachable by whoever
 * reads leave, or by the person and their manager through the link.
 */
attachments.registerParentAccessCheck(PERMISSION_OBJECT, async (tx, principal, objectId) => {
  const [row] = await tx.select({ employeeId: leaveRequest.employeeId }).from(leaveRequest).where(eq(leaveRequest.id, objectId)).limit(1);
  if (!row) return false;
  if (can(principal, 'view', PERMISSION_OBJECT)) return true;
  const reach = await tx.execute(sql`select app_employee_reach(${row.employeeId}) as ok`);
  return Boolean((reach.rows[0] as { ok: boolean } | undefined)?.ok);
});

// ---------------------------------------------------------------------------
// The calendar of a year
// ---------------------------------------------------------------------------

/** The working calendar of each year asked: the year's active calendar (first by code), else Sunday–Thursday. */
export async function calendarsFor(tx: Tx, years: Iterable<number>): Promise<(year: number) => Calendar> {
  const wanted = [...new Set(years)];
  const found = new Map<number, Calendar>();
  if (wanted.length > 0) {
    const rows = await tx
      .select({ code: workingCalendar.code, year: workingCalendar.year, workingDays: workingCalendar.workingDays })
      .from(workingCalendar)
      .where(and(eq(workingCalendar.active, true), inArray(workingCalendar.year, wanted)))
      .orderBy(asc(workingCalendar.code));
    const chosen = new Map<number, { code: string; workingDays: string }>();
    for (const row of rows) if (!chosen.has(row.year)) chosen.set(row.year, row);
    const codes = [...chosen.values()].map((row) => row.code);
    const holidays =
      codes.length === 0
        ? []
        : await tx
            .select({ code: workingCalendarHoliday.calendarCode, day: workingCalendarHoliday.holidayDate })
            .from(workingCalendarHoliday)
            .where(inArray(workingCalendarHoliday.calendarCode, codes));
    for (const [year, row] of chosen) {
      found.set(year, calendarOf({ workingDays: row.workingDays, holidays: holidays.filter((h) => h.code === row.code).map((h) => h.day) }));
    }
  }
  return (year: number) => found.get(year) ?? DEFAULT_CALENDAR;
}

const yearsOf = (from: string, to: string): number[] => {
  const out: number[] = [];
  for (let year = yearOf(from); year <= yearOf(to); year += 1) out.push(year);
  return out;
};

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

async function employeeOf(tx: Tx, id: string) {
  const [row] = await tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      branchCode: employee.branchCode,
      status: employee.status,
      hireDate: employee.hireDate,
      endDate: employee.endDate,
      contractEndDate: employee.contractEndDate,
      appUserId: employee.appUserId,
      // Qualified by hand: in a one-table select Drizzle leaves the column bare, and inside the subquery a bare name would be m's own.
      managerUserId: sql<string | null>`(select m.app_user_id from employee m where m.id = "employee"."manager_employee_id")`,
      managerName: sql<string | null>`(select m.full_name_en from employee m where m.id = "employee"."manager_employee_id")`,
    })
    .from(employee)
    .where(eq(employee.id, id))
    .limit(1);
  if (!row) throw new AdminNotFoundError('employee', id);
  return row;
}

type Person = Awaited<ReturnType<typeof employeeOf>>;

/** The person's own request (self-service, R5) — the link is the permission. */
const isSelf = (ctx: ActorContext, person: Person) => person.appUserId !== null && person.appUserId === ctx.principal.userId;
/** The person's manager decides by the employee record's link (D-HR-1). */
const isManagerOf = (ctx: ActorContext, person: Person) => person.managerUserId !== null && person.managerUserId === ctx.principal.userId;

async function typeOf(tx: Tx, code: string) {
  const [row] = await tx.select().from(leaveType).where(eq(leaveType.code, code.trim().toUpperCase())).limit(1);
  if (!row) throw new HrValidationError('leave_type', `names no leave type '${code}'`);
  return row;
}

async function lock(tx: Tx, id: string) {
  const result = await tx.execute(sql`select id from leave_request where id = ${id} for update`);
  if (result.rows.length === 0) throw new AdminNotFoundError(PERMISSION_OBJECT, id);
  const [row] = await tx.select().from(leaveRequest).where(eq(leaveRequest.id, id)).limit(1);
  return row!;
}

// ---------------------------------------------------------------------------
// Counting and balances
// ---------------------------------------------------------------------------

/** Approved days of one type by the year they fall in, from the requests themselves (R2). */
async function takenByYear(tx: Tx, employeeId: string, typeCode: string, statuses: readonly LeaveStatus[], exceptId: string | null = null): Promise<Map<number, bigint>> {
  const rows = await tx
    .select({ id: leaveRequest.id, fromDate: leaveRequest.fromDate, toDate: leaveRequest.toDate, halfDayStart: leaveRequest.halfDayStart, halfDayEnd: leaveRequest.halfDayEnd })
    .from(leaveRequest)
    .where(and(eq(leaveRequest.employeeId, employeeId), eq(leaveRequest.leaveTypeCode, typeCode), inArray(leaveRequest.status, [...statuses])));
  const kept = rows.filter((row) => row.id !== exceptId);
  const calendar = await calendarsFor(
    tx,
    kept.flatMap((row) => yearsOf(row.fromDate, row.toDate)),
  );
  const out = new Map<number, bigint>();
  for (const row of kept) {
    for (const [year, days] of countLeave(row, calendar).byYear) out.set(year, (out.get(year) ?? 0n) + days);
  }
  return out;
}

export interface TypeBalance extends Balance {
  readonly leaveTypeCode: string;
  readonly nameEn: string;
  readonly nameAr: string | null;
  readonly limited: boolean;
  /** Submitted, not yet decided. */
  readonly pending: bigint;
  /** What a new request may still take: balance less pending. */
  readonly available: bigint;
  readonly allowedNegative: bigint;
}

async function balanceOf(tx: Tx, person: Person, type: typeof leaveType.$inferSelect, year: number, exceptId: string | null = null): Promise<TypeBalance> {
  const [taken, pending, entries] = await Promise.all([
    takenByYear(tx, person.id, type.code, ['approved'], exceptId),
    takenByYear(tx, person.id, type.code, ['submitted'], exceptId),
    tx
      .select({ year: leaveBalanceEntry.year, days: sql<string>`sum(${leaveBalanceEntry.days})::text` })
      .from(leaveBalanceEntry)
      .where(and(eq(leaveBalanceEntry.employeeId, person.id), eq(leaveBalanceEntry.leaveTypeCode, type.code)))
      .groupBy(leaveBalanceEntry.year),
  ]);
  const years = new Set<number>([...taken.keys(), ...entries.map((e) => e.year)]);
  const facts = [...years].map((y) => ({ year: y, taken: taken.get(y) ?? 0n, adjustments: daysFrom(entries.find((e) => e.year === y)?.days ?? '0') }));
  const daysPerYear = daysFrom(type.daysPerYear);
  const balance = balanceFor({
    year,
    hireDate: person.hireDate,
    endDate: person.endDate,
    daysPerYear,
    carryOverDays: daysFrom(type.carryOverDays),
    facts,
  });
  const waiting = pending.get(year) ?? 0n;
  return {
    ...balance,
    leaveTypeCode: type.code,
    nameEn: type.nameEn,
    nameAr: type.nameAr,
    limited: isBalanceLimited(daysPerYear),
    pending: waiting,
    available: balance.balance - waiting,
    allowedNegative: daysFrom(type.allowedNegativeDays),
  };
}

/** Every active type's balance for a person in a year, for the employee's page. */
export async function balances(tx: Tx, employeeId: string, year: number): Promise<TypeBalance[]> {
  const person = await employeeOf(tx, employeeId);
  const types = await tx.select().from(leaveType).where(eq(leaveType.active, true)).orderBy(asc(leaveType.code));
  const out: TypeBalance[] = [];
  for (const type of types) out.push(await balanceOf(tx, person, type, year));
  return out;
}

/** §8 — refused past what remains (each year the span touches), unless the type may go below zero. */
async function assertBalance(tx: Tx, person: Person, type: typeof leaveType.$inferSelect, byYear: ReadonlyMap<number, bigint>, exceptId: string): Promise<void> {
  if (!isBalanceLimited(daysFrom(type.daysPerYear))) return;
  for (const [year, days] of byYear) {
    if (days === 0n) continue;
    const balance = await balanceOf(tx, person, type, year, exceptId);
    assertWithinBalance(balance.available, days, balance.allowedNegative, `${type.nameEn} in ${year}`);
  }
}

async function assertNoOverlap(tx: Tx, employeeId: string, fromDate: string, toDate: string, exceptId: string | null): Promise<void> {
  const rows = await tx
    .select({ id: leaveRequest.id, requestNo: leaveRequest.requestNo, fromDate: leaveRequest.fromDate, toDate: leaveRequest.toDate })
    .from(leaveRequest)
    .where(
      and(
        eq(leaveRequest.employeeId, employeeId),
        inArray(leaveRequest.status, ['submitted', 'approved']),
        sql`${leaveRequest.fromDate} <= ${toDate}::date and ${leaveRequest.toDate} >= ${fromDate}::date`,
      ),
    );
  const clash = rows.find((row) => row.id !== exceptId);
  if (clash) throw new LeaveError(`These days overlap ${clash.requestNo} (${clash.fromDate} to ${clash.toDate}), which is already asked for or granted.`);
}

function assertEmployed(person: Person, fromDate: string, toDate: string): void {
  if (person.status === 'ended') throw new LeaveError(`${person.employeeNo} has left the company; leave cannot be requested for them.`);
  if (fromDate < person.hireDate) throw new LeaveError(`${person.employeeNo} was hired on ${person.hireDate}; leave cannot start before that.`);
  const last = person.endDate ?? person.contractEndDate;
  if (last && toDate > last) throw new LeaveError(`${person.employeeNo}'s employment ends on ${last}; leave cannot run past it.`);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface LeaveInput {
  readonly employeeId: string;
  readonly leaveTypeCode: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly halfDayStart?: boolean;
  readonly halfDayEnd?: boolean;
  readonly reason?: string | null;
}

/** HR enters a request for anyone they reach; a person with a sign-in for themself (R5). */
async function permitRequest(ctx: ActorContext, person: Person, verb: 'create' | 'edit_draft'): Promise<void> {
  if (isSelf(ctx, person)) return;
  await authz.authorize(ctx.principal, verb, PERMISSION_OBJECT, { branchCode: person.branchCode, objectId: person.employeeNo });
}

async function counted(tx: Tx, input: Pick<LeaveInput, 'fromDate' | 'toDate' | 'halfDayStart' | 'halfDayEnd'>) {
  const fromDate = assertDay(input.fromDate, 'from_date');
  const toDate = assertDay(input.toDate, 'to_date');
  if (toDate < fromDate) throw new HrValidationError('to_date', 'cannot be before the first day');
  const calendar = await calendarsFor(tx, yearsOf(fromDate, toDate));
  const count = countLeave({ fromDate, toDate, halfDayStart: Boolean(input.halfDayStart), halfDayEnd: Boolean(input.halfDayEnd) }, calendar);
  if (count.total === 0n) throw new LeaveError(`${fromDate} to ${toDate} has no working day in it — rest days and public holidays are not taken as leave.`);
  return { fromDate, toDate, count };
}

export async function create(tx: Tx, ctx: ActorContext, input: LeaveInput): Promise<{ id: string; requestNo: string }> {
  const person = await employeeOf(tx, requireText(input.employeeId, 'employee'));
  await permitRequest(ctx, person, 'create');
  const type = await typeOf(tx, input.leaveTypeCode);
  if (!type.active) throw new HrValidationError('leave_type', `${type.code} is no longer in use`);
  const { fromDate, toDate, count } = await counted(tx, input);
  assertEmployed(person, fromDate, toDate);

  const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode: person.branchCode, year: yearOf(fromDate) }, ctx.principal.userId);
  const [created] = await tx
    .insert(leaveRequest)
    .values({
      requestNo: allocated.documentNo,
      employeeId: person.id,
      branchCode: person.branchCode,
      leaveTypeCode: type.code,
      fromDate,
      toDate,
      halfDayStart: Boolean(input.halfDayStart),
      halfDayEnd: Boolean(input.halfDayEnd),
      days: daysText(count.total),
      reason: optionalText(input.reason),
      status: 'draft',
      requestedBy: ctx.principal.userId,
    })
    .returning({ id: leaveRequest.id });
  await recordChange(tx, ctx, {
    action: 'leave_request.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode: person.branchCode,
    after: { employeeNo: person.employeeNo, leaveType: type.code, fromDate, toDate, days: showDays(count.total) },
  });
  return { id: created!.id, requestNo: allocated.documentNo };
}

/** A draft changed before it is sent; the days are counted again. */
export async function updateDraft(tx: Tx, ctx: ActorContext, id: string, input: Omit<LeaveInput, 'employeeId'>): Promise<void> {
  const row = await lock(tx, id);
  const person = await employeeOf(tx, row.employeeId);
  await permitRequest(ctx, person, 'edit_draft');
  if (row.status !== 'draft') throw new LeaveError(`${row.requestNo} is ${row.status}; only a draft is changed — cancel it and ask again.`);
  const type = await typeOf(tx, input.leaveTypeCode);
  if (!type.active) throw new HrValidationError('leave_type', `${type.code} is no longer in use`);
  const { fromDate, toDate, count } = await counted(tx, input);
  assertEmployed(person, fromDate, toDate);
  const after = {
    leaveTypeCode: type.code,
    fromDate,
    toDate,
    halfDayStart: Boolean(input.halfDayStart),
    halfDayEnd: Boolean(input.halfDayEnd),
    days: daysText(count.total),
    reason: optionalText(input.reason),
  };
  await tx
    .update(leaveRequest)
    .set({ ...after, updatedAt: new Date() })
    .where(eq(leaveRequest.id, id));
  await recordChange(tx, ctx, {
    action: 'leave_request.updated',
    objectType: PERMISSION_OBJECT,
    objectId: row.requestNo,
    branchCode: row.branchCode,
    before: { leaveTypeCode: row.leaveTypeCode, fromDate: row.fromDate, toDate: row.toDate, days: row.days },
    after,
  });
}

/** Who is told a request waits: the person's manager when they sign in, else every HR manager. */
async function approversToTell(tx: Tx, person: Person, requestedBy: string): Promise<string[]> {
  if (person.managerUserId && person.managerUserId !== requestedBy && person.managerUserId !== person.appUserId) return [person.managerUserId];
  const rows = await tx
    .select({ userId: userRole.userId })
    .from(userRole)
    .innerJoin(appUser, eq(appUser.id, userRole.userId))
    .where(and(eq(userRole.roleCode, 'hr_manager'), eq(appUser.isActive, true)));
  return rows.map((r) => r.userId).filter((userId) => userId !== requestedBy && userId !== person.appUserId);
}

async function tell(tx: Tx, recipients: readonly (string | null)[], row: { requestNo: string; branchCode: string }, event: string, subject: string, body: string, occurrence: string): Promise<void> {
  for (const recipientUserId of new Set(recipients.filter((id): id is string => Boolean(id)))) {
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

/**
 * Sent for a decision: counted again, refused on an overlap, without the
 * paper its type requires, or past the balance (§8, D-HR-6).
 */
export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const row = await lock(tx, id);
  const person = await employeeOf(tx, row.employeeId);
  await permitRequest(ctx, person, 'edit_draft');
  if (row.status !== 'draft') throw new LeaveError(`${row.requestNo} is ${row.status}; only a draft is sent.`);
  const type = await typeOf(tx, row.leaveTypeCode);
  const { count } = await counted(tx, row);
  assertEmployed(person, row.fromDate, row.toDate);
  await assertNoOverlap(tx, row.employeeId, row.fromDate, row.toDate, row.id);
  if (type.requiresAttachment) {
    const files = await attachments.currentFor(tx, PERMISSION_OBJECT, row.id);
    if (files.length === 0) throw new LeaveError(`${type.nameEn} needs its paper (a sick note) attached to ${row.requestNo} before it is sent.`);
  }
  await assertBalance(tx, person, type, count.byYear, row.id);

  await tx
    .update(leaveRequest)
    .set({ status: 'submitted', submittedAt: new Date(), days: daysText(count.total), updatedAt: new Date() })
    .where(eq(leaveRequest.id, id));
  await recordChange(tx, ctx, {
    action: 'leave_request.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: row.requestNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'submitted', days: showDays(count.total) },
  });
  await tell(
    tx,
    await approversToTell(tx, person, row.requestedBy),
    row,
    'hr.leave_submitted',
    `${row.requestNo}: ${person.fullNameEn} asks for ${showDays(count.total)} days of ${type.nameEn}`,
    `${person.employeeNo} ${person.fullNameEn} — ${type.nameEn}, ${row.fromDate} to ${row.toDate} (${showDays(count.total)} working days). It waits for your decision on Leave Management.`,
    'submitted',
  );
}

/** May this person decide this request? The manager by the link, or the HR manager; never the asker, never the person. */
function decisionRefusal(ctx: ActorContext, person: Person, row: typeof leaveRequest.$inferSelect): string | null {
  if (row.requestedBy === ctx.principal.userId) return `the person who asked for ${row.requestNo} cannot decide it (maker-checker)`;
  if (isSelf(ctx, person)) return `${person.fullNameEn} cannot decide their own leave`;
  if (isManagerOf(ctx, person) || can(ctx.principal, 'approve', PERMISSION_OBJECT)) return null;
  return `only ${person.managerName ? `${person.managerName} (the manager)` : 'the manager'} or an HR manager decides ${row.requestNo}`;
}

export function mayDecide(
  ctx: ActorContext,
  person: { appUserId: string | null; managerUserId: string | null; managerName: string | null; fullNameEn: string },
  row: { requestedBy: string; status: string },
): boolean {
  if (row.status !== 'submitted') return false;
  return decisionRefusal(ctx, person as Person, row as typeof leaveRequest.$inferSelect) === null;
}

async function decide(tx: Tx, ctx: ActorContext, id: string, verdict: 'approved' | 'refused', note: string | null): Promise<void> {
  const row = await lock(tx, id);
  const person = await employeeOf(tx, row.employeeId);
  const refusal = decisionRefusal(ctx, person, row);
  if (refusal) {
    // Somebody with no standing at all is refused by the authorisation layer,
    // which writes the refusal; the asker and the person are told why not.
    const standing = isManagerOf(ctx, person) || can(ctx.principal, 'approve', PERMISSION_OBJECT) || row.requestedBy === ctx.principal.userId || isSelf(ctx, person);
    if (!standing) await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.requestNo });
    throw new LeaveError(`${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}.`);
  }
  if (row.status !== 'submitted') throw new LeaveError(`${row.requestNo} is ${row.status}; only a submitted request is decided.`);
  const type = await typeOf(tx, row.leaveTypeCode);
  if (verdict === 'approved') {
    // Somebody else's leave may have been granted since this was sent.
    const { count } = await counted(tx, row);
    await assertBalance(tx, person, type, count.byYear, row.id);
  }
  await tx.update(leaveRequest).set({ status: verdict, decidedBy: ctx.principal.userId, decidedAt: new Date(), decisionNote: note, updatedAt: new Date() }).where(eq(leaveRequest.id, id));
  await recordChange(tx, ctx, {
    action: `leave_request.${verdict}`,
    objectType: PERMISSION_OBJECT,
    objectId: row.requestNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: verdict, ...(note ? { note } : {}) },
  });
  const word = verdict === 'approved' ? 'granted' : 'refused';
  await tell(
    tx,
    [row.requestedBy, person.appUserId],
    row,
    `hr.leave_${verdict}`,
    `${row.requestNo}: ${type.nameEn} ${word}`,
    `${person.fullNameEn}'s ${type.nameEn}, ${row.fromDate} to ${row.toDate}, is ${word}${note ? ` — ${note}` : ''}.`,
    verdict,
  );
}

export async function approve(tx: Tx, ctx: ActorContext, id: string, note: string | null = null): Promise<void> {
  await decide(tx, ctx, id, 'approved', optionalText(note));
}

export async function refuse(tx: Tx, ctx: ActorContext, id: string, note: string): Promise<void> {
  await decide(tx, ctx, id, 'refused', requireText(note, 'decision_note'));
}

/**
 * Cancelled with a reason: a draft or a request still waiting by whoever may
 * change it; a granted leave only by the HR manager — the days it took come
 * back to the balance, and the days read what the sheet recorded again.
 */
export async function cancel(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const why = requireText(reason, 'cancel_reason');
  const row = await lock(tx, id);
  const person = await employeeOf(tx, row.employeeId);
  if (row.status === 'refused' || row.status === 'cancelled') throw new LeaveError(`${row.requestNo} is ${row.status} already.`);
  if (row.status === 'approved') {
    await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: row.branchCode, objectId: row.requestNo });
  } else {
    await permitRequest(ctx, person, 'edit_draft');
  }
  await tx.update(leaveRequest).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: new Date(), cancelReason: why, updatedAt: new Date() }).where(eq(leaveRequest.id, id));
  await recordChange(tx, ctx, {
    action: 'leave_request.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: row.requestNo,
    branchCode: row.branchCode,
    before: { status: row.status },
    after: { status: 'cancelled' },
    reason: why,
  });
  if (row.status === 'approved') {
    await tell(
      tx,
      [row.requestedBy, person.appUserId],
      row,
      'hr.leave_cancelled',
      `${row.requestNo}: granted leave cancelled`,
      `${person.fullNameEn}'s leave ${row.fromDate} to ${row.toDate} is cancelled — ${why}.`,
      'cancelled',
    );
  }
}

export interface AdjustmentInput {
  readonly employeeId: string;
  readonly leaveTypeCode: string;
  readonly year: number;
  readonly days: string;
  readonly kind: 'opening' | 'adjustment';
  readonly reason: string;
}

/** An opening balance or a correction: a dated row with its reason, never an edit (R2, R3). */
export async function adjustBalance(tx: Tx, ctx: ActorContext, input: AdjustmentInput): Promise<void> {
  const person = await employeeOf(tx, input.employeeId);
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: person.branchCode, objectId: person.employeeNo });
  const type = await typeOf(tx, input.leaveTypeCode);
  const days = daysFrom(input.days);
  if (days === 0n) throw new HrValidationError('days', 'an adjustment of nothing changes nothing');
  if (!Number.isInteger(input.year) || input.year < 2000 || input.year > 2100) throw new HrValidationError('year', 'must be a year');
  if (input.kind !== 'opening' && input.kind !== 'adjustment') throw new HrValidationError('kind', 'must be opening or adjustment');
  const reason = requireText(input.reason, 'reason');
  await tx.insert(leaveBalanceEntry).values({
    employeeId: person.id,
    leaveTypeCode: type.code,
    year: input.year,
    days: daysText(days),
    kind: input.kind,
    reason,
    recordedBy: ctx.principal.userId,
  });
  await recordChange(tx, ctx, {
    action: 'leave_balance.adjusted',
    objectType: 'employee',
    objectId: person.employeeNo,
    branchCode: person.branchCode,
    after: { leaveType: type.code, year: input.year, days: showDays(days), kind: input.kind },
    reason,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const typeName = sql<string>`(select t.name_en from leave_type t where t.code = "leave_request"."leave_type_code")`;
const typeNameAr = sql<string | null>`(select t.name_ar from leave_type t where t.code = "leave_request"."leave_type_code")`;
const userName = (column: string) => sql<string | null>`(select u.display_name from app_user u where u.id = ${sql.raw(`"leave_request"."${column}"`)})`;

export interface LeaveListFilter extends RegisterPaging {
  readonly view?: string | null;
  readonly leaveTypeCode?: string | null;
  readonly search?: string | null;
}

export async function listForScreen(tx: Tx, filter: LeaveListFilter) {
  const view = filter.view && ['draft', 'submitted', 'approved', 'refused', 'cancelled'].includes(filter.view) ? filter.view : null;
  const where = whereOf([
    view ? sql`r.status = ${view}` : null,
    filter.leaveTypeCode ? sql`r.leave_type_code = ${filter.leaveTypeCode}` : null,
    searchOf([sql`r.request_no`, sql`e.employee_no`, sql`e.full_name_en`, sql`e.full_name_ar`], filter.search),
  ]);
  const from = sql`from leave_request r join employee e on e.id = r.employee_id ${where}`;
  return registerPage({
    paging: filter,
    count: () => countOf(tx, from),
    rows: async ({ limit, offset }) =>
      (
        await tx.execute(sql`
          select r.id, r.request_no as "requestNo", r.status, r.leave_type_code as "leaveTypeCode",
                 (select t.name_en from leave_type t where t.code = r.leave_type_code) as "typeName",
                 (select t.name_ar from leave_type t where t.code = r.leave_type_code) as "typeNameAr",
                 r.from_date::text as "fromDate", r.to_date::text as "toDate", r.days::text as days,
                 e.employee_no as "employeeNo", e.full_name_en as "fullNameEn", e.full_name_ar as "fullNameAr",
                 r.submitted_at as "submittedAt"
            ${from}
           order by case r.status when 'submitted' then 0 when 'draft' then 1 else 2 end, r.from_date desc, r.request_no desc
           limit ${limit} offset ${offset}`)
      ).rows as unknown as {
        id: string;
        requestNo: string;
        status: LeaveStatus;
        leaveTypeCode: string;
        typeName: string;
        typeNameAr: string | null;
        fromDate: string;
        toDate: string;
        days: string;
        employeeNo: string;
        fullNameEn: string;
        fullNameAr: string | null;
        submittedAt: Date | null;
      }[],
  });
}

export async function byNo(tx: Tx, requestNo: string) {
  const [row] = await tx
    .select({
      id: leaveRequest.id,
      requestNo: leaveRequest.requestNo,
      status: leaveRequest.status,
      employeeId: leaveRequest.employeeId,
      branchCode: leaveRequest.branchCode,
      leaveTypeCode: leaveRequest.leaveTypeCode,
      typeName,
      typeNameAr,
      fromDate: leaveRequest.fromDate,
      toDate: leaveRequest.toDate,
      halfDayStart: leaveRequest.halfDayStart,
      halfDayEnd: leaveRequest.halfDayEnd,
      days: leaveRequest.days,
      reason: leaveRequest.reason,
      requestedBy: leaveRequest.requestedBy,
      requestedByName: userName('requested_by'),
      submittedAt: leaveRequest.submittedAt,
      decidedByName: userName('decided_by'),
      decidedAt: leaveRequest.decidedAt,
      decisionNote: leaveRequest.decisionNote,
      cancelledByName: userName('cancelled_by'),
      cancelledAt: leaveRequest.cancelledAt,
      cancelReason: leaveRequest.cancelReason,
      createdAt: leaveRequest.createdAt,
    })
    .from(leaveRequest)
    .where(eq(leaveRequest.requestNo, requestNo))
    .limit(1);
  if (!row) return null;
  const person = await employeeOf(tx, row.employeeId);
  const type = await typeOf(tx, row.leaveTypeCode);
  const calendar = await calendarsFor(tx, yearsOf(row.fromDate, row.toDate));
  const count = countLeave(row, calendar);
  const balance = await balanceOf(tx, person, type, yearOf(row.fromDate));
  return { row, person, type, count, balance };
}

/** A person's requests, newest first, for their page. */
export async function requestsOf(tx: Tx, employeeId: string, limit = 20) {
  return tx
    .select({
      requestNo: leaveRequest.requestNo,
      status: leaveRequest.status,
      typeName,
      typeNameAr,
      fromDate: leaveRequest.fromDate,
      toDate: leaveRequest.toDate,
      days: leaveRequest.days,
    })
    .from(leaveRequest)
    .where(eq(leaveRequest.employeeId, employeeId))
    .orderBy(desc(leaveRequest.fromDate), desc(leaveRequest.requestNo))
    .limit(limit);
}

/** The people a request may be made for, for the New dialog. */
export async function requestable(tx: Tx) {
  return tx.select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn }).from(employee).where(eq(employee.status, 'active')).orderBy(asc(employee.employeeNo));
}

export async function activeTypes(tx: Tx) {
  return tx.select().from(leaveType).where(eq(leaveType.active, true)).orderBy(asc(leaveType.code));
}

/** Approved leave over a span, per person — what the days read (B-HR-9). */
export async function approvedOver(tx: Tx, employeeIds: readonly string[], fromDate: string, toDate: string) {
  if (employeeIds.length === 0) return [];
  return tx
    .select({
      requestNo: leaveRequest.requestNo,
      employeeId: leaveRequest.employeeId,
      leaveTypeCode: leaveRequest.leaveTypeCode,
      typeName,
      typeNameAr,
      paid: sql<boolean>`(select t.paid from leave_type t where t.code = "leave_request"."leave_type_code")`,
      fromDate: leaveRequest.fromDate,
      toDate: leaveRequest.toDate,
      halfDayStart: leaveRequest.halfDayStart,
      halfDayEnd: leaveRequest.halfDayEnd,
    })
    .from(leaveRequest)
    .where(
      and(inArray(leaveRequest.employeeId, [...employeeIds]), eq(leaveRequest.status, 'approved'), sql`${leaveRequest.fromDate} <= ${toDate}::date and ${leaveRequest.toDate} >= ${fromDate}::date`),
    );
}

/** Leave waiting for this person's decision — as the manager by the link, or every one as an HR manager. */
export async function waitingFor(tx: Tx, ctx: ActorContext) {
  const asHr = can(ctx.principal, 'approve', PERMISSION_OBJECT);
  const rows = await tx.execute(sql`
    select r.request_no as "requestNo", e.full_name_en as "fullNameEn", r.from_date::text as "fromDate", r.to_date::text as "toDate",
           r.days::text as days, r.submitted_at as "submittedAt"
      from leave_request r
      join employee e on e.id = r.employee_id
      left join employee m on m.id = e.manager_employee_id
     where r.status = 'submitted'
       and r.requested_by <> ${ctx.principal.userId}
       and (e.app_user_id is null or e.app_user_id <> ${ctx.principal.userId})
       and (${asHr} or m.app_user_id = ${ctx.principal.userId})
     order by r.submitted_at
     limit 50`);
  return rows.rows as unknown as { requestNo: string; fullNameEn: string; fromDate: string; toDate: string; days: string; submittedAt: Date }[];
}
