/**
 * Phase 02.8 test gate — what may be reversed, when, and to what effect.
 */
import { describe, expect, it } from 'vitest';
import {
  NotReversibleError,
  ReversalDateError,
  ReversalReasonRequiredError,
  assertReversalDate,
  assertReversalReason,
  assertReversible,
  mirrorLines,
  netByAccount,
  type ReversibleJournal,
} from '@domain/reversal';
import { assertBalanced, type JournalLineDraft } from '@domain/journal';
import { MONEY_SCALE, parseDecimal } from '@domain/money';

const iqd = (value: string) => parseDecimal(value, MONEY_SCALE);

const journal = (overrides: Partial<ReversibleJournal> = {}): ReversibleJournal => ({
  id: 'je-1',
  entryNo: 'JE-2026-000001',
  status: 'posted',
  postingDate: '2026-08-16',
  source: 'manual',
  reversesId: null,
  reversedById: null,
  ...overrides,
});

const line = (overrides: Partial<JournalLineDraft> = {}): JournalLineDraft => ({
  lineNo: 1,
  accountId: 'acc-expense',
  accountCode: 'X000002',
  debitTxn: iqd('1000.0000'),
  creditTxn: 0n,
  currency: 'IQD',
  debitIqd: iqd('1000.0000'),
  creditIqd: 0n,
  debitUsd: iqd('0.7634'),
  creditUsd: 0n,
  dimensions: { department: 'FIN' },
  ...overrides,
});

const originalLines: JournalLineDraft[] = [
  line(),
  line({
    lineNo: 2,
    accountId: 'acc-cash',
    accountCode: 'A000002',
    debitTxn: 0n,
    creditTxn: iqd('1000.0000'),
    debitIqd: 0n,
    creditIqd: iqd('1000.0000'),
    debitUsd: 0n,
    creditUsd: iqd('0.7634'),
  }),
];

describe('§14.3 · what may be reversed', () => {
  it('accepts a posted manual journal', () => {
    expect(() => assertReversible(journal())).not.toThrow();
  });

  it('refuses a draft — there is no effect to reverse', () => {
    expect(() => assertReversible(journal({ status: 'draft' }))).toThrow(
      /cancel a draft instead/,
    );
  });

  it('refuses a journal that has already been reversed', () => {
    expect(() => assertReversible(journal({ status: 'reversed' }))).toThrow(NotReversibleError);
    expect(() => assertReversible(journal({ reversedById: 'je-2' }))).toThrow(
      /already been reversed/,
    );
  });

  it('refuses to reverse a reversal', () => {
    // 02.8 gate: "A reversal cannot itself be reversed into a loop that
    // re-creates the original effect."
    expect(() => assertReversible(journal({ reversesId: 'je-0' }))).toThrow(
      /it is itself a reversal/,
    );
  });

  it('refuses an automatic journal, pointing at the source document', () => {
    // §3.2 — an automatic journal belongs to its source document and is
    // corrected through that document's own return or credit note.
    expect(() => assertReversible(journal({ source: 'system' }))).toThrow(
      /Correct it through that document’s approved/,
    );
  });
});

describe('§14.3 · when it may be reversed', () => {
  it('accepts the same day as the original', () => {
    expect(() => assertReversalDate(journal(), '2026-08-16')).not.toThrow();
  });

  it('accepts a later day', () => {
    expect(() => assertReversalDate(journal(), '2026-09-01')).not.toThrow();
  });

  it('refuses an earlier day', () => {
    expect(() => assertReversalDate(journal(), '2026-08-15')).toThrow(ReversalDateError);
    expect(() => assertReversalDate(journal(), '2026-08-15')).toThrow(
      /lands in a period before the thing it corrects/,
    );
  });
});

describe('§5.4 · the reason is stored with the decision', () => {
  it('requires one', () => {
    expect(() => assertReversalReason('JE-1')).toThrow(ReversalReasonRequiredError);
    expect(() => assertReversalReason('JE-1', '   ')).toThrow(ReversalReasonRequiredError);
    expect(() => assertReversalReason('JE-1', 'Posted to the wrong cost centre')).not.toThrow();
  });
});

describe('the mirrored journal', () => {
  it('swaps every side, in every currency', () => {
    const mirrored = mirrorLines(originalLines);

    expect(mirrored[0]!.creditIqd).toBe(iqd('1000.0000'));
    expect(mirrored[0]!.debitIqd).toBe(0n);
    expect(mirrored[0]!.creditUsd).toBe(iqd('0.7634'));
    expect(mirrored[1]!.debitIqd).toBe(iqd('1000.0000'));
  });

  it('keeps the account and the dimensions', () => {
    // The net effect must be zero on every account *and every dimension*,
    // which is only true if the dimensions are carried across unchanged.
    const mirrored = mirrorLines(originalLines);
    expect(mirrored[0]!.accountId).toBe('acc-expense');
    expect(mirrored[0]!.dimensions).toEqual({ department: 'FIN' });
  });

  it('balances in its own right', () => {
    expect(() => assertBalanced(mirrorLines(originalLines))).not.toThrow();
  });

  it('nets the original to exactly zero on every account', () => {
    // 02.8 gate, stated exactly.
    const combined = [...originalLines, ...mirrorLines(originalLines)];
    const net = netByAccount(combined);

    expect(net.get('acc-expense')).toBe(0n);
    expect(net.get('acc-cash')).toBe(0n);
    for (const value of net.values()) expect(value).toBe(0n);
  });

  it('is a full reversal — every line, never a subset', () => {
    // §14.3 permits full reversal only. `mirrorLines` has no way to express a
    // partial one: it maps the whole set or nothing.
    expect(mirrorLines(originalLines)).toHaveLength(originalLines.length);
  });
});
