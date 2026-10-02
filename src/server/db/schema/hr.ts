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
 *                           the configuration as master data (R4)
 *
 * Stage HR-2 (0256) — time:
 *   leave_request           LVE-…: counted on the working calendar, decided by
 *                           the person's manager or the HR manager
 *   leave_balance_entry     an opening balance or an adjustment — append-only;
 *                           entitlement and carry-over derive (R2)
 *   attendance_day          what the day sheet recorded: present or absent
 *   hr_parameter            the sweep's limits as rows (R4)
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgTable, smallint, text, time, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
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
    /** HR-2 (0256) — when a contract or daily engagement ends; the sweep warns ahead of it. */
    contractEndDate: date('contract_end_date'),

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
    check('employee_contract_end_after_hire', sql`${t.contractEndDate} is null or ${t.contractEndDate} >= ${t.hireDate}`),
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
    /** HR-2 (0256) — the year-end sweep warns when unused days of this type will not carry. */
    warnBeforeLapse: boolean('warn_before_lapse').notNull().default(false),
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

// ---------------------------------------------------------------------------
// Stage HR-2 — time (0256)
// ---------------------------------------------------------------------------

export const leaveRequest = pgTable(
  'leave_request',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestNo: text('request_no').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    leaveTypeCode: text('leave_type_code')
      .notNull()
      .references(() => leaveType.code),
    fromDate: date('from_date').notNull(),
    toDate: date('to_date').notNull(),
    halfDayStart: boolean('half_day_start').notNull().default(false),
    halfDayEnd: boolean('half_day_end').notNull().default(false),
    days: numeric('days', { precision: 6, scale: 2 }).notNull().default('0'),
    reason: text('reason'),
    status: text('status').notNull().default('draft'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => appUser.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => appUser.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('leave_request_no_uniq').on(t.requestNo),
    index('leave_request_employee_idx').on(t.employeeId, t.fromDate),
    index('leave_request_status_idx').on(t.status, t.branchCode),
    check('leave_request_status', sql`${t.status} in ('draft', 'submitted', 'approved', 'refused', 'cancelled')`),
    check('leave_request_span', sql`${t.toDate} >= ${t.fromDate}`),
    check('leave_request_days', sql`${t.days} >= 0`),
    check('leave_request_refusal_has_note', sql`${t.status} <> 'refused' or nullif(btrim(${t.decisionNote}), '') is not null`),
    check('leave_request_cancel_has_reason', sql`${t.status} <> 'cancelled' or nullif(btrim(${t.cancelReason}), '') is not null`),
    check('leave_request_decider_not_requester', sql`${t.decidedBy} is null or ${t.decidedBy} <> ${t.requestedBy}`),
  ],
);

export const leaveBalanceEntry = pgTable(
  'leave_balance_entry',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    leaveTypeCode: text('leave_type_code')
      .notNull()
      .references(() => leaveType.code),
    year: integer('year').notNull(),
    days: numeric('days', { precision: 6, scale: 2 }).notNull(),
    kind: text('kind').notNull(),
    reason: text('reason').notNull(),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('leave_balance_entry_employee_idx').on(t.employeeId, t.leaveTypeCode, t.year),
    check('leave_balance_entry_kind', sql`${t.kind} in ('opening', 'adjustment')`),
    check('leave_balance_entry_reason', sql`nullif(btrim(${t.reason}), '') is not null`),
    check('leave_balance_entry_not_zero', sql`${t.days} <> 0`),
  ],
);

export const attendanceDay = pgTable(
  'attendance_day',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    day: date('day').notNull(),
    status: text('status').notNull(),
    checkIn: time('check_in'),
    checkOut: time('check_out'),
    note: text('note'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('attendance_day_employee_day_uniq').on(t.employeeId, t.day),
    index('attendance_day_branch_day_idx').on(t.branchCode, t.day),
    check('attendance_day_status', sql`${t.status} in ('present', 'absent')`),
    check('attendance_day_times', sql`${t.checkIn} is null or ${t.checkOut} is null or ${t.checkOut} >= ${t.checkIn}`),
    check('attendance_day_absent_has_no_times', sql`${t.status} <> 'absent' or (${t.checkIn} is null and ${t.checkOut} is null)`),
  ],
);

export const hrParameter = pgTable(
  'hr_parameter',
  {
    key: text('key').primaryKey(),
    value: integer('value').notNull(),
    updatedBy: uuid('updated_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('hr_parameter_value', sql`${t.value} >= 0 and ${t.value} <= 366`)],
);
