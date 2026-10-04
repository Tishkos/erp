/**
 * The Home page's widget registry — platform phase, Agent 2.
 *
 * Home is not one dashboard with parts hidden. It is a **composition**: a list
 * of widgets, each declaring the grants it needs, and a page made of those the
 * signed-in person really holds. Nothing here knows an e-mail address, a user
 * id or a seeded person; a role is only ever a *capability* the person holds
 * (the CEO's `management`), and everything else falls out of the same grants
 * the screens behind the widgets ask. That is the rule `services/dashboard.ts`
 * has always stated for its bands ("every band asks the object its own screen
 * asks"); this file turns it from a convention in a page into data a test can
 * read.
 *
 * Pure: no database, no request, no clock. The loaders that fetch a widget's
 * figures are `services/home-loaders.ts`, keyed by `WidgetKey` so a widget
 * without a loader is a type error, not a blank hole.
 *
 * ── The vocabulary ────────────────────────────────────────────────────────
 *   family    which kind of work the widget belongs to. It only decides the
 *             order (a finance person's page leads with finance) and the
 *             sentence ("No sales data available for your role.") — never
 *             whether the widget may be seen. That is `requires`.
 *   zone      where it sits: `kpi` (the primary figures), `chart` (the trends
 *             where there is data to draw), `list` (what can be acted on).
 *   requires  every grant the widget needs, as `verb` on `object`. All of
 *             them. A widget of a data family declares at least one — a
 *             family widget with no requirement would be shown to everybody,
 *             including a person with no access to the family's data.
 *   capability  something a person *is* rather than a grant they hold:
 *             `management` (the CEO role), `approver` (someone approvals can
 *             wait on), `assigner` (someone who may give work to others).
 *   weight    importance inside the family, 0–100; the tie-break after the
 *             family's rank.
 */
import { can, isCeo, type PermissionVerb, type Principal } from './permissions';

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

export const CAPABILITY_FAMILIES = [
  'management',
  'finance',
  'receivables',
  'payables',
  'sales',
  'purchasing',
  'inventory',
  'logistics',
  'hr',
  'projects',
  'employee',
] as const;
export type CapabilityFamily = (typeof CAPABILITY_FAMILIES)[number];

/** The families whose data a person either can or cannot read. */
export const DATA_FAMILIES = [
  'finance',
  'receivables',
  'payables',
  'sales',
  'purchasing',
  'inventory',
  'logistics',
  'hr',
  'projects',
] as const;
export type DataFamily = (typeof DATA_FAMILIES)[number];

export function isDataFamily(family: CapabilityFamily): family is DataFamily {
  return (DATA_FAMILIES as readonly string[]).includes(family);
}

/**
 * The objects whose `view` grant evidences a family. A person is "in" a family
 * when they hold any of them, and the family's *depth* — the share they hold —
 * is what ranks one family above another on their page: an accounting officer
 * holds most of Finance and a little of Logistics, so Finance leads.
 */
export const FAMILY_ANCHORS: Readonly<Record<DataFamily, readonly string[]>> = {
  finance: ['bank_account', 'financial_statement', 'journal_entry', 'bank_reconciliation', 'trial_balance', 'gl_inquiry', 'fiscal_period'],
  receivables: ['ar_invoice', 'customer_receipt', 'ar_write_off', 'customer_credit_memo'],
  payables: ['ap_invoice', 'payable', 'payment_application', 'supplier_payment', 'supplier_advance'],
  sales: ['sales_order', 'ar_invoice', 'delivery_note', 'pick_list', 'sales_return'],
  purchasing: ['purchase_order', 'goods_receipt', 'service_receipt', 'recurring_contract'],
  inventory: ['inventory_movement', 'stock_movement', 'warehouse', 'stock_count', 'warehouse_transfer', 'item'],
  logistics: ['bill_of_lading', 'shipment_container', 'customs_pd', 'customs_declaration', 'in_transit', 'landed_cost_register', 'port'],
  hr: ['employee', 'leave_request', 'hr_report', 'payroll_run', 'recruitment', 'performance_review'],
  projects: ['project', 'project_setting'],
};

export interface RankedFamily {
  readonly family: CapabilityFamily;
  /** How many of the family's anchors the person holds, and out of how many. */
  readonly held: number;
  readonly of: number;
}

export function anchorsHeld(principal: Principal, family: DataFamily): number {
  return FAMILY_ANCHORS[family].filter((object) => can(principal, 'view', object)).length;
}

// ---------------------------------------------------------------------------
// Capabilities — what a person is, beyond the grants they hold
// ---------------------------------------------------------------------------

export const WIDGET_CAPABILITIES = ['management', 'approver', 'assigner'] as const;
export type WidgetCapability = (typeof WIDGET_CAPABILITIES)[number];

/**
 * Whether the person holds the capability.
 *
 * `management` is the CEO role — the existing `isCeo`, the same test that
 * keeps role administration with that account. `approver` is "an approval can
 * wait on this person": any `approve` grant, a department they manage, or the
 * super user. (Viewing the My Approvals screen is not enough — every role that
 * raises a document may see its own submissions there, and that does not make
 * them somebody a decision waits for.) `assigner` is the Task Center's right to
 * give work to someone (its `submit` verb; there is no "assign" verb).
 */
export function holdsCapability(principal: Principal, capability: WidgetCapability): boolean {
  if (!principal.isActive) return false;
  switch (capability) {
    case 'management':
      return isCeo(principal);
    case 'approver':
      return (
        principal.isSuperUser ||
        principal.grants.some((grant) => grant.verb === 'approve') ||
        principal.departments.some((department) => department.isManager)
      );
    case 'assigner':
      return can(principal, 'submit', 'task');
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

export type WidgetZone = 'kpi' | 'chart' | 'list';

export interface Requirement {
  readonly verb: PermissionVerb;
  readonly object: string;
}

export interface WidgetDefinition {
  readonly key: string;
  readonly family: CapabilityFamily;
  readonly zone: WidgetZone;
  readonly requires: readonly Requirement[];
  /** When non-empty, at least one of these as well — a widget that reads several sources, each under its own grant. */
  readonly requiresAny?: readonly Requirement[];
  readonly capability?: WidgetCapability;
  readonly weight: number;
  /**
   * Leads its zone whatever the person's families are: what is waiting on them
   * and what is wrong come before any family's figures. Ordered among the
   * leaders by weight.
   */
  readonly lead?: boolean;
  /**
   * A list that is better absent than empty (the pinned views, the attention
   * slot): when it has nothing to say the page does not draw its window.
   */
  readonly hideWhenEmpty?: boolean;
}

const view = (object: string): Requirement => ({ verb: 'view', object });

/**
 * Every widget on Home. The order here means nothing; `composeFor` orders by
 * the person's families and the weights.
 *
 * Titles and empty sentences are `home.widget.<key>.title` / `.empty` in both
 * message files; `tests/unit/dash-widgets.test.ts` fails on a key without them.
 */
export const WIDGETS = [
  // ── Primary figures ─────────────────────────────────────────────────────
  { key: 'approvals_waiting', family: 'employee', zone: 'kpi', requires: [], capability: 'approver', weight: 95, lead: true },
  { key: 'cash_position', family: 'finance', zone: 'kpi', requires: [view('bank_account')], weight: 90 },
  { key: 'receivable_total', family: 'receivables', zone: 'kpi', requires: [view('ar_invoice')], weight: 85 },
  { key: 'payable_total', family: 'payables', zone: 'kpi', requires: [view('ap_invoice')], weight: 85 },
  { key: 'overdue_receivables', family: 'management', zone: 'kpi', requires: [view('ar_invoice')], capability: 'management', weight: 88 },
  { key: 'overdue_payables', family: 'management', zone: 'kpi', requires: [view('ap_invoice')], capability: 'management', weight: 87 },
  { key: 'inventory_value', family: 'inventory', zone: 'kpi', requires: [view('inventory_movement')], weight: 80 },
  { key: 'net_result', family: 'finance', zone: 'kpi', requires: [view('financial_statement')], weight: 70 },
  { key: 'pending_payments', family: 'payables', zone: 'kpi', requires: [view('payment_application')], weight: 75 },
  { key: 'imports_in_progress', family: 'logistics', zone: 'kpi', requires: [view('payable'), view('shipment_container')], weight: 90 },
  { key: 'warehouse_today', family: 'inventory', zone: 'kpi', requires: [view('stock_movement')], weight: 85 },
  { key: 'purchasing_open', family: 'purchasing', zone: 'kpi', requires: [view('purchase_order')], weight: 75 },
  { key: 'sales_period', family: 'sales', zone: 'kpi', requires: [view('ar_invoice')], weight: 78 },
  { key: 'hr_overview', family: 'hr', zone: 'kpi', requires: [view('employee')], weight: 80 },
  { key: 'projects_overview', family: 'projects', zone: 'kpi', requires: [view('project')], weight: 80 },
  { key: 'tasks_mine', family: 'employee', zone: 'kpi', requires: [view('task')], weight: 70 },
  { key: 'notifications_unread', family: 'employee', zone: 'kpi', requires: [view('notification')], weight: 40 },
  { key: 'chat_unread', family: 'employee', zone: 'kpi', requires: [view('chat')], weight: 30 },

  // ── Trends ──────────────────────────────────────────────────────────────
  { key: 'chart_trading', family: 'finance', zone: 'chart', requires: [view('financial_statement')], weight: 80 },
  { key: 'chart_receivable_ageing', family: 'receivables', zone: 'chart', requires: [view('ar_invoice')], weight: 85 },
  { key: 'chart_payable_ageing', family: 'payables', zone: 'chart', requires: [view('ap_invoice')], weight: 85 },
  { key: 'chart_cash_accounts', family: 'finance', zone: 'chart', requires: [view('bank_account')], weight: 70 },
  { key: 'chart_sales_trend', family: 'sales', zone: 'chart', requires: [view('ar_invoice')], weight: 78 },
  { key: 'chart_top_customers', family: 'sales', zone: 'chart', requires: [view('ar_invoice')], weight: 60 },
  { key: 'chart_stock_value', family: 'inventory', zone: 'chart', requires: [view('inventory_movement')], weight: 75 },
  { key: 'chart_import_stages', family: 'logistics', zone: 'chart', requires: [view('payable'), view('shipment_container')], weight: 90 },

  // ── What can be acted on ────────────────────────────────────────────────
  { key: 'attention', family: 'management', zone: 'list', requires: [], weight: 99, lead: true, hideWhenEmpty: true },
  { key: 'list_approvals', family: 'employee', zone: 'list', requires: [], capability: 'approver', weight: 95, lead: true },
  { key: 'list_tasks', family: 'employee', zone: 'list', requires: [view('task')], weight: 70 },
  { key: 'list_pinned_views', family: 'employee', zone: 'list', requires: [], weight: 60, hideWhenEmpty: true },
  { key: 'list_major_imports', family: 'management', zone: 'list', requires: [view('payable')], capability: 'management', weight: 88 },
  { key: 'list_payments_due', family: 'payables', zone: 'list', requires: [view('payable')], weight: 80 },
  { key: 'list_delayed_containers', family: 'logistics', zone: 'list', requires: [view('shipment_container')], weight: 90 },
  { key: 'list_customs_actions', family: 'logistics', zone: 'list', requires: [view('shipment_container'), view('customs_pd')], weight: 85 },
  { key: 'list_landed_cost_blocks', family: 'logistics', zone: 'list', requires: [view('landed_cost_register')], weight: 80 },
  { key: 'list_in_transit', family: 'logistics', zone: 'list', requires: [view('in_transit')], weight: 75 },
  { key: 'list_pending_receipts', family: 'inventory', zone: 'list', requires: [view('shipment_container'), view('inventory_movement')], weight: 85 },
  { key: 'list_low_stock', family: 'inventory', zone: 'list', requires: [view('inventory_movement')], weight: 78 },
  { key: 'list_todays_movements', family: 'inventory', zone: 'list', requires: [view('stock_movement')], weight: 70 },
  { key: 'list_open_orders', family: 'purchasing', zone: 'list', requires: [view('purchase_order')], weight: 70 },
  { key: 'list_on_leave', family: 'hr', zone: 'list', requires: [view('leave_request'), view('employee')], weight: 75 },
  { key: 'list_projects', family: 'projects', zone: 'list', requires: [view('project')], weight: 75 },
  { key: 'list_unread_notifications', family: 'employee', zone: 'list', requires: [view('notification')], weight: 40, hideWhenEmpty: true },
  { key: 'list_findings', family: 'management', zone: 'list', requires: [], requiresAny: [view('inventory_movement'), view('customer_receipt'), view('bank_account')], weight: 50, hideWhenEmpty: true },
  { key: 'list_activity', family: 'management', zone: 'list', requires: [view('audit_event')], weight: 40 },
] as const satisfies readonly WidgetDefinition[];

export type WidgetKey = (typeof WIDGETS)[number]['key'];

export function widgetByKey(key: string): WidgetDefinition | undefined {
  return (WIDGETS as readonly WidgetDefinition[]).find((widget) => widget.key === key);
}

// ---------------------------------------------------------------------------
// Quick actions
// ---------------------------------------------------------------------------

export interface QuickActionDefinition {
  readonly key: string;
  readonly family: CapabilityFamily;
  /** The screen the action opens. It is offered only if the shell serves it. */
  readonly href: string;
  readonly requires: readonly Requirement[];
  readonly capability?: WidgetCapability;
  readonly weight: number;
}

/**
 * The few things worth one click from Home. Each opens a screen that already
 * exists and is offered only to a person who may do what it opens — the same
 * verb the screen's own button asks. Labels: `home.quick.<key>`.
 */
export const QUICK_ACTIONS = [
  { key: 'assign_task', family: 'employee', href: '/tasks', requires: [{ verb: 'submit', object: 'task' }], capability: 'assigner', weight: 90 },
  { key: 'open_approvals', family: 'employee', href: '/approvals', requires: [], capability: 'approver', weight: 95 },
  { key: 'new_sales_invoice', family: 'receivables', href: '/sales/ar-invoices/new', requires: [{ verb: 'create', object: 'ar_invoice' }], weight: 80 },
  { key: 'new_customer_receipt', family: 'receivables', href: '/sales/customer-receipts/new', requires: [{ verb: 'create', object: 'customer_receipt' }], weight: 75 },
  { key: 'new_purchase_invoice', family: 'payables', href: '/payables/invoices/new', requires: [{ verb: 'create', object: 'ap_invoice' }], weight: 80 },
  { key: 'new_supplier_payment', family: 'payables', href: '/payables/supplier-payments/new', requires: [{ verb: 'create', object: 'supplier_payment' }], weight: 70 },
  { key: 'bank_reconciliation', family: 'finance', href: '/treasury/bank-reconciliation', requires: [view('bank_reconciliation')], weight: 72 },
  { key: 'shipment_tracking', family: 'logistics', href: '/logistics/shipment-tracking', requires: [view('shipment_container')], weight: 90 },
  { key: 'stock_availability', family: 'inventory', href: '/inventory/availability', requires: [view('inventory_movement')], weight: 85 },
  { key: 'stock_receipts', family: 'inventory', href: '/inventory/stock-receipts', requires: [view('stock_movement')], weight: 70 },
  { key: 'purchase_orders', family: 'purchasing', href: '/payables/purchase-orders', requires: [view('purchase_order')], weight: 75 },
  { key: 'leave_requests', family: 'hr', href: '/hr/leave', requires: [view('leave_request')], weight: 80 },
  { key: 'projects', family: 'projects', href: '/projects', requires: [view('project')], weight: 80 },
  { key: 'my_tasks', family: 'employee', href: '/tasks', requires: [view('task')], weight: 50 },
  { key: 'chat', family: 'employee', href: '/chat', requires: [view('chat')], weight: 20 },
] as const satisfies readonly QuickActionDefinition[];

export type QuickActionKey = (typeof QUICK_ACTIONS)[number]['key'];

/** How many shortcuts the header offers; past this it is a menu, and the menu already exists. */
export const QUICK_ACTION_LIMIT = 5;

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

const holds = (principal: Principal, requires: readonly Requirement[]): boolean =>
  requires.every((requirement) => can(principal, requirement.verb, requirement.object));

/** Whether the person may be shown the widget at all: every grant, and the capability if it names one. */
export function widgetVisible(principal: Principal, widget: WidgetDefinition): boolean {
  if (!principal.isActive) return false;
  if (!holds(principal, widget.requires)) return false;
  if (widget.requiresAny && widget.requiresAny.length > 0 && !widget.requiresAny.some((r) => can(principal, r.verb, r.object))) {
    return false;
  }
  return widget.capability ? holdsCapability(principal, widget.capability) : true;
}

/**
 * The person's families, deepest first.
 *
 * `management` leads when the person holds the capability; `employee` is every
 * active person's own and goes last unless nothing else is held. The data
 * families follow by how much of each the person holds — a share, so a small
 * family fully held outranks a large one barely touched — with the declared
 * order breaking ties, which is what keeps a super user's page stable. A person
 * who holds `management` reads in the declared order outright (money first, then
 * the operations, then people and projects): an executive's page is not
 * reshuffled by how many objects a role happens to list.
 */
export function rankFamilies(principal: Principal): readonly RankedFamily[] {
  if (!principal.isActive) return [];
  const ranked: RankedFamily[] = [];
  const managing = holdsCapability(principal, 'management');
  if (managing) {
    ranked.push({ family: 'management', held: 1, of: 1 });
  }
  const data = DATA_FAMILIES.map((family, order) => ({
    family,
    order,
    held: anchorsHeld(principal, family),
    of: FAMILY_ANCHORS[family].length,
  }))
    .filter((entry) => entry.held > 0)
    .sort((a, b) =>
      managing ? a.order - b.order : b.held / b.of - a.held / a.of || b.held - a.held || a.order - b.order,
    );
  for (const entry of data) ranked.push({ family: entry.family, held: entry.held, of: entry.of });
  ranked.push({ family: 'employee', held: 1, of: 1 });
  return ranked;
}

/** The data families the person holds nothing of — each gets "No <family> data available for your role." */
export function unavailableFamilies(principal: Principal): readonly DataFamily[] {
  if (!principal.isActive) return [...DATA_FAMILIES];
  return DATA_FAMILIES.filter((family) => anchorsHeld(principal, family) === 0);
}

export interface Composition {
  readonly families: readonly RankedFamily[];
  /** Visible widgets, in the order they are drawn within their zone. */
  readonly kpi: readonly WidgetDefinition[];
  readonly chart: readonly WidgetDefinition[];
  readonly list: readonly WidgetDefinition[];
  readonly quickActions: readonly QuickActionDefinition[];
  readonly unavailable: readonly DataFamily[];
}

function orderBy<T extends { readonly family: CapabilityFamily; readonly weight: number; readonly key: string; readonly lead?: boolean }>(
  items: readonly T[],
  rank: ReadonlyMap<CapabilityFamily, number>,
): T[] {
  const at = (item: T) => (item.lead ? -1 : (rank.get(item.family) ?? Number.MAX_SAFE_INTEGER));
  return [...items].sort((a, b) => at(a) - at(b) || b.weight - a.weight || (a.key < b.key ? -1 : 1));
}

/**
 * The page for this person: which widgets, in which order, and which quick
 * actions. `served` says whether the shell serves a route (`visibleRoute`); an
 * action whose screen is not delivered is left out rather than offered and
 * refused.
 */
export function composeFor(principal: Principal, served: (route: string) => boolean = () => true): Composition {
  const families = rankFamilies(principal);
  const rank = new Map<CapabilityFamily, number>(families.map((entry, index) => [entry.family, index]));
  const widgets = orderBy(
    (WIDGETS as readonly WidgetDefinition[]).filter((widget) => widgetVisible(principal, widget)),
    rank,
  );
  const quickActions = orderBy(
    (QUICK_ACTIONS as readonly QuickActionDefinition[]).filter(
      (action) =>
        principal.isActive &&
        holds(principal, action.requires) &&
        (action.capability ? holdsCapability(principal, action.capability) : true) &&
        served(action.href),
    ),
    rank,
  ).slice(0, QUICK_ACTION_LIMIT);
  return {
    families,
    kpi: widgets.filter((widget) => widget.zone === 'kpi'),
    chart: widgets.filter((widget) => widget.zone === 'chart'),
    list: widgets.filter((widget) => widget.zone === 'list'),
    quickActions,
    unavailable: unavailableFamilies(principal),
  };
}
