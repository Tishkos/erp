/**
 * The pop-up notifications — src/lib/toast-rules.ts (2026-10-07).
 *
 *   T1  how long each stays, and how many at once
 *   T2  whether this page pops anything up: the switch, errors always, never for Noah's camera or an unasking program
 *   T3  a form's result: only the result banner (Flash), its words, the address, a bare code never shown
 *   T4  one result per press: nothing without a press, never twice, not after two minutes, not after back/forward
 *   T5  the server action's own answer is recognised; a page fetch or another address is not
 *   T6  the bell: as many of the newest unread as the count rose by, the chat's left out, none told twice
 *   T7  the chat: the message sound's own rule, per conversation, and never on the chat screen
 */
import { describe, expect, it } from 'vitest';
import { incomingChime, type ConversationTick } from '@/lib/sound-rules';
import {
  ERROR_TIMEOUT_MS,
  RESULT_WAIT_MS,
  TOAST_KINDS,
  TOAST_MAX_VISIBLE,
  TOAST_TIMEOUT_MS,
  addressResult,
  bannerWords,
  incomingRows,
  isActionAnswer,
  mayPopUp,
  newNotices,
  onceWithin,
  pickResult,
  popupMode,
  readableError,
  resultGate,
  timeoutFor,
  toastOfBanner,
  type NoticeTick,
} from '@/lib/toast-rules';

const env = { stored: null, webdriver: false, camera: false, userAgent: 'Mozilla/5.0' };

describe('T1 · how long, how many', () => {
  it('stays five seconds, an error eight; three at a time', () => {
    for (const kind of TOAST_KINDS) expect(timeoutFor(kind)).toBe(kind === 'error' ? ERROR_TIMEOUT_MS : TOAST_TIMEOUT_MS);
    expect(TOAST_TIMEOUT_MS).toBe(5_000);
    expect(ERROR_TIMEOUT_MS).toBe(8_000);
    expect(TOAST_MAX_VISIBLE).toBe(3);
  });
});

describe('T2 · whether this page pops anything up', () => {
  it('is on unless the person turned it off; off still shows a refusal', () => {
    expect(popupMode(env)).toBe('all');
    expect(popupMode({ ...env, stored: 'on' })).toBe('all');
    expect(popupMode({ ...env, stored: 'off' })).toBe('errors');
    for (const kind of TOAST_KINDS) {
      expect(mayPopUp(kind, 'all')).toBe(true);
      expect(mayPopUp(kind, 'errors')).toBe(kind === 'error');
      expect(mayPopUp(kind, 'none')).toBe(false);
    }
  });
  it('never for Noah’s camera; for a program only when it asked', () => {
    expect(popupMode({ ...env, camera: true, stored: 'on' })).toBe('none');
    expect(popupMode({ ...env, userAgent: 'HeadlessChrome noah-live-screenshot', stored: 'on' })).toBe('none');
    expect(popupMode({ ...env, webdriver: true })).toBe('none');
    expect(popupMode({ ...env, webdriver: true, stored: 'on' })).toBe('all');
    expect(popupMode({ ...env, webdriver: true, stored: 'off' })).toBe('errors');
  });
});

describe('T3 · a form’s result', () => {
  const flash = 'admin-module__x__flash';
  const flashError = 'admin-module__x__flash admin-module__x__flashError';
  it('pops up for the result banner only', () => {
    expect(toastOfBanner({ role: 'status', className: flash })).toBe('success');
    expect(toastOfBanner({ role: 'alert', className: flashError })).toBe('error');
    // A row's or a field's own error stays beside it; a status that is not the banner is not a result.
    expect(toastOfBanner({ role: 'alert', className: 'admin-module__x__sapRowError' })).toBeNull();
    expect(toastOfBanner({ role: 'alert', className: '' })).toBeNull();
    expect(toastOfBanner({ role: 'status', className: 'erp-search__empty' })).toBeNull();
    expect(toastOfBanner({ role: 'status', className: flashError })).toBeNull();
  });
  it('reads the address once it is not the one the form was sent from', () => {
    expect(addressResult('/x?saved=1', '/x')).toBe('success');
    expect(addressResult('/x?error=The+period+is+closed', '/x?saved=1')).toBe('error');
    expect(addressResult('/y?saved=1', '/x?saved=1')).toBe('success');
    // A second save on a page that already says Saved: the banner tells it, not the address.
    expect(addressResult('/x?saved=1', '/x?saved=1')).toBeNull();
    expect(addressResult('/x?page=2', '/x')).toBeNull();
    expect(addressResult('/x', '/x?saved=1')).toBeNull();
  });
  it('chooses the banner the address agrees with, else Saved', () => {
    expect(pickResult([], 'success')).toBe(-1);
    expect(pickResult(['error', 'success'], 'error')).toBe(0);
    expect(pickResult(['error', 'success'], null)).toBe(1);
    expect(pickResult(['error'], 'success')).toBe(0);
  });
  it('takes the banner’s heading as the title and its sentence as the line', () => {
    expect(bannerWords({ strong: 'That could not be saved.', rest: '  The period\n is closed. ' })).toEqual({
      title: 'That could not be saved.',
      line: 'The period is closed.',
    });
    expect(bannerWords({ strong: '', rest: ' Saved. ' })).toEqual({ title: 'Saved.', line: '' });
    expect(bannerWords({ strong: '', rest: 'x'.repeat(400) }, 20).title).toHaveLength(20);
  });
  it('shows the address’s sentence, never a bare code', () => {
    expect(readableError('?error=The%20period%20is%20closed.')).toBe('The period is closed.');
    expect(readableError('?error=%D9%84%D9%85')).toBe('لم');
    expect(readableError('?error=not_found')).toBeNull();
    expect(readableError('?error=')).toBeNull();
    expect(readableError('?saved=1')).toBeNull();
  });
});

describe('T4 · one result per press', () => {
  it('waits only after a press, tells the first result once, and forgets on back/forward or after two minutes', () => {
    let now = 1_000;
    const gate = resultGate(() => now);
    // A page opened with a banner on it — or reloaded, or reached by back/forward — was not sent from here.
    expect(gate.current()).toBeNull();
    expect(gate.take()).toBe(false);

    gate.arm('http://x/a', '/a', 10);
    expect(gate.current()).toMatchObject({ url: 'http://x/a', address: '/a', at: 10, answered: false });
    gate.answered();
    expect(gate.current()?.answered).toBe(true);
    expect(gate.take()).toBe(true);
    // The banner and the address both say it: one pop-up.
    expect(gate.take()).toBe(false);

    gate.arm('http://x/a', '/a', 20);
    gate.forget();
    expect(gate.take()).toBe(false);

    gate.arm('http://x/a', '/a', 30);
    now += RESULT_WAIT_MS + 1;
    expect(gate.current()).toBeNull();
    expect(gate.take()).toBe(false);
  });
  it('says the same words once within a moment', () => {
    let now = 0;
    const once = onceWithin(1_500, () => now);
    expect(once('success|Saved.|')).toBe(true);
    expect(once('success|Saved.|')).toBe(false);
    expect(once('error|Not saved|')).toBe(true);
    now = 2_000;
    expect(once('success|Saved.|')).toBe(true);
  });
});

describe('T5 · the server action’s answer', () => {
  const armed = { url: 'http://localhost:3300/payables/invoices/API-1?saved=1#lines', at: 500 };
  it('is a fetch to the page’s own address, begun after the press', () => {
    expect(isActionAnswer({ name: 'http://localhost:3300/payables/invoices/API-1?saved=1', initiatorType: 'fetch', startTime: 520 }, armed)).toBe(true);
    expect(isActionAnswer({ name: 'http://localhost:3300/payables/invoices/API-1?saved=1', initiatorType: 'fetch', startTime: 400 }, armed)).toBe(false);
    // Next's page requests carry _rsc; the bell's and the chat's polls are other addresses; an image is not an answer.
    expect(isActionAnswer({ name: 'http://localhost:3300/payables/invoices/API-1?saved=1&_rsc=abc', initiatorType: 'fetch', startTime: 520 }, armed)).toBe(false);
    expect(isActionAnswer({ name: 'http://localhost:3300/notifications/api/feed', initiatorType: 'fetch', startTime: 520 }, armed)).toBe(false);
    expect(isActionAnswer({ name: 'http://localhost:3300/payables/invoices/API-1?saved=1', initiatorType: 'img', startTime: 520 }, armed)).toBe(false);
  });
});

describe('T6 · the bell', () => {
  const item = (id: string, over: Partial<NoticeTick> = {}): NoticeTick => ({ id, category: 'approvals', read: false, reason: null, ...over });
  const counts = (approvals: number, chat = 0) => [
    { category: 'approvals', unread: approvals },
    { category: 'chat', unread: chat },
  ];
  it('takes as many of the newest unread as the count rose by', () => {
    const list = [item('9'), item('8'), item('7')];
    expect(newNotices(counts(1), counts(3), list, new Set()).map((n) => n.id)).toEqual(['9', '8']);
    expect(newNotices(counts(1), counts(1), list, new Set())).toEqual([]);
    expect(newNotices(counts(3), counts(2), list, new Set())).toEqual([]);
  });
  it('leaves out the chat’s own, one already told, one read, one no longer the reader’s, and stops at three', () => {
    const list = [item('9', { category: 'chat' }), item('8'), item('7', { read: true }), item('6')];
    expect(newNotices(counts(0), counts(2, 1), list, new Set()).map((n) => n.id)).toEqual(['8', '6']);
    expect(newNotices(counts(0), counts(2), list, new Set(['8'])).map((n) => n.id)).toEqual(['6']);
    // The chat's count rising is the chat's, not the bell's news.
    expect(newNotices(counts(0, 0), counts(0, 4), list, new Set())).toEqual([]);
    expect(newNotices(counts(0), counts(1), [item('5', { reason: 'no_access' })], new Set())).toEqual([]);
    const many = ['1', '2', '3', '4', '5'].map((id) => item(id));
    expect(newNotices(counts(0), counts(5), many, new Set())).toHaveLength(TOAST_MAX_VISIBLE);
  });
});

describe('T7 · the chat', () => {
  const ME = 'me-0000';
  const row = (over: Partial<ConversationTick> = {}): ConversationTick => ({
    id: 'c1',
    lastSeq: 4,
    unread: 0,
    muted: false,
    lastMessage: { senderId: 'other', kind: 'text' },
    ...over,
  });
  const context: { meId: string; busy: boolean; inFront: string | null; onChatScreen: boolean } = {
    meId: ME,
    busy: false,
    inFront: null,
    onChatScreen: false,
  };
  const cases: Array<[ConversationTick[] | null, ConversationTick[], typeof context]> = [
    [[row()], [row({ lastSeq: 5, unread: 1 })], context],
    [[], [row({ lastSeq: 1, unread: 1 })], context],
    [null, [row({ lastSeq: 5, unread: 1 })], context],
    [[row()], [row({ lastSeq: 5, unread: 1, lastMessage: { senderId: ME, kind: 'text' } })], context],
    [[row()], [row({ lastSeq: 5, unread: 1, lastMessage: { senderId: 'other', kind: 'system' } })], context],
    [[row()], [row({ lastSeq: 5, unread: 1, muted: true })], context],
    [[row()], [row({ lastSeq: 5, unread: 1 })], { ...context, inFront: 'c1' }],
    [[row()], [row({ lastSeq: 5, unread: 1 })], { ...context, busy: true }],
    [[row({ lastSeq: 5, unread: 1 })], [row({ lastSeq: 5, unread: 1 })], context],
  ];
  it('pops up exactly where the message sound plays', () => {
    for (const [before, after, ctx] of cases) {
      expect(incomingRows(before, after, ctx).length > 0).toBe(incomingChime(before, after, ctx));
    }
  });
  it('names each conversation, and never on the chat screen', () => {
    const before = [row({ id: 'a' }), row({ id: 'b' })];
    const after = [row({ id: 'a', lastSeq: 5, unread: 1 }), row({ id: 'b' }), row({ id: 'c', lastSeq: 1, unread: 1 })];
    expect(incomingRows(before, after, context).map((r) => r.id)).toEqual(['a', 'c']);
    expect(incomingRows(before, after, { ...context, onChatScreen: true })).toEqual([]);
  });
});
