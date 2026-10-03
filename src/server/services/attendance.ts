/**
 * Attendance — REQ-HR-001 Stage HR-2 (§8, D-HR-8).
 *
 * The day sheet records, per person per day, present or absent with the
 * optional in and out times. What a day *was* is read, never stored twice
 * (B-HR-9): an approved leave over it, else the sheet, else the calendar's
 * rest day or holiday, else "not recorded". The sheet does not let a leave
 * day be overwritten: the leave is the fact, and a wrong leave is cancelled.
 *
 * Payroll (HR-3) reads `summary` — the same reading the screens show.
 */
import { and, asc, eq, gte, inArray, lte, or, sql, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { attendanceDay, department, employee, position } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { HrValidationError, assertDay } from '../domain/hr';
import { ATTENDANCE_STATUSES, countLeave, dayKind, dayStatus, daysBetween, timeOrNull, yearOf, type AttendanceStatus, type DayKind, type DayStatus } from '../domain/hr-time';
import { optionalText, recordChange } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import { approvedOver, calendarsFor } from './leave';

export const PERMISSION_OBJECT = 'attendance';

export interface SheetRow {
  readonly employeeId: string;
  readonly employeeNo: string;
  readonly fullNameEn: string;
  readonly fullNameAr: string | null;
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly positionTitle: string | null;
  readonly kind: DayKind;
  readonly status: DayStatus;
  readonly recorded: AttendanceStatus | null;
  readonly checkIn: string | null;
  readonly checkOut: string | null;
  readonly note: string | null;
  /** The approved leave the day reads, when there is one. */
  readonly leaveRequestNo: string | null;
  readonly leaveTypeName: string | null;
  readonly leaveTypeNameAr: string | null;
}

const hhmm = (value: string | null) => (value ? value.slice(0, 5) : null);

/** Who works in a branch on a day: hired by then, not gone before it. */
async function peopleOn(tx: Tx, branchCode: string, day: string, departmentCode: string | null) {
  return tx
    .select({
      employeeId: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      departmentCode: employee.departmentCode,
      departmentName: department.name,
      positionTitle: position.titleEn,
    })
    .from(employee)
    .innerJoin(department, eq(department.code, employee.departmentCode))
    .leftJoin(position, eq(position.code, employee.positionCode))
    .where(
      and(
        eq(employee.branchCode, branchCode),
        lte(employee.hireDate, day),
        or(isNull(employee.endDate), gte(employee.endDate, day)),
        departmentCode ? eq(employee.departmentCode, departmentCode) : undefined,
      ),
    )
    .orderBy(asc(employee.departmentCode), asc(employee.employeeNo));
}

/** One branch's day: everyone who works there, what the day reads for each, what the sheet holds. */
export async function sheet(tx: Tx, input: { branchCode: string; day: string; departmentCode?: string | null }): Promise<{ day: string; kind: DayKind; rows: SheetRow[] }> {
  const day = assertDay(input.day, 'day');
  const people = await peopleOn(tx, input.branchCode, day, input.departmentCode ?? null);
  const ids = people.map((p) => p.employeeId);
  const calendar = await calendarsFor(tx, [yearOf(day)]);
  const kind = dayKind(day, calendar(yearOf(day)));
  const [recorded, leaves] = await Promise.all([
    ids.length === 0
      ? []
      : tx
          .select()
          .from(attendanceDay)
          .where(and(eq(attendanceDay.day, day), inArray(attendanceDay.employeeId, ids))),
    approvedOver(tx, ids, day, day),
  ]);
  const rows = people.map((person): SheetRow => {
    const record = recorded.find((r) => r.employeeId === person.employeeId) ?? null;
    const leave = leaves.find((l) => l.employeeId === person.employeeId) ?? null;
    return {
      ...person,
      kind,
      status: dayStatus({ onLeave: leave !== null, recorded: (record?.status as AttendanceStatus | undefined) ?? null, kind }),
      recorded: (record?.status as AttendanceStatus | undefined) ?? null,
      checkIn: hhmm(record?.checkIn ?? null),
      checkOut: hhmm(record?.checkOut ?? null),
      note: record?.note ?? null,
      leaveRequestNo: leave?.requestNo ?? null,
      leaveTypeName: leave?.typeName ?? null,
      leaveTypeNameAr: leave?.typeNameAr ?? null,
    };
  });
  return { day, kind, rows };
}

export interface SheetEntry {
  readonly employeeId: string;
  /** Empty leaves the person's day as it is. */
  readonly status: AttendanceStatus | '' | null;
  readonly checkIn?: string | null;
  readonly checkOut?: string | null;
  readonly note?: string | null;
}

/**
 * The sheet saved: each line that says present or absent is written or
 * corrected (the before and after in one audit row for the day); a line left
 * empty is left alone; a person on approved leave is not written over.
 */
export async function saveSheet(tx: Tx, ctx: ActorContext, input: { branchCode: string; day: string; entries: readonly SheetEntry[] }): Promise<{ written: number }> {
  const day = assertDay(input.day, 'day');
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: input.branchCode, objectId: day });
  if (day > businessToday()) throw new HrValidationError('day', `${day} has not come yet; attendance is recorded for a day that has happened`);
  const current = await sheet(tx, { branchCode: input.branchCode, day });
  const changes: { employeeNo: string; before: string | null; after: string }[] = [];
  for (const entry of input.entries) {
    const status = (entry.status ?? '') as AttendanceStatus | '';
    if (!status) continue;
    if (!(ATTENDANCE_STATUSES as readonly string[]).includes(status)) throw new HrValidationError('status', 'must be present or absent');
    const row = current.rows.find((r) => r.employeeId === entry.employeeId);
    if (!row) throw new HrValidationError('employee', `does not work in ${input.branchCode} on ${day}`);
    if (row.leaveRequestNo) {
      throw new HrValidationError('status', `${row.employeeNo} is on leave that day (${row.leaveRequestNo}); cancel the leave to record the day otherwise`);
    }
    const checkIn = status === 'present' ? timeOrNull(entry.checkIn, `check_in (${row.employeeNo})`) : null;
    const checkOut = status === 'present' ? timeOrNull(entry.checkOut, `check_out (${row.employeeNo})`) : null;
    if (checkIn && checkOut && checkOut < checkIn) throw new HrValidationError(`check_out (${row.employeeNo})`, 'cannot be before the check-in');
    const note = optionalText(entry.note);
    const same = row.recorded === status && row.checkIn === checkIn && row.checkOut === checkOut && (row.note ?? null) === note;
    if (same) continue;
    if (row.recorded === null) {
      await tx.insert(attendanceDay).values({ employeeId: row.employeeId, branchCode: input.branchCode, day, status, checkIn, checkOut, note, recordedBy: ctx.principal.userId });
    } else {
      await tx
        .update(attendanceDay)
        .set({ status, checkIn, checkOut, note, updatedBy: ctx.principal.userId, updatedAt: new Date() })
        .where(and(eq(attendanceDay.employeeId, row.employeeId), eq(attendanceDay.day, day)));
    }
    changes.push({
      employeeNo: row.employeeNo,
      before: row.recorded ? [row.recorded, row.checkIn, row.checkOut].filter(Boolean).join(' ') : null,
      after: [status, checkIn, checkOut].filter(Boolean).join(' '),
    });
  }
  if (changes.length > 0) {
    await recordChange(tx, ctx, {
      action: 'attendance.recorded',
      objectType: PERMISSION_OBJECT,
      objectId: `${input.branchCode}:${day}`,
      branchCode: input.branchCode,
      after: { day, changes },
    });
  }
  return { written: changes.length };
}

export interface MonthDay {
  readonly day: string;
  readonly kind: DayKind;
  readonly status: DayStatus;
  readonly checkIn: string | null;
  readonly checkOut: string | null;
  readonly note: string | null;
  readonly leaveRequestNo: string | null;
  readonly leaveTypeName: string | null;
  readonly leaveTypeNameAr: string | null;
  readonly paidLeave: boolean | null;
}

/** One person's days over a span, read as the sheet reads them. */
export async function daysOf(tx: Tx, employeeId: string, fromDate: string, toDate: string): Promise<MonthDay[]> {
  const days = daysBetween(assertDay(fromDate, 'from'), assertDay(toDate, 'to'));
  const calendar = await calendarsFor(tx, days.map(yearOf));
  const [recorded, leaves] = await Promise.all([
    tx
      .select()
      .from(attendanceDay)
      .where(and(eq(attendanceDay.employeeId, employeeId), gte(attendanceDay.day, fromDate), lte(attendanceDay.day, toDate))),
    approvedOver(tx, [employeeId], fromDate, toDate),
  ]);
  return days.map((day) => {
    const kind = dayKind(day, calendar(yearOf(day)));
    const record = recorded.find((r) => r.day === day) ?? null;
    const leave = leaves.find((l) => l.fromDate <= day && l.toDate >= day) ?? null;
    return {
      day,
      kind,
      status: dayStatus({ onLeave: leave !== null, recorded: (record?.status as AttendanceStatus | undefined) ?? null, kind }),
      checkIn: hhmm(record?.checkIn ?? null),
      checkOut: hhmm(record?.checkOut ?? null),
      note: record?.note ?? null,
      leaveRequestNo: leave?.requestNo ?? null,
      leaveTypeName: leave?.typeName ?? null,
      leaveTypeNameAr: leave?.typeNameAr ?? null,
      paidLeave: leave?.paid ?? null,
    };
  });
}

/** The month of a "YYYY-MM", first and last day. */
export function monthSpan(month: string): { fromDate: string; toDate: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HrValidationError('month', 'must be a month, written YYYY-MM');
  const [year, mm] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  return { fromDate: `${month}-01`, toDate: `${month}-${String(last).padStart(2, '0')}` };
}

export interface AttendanceSummary {
  readonly present: number;
  readonly absent: number;
  readonly unrecorded: number;
  readonly holidays: number;
  readonly restDays: number;
  /** Leave in hundredths of a day — half days count half. */
  readonly paidLeave: bigint;
  readonly unpaidLeave: bigint;
}

/**
 * The counts payroll reads (HR-3): what each day of the span was. Leave is
 * counted as the request counts it, so a half day is half.
 */
export async function summary(tx: Tx, employeeId: string, fromDate: string, toDate: string): Promise<AttendanceSummary> {
  const days = await daysOf(tx, employeeId, fromDate, toDate);
  const leaves = await approvedOver(tx, [employeeId], fromDate, toDate);
  const calendar = await calendarsFor(
    tx,
    days.map((d) => yearOf(d.day)),
  );
  let paidLeave = 0n;
  let unpaidLeave = 0n;
  for (const leave of leaves) {
    for (const counted of countLeave(leave, calendar).days) {
      if (counted.day < fromDate || counted.day > toDate) continue;
      if (leave.paid) paidLeave += counted.portion;
      else unpaidLeave += counted.portion;
    }
  }
  const count = (status: DayStatus) => days.filter((d) => d.status === status).length;
  return { present: count('present'), absent: count('absent'), unrecorded: count('unrecorded'), holidays: count('holiday'), restDays: count('rest'), paidLeave, unpaidLeave };
}

export const ATTENDANCE_DAY_STATUSES = ATTENDANCE_STATUSES;
