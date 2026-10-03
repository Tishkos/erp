'use server';

import { redirect } from 'next/navigation';
import { flag, runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as departments from '@/server/services/departments';

/**
 * Departments from HR — REQ-FIX-001 FIX-5. The department is the company's
 * one row, created by the same service and under the same grant as on the
 * master-data screen; the code is minted.
 */
const LIST = '/hr/departments';

export async function createDepartment(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) => departments.create(tx, ctx, { name: text(form, 'name'), parentCode: text(form, 'parent_code') || null }));
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${LIST}/${encodeURIComponent(outcome.value!.code)}?saved=1`);
}

const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

export async function updateDepartment(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => departments.update(tx, ctx, code, { name: text(form, 'name'), parentCode: text(form, 'parent_code') || null }), record(code));
}

export async function setDepartmentActive(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => departments.setActive(tx, ctx, code, flag(form, 'active'), text(form, 'reason') || null), record(code));
}
