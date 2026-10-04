'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as periods from '@/server/services/periods';

/**
 * Period / Year-End Closing — REQ-ACC-001 Part D-6. The lock is Accounting
 * Periods' own (`periods.setPeriodStatus`): the checklist is run again inside
 * it and a blocking failure refuses the close. Nothing here rolls profit
 * into retained earnings — that would change the protected statements.
 */
const SCREEN = '/finance/closing';

export async function closePeriodAction(formData: FormData): Promise<void> {
  const periodId = text(formData, 'period_id');
  await runAdminAndReturn(
    (tx, ctx) =>
      periods.setPeriodStatus(tx, ctx, periodId, text(formData, 'status') as 'open' | 'soft_closed' | 'closed', text(formData, 'reason')),
    `${SCREEN}?period=${encodeURIComponent(periodId)}`,
  );
}

/**
 * The period's closing papers — the sign-off, the reconciliations' file — on
 * the period itself (object `fiscal_period`). The attachment rules are
 * registered lazily, so a cold process is told about them before it is handed
 * the first file.
 */
export async function attachToPeriod(formData: FormData): Promise<void> {
  const periodId = text(formData, 'period_id');
  const back = `${SCREEN}?period=${encodeURIComponent(periodId)}`;
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(`${back}&error=attachment_missing`);
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(
    (tx, ctx) =>
      attachments.upload(tx, ctx, {
        objectType: periods.PERMISSION_OBJECT,
        objectId: periodId,
        fileName: upload.name,
        content,
      }),
    back,
  );
}
