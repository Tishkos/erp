/**
 * REQ-WA-001 WA-8 — he proposes, a person confirms.
 *
 * The whole safety of acting from chat rests on one judgement: what counts as
 * a yes. Too strict and a person says "ok" and nothing happens, which they
 * will forgive. Too loose and a sentence that merely contains the word runs
 * something against the company's books, which they will not. These are the
 * cases that decide it.
 */
import { describe, expect, it } from 'vitest';
import { actionLabel, CONFIRM_MINUTES, expired, isConfirmation, isRefusal, type PendingAction } from '@/server/domain/whatsapp-do';

const pending = (over: Partial<PendingAction> = {}): PendingAction => ({
  action: 'approve_opening_stock',
  userId: 'u1',
  chat: '9647000000000-123@g.us',
  target: { kind: 'opening_stock', id: 'id-1', documentNo: 'OPN-HQ-2026-000008', branchCode: 'HQ' },
  reason: null,
  sentence: 'approve opening stock OPN-HQ-2026-000008',
  proposedAt: '2026-10-02T12:00:00.000Z',
  ...over,
});

describe('WA-8 · a yes, and only a yes', () => {
  it('takes a plain yes, in either language', () => {
    for (const said of ['yes', 'Yes', 'yes please', 'ok', 'okay', 'go ahead', 'do it', 'confirm', 'proceed']) {
      expect(isConfirmation(said), said).toBe(true);
    }
    for (const said of ['نعم', 'موافق', 'اي', 'تم', 'سوي', 'اوكي', 'زين']) {
      expect(isConfirmation(said), said).toBe(true);
    }
  });

  it('takes a yes with a courtesy after it', () => {
    expect(isConfirmation('yes thanks')).toBe(true);
    expect(isConfirmation('ok please')).toBe(true);
    expect(isConfirmation('موافق شكرا')).toBe(true);
  });

  it('ignores punctuation and the emoji people answer with', () => {
    expect(isConfirmation('yes!')).toBe(true);
    expect(isConfirmation('نعم.')).toBe(true);
    expect(isConfirmation('ok 👍')).toBe(true);
  });

  it('does NOT take a sentence that merely contains the word', () => {
    // The case that matters. Every one of these is a question, and treating
    // the word inside it as a signature would post something nobody asked
    // for.
    for (const said of [
      'yes but what about the Najaf one',
      'ok so which documents are waiting?',
      'yes I approved it on the screen already',
      'is it ok to approve this?',
      'نعم بس شوف مخزن النجف أول',
      'موافق على شنو بالضبط؟',
      'do it after the accountant checks',
    ]) {
      expect(isConfirmation(said), said).toBe(false);
    }
  });

  it('takes a plain no, and treats anything else as a new question', () => {
    expect(isRefusal('no')).toBe(true);
    expect(isRefusal('cancel')).toBe(true);
    expect(isRefusal('لا')).toBe(true);
    expect(isRefusal('الغي')).toBe(true);
    // Neither a yes nor a no: the bridge drops the proposal and answers it as
    // a question, which is the safe reading of a change of subject.
    expect(isConfirmation('what is in Najaf?')).toBe(false);
    expect(isRefusal('what is in Najaf?')).toBe(false);
  });

  it('takes nothing from an empty message', () => {
    expect(isConfirmation('')).toBe(false);
    expect(isConfirmation('   ')).toBe(false);
    expect(isRefusal('')).toBe(false);
  });
});

describe('WA-8 · a proposal goes stale', () => {
  it('stands for the stated minutes and no longer', () => {
    const at = (minutes: number) => new Date(Date.parse('2026-10-02T12:00:00.000Z') + minutes * 60_000);
    expect(expired(pending(), at(CONFIRM_MINUTES - 1))).toBe(false);
    expect(expired(pending(), at(CONFIRM_MINUTES + 1))).toBe(true);
  });

  it('names what it would have done, for the log', () => {
    expect(actionLabel('approve_document')).toContain('approve');
    expect(actionLabel('reject_document')).toContain('reject');
    expect(actionLabel('approve_opening_stock')).toContain('opening stock');
  });
});
