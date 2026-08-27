'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as periods from '@/server/services/periods';

const LIST = '/finance/periods';

/**
 * Opens a fiscal year, which generates its twelve periods.
 *
 * Phase 1 does not name this screen, but nothing can be posted without it: a
 * journal's posting date must fall inside a period that exists, so the year
 * has to be opened before the first entry.
 */
export async function createFiscalYear(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      periods.createFiscalYear(tx, ctx, {
        code: text(formData, 'code'),
        startsOn: text(formData, 'startsOn'),
        endsOn: text(formData, 'endsOn'),
      }),
    LIST,
  );
}

/** Open, soft-closed or closed — and never without a reason. */
export async function setPeriodStatus(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      periods.setPeriodStatus(
        tx,
        ctx,
        text(formData, 'periodId'),
        text(formData, 'status') as 'open' | 'soft_closed' | 'closed',
        text(formData, 'reason'),
      ),
    LIST,
  );
}
