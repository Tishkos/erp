'use server';

/**
 * Close — REQ-PM-001 Stage PM-6 §12. Technical completion, the settlement
 * (drafted by one person, posted by another) and the close.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as closing from '@/server/services/project-close';
import * as ps from '@/server/services/project-system';

const page = (form: FormData) => `/projects/close?project=${encodeURIComponent(text(form, 'project_code'))}`;

export async function technicallyComplete(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => ps.technicalComplete(tx, ctx, text(form, 'project_code'), text(form, 'note') || null), page(form));
}

export async function draftSettlement(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => closing.createSettlement(tx, ctx, text(form, 'project_code'), { settledOn: text(form, 'settled_on'), note: text(form, 'note') || null }), page(form));
}

export async function postSettlement(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => closing.postSettlement(tx, ctx, text(form, 'settlement_no')), page(form));
}

export async function cancelSettlement(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => closing.cancelSettlement(tx, ctx, text(form, 'settlement_no'), text(form, 'reason')), page(form));
}

export async function closeProject(form: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => ps.close(tx, ctx, text(form, 'project_code'), text(form, 'note')), page(form));
}
