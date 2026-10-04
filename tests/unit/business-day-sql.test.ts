/**
 * A timestamp's date, in SQL, is the company's day.
 *
 * `some_at::date` reads the session's time zone, which is UTC: for the first
 * three hours of every Baghdad day it is yesterday. `payables-sweep` counted a
 * SWIFT as waiting 21 days where the screen beside it said 20 — found
 * 2026-10-04 by a test that happened to run after midnight Baghdad time. The
 * idiom is `(some_at at time zone 'Asia/Baghdad')::date`, as hr-sweep writes
 * it; `tests/integration/hd07-business-today.test.ts` holds the same rule for
 * "today" in TypeScript.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('a timestamp becomes a date in the business time zone', () => {
  it('no service casts a timestamp column straight to a date', () => {
    const dir = 'src/server/services';
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts')) continue;
      readFileSync(join(dir, name), 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (/\b[a-z_.]*_at::date\b/.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
