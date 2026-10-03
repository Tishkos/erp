/**
 * The notification delivery runner — REQ-HARDEN-001 F1–F3 (HARDEN-3),
 * delivered with REQ-WA-001 WA-1.
 *
 * Until now nothing consumed the outbox: `notification_delivery` rows stayed
 * `pending` and the e-mail channel had no sender. This module is the one
 * runner, used by two processes:
 *
 *   scripts/ops/deliver-notifications.ts   cron, every five minutes — owns
 *                                          the e-mail channel
 *   scripts/ops/whatsapp-bridge.ts         long-running — owns the WhatsApp
 *                                          channel
 *
 * Each process registers the sender for the channel it owns and runs
 * `runOnce`: the committed outbox is dispatched onto the queue, the queued
 * `notification.deliver` jobs are run (in-app rows are completed, the owned
 * channel is attempted, the other channel is left pending for its owner), and
 * then the owned channel is swept for anything still due — rows raised before
 * a runner existed, and failed rows whose retry is due (D-HD-4).
 *
 * Everything runs as the system operator (the first active system
 * administrator or super user, as the payables sweep does), because a
 * delivery reads every recipient's notification.
 */
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { db, withScope, type RequestScope, type Tx } from '../db/client';
import { appUser } from '../db/schema';
import type { NotificationChannel } from '../domain/notifications';
import * as jobs from './jobs';
import * as mail from './mail';
import * as notifications from './notifications';

/** The scope the runner works under: the system operator. */
export async function systemScope(): Promise<RequestScope> {
  const [operator] = (
    await db.execute(sql`
      select u.id
        from app_user u
        left join user_role r on r.user_id = u.id and r.role_code = 'system_administrator'
       where u.is_active and (u.is_super_user or r.user_id is not null)
       order by u.created_at
       limit 1
    `)
  ).rows as { id: string }[];
  if (!operator) throw new Error('No active system administrator or super user to run the deliveries as.');
  return { userId: operator.id, branchCode: '', isSuperUser: true };
}

/**
 * Registers the e-mail channel. With mail unconfigured every e-mail delivery
 * is *suppressed* — this deployment does not send mail, and that is a fact to
 * record, not a failure to retry — and the runner says so once in its log.
 */
export function registerEmailSender(
  send: (m: mail.PlainMail) => Promise<boolean> = mail.sendPlain,
  configured: () => boolean = mail.isConfigured,
): void {
  notifications.registerSender('email', async (message, tx: Tx) => {
    if (!configured()) throw new notifications.DeliverySuppressed('mail is not configured on this host (SMTP_HOST, SMTP_USER, SMTP_PASS)');
    const [recipient] = await tx
      .select({ email: appUser.email, isActive: appUser.isActive })
      .from(appUser)
      .where(eq(appUser.id, message.recipientUserId))
      .limit(1);
    if (!recipient) throw new notifications.DeliverySuppressed('the recipient no longer exists');
    if (!recipient.isActive) throw new notifications.DeliverySuppressed('the recipient is deactivated');
    const accepted = await send({ to: recipient.email, subject: message.subject, text: message.body });
    if (!accepted) throw new notifications.DeliverySuppressed('mail is not configured on this host');
  });
}

export interface RunResult {
  readonly dispatched: number;
  readonly jobs: { completed: number; failed: number; deadLetter: number };
  readonly channels: Partial<Record<NotificationChannel, notifications.DeliverResult>>;
}

/**
 * One pass. Safe to run from two processes at once: the outbox and the queue
 * lock the rows they claim, and a delivery row attempted twice in the same
 * instant would at worst count two attempts.
 */
export async function runOnce(
  scope: RequestScope,
  options: { readonly channels: readonly NotificationChannel[]; readonly now?: Date; readonly maxJobs?: number; readonly limit?: number },
): Promise<RunResult> {
  const now = options.now ?? new Date();
  const handlerScope = scope;
  notifications.registerDeliveryHandler((fn) => withScope(handlerScope, fn));

  const { dispatched } = await jobs.dispatch(scope);

  const counts = { completed: 0, failed: 0, deadLetter: 0 };
  const maxJobs = options.maxJobs ?? 500;
  for (let i = 0; i < maxJobs; i += 1) {
    const { outcome } = await jobs.runNext(scope, notifications.DELIVERY_QUEUE, now);
    if (outcome === 'idle') break;
    if (outcome === 'completed') counts.completed += 1;
    else if (outcome === 'failed') counts.failed += 1;
    else counts.deadLetter += 1;
  }

  const channels: Partial<Record<NotificationChannel, notifications.DeliverResult>> = {};
  for (const channel of options.channels) {
    if (!notifications.hasSender(channel)) continue;
    channels[channel] = await withScope(scope, (tx) => notifications.deliverChannel(tx, channel, options.limit === undefined ? { now } : { now, limit: options.limit }));
  }

  return { dispatched, jobs: counts, channels };
}

/** One line for a log. */
export function describe(result: RunResult): string {
  const parts = [`outbox ${result.dispatched} dispatched`, `jobs ${result.jobs.completed} done / ${result.jobs.failed} failed / ${result.jobs.deadLetter} dead`];
  for (const [channel, r] of Object.entries(result.channels)) {
    if (!r) continue;
    parts.push(`${channel} ${r.sent} sent / ${r.failed} failed / ${r.suppressed} suppressed`);
  }
  return parts.join(' · ');
}
