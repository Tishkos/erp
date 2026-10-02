'use server';

import { redirect } from 'next/navigation';
import { flag, runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as hrSettings from '@/server/services/hr-settings';

/**
 * Positions — REQ-FIX-001 FIX-5. The seats of the organisation, written by
 * the HR settings service (minted code, deactivated with a reason, never
 * deleted).
 */
const LIST = '/hr/positions';
const record = (code: string) => `${LIST}/${encodeURIComponent(code)}`;

export async function createPosition(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    hrSettings.createPosition(tx, ctx, {
      titleEn: text(form, 'title_en'),
      titleAr: text(form, 'title_ar') || null,
      departmentCode: text(form, 'department_code'),
      reportsToCode: text(form, 'reports_to_code') || null,
    }),
  );
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.code)}?saved=1`);
}

export async function updatePosition(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn(
    (tx, ctx) =>
      hrSettings.updatePosition(tx, ctx, code, {
        titleEn: text(form, 'title_en'),
        titleAr: text(form, 'title_ar') || null,
        departmentCode: text(form, 'department_code'),
        reportsToCode: text(form, 'reports_to_code') || null,
      }),
    record(code),
  );
}

export async function setPositionActive(form: FormData): Promise<void> {
  const code = text(form, 'code');
  await runAdminAndReturn((tx, ctx) => hrSettings.setPositionActive(tx, ctx, code, flag(form, 'active'), text(form, 'reason') || null), record(code));
}
