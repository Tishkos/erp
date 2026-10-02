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
import {
  SCREENS,
  SCREEN_ARCHETYPES,
  archetypeOf,
  catalogueGaps,
  routeFor,
  screenCount,
  screenRoutes,
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
  // Plus two beside the accounting master data: Cash Accounts beside Bank Accounts, because the
  // questions each kind asks are different; and Payment Methods, which the
  // books require and Appendix A did not list at all.
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
  it('classifies all 230 items in the approved tree', () => {
    // 221 from the approved tree, plus the Stock Ledger (2026-09-27), plus
    // REQ-AP-001 §21.1: the Payables workbench, recurring contracts, payment
    // applications, PDs, B/Ls, containers, loans and the module settings —
    // eight new items — less the module-settings placeholder they replace;
    // plus REQ-AP-001 Stage 8's Sheet Migration (§24.3).
    expect(allMenuItems()).toHaveLength(230);
    expect(Object.keys(SCREENS)).toHaveLength(230);
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
    expect(total).toBe(342);
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
    expect(screenRoutes().size).toBe(230);
  });

  it('marks only the delivered screens as reading real data', () => {
    const wired = [...screenRoutes().values()].filter((screen) => screen.wired);
    expect(wired.map((screen) => screen.route).sort()).toEqual([
      '/',
      '/administration/audit',
      '/administration/company',
      '/administration/managers',
      '/administration/numbering',
      // REQ-AP-001 Stage 8 — the sheet import.
      '/administration/payables-migration',
      '/administration/payables-settings',
      '/administration/permissions',
      '/administration/roles',
      '/administration/users',
      '/approvals',
      '/documents',
      // The accounting core.
      '/finance/balance-sheet',
      '/finance/cash-flow',
      '/finance/changes-in-equity',
      '/finance/gl-inquiry',
      '/finance/income-statement',
      '/finance/journals',
      '/finance/periods',
      // Back on the tree (by direction, 2026-09-24): the documents that cannot
      // name their own account still have to name it somewhere.
      '/finance/posting-mappings',
      '/finance/reversals',
      '/finance/trial-balance',
      '/inventory/availability',
      // Operations build — block 7's Warehouses Report.
      '/inventory/fifo-valuation',
      // Block 8 — Invoice Status Tracking.
      '/inventory/in-transit',
      '/inventory/items',
      // Block 7 — Opening Stock, Item Reconciliation, Stock Movement, Transfer.
      '/inventory/opening-stock',
      // The Stock Ledger (2026-09-27).
      '/inventory/stock-ledger',
      '/inventory/stock-movements',
      '/inventory/stock-reconciliation',
      '/inventory/transfers',
      '/inventory/uom',
      '/master-data/bank-accounts',
      // REQ-AP-001 Stage 3 — the bank master.
      '/master-data/banks',
      '/master-data/branches',
      '/master-data/cash-accounts',
      '/master-data/chart-of-accounts',
      // The accounting master data.
      '/master-data/cost-centres',
      '/master-data/departments',
      '/master-data/exchange-rates',
      '/master-data/payment-methods',
      '/master-data/payment-terms',
      '/master-data/statement-mapping',
      '/master-data/warehouses',
      // REQ-AP-001 Stage 1 — the Payables workbench.
      '/payables',
      // REQ-AP-001 Stage 3 — the advances' register.
      '/payables/advances',
      '/payables/containers',
      '/payables/contracts',
      '/payables/goods-receipts',
      // Operations build — block 4's Purchase Invoice.
      '/payables/goods-returns',
      // Block 10 — Purchase Returns.
      '/payables/invoices',
      // REQ-AP-001 Stage 6 — bank loans.
      '/payables/loans',
      // §15 — what we owe, invoice by invoice.
      '/payables/open-items',
      // REQ-AP-001 Stage 3 — payment applications (§21.7).
      '/payables/payment-applications',
      // REQ-AP-001 Stage 4 — PD / ASYCUDA.
      '/payables/pd',
      '/payables/purchase-orders',
      '/payables/service-receipts',
      // REQ-AP-001 Stage 5 — B/Ls.
      '/payables/shipments',
      // Block 6 — Payments and Receipts.
      '/payables/supplier-payments',
      // Blocks 2 and 3 — the Account Statement, one screen on each side.
      '/payables/supplier-statements',
      '/payables/suppliers',
      // Block 5 — the Sales Invoice.
      '/sales/ar-invoices',
      // Block 6 — Receipts.
      '/sales/customer-receipts',
      '/sales/customer-statements',
      '/sales/customers',
      // §16 — what is owed to us, invoice by invoice.
      '/sales/receivables',
      // Block 9 — Sales Returns.
      '/sales/sales-returns',
      // §17 — Bank and Cash Reporting, beside the accounts it reports on.
      '/treasury/reporting',
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

  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['screen.about', [...SCREEN_ARCHETYPES]],
    ['screen.archetype', [...SCREEN_ARCHETYPES]],
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
