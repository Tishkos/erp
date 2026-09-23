import { screenRoutes } from './domain/screens';
/**
 * The phase gate — only what the accepted phases define is visible.
 *
 * By direction (2026-08-24): the system shows exactly the phases the sponsor
 * has accepted and nothing else. Screens of later phases are hidden from every
 * surface (navigation, launcher, search, tabs, dashboard) AND refused on the
 * direct URL, until their phase is shared and accepted.
 *
 * `SHOW_FUTURE_PHASES=1` lifts the gate — used only by the local test server,
 * so the framework suites that exercise later-phase machinery keep running.
 * Production does not set it.
 *
 * Each phase keeps its own list. A route is not moved between them when a
 * later phase touches it: the point of the record is which phase promised the
 * screen, and that does not change afterwards.
 */

/** Phase 0 — the system foundation. Accepted 2026-08-23. */
const PHASE_0: readonly string[] = [
  '/',
  '/approvals',
  '/profile',
  '/administration/company',
  '/administration/users',
  '/administration/managers',
  '/administration/roles',
  '/administration/permissions',
  '/administration/numbering',
  '/administration/audit',
  '/master-data/branches',
  '/master-data/departments',
];

/**
 * Phase 1 — the accounting core. The Chart of Accounts, Journal Entries and
 * their posting and reversal, and the reports read from what they post.
 *
 * Two screens are here although the phase definition does not name them, for
 * the same reason: nothing can be posted without them. A journal needs a
 * period to post into, and every line is measured in the ledger currency and
 * in USD — so a date with no rate in force refuses the entry outright.
 */
const PHASE_1: readonly string[] = [
  '/master-data/chart-of-accounts',
  '/finance/journals',
  '/finance/reversals',
  '/finance/gl-inquiry',
  '/finance/trial-balance',
  '/finance/income-statement',
  '/finance/balance-sheet',
  '/finance/changes-in-equity',
  '/finance/cash-flow',
  '/finance/periods',
  '/master-data/exchange-rates',
];

/**
 * Phase 2 — the accounting master data. Accepted 2026-08-31.
 *
 * The records the next phases select from rather than retype: cost centres,
 * customers and suppliers, items and the units they are measured in, the
 * company's own bank and cash accounts, and the payment terms and methods
 * every receipt and payment will name.
 */
const PHASE_2: readonly string[] = [
  '/master-data/cost-centres',
  '/master-data/statement-mapping',
  '/master-data/customers',
  '/master-data/suppliers',
  '/master-data/business-partners',
  '/master-data/items',
  '/master-data/uom',
  '/master-data/bank-accounts',
  '/master-data/cash-accounts',
  '/master-data/payment-terms',
  '/master-data/payment-methods',
];

/**
 * The Operations Build — the sponsor's own specification (2026-09-12), built
 * block by block on Phase 2's master data.
 *
 * Not a numbered phase, and deliberately not counted as one below: the phases
 * arrive as documents the sponsor accepts as a set, and this arrived as its own
 * list of eleven blocks to be accepted one at a time. A route joins this list
 * on the day its screen reads real data — never before, because a route that is
 * visible and unbuilt is a menu item that leads to an apology.
 */
export const OPERATIONS: readonly string[] = [
  // Block 7 — the Warehouses Report and Warehouse Setup.
  '/inventory/fifo-valuation',
  '/master-data/warehouses',
  // Block 4 — the Purchase Invoice.
  '/purchasing/ap-invoices',
  // Block 5 — the Sales Invoice.
  '/sales/ar-invoices',
  // Block 9 — Sales Returns.
  '/sales/sales-returns',
  // Block 10 — Purchase Returns.
  '/purchasing/goods-returns',
  // Block 6 — Payments and Receipts.
  '/purchasing/supplier-payments',
  '/sales/customer-receipts',
  // Block 8 — Invoice Status Tracking.
  '/inventory/in-transit',
  // Posting Mappings was here while it was the only way to tell the engine
  // which account a document posts to. By direction (2026-09-23) that choice
  // belongs on the invoice, where the invoice is made — so the screen comes
  // off the tree. The mappings themselves stay: they are what the fields on
  // those forms open on, and what every other document still posts through.
];

const VISIBLE: ReadonlySet<string> = new Set([
  ...PHASE_0,
  ...PHASE_1,
  ...PHASE_2,
  ...OPERATIONS,
]);

/**
 * The phase the system is at, as the footer says it.
 *
 * Read from the lists above rather than written down twice: the day a phase's
 * routes are added here is the day the system is at that phase, and a version
 * label that has to be remembered separately is a label that will be wrong.
 */
export function currentPhase(): string {
  return `Phase ${[PHASE_0, PHASE_1, PHASE_2].length - 1}`;
}

export function futurePhasesShown(): boolean {
  return process.env.SHOW_FUTURE_PHASES === '1';
}

/** May this route exist for the user right now? Record pages inherit their list's answer. */
export function visibleRoute(route: string): boolean {
  if (futurePhasesShown()) return true;
  if (VISIBLE.has(route)) return true;
  // A record under a visible list ( /master-data/branches/HQ ) is visible too.
  const parent = route.replace(/\/[^/]+$/, '');
  return parent.length > 1 && VISIBLE.has(parent);
}

/**
 * The permission objects the accepted phases can grant over — the objects
 * behind the screens that exist. A grant over a section nobody can open would
 * be a promise the system cannot keep, so the editor does not offer one.
 */
export function phaseObjects(): ReadonlySet<string> {
  const objects = new Set<string>();
  for (const screen of screenRoutes().values()) {
    if (visibleRoute(screen.route)) objects.add(screen.item.object);
  }
  return objects;
}
