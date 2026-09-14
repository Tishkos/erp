/**
 * Notifications — Phase 01.9.
 *
 * §21: "Notification rules must suppress duplicates, record delivery status and
 * allow escalation if a task is not acted upon."
 *
 * Three tables, and the shape of them is the §21 boundary: a `notification`
 * references a document by type and id **as text**, with no foreign key into
 * the workflow. Nothing here can be joined into an approval decision, and
 * nothing the approval engine reads comes from here. A missed e-mail cannot
 * change an approval requirement because there is no column through which it
 * could.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { DELIVERY_STATUSES, NOTIFICATION_CHANNELS } from '../../domain/notifications';
import { appUser } from './platform';

export const notificationChannel = pgEnum('notification_channel', NOTIFICATION_CHANNELS);
export const deliveryStatus = pgEnum('notification_delivery_status', DELIVERY_STATUSES);

export const notificationRule = pgTable(
  'notification_rule',
  {
    code: text('code').primaryKey(),
    description: text('description'),
    /** The event that qualifies, e.g. 'journal_entry.submitted'. */
    eventType: text('event_type').notNull(),
    /** The role told about it. Resolved to people when the event happens. */
    recipientRole: text('recipient_role').notNull(),
    channels: text('channels').array().notNull(),

    /** §21 — chase it after this long. Null for information, not a task. */
    escalateAfterSeconds: integer('escalate_after_seconds'),
    escalateToRole: text('escalate_to_role'),

    active: boolean('active').notNull().default(true),
  },
  (t) => [
    index('notification_rule_event_idx').on(t.eventType).where(sql`${t.active}`),
    check('notification_rule_has_channel', sql`array_length(${t.channels}, 1) >= 1`),
    // An escalation with nowhere to go is a timer firing into nothing.
    check(
      'notification_rule_escalation_complete',
      sql`(${t.escalateAfterSeconds} is null) = (${t.escalateToRole} is null)`,
    ),
    check(
      'notification_rule_escalation_positive',
      sql`${t.escalateAfterSeconds} is null or ${t.escalateAfterSeconds} > 0`,
    ),
  ],
);

export const notification = pgTable(
  'notification',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    /**
     * The §21 rule that raised this, or null when it was sent to somebody who
     * asked to be told rather than to a role the rules name — Operations
     * block 8.
     */
    ruleCode: text('rule_code')
      .references(() => notificationRule.code),

    eventType: text('event_type').notNull(),
    /**
     * The document, as loose text. Deliberately not a foreign key: this table
     * must not be joinable into an approval decision (§21).
     */
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),

    recipientUserId: uuid('recipient_user_id')
      .notNull()
      .references(() => appUser.id),

    subject: text('subject').notNull(),
    body: text('body').notNull(),
    context: jsonb('context'),

    /**
     * §21 — duplicate suppression. Deterministic, so the same event recomputed
     * after a retry produces the same key and the unique index recognises it.
     * At-least-once job delivery makes a repeat normal, not exceptional.
     */
    dedupeKey: text('dedupe_key').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    /**
     * When the recipient did the thing — not when they read about it. §21
     * escalates a task that is "not acted upon", and someone opening an e-mail
     * and doing nothing is exactly that case.
     */
    actedAt: timestamp('acted_at', { withTimezone: true }),

    escalatedAt: timestamp('escalated_at', { withTimezone: true }),
    escalatedToUserId: uuid('escalated_to_user_id').references(() => appUser.id),
    branchCode: text('branch_code'),
  },
  (t) => [
    // The §21 acceptance criterion, as an index: one notification per
    // qualifying event per recipient, whatever happens upstream.
    uniqueIndex('notification_dedupe_uniq').on(t.dedupeKey),
    index('notification_inbox_idx').on(t.recipientUserId, t.createdAt),
    index('notification_object_idx').on(t.objectType, t.objectId),
    // The escalation sweep's own query.
    index('notification_escalation_idx')
      .on(t.createdAt)
      .where(sql`${t.actedAt} is null and ${t.escalatedAt} is null`),
  ],
);

/**
 * §21 — "record delivery status."
 *
 * One row per channel per notification, so an e-mail failing does not hide
 * that the in-app copy arrived. Append-only in effect: an attempt is recorded,
 * never revised, because "we tried and it failed" is the thing worth keeping.
 */
export const notificationDelivery = pgTable(
  'notification_delivery',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    notificationId: bigint('notification_id', { mode: 'bigint' })
      .notNull()
      .references(() => notification.id, { onDelete: 'cascade' }),

    channel: notificationChannel('channel').notNull(),
    status: deliveryStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),

    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    errorMessage: text('error_message'),
  },
  (t) => [
    uniqueIndex('notification_delivery_channel_uniq').on(t.notificationId, t.channel),
    index('notification_delivery_status_idx').on(t.status, t.lastAttemptAt),
    check(
      'notification_delivery_delivered_at_matches',
      sql`(${t.status} = 'sent') = (${t.deliveredAt} is not null)`,
    ),
    check(
      'notification_delivery_error_matches',
      sql`(${t.status} = 'failed') = (${t.errorMessage} is not null)`,
    ),
    check('notification_delivery_attempts_non_negative', sql`${t.attempts} >= 0`),
  ],
);
