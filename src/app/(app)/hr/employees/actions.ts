'use server';

import { redirect } from 'next/navigation';
import { flag, runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as employees from '@/server/services/employees';
import * as equipment from '@/server/services/employee-assets';
import * as leave from '@/server/services/leave';

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
      contractEndDate: text(form, 'contract_end_date') || null,
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
        contractEndDate: text(form, 'contract_end_date'),
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

/** HR-3 — a person's own figure for a pay component, or its stop: a dated row. */
export async function setEmployeePayFigure(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      employees.setPayFigure(tx, ctx, text(form, 'id'), {
        componentCode: text(form, 'component_code'),
        effectiveFrom: text(form, 'effective_from'),
        amount: text(form, 'amount') || null,
        stopped: flag(form, 'stopped'),
        note: text(form, 'note') || null,
      }),
    record(employeeNo),
  );
}

/** HR-2 — an opening balance or a correction of a leave balance, with its reason. */
export async function adjustLeaveBalance(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      leave.adjustBalance(tx, ctx, {
        employeeId: text(form, 'id'),
        leaveTypeCode: text(form, 'leave_type_code'),
        year: Number(text(form, 'year')),
        days: text(form, 'days'),
        kind: text(form, 'kind') === 'opening' ? 'opening' : 'adjustment',
        reason: text(form, 'reason'),
      }),
    record(employeeNo),
  );
}

/** HR-4 — equipment handed out to the person, with the condition it went out in. */
export async function handOutEmployeeAsset(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn(
    async (tx, ctx) => {
      await equipment.handOut(tx, ctx, text(form, 'id'), {
        kind: text(form, 'kind'),
        fixedAssetCode: text(form, 'fixed_asset_code') || null,
        description: text(form, 'description') || null,
        serialNo: text(form, 'serial_no') || null,
        handedOutOn: text(form, 'handed_out_on'),
        condition: text(form, 'condition') || null,
      });
    },
    record(employeeNo),
  );
}

/** HR-4 — equipment back, with the day and the condition it came back in. */
export async function returnEmployeeAsset(form: FormData): Promise<void> {
  const employeeNo = text(form, 'employee_no');
  await runAdminAndReturn((tx, ctx) => equipment.returnAsset(tx, ctx, text(form, 'asset_id'), { returnedOn: text(form, 'returned_on'), condition: text(form, 'condition') || null }), record(employeeNo));
}
