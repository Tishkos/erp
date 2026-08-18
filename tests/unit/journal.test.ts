/**
 * Phase 02.5 test gate — the rules a journal must satisfy on its own.
 *
 * The database enforces balancing independently, as a deferred constraint, and
 * that is proved in tests/integration/phase02-journal-entry.test.ts. The gate
 * asks for both: "enforced as a database constraint, not only in application
 * code" — *not only* means the application checks it too, so the user gets a
 * sentence rather than a constraint violation.
 */
import { describe, expect, it } from 'vitest';
import {
  JOURNAL_TYPES,
  JournalBranchError,
  JournalUnbalancedError,
  JournalValidationError,
  NotFinanceDepartmentError,
  assertBalanced,
  assertFinanceDepartment,
  assertJournalValid,
  assertLineWellFormed,
  assertSingleBranch,
  totalCreditIqd,
  totalDebitIqd,
  type JournalHeaderDraft,
  type JournalLineDraft,
} from '@domain/journal';
import { MONEY_SCALE, parseDecimal } from '@domain/money';

const iqd = (value: string) => parseDecimal(value, MONEY_SCALE);

const header = (overrides: Partial<JournalHeaderDraft> = {}): JournalHeaderDraft => ({
  branchCode: 'BGW',
  documentDate: '2026-08-16',
  postingDate: '2026-08-16',
  journalType: 'standard',
  ...overrides,
});

/** A debit line. Amounts are IQD unless told otherwise. */
const debit = (amount: string, overrides: Partial<JournalLineDraft> = {}): JournalLineDraft => ({
  lineNo: 1,
  accountId: 'acc-1',
  accountCode: 'X000002',
  debitTxn: iqd(amount),
  creditTxn: 0n,
  currency: 'IQD',
  debitIqd: iqd(amount),
  creditIqd: 0n,
  debitUsd: 0n,
  creditUsd: 0n,
  dimensions: {},
  ...overrides,
});

const credit = (amount: string, overrides: Partial<JournalLineDraft> = {}): JournalLineDraft => ({
  lineNo: 2,
  accountId: 'acc-2',
  accountCode: 'A000002',
  debitTxn: 0n,
  creditTxn: iqd(amount),
  currency: 'IQD',
  debitIqd: 0n,
  creditIqd: iqd(amount),
  debitUsd: 0n,
  creditUsd: 0n,
  dimensions: {},
  ...overrides,
});

describe('§14.3 · Standard Journal is the only manual type', () => {
  it('recognises one journal type', () => {
    expect(JOURNAL_TYPES).toEqual(['standard']);
  });
});

describe('§14.3 · a journal balances in IQD', () => {
  it('accepts equal debits and credits', () => {
    expect(() => assertBalanced([debit('1000.0000'), credit('1000.0000')])).not.toThrow();
  });

  it('rejects a difference of one hundredth of a dinar', () => {
    // Exact decimals, so a 0.0001 difference is a difference and not a
    // rounding artefact to be shrugged at.
    expect(() => assertBalanced([debit('1000.0000'), credit('999.9999')])).toThrow(
      JournalUnbalancedError,
    );
  });

  it('states both totals and the difference', () => {
    expect(() => assertBalanced([debit('1000.0000'), credit('750.0000')])).toThrow(
      /Debits total 1000.0000 and credits 750.0000, a difference of 250.0000/,
    );
  });

  it('balances across many lines', () => {
    const lines = [
      debit('300.0000', { lineNo: 1 }),
      debit('700.0000', { lineNo: 2 }),
      credit('250.0000', { lineNo: 3 }),
      credit('750.0000', { lineNo: 4 }),
    ];
    expect(totalDebitIqd(lines)).toBe(iqd('1000.0000'));
    expect(totalCreditIqd(lines)).toBe(iqd('1000.0000'));
    expect(() => assertBalanced(lines)).not.toThrow();
  });

  it('balances in IQD even when the transaction currencies differ', () => {
    // §14.3 — "IQD is the primary balancing currency." A USD line and an IQD
    // line balance against each other in IQD and in nothing else.
    const usdLine = debit('100.0000', {
      currency: 'USD',
      debitIqd: iqd('131000.0000'),
      debitUsd: iqd('100.0000'),
    });
    const iqdLine = credit('131000.0000');

    expect(() => assertBalanced([usdLine, iqdLine])).not.toThrow();
  });
});

describe('a well-formed line', () => {
  it('carries a debit or a credit, never both', () => {
    expect(() =>
      assertLineWellFormed(debit('100.0000', { creditTxn: iqd('50.0000') })),
    ).toThrow(/carries both a debit and a credit/);
  });

  it('carries something', () => {
    expect(() =>
      assertLineWellFormed(debit('0.0000', { debitIqd: 0n })),
    ).toThrow(/has no amount/);
  });

  it('refuses a negative amount rather than treating it as the other side', () => {
    expect(() => assertLineWellFormed(debit('100.0000', { debitIqd: -1n }))).toThrow(
      /A negative debit is a credit/,
    );
  });

  it('refuses a line whose IQD conversion landed on the wrong side', () => {
    // A debit in USD is a debit in IQD. If they disagree the journal could
    // balance while meaning the opposite of what was entered.
    expect(() =>
      assertLineWellFormed(
        debit('100.0000', {
          currency: 'USD',
          debitIqd: 0n,
          creditIqd: iqd('131000.0000'),
        }),
      ),
    ).toThrow(/is a debit in USD but not in IQD/);
  });
});

describe('§14.3 · one Journal Entry, one branch', () => {
  it('accepts lines that leave the branch to the header', () => {
    expect(() =>
      assertSingleBranch(header(), [debit('100.0000'), credit('100.0000')]),
    ).not.toThrow();
  });

  it('accepts lines that repeat the header branch', () => {
    expect(() =>
      assertSingleBranch(header(), [
        debit('100.0000', { dimensions: { branch: 'BGW' } }),
        credit('100.0000', { dimensions: { branch: 'BGW' } }),
      ]),
    ).not.toThrow();
  });

  it('rejects a line in a different branch, naming the line', () => {
    expect(() =>
      assertSingleBranch(header(), [
        debit('100.0000', { dimensions: { branch: 'BGW' } }),
        credit('100.0000', { lineNo: 2, dimensions: { branch: 'BSR' } }),
      ]),
    ).toThrow(JournalBranchError);

    expect(() =>
      assertSingleBranch(header(), [
        credit('100.0000', { lineNo: 2, dimensions: { branch: 'BSR' } }),
      ]),
    ).toThrow(/Line 2 is in branch BSR but the journal is in BGW/);
  });
});

describe('the whole journal', () => {
  it('accepts a balanced two-line entry', () => {
    expect(() =>
      assertJournalValid(header(), [debit('1000.0000'), credit('1000.0000')]),
    ).not.toThrow();
  });

  it('rejects a single-sided entry', () => {
    expect(() => assertJournalValid(header(), [debit('1000.0000')])).toThrow(
      /needs at least two lines/,
    );
  });

  it('rejects an entry that totals zero', () => {
    // It balances, trivially, and moves nothing.
    expect(() =>
      assertJournalValid(header(), [
        debit('0.0000', { debitIqd: 0n }),
        credit('0.0000', { creditIqd: 0n }),
      ]),
    ).toThrow(JournalValidationError);
  });

  it('rejects a posting date before the document date', () => {
    // Back-dating the posting date relative to *today* is legitimate (§14.6);
    // posting a document before it exists is a data-entry slip.
    expect(() =>
      assertJournalValid(header({ documentDate: '2026-08-16', postingDate: '2026-08-15' }), [
        debit('100.0000'),
        credit('100.0000'),
      ]),
    ).toThrow(/posting date 2026-08-15 is before the document date 2026-08-16/);
  });

  it('accepts a posting date after the document date', () => {
    expect(() =>
      assertJournalValid(header({ documentDate: '2026-08-01', postingDate: '2026-08-31' }), [
        debit('100.0000'),
        credit('100.0000'),
      ]),
    ).not.toThrow();
  });
});

describe('§14 · Journal Entries belong to the Finance Department', () => {
  it('accepts a user assigned to a Finance department', () => {
    expect(() =>
      assertFinanceDepartment('u-1', [
        { code: 'SLS', isFinance: false },
        { code: 'FIN', isFinance: true },
      ]),
    ).not.toThrow();
  });

  it('rejects a user in other departments only', () => {
    expect(() =>
      assertFinanceDepartment('u-1', [{ code: 'SLS', isFinance: false }]),
    ).toThrow(NotFinanceDepartmentError);
  });

  it('rejects a user in no department at all', () => {
    expect(() => assertFinanceDepartment('u-1', [])).toThrow(
      /belong exclusively to the Finance Department/,
    );
  });
});
