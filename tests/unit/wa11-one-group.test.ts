/**
 * One group, and nothing else — 2026-10-04, by direction: "it should only send
 * it to the group and also it should only answer in the group … never reply to
 * personal messages … it's private, just for one group … name them, fetch them
 * from their name in WhatsApp if possible".
 *
 * The bridge is linked to a person's own WhatsApp account. These are the rules
 * that keep the rest of that account out of the ERP: what the bot hears, where
 * it may write, and whose names it may keep.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, listensTo, maySendTo, type BotSettings } from '@domain/whatsapp';
import { learnName, nameOf, tidyName, type NameBook } from '@domain/whatsapp-names';
import { expectedNumbers, knownNames, rememberNames } from '@/server/services/whatsapp-names';

const GROUP = '120363000000000001@g.us';
const OTHER = '120363000000000999@g.us';
const settings = (over: Partial<BotSettings> = {}): BotSettings => ({ ...DEFAULT_SETTINGS, ...over });

describe('what the bot hears', () => {
  it('group only is the default', () => {
    expect(DEFAULT_SETTINGS.groupOnly).toBe(true);
  });

  it('hears its one registered group, and nothing else', () => {
    const on = settings({ groupJid: GROUP, groupQueries: true });
    expect(listensTo(on, GROUP)).toBe(true);
    expect(listensTo(on, OTHER), 'another group').toBe(false);
    expect(listensTo(on, null), 'a private message').toBe(false);
    expect(listensTo(on, undefined), 'a private message').toBe(false);
  });

  it('hears nothing at all until a group is registered', () => {
    const unregistered = settings({ groupJid: '' });
    expect(listensTo(unregistered, null)).toBe(false);
    expect(listensTo(unregistered, GROUP)).toBe(false);
    expect(listensTo(unregistered, '')).toBe(false);
  });

  it('is silent in its own group when questions there are switched off', () => {
    expect(listensTo(settings({ groupJid: GROUP, groupQueries: false }), GROUP)).toBe(false);
  });

  it('with group only off, a private chat is heard again — and still only the one group', () => {
    const off = settings({ groupOnly: false, groupJid: GROUP, groupQueries: true });
    expect(listensTo(off, null)).toBe(true);
    expect(listensTo(off, GROUP)).toBe(true);
    expect(listensTo(off, OTHER)).toBe(false);
  });
});

describe('where the bot may write', () => {
  it('to its group and to nobody\'s own chat', () => {
    const on = settings({ groupJid: GROUP });
    expect(maySendTo(on, { groupJid: GROUP })).toBe(true);
    expect(maySendTo(on, {}), 'a person\'s own chat').toBe(false);
    expect(maySendTo(on, { groupJid: null })).toBe(false);
    expect(maySendTo(on, { groupJid: OTHER }), 'another group').toBe(false);
  });

  it('nowhere at all until a group is registered', () => {
    expect(maySendTo(settings({ groupJid: '' }), { groupJid: GROUP })).toBe(false);
    expect(maySendTo(settings({ groupJid: '' }), {})).toBe(false);
  });

  it('with group only off, wherever it is asked to', () => {
    expect(maySendTo(settings({ groupOnly: false, groupJid: GROUP }), {})).toBe(true);
  });
});

describe('the names WhatsApp shows', () => {
  it('keeps a saved name and a profile name apart, and prefers the saved one', () => {
    const book: NameBook = {};
    expect(learnName(book, { e164: '+9647824620327', profile: 'Ali 🌙' }, 't1')).toBe(true);
    expect(nameOf(book, '+9647824620327')).toBe('Ali 🌙');
    expect(learnName(book, { e164: '+9647824620327', saved: 'Ali — accountant' }, 't2')).toBe(true);
    expect(book['+9647824620327']).toEqual({ saved: 'Ali — accountant', profile: 'Ali 🌙', at: 't2' });
    expect(nameOf(book, '+9647824620327')).toBe('Ali — accountant');
    // The same again is not news.
    expect(learnName(book, { e164: '+9647824620327', profile: 'Ali 🌙' }, 't3')).toBe(false);
    expect(book['+9647824620327']!.at).toBe('t2');
  });

  it('ignores an empty name, a name that is only the number, and something that is not a number', () => {
    const book: NameBook = {};
    expect(tidyName('  ')).toBeNull();
    expect(tidyName('+964 782 462 0327')).toBeNull();
    expect(tidyName('  Zahra   Ahmed ')).toBe('Zahra Ahmed');
    expect(learnName(book, { e164: '+9647824620327', profile: '+964 782 462 0327' }, 't')).toBe(false);
    expect(learnName(book, { e164: 'not-a-number', profile: 'Somebody' }, 't')).toBe(false);
    expect(book).toEqual({});
    expect(nameOf(book, '+9647824620327')).toBeNull();
  });
});

describe('whose names are kept — only the people named for the group', () => {
  const previous = { names: process.env.WA_NAMES_FILE, expected: process.env.WA_EXPECTED_FILE };
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wa-names-'));
    process.env.WA_NAMES_FILE = join(dir, 'var', 'whatsapp', 'names.json');
    process.env.WA_EXPECTED_FILE = join(dir, 'expected.json');
  });

  afterEach(() => {
    for (const [key, value] of [['WA_NAMES_FILE', previous.names], ['WA_EXPECTED_FILE', previous.expected]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('with no expected list, nothing is kept — not one name, not the file', () => {
    expect(expectedNumbers().size).toBe(0);
    expect(rememberNames([{ e164: '+9647824620327', saved: 'Ali' }, { e164: '+36201234567', saved: 'Mother' }])).toBe(0);
    expect(existsSync(process.env.WA_NAMES_FILE!)).toBe(false);
    expect(knownNames()).toEqual({});
  });

  it('keeps the expected numbers\' names, and nobody else\'s from the same contact list', () => {
    writeFileSync(process.env.WA_EXPECTED_FILE!, JSON.stringify(['+9647824620327', '+9647824620007']));
    const learned = rememberNames([
      { e164: '+9647824620327', saved: 'Ali', profile: 'Ali A.' },
      { e164: '+36201234567', saved: 'Mother' },
      { e164: '+9647700000000', profile: 'A stranger' },
      { e164: '+9647824620007', profile: 'Zahra' },
    ]);
    expect(learned).toBe(2);
    const file = readFileSync(process.env.WA_NAMES_FILE!, 'utf8');
    expect(file).not.toMatch(/Mother|stranger|\+36201234567|\+9647700000000/);
    expect(Object.keys(knownNames()).sort()).toEqual(['+9647824620007', '+9647824620327']);
    expect(nameOf(knownNames(), '+9647824620327')).toBe('Ali');
    // Nothing new, nothing written.
    expect(rememberNames([{ e164: '+9647824620327', saved: 'Ali' }])).toBe(0);
  });

  it('a list that cannot be read is no list', () => {
    writeFileSync(process.env.WA_EXPECTED_FILE!, 'not json');
    expect(expectedNumbers().size).toBe(0);
    expect(rememberNames([{ e164: '+9647824620327', saved: 'Ali' }])).toBe(0);
  });
});
