/**
 * Phase 01.12 test gate — the message catalogue.
 *
 * *"No user-facing string is hardcoded — the catalogue is the single source."*
 *
 * This is checkable, so it is checked rather than promised. The suite reads the
 * .tsx files under src/ and asserts two things:
 *
 *   1. Every key a component asks for exists in the catalogue. A missing key
 *      renders as the key itself in production, which reaches a user as
 *      `page.trial_balance` where a heading should be.
 *   2. No component contains a literal sentence of user-facing text.
 *
 * The second is enforced by pattern, which cannot be perfect — a determined
 * literal will get past it. It catches the ordinary case: someone adding a
 * label in a hurry. That is the case that actually happens, and the one that
 * makes an Arabic translation a code change rather than a file (§25).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU, allMenuItems } from '@domain/menu';
import { DOCUMENT_STATUSES } from '@domain/statuses';
import { STANDARD_ACTIONS } from '@domain/record-view';
import messages from '../../messages/en.json';

const SRC = join(process.cwd(), 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const tsxFiles = walk(SRC).filter((f) => f.endsWith('.tsx'));

function lookup(key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      messages,
    );
}

describe('§25 · the catalogue covers everything the application names', () => {
  it('has a label for every menu section and every page in the Appendix A tree', () => {
    // A menu item without a label renders as its key, which reaches a user as
    // `page.gl_inquiry` in the sidebar.
    for (const section of MENU) {
      expect(lookup(`nav.${section.key}`), section.key).toBeTypeOf('string');
    }
    for (const item of allMenuItems()) {
      expect(lookup(`page.${item.key}`), item.key).toBeTypeOf('string');
    }
  });

  it('has a label for every document status', () => {
    // §25 requires consistent terminology across modules; that is only possible
    // if there is one place each status is named.
    for (const status of DOCUMENT_STATUSES) {
      expect(lookup(`status.${status}`), status).toBeTypeOf('string');
    }
  });

  it('has a label for every standard action, and for every refusal', () => {
    for (const action of STANDARD_ACTIONS) {
      expect(lookup(`action.${action.key}`), action.key).toBeTypeOf('string');
    }
    for (const reason of ['no_permission', 'wrong_status', 'not_editable']) {
      expect(lookup(`action.disabled.${reason}`), reason).toBeTypeOf('string');
    }
  });

  it('has a marking label for every draft state the record framework produces', () => {
    for (const key of ['draft', 'pending_approval', 'final', 'cancelled', 'rejected', 'reversed']) {
      expect(lookup(`record.marking.${key}`), key).toBeTypeOf('string');
    }
  });
});

describe('§25 · every key a component asks for exists', () => {
  /**
   * Keys are extracted from the two shapes used in this codebase:
   * `t('a.b')` and `getTranslations('ns')` + `t('key')`. Dynamic keys built
   * from a variable are skipped — they are covered by the catalogue-coverage
   * tests above, which enumerate the domain lists those variables come from.
   */
  const missing: string[] = [];

  for (const file of tsxFiles) {
    const source = readFileSync(file, 'utf8');

    // The namespaces this file binds. A component often binds several — one
    // per section it renders — so a key is accepted if it resolves under any
    // of them, or at the root.
    const namespaces = [
      ...source.matchAll(/(?:getTranslations|useTranslations)\(\s*'([^']+)'\s*\)/g),
      // The object form names a locale and a namespace both — the print
      // voucher uses it to render either language on demand.
      ...source.matchAll(/namespace:\s*'([^']+)'/g),
    ].map((m) => m[1]!);

    for (const match of source.matchAll(/\b(?:t|label|status|nav|page|phase)\(\s*'([a-z0-9_.]+)'/gi)) {
      const key = match[1]!;
      const candidates = [key, ...namespaces.map((ns) => `${ns}.${key}`)];
      if (!candidates.some((c) => typeof lookup(c) === 'string')) {
        missing.push(`${file.replace(process.cwd(), '')} → ${key}`);
      }
    }
  }

  it('finds no key without a message', () => {
    expect(missing).toEqual([]);
  });
});

describe('§25 · no user-facing sentence is written into a component', () => {
  /**
   * A run of words between JSX tags. Deliberately narrow: it wants sentences,
   * not `{'·'}` separators, class names or numbers. Two or more words with a
   * lower-case letter in them is the shape of a label somebody typed.
   */
  const JSX_TEXT = />\s*([A-Za-z][A-Za-z',.!?-]*(?:\s+[A-Za-z][A-Za-z',.!?-]*){1,})\s*</g;

  const offenders: string[] = [];

  for (const file of tsxFiles) {
    const source = readFileSync(file, 'utf8');

    for (const match of source.matchAll(JSX_TEXT)) {
      const text = match[1]!.trim();
      // A single capitalised word is usually a component name caught by the
      // pattern's tail, e.g. `</Foo><Bar />`. Require a lower-case word.
      if (!/[a-z]/.test(text)) continue;
      if (/^[A-Z][a-zA-Z]*$/.test(text)) continue;
      offenders.push(`${file.replace(process.cwd(), '')} → "${text}"`);
    }
  }

  it('finds no literal label in any component', () => {
    expect(offenders).toEqual([]);
  });
});
