'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as exceptions from '@/server/services/exceptions';

/**
 * The Exception Center — one server action per thing a screen does. The
 * service holds the rules (who may acknowledge, that a note is required, that
 * only an open exception is acknowledged); the database holds them again.
 * Each action runs as the person, in a transaction of their own, and goes back
 * to the page with `saved` or `error`.
 */
const LIST = '/exceptions';
const record = (no: string) => `${LIST}/${encodeURIComponent(no)}`;

/** A person has seen it and says what they know and what will be done. */
export async function acknowledgeException(form: FormData): Promise<void> {
  // The note and the paperclip share the record registry; load it before the first write of a cold process.
  registerAllRecords();
  const no = text(form, 'exception_no');
  await runAdminAndReturn((tx, ctx) => exceptions.acknowledge(tx, ctx, no, text(form, 'note')), record(no));
}

/** "Refresh now": the same sweep the schedule runs, for somebody who administers the centre. */
export async function refreshExceptions(): Promise<void> {
  registerAllRecords();
  const outcome = await runAdmin((tx, ctx) => exceptions.refreshNow(tx, ctx));
  redirect(outcome.ok ? withQuery(LIST, 'saved', '1') : withQuery(LIST, 'error', outcome.error ?? ''));
}
