/**
 * Phase 07.6 — bank statement identity and arithmetic, §17 and Appendix B.
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  assertLineUsable,
  assertStatementBalances,
  directionOf,
  importKeyFor,
  StatementDoesNotBalanceError,
  StatementLineInvalidError,
  type StatementLineInput,
} from '@domain/bank-statement';

const iqd = (whole: string) => BigInt(whole) * 10_000n;

const identity = (overrides: Partial<Parameters<typeof importKeyFor>[0]> = {}) => ({
  accountCode: 'BNK-BGW-01',
  bookingDate: '2026-02-10',
  amountIqd: iqd('1000'),
  reference: 'TRF-991',
  ordinal: 1,
  ...overrides,
});

function line(overrides: Partial<StatementLineInput> = {}): StatementLineInput {
  return {
    lineNo: 1,
    bookingDate: '2026-02-10',
    valueDate: '2026-02-10',
    amountIqd: iqd('1000'),
    reference: 'TRF-991',
    counterparty: 'Supplier One',
    description: 'Outgoing transfer',
    ...overrides,
  };
}

describe('Appendix B · the unique import key', () => {
  it('is the same for the same transaction, so a re-import recognises it', () => {
    expect(importKeyFor(identity())).toBe(importKeyFor(identity()));
  });

  it('is built from what the transaction is, not from what the file called it', () => {
    // Everything but the ordinal is a fact about the payment.
    expect(importKeyFor(identity())).toContain('BNK-BGW-01');
    expect(importKeyFor(identity())).toContain('2026-02-10');
    expect(importKeyFor(identity())).toContain('1000.0000');
  });

  it('differs when the amount differs', () => {
    expect(importKeyFor(identity())).not.toBe(
      importKeyFor(identity({ amountIqd: iqd('1001') })),
    );
  });

  it('differs when the date differs', () => {
    expect(importKeyFor(identity())).not.toBe(
      importKeyFor(identity({ bookingDate: '2026-02-11' })),
    );
  });

  it('differs when the account differs — two accounts can see the same payment', () => {
    expect(importKeyFor(identity())).not.toBe(
      importKeyFor(identity({ accountCode: 'BNK-BGW-02' })),
    );
  });

  it('keeps two genuinely identical transactions apart by their ordinal', () => {
    expect(importKeyFor(identity({ ordinal: 1 }))).not.toBe(
      importKeyFor(identity({ ordinal: 2 })),
    );
  });

  it('ignores the case and spacing of a reference, which banks vary freely', () => {
    expect(importKeyFor(identity({ reference: '  trf-991  ' }))).toBe(
      importKeyFor(identity({ reference: 'TRF-991' })),
    );
  });

  it('treats a missing reference as its own value rather than as absent', () => {
    expect(importKeyFor(identity({ reference: null }))).toBe(
      importKeyFor(identity({ reference: '   ' })),
    );
  });

  it('prefers the bank’s own identifier when there is one', () => {
    const key = importKeyFor(identity(), 'TXN-8899');
    expect(key).toBe('bank:BNK-BGW-01:TXN-8899');
  });

  it('falls back to the fingerprint when the bank gives nothing usable', () => {
    expect(importKeyFor(identity(), '   ')).toBe(importKeyFor(identity()));
    expect(importKeyFor(identity(), null)).toBe(importKeyFor(identity()));
  });

  it('makes the bank’s identifier account-specific', () => {
    expect(importKeyFor(identity(), 'TXN-1')).not.toBe(
      importKeyFor(identity({ accountCode: 'BNK-BGW-02' }), 'TXN-1'),
    );
  });
});

describe('§17 · the statement has to add up', () => {
  it('accepts opening + movement = closing', () => {
    expect(() =>
      assertStatementBalances({
        openingIqd: iqd('5000'),
        closingIqd: iqd('4000'),
        lines: [{ amountIqd: iqd('-1500') }, { amountIqd: iqd('500') }],
      }),
    ).not.toThrow();
  });

  it('refuses a truncated download', () => {
    expect(() =>
      assertStatementBalances({
        openingIqd: iqd('5000'),
        closingIqd: iqd('4000'),
        // The last line is missing, and the file still looks like a statement.
        lines: [{ amountIqd: iqd('-1500') }],
      }),
    ).toThrow(StatementDoesNotBalanceError);
  });

  it('says by how much it is out', () => {
    expect(() =>
      assertStatementBalances({
        openingIqd: iqd('5000'),
        closingIqd: iqd('4000'),
        lines: [{ amountIqd: iqd('-1500') }],
      }),
    ).toThrow(/500\.0000 out/);
  });

  it('accepts a statement with no movement at all', () => {
    expect(() =>
      assertStatementBalances({ openingIqd: iqd('5000'), closingIqd: iqd('5000'), lines: [] }),
    ).not.toThrow();
  });
});

describe('§17 · what a statement line must carry', () => {
  it('accepts an ordinary line', () => {
    expect(() => assertLineUsable(line())).not.toThrow();
  });

  it('refuses a zero amount — a heading is not a transaction', () => {
    expect(() => assertLineUsable(line({ amountIqd: 0n }))).toThrow(StatementLineInvalidError);
  });

  it('refuses a value date before the booking date', () => {
    expect(() =>
      assertLineUsable(line({ bookingDate: '2026-02-10', valueDate: '2026-02-09' })),
    ).toThrow(/value date .* is before the booking date/);
  });

  it('accepts a value date after the booking date — money clears later', () => {
    expect(() =>
      assertLineUsable(line({ bookingDate: '2026-02-10', valueDate: '2026-02-12' })),
    ).not.toThrow();
  });

  it('names the line in the message, because a file has many', () => {
    expect(() => assertLineUsable(line({ lineNo: 47, amountIqd: 0n }))).toThrow(
      /Statement line 47/,
    );
  });
});

describe('§17 · direction reads from the sign', () => {
  it('calls a positive amount money in', () => {
    expect(directionOf(iqd('1'))).toBe('in');
  });

  it('calls a negative amount money out', () => {
    expect(directionOf(iqd('-1'))).toBe('out');
  });
});
