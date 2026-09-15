/**
 * The screen catalogue, and the promise the navigation makes.
 *
 * Two things are asserted here that nothing asserted before.
 *
 * The first is coverage: every item in the approved tree is classified, and the
 * catalogue invents nothing the tree does not name. A menu item with no
 * archetype has no screen, and would be silently skipped by the renderer — the
 * exact failure this file exists to make loud.
 *
 * The second is reachability, and it is the one that was missing. `menu.ts`
 * carried 42 hrefs and only four of them resolved; the other 38 were links to
 * pages nobody had written. The existing gate only checked that an href *looks*
 * like a path (`/^\//`), which every dead link also satisfies. Navigation that
 * offers a page and then 404s is worse than navigation that admits the page is
 * not built — Appendix A's whole point is that the tree is honest about what
 * exists.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MENU, allMenuItems } from '@domain/menu';
import { ENTITY_COLUMNS, specFor } from '@/sample/specs';
import {
  SCREENS,
  SCREEN_ARCHETYPES,
  archetypeOf,
  catalogueGaps,
  routeFor,
  screenCount,
  screenRoutes,
  screensByPhase,
} from '@domain/screens';

const APP = join(process.cwd(), 'src', 'app');

/**
 * Every route the App Router actually serves, as a set of URL paths.
 *
 * Route groups `(name)` contribute nothing to the URL, and parallel/intercepted
 * segments are not used in this application. A dynamic segment is kept as its
 * bracketed literal so a caller can decide whether a concrete path matches it.
 */
function servedRoutes(dir: string = APP, base = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const segment = entry.startsWith('(') && entry.endsWith(')') ? '' : `/${entry}`;
      return servedRoutes(path, base + segment);
    }
    return entry === 'page.tsx' ? [base || '/'] : [];
  });
}

const served = new Set(servedRoutes());

/** True when a concrete path is served, directly or by a catch-all above it. */
function isServed(route: string): boolean {
  if (served.has(route)) return true;
  return [...served].some((pattern) => {
    if (!pattern.includes('[')) return false;
    const expression = pattern
      .split('/')
      .map((segment) =>
        segment.startsWith('[[...') ? '(?:.*)' : segment.startsWith('[...') ? '(?:.+)' : segment.startsWith('[') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('/');
    return new RegExp(`^${expression}$`).test(route);
  });
}

describe('the screen catalogue covers the approved tree', () => {
  it('classifies every menu item, and names none the tree does not', () => {
    const { missing, orphaned } = catalogueGaps();
    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] });
  });

  // 222 in Appendix A, less the invoicing sample and Data Scopes (removed by
  // direction, 2026-08-29), plus the four statement pages — Appendix A named
  // one "Financial Statements"; the sponsor asked for Income Statement,
  // Balance Sheet, Changes in Equity and Cash Flow Statement each on its own
  // screen (2026-08-31), which is grouping refined, not function added.
  //
  // Plus two for Phase 2: Cash Accounts beside Bank Accounts, because the
  // questions each kind asks are different; and Payment Methods, which the
  // phase requires and Appendix A did not list at all.
  //
  // Less five, by direction (2026-08-31): no screen appears under two
  // headings. Appendix A listed the partners under CRM *and* Master Data,
  // units of measure under Inventory *and* Master Data, the audit trail under
  // Documents *and* Administration, and the error queue under Integrations
  // *and* Administration — five aliases, each of which read as a second screen
  // until you opened both and found one page. No function was removed: every
  // one of them is still reachable, once.
  // Plus one more, by direction (2026-09-03): the Statement Mapping, where
  // Finance defines the headers and lines of its own reports.
  it('classifies all 221 items in the approved tree', () => {
    expect(allMenuItems()).toHaveLength(221);
    expect(Object.keys(SCREENS)).toHaveLength(221);
  });

  it('uses only declared archetypes', () => {
    for (const [key, archetype] of Object.entries(SCREENS)) {
      expect(SCREEN_ARCHETYPES, key).toContain(archetype);
    }
  });

  it('counts a document as two screens — the list and the record behind it', () => {
    expect(screenCount('document')).toBe(2);
    expect(screenCount('report')).toBe(1);

    const total = allMenuItems().reduce(
      (sum, item) => sum + screenCount(archetypeOf(item.key)!),
      0,
    );
    expect(total).toBe(328);
  });
});

describe('every screen has one address', () => {
  it('keeps the href a module already declared', () => {
    // journal_entry names /finance/journals; the derivation must not rename it.
    const gl = MENU.find((section) => section.key === 'finance_gl')!;
    const journal = gl.items.find((item) => item.key === 'journal_entry')!;
    expect(routeFor(journal, gl.key)).toBe('/finance/journals');
  });

  it('derives /{section}/{screen} for an item that declares none', () => {
    const sales = MENU.find((section) => section.key === 'sales')!;
    const orders = sales.items.find((item) => item.key === 'sales_orders')!;
    expect(orders.href).toBeNull();
    expect(routeFor(orders, sales.key)).toBe('/sales/sales-orders');
  });

  it('gives every item a route', () => {
    for (const section of MENU) {
      for (const item of section.items) {
        expect(routeFor(item, section.key), item.key).toMatch(/^\//);
      }
    }
  });

  /**
   * No route is reached from two places — by direction, 2026-08-31.
   *
   * The tree used to alias five. Some were deliberate (Business Partners and
   * Units of Measure sat under a module menu *and* under Master Data) and some
   * were accidents that hid a screen: Background Jobs and the Error Queue
   * shared /administration/jobs while classifying as different archetypes, so
   * one of the two could never be rendered at that address.
   *
   * Either way a reader met the same page twice under different names, which
   * is indistinguishable from two screens until you open both. Each now sits
   * under the heading whose work it belongs to, and this test holds the line:
   * an alias reintroduced fails here rather than quietly duplicating a screen.
   */
  it('reaches every screen from exactly one place in the tree', () => {
    const byRoute = new Map<string, string[]>();
    for (const section of MENU) {
      for (const item of section.items) {
        const route = routeFor(item, section.key);
        byRoute.set(route, [...(byRoute.get(route) ?? []), item.key]);
      }
    }
    const shared = Object.fromEntries(
      [...byRoute].filter(([, keys]) => keys.length > 1).map(([route, keys]) => [route, keys.sort()]),
    );
    expect(shared).toEqual({});
    expect(screenRoutes().size).toBe(221);
  });

  it('marks only the delivered screens as reading real data', () => {
    const wired = [...screenRoutes().values()].filter((screen) => screen.wired);
    expect(wired.map((screen) => screen.route).sort()).toEqual([
      '/',
      '/administration/audit',
      '/administration/company',
      '/administration/managers',
      '/administration/numbering',
      '/administration/permissions',
      '/administration/roles',
      '/administration/users',
      '/approvals',
      '/documents',
      // Phase 1 — the accounting core.
      '/finance/balance-sheet',
      '/finance/cash-flow',
      '/finance/changes-in-equity',
      '/finance/gl-inquiry',
      '/finance/income-statement',
      '/finance/journals',
      '/finance/periods',
      '/finance/reversals',
      '/finance/trial-balance',
      '/inventory/availability',
      // Operations build — block 7's Warehouses Report.
      '/inventory/fifo-valuation',
      '/master-data/bank-accounts',
      '/master-data/branches',
      '/master-data/cash-accounts',
      '/master-data/chart-of-accounts',
      // Phase 2 — the accounting master data.
      '/master-data/cost-centres',
      '/master-data/customers',
      '/master-data/departments',
      '/master-data/exchange-rates',
      '/master-data/items',
      '/master-data/payment-methods',
      '/master-data/payment-terms',
      '/master-data/statement-mapping',
      '/master-data/suppliers',
      '/master-data/uom',
      '/master-data/warehouses',
      // Operations build — block 4's Purchase Invoice.
      '/purchasing/ap-invoices',
      // Block 10 — Purchase Returns.
      '/purchasing/goods-returns',
      // Block 6 — Payments and Receipts.
      '/purchasing/supplier-payments',
      // Block 5 — the Sales Invoice.
      '/sales/ar-invoices',
      // Block 6 — Receipts.
      '/sales/customer-receipts',
      // Block 9 — Sales Returns.
      '/sales/sales-returns',
    ]);
  });
});

describe('the navigation offers no page that does not exist', () => {
  /**
   * The regression that prompted this file. Every href in the tree, and every
   * route the catalogue derives, must resolve to something the App Router
   * serves — a page file of its own, or a catch-all standing in for it.
   */
  it('resolves every href declared in the menu tree', () => {
    const dead = allMenuItems()
      .filter((item) => item.href !== null && !isServed(item.href))
      .map((item) => `${item.key} → ${item.href}`);
    expect(dead).toEqual([]);
  });

  it('resolves every route the catalogue derives', () => {
    const dead = [...screenRoutes().values()]
      .filter((screen) => !isServed(screen.route))
      .map((screen) => `${screen.item.key} → ${screen.route}`);
    expect(dead).toEqual([]);
  });
});

describe('the build tracker reports what each phase owes the frontend', () => {
  it('attributes every screen to the phase that delivers it', () => {
    const byPhase = screensByPhase();
    const counted = [...byPhase.values()].reduce((sum, screens) => sum + screens.length, 0);
    expect(counted).toBe(221);
    for (const phase of byPhase.keys()) expect(phase).toMatch(/^\d\d$/);
  });
});

/**
 * The keys the catalogue test cannot see.
 *
 * `i18n-catalogue.test.ts` extracts literal keys from the source, so it proves
 * `t('screen.company')` resolves. It cannot prove `screen(`purpose.${section}`)`
 * resolves, because the key is built at render time — and a missing one of
 * those does not fail a build, it renders `purpose.finance_ap` into the
 * subtitle of every Payables screen.
 *
 * Every namespace the screen renderer indexes by a domain value is enumerated
 * here against the domain list it is indexed by.
 */
describe('§25 · the keys built at render time all resolve', () => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), 'messages', 'en.json'), 'utf8'),
  ) as Record<string, Record<string, Record<string, unknown>>>;
  const arabic = JSON.parse(
    readFileSync(join(process.cwd(), 'messages', 'ar.json'), 'utf8'),
  ) as Record<string, Record<string, Record<string, unknown>>>;

  const METRIC_KEYS = [
    ...new Set(
      MENU.flatMap((section) =>
        section.items.flatMap((item) => specFor(item.key, section.key).metrics),
      ),
    ),
  ];

  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['screen.purpose', MENU.map((section) => section.key)],
    ['screen.about', [...SCREEN_ARCHETYPES]],
    ['screen.archetype', [...SCREEN_ARCHETYPES]],
    ['screen.metric', METRIC_KEYS],
    ['column', [...new Set(Object.values(ENTITY_COLUMNS).flatMap((set) => set.map((c) => c.key)))]],
  ];

  for (const [namespace, keys] of cases) {
    it(`resolves every ${namespace}.* the renderer asks for`, () => {
      const [head, tail] = namespace.split('.');
      const bucket = tail
        ? ((messages[head!]?.[tail] ?? {}) as Record<string, unknown>)
        : ((messages[head!] ?? {}) as Record<string, unknown>);
      const arabicBucket = tail
        ? ((arabic[head!]?.[tail] ?? {}) as Record<string, unknown>)
        : ((arabic[head!] ?? {}) as Record<string, unknown>);

      expect(keys.length).toBeGreaterThan(0);
      expect(keys.filter((key) => typeof bucket[key] !== 'string')).toEqual([]);
      // Arabic must not lag behind: a key present only in English renders as
      // the key itself the moment somebody switches locale.
      expect(keys.filter((key) => typeof arabicBucket[key] !== 'string')).toEqual([]);
    });
  }
});
