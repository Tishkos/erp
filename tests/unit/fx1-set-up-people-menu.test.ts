/**
 * The people script reads the menu — so the menu must still have what it names.
 *
 * `scripts/ops/set-up-people.ts` writes the company's roles in menu sections
 * (`objectsOf('payables', …)`) and a few hand-named objects (`PAYING`, the
 * developer's list), and `roles.setGrants` refuses an object the menu does not
 * know. When the Payables finalisation (2026-10-04) retired the section
 * `payables_setup` and the never-built object `ap_allocation`, the script kept
 * naming them and refused at its first role — found only when a database was
 * built from nothing. The script is not importable (it runs on import), so
 * this reads its source: every section key inside an `objectsOf(…)` call and
 * every quoted name in its hand-written object lists must be in the menu.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU, menuObjects } from '@domain/menu';

const SOURCE = readFileSync(join(process.cwd(), 'scripts/ops/set-up-people.ts'), 'utf8');
const SECTIONS = new Set(MENU.map((section) => section.key));
const OBJECTS = new Set(menuObjects());

/** The quoted names in a block of the script's source, comments left out. */
function quoted(block: string): string[] {
  return [...block.replace(/\/\/.*$/gm, '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!);
}

/** An object list's own names: what is left once its `objectsOf(…)` spreads are taken out. */
function handNamed(block: string): string[] {
  return quoted(block.replace(/objectsOf\([^)]*\)/g, ''));
}

describe('FX1 · set-up-people.ts names only what the menu has', () => {
  it('every section it asks objectsOf() for is a menu section', () => {
    const calls = [...SOURCE.matchAll(/objectsOf\(([^)]*)\)/g)].map((match) => match[1]!);
    expect(calls.length).toBeGreaterThan(0);
    const named = new Set(calls.flatMap(quoted));
    const missing = [...named].filter((key) => !SECTIONS.has(key));
    expect(missing).toEqual([]);
  });

  it('every object it names by hand is one the menu grants', () => {
    const paying = /const PAYING = \[([^\]]*)\]/.exec(SOURCE);
    expect(paying).not.toBeNull();
    const lists = [paying![1]!, ...[...SOURCE.matchAll(/grants\(\s*\[([^\]]*)\]/g)].map((m) => m[1]!)];
    const named = new Set(lists.flatMap(handNamed));
    expect(named.size).toBeGreaterThan(0);
    const missing = [...named].filter((object) => !OBJECTS.has(object));
    expect(missing).toEqual([]);
  });
});
