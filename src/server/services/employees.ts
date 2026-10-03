/**
 * Employees — REQ-HR-001 Stage HR-1 (§4, §5).
 *
 * One record per person (R1). Where they are now is on the row; every
 * change of branch, department, position, manager, status or kind is a
 * dated `employee_history` row written in the same transaction (R3, H8),
 * so "who was their manager in March" is a query. Identity fields (names,
 * phone, address) are corrected in place and audited: a typo is not an
 * event.
 *
 * Compensation is a dated row in its own table, read and written under its
 * own grant (`employee_compensation`), which the database policy asks for
 * itself (R5, H2). The history records *that* the salary changed, never the
 * figure: the history is readable by whoever reads the employee.
 */
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, branch, department, employee, employeeCompensation, employeeHistory, position } from '../db/schema';
import { businessToday } from '../domain/business-date';
import {
  HrValidationError,
  assertDay,
  isEmployeeStatus,
  isEmploymentKind,
  isPayMethod,
  type EmployeeStatus,
  type EmploymentKind,
  type PayMethod,
} from '../domain/hr';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { AdminNotFoundError, normaliseCode, optionalText, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import { can } from '../domain/permissions';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'employee';
export const COMPENSATION_OBJECT = 'employee_compensation';
export const ORGANISATION_OBJECT = 'org_structure';
/** Users — whoever may create one may create the employee behind it (D-FX-9). */
const USER_OBJECT = 'app_user';
const SEQUENCE_KEY = 'EMPLOYEE';

export interface EmployeeInput {
  readonly fullNameEn: string;
  readonly fullNameAr?: string | null;
  readonly nationalId?: string | null;
  readonly dateOfBirth?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly emergencyContact?: string | null;
  readonly departmentCode: string;
  readonly positionCode?: string | null;
  readonly managerEmployeeId?: string | null;
  readonly hireDate: string;
  readonly employmentKind: string;
  /** HR-2 — when a contract or daily engagement ends. */
  readonly contractEndDate?: string | null;
}

export interface MoveInput {
  /** The day the change takes effect; today unless the form says otherwise. */
  readonly effectiveFrom?: string | null;
  readonly reason?: string | null;
  readonly departmentCode?: string | null;
  readonly positionCode?: string | null;
  readonly managerEmployeeId?: string | null;
  readonly employmentKind?: string | null;
  /** HR-2 — a contract's end; empty clears it (a permanent hire). */
  readonly contractEndDate?: string | null;
}

export interface IdentityInput {
  readonly fullNameEn: string;
  readonly fullNameAr?: string | null;
  readonly nationalId?: string | null;
  readonly dateOfBirth?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly emergencyContact?: string | null;
}

export interface CompensationInput {
  readonly effectiveFrom: string;
  readonly baseSalaryIqd: string;
  readonly payMethod: string;
  readonly bankCode?: string | null;
  readonly accountNumber?: string | null;
  readonly iban?: string | null;
  readonly note?: string | null;
}

async function history(
  tx: Tx,
  ctx: ActorContext,
  employeeId: string,
  rows: readonly { field: string; before: string | null; after: string | null; effectiveFrom: string; reason?: string | null }[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(employeeHistory).values(
    rows.map((row) => ({
      employeeId,
      effectiveFrom: row.effectiveFrom,
      field: row.field,
      beforeValue: row.before,
      afterValue: row.after,
      reason: row.reason ?? null,
      recordedBy: ctx.principal.userId,
    })),
  );
}

async function loadById(tx: Tx, id: string) {
  const [row] = await tx.select().from(employee).where(eq(employee.id, id)).limit(1);
  if (!row) throw new AdminNotFoundError('employee', id);
  return row;
}

async function assertDepartment(tx: Tx, code: string): Promise<string> {
  const normalised = normaliseCode(code, 'department');
  const [row] = await tx.select({ code: department.code }).from(department).where(eq(department.code, normalised)).limit(1);
  if (!row) throw new HrValidationError('department', `names no department '${normalised}'`);
  return normalised;
}

async function assertPosition(tx: Tx, code: string | null | undefined): Promise<string | null> {
  const text = (code ?? '').trim();
  if (!text) return null;
  const normalised = normaliseCode(text, 'position');
  const [row] = await tx.select({ code: position.code, active: position.active }).from(position).where(eq(position.code, normalised)).limit(1);
  if (!row) throw new HrValidationError('position', `names no position '${normalised}'`);
  return normalised;
}

async function assertManager(tx: Tx, id: string | null | undefined, self: string | null): Promise<string | null> {
  const text = (id ?? '').trim();
  if (!text) return null;
  if (self && text === self) throw new HrValidationError('manager', 'an employee cannot be their own manager');
  const [row] = await tx.select({ id: employee.id, status: employee.status }).from(employee).where(eq(employee.id, text)).limit(1);
  if (!row) throw new HrValidationError('manager', 'names no employee');
  if (row.status === 'ended') throw new HrValidationError('manager', 'has left the company');
  return row.id;
}

function kindOf(value: string): EmploymentKind {
  if (!isEmploymentKind(value)) throw new HrValidationError('employment_kind', 'must be permanent, contract or daily');
  return value;
}

export async function create(tx: Tx, ctx: ActorContext, input: EmployeeInput): Promise<{ id: string; employeeNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  return insertEmployee(tx, ctx, ctx.branchCode, input, { appUserId: null, reason: null });
}

export interface UserEmployeeInput {
  readonly appUserId: string;
  readonly fullNameEn: string;
  readonly branchCode: string;
  readonly departmentCode: string;
  readonly positionCode?: string | null;
  readonly hireDate?: string | null;
}

/**
 * The employee a new user is (REQ-FIX-001 FIX-5, D-FX-9): made with the
 * user, in the same transaction, linked one to one. It is a user-management
 * act — whoever may create a user may create the person behind it — and the
 * HR record it opens is the minimum (name, branch, department, the day the
 * account was made): HR completes the rest on the employee's page.
 */
export async function createForUser(tx: Tx, ctx: ActorContext, input: UserEmployeeInput, reason: string | null = null): Promise<{ id: string; employeeNo: string }> {
  const viaUsers = can(ctx.principal, 'create', USER_OBJECT);
  if (!viaUsers) await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: input.branchCode });
  const [taken] = await tx.select({ employeeNo: employee.employeeNo }).from(employee).where(eq(employee.appUserId, input.appUserId)).limit(1);
  if (taken) throw new HrValidationError('user', `is already ${taken.employeeNo}`);
  // The employee is kept in the user's branch; the row's policy asks that the
  // one making it works there too. Said here, in words, rather than as a
  // row-security refusal.
  const allowed = await tx.execute(sql`select (app_is_super_user() or app_branch_allowed(${input.branchCode})) as ok`);
  if (!(allowed.rows[0] as { ok: boolean }).ok) {
    throw new HrValidationError('branch', `the employee is kept in branch ${input.branchCode}, which you do not work in — untick "Also an employee" and HR will add the person`);
  }
  return insertEmployee(
    tx,
    ctx,
    input.branchCode,
    {
      fullNameEn: input.fullNameEn,
      departmentCode: input.departmentCode,
      positionCode: input.positionCode ?? null,
      hireDate: input.hireDate ?? businessToday(),
      employmentKind: 'permanent',
    },
    { appUserId: input.appUserId, reason },
  );
}

export interface BackfillOutcome {
  readonly made: readonly { readonly email: string; readonly employeeNo: string; readonly departmentCode: string; readonly departmentAssumed: boolean }[];
  readonly skipped: readonly { readonly email: string; readonly why: string }[];
}

/**
 * Every active user without an employee gets one (FX14) — never two: a user
 * already linked is passed over, and the unique index on the link holds it
 * if two runs race. The branch is the user's default, else the first they
 * work in; the department the first they are scoped to, else the company's
 * first active department — said in the history's reason, for HR to move.
 * Hired the day the account was made.
 */
export async function ensureForUsers(tx: Tx, ctx: ActorContext): Promise<BackfillOutcome> {
  const { rows } = await tx.execute(sql`
    select u.id, u.email, u.display_name as "displayName",
           to_char(u.created_at at time zone 'Asia/Baghdad', 'YYYY-MM-DD') as "hireDate",
           (select s.branch_code from user_branch_scope s join branch b on b.code = s.branch_code
             where s.user_id = u.id and b.active order by s.is_default desc, s.branch_code limit 1) as "branchCode",
           (select s.department_code from user_department_scope s join department d on d.code = s.department_code
             where s.user_id = u.id and d.active order by s.department_code limit 1) as "departmentCode"
      from app_user u
     where u.is_active
       and not exists (select 1 from employee e where e.app_user_id = u.id)
     order by u.created_at, u.email`);
  const [fallback] = await tx.select({ code: department.code }).from(department).where(eq(department.active, true)).orderBy(asc(department.code)).limit(1);
  const made: BackfillOutcome['made'][number][] = [];
  const skipped: BackfillOutcome['skipped'][number][] = [];
  for (const raw of rows as { id: string; email: string; displayName: string; hireDate: string; branchCode: string | null; departmentCode: string | null }[]) {
    if (!raw.branchCode) {
      skipped.push({ email: raw.email, why: 'works in no active branch' });
      continue;
    }
    const departmentCode = raw.departmentCode ?? fallback?.code ?? null;
    if (!departmentCode) {
      skipped.push({ email: raw.email, why: 'there is no active department' });
      continue;
    }
    const assumed = raw.departmentCode === null;
    const reason = assumed
      ? `Backfilled from the user account (REQ-FIX-001 FX14); the account had no department, so ${departmentCode} until HR moves the person`
      : 'Backfilled from the user account (REQ-FIX-001 FX14)';
    const done = await createForUser(tx, ctx, { appUserId: raw.id, fullNameEn: raw.displayName, branchCode: raw.branchCode, departmentCode, hireDate: raw.hireDate }, reason);
    made.push({ email: raw.email, employeeNo: done.employeeNo, departmentCode, departmentAssumed: assumed });
  }
  return { made, skipped };
}

/** The person behind a user account, for the user's page. */
export async function ofUser(tx: Tx, appUserId: string) {
  const [row] = await tx
    .select({ employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, status: employee.status })
    .from(employee)
    .where(eq(employee.appUserId, appUserId))
    .limit(1);
  return row ?? null;
}

/**
 * The one insert behind every way a person enters the register: HR's New
 * dialog, a new user with *Also an employee* ticked, and the backfill of the
 * users who signed in before the two were linked (REQ-FIX-001 FIX-5).
 */
async function insertEmployee(
  tx: Tx,
  ctx: ActorContext,
  branchCode: string,
  input: EmployeeInput,
  link: { readonly appUserId: string | null; readonly reason: string | null },
): Promise<{ id: string; employeeNo: string }> {
  const fullNameEn = requireText(input.fullNameEn, 'full_name_en');
  const hireDate = assertDay(input.hireDate, 'hire_date');
  const departmentCode = await assertDepartment(tx, input.departmentCode);
  const positionCode = await assertPosition(tx, input.positionCode);
  const managerEmployeeId = await assertManager(tx, input.managerEmployeeId, null);
  const employmentKind = kindOf(input.employmentKind);
  const dateOfBirth = input.dateOfBirth ? assertDay(input.dateOfBirth, 'date_of_birth') : null;
  const contractEndDate = input.contractEndDate ? assertDay(input.contractEndDate, 'contract_end_date') : null;
  if (contractEndDate && contractEndDate < hireDate) throw new HrValidationError('contract_end_date', `cannot be before the hire date ${hireDate}`);

  // EMP-{BRANCH}-{SERIAL}: minted, never typed (§4).
  const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, { branchCode }, ctx.principal.userId);
  const [created] = await tx
    .insert(employee)
    .values({
      employeeNo: allocated.documentNo,
      fullNameEn,
      fullNameAr: optionalText(input.fullNameAr),
      nationalId: optionalText(input.nationalId, 64),
      dateOfBirth,
      phone: optionalText(input.phone, 64),
      address: optionalText(input.address),
      emergencyContact: optionalText(input.emergencyContact),
      branchCode,
      departmentCode,
      positionCode,
      managerEmployeeId,
      hireDate,
      employmentKind,
      contractEndDate,
      status: 'active',
      appUserId: link.appUserId,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: employee.id });

  // The first history row: hired, with where they start (H1).
  await history(tx, ctx, created!.id, [
    { field: 'hired', before: null, after: hireDate, effectiveFrom: hireDate, reason: link.reason },
    { field: 'branch_code', before: null, after: branchCode, effectiveFrom: hireDate },
    { field: 'department_code', before: null, after: departmentCode, effectiveFrom: hireDate },
    ...(positionCode ? [{ field: 'position_code', before: null, after: positionCode, effectiveFrom: hireDate }] : []),
    ...(managerEmployeeId ? [{ field: 'manager_employee_id', before: null, after: managerEmployeeId, effectiveFrom: hireDate }] : []),
    { field: 'employment_kind', before: null, after: employmentKind, effectiveFrom: hireDate },
    ...(contractEndDate ? [{ field: 'contract_end_date', before: null, after: contractEndDate, effectiveFrom: hireDate }] : []),
    { field: 'status', before: null, after: 'active', effectiveFrom: hireDate },
  ]);
  await recordChange(tx, ctx, {
    action: 'employee.created',
    objectType: PERMISSION_OBJECT,
    objectId: allocated.documentNo,
    branchCode,
    after: { employeeNo: allocated.documentNo, fullNameEn, departmentCode, positionCode, hireDate, employmentKind, ...(link.appUserId ? { appUserId: link.appUserId } : {}) },
    ...(link.reason ? { reason: link.reason } : {}),
  });
  return { id: created!.id, employeeNo: allocated.documentNo };
}

/** Identity corrected in place — audited, not history (§4). */
export async function updateIdentity(tx: Tx, ctx: ActorContext, id: string, input: IdentityInput): Promise<void> {
  const before = await loadById(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: before.branchCode, objectId: before.employeeNo });
  const values = {
    fullNameEn: requireText(input.fullNameEn, 'full_name_en'),
    fullNameAr: optionalText(input.fullNameAr),
    nationalId: optionalText(input.nationalId, 64),
    dateOfBirth: input.dateOfBirth ? assertDay(input.dateOfBirth, 'date_of_birth') : null,
    phone: optionalText(input.phone, 64),
    address: optionalText(input.address),
    emergencyContact: optionalText(input.emergencyContact),
  };
  await tx.update(employee).set({ ...values, updatedAt: new Date() }).where(eq(employee.id, id));
  await recordChange(tx, ctx, {
    action: 'employee.identity_updated',
    objectType: PERMISSION_OBJECT,
    objectId: before.employeeNo,
    branchCode: before.branchCode,
    before: { fullNameEn: before.fullNameEn, fullNameAr: before.fullNameAr, nationalId: before.nationalId, phone: before.phone, address: before.address },
    after: values,
  });
}

/** A move: department, position, manager or kind — each a dated history row (H1). */
export async function move(tx: Tx, ctx: ActorContext, id: string, input: MoveInput): Promise<number> {
  const before = await loadById(tx, id);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: before.branchCode, objectId: before.employeeNo });
  if (before.status === 'ended') throw new HrValidationError('status', 'has left the company; reinstate first');
  const effectiveFrom = input.effectiveFrom ? assertDay(input.effectiveFrom, 'effective_from') : businessToday();
  const reason = optionalText(input.reason);
  const rows: { field: string; before: string | null; after: string | null; effectiveFrom: string; reason: string | null }[] = [];
  const set: Partial<typeof employee.$inferInsert> = {};

  if (input.departmentCode !== undefined && input.departmentCode !== null && input.departmentCode.trim() !== '') {
    const code = await assertDepartment(tx, input.departmentCode);
    if (code !== before.departmentCode) {
      rows.push({ field: 'department_code', before: before.departmentCode, after: code, effectiveFrom, reason });
      set.departmentCode = code;
    }
  }
  if (input.positionCode !== undefined) {
    const code = await assertPosition(tx, input.positionCode);
    if (code !== before.positionCode) {
      rows.push({ field: 'position_code', before: before.positionCode, after: code, effectiveFrom, reason });
      set.positionCode = code;
    }
  }
  if (input.managerEmployeeId !== undefined) {
    const manager = await assertManager(tx, input.managerEmployeeId, id);
    if (manager !== before.managerEmployeeId) {
      rows.push({ field: 'manager_employee_id', before: before.managerEmployeeId, after: manager, effectiveFrom, reason });
      set.managerEmployeeId = manager;
    }
  }
  if (input.employmentKind !== undefined && input.employmentKind !== null && input.employmentKind !== '') {
    const kind = kindOf(input.employmentKind);
    if (kind !== before.employmentKind) {
      rows.push({ field: 'employment_kind', before: before.employmentKind, after: kind, effectiveFrom, reason });
      set.employmentKind = kind;
    }
  }
  if (input.contractEndDate !== undefined) {
    const end = input.contractEndDate && input.contractEndDate.trim() ? assertDay(input.contractEndDate.trim(), 'contract_end_date') : null;
    if (end && end < before.hireDate) throw new HrValidationError('contract_end_date', `cannot be before the hire date ${before.hireDate}`);
    if (end !== before.contractEndDate) {
      rows.push({ field: 'contract_end_date', before: before.contractEndDate, after: end, effectiveFrom, reason });
      set.contractEndDate = end;
    }
  }
  if (rows.length === 0) return 0;
  await tx.update(employee).set({ ...set, updatedAt: new Date() }).where(eq(employee.id, id));
  await history(tx, ctx, id, rows);
  await recordChange(tx, ctx, {
    action: 'employee.moved',
    objectType: PERMISSION_OBJECT,
    objectId: before.employeeNo,
    branchCode: before.branchCode,
    before: Object.fromEntries(rows.map((r) => [r.field, r.before])),
    after: Object.fromEntries(rows.map((r) => [r.field, r.after])),
    reason,
  });
  return rows.length;
}

/** Suspend, reinstate, or end — the status is a dated row too (§4). */
export async function setStatus(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { status: string; effectiveFrom?: string | null; reason?: string | null },
): Promise<void> {
  const before = await loadById(tx, id);
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: before.branchCode, objectId: before.employeeNo });
  if (!isEmployeeStatus(input.status)) throw new HrValidationError('status', 'must be active, suspended or ended');
  const status: EmployeeStatus = input.status;
  if (status === before.status) return;
  const effectiveFrom = input.effectiveFrom ? assertDay(input.effectiveFrom, 'effective_from') : businessToday();
  const reason = optionalText(input.reason);
  if (status === 'ended' && !reason) throw new HrValidationError('reason', 'say why the employment ended');
  await tx
    .update(employee)
    .set({
      status,
      endDate: status === 'ended' ? effectiveFrom : null,
      endReason: status === 'ended' ? reason : null,
      updatedAt: new Date(),
    })
    .where(eq(employee.id, id));
  await history(tx, ctx, id, [
    { field: 'status', before: before.status, after: status, effectiveFrom, reason },
    ...(status === 'ended' ? [{ field: 'ended', before: null, after: effectiveFrom, effectiveFrom, reason }] : []),
  ]);
  await recordChange(tx, ctx, {
    action: `employee.${status}`,
    objectType: PERMISSION_OBJECT,
    objectId: before.employeeNo,
    branchCode: before.branchCode,
    before: { status: before.status },
    after: { status, effectiveFrom },
    reason,
  });
}

/** The sign-in the person uses, one to one (R5). */
export async function linkUser(tx: Tx, ctx: ActorContext, id: string, appUserId: string | null): Promise<void> {
  const before = await loadById(tx, id);
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: before.branchCode, objectId: before.employeeNo });
  const target = (appUserId ?? '').trim() || null;
  if (target) {
    const [user] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, target)).limit(1);
    if (!user) throw new HrValidationError('user', 'names no user account');
    const [taken] = await tx.select({ employeeNo: employee.employeeNo }).from(employee).where(and(eq(employee.appUserId, target), sql`${employee.id} <> ${id}`)).limit(1);
    if (taken) throw new HrValidationError('user', `is already linked to ${taken.employeeNo}`);
  }
  await tx.update(employee).set({ appUserId: target, updatedAt: new Date() }).where(eq(employee.id, id));
  await recordChange(tx, ctx, {
    action: 'employee.user_linked',
    objectType: PERMISSION_OBJECT,
    objectId: before.employeeNo,
    branchCode: before.branchCode,
    before: { appUserId: before.appUserId },
    after: { appUserId: target },
  });
}

/** A new dated compensation row (R3); the history says the salary changed, not to what (R5). */
export async function setCompensation(tx: Tx, ctx: ActorContext, id: string, input: CompensationInput): Promise<void> {
  const row = await loadById(tx, id);
  await authz.authorize(ctx.principal, 'create', COMPENSATION_OBJECT, { branchCode: row.branchCode, objectId: row.employeeNo });
  const effectiveFrom = assertDay(input.effectiveFrom, 'effective_from');
  const salary = parseDecimal(input.baseSalaryIqd, MONEY_SCALE);
  if (salary < 0n) throw new HrValidationError('base_salary_iqd', 'cannot be negative');
  if (!isPayMethod(input.payMethod)) throw new HrValidationError('pay_method', 'must be bank or cash');
  const payMethod: PayMethod = input.payMethod;
  const bankCode = payMethod === 'bank' ? optionalText(input.bankCode, 32) : null;
  if (payMethod === 'bank' && !bankCode) throw new HrValidationError('bank', 'name the bank the salary is paid into');
  await tx.insert(employeeCompensation).values({
    employeeId: id,
    branchCode: row.branchCode,
    effectiveFrom,
    baseSalaryIqd: toDecimalString(salary, MONEY_SCALE),
    payMethod,
    bankCode,
    accountNumber: payMethod === 'bank' ? optionalText(input.accountNumber, 64) : null,
    iban: payMethod === 'bank' ? optionalText(input.iban, 64) : null,
    note: optionalText(input.note),
    recordedBy: ctx.principal.userId,
  });
  await history(tx, ctx, id, [{ field: 'base_salary_iqd', before: null, after: null, effectiveFrom, reason: optionalText(input.note) }]);
  await recordChange(tx, ctx, {
    action: 'employee.compensation_set',
    objectType: COMPENSATION_OBJECT,
    objectId: row.employeeNo,
    branchCode: row.branchCode,
    // The figure is in the compensation row, read under its own grant; the trail says when and by whom.
    after: { effectiveFrom, payMethod, bankCode },
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const managerName = sql<string | null>`(select m.full_name_en from employee m where m.id = ${employee.managerEmployeeId})`;
const managerNo = sql<string | null>`(select m.employee_no from employee m where m.id = ${employee.managerEmployeeId})`;

export async function list(tx: Tx) {
  return tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      branchCode: employee.branchCode,
      departmentCode: employee.departmentCode,
      departmentName: department.name,
      positionCode: employee.positionCode,
      positionTitle: position.titleEn,
      managerName,
      hireDate: employee.hireDate,
      employmentKind: employee.employmentKind,
      status: employee.status,
      phone: employee.phone,
    })
    .from(employee)
    .innerJoin(department, eq(department.code, employee.departmentCode))
    .leftJoin(position, eq(position.code, employee.positionCode))
    .orderBy(asc(employee.employeeNo));
}

export async function byNo(tx: Tx, employeeNo: string) {
  const [row] = await tx
    .select({
      id: employee.id,
      employeeNo: employee.employeeNo,
      fullNameEn: employee.fullNameEn,
      fullNameAr: employee.fullNameAr,
      nationalId: employee.nationalId,
      dateOfBirth: employee.dateOfBirth,
      phone: employee.phone,
      address: employee.address,
      emergencyContact: employee.emergencyContact,
      branchCode: employee.branchCode,
      branchName: branch.name,
      departmentCode: employee.departmentCode,
      departmentName: department.name,
      positionCode: employee.positionCode,
      positionTitle: position.titleEn,
      managerEmployeeId: employee.managerEmployeeId,
      managerName,
      managerNo,
      hireDate: employee.hireDate,
      employmentKind: employee.employmentKind,
      status: employee.status,
      endDate: employee.endDate,
      endReason: employee.endReason,
      contractEndDate: employee.contractEndDate,
      appUserId: employee.appUserId,
      userEmail: appUser.email,
      createdAt: employee.createdAt,
    })
    .from(employee)
    .innerJoin(department, eq(department.code, employee.departmentCode))
    .innerJoin(branch, eq(branch.code, employee.branchCode))
    .leftJoin(position, eq(position.code, employee.positionCode))
    .leftJoin(appUser, eq(appUser.id, employee.appUserId))
    .where(eq(employee.employeeNo, employeeNo))
    .limit(1);
  return row ?? null;
}

export async function historyOf(tx: Tx, employeeId: string) {
  return tx
    .select({
      id: employeeHistory.id,
      effectiveFrom: employeeHistory.effectiveFrom,
      field: employeeHistory.field,
      beforeValue: employeeHistory.beforeValue,
      afterValue: employeeHistory.afterValue,
      reason: employeeHistory.reason,
      recordedAt: employeeHistory.recordedAt,
      recordedBy: sql<string | null>`(select display_name from app_user u where u.id = ${employeeHistory.recordedBy})`,
    })
    .from(employeeHistory)
    .where(eq(employeeHistory.employeeId, employeeId))
    .orderBy(desc(employeeHistory.effectiveFrom), desc(employeeHistory.recordedAt));
}

/** The compensation rows — refused, and the refusal written, without the grant (H2). */
export async function compensationOf(tx: Tx, ctx: ActorContext, employeeId: string) {
  const row = await loadById(tx, employeeId);
  await authz.authorize(ctx.principal, 'view', COMPENSATION_OBJECT, { branchCode: row.branchCode, objectId: row.employeeNo });
  return tx
    .select({
      id: employeeCompensation.id,
      effectiveFrom: employeeCompensation.effectiveFrom,
      baseSalaryIqd: employeeCompensation.baseSalaryIqd,
      payMethod: employeeCompensation.payMethod,
      bankCode: employeeCompensation.bankCode,
      accountNumber: employeeCompensation.accountNumber,
      iban: employeeCompensation.iban,
      note: employeeCompensation.note,
      recordedAt: employeeCompensation.recordedAt,
      recordedBy: sql<string | null>`(select display_name from app_user u where u.id = ${employeeCompensation.recordedBy})`,
    })
    .from(employeeCompensation)
    .where(eq(employeeCompensation.employeeId, employeeId))
    .orderBy(desc(employeeCompensation.effectiveFrom), desc(employeeCompensation.recordedAt));
}

/** Active people a form can name as manager. */
export async function managersAvailable(tx: Tx) {
  return tx
    .select({ id: employee.id, employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn })
    .from(employee)
    .where(eq(employee.status, 'active'))
    .orderBy(asc(employee.employeeNo));
}

/** Sign-ins not yet linked to a person. */
export async function usersAvailable(tx: Tx) {
  return tx
    .select({ id: appUser.id, email: appUser.email, displayName: appUser.displayName })
    .from(appUser)
    .leftJoin(employee, eq(employee.appUserId, appUser.id))
    .where(and(eq(appUser.isActive, true), isNull(employee.id)))
    .orderBy(asc(appUser.displayName));
}

export interface OrganisationRow {
  readonly departmentCode: string;
  readonly departmentName: string;
  readonly headcount: number;
  readonly positions: readonly {
    readonly code: string;
    readonly titleEn: string;
    readonly titleAr: string | null;
    readonly reportsToCode: string | null;
    readonly depth: number;
    readonly holders: readonly { employeeNo: string; fullNameEn: string; status: string }[];
  }[];
  readonly unseated: readonly { employeeNo: string; fullNameEn: string; status: string }[];
}

/** The tree as it stands in the rows (§5): per department, its seats in reporting order, who holds each. */
export async function organisation(tx: Tx): Promise<readonly OrganisationRow[]> {
  const departments = await tx.select({ code: department.code, name: department.name }).from(department).orderBy(asc(department.code));
  const seats = await tx.select().from(position).where(eq(position.active, true)).orderBy(asc(position.code));
  const people = await tx
    .select({ employeeNo: employee.employeeNo, fullNameEn: employee.fullNameEn, status: employee.status, departmentCode: employee.departmentCode, positionCode: employee.positionCode })
    .from(employee)
    .where(sql`${employee.status} <> 'ended'`)
    .orderBy(asc(employee.employeeNo));

  const holders = new Map<string, { employeeNo: string; fullNameEn: string; status: string }[]>();
  for (const person of people) {
    if (!person.positionCode) continue;
    const bag = holders.get(person.positionCode) ?? [];
    bag.push({ employeeNo: person.employeeNo, fullNameEn: person.fullNameEn, status: person.status });
    holders.set(person.positionCode, bag);
  }

  // Seats in reporting order within a department: roots (no parent, or a parent in another department) first, then their reports.
  const ordered = (departmentCode: string) => {
    const mine = seats.filter((s) => s.departmentCode === departmentCode);
    const codes = new Set(mine.map((s) => s.code));
    const out: OrganisationRow['positions'][number][] = [];
    const visit = (parent: string | null, depth: number, seen: Set<string>) => {
      for (const seat of mine) {
        const parentHere = seat.reportsToCode && codes.has(seat.reportsToCode) ? seat.reportsToCode : null;
        if (parentHere !== parent || seen.has(seat.code)) continue;
        seen.add(seat.code);
        out.push({ code: seat.code, titleEn: seat.titleEn, titleAr: seat.titleAr, reportsToCode: seat.reportsToCode, depth, holders: holders.get(seat.code) ?? [] });
        if (depth < 12) visit(seat.code, depth + 1, seen);
      }
    };
    visit(null, 0, new Set());
    return out;
  };

  return departments.map((dept) => ({
    departmentCode: dept.code,
    departmentName: dept.name,
    headcount: people.filter((p) => p.departmentCode === dept.code).length,
    positions: ordered(dept.code),
    unseated: people.filter((p) => p.departmentCode === dept.code && !p.positionCode).map((p) => ({ employeeNo: p.employeeNo, fullNameEn: p.fullNameEn, status: p.status })),
  }));
}
