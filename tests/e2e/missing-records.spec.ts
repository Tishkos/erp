import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * A record that is not there is "does not exist" — never the error page.
 *
 * By report (2026-10-12): "sometimes … we get issues — This screen could not
 * be shown". One whole class of it was a record screen asked for something it
 * could not find: a stale link, a mistyped number, a record outside the
 * reader's branches. Where the service's refusal carried no `…_NOT_FOUND`
 * code, or a number was handed to a column that holds ids, the page threw and
 * the reader was told the screen had failed — with a reference to quote — when
 * nothing had failed at all.
 *
 * So every record screen in the application is found from the file system
 * (a `page.tsx` under a `[parameter]` folder — a new one is covered the day it
 * is written) and asked twice for a record nobody has: once by a number, once
 * by an id. Each must answer with the not-found page. The request is made as
 * the page's own document request, without a browser tab, and read for what
 * Next writes into a response that ended in `notFound()` and what it writes
 * into one that ended in a thrown error.
 *
 * Requires `npm run db:seed`. On a development server each screen is compiled
 * the first time it is asked for, so this takes a while; it is one test per
 * module so a failure names its area.
 */
const ADMIN = { email: 'admin@example.com', password: 'Ledger-Trial-Balance-7' };
const APP = join(process.cwd(), 'src', 'app');

/** Every record route: `/payables/invoices/[invoiceNo]`, … — route groups such as `(app)` are not part of the address. */
function recordRoutes(dir = APP, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const segment = /^\(.+\)$/.test(entry) ? '' : `/${entry}`;
      found.push(...recordRoutes(path, `${prefix}${segment}`));
    } else if (entry === 'page.tsx' && /\[[^\].]+\]/.test(prefix) && !prefix.includes('[...')) {
      found.push(prefix);
    }
  }
  return found.sort();
}

const ROUTES = recordRoutes();
const moduleOf = (route: string) => route.split('/')[1] ?? '';
const MODULES = [...new Set(ROUTES.map(moduleOf))];

async function signIn(page: Page) {
  await page.goto('/sign-in');
  await page.locator('input[name="email"]').fill(ADMIN.email);
  await page.locator('input[name="password"]').fill(ADMIN.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('/');
}

test('the file system names the record screens', () => {
  // A guard on the finder itself: were it to find nothing, every test below would pass for the wrong reason.
  expect(ROUTES.length).toBeGreaterThan(60);
  expect(ROUTES).toContain('/payables/invoices/[invoiceNo]');
  expect(ROUTES).toContain('/projects/[code]');
  expect(ROUTES).toContain('/administration/users/[id]');
});

/**
 * Screens that take a record in the query rather than in the path. A project
 * workspace handed a code nobody has draws itself with no project chosen; a
 * container addressed by an id that is not an id does not exist. Neither may
 * fall into the error page.
 */
const QUERY_CASES: readonly { readonly path: string; readonly missing: boolean }[] = [
  { path: '/payables/containers/NOPE-404-X?id=not-an-id', missing: true },
  { path: `/payables/containers/NOPE-404-X?id=${randomUUID()}`, missing: true },
  { path: '/projects/wbs?project=NOPE-404-X', missing: false },
  { path: '/projects/plan?project=NOPE-404-X', missing: false },
  { path: '/projects/progress?project=NOPE-404-X', missing: false },
  { path: '/projects/forecast?project=NOPE-404-X', missing: false },
  { path: '/projects/close?project=NOPE-404-X', missing: false },
  { path: '/projects/billing?project=NOPE-404-X', missing: false },
];

test('a record named in the query that does not exist never falls into the error page', async ({ page }) => {
  test.setTimeout(1_800_000);
  await signIn(page);
  await page.goto('about:blank');
  const failures: string[] = [];
  for (const { path, missing } of QUERY_CASES) {
    const response = await page.request.get(path, { timeout: 300_000 });
    const body = await response.text();
    const notFound = response.status() === 404 || body.includes('NEXT_HTTP_ERROR_FALLBACK;404');
    if (!notFound && (response.status() >= 500 || body.includes('data-dgst'))) failures.push(`${path} fell into the error page`);
    else if (missing && !notFound) failures.push(`${path} drew a screen for a record that does not exist`);
  }
  expect(failures, failures.join('\n')).toEqual([]);
});

for (const module of MODULES) {
  test(`${module}: a record that does not exist is "does not exist", not an error`, async ({ page }) => {
    test.setTimeout(1_800_000);
    await signIn(page);
    // Nothing left open: no poll runs while the screens are asked for.
    await page.goto('about:blank');

    const failures: string[] = [];
    for (const route of ROUTES.filter((candidate) => moduleOf(candidate) === module)) {
      for (const [form, value] of [
        ['a number nobody has', 'NOPE-404-X'],
        ['an id nobody has', randomUUID()],
      ] as const) {
        const path = route.replace(/\[[^\]]+\]/g, value);
        const response = await page.request.get(path, { timeout: 300_000 });
        const body = await response.text();
        // What Next writes into a streamed response that ended in `notFound()`.
        const missing = response.status() === 404 || body.includes('NEXT_HTTP_ERROR_FALLBACK;404');
        // What it writes into one that ended in a thrown error: the digest the error page shows.
        const failed = !missing && (response.status() >= 500 || body.includes('data-dgst'));
        if (failed) failures.push(`${path} (${form}) fell into the error page`);
        else if (!missing) failures.push(`${path} (${form}) drew a screen for a record that does not exist`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}
