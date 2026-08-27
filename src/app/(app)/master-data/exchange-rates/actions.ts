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

/**
 * Adds a currency to the master — the step that used to be missing. A rate
 * points at a currency row, so a currency the master did not hold could
 * never be priced, and the wall appeared here, on the rate dialog.
 */
export async function createCurrency(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      rates.createCurrency(tx, ctx, {
        code: text(formData, 'code'),
        name: text(formData, 'name'),
        decimals: Number(text(formData, 'decimals') || '2'),
      }),
    LIST,
  );
}

/** Retire or restore — history keeps every posting either way. */
export async function setCurrencyActive(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      rates.setCurrencyActive(tx, ctx, text(formData, 'code'), text(formData, 'active') === '1'),
    LIST,
  );
}
