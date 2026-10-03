'use server';

/**
 * Project settings — REQ-PM-001 R4: types, tolerance profiles and cost
 * codes are rows an administrator edits. Nothing deletes; a row is
 * deactivated with a reason.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as ps from '@/server/services/project-system';
import * as billing from '@/server/services/project-billing';

const BACK = '/administration/project-settings';

export async function saveProjectType(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => ps.saveType(tx, ctx, { code: text(form, 'code'), nameEn: text(form, 'name_en'), nameAr: text(form, 'name_ar') || null, kind: text(form, 'kind'), existing: text(form, 'existing') === '1' }),
    BACK,
  );
}

export async function setProjectTypeActive(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => ps.setTypeActive(tx, ctx, text(form, 'code'), text(form, 'active') === '1', text(form, 'reason') || null), BACK);
}

export async function saveToleranceProfile(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      ps.saveToleranceProfile(tx, ctx, {
        code: text(form, 'code'),
        nameEn: text(form, 'name_en'),
        nameAr: text(form, 'name_ar') || null,
        warnPercent: text(form, 'warn_percent'),
        stopPercent: text(form, 'stop_percent'),
        existing: text(form, 'existing') === '1',
      }),
    BACK,
  );
}

export async function setToleranceProfileActive(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => ps.setToleranceProfileActive(tx, ctx, text(form, 'code'), text(form, 'active') === '1', text(form, 'reason') || null), BACK);
}

export async function saveCostCode(form: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => ps.saveCostCode(tx, ctx, { code: text(form, 'code'), nameEn: text(form, 'name_en'), nameAr: text(form, 'name_ar') || null, accountId: text(form, 'account_id') || null, existing: text(form, 'existing') === '1' }),
    BACK,
  );
}

export async function setCostCodeActive(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => ps.setCostCodeActive(tx, ctx, text(form, 'code'), text(form, 'active') === '1', text(form, 'reason') || null), BACK);
}

/** REQ-PM-001 D-PM-1 — Finance ratifies the recognition method, with its note. */
export async function ratifyRecognition(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => billing.ratifyPolicy(tx, ctx, text(form, 'note')), BACK);
}
