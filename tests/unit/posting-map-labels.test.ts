/**
 * Every line of the posting map has a name on the Posting Mappings screen.
 *
 * The screen labels a line with `posting_map.role.<role>`. A role added to
 * `POSTING_MAP` without that message threw MISSING_MESSAGE on every draw of
 * the page (found in the live error log, 2026-10-04: `inventory`, the stock
 * side of a project's material issue) — the page still rendered, with the raw
 * key where the name should be.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POSTING_MAP } from '@domain/posting-map';

type Catalogue = { posting_map: { role: Record<string, string> } };
const roles = (locale: 'en' | 'ar') => (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as Catalogue).posting_map.role;

describe('the posting map and its labels', () => {
  it('names every role in both languages', () => {
    const used = [...new Set(POSTING_MAP.flatMap((document) => document.lines.map((line) => line.role)))].sort();
    for (const locale of ['en', 'ar'] as const) {
      const have = roles(locale);
      expect(used.filter((role) => !have[role]), locale).toEqual([]);
    }
  });
});
