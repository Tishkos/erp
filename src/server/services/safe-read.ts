/**
 * One read that may fail without taking the page with it — platform phase, Agent 2.
 *
 * Home and My Approvals draw many independent reads through one transaction.
 * A failed statement aborts a PostgreSQL transaction for everything after it,
 * so each read runs in a savepoint: its failure is rolled back to that point,
 * logged with the read's name, and answered as `{ ok: false }` — which the page
 * renders as "could not be read" rather than as a zero or as nothing.
 *
 * Reads run one at a time on purpose: a transaction is one client, and a client
 * runs one query at a time however many are started.
 */
import type { Tx } from '../db/client';
import { logger } from '../logging';

export type Safe<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

export async function safeRead<T>(tx: Tx, name: string, read: (sp: Tx) => Promise<T>): Promise<Safe<T>> {
  try {
    const value = await tx.transaction((savepoint) => read(savepoint as unknown as Tx));
    return { ok: true, value };
  } catch (cause) {
    logger.error('a read could not be completed and was left out', { error: cause, read: name });
    return { ok: false };
  }
}
