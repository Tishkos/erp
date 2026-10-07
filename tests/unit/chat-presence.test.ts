/**
 * The status a person chooses (2026-10-06, migration 0410) — domain/chat.ts.
 *
 *   P1  Available is the heartbeat's own answer: Online, Away when idle, Offline when gone
 *   P2  Busy and Away hold while the person is here, whatever their activity
 *   P3  Appear offline shows Offline and never a "last seen"
 *   P4  gone is Offline whatever was chosen
 *   P5  a row written before 0410 is read from its busy flag
 *   P6  the person's own dot, and who hears message sounds
 */
import { describe, expect, it } from 'vitest';
import {
  AWAY_AFTER_MS,
  CHOSEN_STATUSES,
  PRESENCE_WINDOW_MS,
  chosenStatusOf,
  isChosenStatus,
  mayChime,
  ownPresenceOf,
  presenceOf,
  type ChosenStatus,
} from '@domain/chat';

const now = new Date('2026-10-06T09:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const here = (status: ChosenStatus, idleMs = 1_000) => ({
  lastSeenAt: ago(3_000),
  lastActiveAt: ago(idleMs),
  busy: status === 'busy',
  status,
});

describe('P1 · Available is what the heartbeat says', () => {
  it('online while active, away after five idle minutes', () => {
    expect(presenceOf(here('available'), now).state).toBe('online');
    expect(presenceOf(here('available', AWAY_AFTER_MS + 1), now).state).toBe('away');
  });
});

describe('P2 · Busy and Away hold while the person is here', () => {
  it('busy is busy, active or not', () => {
    expect(presenceOf(here('busy'), now).state).toBe('busy');
    expect(presenceOf(here('busy', AWAY_AFTER_MS + 1), now).state).toBe('busy');
  });
  it('away is away, however active', () => {
    expect(presenceOf(here('away', 0), now).state).toBe('away');
    expect(presenceOf(here('away'), now).lastSeenAt).toBe(ago(3_000));
  });
});

describe('P3 · Appear offline gives nothing away', () => {
  it('is offline with no last seen, even while active', () => {
    expect(presenceOf(here('invisible', 0), now)).toEqual({ state: 'offline', lastSeenAt: null });
  });
});

describe('P4 · gone is offline whatever was chosen', () => {
  it('after the presence window every status reads offline, with when they were last here', () => {
    for (const status of ['available', 'busy', 'away'] as const) {
      const seen = ago(PRESENCE_WINDOW_MS + 1);
      expect(presenceOf({ lastSeenAt: seen, lastActiveAt: seen, busy: status === 'busy', status }, now)).toEqual({
        state: 'offline',
        lastSeenAt: seen,
      });
    }
  });
});

describe('P5 · the stored status, read leniently', () => {
  it('knows the four and nothing else', () => {
    expect(CHOSEN_STATUSES).toEqual(['available', 'busy', 'away', 'invisible']);
    for (const status of CHOSEN_STATUSES) expect(isChosenStatus(status)).toBe(true);
    for (const other of ['online', 'offline', '', null, undefined, 3]) expect(isChosenStatus(other)).toBe(false);
  });
  it('a row without a status is read from its busy flag', () => {
    expect(chosenStatusOf({ status: null, busy: true })).toBe('busy');
    expect(chosenStatusOf({ busy: false })).toBe('available');
    expect(chosenStatusOf({ status: 'away', busy: false })).toBe('away');
    expect(chosenStatusOf({ status: 'nonsense', busy: false })).toBe('available');
    // The pre-0410 shape still gives the pre-0410 answer.
    expect(presenceOf({ lastSeenAt: ago(3_000), lastActiveAt: ago(1_000), busy: true }, now).state).toBe('busy');
  });
});

describe('P6 · the person themself', () => {
  it('wears the dot they chose', () => {
    expect(ownPresenceOf('available')).toBe('online');
    expect(ownPresenceOf('busy')).toBe('busy');
    expect(ownPresenceOf('away')).toBe('away');
    expect(ownPresenceOf('invisible')).toBe('offline');
  });
  it('hears message sounds unless Busy', () => {
    expect(mayChime('busy')).toBe(false);
    for (const status of ['available', 'away', 'invisible', null, undefined] as const) expect(mayChime(status)).toBe(true);
  });
});
