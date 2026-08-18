/**
 * Phase 00.5 — architectural rule, enforced as a test.
 *
 * `src/server/domain` must stay free of framework imports so that exactly one
 * implementation of every business rule exists, callable from the UI, the API
 * and background jobs alike.
 *
 * Blueprint §23: "Every create/update API must enforce the same permissions and
 * business validations as the user interface."
 * Blueprint §24: "Module developers shall call shared services… Duplicating
 * these mechanisms inside each module will create inconsistent controls and
 * expensive maintenance."
 *
 * Without this test the rule is a comment, and comments do not fail builds.
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOMAIN_ROOT = fileURLToPath(new URL('../../src/server/domain', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Imports the domain layer may not contain.
 *
 * Each is banned for a reason, not on principle:
 *   next/*        would tie a business rule to one transport
 *   react*        the domain has no rendering concern
 *   drizzle/pg    persistence belongs to the repository layer above
 *   better-auth   identity is resolved before the domain is called
 *   pg-boss       scheduling is an outer concern; the domain is synchronous
 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /^next(\/|$)/, reason: 'ties a business rule to the Next.js transport' },
  { pattern: /^react(-dom)?(\/|$)/, reason: 'the domain has no rendering concern' },
  { pattern: /^server-only$/, reason: 'the domain must be importable by tests and jobs' },
  { pattern: /^drizzle-orm(\/|$)/, reason: 'persistence belongs to the repository layer' },
  { pattern: /^pg$/, reason: 'persistence belongs to the repository layer' },
  { pattern: /^better-auth(\/|$)/, reason: 'identity is resolved before the domain is called' },
  { pattern: /^pg-boss$/, reason: 'scheduling is an outer concern' },
  { pattern: /^@casl\//, reason: 'authorisation is enforced in the service layer above' },
];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

async function collectTypeScriptFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found; // directory not created yet — nothing to police
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await collectTypeScriptFiles(full)));
    } else if (/\.tsx?$/.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function specifiersIn(source: string): string[] {
  const specifiers: string[] = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      if (match[1]) specifiers.push(match[1]);
    }
  }
  return specifiers;
}

describe('src/server/domain stays framework-free', () => {
  it('contains no forbidden import', async () => {
    const files = await collectTypeScriptFiles(DOMAIN_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of specifiersIn(source)) {
        const rule = FORBIDDEN.find((r) => r.pattern.test(specifier));
        if (rule) {
          violations.push(
            `${relative(REPO_ROOT, file)} imports "${specifier}" — ${rule.reason}`,
          );
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('reaches outside itself only through relative paths or @domain', async () => {
    const files = await collectTypeScriptFiles(DOMAIN_ROOT);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const specifier of specifiersIn(source)) {
        // `@/…` resolves into the application layer — that would invert the
        // dependency direction and let a screen's concern into the domain.
        if (specifier.startsWith('@/')) {
          violations.push(
            `${relative(REPO_ROOT, file)} imports "${specifier}" — the domain must not depend on the application layer`,
          );
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
