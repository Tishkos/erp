'use server';

/**
 * The cost plan — REQ-PM-001 Stage PM-2 §7: versions, a spread over months,
 * one cell set by hand. Only the current version is written.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as pb from '@/server/services/project-budget';

const page = (code: string) => `/projects/plan?project=${encodeURIComponent(code)}`;

export async function createPlanVersion(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) => pb.createPlanVersion(tx, ctx, code, { name: text(form, 'name'), note: text(form, 'note') || null, copyCurrent: text(form, 'copy_current') === '1' }),
    page(code),
  );
}

export async function spreadPlan(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) => pb.spreadPlan(tx, ctx, code, { wbsCode: text(form, 'wbs_code'), costCode: text(form, 'cost_code'), from: text(form, 'from'), to: text(form, 'to'), totalIqd: text(form, 'total_iqd') }),
    page(code),
  );
}

export async function setPlanLine(form: FormData): Promise<void> {
  const code = text(form, 'project_code');
  await runAdminAndReturn(
    (tx, ctx) => pb.setPlanLine(tx, ctx, code, { wbsCode: text(form, 'wbs_code'), costCode: text(form, 'cost_code'), period: text(form, 'period'), amountIqd: text(form, 'amount_iqd') }),
    page(code),
  );
}
