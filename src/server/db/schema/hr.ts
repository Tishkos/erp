/**
 * Human resources — REQ-HR-001 Stage HR-1 (2026-10-02).
 *
 *   position                the organisation's seats: a title under a
 *                           department, reporting to another seat (§5)
 *   employee                one record per person (R1), where they are now
 *   employee_history        every dated change of branch, department,
 *                           position, manager, status, kind or salary —
 *                           append-only (§4, R3)
 *   employee_compensation   the salary rows, dated, in their own table so
 *                           the grant and the policy can cover them apart
 *                           from identity (R5)
 *   pay_component, leave_type, working_calendar (+ holidays)
 *                           the configuration as master data (R4), inert
 *                           until Stages HR-2 and HR-3 use them
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { bank } from './item';
import { appUser, branch, department } from './platform';

export const position = pgTable(
  'position',
  {
    code: text('code').primaryKey(),
    titleEn: text('title_en').notNull(),
    titleAr: text('title_ar'),
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    /** The seat this one reports to; null at the top. */
    reportsToCode: text('reports_to_code'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('position_department_idx').on(t.departmentCode), check('position_not_own_parent', sql`${t.reportsToCode} is null or ${t.reportsToCode} <> ${t.code}`)],
);

export const employee = pgTable(
  'employee',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeNo: text('employee_no').notNull(),
    fullNameEn: text('full_name_en').notNull(),
    fullNameAr: text('full_name_ar'),
    nationalId: text('national_id'),
    dateOfBirth: date('date_of_birth'),
    phone: text('phone'),
    address: text('address'),
    emergencyContact: text('emergency_contact'),

    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    positionCode: text('position_code').references(() => position.code),
    managerEmployeeId: uuid('manager_employee_id'),
    hireDate: date('hire_date').notNull(),
    employmentKind: text('employment_kind').notNull().default('permanent'),
    status: text('status').notNull().default('active'),
    endDate: date('end_date'),
    endReason: text('end_reason'),

    /** The user account the person signs in with, when they have one (R5). */
    appUserId: uuid('app_user_id').references(() => appUser.id),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('employee_no_uniq').on(t.employeeNo),
    uniqueIndex('employee_app_user_uniq').on(t.appUserId).where(sql`${t.appUserId} is not null`),
    index('employee_branch_idx').on(t.branchCode, t.status),
    index('employee_department_idx').on(t.departmentCode),
    index('employee_manager_idx').on(t.managerEmployeeId),
    check('employee_kind', sql`${t.employmentKind} in ('permanent', 'contract', 'daily')`),
    check('employee_status', sql`${t.status} in ('active', 'suspended', 'ended')`),
    check('employee_ended_has_date', sql`(${t.status} = 'ended') = (${t.endDate} is not null)`),
    check('employee_not_own_manager', sql`${t.managerEmployeeId} is null or ${t.managerEmployeeId} <> ${t.id}`),
  ],
);

export const employeeHistory = pgTable(
  'employee_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    /** The day the change takes effect — the question "who was their manager in March" is asked of this. */
    effectiveFrom: date('effective_from').notNull(),
    field: text('field').notNull(),
    beforeValue: text('before_value'),
    afterValue: text('after_value'),
    reason: text('reason'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('employee_history_employee_idx').on(t.employeeId, t.effectiveFrom, t.recordedAt)],
);

export const employeeCompensation = pgTable(
  'employee_compensation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    /** Carried so the policy can scope by branch without a join the policy may not make. */
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    effectiveFrom: date('effective_from').notNull(),
    baseSalaryIqd: numeric('base_salary_iqd', { precision: 20, scale: 4 }).notNull(),
    payMethod: text('pay_method').notNull().default('bank'),
    bankCode: text('bank_code').references(() => bank.code),
    accountNumber: text('account_number'),
    iban: text('iban'),
    note: text('note'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('employee_compensation_employee_idx').on(t.employeeId, t.effectiveFrom),
    check('employee_compensation_salary_not_negative', sql`${t.baseSalaryIqd} >= 0`),
    check('employee_compensation_method', sql`${t.payMethod} in ('bank', 'cash')`),
  ],
);

export const payComponent = pgTable(
  'pay_component',
  {
    code: text('code').primaryKey(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    kind: text('kind').notNull(),
    calculation: text('calculation').notNull(),
    /** A fixed amount in IQD, or a percentage of the base, by `calculation`. */
    defaultValue: numeric('default_value', { precision: 20, scale: 4 }).notNull().default('0'),
    taxable: boolean('taxable').notNull().default(true),
    active: boolean('active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(100),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pay_component_kind', sql`${t.kind} in ('earning', 'deduction', 'employer_cost')`),
    check('pay_component_calculation', sql`${t.calculation} in ('fixed', 'percent_of_base', 'manual')`),
  ],
);

export const leaveType = pgTable(
  'leave_type',
  {
    code: text('code').primaryKey(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    daysPerYear: numeric('days_per_year', { precision: 6, scale: 2 }).notNull().default('0'),
    carryOverDays: numeric('carry_over_days', { precision: 6, scale: 2 }).notNull().default('0'),
    paid: boolean('paid').notNull().default(true),
    requiresAttachment: boolean('requires_attachment').notNull().default(false),
    /** D-HR-6 — how far below zero a balance may go; 0 refuses. */
    allowedNegativeDays: numeric('allowed_negative_days', { precision: 6, scale: 2 }).notNull().default('0'),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('leave_type_days', sql`${t.daysPerYear} >= 0 and ${t.carryOverDays} >= 0 and ${t.allowedNegativeDays} >= 0`)],
);

export const workingCalendar = pgTable(
  'working_calendar',
  {
    code: text('code').primaryKey(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    year: integer('year').notNull(),
    /** "mon,tue,wed,thu,sat" */
    workingDays: text('working_days').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('working_calendar_year', sql`${t.year} between 2000 and 2100`)],
);

export const workingCalendarHoliday = pgTable(
  'working_calendar_holiday',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    calendarCode: text('calendar_code')
      .notNull()
      .references(() => workingCalendar.code),
    holidayDate: date('holiday_date').notNull(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
  },
  (t) => [uniqueIndex('working_calendar_holiday_uniq').on(t.calendarCode, t.holidayDate)],
);
