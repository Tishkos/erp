/**
 * When the application makes a sound — src/lib/sound-rules.ts (2026-10-06).
 *
 *   S1  a message from somebody else, not muted, not being read, not while Busy, not on the first look
 *   S2  the bell: more unread than before, the chat's own left out
 *   S3  a form's result, from the address and from the banner that appeared
 *   S4  one missing-field sound per try
 *   S5  never before the person has touched the page, never for a program, never when switched off
 */
import { describe, expect, it } from 'vitest';
import {
  SOUND_KINDS,
  burstGate,
  incomingChime,
  notificationChime,
  resultOfAddress,
  resultOfBanner,
  silencedByBusy,
  soundAllowed,
  type ConversationTick,
} from '@/lib/sound-rules';

const ME = 'me-0000';
const row = (over: Partial<ConversationTick> = {}): ConversationTick => ({
  id: 'c1',
  lastSeq: 4,
  unread: 0,
  muted: false,
  lastMessage: { senderId: 'other', kind: 'text' },
  ...over,
});
const context = { meId: ME, busy: false, inFront: null };

describe('S1 · a message arrived', () => {
  it('chimes for a new unread message from somebody else', () => {
    expect(incomingChime([row()], [row({ lastSeq: 5, unread: 1 })], context)).toBe(true);
    // A conversation that was not in the list before.
    expect(incomingChime([], [row({ lastSeq: 1, unread: 1 })], context)).toBe(true);
  });
  it('stays quiet on the first look, for one\'s own message, a system line, a muted or open conversation, or while Busy', () => {
    const after = [row({ lastSeq: 5, unread: 1 })];
    expect(incomingChime(null, after, context)).toBe(false);
    expect(incomingChime([row()], [row({ lastSeq: 5, unread: 1, lastMessage: { senderId: ME, kind: 'text' } })], context)).toBe(false);
    expect(incomingChime([row()], [row({ lastSeq: 5, unread: 1, lastMessage: { senderId: 'other', kind: 'system' } })], context)).toBe(false);
    expect(incomingChime([row()], [row({ lastSeq: 5, unread: 1, muted: true })], context)).toBe(false);
    expect(incomingChime([row()], after, { ...context, inFront: 'c1' })).toBe(false);
    expect(incomingChime([row()], after, { ...context, busy: true })).toBe(false);
  });
  it('stays quiet when nothing new is unread (read on another device, a reaction moving the list)', () => {
    expect(incomingChime([row({ unread: 2 })], [row({ lastSeq: 5, unread: 2 })], context)).toBe(false);
    expect(incomingChime([row({ unread: 1 })], [row({ unread: 0 })], context)).toBe(false);
  });
});

describe('S2 · the bell', () => {
  it('chimes when unread rises outside the chat', () => {
    expect(notificationChime([{ category: 'approvals', unread: 1 }], [{ category: 'approvals', unread: 2 }], { busy: false })).toBe(true);
    expect(notificationChime([], [{ category: 'tasks', unread: 1 }], { busy: false })).toBe(true);
  });
  it('stays quiet on the first look, for the chat\'s own, when counts fall, or while Busy', () => {
    expect(notificationChime(null, [{ category: 'tasks', unread: 3 }], { busy: false })).toBe(false);
    expect(notificationChime([{ category: 'chat', unread: 0 }], [{ category: 'chat', unread: 4 }], { busy: false })).toBe(false);
    expect(notificationChime([{ category: 'tasks', unread: 3 }], [{ category: 'tasks', unread: 1 }], { busy: false })).toBe(false);
    expect(notificationChime([{ category: 'tasks', unread: 0 }], [{ category: 'tasks', unread: 1 }], { busy: true })).toBe(false);
  });
});

describe('S3 · a form\'s result', () => {
  it('reads the address a server action came back to', () => {
    expect(resultOfAddress('?saved=1')).toBe('success');
    expect(resultOfAddress('saved=1&q=x')).toBe('success');
    expect(resultOfAddress('?error=That%20period%20is%20closed')).toBe('error');
    expect(resultOfAddress('?saved=1&error=x')).toBe('error');
    expect(resultOfAddress('?error=')).toBe(null);
    expect(resultOfAddress('?q=gstest&page=2')).toBe(null);
  });
  it('reads the banner: Flash saved is a status, a refusal is an alert', () => {
    expect(resultOfBanner({ role: 'status', className: 'admin-module__x1__flash' })).toBe('success');
    expect(resultOfBanner({ role: 'alert', className: 'admin-module__x1__flash admin-module__x1__flashError' })).toBe('error');
    expect(resultOfBanner({ role: 'alert', className: '' })).toBe('error');
    // A status that is not the result banner (a loading line) is not a result.
    expect(resultOfBanner({ role: 'status', className: 'space-y-1 p-2' })).toBe(null);
    expect(resultOfBanner({ role: null, className: 'flash' })).toBe(null);
  });
});

describe('S4 · one missing-field sound per try', () => {
  it('answers true once per burst', () => {
    let t = 1_000;
    const gate = burstGate(800, () => t);
    expect(gate()).toBe(true);
    t += 5;
    expect(gate()).toBe(false);
    t += 5;
    expect(gate()).toBe(false);
    t += 2_000;
    expect(gate()).toBe(true);
  });
});

describe('S5 · whether the page may sound at all', () => {
  const env = { enabled: true, activated: true, webdriver: false, userAgent: 'Mozilla/5.0', camera: false };
  it('sounds for a person who has touched the page and kept Sounds on', () => {
    expect(soundAllowed(env)).toBe(true);
  });
  it('never before the first touch, for a program, for Noah\'s camera, or when switched off', () => {
    expect(soundAllowed({ ...env, activated: false })).toBe(false);
    expect(soundAllowed({ ...env, webdriver: true })).toBe(false);
    expect(soundAllowed({ ...env, camera: true })).toBe(false);
    expect(soundAllowed({ ...env, userAgent: 'Mozilla/5.0 noah-live-screenshot' })).toBe(false);
    expect(soundAllowed({ ...env, enabled: false })).toBe(false);
  });
  it('Busy silences messages and notifications, never the person\'s own results', () => {
    expect(SOUND_KINDS.filter(silencedByBusy)).toEqual(['message', 'notification']);
  });
});
