'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as recruitment from '@/server/services/recruitment';

/**
 * Recruitment — REQ-HR-001 Stage HR-5. The service holds every rule: who
 * opens and hires, the pipeline's order, the headcount.
 */
const LIST = '/hr/recruitment';
const vacancyPage = (vacancyNo: string) => `${LIST}/${encodeURIComponent(vacancyNo)}`;
const applicantPage = (applicantNo: string) => `${LIST}/applicants/${encodeURIComponent(applicantNo)}`;

const vacancyInput = (form: FormData): recruitment.VacancyInput => ({
  positionCode: text(form, 'position_code'),
  departmentCode: text(form, 'department_code') || null,
  headcount: text(form, 'headcount') || 1,
  employmentKind: text(form, 'employment_kind') || null,
  opensOn: text(form, 'opens_on') || null,
  closesOn: text(form, 'closes_on') || null,
  description: text(form, 'description'),
});

const applicantInput = (form: FormData): recruitment.ApplicantInput => ({
  fullNameEn: text(form, 'full_name_en'),
  fullNameAr: text(form, 'full_name_ar') || null,
  phone: text(form, 'phone') || null,
  email: text(form, 'email') || null,
  source: text(form, 'source') || null,
  note: text(form, 'note') || null,
});

export async function createVacancy(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) => recruitment.createVacancy(tx, ctx, vacancyInput(form)));
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${vacancyPage(outcome.value!.vacancyNo)}?saved=1`);
}

export async function updateVacancy(form: FormData): Promise<void> {
  const vacancyNo = text(form, 'vacancy_no');
  await runAdminAndReturn((tx, ctx) => recruitment.updateVacancy(tx, ctx, vacancyNo, vacancyInput(form)), vacancyPage(vacancyNo));
}

export async function openVacancy(form: FormData): Promise<void> {
  const vacancyNo = text(form, 'vacancy_no');
  await runAdminAndReturn((tx, ctx) => recruitment.openVacancy(tx, ctx, vacancyNo), vacancyPage(vacancyNo));
}

export async function cancelVacancy(form: FormData): Promise<void> {
  const vacancyNo = text(form, 'vacancy_no');
  await runAdminAndReturn((tx, ctx) => recruitment.cancelVacancy(tx, ctx, vacancyNo, text(form, 'reason')), vacancyPage(vacancyNo));
}

export async function closeVacancy(form: FormData): Promise<void> {
  const vacancyNo = text(form, 'vacancy_no');
  await runAdminAndReturn((tx, ctx) => recruitment.closeVacancy(tx, ctx, vacancyNo, text(form, 'reason')), vacancyPage(vacancyNo));
}

export async function amendVacancy(form: FormData): Promise<void> {
  const vacancyNo = text(form, 'vacancy_no');
  await runAdminAndReturn((tx, ctx) => recruitment.amendOpen(tx, ctx, vacancyNo, { closesOn: text(form, 'closes_on') || null, headcount: text(form, 'headcount') || null }), vacancyPage(vacancyNo));
}

export async function addApplicant(form: FormData): Promise<void> {
  const vacancyNo = text(form, 'vacancy_no');
  const outcome = await runAdmin((tx, ctx) => recruitment.addApplicant(tx, ctx, vacancyNo, applicantInput(form)));
  if (!outcome.ok) redirect(`${vacancyPage(vacancyNo)}?error=${encodeURIComponent(outcome.error ?? '')}`);
  redirect(`${applicantPage(outcome.value!.applicantNo)}?saved=1`);
}

export async function updateApplicant(form: FormData): Promise<void> {
  const applicantNo = text(form, 'applicant_no');
  await runAdminAndReturn((tx, ctx) => recruitment.updateApplicant(tx, ctx, applicantNo, applicantInput(form)), applicantPage(applicantNo));
}

export async function moveApplicant(form: FormData): Promise<void> {
  const applicantNo = text(form, 'applicant_no');
  await runAdminAndReturn((tx, ctx) => recruitment.moveApplicant(tx, ctx, applicantNo, text(form, 'stage'), text(form, 'note') || null), applicantPage(applicantNo));
}

export async function hireApplicant(form: FormData): Promise<void> {
  const applicantNo = text(form, 'applicant_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      recruitment.hire(tx, ctx, applicantNo, {
        hireDate: text(form, 'hire_date'),
        employmentKind: text(form, 'employment_kind') || null,
        managerEmployeeId: text(form, 'manager_employee_id') || null,
        nationalId: text(form, 'national_id') || null,
        dateOfBirth: text(form, 'date_of_birth') || null,
        contractEndDate: text(form, 'contract_end_date') || null,
      }),
    applicantPage(applicantNo),
  );
}

/** An applicant's CV or letter, filed on their record. */
export async function attachToApplicant(form: FormData): Promise<void> {
  const applicantNo = text(form, 'applicant_no');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${applicantPage(applicantNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back (`attachments-runtime.ts`).
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    await attachments.upload(tx, ctx, { objectType: recruitment.APPLICANT_OBJECT, objectId: text(form, 'id'), fileName: upload.name, content });
  }, applicantPage(applicantNo));
}
