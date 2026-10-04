/**
 * The screens whose filters can be saved as a view (platform phase, Agent 8).
 *
 * One entry per list or report screen, and each entry is *all* a screen has to
 * say: its path, the query-string parameters it reads (name, kind, allowed
 * values) and which of its dates may be kept as a rule. `saved-views.ts` turns
 * that declaration into validation, so a view can never carry a parameter the
 * screen did not declare.
 *
 * To make another screen viewable (later agents — one entry here, nothing else
 * in this file):
 *
 *   1. add a `ViewableRoute` below; `route` must be a path the shell serves and
 *      `key` is `<area>.<screen>` (stored with every view, so it never changes);
 *   2. in the page, after its permission check:
 *
 *        const saved = await savedViewsFor('<key>', searchParams);
 *        … <ListToolbar …><SavedViewsMenu state={saved} /></ListToolbar>
 *
 *      (a report without a toolbar puts the menu in `AdminPage`'s `actions`);
 *   3. optionally a pinned-count function in `services/saved-view-counts.ts`
 *      that asks the *screen's own* query — never a second one;
 *   4. enum values with no message of the screen's own get one under
 *      `savedViews.values.<own>` in both locales; `sv01-saved-view-routes`
 *      fails if a label, a slot parameter or the route itself is missing.
 *
 * Open slot — the Task Center (Agent 3) registers its list here when it lands:
 * `{ key: 'tasks.my', route: '/tasks', params: { view: …, due: … } }` with a
 * `range` slot on its due date, which makes "my open tasks due this week" a
 * view. Until its route is served an entry would only be shown as unavailable,
 * so none is declared for it.
 */
import type { ViewableRoute } from './saved-views';

const SHIPMENT_VIEW = { namespace: 'admin.shipments', prefix: 'view_' } as const;
const LOGISTICS_VIEW = { namespace: 'admin.logistics', prefix: 'view_' } as const;

const OPEN_ITEMS_PARAMS = {
  code: { kind: 'token' },
  as_at: { kind: 'date' },
} as const;

export const VIEWABLE_ROUTES: readonly ViewableRoute[] = [
  // --- Payables ------------------------------------------------------------
  {
    key: 'payables.invoices',
    route: '/payables/invoices',
    params: {
      q: { kind: 'text' },
      view: {
        kind: 'enum',
        values: ['imports', 'expenses', 'unpaid', 'overdue'],
        labels: { namespace: 'admin.expenses', prefix: 'view_' },
      },
      min_amount: { kind: 'amount' },
    },
  },
  {
    // "Overdue suppliers": show=overdue, as of today (the screen's own default).
    key: 'payables.open_items',
    route: '/payables/open-items',
    params: {
      show: {
        kind: 'enum',
        values: ['all', 'open', 'overdue'],
        labels: { namespace: 'admin.open_items', prefix: 'show_' },
      },
      ...OPEN_ITEMS_PARAMS,
    },
    slots: [{ id: 'as_at', kind: 'point', param: 'as_at' }],
  },
  {
    key: 'payables.suppliers',
    route: '/payables/suppliers',
    params: {
      q: { kind: 'text' },
      status: {
        kind: 'enum',
        values: ['prospect', 'active', 'on_hold', 'blocked', 'inactive'],
        labels: { namespace: 'admin.partners', prefix: 'status_' },
      },
    },
  },

  // --- Sales & Receivables -------------------------------------------------
  {
    // "Sales invoices awaiting payment": show=open (or overdue).
    key: 'sales.receivables',
    route: '/sales/receivables',
    params: {
      show: {
        kind: 'enum',
        values: ['all', 'open', 'part_paid', 'paid', 'overdue'],
        labels: { namespace: 'admin.receivables_ageing', prefix: 'show_' },
      },
      ...OPEN_ITEMS_PARAMS,
      currency: { kind: 'token', max: 3 },
      branch: { kind: 'token' },
    },
    slots: [{ id: 'as_at', kind: 'point', param: 'as_at' }],
  },
  { key: 'sales.invoices', route: '/sales/ar-invoices', params: { q: { kind: 'text' } } },
  { key: 'sales.receipts', route: '/sales/customer-receipts', params: { q: { kind: 'text' } } },
  {
    key: 'sales.customers',
    route: '/sales/customers',
    params: {
      q: { kind: 'text' },
      status: {
        kind: 'enum',
        values: ['prospect', 'active', 'on_hold', 'blocked', 'inactive'],
        labels: { namespace: 'admin.partners', prefix: 'status_' },
      },
    },
  },

  // --- Imports: containers, bills of lading, customs -----------------------
  {
    // "Containers arriving this month": eta_from/eta_to kept as the `this_month` rule.
    key: 'imports.containers',
    route: '/payables/containers',
    params: {
      q: { kind: 'text' },
      view: {
        kind: 'enum',
        values: ['in_transit', 'late', 'received', 'exceptions', 'cancelled', 'all'],
        labels: SHIPMENT_VIEW,
      },
      eta_from: { kind: 'date' },
      eta_to: { kind: 'date' },
    },
    slots: [{ id: 'eta', kind: 'range', from: 'eta_from', to: 'eta_to' }],
  },
  { key: 'imports.shipments', route: '/payables/shipments', params: { q: { kind: 'text' } } },
  {
    // "Imports in customs": the PD register's open view.
    key: 'imports.pd',
    route: '/payables/pd',
    params: {
      q: { kind: 'text' },
      view: {
        kind: 'enum',
        values: ['live', 'expiring', 'final', 'holding', 'all'],
        labels: { own: 'pd_view' },
      },
    },
  },
  {
    key: 'logistics.shipment_tracking',
    route: '/logistics/shipment-tracking',
    params: {
      q: { kind: 'text' },
      view: {
        kind: 'enum',
        values: ['open', 'late', 'at_port', 'cleared', 'all'],
        labels: { ...LOGISTICS_VIEW, map: { cleared: 'view_customs_cleared' } },
      },
    },
  },
  {
    key: 'logistics.in_transit',
    route: '/logistics/in-transit',
    params: {
      q: { kind: 'text' },
      view: { kind: 'enum', values: ['open', 'all'], labels: LOGISTICS_VIEW },
    },
  },
  {
    key: 'logistics.customs_declarations',
    route: '/logistics/customs-declarations',
    params: {
      q: { kind: 'text' },
      view: { kind: 'enum', values: ['open', 'cleared', 'ended', 'all'], labels: LOGISTICS_VIEW },
    },
  },

  // --- Inventory -----------------------------------------------------------
  {
    // "Low-stock inventory" is availability with the in-stock box and a warehouse.
    key: 'inventory.availability',
    route: '/inventory/availability',
    params: {
      q: { kind: 'text' },
      warehouse: { kind: 'token' },
      category: { kind: 'token' },
      branch: { kind: 'token' },
      in_stock: { kind: 'flag' },
    },
  },
  {
    key: 'inventory.stock_movements',
    route: '/inventory/stock-movements',
    params: {
      from: { kind: 'date' },
      to: { kind: 'date' },
      item: { kind: 'text' },
      warehouse: { kind: 'token' },
      document: { kind: 'token' },
    },
    slots: [{ id: 'dates', kind: 'range', from: 'from', to: 'to' }],
  },
  {
    key: 'inventory.stock_ledger',
    route: '/inventory/stock-ledger',
    params: {
      item: { kind: 'text' },
      warehouse: { kind: 'token' },
      from: { kind: 'date' },
      to: { kind: 'date' },
    },
    slots: [{ id: 'dates', kind: 'range', from: 'from', to: 'to' }],
  },
  // --- Platform ------------------------------------------------------------
  {
    // The Exception Center's register: "critical receivables", "mine, still open".
    key: 'exceptions.list',
    route: '/exceptions',
    params: {
      q: { kind: 'text' },
      domain: {
        kind: 'enum',
        values: ['accounting', 'receivables', 'payables', 'inventory', 'logistics', 'tasks', 'approvals', 'platform'],
        labels: { namespace: 'admin.exceptions', prefix: 'domain_' },
      },
      severity: {
        kind: 'enum',
        values: ['critical', 'high', 'medium', 'low'],
        labels: { namespace: 'admin.exceptions', prefix: 'severity_' },
      },
      status: {
        kind: 'enum',
        values: ['live', 'open', 'acknowledged', 'resolved', 'all'],
        labels: { namespace: 'admin.exceptions', prefix: 'status_' },
      },
      owner: {
        kind: 'enum',
        values: ['me', 'none'],
        labels: { namespace: 'admin.exceptions', prefix: 'owner_' },
      },
    },
  },
];

const BY_KEY: ReadonlyMap<string, ViewableRoute> = new Map(VIEWABLE_ROUTES.map((route) => [route.key, route]));

/** The registered screen for a key, or undefined (a key stored by an earlier release of the registry). */
export function viewableRoute(key: string): ViewableRoute | undefined {
  return BY_KEY.get(key);
}
