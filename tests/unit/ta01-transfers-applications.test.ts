/**
 * Transfers & Applications, 2026-10-15 — by direction:
 *
 *   TA1  "search by name, not just by code … if the supplier is Hama I can
 *        search by ham, much smarter": the search box reads words, folded.
 *   TA2  "more options — pending etc, much more states": the Status filter's
 *        groups and single statuses, and the earlier view names still read.
 *   TA3  "the bank payment for that import should be locked to the same bank
 *        as the first payment application".
 *   TA4  "sometimes I change the tabs and it removes everything … local
 *        storage … multi-tab": what a kept form restores and lists.
 */
import { describe, expect, it } from 'vitest';
import { MAX_SEARCH_WORDS, searchWords } from '@/server/domain/search';
import { STATUS_GROUPS, bankKeyOf, keepsTheBank, statusesOf } from '@/server/domain/payment-applications';
import {
  FORM_MEMORY_DAYS,
  type StoredForm,
  draftsOf,
  isEmptyChange,
  memoryKey,
  parseStored,
  shouldRestore,
} from '@/lib/form-memory';

describe('TA1 · the search box reads words', () => {
  it('splits, folds and keeps each word once', () => {
    expect(searchWords('  Hama  ')).toEqual(['hama']);
    expect(searchWords('ham 2026')).toEqual(['ham', '2026']);
    expect(searchWords('HAM ham Ham')).toEqual(['ham']);
    // Arabic letter forms and digits fold as Global Search folds them.
    expect(searchWords('شركة أحمد ١٢٣')).toEqual(['شركه', 'احمد', '123']);
  });

  it('nothing asked is no search, and a long phrase is cut', () => {
    expect(searchWords('')).toEqual([]);
    expect(searchWords(null)).toEqual([]);
    expect(searchWords(' ‏ ')).toEqual([]);
    expect(searchWords('a b c d e f g h')).toHaveLength(MAX_SEARCH_WORDS);
  });
});

describe('TA2 · the Status filter', () => {
  it('reads a group, one status, an earlier view name, or nothing', () => {
    expect(statusesOf('pending')).toEqual(['draft', 'submitted', 'approved', 'sent']);
    expect(statusesOf('not_with_bank')).toEqual(['draft', 'submitted', 'approved']);
    expect(statusesOf('paid')).toEqual(['confirmed', 'debited']);
    expect(statusesOf('closed')).toEqual(['rejected', 'cancelled', 'reversed']);
    expect(statusesOf('sent')).toEqual(['sent']);
    expect(statusesOf('waiting')).toEqual(['sent']);
    expect(statusesOf('to_approve')).toEqual(['submitted']);
    expect(statusesOf('')).toBeNull();
    expect(statusesOf('nonsense')).toBeNull();
  });

  it('pending and closed together are every status', () => {
    const all = new Set([...STATUS_GROUPS.pending, ...STATUS_GROUPS.paid, ...STATUS_GROUPS.closed]);
    // Nine since 0427: a paid application can be reversed.
    expect(all.size).toBe(9);
  });
});

describe('TA3 · one import, one bank', () => {
  const at = (id: string, bankCode: string | null, bankName: string | null, accountType = 'bank') => ({ id, accountType, bankCode, bankName });

  it('the bank list names the bank; else the bank the account names; else the account', () => {
    expect(bankKeyOf(at('a', 'RAF', 'Rafidain'))).toBe('bank:RAF');
    expect(bankKeyOf(at('a', null, '  Rafidain   Bank '))).toBe('name:rafidain bank');
    expect(bankKeyOf(at('a', null, null))).toBe('account:a');
    expect(bankKeyOf(at('a', null, null, 'cash'))).toBeNull();
  });

  it('a later bank application keeps the first one’s bank; cash neither sets nor meets it', () => {
    const first = at('a', 'RAF', null);
    expect(keepsTheBank(null, at('b', 'MNS', null))).toBe(true);
    expect(keepsTheBank(first, at('b', 'RAF', null))).toBe(true);
    expect(keepsTheBank(first, at('c', 'MNS', null))).toBe(false);
    expect(keepsTheBank(first, at('d', null, null, 'cash'))).toBe(true);
    // Not on the bank list: the bank it names, written any way.
    expect(keepsTheBank(at('a', null, 'Rafidain Bank'), at('b', null, 'rafidain  bank'))).toBe(true);
    expect(keepsTheBank(at('a', null, 'Rafidain Bank'), at('b', null, 'Mansour Bank'))).toBe(false);
  });
});

describe('TA4 · a kept form', () => {
  const now = Date.parse('2026-10-15T09:00:00Z');
  const entry = (over: Partial<StoredForm> = {}): StoredForm => ({
    v: 1,
    title: 'IMP-HQ-2026-000014 · Hama',
    href: '/payables/payment-applications/new?import=IMP-HQ-2026-000014',
    savedAt: '2026-10-15T08:30:00Z',
    submittedAt: null,
    values: { amount: ['3500'] },
    ...over,
  });

  it('is kept per person and per record', () => {
    expect(memoryKey('u1', 'payapp-new:IMP-1')).toBe('qimah:form:u1:payapp-new:IMP-1');
    expect(memoryKey('u1', 'payapp-new:IMP-1')).not.toBe(memoryKey('u2', 'payapp-new:IMP-1'));
  });

  it('comes back unless it was saved — and comes back after a refused save', () => {
    expect(shouldRestore(entry(), { refused: false, now })).toBe(true);
    expect(shouldRestore(entry({ submittedAt: '2026-10-15T08:31:00Z' }), { refused: false, now })).toBe(false);
    expect(shouldRestore(entry({ submittedAt: '2026-10-15T08:31:00Z' }), { refused: true, now })).toBe(true);
    const old = new Date(now - (FORM_MEMORY_DAYS + 1) * 86_400_000).toISOString();
    expect(shouldRestore(entry({ savedAt: old }), { refused: false, now })).toBe(false);
  });

  it('nothing typed keeps nothing; a row not drawn yet reads as blank', () => {
    expect(isEmptyChange({ amount: [''], method: ['SWIFT'] }, { amount: [''], method: ['SWIFT'] })).toBe(true);
    expect(isEmptyChange({ amount: [''] }, { amount: ['10'] })).toBe(false);
    expect(isEmptyChange({ qty: [''] }, { qty: ['', ''] })).toBe(true);
    expect(isEmptyChange({ qty: [''] }, { qty: ['', '5'] })).toBe(false);
  });

  it('reads only what it wrote', () => {
    expect(parseStored(JSON.stringify(entry()))).toEqual(entry());
    expect(parseStored('{"v":2}')).toBeNull();
    expect(parseStored('not json')).toBeNull();
    expect(parseStored(null)).toBeNull();
  });

  it('lists the person’s drafts in progress, the latest first — not sent ones, not someone else’s', () => {
    const prefix = memoryKey('u1', 'payapp-new:');
    const pairs: [string, string][] = [
      [memoryKey('u1', 'payapp-new:IMP-1'), JSON.stringify(entry({ savedAt: '2026-10-15T08:00:00Z' }))],
      [memoryKey('u1', 'payapp-new:IMP-2'), JSON.stringify(entry({ savedAt: '2026-10-15T08:45:00Z', title: 'IMP-2' }))],
      [memoryKey('u1', 'payapp-new:IMP-3'), JSON.stringify(entry({ submittedAt: '2026-10-15T08:50:00Z' }))],
      [memoryKey('u2', 'payapp-new:IMP-4'), JSON.stringify(entry())],
      [memoryKey('u1', 'other:IMP-5'), JSON.stringify(entry())],
    ];
    expect(draftsOf(pairs, prefix, now).map((draft) => draft.key)).toEqual([
      memoryKey('u1', 'payapp-new:IMP-2'),
      memoryKey('u1', 'payapp-new:IMP-1'),
    ]);
  });
});
