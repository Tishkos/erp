/**
 * Internal chat — the pure rules (domain/chat.ts).
 *
 *   C1  a sender's message is sending → sent → delivered → seen, by the
 *       slowest recipient; a persisted message is never "sending"
 *   C2  a receipt only moves forward; reading implies delivery; a repeat is a
 *       no-op; an acknowledgement reaches no further than it names
 *   C3  unread counts the unseen and standing; the badge leaves out muted
 *   C4  presence from the heartbeat: online, away, busy, offline
 *   C5  mentions are read from the text against the members
 *   C6  the edges: bodies, titles, reasons, links, drafts, search
 */
import { describe, expect, it } from 'vitest';
import {
  AWAY_AFTER_MS,
  CHAT_DRAFT_MAX_LENGTH,
  CHAT_MESSAGE_MAX_LENGTH,
  ChatError,
  PRESENCE_WINDOW_MS,
  ReceiptError,
  TYPING_TTL_MS,
  advanceReceipt,
  assertBody,
  assertRetractReason,
  assertTitle,
  badgeText,
  badgeTotal,
  deriveMentions,
  isChatReaction,
  isLocalHref,
  isTyping,
  likePattern,
  memberKeyOf,
  messageStatus,
  normaliseDraft,
  pollIntervalMs,
  presenceOf,
  preview,
  previewKind,
  receiptNeeds,
  receiptsToAdvance,
  searchTerm,
  shouldWritePresence,
  sizeText,
  stateRank,
  unreadCount,
} from '../../src/server/domain/chat';

const T0 = '2026-10-04T08:00:00.000Z';
const T1 = '2026-10-04T08:00:05.000Z';
const T2 = '2026-10-04T08:00:09.000Z';
const none = { deliveredAt: null, seenAt: null };

describe('C1 message status: sending, sent, delivered, seen', () => {
  it('is "sending" until the server has the message, whatever the receipts say', () => {
    expect(messageStatus([], false).state).toBe('sending');
    expect(messageStatus([{ deliveredAt: T0, seenAt: T1 }], false).state).toBe('sending');
  });

  it('is "sent" once persisted and nobody has acknowledged it', () => {
    expect(messageStatus([none]).state).toBe('sent');
    expect(messageStatus([none, none])).toMatchObject({ state: 'sent', total: 2, delivered: 0, seen: 0 });
  });

  it('is "sent" with no recipients at all: it cannot be delivered to no one', () => {
    expect(messageStatus([])).toMatchObject({ state: 'sent', total: 0 });
  });

  it('is "delivered" when every recipient received it, "seen" when every one read it', () => {
    expect(messageStatus([{ deliveredAt: T0, seenAt: null }]).state).toBe('delivered');
    expect(messageStatus([{ deliveredAt: T0, seenAt: T1 }]).state).toBe('seen');
  });

  it('in a group, is the state every recipient has reached, with the counts of the rest', () => {
    const status = messageStatus([
      { deliveredAt: T0, seenAt: T1 },
      { deliveredAt: T0, seenAt: null },
      none,
    ]);
    expect(status).toEqual({ state: 'sent', total: 3, delivered: 2, seen: 1 });
    expect(
      messageStatus([
        { deliveredAt: T0, seenAt: T1 },
        { deliveredAt: T0, seenAt: null },
      ]),
    ).toEqual({ state: 'delivered', total: 2, delivered: 2, seen: 1 });
  });

  it('ranks the states in order', () => {
    expect(['sending', 'sent', 'delivered', 'seen'].map((s) => stateRank(s as never))).toEqual([0, 1, 2, 3]);
  });
});

describe('C2 receipts move forward only', () => {
  it('records a delivery once and ignores a repeat', () => {
    const first = advanceReceipt(none, 'delivered', T0);
    expect(first).toEqual({ deliveredAt: T0, seenAt: null });
    expect(advanceReceipt(first, 'delivered', T2)).toBe(first);
  });

  it('records seen after delivered, once', () => {
    const delivered = advanceReceipt(none, 'delivered', T0);
    const seen = advanceReceipt(delivered, 'seen', T1);
    expect(seen).toEqual({ deliveredAt: T0, seenAt: T1 });
    expect(advanceReceipt(seen, 'seen', T2)).toBe(seen);
  });

  it('reading an undelivered message delivers it at the same instant', () => {
    expect(advanceReceipt(none, 'seen', T1)).toEqual({ deliveredAt: T1, seenAt: T1 });
  });

  it('refuses to see a message before it was delivered', () => {
    expect(() => advanceReceipt({ deliveredAt: T1, seenAt: null }, 'seen', T0)).toThrow(ReceiptError);
  });

  it('says what a receipt still needs', () => {
    expect(receiptNeeds(none, 'delivered')).toBe(true);
    expect(receiptNeeds({ deliveredAt: T0, seenAt: null }, 'delivered')).toBe(false);
    expect(receiptNeeds({ deliveredAt: T0, seenAt: null }, 'seen')).toBe(true);
    expect(receiptNeeds({ deliveredAt: T0, seenAt: T1 }, 'seen')).toBe(false);
  });

  it('acknowledges up to the named number and no further', () => {
    const receipts = [1, 2, 3, 4].map((messageSeq) => ({ messageSeq, deliveredAt: null, seenAt: null }));
    expect(receiptsToAdvance(receipts, 'delivered', 2)).toEqual([1, 2]);
    expect(receiptsToAdvance(receipts, 'delivered', 99)).toEqual([1, 2, 3, 4]);
    expect(receiptsToAdvance(receipts, 'delivered', 0)).toEqual([]);
  });

  it('leaves the ones already acknowledged out', () => {
    const receipts = [
      { messageSeq: 1, deliveredAt: T0, seenAt: T1 },
      { messageSeq: 2, deliveredAt: T0, seenAt: null },
      { messageSeq: 3, deliveredAt: null, seenAt: null },
    ];
    expect(receiptsToAdvance(receipts, 'seen', 3)).toEqual([2, 3]);
    expect(receiptsToAdvance(receipts, 'delivered', 3)).toEqual([3]);
  });
});

describe('C3 unread', () => {
  const r = (messageSeq: number, seenAt: string | null, retracted = false) => ({
    messageSeq,
    deliveredAt: T0,
    seenAt,
    retracted,
  });

  it('counts the unseen, not the seen and not the withdrawn', () => {
    expect(unreadCount([r(1, null), r(2, T1), r(3, null), r(4, null, true)])).toBe(2);
    expect(unreadCount([])).toBe(0);
  });

  it('adds up the badge without the muted conversations', () => {
    expect(
      badgeTotal([
        { unread: 3, muted: false },
        { unread: 10, muted: true },
        { unread: 2, muted: false },
      ]),
    ).toBe(5);
    expect(badgeTotal([])).toBe(0);
  });

  it('writes a count a badge can hold', () => {
    expect(badgeText(0)).toBe('');
    expect(badgeText(-4)).toBe('');
    expect(badgeText(7)).toBe('7');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
    expect(badgeText(Number.NaN)).toBe('');
  });
});

describe('C4 presence from the heartbeat', () => {
  const now = new Date('2026-10-04T08:10:00.000Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

  it('is offline with no heartbeat at all', () => {
    expect(presenceOf(null, now)).toEqual({ state: 'offline', lastSeenAt: null });
    expect(presenceOf({ lastSeenAt: null, lastActiveAt: null, busy: false }, now).state).toBe('offline');
  });

  it('is online when the page asked recently and the person touched it recently', () => {
    expect(presenceOf({ lastSeenAt: ago(3_000), lastActiveAt: ago(20_000), busy: false }, now).state).toBe('online');
  });

  it('is away when the page asks but nobody has touched it for five minutes', () => {
    expect(presenceOf({ lastSeenAt: ago(3_000), lastActiveAt: ago(AWAY_AFTER_MS + 1), busy: false }, now).state).toBe('away');
    expect(presenceOf({ lastSeenAt: ago(3_000), lastActiveAt: null, busy: false }, now).state).toBe('away');
  });

  it('is busy when asked not to be disturbed and still present', () => {
    expect(presenceOf({ lastSeenAt: ago(3_000), lastActiveAt: ago(1_000), busy: true }, now).state).toBe('busy');
  });

  it('is offline once the page has stopped asking, busy or not, and says when it last did', () => {
    const seen = ago(PRESENCE_WINDOW_MS + 1);
    expect(presenceOf({ lastSeenAt: seen, lastActiveAt: seen, busy: true }, now)).toEqual({ state: 'offline', lastSeenAt: seen });
  });

  it('holds right at the edge of the window', () => {
    expect(presenceOf({ lastSeenAt: ago(PRESENCE_WINDOW_MS), lastActiveAt: ago(10_000), busy: false }, now).state).toBe('online');
  });

  it('writes the heartbeat when it is old, when busy changed or when activity resumes', () => {
    const stored = { lastSeenAt: ago(2_000), lastActiveAt: ago(2_000), busy: false };
    expect(shouldWritePresence(null, { active: true, busy: false }, now)).toBe(true);
    expect(shouldWritePresence(stored, { active: true, busy: false }, now)).toBe(false);
    expect(shouldWritePresence(stored, { active: true, busy: true }, now)).toBe(true);
    expect(shouldWritePresence({ ...stored, lastSeenAt: ago(20_000) }, { active: false, busy: false }, now)).toBe(true);
    expect(shouldWritePresence({ ...stored, lastActiveAt: ago(60_000) }, { active: true, busy: false }, now)).toBe(true);
    expect(shouldWritePresence({ ...stored, lastActiveAt: ago(60_000) }, { active: false, busy: false }, now)).toBe(false);
  });
});

describe('C4b typing and polling', () => {
  const now = new Date('2026-10-04T08:10:00.000Z');

  it('is typing until the time it expires', () => {
    expect(isTyping(null, now)).toBe(false);
    expect(isTyping(new Date(now.getTime() + TYPING_TTL_MS).toISOString(), now)).toBe(true);
    expect(isTyping(new Date(now.getTime() - 1).toISOString(), now)).toBe(false);
    expect(isTyping('garbage', now)).toBe(false);
  });

  it('asks fastest on an open thread, slowest in a hidden tab, and backs off on failure', () => {
    expect(pollIntervalMs({ visible: true, open: true })).toBe(2_000);
    expect(pollIntervalMs({ visible: true, open: false })).toBe(6_000);
    expect(pollIntervalMs({ visible: true, open: false, elsewhere: true })).toBe(15_000);
    expect(pollIntervalMs({ visible: false, open: false, elsewhere: true })).toBe(30_000);
    expect(pollIntervalMs({ visible: false, open: true })).toBe(30_000);
    expect(pollIntervalMs({ visible: true, open: true, failures: 2 })).toBe(8_000);
    expect(pollIntervalMs({ visible: true, open: true, failures: 40 })).toBe(60_000);
  });
});

describe('C5 mentions', () => {
  const members = [
    { userId: 'u-ann', name: 'Ann' },
    { userId: 'u-annlee', name: 'Ann Lee' },
    { userId: 'u-bo', name: 'Bo' },
    { userId: 'u-me', name: 'Me Myself' },
  ];

  it('reads @Name against the members', () => {
    expect(deriveMentions('please look @Bo', members)).toEqual(['u-bo']);
    expect(deriveMentions('@Bo and @Ann, thanks', members).sort()).toEqual(['u-ann', 'u-bo']);
  });

  it('takes the longest name', () => {
    expect(deriveMentions('over to @Ann Lee now', members)).toEqual(['u-annlee']);
  });

  it('ignores a name that is only the start of a longer word, and a bare @', () => {
    expect(deriveMentions('@Boris is not here', members)).toEqual([]);
    expect(deriveMentions('mail me @ noon', members)).toEqual([]);
  });

  it('is case-insensitive, counts a person once and never mentions the author', () => {
    expect(deriveMentions('@bo @BO @Bo', members)).toEqual(['u-bo']);
    expect(deriveMentions('note to self @Me Myself', members, 'u-me')).toEqual([]);
  });

  it('works with Arabic names', () => {
    expect(deriveMentions('شكرا @سارة', [{ userId: 'u-s', name: 'سارة' }])).toEqual(['u-s']);
  });
});

describe('C6 the edges', () => {
  it('keys a conversation by its sorted, distinct members', () => {
    expect(memberKeyOf(['B', 'a', 'B'])).toBe('a,b');
    expect(memberKeyOf(['x', 'y'])).toBe(memberKeyOf(['y', 'x']));
  });

  it('trims a body, refuses empty and over-long ones, allows a file with no text', () => {
    expect(assertBody('  hi \r\n there ', false)).toBe('hi \n there');
    expect(() => assertBody('   ', false)).toThrow(ChatError);
    expect(assertBody('', true)).toBe('');
    expect(() => assertBody('x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1), false)).toThrow(/at most 4000/);
    expect(assertBody('x'.repeat(CHAT_MESSAGE_MAX_LENGTH), false)).toHaveLength(CHAT_MESSAGE_MAX_LENGTH);
  });

  it('needs a group name and a reason to withdraw', () => {
    expect(assertTitle('  Month   end ')).toBe('Month end');
    expect(() => assertTitle('  ')).toThrow(ChatError);
    expect(() => assertTitle('x'.repeat(121))).toThrow(ChatError);
    expect(() => assertRetractReason('no')).toThrow(ChatError);
    expect(assertRetractReason(' wrong   thread ')).toBe('wrong thread');
  });

  it('accepts only local links', () => {
    expect(isLocalHref('/payables/invoices/AP-1')).toBe(true);
    expect(isLocalHref('//evil.example')).toBe(false);
    expect(isLocalHref('https://evil.example')).toBe(false);
    expect(isLocalHref('/\\evil')).toBe(false);
    expect(isLocalHref('/')).toBe(false);
    expect(isLocalHref('')).toBe(false);
  });

  it('cleans a prefilled draft and cuts it', () => {
    expect(normaliseDraft(null)).toBe('');
    expect(normaliseDraft('a\u0000b\r\nc\u0007')).toBe('ab\nc');
    expect(normaliseDraft('y'.repeat(CHAT_DRAFT_MAX_LENGTH + 50))).toHaveLength(CHAT_DRAFT_MAX_LENGTH);
  });

  it('turns a search into a literal pattern, or nothing when too short', () => {
    expect(searchTerm(' a ')).toBeNull();
    expect(searchTerm('  invoice   42 ')).toBe('invoice 42');
    expect(likePattern('50%_off')).toBe('%50\\%\\_off%');
  });

  it('cuts a preview at a word', () => {
    expect(preview('short')).toBe('short');
    const long = 'word '.repeat(60);
    const cut = preview(long, 50);
    expect(cut.length).toBeLessThanOrEqual(51);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/\swor…$/);
  });

  it('knows which files can be shown in place', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('image/svg+xml')).toBe('file');
    expect(previewKind('application/pdf')).toBe('pdf');
    expect(previewKind('application/zip')).toBe('file');
    expect(sizeText(512)).toBe('512 B');
    expect(sizeText(1536)).toBe('1.5 KB');
    expect(sizeText(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(sizeText(-1)).toBe('');
  });

  it('knows the reaction codes', () => {
    expect(isChatReaction('like')).toBe(true);
    expect(isChatReaction('poop')).toBe(false);
  });
});
