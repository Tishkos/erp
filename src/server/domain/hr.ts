/**
 * Human resources — REQ-HR-001 Stage HR-1: the people and the organisation.
 *
 * The shapes and the rules that need no database: what an employee record
 * may say, which of its fields are *dated history* (R1 — a change is a new
 * row, never an overwritten field), and what a pay component, a leave type
 * and a working calendar are (R4 — configuration is master data).
 */

export const EMPLOYMENT_KINDS = ['permanent', 'contract', 'daily'] as const;
export type EmploymentKind = (typeof EMPLOYMENT_KINDS)[number];

export const EMPLOYEE_STATUSES = ['active', 'suspended', 'ended'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/**
 * The fields whose every change is a dated history row (§4 "Dated history").
 * Identity fields (name, phone, address) are corrected in place and audited;
 * these are the ones "who was their manager in March" is asked about.
 */
export const HISTORY_FIELDS = ['branch_code', 'department_code', 'position_code', 'manager_employee_id', 'status', 'employment_kind'] as const;
export type HistoryField = (typeof HISTORY_FIELDS)[number] | 'base_salary_iqd' | 'hired' | 'ended' | 'contract_end_date';

export const PAY_COMPONENT_KINDS = ['earning', 'deduction', 'employer_cost'] as const;
export type PayComponentKind = (typeof PAY_COMPONENT_KINDS)[number];

export const PAY_CALCULATIONS = ['fixed', 'percent_of_base', 'manual'] as const;
export type PayCalculation = (typeof PAY_CALCULATIONS)[number];

export const PAY_METHODS = ['bank', 'cash'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export class HrValidationError extends Error {
  readonly code = 'HR_VALIDATION';
  constructor(
    readonly field: string,
    detail: string,
  ) {
    super(`${field}: ${detail}`);
    this.name = 'HrValidationError';
  }
}

export function isEmploymentKind(value: string): value is EmploymentKind {
  return (EMPLOYMENT_KINDS as readonly string[]).includes(value);
}

export function isEmployeeStatus(value: string): value is EmployeeStatus {
  return (EMPLOYEE_STATUSES as readonly string[]).includes(value);
}

export function isPayComponentKind(value: string): value is PayComponentKind {
  return (PAY_COMPONENT_KINDS as readonly string[]).includes(value);
}

export function isPayCalculation(value: string): value is PayCalculation {
  return (PAY_CALCULATIONS as readonly string[]).includes(value);
}

export function isPayMethod(value: string): value is PayMethod {
  return (PAY_METHODS as readonly string[]).includes(value);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function assertDay(value: string, field: string): string {
  if (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new HrValidationError(field, 'must be a day, written YYYY-MM-DD');
  }
  return value;
}

/** Working days parsed from the calendar's text column ("mon,tue,wed,thu,sat"). */
export function workingDays(value: string): readonly Weekday[] {
  return value
    .split(',')
    .map((day) => day.trim().toLowerCase())
    .filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day));
}

export function assertWorkingDays(value: string): string {
  const days = workingDays(value);
  if (days.length === 0) throw new HrValidationError('working_days', 'name at least one day (mon,tue,wed,thu,sat)');
  return days.join(',');
}
