/**
 * §15 — the ageing buckets, where the off-by-one lives.
 *
 * A date comparison is exactly the kind of rule that goes quietly wrong: put an
 * invoice in the wrong column on the day it falls due and the A/P clerk chases
 * a supplier who is not late, on the one day they are most likely to look.
 */
import { describe, expect, it } from 'vitest';
import {
  AGEING_BUCKETS,
  FORECAST_HORIZONS,
  bucketFor,
  daysBetween,
  horizonFor,
} from '@domain/ageing';

describe('§15 · which bucket an open invoice falls in', () => {
  it('is current on the day it falls due, not late', () => {
    // Payment is due *by* that date. Nothing is late until it has passed, and
    // this is the boundary the off-by-one lives on.
    expect(bucketFor('2026-04-01', '2026-04-01')).toBe('current');
    expect(bucketFor('2026-04-01', '2026-04-02')).toBe('1-30');
  });

  it('is current while the due date is still ahead', () => {
    expect(bucketFor('2026-05-01', '2026-04-01')).toBe('current');
  });

  it('walks the buckets at exactly the right days', () => {
    const due = '2026-01-01';
    expect(bucketFor(due, '2026-01-31')).toBe('1-30'); // 30 days
    expect(bucketFor(due, '2026-02-01')).toBe('31-60'); // 31
    expect(bucketFor(due, '2026-03-02')).toBe('31-60'); // 60
    expect(bucketFor(due, '2026-03-03')).toBe('61-90'); // 61
    expect(bucketFor(due, '2026-04-01')).toBe('61-90'); // 90
    expect(bucketFor(due, '2026-04-02')).toBe('90+'); // 91
  });

  it('counts from the due date, not the invoice date', () => {
    // 90-day terms: an invoice raised in January and due in April is not
    // overdue in March, however old it looks.
    expect(bucketFor('2026-04-15', '2026-03-20')).toBe('current');
  });

  it('offers exactly the five buckets', () => {
    expect([...AGEING_BUCKETS]).toEqual(['current', '1-30', '31-60', '61-90', '90+']);
  });

  it('refuses a date it cannot read rather than guessing', () => {
    expect(() => bucketFor('not-a-date', '2026-04-01')).toThrow(RangeError);
  });
});

describe('§15 · the forward view', () => {
  it('separates what is already late from what is coming', () => {
    expect(horizonFor('2026-03-31', '2026-04-01')).toBe('overdue');
    expect(horizonFor('2026-04-01', '2026-04-01')).toBe('0-30');
    expect(horizonFor('2026-05-01', '2026-04-01')).toBe('0-30');
    expect(horizonFor('2026-05-02', '2026-04-01')).toBe('31-60');
    expect(horizonFor('2026-06-15', '2026-04-01')).toBe('61+');
  });

  it('offers exactly the four horizons', () => {
    expect([...FORECAST_HORIZONS]).toEqual(['overdue', '0-30', '31-60', '61+']);
  });
});

describe('days between two business dates', () => {
  it('counts whole days, forwards and backwards', () => {
    expect(daysBetween('2026-04-01', '2026-04-11')).toBe(10);
    expect(daysBetween('2026-04-11', '2026-04-01')).toBe(-10);
    expect(daysBetween('2026-04-01', '2026-04-01')).toBe(0);
  });

  it('crosses a month and a year without drifting', () => {
    expect(daysBetween('2026-01-31', '2026-03-01')).toBe(29);
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('is unaffected by a daylight-saving shift', () => {
    // Parsed as UTC (TECHSTACK A10 — business dates are never local instants),
    // so a clock change cannot turn 30 days into 29.9 and round it down.
    expect(daysBetween('2026-03-01', '2026-03-31')).toBe(30);
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
  });
});
