'use server';

import { revalidatePath } from 'next/cache';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import type { Tx } from '@/server/db/client';
import { isCategory, type NotificationCategory } from '@/server/domain/notification-center';
import * as center from '@/server/services/notification-center';
import * as notifications from '@/server/services/notifications';

/**
 * What a person does to their own notifications — read, un-read, read all.
 *
 * Every action runs in the person's own scope (`runAdmin`) and touches rows
 * whose recipient is that person and nobody else: another id is not an error
 * the caller can learn from, it simply changes nothing. All of them are
 * idempotent — marking a read one read, or an unread one unread, is a no-op
 * that answers with the same count.
 *
 * The bell calls the first three and gets the unread count back; the
 * notifications screen submits the `…Form` ones and returns to itself.
 */

export interface BellActionResult {
  readonly ok: boolean;
  /** How many are unread now. */
  readonly unread: number;
  readonly changed: number;
  readonly error?: string | undefined;
}

const NUMBER = /^\d{1,18}$/;

const categoryOf = (value: string | null | undefined): NotificationCategory | null => (value && isCategory(value) ? value : null);

async function change(id: string, step: (tx: Tx, userId: string, key: bigint) => Promise<number>): Promise<BellActionResult> {
  if (!NUMBER.test(id)) return { ok: false, unread: 0, changed: 0, error: 'not_found' };
  const outcome = await runAdmin(async (tx, ctx) => {
    const changed = await step(tx, ctx.principal.userId, BigInt(id));
    return { changed, unread: await notifications.unreadCountFor(tx, ctx.principal.userId) };
  });
  return outcome.ok ? { ok: true, ...outcome.value! } : { ok: false, unread: 0, changed: 0, error: outcome.error };
}

export async function markReadAction(id: string): Promise<BellActionResult> {
  return change(id, (tx, userId, key) => notifications.markRead(tx, key, userId));
}

export async function markUnreadAction(id: string): Promise<BellActionResult> {
  return change(id, (tx, userId, key) => notifications.markUnread(tx, key, userId));
}

export async function markAllReadAction(category: string | null): Promise<BellActionResult> {
  const outcome = await runAdmin(async (tx, ctx) => {
    const changed = await center.markAllReadAudited(tx, ctx, { category: categoryOf(category) });
    return { changed, unread: await notifications.unreadCountFor(tx, ctx.principal.userId) };
  });
  if (outcome.ok) revalidatePath('/notifications');
  return outcome.ok ? { ok: true, ...outcome.value! } : { ok: false, unread: 0, changed: 0, error: outcome.error };
}

// ---------------------------------------------------------------------------
// The screen's forms
// ---------------------------------------------------------------------------

/** Where the screen goes back to: its own address, with the filters it had. */
function backTo(form: FormData): string {
  const query = new URLSearchParams();
  for (const key of ['q', 'state', 'category', 'page']) {
    const value = text(form, key);
    if (value) query.set(key, value);
  }
  const rest = query.toString();
  return rest ? `/notifications?${rest}` : '/notifications';
}

export async function markAllReadForm(form: FormData): Promise<void> {
  const category = categoryOf(text(form, 'category'));
  await runAdminAndReturn((tx, ctx) => center.markAllReadAudited(tx, ctx, { category }), backTo(form));
}

export async function toggleReadForm(form: FormData): Promise<void> {
  const id = text(form, 'id');
  const toUnread = text(form, 'to') === 'unread';
  await runAdminAndReturn(async (tx, ctx) => {
    if (!NUMBER.test(id)) return 0;
    return toUnread ? notifications.markUnread(tx, BigInt(id), ctx.principal.userId) : notifications.markRead(tx, BigInt(id), ctx.principal.userId);
  }, backTo(form));
}
