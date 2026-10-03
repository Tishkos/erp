/**
 * REQ-HARDEN-001 G7 / HD19 — the browser gets the namespaces it uses, not the
 * catalogue.
 *
 * Every `useTranslations` in `src` is a client-side translation (the server
 * uses `getTranslations`), and it must name one of `CLIENT_NAMESPACES`: the
 * provider in the root layout hands the browser those and nothing else, so a
 * namespace missing from the list would render its keys instead of words.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';
import { CLIENT_NAMESPACES, clientMessages } from '@/i18n/client-messages';

const ROOT = join(__dirname, '..', '..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe('HD19 · the client catalogue', () => {
  it('every useTranslations names a namespace the provider hands the browser', () => {
    const outside: string[] = [];
    for (const file of sources(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(ROOT, file);
      // The whole catalogue on the client is what this replaced.
      if (/\buseMessages\(/.test(text)) outside.push(`${rel}: useMessages()`);
      for (const match of text.matchAll(/\buseTranslations\(([^)]*)\)/g)) {
        const arg = match[1]!.trim();
        const ns = /^['"]([^'"]+)['"]$/.exec(arg)?.[1];
        if (!ns) {
          outside.push(`${rel}: useTranslations(${arg})`);
          continue;
        }
        const root = ns.split('.')[0]!;
        if (!(CLIENT_NAMESPACES as readonly string[]).includes(root)) outside.push(`${rel}: useTranslations('${ns}')`);
      }
    }
    expect(outside).toEqual([]);
  });

  it('every listed namespace exists in both catalogues, and the rest stay on the server', () => {
    for (const catalogue of [en, ar] as Array<Record<string, unknown>>) {
      const picked = clientMessages(catalogue);
      expect(Object.keys(picked).sort()).toEqual([...CLIENT_NAMESPACES].sort());
      expect(picked).not.toHaveProperty('admin');
      // A fraction of the whole, which is the point.
      expect(JSON.stringify(picked).length).toBeLessThan(JSON.stringify(catalogue).length / 4);
    }
  });
});
