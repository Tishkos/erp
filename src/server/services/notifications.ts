/**
 * Notification service — Phase 01.9.
 *
 * §21: "Notification rules must suppress duplicates, record delivery status and
 * allow escalation if a task is not acted upon."
 *
 * ── The boundary, again ─────────────────────────────────────────────────────
 * §21 — "A missed e-mail must never change the underlying approval
 * requirement." Nothing in this file writes to `workflow_instance`,
 * `workflow_decision`, `journal_entry` or any document status, and nothing it
 * returns is consulted by the code that does. That is what makes the 01.9 gate
 * — "suppressing notifications entirely leaves every approval requirement
 * intact" — true by construction.
 *
 * Notifications are enqueued through the 01.10 outbox, so they commit with the
 * event that caused them and are delivered afterwards. Delivery is
 * at-least-once, which is why `raise` is idempotent on the dedupe key rather
 * than merely careful.
 */
import { and, asc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  assertRule,
  dedupeKeyFor,
  isEscalationDue,
  renderNotification,
  type NotificationChannel,
  type NotificationRule,
  type QualifyingEvent,
} from '../domain/notifications';
import {
  notification,
  notificationDelivery,
  notificationRule,
  role,
  userRole,
} from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as jobs from './jobs';

export const PERMISSION_OBJECT = 'notification';
export const DELIVERY_QUEUE = 'notification.deliver';

function toRule(row: typeof notificationRule.$inferSelect): NotificationRule {
  return {
    code: row.code,
    eventType: row.eventType,
    channels: row.channels as NotificationChannel[],
    recipientRole: row.recipientRole,
    escalateAfterSeconds: row.escalateAfterSeconds,
    escalateToRole: row.escalateToRole,
    active: row.active,
  };
}

/** The rules that qualify for an event. */
export async function rulesFor(tx: Tx, eventType: string): Promise<NotificationRule[]> {
  const rows = await tx
    .select()
    .from(notificationRule)
    .where(and(eq(notificationRule.eventType, eventType), eq(notificationRule.active, true)));

  return rows.map(toRule);
}

async function recipientsOf(tx: Tx, roleCode: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: userRole.userId })
    .from(userRole)
    .where(eq(userRole.roleCode, roleCode));

  return rows.map((r) => r.userId);
}

export interface RaiseResult {
  readonly created: number;
  /** Notifications that already existed for this event — §21 suppression. */
  readonly suppressed: number;
}

/**
 * Raises the notifications a qualifying event calls for.
 *
 * Idempotent on the dedupe key: called twice for the same event, the second
 * call creates nothing. That is not defensive coding — at-least-once job
 * delivery makes the second call *normal*, and §21's "generated once per
 * qualifying event" would otherwise be a matter of luck.
 *
 * A rule with no recipients raises nothing and is not an error: the role may
 * simply be unstaffed today, and that is an operational fact rather than a
 * failure of the event that occurred.
 */
export async function raise(
  tx: Tx,
  event: QualifyingEvent,
  context: Readonly<Record<string, string | number | null | undefined>> = {},
  options: { branchCode?: string | null; actorUserId?: string | null } = {},
): Promise<RaiseResult> {
  const rules = await rulesFor(tx, event.eventType);

  let created = 0;
  let suppressed = 0;

  for (const rule of rules) {
    assertRule(rule);

    const recipients = await recipientsOf(tx, rule.recipientRole);
    const { subject, body } = renderNotification(event, context);

    for (const recipientUserId of recipients) {
      const dedupeKey = dedupeKeyFor(rule, event, recipientUserId);

      const inserted = await tx
        .insert(notification)
        .values({
          ruleCode: rule.code,
          eventType: event.eventType,
          objectType: event.objectType,
          objectId: event.objectId,
          recipientUserId,
          subject,
          body,
          context: context as Record<string, unknown>,
          dedupeKey,
          branchCode: options.branchCode ?? null,
        })
        .onConflictDoNothing({ target: notification.dedupeKey })
        .returning({ id: notification.id });

      if (inserted.length === 0) {
        suppressed += 1;
        continue;
      }

      created += 1;
      const notificationId = inserted[0]!.id;

      for (const channel of rule.channels) {
        await tx.insert(notificationDelivery).values({ notificationId, channel });
      }

      // Handed to the queue through the outbox, so it commits with the event
      // that caused it and is delivered after (§24).
      await jobs.enqueue(tx, options.actorUserId ?? null, {
        queueName: DELIVERY_QUEUE,
        payload: { notificationId: notificationId.toString() },
        idempotencyKey: dedupeKey,
        branchCode: options.branchCode ?? null,
      });
    }
  }

  return { created, suppressed };
}

// ---------------------------------------------------------------------------
// §21 — delivery status
// ---------------------------------------------------------------------------

export type ChannelSender = (message: {
  channel: NotificationChannel;
  recipientUserId: string;
  subject: string;
  body: string;
}) => Promise<void> | void;

const senders = new Map<NotificationChannel, ChannelSender>();

/**
 * Registers how a channel actually delivers.
 *
 * In-app needs no sender — the row *is* the delivery. E-mail is registered by
 * the deployment, because the transport is infrastructure and §25 keeps
 * configuration out of code.
 */
export function registerSender(channel: NotificationChannel, sender: ChannelSender): void {
  senders.set(channel, sender);
}

export function clearSenders(): void {
  senders.clear();
}

/**
 * Attempts delivery on every pending channel of one notification.
 *
 * A failure is recorded and the attempt counted. It does not throw: the caller
 * is a job handler, and a notification that cannot be delivered is not a reason
 * to retry the *event*. §21 — the delivery outcome changes nothing upstream.
 */
export async function deliver(
  tx: Tx,
  notificationId: bigint,
): Promise<{ sent: number; failed: number }> {
  const [row] = await tx
    .select()
    .from(notification)
    .where(eq(notification.id, notificationId))
    .limit(1);

  if (!row) return { sent: 0, failed: 0 };

  const pending = await tx
    .select()
    .from(notificationDelivery)
    .where(
      and(
        eq(notificationDelivery.notificationId, notificationId),
        eq(notificationDelivery.status, 'pending'),
      ),
    );

  let sent = 0;
  let failed = 0;

  for (const delivery of pending) {
    const sender = senders.get(delivery.channel);

    try {
      // In-app delivery is the row existing; there is nothing to send.
      if (delivery.channel !== 'in_app') {
        if (!sender) {
          throw new Error(`No sender is registered for the ${delivery.channel} channel.`);
        }
        await sender({
          channel: delivery.channel,
          recipientUserId: row.recipientUserId,
          subject: row.subject,
          body: row.body,
        });
      }

      await tx
        .update(notificationDelivery)
        .set({
          status: 'sent',
          deliveredAt: new Date(),
          lastAttemptAt: new Date(),
          attempts: delivery.attempts + 1,
          errorMessage: null,
        })
        .where(eq(notificationDelivery.id, delivery.id));

      sent += 1;
    } catch (error) {
      await tx
        .update(notificationDelivery)
        .set({
          status: 'failed',
          lastAttemptAt: new Date(),
          attempts: delivery.attempts + 1,
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        .where(eq(notificationDelivery.id, delivery.id));

      failed += 1;
    }
  }

  return { sent, failed };
}

/** The failures, so §21's "delivery status" is visible rather than merely recorded. */
export async function failedDeliveries(tx: Tx) {
  return tx
    .select({
      notificationId: notificationDelivery.notificationId,
      channel: notificationDelivery.channel,
      attempts: notificationDelivery.attempts,
      errorMessage: notificationDelivery.errorMessage,
      lastAttemptAt: notificationDelivery.lastAttemptAt,
      subject: notification.subject,
      recipientUserId: notification.recipientUserId,
    })
    .from(notificationDelivery)
    .innerJoin(notification, eq(notification.id, notificationDelivery.notificationId))
    .where(eq(notificationDelivery.status, 'failed'))
    .orderBy(asc(notificationDelivery.lastAttemptAt));
}

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

export async function inboxFor(tx: Tx, userId: string, options: { unreadOnly?: boolean } = {}) {
  return tx
    .select()
    .from(notification)
    .where(
      options.unreadOnly
        ? and(eq(notification.recipientUserId, userId), isNull(notification.readAt))
        : eq(notification.recipientUserId, userId),
    )
    .orderBy(asc(notification.createdAt));
}

export async function markRead(tx: Tx, notificationId: bigint): Promise<void> {
  await tx
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.id, notificationId), isNull(notification.readAt)));
}

/**
 * Records that the task was done.
 *
 * Called by the module that owns the document when the thing is approved,
 * rejected or otherwise dealt with — **not** the other way round. The
 * notification learns from the workflow; the workflow never learns from the
 * notification (§21).
 */
export async function markActed(
  tx: Tx,
  objectType: string,
  objectId: string,
): Promise<number> {
  const updated = await tx
    .update(notification)
    .set({ actedAt: new Date() })
    .where(
      and(
        eq(notification.objectType, objectType),
        eq(notification.objectId, objectId),
        isNull(notification.actedAt),
      ),
    )
    .returning({ id: notification.id });

  return updated.length;
}

// ---------------------------------------------------------------------------
// §21 — escalation
// ---------------------------------------------------------------------------

export interface EscalationResult {
  readonly escalated: number;
}

/**
 * Escalates every task that has gone unacted past its rule's interval.
 *
 * The clock stops when the task is **acted upon**, not when it is read — §21
 * says "if a task is not acted upon", and someone opening an e-mail and doing
 * nothing is exactly the case escalation exists for.
 *
 * An escalation raises a *new* notification to the escalation role. It does not
 * approve anything, reassign anything, or alter the document in any way.
 */
export async function escalateDue(
  tx: Tx,
  now = new Date(),
): Promise<EscalationResult> {
  const candidates = await tx
    .select({ notification, rule: notificationRule })
    .from(notification)
    .innerJoin(notificationRule, eq(notificationRule.code, notification.ruleCode))
    .where(
      and(
        isNull(notification.actedAt),
        isNull(notification.escalatedAt),
        sql`${notificationRule.escalateAfterSeconds} is not null`,
      ),
    )
    .orderBy(asc(notification.createdAt));

  let escalated = 0;

  for (const row of candidates) {
    const rule = toRule(row.rule);

    if (
      !isEscalationDue(rule, {
        createdAt: row.notification.createdAt,
        actedAt: row.notification.actedAt,
        escalatedAt: row.notification.escalatedAt,
      }, now)
    ) {
      continue;
    }

    const escalateTo = await recipientsOf(tx, rule.escalateToRole!);

    await tx
      .update(notification)
      .set({ escalatedAt: now, escalatedToUserId: escalateTo[0] ?? null })
      .where(eq(notification.id, row.notification.id));

    for (const recipientUserId of escalateTo) {
      const dedupeKey = `escalation|${row.notification.dedupeKey}|${recipientUserId}`;

      const inserted = await tx
        .insert(notification)
        .values({
          ruleCode: rule.code,
          eventType: `${row.notification.eventType}.escalated`,
          objectType: row.notification.objectType,
          objectId: row.notification.objectId,
          recipientUserId,
          subject: `Still outstanding — ${row.notification.subject}`,
          body:
            `${row.notification.body}\n\n` +
            `This has been outstanding since ${row.notification.createdAt.toISOString()} ` +
            'and has been escalated. The approval itself is still recorded on the document.',
          context: row.notification.context,
          dedupeKey,
          branchCode: row.notification.branchCode,
          // An escalation does not itself escalate. Without this the notice
          // raised here would come due on the next sweep and raise another,
          // and the chain would only stop when someone acted.
          escalatedAt: now,
        })
        .onConflictDoNothing({ target: notification.dedupeKey })
        .returning({ id: notification.id });

      if (inserted.length === 0) continue;

      for (const channel of rule.channels) {
        await tx
          .insert(notificationDelivery)
          .values({ notificationId: inserted[0]!.id, channel });
      }

      await jobs.enqueue(tx, null, {
        queueName: DELIVERY_QUEUE,
        payload: { notificationId: inserted[0]!.id.toString() },
        idempotencyKey: dedupeKey,
        branchCode: row.notification.branchCode,
      });
    }

    escalated += 1;
  }

  return { escalated };
}

/** Registers the delivery handler on the 01.10 queue. */
export function registerDeliveryHandler(runWithTx: (fn: (tx: Tx) => Promise<void>) => Promise<void>): void {
  jobs.registerHandler(DELIVERY_QUEUE, async (payload) => {
    const notificationId = BigInt(String(payload.notificationId));
    await runWithTx(async (tx) => {
      await deliver(tx, notificationId);
    });
  });
}

export { lte, role };
