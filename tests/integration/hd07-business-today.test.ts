/**
 * REQ-HARDEN-001 HD7 — a posting made at 01:00 Baghdad lands on the Baghdad
 * date, sweep included. The services stamp `businessToday()`; this proves the
 * helper against the clock the services are given, and that the sweep's
 * `asOf` and a service's own "today" are the same date.
 */
import { describe, expect, it } from 'vitest';
import { businessToday, businessDateOf } from '@/server/domain/business-date';

describe('HD7 · business today', () => {
  it('01:00 in Baghdad on the 2nd is the 2nd for every stamp', () => {
    const instant = new Date('2026-10-01T22:00:00Z');
    expect(businessToday(instant, 'Asia/Baghdad')).toBe('2026-10-02');
    expect(businessDateOf(instant, 'Asia/Baghdad')).toBe('2026-10-02');
  });

  it('no service stamps UTC today any more', async () => {
    const { execSync } = await import('node:child_process');
    const hits = execSync(
      `grep -rln "new Date().toISOString().slice(0, 10)" src scripts --include=*.ts --include=*.tsx || true`,
      { cwd: process.cwd() },
    )
      .toString()
      .trim();
    expect(hits.split('\n').filter((line) => line && !line.endsWith('domain/business-date.ts'))).toEqual([]);
  });
});
