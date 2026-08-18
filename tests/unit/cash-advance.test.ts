/**
 * Phase 07.5 — petty cash advance rules, §17 and Appendix D.
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import {
  AdvanceNotIssuableError,
  AdvanceOverAccountedError,
  assertIssuable,
  assertWithinAdvance,
  bucketFor,
  outstandingOn,
} from '@domain/cash-advance';

const iqd = (whole: string) => BigInt(whole) * 10_000n;

const advance = (settled = '0', returned = '0') => ({
  amountIqd: iqd('1000'),
  settledIqd: iqd(settled),
  returnedIqd: iqd(returned),
});

describe('§17 · what the holder still has to account for', () => {
  it('is the whole advance before anything comes back', () => {
    expect(outstandingOn(advance())).toBe(iqd('1000'));
  });

  it('falls by receipts and by cash returned alike', () => {
    expect(outstandingOn(advance('600', '150'))).toBe(iqd('250'));
  });

  it('reaches zero when everything is accounted for', () => {
    expect(outstandingOn(advance('700', '300'))).toBe(0n);
  });
});

describe('§17 · an advance cannot account for more than it issued', () => {
  it('accepts an amount within the outstanding balance', () => {
    expect(() => assertWithinAdvance('CAD-1', advance(), iqd('400'))).not.toThrow();
  });

  it('accepts exactly the outstanding balance', () => {
    expect(() => assertWithinAdvance('CAD-1', advance('600'), iqd('400'))).not.toThrow();
  });

  it('refuses more than was advanced', () => {
    expect(() => assertWithinAdvance('CAD-1', advance(), iqd('1001'))).toThrow(
      AdvanceOverAccountedError,
    );
  });

  it('counts receipts and returns together against the same money', () => {
    // 700 spent already; only 300 is left, so 400 is too much.
    expect(() => assertWithinAdvance('CAD-1', advance('700'), iqd('400'))).toThrow(
      AdvanceOverAccountedError,
    );
  });

  it('refuses an amount of nothing', () => {
    expect(() => assertWithinAdvance('CAD-1', advance(), 0n)).toThrow(AdvanceOverAccountedError);
  });

  it('names the alternative, not only the rule', () => {
    expect(() => assertWithinAdvance('CAD-1', advance(), iqd('2000'))).toThrow(
      /that is an expense claim/,
    );
  });
});

describe('Appendix D · advances age from the date they were due', () => {
  it('is current before the accounting date', () => {
    expect(bucketFor('2026-03-01', '2026-02-15')).toBe('current');
  });

  it('is current on the day itself', () => {
    expect(bucketFor('2026-02-15', '2026-02-15')).toBe('current');
  });

  it('ages a day late into the first bucket', () => {
    expect(bucketFor('2026-02-14', '2026-02-15')).toBe('1-30');
  });

  it('walks the buckets in order', () => {
    expect(bucketFor('2026-01-16', '2026-02-15')).toBe('1-30'); // 30 days
    expect(bucketFor('2026-01-01', '2026-02-15')).toBe('31-60'); // 45
    expect(bucketFor('2025-12-16', '2026-02-15')).toBe('61-90'); // 61
    expect(bucketFor('2025-01-01', '2026-02-15')).toBe('90+'); // 410
  });

  it('does not age from the issue date — an advance for a future trip is not late', () => {
    // Issued long ago, due next month: still current.
    expect(bucketFor('2026-03-31', '2026-02-15')).toBe('current');
  });
});

describe('§17 · what has to be true before cash leaves the drawer', () => {
  const issuable = {
    amountIqd: iqd('500'),
    purpose: 'Fuel and tolls for the Basra delivery',
    issueDate: '2026-02-10',
    dueDate: '2026-02-20',
  };

  it('accepts a complete request', () => {
    expect(() => assertIssuable(issuable)).not.toThrow();
  });

  it('refuses an advance of nothing', () => {
    expect(() => assertIssuable({ ...issuable, amountIqd: 0n })).toThrow(AdvanceNotIssuableError);
  });

  it('refuses an advance with no stated purpose', () => {
    expect(() => assertIssuable({ ...issuable, purpose: null })).toThrow(/stated purpose/);
    expect(() => assertIssuable({ ...issuable, purpose: '   ' })).toThrow(/stated purpose/);
  });

  it('refuses a deadline before the money is handed over', () => {
    expect(() => assertIssuable({ ...issuable, dueDate: '2026-02-09' })).toThrow(
      /cannot be overdue before it exists/,
    );
  });

  it('accepts a deadline on the day of issue', () => {
    expect(() => assertIssuable({ ...issuable, dueDate: '2026-02-10' })).not.toThrow();
  });
});
