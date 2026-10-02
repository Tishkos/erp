'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as employees from '@/server/services/employees';

/**
 * Employees — REQ-HR-001 Stage HR-1. The service holds every rule: the
 * number is minted, every move is a dated history row, compensation is
 * its own grant.
 */
const LIST = '/hr/employees';
const record = (employeeNo: string) => `${LIST}/${encodeURIComponent(employeeNo)}`;

export async function createEmployee(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    employees.create(tx, ctx, {
      fullNameEn: text(form, 'full_name_en'),
      fullNameAr: text(form, 'full_name_ar') || null,
      nationalId: text(form, 'national_id') || null,
      dateOfBirth: text(form, 'date_of_birth') || null,
      phone: text(form, 'phone') || null,
      address: text(form, 'address') || null,
      emergencyContact: text(form, 'emergency_contact') || null,
      departmentCode: text(form, 'department_code'),
      positionCode: text(form, 'position_code') || null,
      managerEmployeeId: text(form, 'manager_employee_id') || null,
      hireDate: text(form, 'hire_date'),
      employmentKind: text(form, 'employment_kind') || 'permanent',
    }),
  );
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.employeeNo)}?saved=1`);
}

export async function updateEmployeeIdentity(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      employees.updateIdentity(tx, ctx, text(form, 'id'), {
        fullNameEn: text(form, 'full_name_en'),
        fullNameAr: text(form, 'full_name_ar') || null,
        nationalId: text(form, 'national_id') || null,
        dateOfBirth: text(form, 'date_of_birth') || null,
        phone: text(form, 'phone') || null,
        address: text(form, 'address') || null,
        emergencyContact: text(form, 'emergency_contact') || null,
      }),
    record(employeeNo),
  );
}

export async function moveEmployee(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      employees.move(tx, ctx, text(form, 'id'), {
        effectiveFrom: text(form, 'effective_from') || null,
        reason: text(form, 'reason') || null,
        departmentCode: text(form, 'department_code') || null,
        positionCode: text(form, 'position_code'),
        managerEmployeeId: text(form, 'manager_employee_id'),
        employmentKind: text(form, 'employment_kind') || null,
      }),
    record(employeeNo),
  );
}

export async function setEmployeeStatus(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      employees.setStatus(tx, ctx, text(form, 'id'), {
        status: text(form, 'status'),
        effectiveFrom: text(form, 'effective_from') || null,
        reason: text(form, 'reason') || null,
      }),
    record(employeeNo),
  );
}

export async function linkEmployeeUser(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn((tx, ctx) => employees.linkUser(tx, ctx, text(form, 'id'), text(form, 'app_user_id') || null), record(employeeNo));
}

export async function setEmployeeCompensation(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      employees.setCompensation(tx, ctx, text(form, 'id'), {
        effectiveFrom: text(form, 'effective_from'),
        baseSalaryIqd: text(form, 'base_salary_iqd'),
        payMethod: text(form, 'pay_method') || 'bank',
        bankCode: text(form, 'bank_code') || null,
        accountNumber: text(form, 'account_number') || null,
        iban: text(form, 'iban') || null,
        note: text(form, 'note') || null,
      }),
    record(employeeNo),
  );
}
