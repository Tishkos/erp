import { describe, expect, it } from 'vitest';
import { addBusinessDays, businessDateOf, businessToday } from '@/server/domain/business-date';

/** REQ-HARDEN-001 HD7 — "today" is Baghdad's, not UTC's. */
describe('HD7 · the business date', () => {
  it('is the Baghdad date, so 01:00 in Baghdad on the 2nd is the 2nd, not the 1st', () => {
    // 22:30 UTC on the 1st is 01:30 on the 2nd in Baghdad (UTC+3).
    expect(businessToday(new Date('2026-10-01T22:30:00Z'), 'Asia/Baghdad')).toBe('2026-10-02');
    // UTC would have said the 1st.
    expect(new Date('2026-10-01T22:30:00Z').toISOString().slice(0, 10)).toBe('2026-10-01');
  });

  it('agrees with UTC inside the day', () => {
    expect(businessDateOf(new Date('2026-10-02T09:00:00Z'), 'Asia/Baghdad')).toBe('2026-10-02');
  });

  it('crosses month and year ends correctly', () => {
    expect(businessToday(new Date('2026-12-31T21:30:00Z'), 'Asia/Baghdad')).toBe('2027-01-01');
    expect(addBusinessDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addBusinessDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});
