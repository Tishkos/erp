/**
 * Phase 06.7 — the warranty rules, tested where they are pure.
 *
 *   - §7.4 the end date is invoice date + the item's duration, calculated
 *   - §9.3 an item without a duration produces no warranty at all
 *
 * The register itself — a row per serial, the lookup, the append-only guard —
 * is proved against the database.
 */
import { describe, expect, it } from 'vitest';
import {
  coverRemaining,
  hasWarranty,
  isCovered,
  warrantyEndFor,
  warrantyFor,
} from '@domain/warranty';

describe('06.7 gate · the end date is calculated from the invoice date (§7.4)', () => {
  it('adds the item’s months to the invoice date', () => {
    expect(warrantyEndFor('2026-02-13', 12)).toBe('2027-02-13');
    expect(warrantyEndFor('2026-02-13', 24)).toBe('2028-02-13');
    expect(warrantyEndFor('2026-02-13', 6)).toBe('2026-08-13');
  });

  it('clamps into a shorter month rather than rolling into the next one', () => {
    // 31 January plus one month is 28 February, not 3 March. The customer gets
    // the month they were promised and not three extra days by accident.
    expect(warrantyEndFor('2026-01-31', 1)).toBe('2026-02-28');
    expect(warrantyEndFor('2026-08-31', 1)).toBe('2026-09-30');
  });

  it('handles a leap year', () => {
    expect(warrantyEndFor('2028-02-29', 12)).toBe('2029-02-28');
  });

  it('refuses a duration that is not one', () => {
    expect(() => warrantyEndFor('2026-02-13', 0)).toThrow(RangeError);
    expect(() => warrantyEndFor('2026-02-13', -6)).toThrow(RangeError);
    expect(() => warrantyEndFor('2026-02-13', 1.5)).toThrow(RangeError);
  });
});

describe('06.7 gate · an item without a duration produces no warranty (§9.3)', () => {
  it('says an item with no duration has no warranty', () => {
    expect(hasWarranty(null)).toBe(false);
    expect(hasWarranty(undefined)).toBe(false);
    expect(hasWarranty(0)).toBe(false);
    expect(hasWarranty(12)).toBe(true);
  });

  it('returns nothing to register rather than a zero-length record', () => {
    // The distinction the gate is about: no record says "this was sold without
    // cover"; a zero-length one says "the cover expired the day you bought it",
    // which is a claim the company would have to defend at a counter.
    expect(warrantyFor({ invoiceDate: '2026-02-13', warrantyMonths: null })).toBeNull();
    expect(warrantyFor({ invoiceDate: '2026-02-13', warrantyMonths: 0 })).toBeNull();
  });

  it('returns the whole registration when there is a duration', () => {
    expect(warrantyFor({ invoiceDate: '2026-02-13', warrantyMonths: 12 })).toEqual({
      startsOn: '2026-02-13',
      endsOn: '2027-02-13',
      months: 12,
    });
  });
});

describe('06.7 · whether a unit is covered on a day', () => {
  const warranty = { startsOn: '2026-02-13', endsOn: '2027-02-13' };

  it('covers the day of sale', () => {
    expect(isCovered(warranty, '2026-02-13')).toBe(true);
  });

  it('covers the last day, inclusive', () => {
    // The alternative reading would shorten every warranty by a day.
    expect(isCovered(warranty, '2027-02-13')).toBe(true);
  });

  it('does not cover the day after', () => {
    expect(isCovered(warranty, '2027-02-14')).toBe(false);
  });

  it('does not cover a day before the sale', () => {
    expect(isCovered(warranty, '2026-02-12')).toBe(false);
  });

  it('reports the days remaining, and zero once expired', () => {
    expect(coverRemaining(warranty, '2027-02-03')).toBe(10);
    expect(coverRemaining(warranty, '2027-02-13')).toBe(0);
    expect(coverRemaining(warranty, '2027-03-01')).toBe(0);
  });
});
