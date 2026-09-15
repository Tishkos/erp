/**
 * A screen points at itself.
 *
 * Clicking Goods Returns showed the Sales Returns tabs, because that screen was
 * written by deriving it from the Sales Return one and the rename missed the
 * JSX attributes: `'/sales/sales-returns'` in code was replaced, and
 * `route="/sales/sales-returns"` was not. The page gated on its own address,
 * fetched its own data, and then drew somebody else's navigation.
 *
 * Nothing catches that. It typechecks, the route is real, the tabs render, and
 * every test passes — the only symptom is that a person clicks one thing and
 * arrives somewhere that looks like another. Three more screens had it, for the
 * same reason, and I would have shipped all four.
 *
 * So: whatever route a page admits itself to be, that is the route its tabs and
 * its search-clear link must name.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Every page under the application shell, walked rather than globbed. */
function pagesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...pagesUnder(path));
    else if (entry.name === 'page.tsx') found.push(path);
  }
  return found;
}

const PAGES = pagesUnder('src/app/(app)');

/** The address the page checks itself against — its own, by definition. */
const gatedRoute = (source: string): string | null =>
  /visibleRoute\('([^']+)'\)/.exec(source)?.[1] ?? null;

const attribute = (source: string, name: string): string[] =>
  [...source.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map((match) => match[1]!);

describe('every screen names its own route', () => {
  it('found the pages to check', () => {
    // A glob that silently matches nothing would make everything below vacuous.
    expect(PAGES.length).toBeGreaterThan(20);
  });

  it('draws its own section tabs, not another screen’s', () => {
    const wrong: string[] = [];

    for (const path of PAGES) {
      const source = readFileSync(path, 'utf8');
      const own = gatedRoute(source);
      if (!own) continue;

      for (const route of attribute(source, 'SectionTabs route')) {
        if (route !== own) wrong.push(`${path}: gates on ${own}, tabs say ${route}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('clears its own search, not another screen’s', () => {
    const wrong: string[] = [];

    for (const path of PAGES) {
      const source = readFileSync(path, 'utf8');
      const own = gatedRoute(source);
      if (!own) continue;

      for (const href of attribute(source, 'clearHref')) {
        if (href !== own) wrong.push(`${path}: gates on ${own}, clears to ${href}`);
      }
    }

    expect(wrong).toEqual([]);
  });
});
