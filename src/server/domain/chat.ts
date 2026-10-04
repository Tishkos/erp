/**
 * Internal chat — the pure rules (platform phase, Agent 1).
 *
 * Nothing here touches the database or the clock: the service hands in rows
 * and an instant, the screen hands in what it was given, and the same answer
 * comes back to both. `tests/unit/chat-rules.test.ts` holds the arithmetic.
 *
 *   receipts   a message is sent, then delivered to each recipient when that
 *              person's browser acknowledged it, then seen when they read the
 *              conversation. Forward only; "seen" without "delivered" is not a
 *              state (the table's CHECK says the same).
 *   unread     what a person has not seen, per conversation and in all — a
 *              muted conversation counts in its own row and not in the badge.
 *   presence   Online / Away / Busy / Offline from two timestamps and a flag;
 *              never stored, so it cannot be stale.
 *   mentions   read out of the text against the conversation's members, so a
 *              client cannot claim to have mentioned someone it did not.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHAT_MESSAGE_MAX_LENGTH = 4000;
export const CHAT_TITLE_MAX_LENGTH = 120;
export const CHAT_MAX_FILES_PER_MESSAGE = 5;
export const CHAT_MAX_MEMBERS = 50;
export const CHAT_RETRACT_REASON_MIN = 3;
export const CHAT_DRAFT_MAX_LENGTH = 2000;
export const CHAT_SEARCH_MIN = 2;
export const CHAT_PAGE_SIZE = 50;

/** The reaction codes the database accepts; the screen words each in the reader's language. */
export const CHAT_REACTIONS = ['like', 'love', 'laugh', 'thanks', 'done', 'eyes'] as const;
export type ChatReaction = (typeof CHAT_REACTIONS)[number];

export function isChatReaction(value: string): value is ChatReaction {
  return (CHAT_REACTIONS as readonly string[]).includes(value);
}

export const CHAT_KINDS = ['direct', 'group'] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

/** The lines the system writes into a conversation itself. */
export const CHAT_SYSTEM_EVENTS = ['created', 'added', 'left', 'removed', 'renamed'] as const;
export type ChatSystemEvent = (typeof CHAT_SYSTEM_EVENTS)[number];

// ---------------------------------------------------------------------------
// Receipts: Sending → Sent → Delivered → Seen
// ---------------------------------------------------------------------------

export const MESSAGE_STATES = ['sending', 'sent', 'delivered', 'seen'] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export interface ReceiptFacts {
  readonly deliveredAt: string | null;
  readonly seenAt: string | null;
}

export interface MessageStatus {
  readonly state: MessageState;
  /** Recipients the message was written for. */
  readonly total: number;
  readonly delivered: number;
  readonly seen: number;
}

/** Position of a state on the way to "seen"; a message never moves down it. */
export function stateRank(state: MessageState): number {
  return MESSAGE_STATES.indexOf(state);
}

/**
 * What the sender sees under their own message.
 *
 *   sending    the browser has not had the server's answer yet (a client-side
 *              state: a persisted message is never "sending")
 *   sent       the server holds it; nobody has acknowledged it yet
 *   delivered  every recipient's browser has acknowledged it
 *   seen       every recipient has read it
 *
 * In a group the state is the one *every* recipient has reached; the counts say
 * how far the rest are. With nobody to receive it the message is "sent" and
 * stays so — it cannot honestly be delivered to no one.
 */
export function messageStatus(receipts: readonly ReceiptFacts[], persisted = true): MessageStatus {
  if (!persisted) return { state: 'sending', total: 0, delivered: 0, seen: 0 };
  const total = receipts.length;
  const delivered = receipts.filter((r) => r.deliveredAt !== null).length;
  const seen = receipts.filter((r) => r.seenAt !== null).length;
  if (total === 0) return { state: 'sent', total, delivered, seen };
  if (seen === total) return { state: 'seen', total, delivered, seen };
  if (delivered === total) return { state: 'delivered', total, delivered, seen };
  return { state: 'sent', total, delivered, seen };
}

export type ReceiptEvent = 'delivered' | 'seen';

export class ReceiptError extends Error {
  readonly code = 'RECEIPT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'ReceiptError';
  }
}

/**
 * One recipient's receipt after an event. Forward only: a delivery is recorded
 * once (a repeat changes nothing), a message cannot be un-seen, and reading a
 * message implies it arrived — so "seen" on an undelivered receipt records the
 * delivery at the same instant rather than refusing the reader. An event
 * stamped before the delivery it follows is refused.
 */
export function advanceReceipt(prev: ReceiptFacts, event: ReceiptEvent, at: string): ReceiptFacts {
  if (event === 'delivered') {
    return prev.deliveredAt !== null ? prev : { deliveredAt: at, seenAt: prev.seenAt };
  }
  if (prev.seenAt !== null) return prev;
  const deliveredAt = prev.deliveredAt ?? at;
  if (Date.parse(at) < Date.parse(deliveredAt)) {
    throw new ReceiptError('A message cannot be seen before it was delivered.');
  }
  return { deliveredAt, seenAt: at };
}

/** Whether a receipt still has somewhere to go for this event. */
export function receiptNeeds(prev: ReceiptFacts, event: ReceiptEvent): boolean {
  return event === 'delivered' ? prev.deliveredAt === null : prev.seenAt === null;
}

export interface PendingReceipt {
  readonly messageSeq: number;
  readonly deliveredAt: string | null;
  readonly seenAt: string | null;
  readonly retracted?: boolean;
}

/**
 * The sequence numbers an acknowledgement up to `upTo` moves forward. A
 * browser can only acknowledge what the server has numbered, so a claim past
 * the last message reaches no further than it.
 */
export function receiptsToAdvance(
  receipts: readonly PendingReceipt[],
  event: ReceiptEvent,
  upTo: number,
): number[] {
  return receipts
    .filter((r) => r.messageSeq <= upTo && receiptNeeds(r, event))
    .map((r) => r.messageSeq);
}

// ---------------------------------------------------------------------------
// Unread
// ---------------------------------------------------------------------------

/** Unseen, still-standing messages for one person in one conversation. */
export function unreadCount(receipts: readonly PendingReceipt[]): number {
  return receipts.filter((r) => r.seenAt === null && !r.retracted).length;
}

export interface ConversationUnread {
  readonly unread: number;
  readonly muted: boolean;
}

/** The header badge: every conversation that is not muted. */
export function badgeTotal(conversations: readonly ConversationUnread[]): number {
  return conversations.reduce((sum, c) => (c.muted ? sum : sum + c.unread), 0);
}

/** "99+" past the cap, so a number never outgrows its badge. */
export function badgeText(count: number, cap = 99): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  return count > cap ? `${cap}+` : String(Math.trunc(count));
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export type Presence = 'online' | 'away' | 'busy' | 'offline';

/**
 * A browser asks the server every few seconds while the page is open (twice a
 * minute in a hidden tab at the slowest), so "present" means "asked within the
 * last 75 seconds": two missed slowest polls and some slack.
 */
export const PRESENCE_WINDOW_MS = 75_000;
/** At the page but not touching it for five minutes is Away. */
export const AWAY_AFTER_MS = 5 * 60_000;

export interface PresenceFacts {
  readonly lastSeenAt: string | null;
  readonly lastActiveAt: string | null;
  readonly busy: boolean;
}

export interface PresenceView {
  readonly state: Presence;
  /** Shown as "last seen …" when the person is not present. */
  readonly lastSeenAt: string | null;
}

export function presenceOf(facts: PresenceFacts | null | undefined, now: Date): PresenceView {
  if (!facts || facts.lastSeenAt === null) return { state: 'offline', lastSeenAt: null };
  const seen = Date.parse(facts.lastSeenAt);
  if (Number.isNaN(seen)) return { state: 'offline', lastSeenAt: null };
  const t = now.getTime();
  if (t - seen > PRESENCE_WINDOW_MS) return { state: 'offline', lastSeenAt: facts.lastSeenAt };
  if (facts.busy) return { state: 'busy', lastSeenAt: facts.lastSeenAt };
  const active = facts.lastActiveAt === null ? Number.NaN : Date.parse(facts.lastActiveAt);
  if (Number.isNaN(active) || t - active > AWAY_AFTER_MS) return { state: 'away', lastSeenAt: facts.lastSeenAt };
  return { state: 'online', lastSeenAt: facts.lastSeenAt };
}

/** The heartbeat is written at most this often, however fast the page polls. */
export const PRESENCE_WRITE_EVERY_MS = 15_000;

export function shouldWritePresence(
  stored: { lastSeenAt: string; lastActiveAt: string | null; busy: boolean } | null,
  next: { active: boolean; busy: boolean },
  now: Date,
): boolean {
  if (!stored) return true;
  if (stored.busy !== next.busy) return true;
  const age = now.getTime() - Date.parse(stored.lastSeenAt);
  if (!(age < PRESENCE_WRITE_EVERY_MS)) return true;
  // Becoming active after a stretch of being idle shows at once.
  if (next.active) {
    const last = stored.lastActiveAt === null ? Number.NaN : Date.parse(stored.lastActiveAt);
    if (Number.isNaN(last) || now.getTime() - last > PRESENCE_WRITE_EVERY_MS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Typing
// ---------------------------------------------------------------------------

export const TYPING_TTL_MS = 6_000;
/** A page tells the server it is typing at most this often. */
export const TYPING_SEND_EVERY_MS = 3_000;

export function isTyping(typingUntil: string | null | undefined, now: Date): boolean {
  if (!typingUntil) return false;
  const until = Date.parse(typingUntil);
  return !Number.isNaN(until) && until > now.getTime();
}

// ---------------------------------------------------------------------------
// How often a page asks
// ---------------------------------------------------------------------------

export interface PollContext {
  /** The tab is in front. */
  readonly visible: boolean;
  /** A conversation is open in it. */
  readonly open: boolean;
  /** The last request failed. */
  readonly failures?: number;
}

/**
 * One request a few seconds: quick while someone is looking at a thread, slower
 * on a list, slowest in a hidden tab. A failing connection backs off, up to a
 * minute, and resumes at once when it recovers.
 */
export function pollIntervalMs(context: PollContext): number {
  const base = !context.visible ? 30_000 : context.open ? 2_000 : 6_000;
  const failures = Math.max(0, context.failures ?? 0);
  if (failures === 0) return base;
  return Math.min(60_000, base * 2 ** Math.min(failures, 5));
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** The key a direct (or record) conversation is found by: the members, sorted. */
export function memberKeyOf(userIds: readonly string[]): string {
  return [...new Set(userIds.map((id) => id.toLowerCase()))].sort().join(',');
}

export class ChatError extends Error {
  readonly code = 'CHAT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'ChatError';
  }
}

export function assertBody(body: string, hasFiles: boolean): string {
  const text = body.replace(/\r\n?/g, '\n').trim();
  if (text.length === 0 && !hasFiles) throw new ChatError('Write something or attach a file before sending.');
  if (text.length > CHAT_MESSAGE_MAX_LENGTH) {
    throw new ChatError(`A message is at most ${CHAT_MESSAGE_MAX_LENGTH} characters; this one has ${text.length}.`);
  }
  return text;
}

export function assertTitle(title: string): string {
  const text = title.replace(/\s+/g, ' ').trim();
  if (text.length === 0) throw new ChatError('A group needs a name.');
  if (text.length > CHAT_TITLE_MAX_LENGTH) throw new ChatError(`A group name is at most ${CHAT_TITLE_MAX_LENGTH} characters.`);
  return text;
}

export function assertRetractReason(reason: string): string {
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text.length < CHAT_RETRACT_REASON_MIN) {
    throw new ChatError(`Say why the message is withdrawn (at least ${CHAT_RETRACT_REASON_MIN} characters).`);
  }
  return text;
}

/** A path on this site and nowhere else: one slash, then not another slash, a backslash or a space. */
export function isLocalHref(href: string): boolean {
  return /^\/[^/\\ ]/.test(href);
}

/**
 * The text a link opens a conversation with (`?draft=`): single line breaks
 * kept, control characters dropped, cut to the draft limit. Never sent by
 * itself — it only fills the box.
 */
export function normaliseDraft(raw: string | null | undefined): string {
  if (!raw) return '';
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return clean.slice(0, CHAT_DRAFT_MAX_LENGTH);
}

/** Whether a member is shown the record a conversation is about. */
export function recordShownTo(hasRecord: boolean, memberMayOpen: boolean): boolean {
  return hasRecord && memberMayOpen;
}

// ---------------------------------------------------------------------------
// Mentions
// ---------------------------------------------------------------------------

export interface Mentionable {
  readonly userId: string;
  readonly name: string;
}

/**
 * The members a text mentions: `@Name` with the name as the member is shown,
 * ending at the end of the text or at anything that is not part of a name. The
 * longest name wins ("@Ann Lee" is Ann Lee, not Ann), the author is never
 * their own mention, and each person counts once.
 */
export function deriveMentions(body: string, members: readonly Mentionable[], authorId?: string): string[] {
  const found = new Set<string>();
  const ordered = [...members]
    .filter((m) => m.name.trim().length > 0 && m.userId !== authorId)
    .sort((a, b) => b.name.length - a.name.length);
  const text = body.toLowerCase();
  let at = text.indexOf('@');
  while (at !== -1) {
    const rest = text.slice(at + 1);
    for (const member of ordered) {
      const name = member.name.trim().toLowerCase();
      if (!rest.startsWith(name)) continue;
      const after = rest.charAt(name.length);
      // The name ends the word: end of text, space, or punctuation — not more letters.
      if (after === '' || !/[\p{L}\p{N}_]/u.test(after)) {
        found.add(member.userId);
        break;
      }
    }
    at = text.indexOf('@', at + 1);
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The term a search runs with, or null when it is too short to mean anything. */
export function searchTerm(raw: string): string | null {
  const term = raw.replace(/\s+/g, ' ').trim();
  return term.length >= CHAT_SEARCH_MIN ? term.slice(0, 100) : null;
}

/** A term as a LIKE pattern that matches it literally. */
export function likePattern(term: string): string {
  return `%${term.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The start of a message, cut at a word where it can be, for a quote or a list row. */
export function preview(body: string, max = 120): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Attachments on a message
// ---------------------------------------------------------------------------

/** What the screen can show in place: a picture, or a PDF in the browser's own viewer. */
export function previewKind(contentType: string): 'image' | 'pdf' | 'file' {
  const type = contentType.toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp)$/.test(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'file';
}

export function sizeText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
