/**
 * REQ-HARDEN-001 HD12 `hd12-errors-not-404` — no page turns every failure
 * of its load into "record does not exist". A page may answer a missing
 * record with null (→ `notFound()`), but only after narrowing on the
 * `_NOT_FOUND` error code (`isNotFoundError`); a bare `catch { return null }`
 * around a load is the pattern the audit found (E1, E2) and fails here.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNotFoundError, nullIfNotFound } from '@/server/not-found';

const ROOT = process.cwd();

function pages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...pages(path));
    else if (entry === 'page.tsx') out.push(path);
  }
  return out;
}

describe('HD12 · a page distinguishes a missing record from a failed read', () => {
  it('no page.tsx returns null from a bare catch', () => {
    const offenders: string[] = [];
    for (const file of pages(join(ROOT, 'src/app'))) {
      const source = readFileSync(file, 'utf8');
      if (/catch\s*\{\s*\n?\s*return null;?\s*\n?\s*\}/.test(source)) offenders.push(file.replace(ROOT + '/', ''));
    }
    expect(offenders).toEqual([]);
  });

  it('isNotFoundError recognises the services\' not-found codes and nothing else', async () => {
    class PayableNotFoundError extends Error {
      readonly code = 'PAYABLE_NOT_FOUND';
    }
    class ConnectionError extends Error {
      readonly code = 'ECONNREFUSED';
    }
    expect(isNotFoundError(new PayableNotFoundError('x'))).toBe(true);
    expect(isNotFoundError(new ConnectionError('x'))).toBe(false);
    expect(isNotFoundError(new Error('plain'))).toBe(false);
    expect(isNotFoundError('string')).toBe(false);
    expect(await nullIfNotFound(async () => { throw new PayableNotFoundError('x'); })).toBeNull();
    await expect(nullIfNotFound(async () => { throw new ConnectionError('x'); })).rejects.toThrow('x');
    expect(await nullIfNotFound(async () => 42)).toBe(42);
  });

  it('mappedAccountFor hides only the missing mapping, never an ambiguous one (E3)', () => {
    const source = readFileSync(join(ROOT, 'src/server/services/posting.ts'), 'utf8');
    const body = source.slice(source.indexOf('export async function mappedAccountFor'));
    expect(body).toMatch(/if \(error instanceof NoPostingRuleError\) return null;\s*\n\s*throw error;/);
  });
});
