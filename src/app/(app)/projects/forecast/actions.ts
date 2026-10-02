'use server';

/**
 * Forecast — REQ-PM-001 Stage PM-5 §11. The manager's estimate to complete
 * for one element, dated and reasoned; the latest one to a day counts.
 */
import { runAdminAndReturn, text } from '@/server/admin-action';
import * as billing from '@/server/services/project-billing';

export async function setEtc(form: FormData): Promise<void> {
  const asOf = text(form, 'return_as_of');
  await runAdminAndReturn(
    (tx, ctx) => billing.setEtc(tx, ctx, text(form, 'project_code'), { wbsCode: text(form, 'wbs_code'), asOf: text(form, 'as_of'), etcIqd: text(form, 'etc'), reason: text(form, 'reason') }),
    `/projects/forecast?project=${encodeURIComponent(text(form, 'project_code'))}${asOf ? `&as_of=${asOf}` : ''}`,
  );
}
