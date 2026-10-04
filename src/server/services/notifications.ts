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
import { and, asc, eq, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import {
  NOTIFICATION_CATEGORIES,
  categoryOf,
  claimedByOthers,
  dedupeKeyOf,
  kindDef,
  matchOf,
  needsOccurrence,
  windowToken,
  type NotificationCategory,
} from '../domain/notification-center';
import { businessToday } from '../domain/business-date';
import {
  assertRule,
  dedupeKeyFor,
  eventKeyOf,
  isDeliveryDue,
  isEscalationDue,
  renderNotification,
  DELIVERY_MAX_ATTEMPTS,
  type DeliveryStatus,
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
import { markSystemSweep, type Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as jobs from './jobs';
import { countOf, registerPage, whereOf, type RegisterPage } from './register-page';

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

/**
 * Of the rules that reached one person, the one whose window is shortest.
 *
 * A rule that escalates beats one that does not, and the sooner of two that
 * do; failing that, the first by code, so the choice does not depend on the
 * order the rules happened to be read in.
 */
function strictest(rules: readonly NotificationRule[]): NotificationRule {
  return [...rules].sort((a, b) => {
    const left = a.escalateAfterSeconds ?? Number.POSITIVE_INFINITY;
    const right = b.escalateAfterSeconds ?? Number.POSITIVE_INFINITY;
    return left === right ? a.code.localeCompare(b.code) : left - right;
  })[0]!;
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
/**
 * HD5 — the one way a notification row is written. The recipient's own
 * policy hides other people's notifications, which would also hide the row a
 * module has just raised for them from the RETURNING clause; the definer
 * function `app_notify` inserts and returns the id without widening the
 * policy. Null when the dedupe key already exists.
 *
 * Platform phase (Agent 6, C-72): a kind the registry gives a permission
 * object (`domain/notification-center.KINDS`) is told only to a person who is
 * active, holds that grant and — when the notification names a branch — has
 * that branch in scope. Anyone else is skipped (null, nothing written). A kind
 * with no object, or one the registry does not know, is written as before: its
 * emitter chose its people by its own rule.
 */
export type InsertOutcome =
  | { readonly status: 'created'; readonly id: bigint }
  | { readonly status: 'duplicate' }
  | { readonly status: 'not_permitted'; readonly reason: 'inactive' | 'no_grant' | 'no_branch' };

export interface NotificationRowInput {
  ruleCode: string | null;
  eventType: string;
  objectType: string;
  objectId: string;
  recipientUserId: string;
  subject: string;
  body: string;
  context: Record<string, unknown> | null;
  dedupeKey: string;
  branchCode: string | null;
}

const refusals = new WeakMap<object, Map<string, 'inactive' | 'no_grant' | 'no_branch' | null>>();

/** Why a person may not be told this kind (null: they may). Asked once per person, grant and branch in a transaction. */
export async function refusalFor(
  tx: Tx,
  recipientUserId: string,
  kind: string,
  branchCode: string | null,
): Promise<'inactive' | 'no_grant' | 'no_branch' | null> {
  const def = kindDef(kind);
  if (!def.object) return null;
  const verb = def.verb ?? 'view';
  const key = `${recipientUserId}|${def.object}|${verb}|${branchCode ?? ''}`;
  let cache = refusals.get(tx);
  if (!cache) {
    cache = new Map();
    refusals.set(tx, cache);
  }
  if (cache.has(key)) return cache.get(key) ?? null;

  const result = await tx.execute(sql`
    select u.is_active as active, u.is_super_user as super,
           exists (select 1 from user_role ur join role_grant g on g.role_code = ur.role_code
                    where ur.user_id = u.id and g.object = ${def.object} and g.verb = ${verb}::permission_verb) as granted,
           exists (select 1 from user_branch_scope b where b.user_id = u.id and b.branch_code = ${branchCode ?? ''}) as in_branch
      from app_user u
     where u.id = ${recipientUserId}::uuid`);
  const row = result.rows[0] as { active: boolean; super: boolean; granted: boolean; in_branch: boolean } | undefined;
  const refused =
    !row || !row.active
      ? 'inactive'
      : !row.super && !row.granted
        ? 'no_grant'
        : branchCode && !row.super && !row.in_branch
          ? 'no_branch'
          : null;
  cache.set(key, refused);
  return refused;
}

export async function tryInsertNotification(tx: Tx, row: NotificationRowInput): Promise<InsertOutcome> {
  const refused = await refusalFor(tx, row.recipientUserId, row.eventType, row.branchCode);
  if (refused) return { status: 'not_permitted', reason: refused };
  const result = await tx.execute(sql`
    select app_notify(${row.ruleCode}, ${row.eventType}, ${row.objectType}, ${row.objectId}, ${row.recipientUserId}::uuid,
                      ${row.subject}, ${row.body}, ${row.context === null ? null : JSON.stringify(row.context)}::jsonb,
                      ${row.dedupeKey}, ${row.branchCode}) as id`);
  const id = (result.rows[0] as { id: string | null } | undefined)?.id ?? null;
  return id === null ? { status: 'duplicate' } : { status: 'created', id: BigInt(id) };
}

export async function insertNotification(tx: Tx, row: NotificationRowInput): Promise<bigint | null> {
  const outcome = await tryInsertNotification(tx, row);
  return outcome.status === 'created' ? outcome.id : null;
}

export async function raise(
  tx: Tx,
  event: QualifyingEvent,
  context: Readonly<Record<string, string | number | null | undefined>> = {},
  options: { branchCode?: string | null; actorUserId?: string | null } = {},
): Promise<RaiseResult> {
  const rules = await rulesFor(tx, event.eventType);
  for (const rule of rules) assertRule(rule);

  // Who the event reaches, and by what means.
  //
  // The rules are written per role and a person may hold two of them: on
  // 2026-10-02 one supplier payment told the same person twice, once by the
  // accounting manager's rule and once by the CEO's, because the dedupe key
  // began with the rule's code and so only ever suppressed a repeat of the
  // same rule. §21 generates a notification once per qualifying event, so the
  // rules that reach somebody are merged here: the text is the event's — it
  // never came from the rule — and the channels are the union of theirs, so
  // nobody loses a channel because another rule reached them first.
  const reached = new Map<string, { rules: NotificationRule[]; channels: NotificationChannel[] }>();
  for (const rule of rules) {
    for (const recipientUserId of await recipientsOf(tx, rule.recipientRole)) {
      const entry = reached.get(recipientUserId) ?? { rules: [], channels: [] };
      entry.rules.push(rule);
      for (const channel of rule.channels) {
        if (!entry.channels.includes(channel)) entry.channels.push(channel);
      }
      reached.set(recipientUserId, entry);
    }
  }

  const { subject, body } = renderNotification(event, context);

  let created = 0;
  let suppressed = 0;

  for (const [recipientUserId, { rules: reaching, channels }] of reached) {
    const dedupeKey = dedupeKeyFor(event, recipientUserId);

    const outcome = await tryInsertNotification(tx, {
      // A notification carries one rule, which escalation reads for its
      // window. Of the rules that reached this person the strictest is
      // recorded — the one that escalates soonest — because a merged
      // notification should escalate no later than the earliest rule that
      // asked for it.
      ruleCode: strictest(reaching).code,
      eventType: event.eventType,
      objectType: event.objectType,
      objectId: event.objectId,
      recipientUserId,
      subject,
      body,
      context: context as Record<string, unknown>,
      dedupeKey,
      branchCode: options.branchCode ?? null,
    });

    // Not the recipient's to be told (C-72): neither created nor a repeat.
    if (outcome.status === 'not_permitted') continue;
    if (outcome.status === 'duplicate') {
      suppressed += 1;
      continue;
    }
    const notificationId = outcome.id;

    created += 1;

    for (const channel of channels) {
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
  notificationId: bigint;
  deliveryId: bigint;
  eventType: string;
  objectType: string;
  objectId: string;
  /**
   * The event, without the recipient — the same for every person this event
   * notified. A channel that must act once per event rather than once per
   * recipient keys on this (`whatsapp.ts`, the copy into the group).
   */
  eventKey: string;
}, tx: Tx) => Promise<void> | void;

/**
 * Thrown by a sender when the recipient cannot be reached on this channel at
 * all — no address, notifications switched off — as opposed to a transport
 * that failed. The delivery is marked `suppressed`: not an error, nothing to
 * retry, and the in-app copy is still there.
 */
export class DeliverySuppressed extends Error {
  readonly code = 'DELIVERY_SUPPRESSED';
  constructor(reason: string) {
    super(reason);
    this.name = 'DeliverySuppressed';
  }
}

const senders = new Map<NotificationChannel, ChannelSender>();

/**
 * Registers how a channel actually delivers.
 *
 * In-app needs no sender — the row *is* the delivery. E-mail is registered by
 * the delivery job (`scripts/ops/deliver-notifications.ts`) and WhatsApp by
 * the bridge (`scripts/ops/whatsapp-bridge.ts`), because each transport is
 * infrastructure and §25 keeps configuration out of code. A process that owns
 * no sender for a channel leaves that channel's rows pending for the one that
 * does (REQ-WA-001 WA-1).
 */
export function registerSender(channel: NotificationChannel, sender: ChannelSender): void {
  senders.set(channel, sender);
}

export function clearSenders(): void {
  senders.clear();
}

export function hasSender(channel: NotificationChannel): boolean {
  return channel === 'in_app' || senders.has(channel);
}

type DeliveryRow = typeof notificationDelivery.$inferSelect;
type NotificationRow = typeof notification.$inferSelect;

/**
 * One attempt on one delivery row. The outcome is written whatever it is:
 * sent, failed with the reason, or suppressed — and the attempt counted. It
 * does not throw: the caller is a job, and a notification that cannot be
 * delivered is not a reason to retry the *event*. §21 — the delivery outcome
 * changes nothing upstream.
 */
async function attempt(tx: Tx, delivery: DeliveryRow, row: NotificationRow): Promise<'sent' | 'failed' | 'suppressed' | 'skipped'> {
  const sender = senders.get(delivery.channel);
  const now = new Date();

  // In-app delivery is the row existing; there is nothing to send. Another
  // channel without a sender in this process belongs to another process.
  if (delivery.channel !== 'in_app' && !sender) return 'skipped';

  try {
    if (sender && delivery.channel !== 'in_app') {
      await sender({
        channel: delivery.channel,
        recipientUserId: row.recipientUserId,
        subject: row.subject,
        body: row.body,
        notificationId: row.id,
        deliveryId: delivery.id,
        eventType: row.eventType,
        objectType: row.objectType,
        objectId: row.objectId,
        eventKey: eventKeyOf(row.dedupeKey),
      }, tx);
    }
    await tx
      .update(notificationDelivery)
      .set({ status: 'sent', deliveredAt: now, lastAttemptAt: now, attempts: delivery.attempts + 1, errorMessage: null })
      .where(eq(notificationDelivery.id, delivery.id));
    return 'sent';
  } catch (error) {
    if (error instanceof DeliverySuppressed) {
      await tx
        .update(notificationDelivery)
        .set({ status: 'suppressed', lastAttemptAt: now, attempts: delivery.attempts + 1, errorMessage: null })
        .where(eq(notificationDelivery.id, delivery.id));
      return 'suppressed';
    }
    await tx
      .update(notificationDelivery)
      .set({
        status: 'failed',
        lastAttemptAt: now,
        attempts: delivery.attempts + 1,
        errorMessage: error instanceof Error ? error.message : String(error),
      })
      .where(eq(notificationDelivery.id, delivery.id));
    return 'failed';
  }
}

export interface DeliverResult {
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  /** Channels this process has no sender for — left pending for the one that does. */
  readonly skipped: number;
}

/**
 * Attempts delivery on every due channel of one notification: the pending
 * ones, and the failed ones whose retry is due (D-HD-4: three attempts,
 * 1 / 10 / 60 minutes apart; after that the failure stays and is visible).
 */
export async function deliver(tx: Tx, notificationId: bigint, now = new Date()): Promise<DeliverResult> {
  // A delivery reads somebody else's notification (C-70): the job that runs it is the system sweep.
  await markSystemSweep(tx);
  const [row] = await tx.select().from(notification).where(eq(notification.id, notificationId)).limit(1);
  const result = { sent: 0, failed: 0, suppressed: 0, skipped: 0 };
  if (!row) return result;

  const candidates = await tx
    .select()
    .from(notificationDelivery)
    .where(
      and(
        eq(notificationDelivery.notificationId, notificationId),
        inArray(notificationDelivery.status, ['pending', 'failed'] satisfies DeliveryStatus[]),
      ),
    )
    .orderBy(asc(notificationDelivery.id));

  for (const delivery of candidates) {
    if (!isDeliveryDue(delivery, now)) continue;
    const outcome = await attempt(tx, delivery, row);
    result[outcome] += 1;
  }
  return result;
}

/**
 * The deliveries one channel's process should attempt now: pending rows and
 * failed rows whose retry is due, oldest first. Reads every recipient's
 * notification, so it marks the transaction as the system sweep HD5 allows.
 */
export async function dueDeliveries(
  tx: Tx,
  channel: NotificationChannel,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<Array<{ delivery: DeliveryRow; notification: NotificationRow }>> {
  const now = options.now ?? new Date();
  await markSystemSweep(tx);
  const rows = await tx
    .select({ delivery: notificationDelivery, notification })
    .from(notificationDelivery)
    .innerJoin(notification, eq(notification.id, notificationDelivery.notificationId))
    .where(
      and(
        eq(notificationDelivery.channel, channel),
        inArray(notificationDelivery.status, ['pending', 'failed'] satisfies DeliveryStatus[]),
        sql`${notificationDelivery.attempts} < ${DELIVERY_MAX_ATTEMPTS}`,
      ),
    )
    .orderBy(asc(notificationDelivery.id))
    .limit(Math.max(1, Math.min(1000, (options.limit ?? 200) * 2)));
  return rows.filter((r) => isDeliveryDue(r.delivery, now)).slice(0, options.limit ?? 200);
}

/** One channel's sweep: every due delivery on it, attempted once each. */
export async function deliverChannel(
  tx: Tx,
  channel: NotificationChannel,
  options: { readonly now?: Date; readonly limit?: number } = {},
): Promise<DeliverResult> {
  const due = await dueDeliveries(tx, channel, options);
  const result = { sent: 0, failed: 0, suppressed: 0, skipped: 0 };
  for (const { delivery, notification: row } of due) {
    const outcome = await attempt(tx, delivery, row);
    result[outcome] += 1;
  }
  return result;
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

/** HD6 — only the recipient marks a notification read; another id is a no-op. */
export async function markRead(tx: Tx, notificationId: bigint, recipientUserId: string): Promise<number> {
  const updated = await tx
    .update(notification)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notification.id, notificationId),
        eq(notification.recipientUserId, recipientUserId),
        isNull(notification.readAt),
      ),
    )
    .returning({ id: notification.id });
  return updated.length;
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
  // HD5 — across every recipient, through the definer function; the caller's
  // own policy would otherwise reach only its own copy.
  const result = await tx.execute(sql`select app_notification_mark_acted(${objectType}, ${objectId}) as n`);
  return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
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
  // HD5 — this is the system sweep the notification policy makes room for:
  // it reads everybody's outstanding tasks to escalate them.
  await markSystemSweep(tx);
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

      const escalationId = await insertNotification(tx, {
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
        context: row.notification.context as Record<string, unknown> | null,
        dedupeKey,
        branchCode: row.notification.branchCode,
      });

      if (escalationId === null) continue;
      // An escalation does not itself escalate. Without this the notice
      // raised here would come due on the next sweep and raise another,
      // and the chain would only stop when someone acted.
      await tx.update(notification).set({ escalatedAt: now }).where(eq(notification.id, escalationId));

      for (const channel of rule.channels) {
        await tx
          .insert(notificationDelivery)
          .values({ notificationId: escalationId, channel });
      }

      await jobs.enqueue(tx, null, {
        queueName: DELIVERY_QUEUE,
        payload: { notificationId: escalationId.toString() },
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

// ===========================================================================
// The notification centre — platform phase, Agent 6
// ===========================================================================
//
// One table, one runner, one bell. What follows is the part the bell, the
// /notifications screen, the Dashboard and the modules that raise things ask
// of this service:
//
//   emit(…)            the contract for a module that has something to say to
//                      named people — Exceptions, Automation, the Task Center
//   unreadCountFor,    what the bell and the Dashboard draw
//   countsFor,
//   listFor
//   markRead,          read state: stored per recipient, idempotent, and
//   markUnread,        never an audit row per click (see notification-center.ts
//   markAllRead        for the one bulk act that is audited)
//
// Where a notification leads is not decided here — `notification-center.ts`
// resolves it in the reader's own scope, when it is shown and when it is
// clicked.

export class NotificationError extends Error {
  readonly code = 'NOTIFICATION_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'NotificationError';
  }
}

/**
 * Runs a notification step so that its failure never reaches the business act
 * that caused it (§21: a notification can never change what the document is).
 * The step runs in a savepoint: whatever it wrote is undone with it, the
 * error is logged, and the caller carries on.
 */
export async function safely<T>(tx: Tx, step: (sp: Tx) => Promise<T>): Promise<T | null> {
  try {
    return await tx.transaction((savepoint) => step(savepoint as unknown as Tx));
  } catch (error) {
    console.error('[notifications] a notification step failed and was left out:', error instanceof Error ? error.message : error);
    return null;
  }
}

export interface EmitInput {
  /** The kind (`event_type`): an entry of `domain/notification-center.KINDS`, or a new one. */
  readonly kind: string;
  /** What it is about: the record's type and the id it is addressed by. */
  readonly objectType: string;
  readonly objectId: string;
  /** Who is told. Null and duplicates are dropped, `except` is removed. */
  readonly recipients: readonly (string | null | undefined)[];
  readonly except?: readonly (string | null | undefined)[];
  /** One plain line and the detail, stored as written: the fallback text when a kind has no label of its own. */
  readonly subject: string;
  readonly body?: string;
  /** Facts the label uses (`reference`, `party`, `days_overdue`, …) and, optionally, a local `href`. */
  readonly context?: Readonly<Record<string, unknown>>;
  /**
   * Which occurrence this is. Required for a kind whose window is
   * `occurrence` (a revision, a status entered, a sequence number); a `day`
   * kind uses the business day and a `once` kind none, unless named.
   */
  readonly occurrence?: string | null;
  readonly branchCode?: string | null;
  /** Also require that the recipient can open the record now (asked as them, in this transaction). */
  readonly recordAccess?: boolean;
  readonly actorUserId?: string | null;
}

export interface EmitResult {
  /** Rows written. */
  readonly created: number;
  /** Already told for this window: nothing written. */
  readonly suppressed: number;
  /** Not theirs to be told (no grant, no branch, inactive, cannot open the record). */
  readonly skipped: number;
  readonly ids: readonly bigint[];
}

/**
 * Tells named people, once per (recipient, kind, subject, window).
 *
 * The same key the rule path uses (`dedupeKeyOf`), the same unique index and
 * `ON CONFLICT DO NOTHING` inside `app_notify`: two calls — a refresh, a retry,
 * two requests at the same instant — write one row. The delivery channels of
 * any active rule for the kind reach the recipients holding the rule's role
 * through the same runner (`notification.deliver`); with no rule the
 * notification is the in-app row alone.
 */
export async function emit(tx: Tx, input: EmitInput): Promise<EmitResult> {
  if (!input.kind.trim()) throw new NotificationError('A notification names its kind.');
  if (!input.objectType.trim() || !input.objectId.trim()) throw new NotificationError(`${input.kind} names no subject (objectType, objectId).`);
  if (needsOccurrence(input.kind, input.occurrence)) {
    throw new NotificationError(
      `${input.kind} is told once per occurrence: name the occurrence (a revision, a status, a sequence number), or the second event on this subject would be dropped as a repeat.`,
    );
  }
  const window = windowToken(input.kind, { occurrence: input.occurrence ?? null, today: businessToday() });
  const skip = new Set((input.except ?? []).filter((id): id is string => Boolean(id)));
  const people = [...new Set(input.recipients.filter((id): id is string => Boolean(id) && !skip.has(id as string)))];

  const rules = people.length > 0 ? await rulesFor(tx, input.kind) : [];
  const channelsOf = new Map<string, NotificationChannel[]>();
  for (const rule of rules) {
    assertRule(rule);
    for (const userId of await recipientsOf(tx, rule.recipientRole)) {
      const list = channelsOf.get(userId) ?? [];
      for (const channel of rule.channels) if (!list.includes(channel)) list.push(channel);
      channelsOf.set(userId, list);
    }
  }

  let created = 0;
  let suppressed = 0;
  let skipped = 0;
  const ids: bigint[] = [];
  for (const recipientUserId of people) {
    if (input.recordAccess) {
      const { mayOpenAs } = await import('./notification-center');
      if (!(await mayOpenAs(tx, recipientUserId, input.objectType, input.objectId))) {
        skipped += 1;
        continue;
      }
    }
    const dedupeKey = dedupeKeyOf({ kind: input.kind, objectType: input.objectType, objectId: input.objectId, window, recipientUserId });
    const outcome = await tryInsertNotification(tx, {
      ruleCode: null,
      eventType: input.kind,
      objectType: input.objectType,
      objectId: input.objectId,
      recipientUserId,
      subject: input.subject,
      body: input.body ?? '',
      context: (input.context ?? null) as Record<string, unknown> | null,
      dedupeKey,
      branchCode: input.branchCode ?? null,
    });
    if (outcome.status === 'not_permitted') {
      skipped += 1;
      continue;
    }
    if (outcome.status === 'duplicate') {
      suppressed += 1;
      continue;
    }
    created += 1;
    ids.push(outcome.id);

    const channels = channelsOf.get(recipientUserId) ?? [];
    if (channels.length > 0) {
      for (const channel of channels) {
        await tx.insert(notificationDelivery).values({ notificationId: outcome.id, channel });
      }
      await jobs.enqueue(tx, input.actorUserId ?? null, {
        queueName: DELIVERY_QUEUE,
        payload: { notificationId: outcome.id.toString() },
        idempotencyKey: dedupeKey,
        branchCode: input.branchCode ?? null,
      });
    }
  }
  return { created, suppressed, skipped, ids };
}

// ---------------------------------------------------------------------------
// Reading: the bell and the screen
// ---------------------------------------------------------------------------

export interface NotificationItem {
  readonly id: string;
  readonly kind: string;
  readonly category: NotificationCategory;
  readonly objectType: string;
  readonly objectId: string;
  readonly subject: string;
  readonly body: string;
  readonly context: Record<string, unknown> | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
  readonly actedAt: Date | null;
  readonly branchCode: string | null;
}

export type ReadState = 'unread' | 'all';

export interface ListOptions {
  readonly state?: ReadState | null;
  readonly category?: NotificationCategory | null;
  readonly q?: string | null;
  readonly page?: number | null;
  readonly pageSize?: number | null;
}

export interface CategoryCount {
  readonly category: NotificationCategory;
  readonly unread: number;
  readonly total: number;
}

export interface NotificationCounts {
  readonly unread: number;
  readonly total: number;
  /** Every category, in the registry's order, with the ones that hold nothing at zero. */
  readonly categories: readonly CategoryCount[];
}

/** The categories a notification can belong to, in the order the bell and the screen list them. */
export function categories(): readonly NotificationCategory[] {
  return NOTIFICATION_CATEGORIES;
}

function kindsPredicate(match: { readonly exact: readonly string[]; readonly prefixes: readonly string[] }): SQL | null {
  const parts: SQL[] = [];
  if (match.exact.length > 0) parts.push(sql`n.event_type in (${sql.join(match.exact.map((kind) => sql`${kind}`), sql`, `)})`);
  for (const prefix of match.prefixes) parts.push(sql`starts_with(n.event_type, ${prefix})`);
  return parts.length === 0 ? null : sql`(${sql.join(parts, sql` or `)})`;
}

/** The SQL for "this notification is in that category", built from the registry. */
function categoryPredicate(category: NotificationCategory): SQL | null {
  if (category === 'system') {
    const others = kindsPredicate(claimedByOthers());
    return others === null ? null : sql`not ${others}`;
  }
  return kindsPredicate(matchOf(category)) ?? sql`false`;
}

/** How many are waiting for this person. One indexed count: the bell asks it on every poll. */
export async function unreadCountFor(tx: Tx, userId: string): Promise<number> {
  const result = await tx.execute(
    sql`select count(*)::int as n from notification where recipient_user_id = ${userId}::uuid and read_at is null`,
  );
  return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
}

/** Unread and total, overall and per category — the tabs of the bell and the screen's filter. */
export async function countsFor(tx: Tx, userId: string): Promise<NotificationCounts> {
  const result = await tx.execute(sql`
    select event_type, count(*)::int as total, (count(*) filter (where read_at is null))::int as unread
      from notification
     where recipient_user_id = ${userId}::uuid
     group by event_type`);
  const by = new Map<NotificationCategory, { unread: number; total: number }>(
    NOTIFICATION_CATEGORIES.map((category) => [category, { unread: 0, total: 0 }]),
  );
  let unread = 0;
  let total = 0;
  for (const row of result.rows as { event_type: string; total: number; unread: number }[]) {
    const entry = by.get(categoryOf(row.event_type))!;
    entry.total += Number(row.total);
    entry.unread += Number(row.unread);
    total += Number(row.total);
    unread += Number(row.unread);
  }
  return { unread, total, categories: NOTIFICATION_CATEGORIES.map((category) => ({ category, ...by.get(category)! })) };
}

interface ListRow {
  id: string;
  event_type: string;
  object_type: string;
  object_id: string;
  subject: string;
  body: string;
  context: Record<string, unknown> | null;
  created_at: Date;
  read_at: Date | null;
  acted_at: Date | null;
  branch_code: string | null;
}

function itemOf(row: ListRow): NotificationItem {
  return {
    id: String(row.id),
    kind: row.event_type,
    category: categoryOf(row.event_type),
    objectType: row.object_type,
    objectId: row.object_id,
    subject: row.subject,
    body: row.body,
    context: row.context,
    createdAt: new Date(row.created_at),
    readAt: row.read_at ? new Date(row.read_at) : null,
    actedAt: row.acted_at ? new Date(row.acted_at) : null,
    branchCode: row.branch_code,
  };
}

/**
 * This person's notifications, newest first, paged at fifty with a true count
 * (`register-page`). Always `recipient_user_id = userId` — the policy says the
 * same (C-70); asking for it in the query as well means a caller in a sweep's
 * transaction still gets only the one person's.
 */
export async function listFor(tx: Tx, userId: string, options: ListOptions = {}): Promise<RegisterPage<NotificationItem>> {
  const parts: (SQL | null)[] = [sql`n.recipient_user_id = ${userId}::uuid`];
  if (options.state === 'unread') parts.push(sql`n.read_at is null`);
  if (options.category) parts.push(categoryPredicate(options.category));
  const needle = (options.q ?? '').trim();
  if (needle) {
    const pattern = `%${needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    parts.push(sql`(n.subject ilike ${pattern} escape '\\' or n.body ilike ${pattern} escape '\\' or n.object_id ilike ${pattern} escape '\\')`);
  }
  const where = whereOf(parts);
  return registerPage<NotificationItem>({
    paging: { page: options.page ?? 1, pageSize: options.pageSize ?? null },
    count: () => countOf(tx, sql`from notification n ${where}`),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select n.id::text as id, n.event_type, n.object_type, n.object_id, n.subject, n.body, n.context,
               n.created_at, n.read_at, n.acted_at, n.branch_code
          from notification n
          ${where}
         order by n.created_at desc, n.id desc
         limit ${limit} offset ${offset}`);
      return (result.rows as unknown as ListRow[]).map(itemOf);
    },
  });
}

/** One notification of this person's, by id; null when it is not theirs or does not exist. */
export async function findFor(tx: Tx, userId: string, id: bigint): Promise<NotificationItem | null> {
  const result = await tx.execute(sql`
    select n.id::text as id, n.event_type, n.object_type, n.object_id, n.subject, n.body, n.context,
           n.created_at, n.read_at, n.acted_at, n.branch_code
      from notification n
     where n.id = ${id.toString()}::bigint and n.recipient_user_id = ${userId}::uuid`);
  const row = result.rows[0] as unknown as ListRow | undefined;
  return row ? itemOf(row) : null;
}

// ---------------------------------------------------------------------------
// Read state — stored per recipient, idempotent
// ---------------------------------------------------------------------------

/** Mark as unread again. A no-op (0) when it is not theirs or is unread already. */
export async function markUnread(tx: Tx, notificationId: bigint, recipientUserId: string): Promise<number> {
  const updated = await tx
    .update(notification)
    .set({ readAt: null })
    .where(
      and(
        eq(notification.id, notificationId),
        eq(notification.recipientUserId, recipientUserId),
        sql`${notification.readAt} is not null`,
      ),
    )
    .returning({ id: notification.id });
  return updated.length;
}

/** Several at once (the screen's selection); the count is those that changed. */
export async function markManyRead(tx: Tx, notificationIds: readonly bigint[], recipientUserId: string): Promise<number> {
  if (notificationIds.length === 0) return 0;
  const updated = await tx
    .update(notification)
    .set({ readAt: new Date() })
    .where(
      and(
        inArray(notification.id, [...notificationIds]),
        eq(notification.recipientUserId, recipientUserId),
        isNull(notification.readAt),
      ),
    )
    .returning({ id: notification.id });
  return updated.length;
}

/** Everything unread of theirs — or of one category — marked read; the count is how many changed. */
export async function markAllRead(
  tx: Tx,
  recipientUserId: string,
  options: { readonly category?: NotificationCategory | null } = {},
): Promise<number> {
  const parts: (SQL | null)[] = [sql`n.recipient_user_id = ${recipientUserId}::uuid`, sql`n.read_at is null`];
  if (options.category) parts.push(categoryPredicate(options.category));
  const result = await tx.execute(sql`update notification n set read_at = now() ${whereOf(parts)} returning n.id`);
  return result.rows.length;
}

export { lte, role };
