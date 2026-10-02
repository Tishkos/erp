/**
 * The WhatsApp bridge — REQ-WA-001 (WA-1, WA-2).
 *
 * Four tables, and the shape of them is the requirement's boundary:
 *
 *   whatsapp_contact   who may be reached, and who may ask (W-R3): one row
 *                      per user, one number per row, deactivated never deleted
 *   whatsapp_session   the Baileys pairing — credentials and signal keys —
 *                      so a restart does not mean a new QR code
 *   whatsapp_message   every message in or out, with what was decided about
 *                      it (W-R4 made readable); bodies are blanked after the
 *                      retention period (D-WA-8), rows stay
 *   whatsapp_setting   the few knobs the sponsor turns: models, limits,
 *                      throttle — key/value, like `app_setting`
 *
 * Nothing here is joined into an approval or a posting. A message is text
 * about a document, by its number, and the worst it can do is be read.
 */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { appUser } from './platform';
import { notificationDelivery } from './notifications';

export const whatsappContact = pgTable(
  'whatsapp_contact',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    /** E.164, with the plus: +9647xxxxxxxxx. The allow-list reads this. */
    e164: text('e164').notNull(),
    /** Receives the notifications the rules send over the `whatsapp` channel. */
    allowNotifications: boolean('allow_notifications').notNull().default(true),
    /**
     * May ask questions. Granted only to a user holding the `ceo` role
     * (D-WA-3 as ratified: "only ceo role"); the service refuses otherwise,
     * and the bridge checks the role again on every message.
     */
    allowQueries: boolean('allow_queries').notNull().default(false),
    /** Receives the morning digest (WA-4). */
    allowDigest: boolean('allow_digest').notNull().default(false),
    active: boolean('active').notNull().default(true),
    deactivatedReason: text('deactivated_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid('created_by').references(() => appUser.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('whatsapp_contact_user_uniq').on(t.userId),
    uniqueIndex('whatsapp_contact_e164_uniq').on(t.e164),
    check('whatsapp_contact_e164_format', sql`${t.e164} ~ '^\\+[1-9][0-9]{7,14}$'`),
  ],
);

/** Baileys' authentication state, one row per key. */
export const whatsappSession = pgTable('whatsapp_session', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const WHATSAPP_DIRECTIONS = ['in', 'out'] as const;
export type WhatsappDirection = (typeof WHATSAPP_DIRECTIONS)[number];

/**
 * How a message ended:
 *   in  — received → answered | refused (W-R2/W-R3: no reply) | failed
 *   out — pending → sent | failed
 */
export const WHATSAPP_MESSAGE_STATUSES = ['received', 'answered', 'refused', 'failed', 'pending', 'sent'] as const;
export type WhatsappMessageStatus = (typeof WHATSAPP_MESSAGE_STATUSES)[number];

export const whatsappMessage = pgTable(
  'whatsapp_message',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    direction: text('direction').notNull(),
    /** The other party's number, E.164. */
    e164: text('e164').notNull(),
    /** The contact the number resolved to, null for an unlisted sender. */
    contactId: uuid('contact_id').references(() => whatsappContact.id),
    userId: uuid('user_id').references(() => appUser.id),
    /** WhatsApp's own id for the message, when known. */
    waMessageId: text('wa_message_id'),
    /** The text, blanked after retention (D-WA-8). */
    body: text('body'),
    /** For an outbound document: the file name and type sent as the caption's attachment. */
    attachmentName: text('attachment_name'),
    attachmentType: text('attachment_type'),
    attachmentBytes: integer('attachment_bytes'),
    /** For an inbound question: the intent the router chose, or `agent`, or `none`. */
    intent: text('intent'),
    /** The parameters the intent ran with, and for an answer the figures' source. */
    detail: jsonb('detail'),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
    /** The inbound message an outbound one answers. */
    inReplyTo: bigint('in_reply_to', { mode: 'bigint' }),
    /** The notification delivery an outbound message carries. */
    deliveryId: bigint('delivery_id', { mode: 'bigint' }).references(() => notificationDelivery.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /** When the body was blanked by retention. */
    redactedAt: timestamp('redacted_at', { withTimezone: true }),
  },
  (t) => [
    index('whatsapp_message_status_idx').on(t.direction, t.status, t.createdAt),
    index('whatsapp_message_created_idx').on(t.createdAt),
    check('whatsapp_message_direction', sql`${t.direction} in ('in', 'out')`),
    check(
      'whatsapp_message_status',
      sql`${t.status} in ('received', 'answered', 'refused', 'failed', 'pending', 'sent')`,
    ),
    check('whatsapp_message_error_matches', sql`(${t.status} = 'failed') = (${t.errorMessage} is not null)`),
  ],
);

export const whatsappSetting = pgTable('whatsapp_setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => appUser.id),
});
