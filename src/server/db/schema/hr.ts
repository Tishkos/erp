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
 * Stage HR-2 (0261) — time:
 *   leave_request           LVE-…: counted on the working calendar, decided by
 *                           the person's manager or the HR manager
 *   leave_balance_entry     an opening balance or an adjustment — append-only;
 *                           entitlement and carry-over derive (R2)
 *   attendance_day          what the day sheet recorded: present or absent
 *   hr_parameter            the sweep's limits as rows (R4)
 *
 * Stage HR-3 (0262) — payroll:
 *   employee_pay_component  a person's own figure for a component, or its stop —
 *                           dated, append-only, under the compensation grant
 *   payroll_run             PAY-…: one live run per branch per month
 *   payroll_line            one person's month, its payslip once posted
 *   payroll_line_component  each component of the line, computed or typed
 *   payroll_payment         one pay method's net pay leaving a bank or cash account
 *
 * Stage HR-4 (0263) — advances & loans, equipment:
 *   employee_advance           EADV-…: money lent, recovered from pay or cash
 *   employee_advance_recovery  what came back — append-only
 *   employee_asset             what a person holds, handed out and returned
 *
 * Stage HR-5 (0264) — recruitment & performance:
 *   vacancy             VAC-…: a position to fill, how many, from when
 *   applicant           APL-…: who applied, the stage they are at; hired, an employee
 *   applicant_stage     every move of an applicant — append-only
 *   review_cycle        a period people are reviewed for (master data)
 *   performance_review  REV-…: one person, one cycle, their reviewer; rated, signed off
 *   review_goal         the review's goals: weight, target, rating
 */
import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, numeric, pgTable, smallint, text, time, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { chartOfAccount } from './accounting';
import { fixedAsset } from './fixed-assets';
import { bank, bankCashAccount } from './item';
import { journalEntry } from './journal';
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
    /** HR-2 (0261) — when a contract or daily engagement ends; the sweep warns ahead of it. */
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
    /** HR-3 (0262) — where an earning or an employer cost is expensed; empty, the posting mapping decides. */
    expenseAccountId: uuid('expense_account_id').references(() => chartOfAccount.id),
    /** HR-3 (0262) — where a deduction or an employer cost is owed; empty, the posting mapping decides. */
    liabilityAccountId: uuid('liability_account_id').references(() => chartOfAccount.id),
    active: boolean('active').notNull().default(true),
    sortOrder: smallint('sort_order').notNull().default(100),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('pay_component_kind', sql`${t.kind} in ('earning', 'deduction', 'employer_cost')`),
    check('pay_component_calculation', sql`${t.calculation} in ('base_salary', 'fixed', 'percent_of_base', 'manual', 'absence', 'advance_recovery')`),
    check('pay_component_calculation_kind', sql`(${t.calculation} <> 'base_salary' or ${t.kind} = 'earning') and (${t.calculation} not in ('absence', 'advance_recovery') or ${t.kind} = 'deduction')`),
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
    /** HR-2 (0261) — the year-end sweep warns when unused days of this type will not carry. */
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
// Stage HR-2 — time (0261)
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

// ---------------------------------------------------------------------------
// Stage HR-3 (0262) — payroll
// ---------------------------------------------------------------------------

export const employeePayComponent = pgTable(
  'employee_pay_component',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    componentCode: text('component_code')
      .notNull()
      .references(() => payComponent.code),
    effectiveFrom: date('effective_from').notNull(),
    /** IQD a month for a fixed component, a percentage for a percent one; null with a stop. */
    amount: numeric('amount', { precision: 20, scale: 4 }),
    stopped: boolean('stopped').notNull().default(false),
    note: text('note'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('employee_pay_component_idx').on(t.employeeId, t.componentCode, t.effectiveFrom),
    check('employee_pay_component_amount_or_stop', sql`${t.stopped} = (${t.amount} is null)`),
    check('employee_pay_component_not_negative', sql`${t.amount} is null or ${t.amount} >= 0`),
  ],
);

export const payrollRun = pgTable(
  'payroll_run',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runNo: text('run_no').notNull(),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    periodMonth: date('period_month').notNull(),
    periodEnd: date('period_end').notNull(),
    payDate: date('pay_date').notNull(),
    status: text('status').notNull().default('draft'),
    workingDays: smallint('working_days').notNull(),
    employees: integer('employees').notNull().default(0),
    grossIqd: numeric('gross_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    deductionsIqd: numeric('deductions_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    netIqd: numeric('net_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    employerCostIqd: numeric('employer_cost_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    paidIqd: numeric('paid_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    note: text('note'),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedBy: uuid('submitted_by').references(() => appUser.id),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    returnedBy: uuid('returned_by').references(() => appUser.id),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
    returnNote: text('return_note'),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedBy: uuid('posted_by').references(() => appUser.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    reversedBy: uuid('reversed_by').references(() => appUser.id),
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversalReason: text('reversal_reason'),
    reversalJournalEntryId: uuid('reversal_journal_entry_id').references(() => journalEntry.id),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('payroll_run_no_uniq').on(t.runNo),
    uniqueIndex('payroll_run_live_uniq').on(t.branchCode, t.periodMonth).where(sql`${t.status} not in ('reversed', 'cancelled')`),
    index('payroll_run_status_idx').on(t.status, t.branchCode),
    check('payroll_run_status', sql`${t.status} in ('draft', 'submitted', 'approved', 'posted', 'paid', 'reversed', 'cancelled')`),
    check('payroll_run_approver_not_preparer', sql`${t.approvedBy} is null or (${t.approvedBy} <> ${t.createdBy} and ${t.approvedBy} is distinct from ${t.submittedBy})`),
  ],
);

export const payrollPayment = pgTable(
  'payroll_payment',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRun.id),
    payMethod: text('pay_method').notNull(),
    bankCashAccountId: uuid('bank_cash_account_id')
      .notNull()
      .references(() => bankCashAccount.id),
    paidOn: date('paid_on').notNull(),
    reference: text('reference'),
    amountIqd: numeric('amount_iqd', { precision: 20, scale: 4 }).notNull(),
    lines: integer('lines').notNull(),
    journalEntryId: uuid('journal_entry_id')
      .notNull()
      .references(() => journalEntry.id),
    paidBy: uuid('paid_by')
      .notNull()
      .references(() => appUser.id),
    paidAt: timestamp('paid_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('payroll_payment_run_method_uniq').on(t.runId, t.payMethod), check('payroll_payment_method', sql`${t.payMethod} in ('bank', 'cash')`)],
);

export const payrollLine = pgTable(
  'payroll_line',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => payrollRun.id),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    employeeNo: text('employee_no').notNull(),
    fullNameEn: text('full_name_en').notNull(),
    fullNameAr: text('full_name_ar'),
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    positionTitle: text('position_title'),
    compensationId: uuid('compensation_id').references(() => employeeCompensation.id),
    payMethod: text('pay_method').notNull().default('bank'),
    bankCode: text('bank_code'),
    accountNumber: text('account_number'),
    iban: text('iban'),
    workingDays: smallint('working_days').notNull(),
    employedDays: smallint('employed_days').notNull(),
    presentDays: smallint('present_days').notNull().default(0),
    absentDays: smallint('absent_days').notNull().default(0),
    unrecordedDays: smallint('unrecorded_days').notNull().default(0),
    paidLeaveDays: numeric('paid_leave_days', { precision: 6, scale: 2 }).notNull().default('0'),
    unpaidLeaveDays: numeric('unpaid_leave_days', { precision: 6, scale: 2 }).notNull().default('0'),
    baseSalaryIqd: numeric('base_salary_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    grossIqd: numeric('gross_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    deductionsIqd: numeric('deductions_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    netIqd: numeric('net_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    employerCostIqd: numeric('employer_cost_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    payslipNo: text('payslip_no'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    paymentId: uuid('payment_id').references(() => payrollPayment.id),
  },
  (t) => [
    uniqueIndex('payroll_line_run_employee_uniq').on(t.runId, t.employeeId),
    uniqueIndex('payroll_line_payslip_uniq').on(t.payslipNo).where(sql`${t.payslipNo} is not null`),
    index('payroll_line_employee_idx').on(t.employeeId),
    check('payroll_line_method', sql`${t.payMethod} in ('bank', 'cash')`),
  ],
);

export const payrollLineComponent = pgTable(
  'payroll_line_component',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    lineId: uuid('line_id')
      .notNull()
      .references(() => payrollLine.id),
    componentCode: text('component_code')
      .notNull()
      .references(() => payComponent.code),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    kind: text('kind').notNull(),
    calculation: text('calculation').notNull(),
    /** The percentage a percent component applied. */
    rate: numeric('rate', { precision: 9, scale: 4 }),
    /** The days (hundredths as a decimal) a base or an absence counted. */
    quantity: numeric('quantity', { precision: 8, scale: 2 }),
    amountIqd: numeric('amount_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    note: text('note'),
    sortOrder: smallint('sort_order').notNull().default(100),
  },
  (t) => [uniqueIndex('payroll_line_component_uniq').on(t.lineId, t.componentCode)],
);

// ---------------------------------------------------------------------------
// Stage HR-4 (0263) — advances & loans, equipment
// ---------------------------------------------------------------------------

export const employeeAdvance = pgTable(
  'employee_advance',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advanceNo: text('advance_no').notNull(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    kind: text('kind').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 20, scale: 4 }).notNull(),
    instalments: smallint('instalments').notNull().default(1),
    firstRecoveryMonth: date('first_recovery_month').notNull(),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('draft'),
    recoveredIqd: numeric('recovered_iqd', { precision: 20, scale: 4 }).notNull().default('0'),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    endorsedBy: uuid('endorsed_by').references(() => appUser.id),
    endorsedAt: timestamp('endorsed_at', { withTimezone: true }),
    approvedBy: uuid('approved_by').references(() => appUser.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    refusedBy: uuid('refused_by').references(() => appUser.id),
    refusedAt: timestamp('refused_at', { withTimezone: true }),
    paidBy: uuid('paid_by').references(() => appUser.id),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    paidOn: date('paid_on'),
    bankCashAccountId: uuid('bank_cash_account_id').references(() => bankCashAccount.id),
    paymentReference: text('payment_reference'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('employee_advance_no_uniq').on(t.advanceNo),
    index('employee_advance_employee_idx').on(t.employeeId, t.status),
    index('employee_advance_status_idx').on(t.status, t.branchCode),
    check('employee_advance_kind', sql`${t.kind} in ('advance', 'loan')`),
    check('employee_advance_endorser_not_requester', sql`${t.endorsedBy} is null or ${t.endorsedBy} <> ${t.requestedBy}`),
  ],
);

export const employeeAdvanceRecovery = pgTable(
  'employee_advance_recovery',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    advanceId: uuid('advance_id')
      .notNull()
      .references(() => employeeAdvance.id),
    source: text('source').notNull(),
    month: date('month').notNull(),
    amountIqd: numeric('amount_iqd', { precision: 20, scale: 4 }).notNull(),
    runId: uuid('run_id').references(() => payrollRun.id),
    lineId: uuid('line_id').references(() => payrollLine.id),
    bankCashAccountId: uuid('bank_cash_account_id').references(() => bankCashAccount.id),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntry.id),
    reference: text('reference'),
    recordedBy: uuid('recorded_by')
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('employee_advance_recovery_advance_idx').on(t.advanceId, t.month), index('employee_advance_recovery_run_idx').on(t.runId)],
);

export const employeeAsset = pgTable(
  'employee_asset',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    assetKind: text('asset_kind').notNull(),
    fixedAssetId: uuid('fixed_asset_id').references(() => fixedAsset.id),
    description: text('description').notNull(),
    serialNo: text('serial_no'),
    handedOutOn: date('handed_out_on').notNull(),
    outCondition: text('out_condition'),
    handedOutBy: uuid('handed_out_by')
      .notNull()
      .references(() => appUser.id),
    returnedOn: date('returned_on'),
    returnCondition: text('return_condition'),
    returnedBy: uuid('returned_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('employee_asset_employee_idx').on(t.employeeId, t.returnedOn), check('employee_asset_kind', sql`${t.assetKind} in ('fixed_asset', 'item')`)],
);

export const vacancy = pgTable(
  'vacancy',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    vacancyNo: text('vacancy_no').notNull(),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    positionCode: text('position_code')
      .notNull()
      .references(() => position.code),
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    headcount: smallint('headcount').notNull().default(1),
    hired: smallint('hired').notNull().default(0),
    employmentKind: text('employment_kind').notNull().default('permanent'),
    opensOn: date('opens_on').notNull(),
    closesOn: date('closes_on'),
    description: text('description').notNull(),
    status: text('status').notNull().default('draft'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    openedBy: uuid('opened_by').references(() => appUser.id),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    closedBy: uuid('closed_by').references(() => appUser.id),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeReason: text('close_reason'),
  },
  (t) => [
    uniqueIndex('vacancy_no_uniq').on(t.vacancyNo),
    index('vacancy_status_idx').on(t.status, t.branchCode),
    check('vacancy_status', sql`${t.status} in ('draft', 'open', 'filled', 'closed', 'cancelled')`),
    check('vacancy_kind', sql`${t.employmentKind} in ('permanent', 'contract', 'daily')`),
  ],
);

export const applicant = pgTable(
  'applicant',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicantNo: text('applicant_no').notNull(),
    vacancyId: uuid('vacancy_id')
      .notNull()
      .references(() => vacancy.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    fullNameEn: text('full_name_en').notNull(),
    fullNameAr: text('full_name_ar'),
    phone: text('phone'),
    email: text('email'),
    source: text('source'),
    stage: text('stage').notNull().default('applied'),
    note: text('note'),
    employeeId: uuid('employee_id').references(() => employee.id),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('applicant_no_uniq').on(t.applicantNo),
    index('applicant_vacancy_idx').on(t.vacancyId, t.stage),
    check('applicant_stage', sql`${t.stage} in ('applied', 'screening', 'interview', 'offer', 'hired', 'rejected', 'withdrawn')`),
  ],
);

export const applicantStage = pgTable(
  'applicant_stage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicantId: uuid('applicant_id')
      .notNull()
      .references(() => applicant.id),
    fromStage: text('from_stage'),
    toStage: text('to_stage').notNull(),
    note: text('note'),
    movedBy: uuid('moved_by')
      .notNull()
      .references(() => appUser.id),
    movedAt: timestamp('moved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('applicant_stage_applicant_idx').on(t.applicantId, t.movedAt)],
);

export const reviewCycle = pgTable(
  'review_cycle',
  {
    code: text('code').primaryKey(),
    nameEn: text('name_en').notNull(),
    nameAr: text('name_ar'),
    periodFrom: date('period_from').notNull(),
    periodTo: date('period_to').notNull(),
    status: text('status').notNull().default('draft'),
    createdBy: uuid('created_by').references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('review_cycle_status', sql`${t.status} in ('draft', 'open', 'closed')`)],
);

export const performanceReview = pgTable(
  'performance_review',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewNo: text('review_no').notNull(),
    cycleCode: text('cycle_code')
      .notNull()
      .references(() => reviewCycle.code),
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employee.id),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => appUser.id),
    status: text('status').notNull().default('draft'),
    overallRating: numeric('overall_rating', { precision: 4, scale: 2 }),
    reviewerComment: text('reviewer_comment'),
    employeeComment: text('employee_comment'),
    employeeCommentedAt: timestamp('employee_commented_at', { withTimezone: true }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    ratedAt: timestamp('rated_at', { withTimezone: true }),
    signedOffBy: uuid('signed_off_by').references(() => appUser.id),
    signedOffAt: timestamp('signed_off_at', { withTimezone: true }),
    signOffNote: text('sign_off_note'),
    cancelledBy: uuid('cancelled_by').references(() => appUser.id),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelReason: text('cancel_reason'),
  },
  (t) => [
    uniqueIndex('performance_review_no_uniq').on(t.reviewNo),
    uniqueIndex('performance_review_cycle_employee_uniq').on(t.cycleCode, t.employeeId),
    check('performance_review_status', sql`${t.status} in ('draft', 'rated', 'signed_off', 'cancelled')`),
    check('performance_review_signer_not_reviewer', sql`${t.signedOffBy} is null or ${t.signedOffBy} <> ${t.reviewerUserId}`),
  ],
);

export const reviewGoal = pgTable(
  'review_goal',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reviewId: uuid('review_id')
      .notNull()
      .references(() => performanceReview.id),
    lineNo: smallint('line_no').notNull(),
    title: text('title').notNull(),
    target: text('target'),
    weight: smallint('weight').notNull(),
    rating: smallint('rating'),
    comment: text('comment'),
  },
  (t) => [uniqueIndex('review_goal_line_uniq').on(t.reviewId, t.lineNo), check('review_goal_weight', sql`${t.weight} between 1 and 100`)],
);
