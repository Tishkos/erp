/**
 * Phase 01.5 test gate — format and reset rules.
 *
 * Uniqueness under concurrency, and the gap left by a rolled-back document,
 * are database properties and are proved in
 * tests/integration/phase01-platform-core.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  NumberingContextError,
  SequenceDefinitionError,
  findGaps,
  formatDocumentNumber,
  scopeKeyFor,
  validateSequenceDefinition,
  type SequenceDefinition,
} from '@domain/numbering';

const journal: SequenceDefinition = {
  key: 'JOURNAL_ENTRY',
  prefix: 'JE',
  pattern: '{PREFIX}-{SERIAL}',
  padding: 6,
  scopeBranch: false,
  scopeYear: false,
};

const branchYear: SequenceDefinition = {
  key: 'SALES_INVOICE',
  prefix: 'INV',
  pattern: '{PREFIX}-{BRANCH}-{YY}-{SERIAL}',
  padding: 5,
  scopeBranch: true,
  scopeYear: true,
};

describe('§14.2 · number format', () => {
  it('pads the serial to the configured width', () => {
    expect(formatDocumentNumber(journal, 1n)).toBe('JE-000001');
    expect(formatDocumentNumber(journal, 999999n)).toBe('JE-999999');
  });

  it('does not truncate a serial that outgrows the padding', () => {
    // Losing a digit would collide with an existing number. Growing the string
    // is ugly; reusing a number is a §14.2 breach.
    expect(formatDocumentNumber(journal, 1234567n)).toBe('JE-1234567');
  });

  it('resolves branch and year tokens', () => {
    expect(formatDocumentNumber(branchYear, 42n, { branchCode: 'BGW', year: 2026 })).toBe(
      'INV-BGW-26-00042',
    );
  });

  it('supports a four-digit year', () => {
    const def = { ...branchYear, pattern: '{PREFIX}/{YYYY}/{SERIAL}', scopeBranch: false };
    expect(formatDocumentNumber(def, 7n, { year: 2026 })).toBe('INV/2026/00007');
  });

  it('refuses a serial of zero or less', () => {
    expect(() => formatDocumentNumber(journal, 0n)).toThrow(RangeError);
    expect(() => formatDocumentNumber(journal, -1n)).toThrow(RangeError);
  });

  it('names what is missing when the context is incomplete', () => {
    expect(() => formatDocumentNumber(branchYear, 1n, { year: 2026 })).toThrow(
      NumberingContextError,
    );
    expect(() => formatDocumentNumber(branchYear, 1n, { branchCode: 'BGW' })).toThrow(
      /no year was supplied/,
    );
  });
});

describe('§4.3 · reset rules must be expressible in the pattern', () => {
  it('rejects a per-branch sequence whose pattern omits the branch', () => {
    // Two branches drawing from separate counters but printing the same string
    // would mint INV-00001 twice. Caught at configuration time, not on the day
    // it happens.
    expect(() =>
      validateSequenceDefinition({ ...branchYear, pattern: '{PREFIX}-{YY}-{SERIAL}' }),
    ).toThrow(SequenceDefinitionError);
  });

  it('rejects a per-year sequence whose pattern omits the year', () => {
    expect(() =>
      validateSequenceDefinition({ ...branchYear, pattern: '{PREFIX}-{BRANCH}-{SERIAL}' }),
    ).toThrow(/must contain \{YY\}/);
  });

  it('rejects a pattern with no serial at all', () => {
    expect(() => validateSequenceDefinition({ ...journal, pattern: '{PREFIX}-fixed' })).toThrow(
      /must contain \{SERIAL\}/,
    );
  });

  it('rejects an unknown token rather than printing it literally', () => {
    expect(() =>
      validateSequenceDefinition({ ...journal, pattern: '{PREFIX}-{MONTH}-{SERIAL}' }),
    ).toThrow(/unknown token\(s\) MONTH/);
  });

  it('rejects a padding outside 1–18', () => {
    expect(() => validateSequenceDefinition({ ...journal, padding: 0 })).toThrow(
      SequenceDefinitionError,
    );
    expect(() => validateSequenceDefinition({ ...journal, padding: 19 })).toThrow(
      SequenceDefinitionError,
    );
  });
});

describe('§4.3 · the counter a number is drawn from', () => {
  it('is one counter when the sequence never resets', () => {
    expect(scopeKeyFor(journal)).toBe('');
    expect(scopeKeyFor(journal, { branchCode: 'BGW', year: 2026 })).toBe('');
  });

  it('is one counter per branch and year when it resets on both', () => {
    expect(scopeKeyFor(branchYear, { branchCode: 'BGW', year: 2026 })).toBe('BGW|2026');
    expect(scopeKeyFor(branchYear, { branchCode: 'BSR', year: 2026 })).toBe('BSR|2026');
  });

  it('changes at the year boundary, so serials restart and numbers stay distinct', () => {
    // 01.5 gate: "Branch and year patterns resolve correctly across a year
    // boundary." Serial 1 exists in both years; the document numbers do not
    // collide because the year is printed.
    const y2026 = scopeKeyFor(branchYear, { branchCode: 'BGW', year: 2026 });
    const y2027 = scopeKeyFor(branchYear, { branchCode: 'BGW', year: 2027 });

    expect(y2026).not.toBe(y2027);
    expect(formatDocumentNumber(branchYear, 1n, { branchCode: 'BGW', year: 2026 })).toBe(
      'INV-BGW-26-00001',
    );
    expect(formatDocumentNumber(branchYear, 1n, { branchCode: 'BGW', year: 2027 })).toBe(
      'INV-BGW-27-00001',
    );
  });

  it('refuses to guess a missing branch or year', () => {
    expect(() => scopeKeyFor(branchYear, { year: 2026 })).toThrow(NumberingContextError);
    expect(() => scopeKeyFor(branchYear, { branchCode: 'BGW' })).toThrow(NumberingContextError);
  });
});

describe('§24 · sequence gap report', () => {
  it('reports nothing when every issued number reached a document', () => {
    expect(findGaps(3n, [1n, 2n, 3n])).toEqual([]);
  });

  it('reports the serials consumed by rolled-back work', () => {
    expect(findGaps(5n, [1n, 3n, 5n])).toEqual([2n, 4n]);
  });

  it('reports nothing when the sequence has never been used', () => {
    expect(findGaps(0n, [])).toEqual([]);
  });

  it('is unaffected by the order the allocations were recorded in', () => {
    expect(findGaps(4n, [4n, 1n, 2n])).toEqual([3n]);
  });
});
