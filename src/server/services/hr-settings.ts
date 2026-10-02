/**
 * HR settings — REQ-HR-001 §5, §6, §7 (R4: configuration is master data).
 *
 * Positions, pay components, leave types and working calendars are rows an
 * HR manager edits on one settings screen. Rows are never deleted, only
 * deactivated: a position somebody held, a component a payslip carried, a
 * leave type a request named — each stays, so history keeps its meaning.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { department, leaveType, payComponent, position, workingCalendar, workingCalendarHoliday } from '../db/schema';
import { HrValidationError, assertDay, assertWorkingDays, isPayCalculation, isPayComponentKind } from '../domain/hr';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { AdminNotFoundError, normaliseCode, optionalText, permit, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';

export const PERMISSION_OBJECT = 'hr_setting';

// ---------------------------------------------------------------------------
// Positions (§5)
// ---------------------------------------------------------------------------

export interface PositionInput {
  readonly code: string;
  readonly titleEn: string;
  readonly titleAr?: string | null;
  readonly departmentCode: string;
  readonly reportsToCode?: string | null;
}

export async function createPosition(tx: Tx, ctx: ActorContext, input: PositionInput): Promise<{ code: string }> {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const titleEn = requireText(input.titleEn, 'title_en');
  const departmentCode = normaliseCode(input.departmentCode, 'department');
  const [dept] = await tx.select({ code: department.code }).from(department).where(eq(department.code, departmentCode)).limit(1);
  if (!dept) throw new HrValidationError('department', `names no department '${departmentCode}'`);
  const reportsToCode = await assertReportsTo(tx, input.reportsToCode, code);
  const [existing] = await tx.select({ code: position.code }).from(position).where(eq(position.code, code)).limit(1);
  if (existing) throw new HrValidationError('code', `'${code}' is already a position`);
  await tx.insert(position).values({ code, titleEn, titleAr: optionalText(input.titleAr), departmentCode, reportsToCode, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'position.created', objectType: 'position', objectId: code, after: { code, titleEn, departmentCode, reportsToCode } });
  return { code };
}

async function assertReportsTo(tx: Tx, value: string | null | undefined, self: string): Promise<string | null> {
  const text = (value ?? '').trim();
  if (!text) return null;
  const code = normaliseCode(text, 'reports_to');
  if (code === self) throw new HrValidationError('reports_to', 'a position cannot report to itself');
  const [row] = await tx.select({ code: position.code }).from(position).where(eq(position.code, code)).limit(1);
  if (!row) throw new HrValidationError('reports_to', `names no position '${code}'`);
  return code;
}

export async function updatePosition(tx: Tx, ctx: ActorContext, code: string, input: Omit<PositionInput, 'code'>): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select().from(position).where(eq(position.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('position', code);
  const departmentCode = normaliseCode(input.departmentCode, 'department');
  const reportsToCode = await assertReportsTo(tx, input.reportsToCode, code);
  const values = { titleEn: requireText(input.titleEn, 'title_en'), titleAr: optionalText(input.titleAr), departmentCode, reportsToCode };
  await tx.update(position).set({ ...values, updatedAt: new Date() }).where(eq(position.code, code));
  await recordChange(tx, ctx, { action: 'position.updated', objectType: 'position', objectId: code, before: { titleEn: before.titleEn, departmentCode: before.departmentCode, reportsToCode: before.reportsToCode }, after: values });
}

export async function setPositionActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select({ active: position.active }).from(position).where(eq(position.code, code)).limit(1);
  if (!active && !optionalText(reason)) throw new HrValidationError('reason', 'say why it is deactivated');
  if (!before) throw new AdminNotFoundError('position', code);
  await tx.update(position).set({ active, updatedAt: new Date() }).where(eq(position.code, code));
  await recordChange(tx, ctx, { action: active ? 'position.activated' : 'position.deactivated', objectType: 'position', objectId: code, before: { active: before.active }, after: { active }, reason: optionalText(reason) });
}

export async function positions(tx: Tx) {
  return tx
    .select({
      code: position.code,
      titleEn: position.titleEn,
      titleAr: position.titleAr,
      departmentCode: position.departmentCode,
      departmentName: department.name,
      reportsToCode: position.reportsToCode,
      active: position.active,
    })
    .from(position)
    .innerJoin(department, eq(department.code, position.departmentCode))
    .orderBy(asc(position.departmentCode), asc(position.code));
}

// ---------------------------------------------------------------------------
// Pay components (§6)
// ---------------------------------------------------------------------------

export interface PayComponentInput {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr?: string | null;
  readonly kind: string;
  readonly calculation: string;
  readonly defaultValue?: string | null;
  readonly taxable: boolean;
}

function componentValues(input: Omit<PayComponentInput, 'code'>) {
  if (!isPayComponentKind(input.kind)) throw new HrValidationError('kind', 'must be earning, deduction or employer_cost');
  if (!isPayCalculation(input.calculation)) throw new HrValidationError('calculation', 'must be fixed, percent_of_base or manual');
  const value = parseDecimal((input.defaultValue ?? '').trim() || '0', MONEY_SCALE);
  if (value < 0n) throw new HrValidationError('default_value', 'cannot be negative');
  if (input.calculation === 'percent_of_base' && value > 100n * 10n ** MONEY_SCALE) throw new HrValidationError('default_value', 'a percentage of the base cannot exceed 100');
  return {
    nameEn: requireText(input.nameEn, 'name_en'),
    nameAr: optionalText(input.nameAr),
    kind: input.kind,
    calculation: input.calculation,
    defaultValue: toDecimalString(value, MONEY_SCALE),
    taxable: input.taxable,
  };
}

export async function createPayComponent(tx: Tx, ctx: ActorContext, input: PayComponentInput): Promise<{ code: string }> {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const [existing] = await tx.select({ code: payComponent.code }).from(payComponent).where(eq(payComponent.code, code)).limit(1);
  if (existing) throw new HrValidationError('code', `'${code}' is already a pay component`);
  const values = componentValues(input);
  await tx.insert(payComponent).values({ code, ...values, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'pay_component.created', objectType: 'pay_component', objectId: code, after: { code, ...values } });
  return { code };
}

export async function updatePayComponent(tx: Tx, ctx: ActorContext, code: string, input: Omit<PayComponentInput, 'code'>): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select().from(payComponent).where(eq(payComponent.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('pay_component', code);
  const values = componentValues(input);
  await tx.update(payComponent).set({ ...values, updatedAt: new Date() }).where(eq(payComponent.code, code));
  await recordChange(tx, ctx, { action: 'pay_component.updated', objectType: 'pay_component', objectId: code, before: { nameEn: before.nameEn, kind: before.kind, calculation: before.calculation, defaultValue: before.defaultValue, taxable: before.taxable }, after: values });
}

export async function setPayComponentActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select({ active: payComponent.active }).from(payComponent).where(eq(payComponent.code, code)).limit(1);
  if (!active && !optionalText(reason)) throw new HrValidationError('reason', 'say why it is deactivated');
  if (!before) throw new AdminNotFoundError('pay_component', code);
  await tx.update(payComponent).set({ active, updatedAt: new Date() }).where(eq(payComponent.code, code));
  await recordChange(tx, ctx, { action: active ? 'pay_component.activated' : 'pay_component.deactivated', objectType: 'pay_component', objectId: code, before: { active: before.active }, after: { active }, reason: optionalText(reason) });
}

export async function payComponents(tx: Tx) {
  return tx.select().from(payComponent).orderBy(asc(payComponent.sortOrder), asc(payComponent.code));
}

// ---------------------------------------------------------------------------
// Leave types (§7)
// ---------------------------------------------------------------------------

export interface LeaveTypeInput {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr?: string | null;
  readonly daysPerYear: string;
  readonly carryOverDays?: string | null;
  readonly paid: boolean;
  readonly requiresAttachment: boolean;
  readonly allowedNegativeDays?: string | null;
}

const days = (value: string | null | undefined, field: string): string => {
  const text = (value ?? '').trim() || '0';
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(text)) throw new HrValidationError(field, 'must be a number of days, up to two decimals');
  return text;
};

function leaveValues(input: Omit<LeaveTypeInput, 'code'>) {
  return {
    nameEn: requireText(input.nameEn, 'name_en'),
    nameAr: optionalText(input.nameAr),
    daysPerYear: days(input.daysPerYear, 'days_per_year'),
    carryOverDays: days(input.carryOverDays, 'carry_over_days'),
    paid: input.paid,
    requiresAttachment: input.requiresAttachment,
    allowedNegativeDays: days(input.allowedNegativeDays, 'allowed_negative_days'),
  };
}

export async function createLeaveType(tx: Tx, ctx: ActorContext, input: LeaveTypeInput): Promise<{ code: string }> {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const [existing] = await tx.select({ code: leaveType.code }).from(leaveType).where(eq(leaveType.code, code)).limit(1);
  if (existing) throw new HrValidationError('code', `'${code}' is already a leave type`);
  const values = leaveValues(input);
  await tx.insert(leaveType).values({ code, ...values, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'leave_type.created', objectType: 'leave_type', objectId: code, after: { code, ...values } });
  return { code };
}

export async function updateLeaveType(tx: Tx, ctx: ActorContext, code: string, input: Omit<LeaveTypeInput, 'code'>): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select().from(leaveType).where(eq(leaveType.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('leave_type', code);
  const values = leaveValues(input);
  await tx.update(leaveType).set({ ...values, updatedAt: new Date() }).where(eq(leaveType.code, code));
  await recordChange(tx, ctx, { action: 'leave_type.updated', objectType: 'leave_type', objectId: code, before: { nameEn: before.nameEn, daysPerYear: before.daysPerYear, carryOverDays: before.carryOverDays, paid: before.paid }, after: values });
}

export async function setLeaveTypeActive(tx: Tx, ctx: ActorContext, code: string, active: boolean, reason?: string | null): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select({ active: leaveType.active }).from(leaveType).where(eq(leaveType.code, code)).limit(1);
  if (!active && !optionalText(reason)) throw new HrValidationError('reason', 'say why it is deactivated');
  if (!before) throw new AdminNotFoundError('leave_type', code);
  await tx.update(leaveType).set({ active, updatedAt: new Date() }).where(eq(leaveType.code, code));
  await recordChange(tx, ctx, { action: active ? 'leave_type.activated' : 'leave_type.deactivated', objectType: 'leave_type', objectId: code, before: { active: before.active }, after: { active }, reason: optionalText(reason) });
}

export async function leaveTypes(tx: Tx) {
  return tx.select().from(leaveType).orderBy(asc(leaveType.code));
}

// ---------------------------------------------------------------------------
// Working calendars (§7)
// ---------------------------------------------------------------------------

export interface CalendarInput {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr?: string | null;
  readonly year: string;
  readonly workingDays: string;
}

function yearOf(value: string): number {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HrValidationError('year', 'must be a year between 2000 and 2100');
  return year;
}

export async function createCalendar(tx: Tx, ctx: ActorContext, input: CalendarInput): Promise<{ code: string }> {
  await permit(ctx, 'configure', PERMISSION_OBJECT);
  const code = normaliseCode(input.code, 'code');
  const [existing] = await tx.select({ code: workingCalendar.code }).from(workingCalendar).where(eq(workingCalendar.code, code)).limit(1);
  if (existing) throw new HrValidationError('code', `'${code}' is already a calendar`);
  const values = { nameEn: requireText(input.nameEn, 'name_en'), nameAr: optionalText(input.nameAr), year: yearOf(input.year), workingDays: assertWorkingDays(input.workingDays) };
  await tx.insert(workingCalendar).values({ code, ...values, createdBy: ctx.principal.userId });
  await recordChange(tx, ctx, { action: 'working_calendar.created', objectType: 'working_calendar', objectId: code, after: { code, ...values } });
  return { code };
}

export async function updateCalendar(tx: Tx, ctx: ActorContext, code: string, input: Omit<CalendarInput, 'code' | 'year'>): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const [before] = await tx.select().from(workingCalendar).where(eq(workingCalendar.code, code)).limit(1);
  if (!before) throw new AdminNotFoundError('working_calendar', code);
  const values = { nameEn: requireText(input.nameEn, 'name_en'), nameAr: optionalText(input.nameAr), workingDays: assertWorkingDays(input.workingDays) };
  await tx.update(workingCalendar).set({ ...values, updatedAt: new Date() }).where(eq(workingCalendar.code, code));
  await recordChange(tx, ctx, { action: 'working_calendar.updated', objectType: 'working_calendar', objectId: code, before: { nameEn: before.nameEn, workingDays: before.workingDays }, after: values });
}

export async function addHoliday(tx: Tx, ctx: ActorContext, calendarCode: string, input: { holidayDate: string; nameEn: string; nameAr?: string | null }): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, calendarCode);
  const [calendar] = await tx.select({ code: workingCalendar.code, year: workingCalendar.year }).from(workingCalendar).where(eq(workingCalendar.code, calendarCode)).limit(1);
  if (!calendar) throw new AdminNotFoundError('working_calendar', calendarCode);
  const holidayDate = assertDay(input.holidayDate, 'holiday_date');
  if (Number(holidayDate.slice(0, 4)) !== calendar.year) throw new HrValidationError('holiday_date', `must fall in ${calendar.year}`);
  const [existing] = await tx.select({ id: workingCalendarHoliday.id }).from(workingCalendarHoliday).where(and(eq(workingCalendarHoliday.calendarCode, calendarCode), eq(workingCalendarHoliday.holidayDate, holidayDate))).limit(1);
  if (existing) throw new HrValidationError('holiday_date', 'is already a holiday on this calendar');
  await tx.insert(workingCalendarHoliday).values({ calendarCode, holidayDate, nameEn: requireText(input.nameEn, 'name_en'), nameAr: optionalText(input.nameAr) });
  await recordChange(tx, ctx, { action: 'working_calendar.holiday_added', objectType: 'working_calendar', objectId: calendarCode, after: { holidayDate, nameEn: input.nameEn } });
}

export async function removeHoliday(tx: Tx, ctx: ActorContext, calendarCode: string, holidayDate: string): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, calendarCode);
  const [existing] = await tx.select({ id: workingCalendarHoliday.id, nameEn: workingCalendarHoliday.nameEn }).from(workingCalendarHoliday).where(and(eq(workingCalendarHoliday.calendarCode, calendarCode), eq(workingCalendarHoliday.holidayDate, holidayDate))).limit(1);
  if (!existing) throw new AdminNotFoundError('holiday', holidayDate);
  await tx.delete(workingCalendarHoliday).where(eq(workingCalendarHoliday.id, existing.id));
  await recordChange(tx, ctx, { action: 'working_calendar.holiday_removed', objectType: 'working_calendar', objectId: calendarCode, before: { holidayDate, nameEn: existing.nameEn } });
}

export async function calendars(tx: Tx) {
  const rows = await tx.select().from(workingCalendar).orderBy(asc(workingCalendar.year), asc(workingCalendar.code));
  const holidays = await tx.select().from(workingCalendarHoliday).orderBy(asc(workingCalendarHoliday.holidayDate));
  return rows.map((row) => ({ ...row, holidays: holidays.filter((h) => h.calendarCode === row.code) }));
}
