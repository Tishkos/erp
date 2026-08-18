/**
 * Phase 07.8 — forecast bucketing, §17.
 *
 * Pure: no database, no clock.
 */
import { describe, expect, it } from 'vitest';
import { startOfBucket } from '@domain/cash-forecast';

describe('§17 · day, week and month buckets', () => {
  it('leaves a day alone', () => {
    expect(startOfBucket('2026-02-18', 'day')).toBe('2026-02-18');
  });

  it('takes a month back to its first day', () => {
    expect(startOfBucket('2026-02-18', 'month')).toBe('2026-02-01');
    expect(startOfBucket('2026-02-01', 'month')).toBe('2026-02-01');
    expect(startOfBucket('2026-12-31', 'month')).toBe('2026-12-01');
  });

  it('takes a week back to its Monday', () => {
    // 2026-02-18 is a Wednesday; the Monday before it is the 16th.
    expect(startOfBucket('2026-02-18', 'week')).toBe('2026-02-16');
    expect(startOfBucket('2026-02-16', 'week')).toBe('2026-02-16');
    expect(startOfBucket('2026-02-22', 'week')).toBe('2026-02-16'); // Sunday
    expect(startOfBucket('2026-02-23', 'week')).toBe('2026-02-23'); // next Monday
  });

  it('crosses a month boundary within a week', () => {
    // 2026-03-01 is a Sunday, so its week began on 23 February.
    expect(startOfBucket('2026-03-01', 'week')).toBe('2026-02-23');
  });

  it('crosses a year boundary', () => {
    // 2027-01-01 is a Friday; its week began on 28 December 2026.
    expect(startOfBucket('2027-01-01', 'week')).toBe('2026-12-28');
  });

  it('puts every day of one week in the same box', () => {
    const week = [
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-21',
      '2026-02-22',
    ];
    const buckets = new Set(week.map((day) => startOfBucket(day, 'week')));
    expect(buckets.size).toBe(1);
  });

  it('is stable — bucketing a bucket start gives the same answer', () => {
    for (const bucket of ['day', 'week', 'month'] as const) {
      const first = startOfBucket('2026-02-18', bucket);
      expect(startOfBucket(first, bucket)).toBe(first);
    }
  });
});
