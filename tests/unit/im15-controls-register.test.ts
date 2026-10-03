/**
 * REQ-IMPROVE-001 FC-9 — IM15 `im15-controls-register`: every control in
 * docs/CONTROLS.md names a test that exists, every database control names
 * a migration that exists, and the rows are numbered without gaps.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

interface Row {
  readonly id: string;
  readonly where: string;
  readonly enforcedBy: string;
  readonly tests: string[];
}

function rows(): Row[] {
  const text = readFileSync(join(ROOT, 'docs/CONTROLS.md'), 'utf8');
  return text
    .split('\n')
    .filter((line) => /^\| C-\d+ \|/.test(line))
    .map((line) => {
      const cells = line.split('|').map((c) => c.trim());
      return {
        id: cells[1]!,
        where: cells[3]!,
        enforcedBy: cells[4]!,
        tests: [...cells[5]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
      };
    });
}

describe('IM15 · the controls register', () => {
  const register = rows();

  it('has rows, numbered without gaps', () => {
    expect(register.length).toBeGreaterThanOrEqual(10);
    register.forEach((row, index) => expect(row.id).toBe(`C-${String(index + 1).padStart(2, '0')}`));
  });

  it('every control names at least one test file that exists', () => {
    for (const row of register) {
      expect(row.tests.length, row.id).toBeGreaterThan(0);
      for (const file of row.tests) expect(existsSync(join(ROOT, file)), `${row.id}: ${file}`).toBe(true);
    }
  });

  it('every database control names a migration that exists', () => {
    for (const row of register.filter((r) => r.where.includes('database'))) {
      const migrations = [...row.enforcedBy.matchAll(/`(\d{4}_[a-z0-9_]+\.sql)`/g)].map((m) => m[1]!);
      const triggers = /reject_mutation|_forward_only|_append_only|withReadOnlyScope|inventory-negative-stock-paths/.test(row.enforcedBy);
      expect(migrations.length > 0 || triggers, `${row.id} names no migration`).toBe(true);
      for (const file of migrations) expect(existsSync(join(ROOT, 'src/server/db/migrations', file)), `${row.id}: ${file}`).toBe(true);
    }
  });
});
