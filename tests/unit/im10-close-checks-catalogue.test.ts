/**
 * REQ-IMPROVE-001 IMPROVE-2a — the checklist's codes are named on the screen
 * in both languages, and the closed-period lock is in the migration that
 * ships it (FC-2, FC-3): a check added without its words, or a trigger
 * dropped, fails here before it fails an accountant.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_CODES } from '@/server/services/closing-checks';

const ROOT = process.cwd();
const messages = (locale: string) => JSON.parse(readFileSync(join(ROOT, `messages/${locale}.json`), 'utf8')) as { admin: { periods: Record<string, string> } };

describe('IM10 · the period-close checklist', () => {
  it('names every check in English and Arabic', () => {
    for (const locale of ['en', 'ar']) {
      const periods = messages(locale).admin.periods;
      for (const code of CHECK_CODES) expect(periods[`check_${code}`], `${locale}: check_${code}`).toBeTruthy();
      for (const state of ['pass', 'fail', 'warn']) expect(periods[`check_state_${state}`], `${locale}: check_state_${state}`).toBeTruthy();
    }
  });

  it('holds the closed-period lock and the close sequence in the database', () => {
    const migration = readFileSync(join(ROOT, 'src/server/db/migrations/0243_closed_period_lock.sql'), 'utf8');
    expect(migration).toMatch(/CREATE TRIGGER journal_entry_closed_period_lock/);
    expect(migration).toMatch(/CREATE TRIGGER inventory_movement_closed_period_lock/);
    expect(migration).toMatch(/CREATE TRIGGER fiscal_period_close_in_sequence/);
    expect(migration).toMatch(/BEFORE INSERT ON inventory_movement/);
  });

  it('lists the sequence check first, so a refused close names the calendar before the books', () => {
    expect(CHECK_CODES[0]).toBe('sequence');
    expect(new Set(CHECK_CODES).size).toBe(CHECK_CODES.length);
  });
});
