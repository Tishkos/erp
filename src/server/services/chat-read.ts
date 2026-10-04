/**
 * Internal chat — the reader (platform phase, Agent 1).
 *
 * Everything the screen draws, built from rows the database already filtered:
 * every query here runs in the asking person's own scope, so row-level
 * security (0310) removes what they are not in before this file sees it. It
 * asks `membership` first anyway, so a stranger gets one plain refusal rather
 * than an empty conversation that proves one exists.
 *
 * `sync` is what a page calls every few seconds. It carries the page's
 * acknowledgements in (what reached the browser, what was read on screen) and
 * brings the list, the open thread and the typing indicator back. There is
 * one request, one transaction and one answer; nothing is pushed.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, attachment, chatConversation, chatMessage, chatParticipant, chatPresence, chatReaction, chatReceipt } from '../db/schema';
import {
  CHAT_PAGE_SIZE,
  ChatError,
  badgeTotal,
  isTyping,
  likePattern,
  messageStatus,
  preview,
  presenceOf,
  previewKind,
  searchTerm,
  type MessageStatus,
  type Presence,
} from '../domain/chat';
import * as attachments from './attachments';
import type { ActorContext } from './chart-of-accounts';
import * as chat from './chat';

const me = (ctx: ActorContext): string => ctx.principal.userId;
const uuidList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

// ---------------------------------------------------------------------------
// The shapes the screen receives (plain JSON)
// ---------------------------------------------------------------------------

export interface PersonView {
  readonly userId: string;
  readonly name: string;
  readonly role?: 'owner' | 'member';
  readonly presence: Presence;
  readonly lastSeenAt: string | null;
}

export interface LastMessageView {
  readonly id: string;
  readonly seq: number;
  readonly kind: 'text' | 'system';
  readonly senderId: string;
  readonly senderName: string;
  /** The text, or the system line's event code; empty for a withdrawn message. */
  readonly preview: string;
  readonly retracted: boolean;
  readonly fileCount: number;
  readonly createdAt: string;
}

export interface ConversationRow {
  readonly id: string;
  readonly kind: 'direct' | 'group';
  /** The group's name, or the other person's. */
  readonly name: string;
  readonly rev: number;
  readonly lastSeq: number;
  readonly lastMessageAt: string | null;
  readonly lastMessage: LastMessageView | null;
  readonly unread: number;
  readonly mentioned: boolean;
  readonly muted: boolean;
  readonly aboutRecord: boolean;
  readonly memberCount: number;
  /** For a direct conversation, the other person. */
  readonly other: PersonView | null;
}

export interface FileView {
  readonly id: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly kind: 'image' | 'pdf' | 'file';
}

export interface ReactionView {
  readonly reaction: string;
  readonly count: number;
  readonly mine: boolean;
  readonly names: string[];
}

export interface QuoteView {
  readonly id: string;
  readonly seq: number;
  readonly senderName: string;
  readonly preview: string;
  readonly retracted: boolean;
  /** False when the quoted message is older than this person's first. */
  readonly available: boolean;
}

export interface ReceiptView {
  readonly userId: string;
  readonly name: string;
  readonly deliveredAt: string | null;
  readonly seenAt: string | null;
}

export interface MessageView {
  readonly id: string;
  readonly seq: number;
  readonly kind: 'text' | 'system';
  readonly senderId: string;
  readonly senderName: string;
  readonly mine: boolean;
  /** Empty when the message was withdrawn. */
  readonly body: string;
  readonly meta: Record<string, unknown> | null;
  readonly createdAt: string;
  readonly retracted: { readonly at: string; readonly byName: string; readonly reason: string } | null;
  readonly mentionsMe: boolean;
  readonly mentionNames: string[];
  /** The browser's id for a message this person sent, so a pending copy and the stored one are one. */
  readonly clientId: string | null;
  readonly replyTo: QuoteView | null;
  readonly files: FileView[];
  readonly reactions: ReactionView[];
  /** Sender's view of how far it has got; null for other people's messages. */
  readonly status: MessageStatus | null;
  readonly receipts: ReceiptView[];
}

/**
 * What a member is told about the record a conversation is about: everything
 * when they can open it, and nothing at all — not its type, id or name — when
 * they cannot.
 */
export type RecordView =
  | { readonly accessible: true; readonly type: string; readonly id: string; readonly label: string; readonly href: string | null }
  | { readonly accessible: false };

export interface ThreadView {
  readonly id: string;
  readonly kind: 'direct' | 'group';
  readonly name: string;
  readonly title: string | null;
  readonly rev: number;
  readonly lastSeq: number;
  readonly muted: boolean;
  readonly role: 'owner' | 'member';
  readonly members: PersonView[];
  readonly record: RecordView | null;
  readonly messages: MessageView[];
  readonly hasMore: boolean;
  readonly typing: string[];
  /** The oldest message this person has not seen — where "unread" begins on opening. */
  readonly firstUnseenSeq: number | null;
}

// ---------------------------------------------------------------------------
// People and presence
// ---------------------------------------------------------------------------

async function presenceMap(tx: Tx, userIds: readonly string[], now: Date) {
  const map = new Map<string, { presence: Presence; lastSeenAt: string | null }>();
  if (userIds.length === 0) return map;
  // The presence policy lets a person read their own and that of people they share a conversation with.
  const rows = await tx.select().from(chatPresence).where(inArray(chatPresence.userId, [...userIds]));
  for (const row of rows) {
    const view = presenceOf(
      { lastSeenAt: row.lastSeenAt.toISOString(), lastActiveAt: row.lastActiveAt?.toISOString() ?? null, busy: row.busy },
      now,
    );
    map.set(row.userId, { presence: view.state, lastSeenAt: view.lastSeenAt });
  }
  return map;
}

const personOf = (
  map: Map<string, { presence: Presence; lastSeenAt: string | null }>,
  userId: string,
  name: string,
  role?: 'owner' | 'member',
): PersonView => ({
  userId,
  name,
  ...(role ? { role } : {}),
  presence: map.get(userId)?.presence ?? 'offline',
  lastSeenAt: map.get(userId)?.lastSeenAt ?? null,
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export async function listConversations(tx: Tx, ctx: ActorContext, now = new Date()): Promise<ConversationRow[]> {
  const mine = await tx
    .select({
      id: chatConversation.id,
      kind: chatConversation.kind,
      title: chatConversation.title,
      rev: chatConversation.rev,
      lastSeq: chatConversation.lastSeq,
      lastMessageAt: chatConversation.lastMessageAt,
      recordType: chatConversation.recordType,
      muted: chatParticipant.muted,
    })
    .from(chatParticipant)
    .innerJoin(chatConversation, eq(chatConversation.id, chatParticipant.conversationId))
    .where(and(eq(chatParticipant.userId, me(ctx)), isNull(chatParticipant.leftAt)))
    .orderBy(desc(sql`coalesce(${chatConversation.lastMessageAt}, ${chatConversation.createdAt})`), asc(chatConversation.id))
    .limit(200);
  if (mine.length === 0) return [];
  const ids = mine.map((c) => c.id);

  // One connection runs one statement at a time; these are asked in turn.
  const unreadRows = await tx.execute(sql`
      select r.conversation_id::text as id, count(*)::int as n, bool_or(${me(ctx)}::uuid = any(m.mentions)) as mentioned
        from chat_receipt r
        join chat_message m on m.id = r.message_id
       where r.user_id = ${me(ctx)}::uuid and r.seen_at is null and m.retracted_at is null
         and r.conversation_id in (${uuidList(ids)})
       group by r.conversation_id`);
  const lastRows = await tx.execute(sql`
      select distinct on (m.conversation_id)
             m.conversation_id::text as conversation_id, m.id::text as id, m.seq, m.kind, m.body, m.sender_id::text as sender_id,
             m.retracted_at, m.created_at, u.display_name as sender_name
        from chat_message m
        join app_user u on u.id = m.sender_id
       where m.conversation_id in (${uuidList(ids)})
       order by m.conversation_id, m.seq desc`);
  const memberRows = await tx.execute(sql`
      select p.conversation_id::text as conversation_id, p.user_id::text as user_id, u.display_name as name
        from chat_participant p
        join app_user u on u.id = p.user_id
       where p.conversation_id in (${uuidList(ids)}) and p.left_at is null`);

  const unread = new Map((unreadRows.rows as { id: string; n: number; mentioned: boolean }[]).map((r) => [r.id, r]));
  const lasts = new Map(
    (lastRows.rows as {
      conversation_id: string; id: string; seq: string; kind: 'text' | 'system'; body: string; sender_id: string;
      retracted_at: Date | null; created_at: Date; sender_name: string;
    }[]).map((r) => [r.conversation_id, r]),
  );
  const membersBy = new Map<string, { userId: string; name: string }[]>();
  for (const r of memberRows.rows as { conversation_id: string; user_id: string; name: string }[]) {
    const list = membersBy.get(r.conversation_id) ?? [];
    list.push({ userId: r.user_id, name: r.name });
    membersBy.set(r.conversation_id, list);
  }

  const lastIds = [...lasts.values()].filter((l) => l.kind === 'text').map((l) => l.id);
  const fileCounts = new Map<string, number>();
  if (lastIds.length > 0) {
    const files = await tx
      .select({ objectId: attachment.objectId })
      .from(attachment)
      .where(
        and(
          eq(attachment.objectType, chat.MESSAGE_OBJECT),
          inArray(attachment.objectId, lastIds),
          eq(attachment.scanStatus, 'clean'),
          isNull(attachment.supersededById),
          isNull(attachment.disposedAt),
        ),
      );
    for (const f of files) fileCounts.set(f.objectId, (fileCounts.get(f.objectId) ?? 0) + 1);
  }

  const partners = mine
    .filter((c) => c.kind === 'direct')
    .map((c) => (membersBy.get(c.id) ?? []).find((m) => m.userId !== me(ctx))?.userId)
    .filter((id): id is string => Boolean(id));
  const presence = await presenceMap(tx, partners, now);

  return mine.map((c): ConversationRow => {
    const members = membersBy.get(c.id) ?? [];
    const partner = c.kind === 'direct' ? members.find((m) => m.userId !== me(ctx)) : undefined;
    const last = lasts.get(c.id);
    const retracted = Boolean(last?.retracted_at);
    const counts = unread.get(c.id);
    return {
      id: c.id,
      kind: c.kind as 'direct' | 'group',
      name: c.kind === 'direct' ? (partner?.name ?? '') : (c.title ?? ''),
      rev: Number(c.rev),
      lastSeq: Number(c.lastSeq),
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      lastMessage: last
        ? {
            id: last.id,
            seq: Number(last.seq),
            kind: last.kind,
            senderId: last.sender_id,
            senderName: last.sender_name,
            preview: retracted ? '' : preview(last.body, 90),
            retracted,
            fileCount: fileCounts.get(last.id) ?? 0,
            createdAt: new Date(last.created_at).toISOString(),
          }
        : null,
      unread: counts?.n ?? 0,
      mentioned: counts?.mentioned ?? false,
      muted: c.muted,
      aboutRecord: c.recordType !== null,
      memberCount: members.length,
      other: partner ? personOf(presence, partner.userId, partner.name) : null,
    };
  });
}

/** What the header badge shows: the unread of every conversation that is not muted. */
export const badgeOf = (rows: readonly ConversationRow[]): number => badgeTotal(rows);

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

export interface ThreadOptions {
  /** Messages older than this number (for "earlier"). */
  readonly beforeSeq?: number | null;
  readonly limit?: number;
}

export async function threadOf(
  tx: Tx,
  ctx: ActorContext,
  conversationId: string,
  options: ThreadOptions = {},
  now = new Date(),
): Promise<ThreadView> {
  const mine = await chat.membership(tx, ctx, conversationId);
  const [conversation] = await tx.select().from(chatConversation).where(eq(chatConversation.id, conversationId)).limit(1);
  if (!conversation) throw new ChatError(chat.NOT_IN_CONVERSATION);

  const members = await chat.activeMembers(tx, conversationId);
  const presence = await presenceMap(tx, members.map((m) => m.userId), now);
  const partner = conversation.kind === 'direct' ? members.find((m) => m.userId !== me(ctx)) : undefined;

  const messages = await messageWindow(tx, ctx, conversationId, mine.firstSeq, options);

  let record: RecordView | null = null;
  if (conversation.recordType && conversation.recordId) {
    // A record is shown to a member who could open it from its own screen, and to nobody else.
    const accessible = await chat.mayOpenRecord(tx, ctx, conversation.recordType, conversation.recordId);
    record = accessible
      ? {
          accessible: true,
          type: conversation.recordType,
          id: conversation.recordId,
          label: conversation.recordLabel ?? conversation.recordId,
          href: conversation.recordHref,
        }
      : { accessible: false };
  }

  const typingRows = await tx
    .select({ userId: chatParticipant.userId, until: chatParticipant.typingUntil })
    .from(chatParticipant)
    .where(and(eq(chatParticipant.conversationId, conversationId), isNull(chatParticipant.leftAt)));
  const typing = typingRows
    .filter((r) => r.userId !== me(ctx) && isTyping(r.until?.toISOString(), now))
    .map((r) => members.find((m) => m.userId === r.userId)?.name ?? '')
    .filter(Boolean);

  const first = await tx.execute(sql`select app_chat_first_unseen(${conversationId}::uuid, ${me(ctx)}::uuid) as seq`);
  const firstUnseen = (first.rows[0] as { seq: string | null } | undefined)?.seq ?? null;

  return {
    id: conversation.id,
    kind: conversation.kind as 'direct' | 'group',
    name: conversation.kind === 'direct' ? (partner?.name ?? '') : (conversation.title ?? ''),
    title: conversation.title,
    rev: Number(conversation.rev),
    lastSeq: Number(conversation.lastSeq),
    muted: mine.muted,
    role: mine.role,
    members: members.map((m) => personOf(presence, m.userId, m.name, m.role)),
    record,
    messages: messages.messages,
    hasMore: messages.hasMore,
    typing,
    firstUnseenSeq: firstUnseen === null ? null : Number(firstUnseen),
  };
}

/** One page of older messages — "earlier" on a long conversation. */
export async function earlier(
  tx: Tx,
  ctx: ActorContext,
  conversationId: string,
  beforeSeq: number,
  limit = CHAT_PAGE_SIZE,
): Promise<{ messages: MessageView[]; hasMore: boolean }> {
  const mine = await chat.membership(tx, ctx, conversationId);
  return messageWindow(tx, ctx, conversationId, mine.firstSeq, { beforeSeq, limit });
}

async function messageWindow(
  tx: Tx,
  ctx: ActorContext,
  conversationId: string,
  firstSeq: number,
  options: ThreadOptions,
): Promise<{ messages: MessageView[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(options.limit ?? CHAT_PAGE_SIZE, 1), 200);
  const rows = await tx
    .select({
      id: chatMessage.id,
      seq: chatMessage.seq,
      kind: chatMessage.kind,
      senderId: chatMessage.senderId,
      senderName: appUser.displayName,
      body: chatMessage.body,
      meta: chatMessage.meta,
      replyToId: chatMessage.replyToId,
      mentions: chatMessage.mentions,
      clientId: chatMessage.clientId,
      createdAt: chatMessage.createdAt,
      retractedAt: chatMessage.retractedAt,
      retractedBy: chatMessage.retractedBy,
      retractReason: chatMessage.retractReason,
    })
    .from(chatMessage)
    .innerJoin(appUser, eq(appUser.id, chatMessage.senderId))
    .where(
      and(
        eq(chatMessage.conversationId, conversationId),
        gte(chatMessage.seq, firstSeq),
        options.beforeSeq ? lt(chatMessage.seq, options.beforeSeq) : undefined,
      ),
    )
    .orderBy(desc(chatMessage.seq))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const window = rows.slice(0, limit).reverse();
  if (window.length === 0) return { messages: [], hasMore };

  const textIds = window.filter((r) => r.kind === 'text').map((r) => r.id);
  const mineIds = window.filter((r) => r.kind === 'text' && r.senderId === me(ctx)).map((r) => r.id);

  // Who withdrew, by name (always the sender today, but the table says "by").
  const names = new Map<string, string>();
  const nameOf = async (userIds: readonly string[]) => {
    const missing = [...new Set(userIds)].filter((id) => !names.has(id));
    if (missing.length === 0) return;
    const found = await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, missing));
    for (const f of found) names.set(f.id, f.name);
  };
  for (const r of window) names.set(r.senderId, r.senderName);
  await nameOf(window.flatMap((r) => (r.retractedBy ? [r.retractedBy] : [])).concat(window.flatMap((r) => r.mentions)));

  // The messages replied to, wherever they sit in the conversation.
  const quoted = new Map<string, QuoteView>();
  const replyIds = [...new Set(window.flatMap((r) => (r.replyToId ? [r.replyToId] : [])))];
  if (replyIds.length > 0) {
    const found = await tx
      .select({
        id: chatMessage.id,
        seq: chatMessage.seq,
        body: chatMessage.body,
        senderName: appUser.displayName,
        retractedAt: chatMessage.retractedAt,
      })
      .from(chatMessage)
      .innerJoin(appUser, eq(appUser.id, chatMessage.senderId))
      .where(and(inArray(chatMessage.id, replyIds), eq(chatMessage.conversationId, conversationId)));
    for (const q of found) {
      quoted.set(q.id, {
        id: q.id,
        seq: Number(q.seq),
        senderName: q.senderName,
        preview: q.retractedAt ? '' : preview(q.body, 140),
        retracted: Boolean(q.retractedAt),
        available: true,
      });
    }
  }

  const fileRows =
    textIds.length === 0
      ? []
      : await tx
          .select({
            id: attachment.id,
            objectId: attachment.objectId,
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            sizeBytes: attachment.sizeBytes,
          })
          .from(attachment)
          .where(
            and(
              eq(attachment.objectType, chat.MESSAGE_OBJECT),
              inArray(attachment.objectId, textIds),
              eq(attachment.scanStatus, 'clean'),
              isNull(attachment.supersededById),
              isNull(attachment.disposedAt),
            ),
          )
          .orderBy(asc(attachment.createdAt));
  const reactionRows =
    textIds.length === 0
      ? []
      : await tx
          .select({
            messageId: chatReaction.messageId,
            reaction: chatReaction.reaction,
            userId: chatReaction.userId,
            name: appUser.displayName,
            createdAt: chatReaction.createdAt,
          })
          .from(chatReaction)
          .innerJoin(appUser, eq(appUser.id, chatReaction.userId))
          .where(inArray(chatReaction.messageId, textIds))
          .orderBy(asc(chatReaction.createdAt));
  const receiptRows =
    mineIds.length === 0
      ? []
      : await tx
          .select({
            messageId: chatReceipt.messageId,
            userId: chatReceipt.userId,
            name: appUser.displayName,
            deliveredAt: chatReceipt.deliveredAt,
            seenAt: chatReceipt.seenAt,
          })
          .from(chatReceipt)
          .innerJoin(appUser, eq(appUser.id, chatReceipt.userId))
          .where(inArray(chatReceipt.messageId, mineIds));

  const filesBy = new Map<string, FileView[]>();
  for (const f of fileRows) {
    const list = filesBy.get(f.objectId) ?? [];
    list.push({ id: f.id, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes, kind: previewKind(f.contentType) });
    filesBy.set(f.objectId, list);
  }
  const reactionsBy = new Map<string, Map<string, ReactionView>>();
  for (const r of reactionRows) {
    const perMessage = reactionsBy.get(r.messageId) ?? new Map<string, ReactionView>();
    const current = perMessage.get(r.reaction) ?? { reaction: r.reaction, count: 0, mine: false, names: [] };
    perMessage.set(r.reaction, {
      reaction: r.reaction,
      count: current.count + 1,
      mine: current.mine || r.userId === me(ctx),
      names: [...current.names, r.name],
    });
    reactionsBy.set(r.messageId, perMessage);
  }
  const receiptsBy = new Map<string, ReceiptView[]>();
  for (const r of receiptRows) {
    const list = receiptsBy.get(r.messageId) ?? [];
    list.push({
      userId: r.userId,
      name: r.name,
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
      seenAt: r.seenAt?.toISOString() ?? null,
    });
    receiptsBy.set(r.messageId, list);
  }

  const messages = window.map((r): MessageView => {
    const retracted = r.retractedAt
      ? { at: r.retractedAt.toISOString(), byName: names.get(r.retractedBy ?? '') ?? r.senderName, reason: r.retractReason ?? '' }
      : null;
    const receipts = receiptsBy.get(r.id) ?? [];
    const isMine = r.senderId === me(ctx);
    return {
      id: r.id,
      seq: Number(r.seq),
      kind: r.kind as 'text' | 'system',
      senderId: r.senderId,
      senderName: r.senderName,
      mine: isMine,
      body: retracted ? '' : r.body,
      meta: (r.meta as Record<string, unknown> | null) ?? null,
      createdAt: r.createdAt.toISOString(),
      retracted,
      mentionsMe: r.mentions.includes(me(ctx)),
      mentionNames: retracted ? [] : r.mentions.map((id) => names.get(id) ?? '').filter(Boolean),
      clientId: isMine ? r.clientId : null,
      replyTo: r.replyToId
        ? (quoted.get(r.replyToId) ?? { id: r.replyToId, seq: 0, senderName: '', preview: '', retracted: false, available: false })
        : null,
      files: retracted ? [] : (filesBy.get(r.id) ?? []),
      reactions: retracted ? [] : [...(reactionsBy.get(r.id)?.values() ?? [])],
      status: isMine && r.kind === 'text' ? messageStatus(receipts) : null,
      receipts: isMine ? receipts : [],
    };
  });
  return { messages, hasMore };
}

// ---------------------------------------------------------------------------
// The poll
// ---------------------------------------------------------------------------

export interface SyncRequest {
  /** The conversation open in the page, or null on a list. */
  readonly open: string | null;
  /** The tab is in front. */
  readonly visible: boolean;
  /** The person has touched the page lately. */
  readonly active: boolean;
  /** The revision of each conversation the page already holds. */
  readonly revs: Readonly<Record<string, number>>;
  /** Per conversation, the highest message number that has reached the browser. */
  readonly ack: Readonly<Record<string, number>>;
  /** The open conversation was read on screen up to this message. */
  readonly seen?: { readonly id: string; readonly upTo: number } | null;
  /** Whether the person is typing in the open conversation; absent leaves it as it was. */
  readonly typing?: boolean | null;
  readonly limit?: number | undefined;
}

export interface SyncResponse {
  readonly now: string;
  readonly me: { readonly userId: string; readonly name: string; readonly busy: boolean };
  readonly badge: number;
  readonly conversations: ConversationRow[];
  /** Present when the open conversation moved since the page's revision. */
  readonly thread: ThreadView | null;
  /** Present always for an open conversation: who is typing, and the others' presence. */
  readonly live: { readonly id: string; readonly typing: string[]; readonly members: PersonView[] } | null;
  /** The open conversation is gone from this person (left, or removed). */
  readonly closed: string | null;
}

export async function sync(tx: Tx, ctx: ActorContext, request: SyncRequest): Promise<SyncResponse> {
  if (!chat.mayUse(ctx.principal)) throw new ChatError('Chat is not available to you.');
  const now = new Date();

  const stored = await chat.heartbeat(tx, ctx, { active: request.active });

  // What reached the browser, then what was read on screen. The recipient's own
  // statements, in the recipient's own transaction, or they are not recorded.
  for (const [conversationId, upTo] of Object.entries(request.ack).slice(0, 100)) {
    try {
      await chat.markDelivered(tx, ctx, conversationId, upTo);
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
    }
  }
  if (request.seen && request.visible) {
    try {
      await chat.markSeen(tx, ctx, request.seen.id, request.seen.upTo);
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
    }
  }

  if (request.open && typeof request.typing === 'boolean') {
    try {
      await chat.setTyping(tx, ctx, request.open, request.typing);
    } catch (error) {
      if (!(error instanceof ChatError)) throw error;
    }
  }

  const conversations = await listConversations(tx, ctx, now);
  const [self] = await tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, me(ctx))).limit(1);

  let thread: ThreadView | null = null;
  let live: SyncResponse['live'] = null;
  let closed: string | null = null;
  if (request.open) {
    const row = conversations.find((c) => c.id === request.open);
    if (!row) {
      closed = request.open;
    } else {
      const known = request.revs[request.open];
      if (known === undefined || known !== row.rev) {
        thread = await threadOf(tx, ctx, request.open, { limit: request.limit ?? CHAT_PAGE_SIZE }, now);
        live = { id: thread.id, typing: thread.typing, members: thread.members };
      } else {
        const members = await chat.activeMembers(tx, request.open);
        const presence = await presenceMap(tx, members.map((m) => m.userId), now);
        const typingRows = await tx
          .select({ userId: chatParticipant.userId, until: chatParticipant.typingUntil })
          .from(chatParticipant)
          .where(and(eq(chatParticipant.conversationId, request.open), isNull(chatParticipant.leftAt)));
        live = {
          id: request.open,
          typing: typingRows
            .filter((r) => r.userId !== me(ctx) && isTyping(r.until?.toISOString(), now))
            .map((r) => members.find((m) => m.userId === r.userId)?.name ?? '')
            .filter(Boolean),
          members: members.map((m) => personOf(presence, m.userId, m.name, m.role)),
        };
      }
    }
  }

  return {
    now: now.toISOString(),
    me: { userId: me(ctx), name: self?.name ?? '', busy: stored.busy },
    badge: badgeOf(conversations),
    conversations,
    thread,
    live,
    closed,
  };
}

export interface InitialView {
  readonly me: SyncResponse['me'];
  readonly badge: number;
  readonly conversations: ConversationRow[];
  readonly thread: ThreadView | null;
  readonly openId: string | null;
}

/**
 * What the chat page is drawn with before the browser has asked for anything:
 * the list, and the conversation named in the address when it is one of this
 * person's. Read-only — the first poll is what records presence and receipts.
 */
export async function initialView(tx: Tx, ctx: ActorContext, requested: string | null): Promise<InitialView> {
  if (!chat.mayUse(ctx.principal)) throw new ChatError('Chat is not available to you.');
  const now = new Date();
  const conversations = await listConversations(tx, ctx, now);
  const stored = await chat.presenceOfSelf(tx, ctx);
  const [self] = await tx.select({ name: appUser.displayName }).from(appUser).where(eq(appUser.id, me(ctx))).limit(1);
  let thread: ThreadView | null = null;
  let openId: string | null = null;
  if (requested && conversations.some((c) => c.id === requested)) {
    thread = await threadOf(tx, ctx, requested, {}, now);
    openId = requested;
  }
  return {
    me: { userId: me(ctx), name: self?.name ?? '', busy: stored?.busy ?? false },
    badge: badgeOf(conversations),
    conversations,
    thread,
    openId,
  };
}

// ---------------------------------------------------------------------------
// Search and people
// ---------------------------------------------------------------------------

export interface SearchHit {
  readonly messageId: string;
  readonly conversationId: string;
  readonly conversationName: string;
  readonly kind: 'direct' | 'group';
  readonly seq: number;
  readonly senderName: string;
  readonly mine: boolean;
  readonly snippet: string;
  readonly createdAt: string;
}

/** A word or phrase in the messages this person can read — row-level security is the filter. */
export async function searchMessages(
  tx: Tx,
  ctx: ActorContext,
  query: string,
  options: { conversationId?: string | null; limit?: number } = {},
): Promise<SearchHit[]> {
  await chat.permit(ctx, 'view');
  const term = searchTerm(query);
  if (term === null) return [];
  const pattern = likePattern(term);
  const limit = Math.min(options.limit ?? 30, 50);
  const scope = options.conversationId ? sql`and m.conversation_id = ${options.conversationId}::uuid` : sql``;
  const result = await tx.execute(sql`
    select m.id::text as id, m.conversation_id::text as conversation_id, m.seq, m.body, m.created_at, m.sender_id::text as sender_id,
           u.display_name as sender_name, c.kind, c.title
      from chat_message m
      join chat_conversation c on c.id = m.conversation_id
      join app_user u on u.id = m.sender_id
     where m.kind = 'text' and m.retracted_at is null and lower(m.body) like ${pattern} escape '\\'
       ${scope}
     order by m.created_at desc
     limit ${limit}`);
  const rows = result.rows as {
    id: string; conversation_id: string; seq: string; body: string; created_at: Date; sender_id: string;
    sender_name: string; kind: 'direct' | 'group'; title: string | null;
  }[];
  if (rows.length === 0) return [];

  const directIds = [...new Set(rows.filter((r) => r.kind === 'direct').map((r) => r.conversation_id))];
  const partnerName = new Map<string, string>();
  if (directIds.length > 0) {
    const partners = await tx.execute(sql`
      select p.conversation_id::text as conversation_id, u.display_name as name
        from chat_participant p join app_user u on u.id = p.user_id
       where p.conversation_id in (${uuidList(directIds)}) and p.user_id <> ${me(ctx)}::uuid and p.left_at is null`);
    for (const p of partners.rows as { conversation_id: string; name: string }[]) partnerName.set(p.conversation_id, p.name);
  }

  const lowered = term.toLowerCase();
  return rows.map((r) => {
    const at = r.body.toLowerCase().indexOf(lowered);
    const start = Math.max(0, at - 40);
    const snippet = `${start > 0 ? '…' : ''}${r.body.slice(start, start + 140).replace(/\s+/g, ' ')}${start + 140 < r.body.length ? '…' : ''}`;
    return {
      messageId: r.id,
      conversationId: r.conversation_id,
      conversationName: r.kind === 'direct' ? (partnerName.get(r.conversation_id) ?? '') : (r.title ?? ''),
      kind: r.kind,
      seq: Number(r.seq),
      senderName: r.sender_name,
      mine: r.sender_id === me(ctx),
      snippet,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

export interface PersonHit {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

/** Colleagues a conversation can be opened with: active, holding chat, never the asker. */
export async function searchPeople(tx: Tx, ctx: ActorContext, query: string, limit = 20): Promise<PersonHit[]> {
  await chat.permit(ctx, 'view');
  const term = query.replace(/\s+/g, ' ').trim().slice(0, 100);
  const filter = term.length > 0 ? sql`and (lower(u.display_name) like ${likePattern(term)} escape '\\' or lower(u.email) like ${likePattern(term)} escape '\\')` : sql``;
  const result = await tx.execute(sql`
    select u.id::text as id, u.display_name as name, u.email
      from app_user u
     where u.is_active and u.id <> ${me(ctx)}::uuid
       and (u.is_super_user or exists (
             select 1 from user_role ur join role_grant g on g.role_code = ur.role_code
              where ur.user_id = u.id and g.object = 'chat' and g.verb = 'view'))
       ${filter}
     order by u.display_name
     limit ${Math.min(limit, 50)}`);
  return (result.rows as { id: string; name: string; email: string }[]).map((r) => ({ userId: r.id, name: r.name, email: r.email }));
}

// ---------------------------------------------------------------------------
// Files, and the doors other modules use
// ---------------------------------------------------------------------------

/** A file sent in a conversation, after the same checks as any attachment: the grant, then the message's parent check (membership). */
export async function fileOf(tx: Tx, ctx: ActorContext, attachmentId: string) {
  await chat.permit(ctx, 'view');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(attachmentId)) throw new ChatError('No such file.');
  const [row] = await tx
    .select({ objectType: attachment.objectType })
    .from(attachment)
    .where(eq(attachment.id, attachmentId))
    .limit(1);
  if (!row || row.objectType !== chat.MESSAGE_OBJECT) throw new ChatError('No such file.');
  return attachments.download(tx, chat.withFileRights(ctx), attachmentId);
}

export interface RecordConversationRow {
  readonly id: string;
  readonly name: string;
  readonly unread: number;
}

/** The conversations this person is in about a record — for a "discuss" door on another module's screen. */
export async function recordConversationsFor(
  tx: Tx,
  ctx: ActorContext,
  recordType: string,
  recordId: string,
): Promise<RecordConversationRow[]> {
  await chat.permit(ctx, 'view');
  const rows = await listConversations(tx, ctx);
  const about = await tx
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(and(eq(chatConversation.recordType, recordType), eq(chatConversation.recordId, recordId)));
  const ids = new Set(about.map((a) => a.id));
  return rows.filter((r) => ids.has(r.id)).map((r) => ({ id: r.id, name: r.name, unread: r.unread }));
}

/** Total unread across conversations that are not muted. */
export async function unreadBadge(tx: Tx, ctx: ActorContext): Promise<number> {
  return badgeOf(await listConversations(tx, ctx));
}
