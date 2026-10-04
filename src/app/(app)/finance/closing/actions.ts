'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
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
