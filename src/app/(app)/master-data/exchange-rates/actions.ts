'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as rates from '@/server/services/exchange-rates';

const LIST = '/master-data/exchange-rates';

/**
 * Publishes a rate — Phase 1's other unnamed prerequisite.
 *
 * Every journal line is measured in the ledger currency *and* in USD, so a
 * line cannot be recorded on a date with no USD rate in force. Nothing posts
 * until Finance has published one, which is why this screen belongs to the
 * phase even though its definition does not mention currencies.
 *
 * A published rate is never edited. A correction supersedes it, so the figure
 * a journal was measured at stays readable for as long as the journal does.
 */
export async function publishRate(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      rates.publishRate(tx, ctx, {
        currency: text(formData, 'currency'),
        iqdPerUnit: text(formData, 'iqdPerUnit'),
        effectiveFrom: text(formData, 'effectiveFrom'),
        source: text(formData, 'source'),
      }),
    LIST,
  );
}
