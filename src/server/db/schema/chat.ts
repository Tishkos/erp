/**
 * Internal chat — platform phase, Agent 1 (migrations 0310–0311).
 *
 * Six tables; the rules that matter are the database's (0310): membership by
 * row-level security, receipts forward-only, messages never edited or deleted,
 * a participant's row never deleted. `services/chat.ts` is the only writer.
 *
 *   chat_conversation  direct or group, optionally tied to an ERP record
 *   chat_participant   who is in it, since which message, muted, typing
 *   chat_message       what was said; withdrawn with a reason, never removed
 *   chat_receipt       delivered_at / seen_at per message per recipient
 *   chat_reaction      one code per person per message
 *   chat_presence      the heartbeat Online / Away / Busy / Offline derive from
 */
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appUser } from './platform';

export const chatConversation = pgTable(
  'chat_conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    title: text('title'),
    /** The audit object type and id the record's history is kept under. */
    recordType: text('record_type'),
    recordId: text('record_id'),
    recordLabel: text('record_label'),
    recordHref: text('record_href'),
    memberKey: text('member_key'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    rev: bigint('rev', { mode: 'number' }).notNull().default(0),
  },
  (t) => [index('chat_conversation_record_idx').on(t.recordType, t.recordId)],
);

export const chatParticipant = pgTable(
  'chat_participant',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversation.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    firstSeq: bigint('first_seq', { mode: 'number' }).notNull().default(1),
    leftAt: timestamp('left_at', { withTimezone: true }),
    muted: boolean('muted').notNull().default(false),
    typingUntil: timestamp('typing_until', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] })],
);

export const chatMessage = pgTable(
  'chat_message',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversation.id),
    /** Assigned by the before-insert trigger from the conversation's counter. */
    seq: bigint('seq', { mode: 'number' }).notNull().default(0),
    kind: text('kind').notNull().default('text'),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => appUser.id),
    body: text('body').notNull().default(''),
    meta: jsonb('meta'),
    replyToId: uuid('reply_to_id'),
    mentions: uuid('mentions')
      .array()
      .notNull()
      .default(sql`'{}'`),
    clientId: uuid('client_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retractedAt: timestamp('retracted_at', { withTimezone: true }),
    retractedBy: uuid('retracted_by').references(() => appUser.id),
    retractReason: text('retract_reason'),
  },
  (t) => [uniqueIndex('chat_message_seq_uniq').on(t.conversationId, t.seq)],
);

export const chatReceipt = pgTable(
  'chat_receipt',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessage.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversation.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    seenAt: timestamp('seen_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] })],
);

export const chatReaction = pgTable(
  'chat_reaction',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => chatMessage.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => chatConversation.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    reaction: text('reaction').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId, t.reaction] })],
);

export const chatPresence = pgTable('chat_presence', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => appUser.id),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
  busy: boolean('busy').notNull().default(false),
  /** What the person chose: available, busy, away or invisible ("appear offline") — 0410; `busy` follows it. */
  status: text('status').notNull().default('available'),
});
