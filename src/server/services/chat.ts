/**
 * Internal chat — the writer (platform phase, Agent 1; migrations 0310–0311).
 *
 * The one service that writes `chat_*`. Access is membership, and it is held
 * three times: the grant (`chat`: view to read the screen, create to write),
 * this file asking "am I in it?" before it does anything, and the database's
 * row-level security (0310), which answers the same question again for every
 * statement — so a query that forgot to ask still returns nothing for a
 * stranger. There is no administrator bypass: a super user who is not a
 * member sees nothing of a private conversation.
 *
 * What is never faked:
 *   * `delivered_at` is written when the *recipient's* browser acknowledged the
 *     message on a later request (`markDelivered`); `seen_at` when that person
 *     had the conversation open and read to the message (`markSeen`). The
 *     sender cannot write either, and the table refuses to move them back.
 *   * Presence is a heartbeat the page sends while it is open; Online / Away /
 *     Busy / Offline are worked out from it when read (`domain/chat.presenceOf`).
 *
 * What is never lost: a message is not edited and not deleted. A sender
 * withdraws it with a reason (`retractMessage`); the text stays in the table
 * for the record and is never handed out again.
 *
 * Notifications are only *emitted* here, through `notifications.insertNotification`
 * (`chat.message` once per run of unread messages, `chat.mention` per mention).
 * There is no bell, queue or channel of chat's own.
 *
 * Audit: a conversation being opened, a member added, removed or leaving, a
 * rename, a record conversation, a withdrawn message. Not each message nor
 * each reaction: the message row is its own append-only record (sender, time,
 * number), and an audit row per line of conversation would bury the audit
 * trail's real events.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { applyScope, db, type Tx } from '../db/client';
import { appUser, chatConversation, chatMessage, chatParticipant, chatPresence, chatReaction } from '../db/schema';
import {
  CHAT_MAX_FILES_PER_MESSAGE,
  CHAT_MAX_MEMBERS,
  ChatError,
  assertBody,
  assertRetractReason,
  assertTitle,
  deriveMentions,
  isChatReaction,
  isLocalHref,
  memberKeyOf,
  preview,
  shouldWritePresence,
  TYPING_TTL_MS,
  type ChatSystemEvent,
} from '../domain/chat';
import { can, type Principal } from '../domain/permissions';
import * as attachments from './attachments';
import * as audit from './audit';
import { authorize, loadPrincipal } from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as notifications from './notifications';

export const PERMISSION_OBJECT = 'chat';
/** The object type a conversation's files and notices hang on. */
export const CONVERSATION_OBJECT = 'chat_conversation';
/** The object type a message's files hang on (registered in attachments-runtime). */
export const MESSAGE_OBJECT = 'chat_message';
export const RECORD_LABEL_MAX = 200;

export { ChatError };

const me = (ctx: ActorContext): string => ctx.principal.userId;

/** A guarded door: refused and recorded when the grant is missing. */
export async function permit(ctx: ActorContext, verb: 'view' | 'create'): Promise<void> {
  await authorize(ctx.principal, verb, PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

/** The same question without the record of a refusal, for the polling path. */
export function mayUse(principal: Principal): boolean {
  return can(principal, 'view', PERMISSION_OBJECT);
}

const uuidList = (ids: readonly string[]) => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);

// ---------------------------------------------------------------------------
// Who is in, who may be
// ---------------------------------------------------------------------------

export interface Membership {
  readonly role: 'owner' | 'member';
  readonly firstSeq: number;
  readonly muted: boolean;
}

/** One answer for "no such conversation" and "not yours": the difference is itself information. */
export const NOT_IN_CONVERSATION = 'This conversation does not exist or you are not in it.';

export async function membership(tx: Tx, ctx: ActorContext, conversationId: string): Promise<Membership> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) {
    throw new ChatError(NOT_IN_CONVERSATION);
  }
  const [row] = await tx
    .select({ role: chatParticipant.role, firstSeq: chatParticipant.firstSeq, muted: chatParticipant.muted })
    .from(chatParticipant)
    .where(
      and(
        eq(chatParticipant.conversationId, conversationId),
        eq(chatParticipant.userId, me(ctx)),
        isNull(chatParticipant.leftAt),
      ),
    )
    .limit(1);
  if (!row) throw new ChatError(NOT_IN_CONVERSATION);
  return { role: row.role as 'owner' | 'member', firstSeq: Number(row.firstSeq), muted: row.muted };
}

export interface ActiveMember {
  readonly userId: string;
  readonly name: string;
  readonly role: 'owner' | 'member';
  readonly muted: boolean;
  readonly firstSeq: number;
}

export async function activeMembers(tx: Tx, conversationId: string): Promise<ActiveMember[]> {
  const rows = await tx
    .select({
      userId: chatParticipant.userId,
      name: appUser.displayName,
      role: chatParticipant.role,
      muted: chatParticipant.muted,
      firstSeq: chatParticipant.firstSeq,
    })
    .from(chatParticipant)
    .innerJoin(appUser, eq(appUser.id, chatParticipant.userId))
    .where(and(eq(chatParticipant.conversationId, conversationId), isNull(chatParticipant.leftAt)))
    .orderBy(asc(chatParticipant.joinedAt), asc(appUser.displayName));
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    role: r.role as 'owner' | 'member',
    muted: r.muted,
    firstSeq: Number(r.firstSeq),
  }));
}

/**
 * Of these people, the ones who are active and hold `chat` — the only ones a
 * conversation may be opened with. Name by id.
 */
export async function eligibleUsers(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await tx.execute(sql`
    select u.id::text as id, u.display_name as name
      from app_user u
     where u.id in (${uuidList(ids)})
       and u.is_active
       and (u.is_super_user or exists (
             select 1 from user_role ur
               join role_grant g on g.role_code = ur.role_code
              where ur.user_id = u.id and g.object = ${PERMISSION_OBJECT} and g.verb = 'view'))`);
  return new Map((result.rows as { id: string; name: string }[]).map((r) => [r.id, r.name]));
}

/**
 * Whether a person can open a record, asked as that person: their own
 * principal and their own row-level scope, in a transaction of their own, with
 * the registered check the record's attachments are guarded by.
 */
export async function mayOpenRecordAs(userId: string, recordType: string, recordId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ isSuperUser: appUser.isSuperUser })
      .from(appUser)
      .where(eq(appUser.id, userId))
      .limit(1);
    if (!user) return false;
    await applyScope(tx, { userId, branchCode: '', isSuperUser: user.isSuperUser });
    const principal = await loadPrincipal(tx, userId);
    if (!principal.isActive) return false;
    await applyScope(tx, { userId, branchCode: principal.defaultBranchCode ?? '', isSuperUser: user.isSuperUser });
    return attachments.mayAccessParent(tx, principal, recordType, recordId);
  });
}

/** The viewer's own answer, in the transaction they are already in. */
export function mayOpenRecord(tx: Tx, ctx: ActorContext, recordType: string, recordId: string): Promise<boolean> {
  return attachments.mayAccessParent(tx, ctx.principal, recordType, recordId);
}

// ---------------------------------------------------------------------------
// System lines and the audit
// ---------------------------------------------------------------------------

async function systemLine(
  tx: Tx,
  conversationId: string,
  actorId: string,
  event: ChatSystemEvent,
  meta: Record<string, unknown>,
): Promise<void> {
  await tx.insert(chatMessage).values({
    conversationId,
    senderId: actorId,
    kind: 'system',
    body: event,
    meta: { actorId, ...meta },
  });
}

async function record(
  tx: Tx,
  ctx: ActorContext,
  action: string,
  conversationId: string,
  after: Record<string, unknown>,
  reason: string | null = null,
): Promise<void> {
  await audit.record(tx, {
    actorUserId: me(ctx),
    action,
    objectType: CONVERSATION_OBJECT,
    objectId: conversationId,
    branchCode: ctx.branchCode,
    after,
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

// ---------------------------------------------------------------------------
// Opening conversations
// ---------------------------------------------------------------------------

async function assertCanBePicked(tx: Tx, userIds: readonly string[], who: 'member' | 'person' = 'person') {
  const unique = [...new Set(userIds)];
  const found = await eligibleUsers(tx, unique);
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new ChatError(
      who === 'person' && unique.length === 1
        ? 'That person cannot be reached in chat: they are not an active user with chat access.'
        : 'Some of the people picked cannot be reached in chat: they are not active users with chat access.',
    );
  }
  return found;
}

export interface OpenResult {
  readonly conversationId: string;
  readonly created: boolean;
}

/** A person-to-person conversation; the one that already exists when there is one. */
export async function openDirect(tx: Tx, ctx: ActorContext, otherUserId: string): Promise<OpenResult> {
  await permit(ctx, 'create');
  if (otherUserId === me(ctx)) throw new ChatError('Pick a colleague: a conversation needs somebody else in it.');
  await assertCanBePicked(tx, [otherUserId]);

  const memberKey = memberKeyOf([me(ctx), otherUserId]);
  const [existing] = await tx
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(
      and(
        eq(chatConversation.kind, 'direct'),
        isNull(chatConversation.recordType),
        eq(chatConversation.memberKey, memberKey),
      ),
    )
    .limit(1);
  if (existing) return { conversationId: existing.id, created: false };

  const id = crypto.randomUUID();
  await tx.insert(chatConversation).values({ id, kind: 'direct', memberKey, createdBy: me(ctx) });
  await tx.insert(chatParticipant).values([
    { conversationId: id, userId: me(ctx), role: 'member' },
    { conversationId: id, userId: otherUserId, role: 'member' },
  ]);
  await record(tx, ctx, 'chat.conversation_opened', id, { kind: 'direct', with: otherUserId });
  return { conversationId: id, created: true };
}

export interface GroupInput {
  readonly title: string;
  readonly memberIds: readonly string[];
}

export async function createGroup(tx: Tx, ctx: ActorContext, input: GroupInput): Promise<OpenResult> {
  await permit(ctx, 'create');
  const title = assertTitle(input.title);
  const others = [...new Set(input.memberIds)].filter((id) => id !== me(ctx));
  if (others.length === 0) throw new ChatError('Pick at least one colleague for the group.');
  if (others.length + 1 > CHAT_MAX_MEMBERS) throw new ChatError(`A group holds at most ${CHAT_MAX_MEMBERS} people.`);
  const names = await assertCanBePicked(tx, others, 'member');

  const id = crypto.randomUUID();
  await tx.insert(chatConversation).values({ id, kind: 'group', title, createdBy: me(ctx) });
  await tx.insert(chatParticipant).values([
    { conversationId: id, userId: me(ctx), role: 'owner' },
    ...others.map((userId) => ({ conversationId: id, userId, role: 'member' as const })),
  ]);
  await systemLine(tx, id, me(ctx), 'created', { title, names: others.map((o) => names.get(o) ?? '') });
  await record(tx, ctx, 'chat.conversation_opened', id, { kind: 'group', title, members: others });
  return { conversationId: id, created: true };
}

export interface RecordConversationInput {
  /** The audit object type the record's history and attachments are kept under. */
  readonly recordType: string;
  /** The id they are kept under (the record's uuid or its number, as that type uses). */
  readonly recordId: string;
  /** How the record is called on a screen; shown only to members who can open it. */
  readonly label?: string | null;
  /** Where it opens: a path on this site. */
  readonly href?: string | null;
  /** The colleagues to talk to. Each must be able to open the record themselves. */
  readonly memberIds: readonly string[];
  /** A group's name; defaults to the label. */
  readonly title?: string | null;
}

/**
 * A conversation about a real record, found again by (type, id, members).
 *
 * The opener must be able to open the record, and so must everybody they add —
 * a conversation never puts a record in front of somebody who could not open it
 * from its own screen. For the Task Center and any other module that wants a
 * "discuss this" door: call this, then send the person to
 * `/chat?c=<conversationId>` (with `&draft=` to prefill the box).
 */
export async function openRecordConversation(
  tx: Tx,
  ctx: ActorContext,
  input: RecordConversationInput,
): Promise<OpenResult> {
  await permit(ctx, 'create');
  const recordType = input.recordType.trim();
  const recordId = input.recordId.trim();
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(recordType) || recordId.length === 0 || recordId.length > 200) {
    throw new ChatError('Name the record by its type and id.');
  }
  const label = input.label?.replace(/\s+/g, ' ').trim().slice(0, RECORD_LABEL_MAX) || null;
  const href = input.href?.trim() || null;
  if (href !== null && !isLocalHref(href)) throw new ChatError('A record opens on this site; the link must be a path here.');

  if (!(await mayOpenRecord(tx, ctx, recordType, recordId))) {
    throw new ChatError('You cannot open that record, so you cannot start a conversation about it.');
  }
  const others = [...new Set(input.memberIds)].filter((id) => id !== me(ctx));
  if (others.length === 0) throw new ChatError('Pick at least one colleague to talk to about the record.');
  if (others.length + 1 > CHAT_MAX_MEMBERS) throw new ChatError(`A conversation holds at most ${CHAT_MAX_MEMBERS} people.`);
  const names = await assertCanBePicked(tx, others, 'member');
  for (const userId of others) {
    if (!(await mayOpenRecordAs(userId, recordType, recordId))) {
      throw new ChatError(`${names.get(userId) ?? 'That person'} cannot open this record, so they cannot be added to a conversation about it.`);
    }
  }

  const memberKey = memberKeyOf([me(ctx), ...others]);
  const [existing] = await tx
    .select({ id: chatConversation.id })
    .from(chatConversation)
    .where(
      and(
        eq(chatConversation.recordType, recordType),
        eq(chatConversation.recordId, recordId),
        eq(chatConversation.memberKey, memberKey),
      ),
    )
    .limit(1);
  if (existing) return { conversationId: existing.id, created: false };

  const direct = others.length === 1;
  // Never derived from the record: a title is shown to every member, the record only to those who can open it.
  const title = direct ? null : assertTitle(input.title?.trim() || 'Record conversation');
  const id = crypto.randomUUID();
  await tx.insert(chatConversation).values({
    id,
    kind: direct ? 'direct' : 'group',
    title,
    recordType,
    recordId,
    recordLabel: label,
    recordHref: href,
    memberKey,
    createdBy: me(ctx),
  });
  await tx.insert(chatParticipant).values([
    { conversationId: id, userId: me(ctx), role: direct ? 'member' : 'owner' },
    ...others.map((userId) => ({ conversationId: id, userId, role: 'member' as const })),
  ]);
  if (!direct) await systemLine(tx, id, me(ctx), 'created', { title, names: others.map((o) => names.get(o) ?? '') });
  await record(tx, ctx, 'chat.record_conversation_opened', id, { recordType, recordId, members: others });
  return { conversationId: id, created: true };
}

// ---------------------------------------------------------------------------
// Membership of a group
// ---------------------------------------------------------------------------

async function lockedGroup(tx: Tx, ctx: ActorContext, conversationId: string, ownerOnly: boolean) {
  const mine = await membership(tx, ctx, conversationId);
  // The counter's row: held so nobody's first message moves while a person is let in or out.
  const locked = await tx.execute(sql`select * from app_chat_lock(${conversationId}::uuid)`);
  const row = locked.rows[0] as { kind: string; last_seq: string; record_type: string | null; record_id: string | null } | undefined;
  if (!row) throw new ChatError(NOT_IN_CONVERSATION);
  if (row.kind !== 'group') throw new ChatError('A conversation between two people has no members to change.');
  if (ownerOnly && mine.role !== 'owner') throw new ChatError('Only an owner of the group does that.');
  return { lastSeq: Number(row.last_seq), recordType: row.record_type, recordId: row.record_id };
}

async function touch(tx: Tx, conversationId: string): Promise<void> {
  await tx.execute(sql`select app_chat_touch(${conversationId}::uuid)`);
}

export async function addMembers(
  tx: Tx,
  ctx: ActorContext,
  conversationId: string,
  userIds: readonly string[],
): Promise<void> {
  await permit(ctx, 'create');
  const group = await lockedGroup(tx, ctx, conversationId, true);
  const wanted = [...new Set(userIds)].filter((id) => id !== me(ctx));
  if (wanted.length === 0) throw new ChatError('Pick at least one colleague to add.');
  const names = await assertCanBePicked(tx, wanted, 'member');

  const rows = await tx
    .select({ userId: chatParticipant.userId, leftAt: chatParticipant.leftAt })
    .from(chatParticipant)
    .where(and(eq(chatParticipant.conversationId, conversationId), inArray(chatParticipant.userId, wanted)));
  const known = new Map(rows.map((r) => [r.userId, r.leftAt]));
  const activeNow = await activeMembers(tx, conversationId);
  const toAdd = wanted.filter((id) => !activeNow.some((m) => m.userId === id));
  if (toAdd.length === 0) throw new ChatError('Everyone picked is already in the group.');
  if (activeNow.length + toAdd.length > CHAT_MAX_MEMBERS) throw new ChatError(`A group holds at most ${CHAT_MAX_MEMBERS} people.`);

  if (group.recordType && group.recordId) {
    for (const userId of toAdd) {
      if (!(await mayOpenRecordAs(userId, group.recordType, group.recordId))) {
        throw new ChatError(`${names.get(userId) ?? 'That person'} cannot open the record this conversation is about, so they cannot be added.`);
      }
    }
  }

  // From the next message on: nobody reads what was said before they came in.
  const firstSeq = group.lastSeq + 1;
  for (const userId of toAdd) {
    if (known.has(userId)) {
      await tx
        .update(chatParticipant)
        .set({ leftAt: null, firstSeq })
        .where(and(eq(chatParticipant.conversationId, conversationId), eq(chatParticipant.userId, userId)));
    } else {
      await tx.insert(chatParticipant).values({ conversationId, userId, role: 'member', firstSeq });
    }
  }
  await systemLine(tx, conversationId, me(ctx), 'added', { names: toAdd.map((id) => names.get(id) ?? ''), ids: toAdd });
  await record(tx, ctx, 'chat.members_added', conversationId, { added: toAdd });
}

export async function removeMember(tx: Tx, ctx: ActorContext, conversationId: string, userId: string): Promise<void> {
  await permit(ctx, 'create');
  if (userId === me(ctx)) return leaveConversation(tx, ctx, conversationId);
  await lockedGroup(tx, ctx, conversationId, true);
  const members = await activeMembers(tx, conversationId);
  const target = members.find((m) => m.userId === userId);
  if (!target) throw new ChatError('That person is not in the group.');
  await tx
    .update(chatParticipant)
    .set({ leftAt: new Date() })
    .where(and(eq(chatParticipant.conversationId, conversationId), eq(chatParticipant.userId, userId)));
  await systemLine(tx, conversationId, me(ctx), 'removed', { names: [target.name], ids: [userId] });
  await record(tx, ctx, 'chat.member_removed', conversationId, { removed: userId });
}

export async function leaveConversation(tx: Tx, ctx: ActorContext, conversationId: string): Promise<void> {
  await permit(ctx, 'create');
  const mine = await membership(tx, ctx, conversationId);
  await lockedGroup(tx, ctx, conversationId, false);
  const members = await activeMembers(tx, conversationId);
  const others = members.filter((m) => m.userId !== me(ctx));
  // A group is never left without an owner: the longest-standing member takes over.
  if (mine.role === 'owner' && others.length > 0 && !others.some((m) => m.role === 'owner')) {
    const successor = others[0]!;
    await tx
      .update(chatParticipant)
      .set({ role: 'owner' })
      .where(and(eq(chatParticipant.conversationId, conversationId), eq(chatParticipant.userId, successor.userId)));
  }
  const myName = members.find((m) => m.userId === me(ctx))?.name ?? '';
  await systemLine(tx, conversationId, me(ctx), 'left', { names: [myName], ids: [me(ctx)] });
  await tx
    .update(chatParticipant)
    .set({ leftAt: new Date() })
    .where(and(eq(chatParticipant.conversationId, conversationId), eq(chatParticipant.userId, me(ctx))));
  await record(tx, ctx, 'chat.member_left', conversationId, { left: me(ctx) });
}

export async function renameGroup(tx: Tx, ctx: ActorContext, conversationId: string, title: string): Promise<void> {
  await permit(ctx, 'create');
  const next = assertTitle(title);
  await lockedGroup(tx, ctx, conversationId, true);
  const [current] = await tx
    .select({ title: chatConversation.title })
    .from(chatConversation)
    .where(eq(chatConversation.id, conversationId))
    .limit(1);
  if (current?.title === next) return;
  await tx.update(chatConversation).set({ title: next }).where(eq(chatConversation.id, conversationId));
  await systemLine(tx, conversationId, me(ctx), 'renamed', { title: next, was: current?.title ?? null });
  await record(tx, ctx, 'chat.group_renamed', conversationId, { title: next, was: current?.title ?? null });
}

/** A personal setting: nothing to audit, nothing anyone else sees. */
export async function setMuted(tx: Tx, ctx: ActorContext, conversationId: string, muted: boolean): Promise<void> {
  await permit(ctx, 'view');
  await membership(tx, ctx, conversationId);
  await tx
    .update(chatParticipant)
    .set({ muted })
    .where(and(eq(chatParticipant.conversationId, conversationId), eq(chatParticipant.userId, me(ctx))));
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface FileInput {
  readonly name: string;
  readonly content: Buffer;
}

export interface SendInput {
  readonly conversationId: string;
  readonly body: string;
  readonly replyToId?: string | null;
  /** The browser's own id for this send: a retry finds the message instead of sending it twice. */
  readonly clientId?: string | null;
  readonly files?: readonly FileInput[];
}

export interface SendResult {
  readonly messageId: string;
  readonly seq: number;
  readonly duplicate: boolean;
}

/** Files travel under the chat grant: membership (the parent check) is what decides, not the attachment grant. */
export function withFileRights(ctx: ActorContext): ActorContext {
  const grants = [...ctx.principal.grants, { object: 'attachment', verb: 'view' as const }, { object: 'attachment', verb: 'create' as const }];
  return { ...ctx, principal: { ...ctx.principal, grants } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sendMessage(tx: Tx, ctx: ActorContext, input: SendInput): Promise<SendResult> {
  await permit(ctx, 'create');
  const mine = await membership(tx, ctx, input.conversationId);
  const files = input.files ?? [];
  if (files.length > CHAT_MAX_FILES_PER_MESSAGE) {
    throw new ChatError(`At most ${CHAT_MAX_FILES_PER_MESSAGE} files go in one message.`);
  }
  const body = assertBody(input.body ?? '', files.length > 0);
  const clientId = input.clientId && UUID_RE.test(input.clientId) ? input.clientId : null;

  // A retry after an answer that never arrived: the message is already there.
  if (clientId) {
    const [again] = await tx
      .select({ id: chatMessage.id, seq: chatMessage.seq })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.conversationId, input.conversationId),
          eq(chatMessage.senderId, me(ctx)),
          eq(chatMessage.clientId, clientId),
        ),
      )
      .limit(1);
    if (again) return { messageId: again.id, seq: Number(again.seq), duplicate: true };
  }

  const replyToId = input.replyToId || null;
  if (replyToId) {
    if (!UUID_RE.test(replyToId)) throw new ChatError('The message you are replying to is not in this conversation.');
    // A reply quotes something this person can read in this conversation.
    const [quoted] = await tx
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(and(eq(chatMessage.id, replyToId), eq(chatMessage.conversationId, input.conversationId)))
      .limit(1);
    if (!quoted) throw new ChatError('The message you are replying to is not in this conversation.');
  }

  const members = await activeMembers(tx, input.conversationId);
  const mentions = deriveMentions(body, members, me(ctx));
  const sender = members.find((m) => m.userId === me(ctx));

  const messageId = crypto.randomUUID();
  const [row] = await tx
    .insert(chatMessage)
    .values({
      id: messageId,
      conversationId: input.conversationId,
      senderId: me(ctx),
      kind: 'text',
      body,
      replyToId,
      mentions,
      clientId,
    })
    .returning({ seq: chatMessage.seq });
  const seq = Number(row!.seq);

  const names: string[] = [];
  if (files.length > 0) {
    const fileCtx = withFileRights(ctx);
    for (const file of files) {
      const uploaded = await attachments.upload(tx, fileCtx, {
        objectType: MESSAGE_OBJECT,
        objectId: messageId,
        fileName: file.name,
        content: file.content,
      });
      if (uploaded.quarantined) {
        // The upload row and its audit roll back with the message; the refusal is kept on its own connection.
        await audit.recordSecurity(
          { userId: me(ctx), branchCode: ctx.branchCode, isSuperUser: ctx.principal.isSuperUser },
          {
            actorUserId: me(ctx),
            action: 'chat.file_refused',
            objectType: CONVERSATION_OBJECT,
            objectId: input.conversationId,
            branchCode: ctx.branchCode,
            after: { fileName: file.name, scanStatus: uploaded.scanStatus },
            outcome: 'denied',
            requestId: ctx.requestId ?? null,
            clientIp: ctx.clientIp ?? null,
          },
        );
        throw new ChatError(`${file.name} did not pass the malware scan, so the message was not sent.`);
      }
      names.push(file.name);
    }
  }

  await notifyRecipients(tx, {
    conversationId: input.conversationId,
    messageId,
    seq,
    senderId: me(ctx),
    senderName: sender?.name ?? '',
    body,
    fileNames: names,
    mentions,
    members,
    mutedSender: mine.muted,
  });
  return { messageId, seq, duplicate: false };
}

interface NoticeInput {
  readonly conversationId: string;
  readonly messageId: string;
  readonly seq: number;
  readonly senderId: string;
  readonly senderName: string;
  readonly body: string;
  readonly fileNames: readonly string[];
  readonly mentions: readonly string[];
  readonly members: readonly ActiveMember[];
  readonly mutedSender: boolean;
}

/**
 * `chat.message` for each recipient, once per run of unread messages (keyed on
 * the oldest message they have not seen, so ten messages while they are away
 * make one notice, and the next run after they have read makes the next), and
 * `chat.mention` for each person named. A muted conversation raises no
 * `chat.message`; a mention still reaches the person.
 */
async function notifyRecipients(tx: Tx, n: NoticeInput): Promise<void> {
  const [conversation] = await tx
    .select({ kind: chatConversation.kind, title: chatConversation.title })
    .from(chatConversation)
    .where(eq(chatConversation.id, n.conversationId))
    .limit(1);
  const group = conversation?.kind === 'group';
  const where = group ? ` in ${conversation?.title ?? 'a group'}` : '';
  const text = n.body.length > 0 ? preview(n.body, 140) : n.fileNames.length > 0 ? `Sent ${n.fileNames.length === 1 ? n.fileNames[0] : `${n.fileNames.length} files`}` : '';
  const href = `/chat?c=${n.conversationId}`;
  const context = { conversationId: n.conversationId, messageId: n.messageId, seq: n.seq, senderId: n.senderId, href };

  for (const member of n.members) {
    if (member.userId === n.senderId || member.firstSeq > n.seq) continue;
    if (n.mentions.includes(member.userId)) {
      await notifications.insertNotification(tx, {
        ruleCode: null,
        eventType: 'chat.mention',
        objectType: CONVERSATION_OBJECT,
        objectId: n.conversationId,
        recipientUserId: member.userId,
        subject: `${n.senderName} mentioned you${where}`,
        body: text,
        context,
        dedupeKey: `chat.mention:${n.messageId}:${member.userId}`,
        branchCode: null,
      });
      continue;
    }
    if (member.muted) continue;
    const first = await tx.execute(sql`select app_chat_first_unseen(${n.conversationId}::uuid, ${member.userId}::uuid) as seq`);
    const firstUnseen = (first.rows[0] as { seq: string | null } | undefined)?.seq ?? String(n.seq);
    await notifications.insertNotification(tx, {
      ruleCode: null,
      eventType: 'chat.message',
      objectType: CONVERSATION_OBJECT,
      objectId: n.conversationId,
      recipientUserId: member.userId,
      subject: `${n.senderName}${where}`,
      body: text,
      context,
      dedupeKey: `chat.message:${n.conversationId}:${firstUnseen}:${member.userId}`,
      branchCode: null,
    });
  }
}

/**
 * Withdraws a message. The sender's alone, with a reason; the text stays in the
 * table and is never handed out again, its files stop being served, and a
 * reply that quotes it shows that it was withdrawn.
 */
export async function retractMessage(tx: Tx, ctx: ActorContext, messageId: string, reason: string): Promise<void> {
  await permit(ctx, 'create');
  const why = assertRetractReason(reason);
  const [row] = await tx
    .select({
      conversationId: chatMessage.conversationId,
      senderId: chatMessage.senderId,
      kind: chatMessage.kind,
      retractedAt: chatMessage.retractedAt,
    })
    .from(chatMessage)
    .where(eq(chatMessage.id, messageId))
    .limit(1);
  if (!row) throw new ChatError('There is no such message.');
  await membership(tx, ctx, row.conversationId);
  if (row.kind !== 'text') throw new ChatError('Only a message somebody wrote can be withdrawn.');
  if (row.senderId !== me(ctx)) throw new ChatError('Only the person who wrote a message can withdraw it.');
  if (row.retractedAt) throw new ChatError('That message is already withdrawn.');
  await tx
    .update(chatMessage)
    .set({ retractedAt: new Date(), retractedBy: me(ctx), retractReason: why })
    .where(eq(chatMessage.id, messageId));
  await touch(tx, row.conversationId);
  await record(tx, ctx, 'chat.message_retracted', row.conversationId, { messageId }, why);
}

export async function react(tx: Tx, ctx: ActorContext, messageId: string, reaction: string, on: boolean): Promise<void> {
  await permit(ctx, 'create');
  if (!isChatReaction(reaction)) throw new ChatError('That reaction is not available.');
  const [row] = await tx
    .select({ conversationId: chatMessage.conversationId, kind: chatMessage.kind, retractedAt: chatMessage.retractedAt })
    .from(chatMessage)
    .where(eq(chatMessage.id, messageId))
    .limit(1);
  if (!row) throw new ChatError('There is no such message.');
  await membership(tx, ctx, row.conversationId);
  if (row.kind !== 'text' || row.retractedAt) throw new ChatError('That message cannot be reacted to.');
  if (on) {
    await tx
      .insert(chatReaction)
      .values({ messageId, conversationId: row.conversationId, userId: me(ctx), reaction })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(chatReaction)
      .where(and(eq(chatReaction.messageId, messageId), eq(chatReaction.userId, me(ctx)), eq(chatReaction.reaction, reaction)));
  }
  await touch(tx, row.conversationId);
}

// ---------------------------------------------------------------------------
// Receipts: written by the recipient, never by anyone for them
// ---------------------------------------------------------------------------

/** Acknowledged by this person's browser: everything up to `upToSeq` has reached it. Returns how many receipts moved. */
export async function markDelivered(tx: Tx, ctx: ActorContext, conversationId: string, upToSeq: number): Promise<number> {
  if (!Number.isFinite(upToSeq) || upToSeq < 1) return 0;
  await membership(tx, ctx, conversationId);
  const result = await tx.execute(sql`
    update chat_receipt r
       set delivered_at = now()
      from chat_message m
     where m.id = r.message_id
       and r.conversation_id = ${conversationId}::uuid
       and r.user_id = ${me(ctx)}::uuid
       and r.delivered_at is null
       and m.seq <= ${Math.floor(upToSeq)}`);
  const moved = result.rowCount ?? 0;
  if (moved > 0) await touch(tx, conversationId);
  return moved;
}

/**
 * Read by this person: the conversation was open and on screen up to
 * `upToSeq`. A message read is also a message delivered (at the same instant,
 * if the acknowledgement had not yet come). Their notices for the conversation
 * are marked read through the notification service.
 */
export async function markSeen(tx: Tx, ctx: ActorContext, conversationId: string, upToSeq: number): Promise<number> {
  if (!Number.isFinite(upToSeq) || upToSeq < 1) return 0;
  await membership(tx, ctx, conversationId);
  const result = await tx.execute(sql`
    update chat_receipt r
       set delivered_at = coalesce(r.delivered_at, now()), seen_at = now()
      from chat_message m
     where m.id = r.message_id
       and r.conversation_id = ${conversationId}::uuid
       and r.user_id = ${me(ctx)}::uuid
       and r.seen_at is null
       and m.seq <= ${Math.floor(upToSeq)}`);
  const moved = result.rowCount ?? 0;
  if (moved > 0) {
    await touch(tx, conversationId);
    const unread = await tx.execute(sql`
      select id::text as id from notification
       where recipient_user_id = ${me(ctx)}::uuid
         and object_type = ${CONVERSATION_OBJECT}
         and object_id = ${conversationId}
         and event_type in ('chat.message', 'chat.mention')
         and read_at is null`);
    for (const { id } of unread.rows as { id: string }[]) {
      await notifications.markRead(tx, BigInt(id), me(ctx));
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Typing and presence
// ---------------------------------------------------------------------------

export async function setTyping(tx: Tx, ctx: ActorContext, conversationId: string, typing: boolean): Promise<void> {
  await membership(tx, ctx, conversationId);
  await tx
    .update(chatParticipant)
    .set({ typingUntil: typing ? new Date(Date.now() + TYPING_TTL_MS) : null })
    .where(and(eq(chatParticipant.conversationId, conversationId), eq(chatParticipant.userId, me(ctx))));
}

export interface StoredPresence {
  readonly lastSeenAt: string;
  readonly lastActiveAt: string | null;
  readonly busy: boolean;
}

export async function presenceOfSelf(tx: Tx, ctx: ActorContext): Promise<StoredPresence | null> {
  const [row] = await tx.select().from(chatPresence).where(eq(chatPresence.userId, me(ctx))).limit(1);
  if (!row) return null;
  return {
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    busy: row.busy,
  };
}

/**
 * The heartbeat: the page is open (`lastSeenAt`), and the person is at it
 * (`lastActiveAt`, only when `active`). Written at most every 15 seconds,
 * however fast the page asks.
 */
export async function heartbeat(
  tx: Tx,
  ctx: ActorContext,
  state: { active: boolean },
  stored?: StoredPresence | null,
): Promise<StoredPresence> {
  const current = stored === undefined ? await presenceOfSelf(tx, ctx) : stored;
  const now = new Date();
  if (!shouldWritePresence(current, { active: state.active, busy: current?.busy ?? false }, now)) {
    return current!;
  }
  await tx
    .insert(chatPresence)
    .values({ userId: me(ctx), lastSeenAt: now, lastActiveAt: state.active ? now : null })
    .onConflictDoUpdate({
      target: chatPresence.userId,
      set: state.active ? { lastSeenAt: now, lastActiveAt: now } : { lastSeenAt: now },
    });
  return {
    lastSeenAt: now.toISOString(),
    lastActiveAt: state.active ? now.toISOString() : (current?.lastActiveAt ?? null),
    busy: current?.busy ?? false,
  };
}

/** "Do not disturb": shown to the people the person talks to as Busy, until it is turned off. */
export async function setBusy(tx: Tx, ctx: ActorContext, busy: boolean): Promise<void> {
  await permit(ctx, 'view');
  const now = new Date();
  await tx
    .insert(chatPresence)
    .values({ userId: me(ctx), lastSeenAt: now, lastActiveAt: now, busy })
    .onConflictDoUpdate({ target: chatPresence.userId, set: { busy, lastSeenAt: now, lastActiveAt: now } });
}
