/**
 * The screen catalogue — every Appendix A menu item classified by the shape of
 * screen it needs.
 *
 * Appendix A names 218 pages. They are not 218 designs: they collapse into
 * seven shapes, and that collapse *is* the design system. A shape is designed
 * once, to the standard set by the two approved screens, then instantiated per
 * module. Without the collapse, "design every page" is 218 negotiations; with
 * it, the argument happens seven times and the rest is data.
 *
 * This file is the classification, and it is pure data in the domain layer for
 * the same reason the menu tree is (`menu.ts`): two separate things need the
 * same answer — the route that serves a screen, and the coverage test that
 * proves none was dropped. A classification assembled inside JSX could not be
 * asserted against.
 *
 * A `document` screen is really a pair — the list and the record behind it,
 * since Appendix A rules 1–4 govern both — so counts treat it as two screens.
 */
import { allMenuItems, MENU, type MenuItem, type MenuSection } from './menu';

export const SCREEN_ARCHETYPES = [
  'dashboard',
  'list',
  'document',
  'workspace',
  'report',
  'settings',
  'inbox',
] as const;

export type ScreenArchetype = (typeof SCREEN_ARCHETYPES)[number];

/** How many screens an archetype stands for (document = list + record). */
export function screenCount(archetype: ScreenArchetype): number {
  return archetype === 'document' ? 2 : 1;
}

/**
 * Menu key → archetype, in Appendix A order.
 *
 * `document`  — a numbered business record: list plus record page.
 * `list`      — rows to read, with no record lifecycle of its own.
 * `workspace` — an interactive working surface (reconciliation, matching,
 *               inquiry, monitoring).
 * `report`    — parameters over figures, drill-down, export.
 * `settings`  — configuration the module owner maintains.
 * `inbox`     — items addressed to me, acted on in place.
 * `dashboard` — a KPI strip over charts and panels.
 */
export const SCREENS: Readonly<Record<string, ScreenArchetype>> = {
  // 1 — Home
  my_dashboard: 'dashboard',
  my_tasks: 'inbox',
  my_approvals: 'inbox',
  notifications: 'inbox',
  recent_records: 'list',
  global_search: 'workspace',

  // 2 — CRM
  crm_dashboard: 'dashboard',
  logistics_dashboard: 'dashboard',
  money_transfer_dashboard: 'dashboard',
  leads: 'document',
  opportunities: 'document',
  activities: 'document',
  contacts: 'document',
  pipeline: 'workspace',
  crm_reports: 'report',
  crm_settings: 'settings',

  // 3 — Sales
  sales_dashboard: 'dashboard',
  customers: 'document',
  ar_statements: 'report',
  customer_price_lists: 'document',
  sales_orders: 'document',
  reservations: 'document',
  pick_lists: 'document',
  delivery_notes: 'document',
  ar_invoices: 'document',
  cash_sales: 'document',
  customer_receipts: 'document',
  credit_control: 'workspace',
  sales_returns: 'document',
  customer_credit_memos: 'document',
  warranty_inquiry: 'workspace',
  sales_reports: 'report',
  sales_settings: 'settings',

  // 4 — Payables (was Purchasing; REQ-AP-001 D7 — one module for all owed)
  payables_workbench: 'workspace',
  procurement_dashboard: 'dashboard',
  suppliers: 'document',
  ap_statements: 'report',
  purchase_orders: 'document',
  goods_receipts: 'document',
  service_receipts: 'document',
  recurring_contracts: 'document',
  ap_invoices: 'document',
  payment_applications: 'document',
  supplier_advances: 'document',
  supplier_payments: 'document',
  goods_returns: 'document',
  supplier_credit_memos: 'document',
  match_exceptions: 'workspace',
  pds: 'document',
  shipments: 'document',
  containers: 'list',
  loans: 'document',
  purchasing_reports: 'report',
  payables_settings: 'settings',
  payables_migration: 'settings',
  legacy_import: 'settings',
  hr_settings: 'settings',
  whatsapp: 'settings',
  project_settings: 'settings',

  // 5 — Inventory
  availability: 'workspace',
  opening_stock: 'document',
  stock_movements: 'document',
  stock_ledger: 'report',
  transfer_requests: 'document',
  in_transit: 'list',
  quarantine: 'workspace',
  inventory_returns: 'document',
  damaged_goods: 'document',
  serial_batch_tracking: 'workspace',
  uom: 'document',
  stock_reconciliation: 'workspace',
  fifo_valuation: 'report',
  inventory_reports: 'report',
  inventory_settings: 'settings',

  // 6 — Projects
  project_master: 'document',
  contracts: 'document',
  wbs: 'workspace',
  cost_plan: 'workspace',
  project_budgets: 'document',
  change_orders: 'document',
  project_costs: 'list',
  project_procurement: 'list',
  material_issues: 'document',
  progress: 'workspace',
  project_billing: 'document',
  project_forecast: 'report',
  project_close: 'workspace',
  project_reports: 'report',

  // 7 — Logistics
  client_import_files: 'document',
  logistics_jobs: 'document',
  routes: 'document',
  carriers: 'document',
  shipping_documents: 'document',
  client_charges: 'document',
  direct_costs: 'document',
  delivery_evidence: 'document',
  claims: 'document',
  settlement: 'workspace',
  logistics_margin_reports: 'report',

  // 8 — Money Transfer
  client_accounts: 'document',
  deposits: 'document',
  transfer_instructions: 'document',
  initiate_transfer: 'document',
  bank_execution_batches: 'document',
  transfer_fees: 'settings',
  returned_transfers: 'document',
  refunds: 'document',
  transfer_reconciliation: 'workspace',
  client_statements: 'report',
  transfer_margin_reports: 'report',

  // 9 — Investments
  investment_register: 'document',
  investment_transactions: 'document',
  investment_income: 'document',
  valuation: 'document',
  impairment: 'document',
  maturity: 'list',
  disposal: 'document',
  investment_reconciliation: 'workspace',
  investment_reports: 'report',

  // 10 — Finance · General Ledger
  journal_entry: 'document',
  recurring_journals: 'document',
  reversals: 'document',
  gl_inquiry: 'workspace',
  trial_balance: 'report',
  soft_close: 'workspace',
  year_end_close: 'workspace',
  posting_mappings: 'settings',
  income_statement: 'report',
  balance_sheet: 'report',
  changes_in_equity: 'report',
  cash_flow: 'report',

  // 11 — Finance · Receivables
  customer_ledger: 'report',
  ar_open_items: 'list',
  ar_receipts: 'document',
  ar_allocations: 'workspace',
  credit_limits: 'document',
  collections: 'workspace',
  ar_ageing: 'report',
  ar_reconciliation: 'workspace',

  // 12 — Finance · Payables
  supplier_ledger: 'report',
  ap_open_items: 'list',
  ap_advances: 'document',
  ap_payments: 'document',
  ap_allocations: 'workspace',
  ap_ageing: 'report',
  ap_reconciliation: 'workspace',

  // 13 — Treasury
  bank_cash_accounts: 'document',
  cash_accounts: 'document',
  treasury_receipts: 'document',
  treasury_payments: 'document',
  bank_transfers: 'document',
  bank_statements: 'document',
  bank_reconciliation: 'workspace',
  daily_position: 'report',
  cash_forecast: 'report',
  treasury_reports: 'report',

  // 14 — Fixed Assets
  asset_categories: 'document',
  fixed_asset_documents: 'document',
  asset_register: 'document',
  available_for_use: 'workspace',
  depreciation: 'workspace',
  asset_transfers: 'document',
  asset_impairment: 'document',
  asset_disposal: 'document',
  asset_verification: 'workspace',
  asset_reports: 'report',

  // 15 — Budgeting
  budget_versions: 'document',
  department_project_budgets: 'document',
  forecasts: 'document',
  budget_revisions: 'document',
  commitments: 'list',
  variance_reports: 'report',

  // 16 — HR & Payroll
  employees: 'document',
  organisation: 'workspace',
  attendance: 'workspace',
  leave: 'document',
  payroll: 'workspace',
  payslips: 'report',
  employee_advances: 'document',
  expense_claims: 'document',
  travel: 'document',
  asset_assignment: 'document',
  hr_reports: 'report',

  // 17 — Documents & Tasks
  document_centre: 'workspace',
  templates: 'document',
  checklists: 'document',
  expiring_documents: 'list',
  tasks: 'inbox',
  notes: 'list',
  retention: 'settings',
  executive_reports: 'report',
  financial_reports: 'report',
  sales_analytics: 'report',
  purchase_analytics: 'report',
  inventory_analytics: 'report',
  project_analytics: 'report',
  logistics_analytics: 'report',
  money_transfer_analytics: 'report',
  investment_analytics: 'report',
  hr_analytics: 'report',
  audit_analytics: 'report',
  scheduled_reports: 'document',

  // 19 — Master Data
  chart_of_accounts: 'document',
  // The Statement Mapping — by direction 2026-09-03: Finance owns the shape
  // of its reports, so the layout is a settings screen beside the chart.
  statement_mapping: 'settings',
  currencies_rates: 'document',
  branches: 'document',
  departments: 'document',
  cost_centres: 'document',
  items: 'document',
  supplier_item_codes: 'document',
  barcodes: 'document',
  price_lists: 'document',
  warehouses: 'document',
  banks: 'document',
  payment_terms: 'document',
  payment_methods: 'document',

  // 20 — Administration
  company: 'settings',
  users: 'document',
  department_manager_toggles: 'settings',
  roles: 'document',
  permissions: 'settings',
  numbering: 'settings',
  audit_trail: 'report',
  system_parameters: 'settings',
  background_jobs: 'workspace',
  backup_health: 'workspace',

  // 21 — Integrations & Support
  api_clients: 'document',
  imports: 'workspace',
  bank_import: 'workspace',
  interface_monitor: 'workspace',
  release_notes: 'list',
  data_quality: 'report',
  change_requests: 'document',
  uat_evidence: 'list',
  support_runbooks: 'list',
};

export function archetypeOf(key: string): ScreenArchetype | undefined {
  return SCREENS[key];
}

/** Menu keys the catalogue misses, or entries naming no menu key — both empty. */
export function catalogueGaps(): { missing: string[]; orphaned: string[] } {
  const menuKeys = new Set(allMenuItems().map((item) => item.key));
  return {
    missing: [...menuKeys].filter((key) => !(key in SCREENS)),
    orphaned: Object.keys(SCREENS).filter((key) => !menuKeys.has(key)),
  };
}

/**
 * The route a screen lives at.
 *
 * Two kinds of route, one address space. An item that already names an `href`
 * keeps it — that is where its module said the page belongs, and several of
 * those paths are already in the navigation. Everything else derives a route
 * from its position in Appendix A, `/{section}/{screen}`, so that **every**
 * entry in the approved tree is a real address rather than a dead menu item.
 *
 * Section keys and item keys are both unique — asserted in the unit tests —
 * so the derivation cannot collide.
 *
 * Deriving rather than storing matters: the route and the tree cannot drift
 * apart, and a module that later ships its own page changes one field.
 */
export function routeFor(item: MenuItem, sectionKey: string): string {
  if (item.href !== null) return item.href;
  return `/${sectionKey.replaceAll('_', '-')}/${item.key.replaceAll('_', '-')}`;
}

/**
 * The screens that read the database today — the one list the server trusts.
 *
 * A menu item's `href` records where a module *intends* to put its page, and
 * most name a path no module has written yet. That makes `href` the wrong
 * thing to badge a screen "live" with — the badge has to mean *these are your
 * figures*, and only these are. `visibleRoute` (src/server/delivered.ts)
 * reads this set, so a route that is not here is refused on the URL and
 * absent from every surface.
 *
 * A route joins this set on the day its page reads the real database, as the
 * company's requirements (docs/requirements/) are built out.
 */
const DELIVERED: ReadonlySet<string> = new Set([
  '/',
  '/master-data/chart-of-accounts',
  '/inventory/availability',
  '/documents',
  // Administration.
  '/administration/company',
  '/administration/users',
  '/administration/managers',
  '/administration/roles',
  '/administration/permissions',
  '/administration/numbering',
  '/administration/audit',
  '/master-data/branches',
  '/master-data/departments',
  '/approvals',
  // The accounting core.
  '/finance/journals',
  '/finance/reversals',
  '/finance/gl-inquiry',
  '/finance/trial-balance',
  '/finance/income-statement',
  // The accounting master data.
  '/master-data/cost-centres',
  '/master-data/statement-mapping',
  '/sales/customers',
  '/payables/suppliers',
  '/inventory/items',
  '/inventory/uom',
  '/master-data/bank-accounts',
  '/master-data/cash-accounts',
  '/master-data/payment-terms',
  '/master-data/payment-methods',
  '/finance/balance-sheet',
  '/finance/changes-in-equity',
  '/finance/cash-flow',
  '/finance/periods',
  '/master-data/exchange-rates',
  // The Warehouses Report and Warehouse Setup.
  '/inventory/fifo-valuation',
  '/master-data/warehouses',
  // Transfer, Opening Stock, Item Reconciliation, Stock Movement.
  '/inventory/transfers',
  '/inventory/opening-stock',
  '/inventory/stock-reconciliation',
  '/inventory/stock-movements',
  // The Stock Ledger — the movements with a running balance (2026-09-27).
  '/inventory/stock-ledger',
  // The Purchase Invoice.
  '/payables/invoices',
  // The Sales Invoice.
  '/sales/ar-invoices',
  // Sales Returns.
  '/sales/sales-returns',
  // Purchase Returns.
  '/payables/goods-returns',
  // Payments and Receipts.
  '/payables/supplier-payments',
  '/sales/customer-receipts',
  // Invoice Status Tracking.
  '/inventory/in-transit',
  // The Account Statement, one screen on each side.
  '/sales/customer-statements',
  '/payables/supplier-statements',
  // Where every document that cannot name its own account says which one.
  '/finance/posting-mappings',
  // Treasury and Banking reporting — the balance, and what it is made of.
  '/treasury/reporting',
  // §15 and §16 — open items and ageing, one screen on each side.
  '/sales/receivables',
  // REQ-AP-001 Stage 1 — the payables workbench, the payable page's list
  // route, and the module's settings.
  '/payables',
  '/administration/payables-settings',
  '/payables/open-items',
  // REQ-AP-001 Stage 2 — the standing commitments, the department's inbox,
  // and the two documents that finally earn their screens (§21.4-§21.6).
  '/payables/contracts',
  '/payables/service-receipts',
  '/payables/purchase-orders',
  '/payables/goods-receipts',
  // REQ-AP-001 Stage 3 — payments & bank (§15, §21.7): the applications, the
  // advances' own register, and the bank master.
  '/payables/payment-applications',
  '/payables/advances',
  '/master-data/banks',
  // REQ-AP-001 Stage 4 — PD / ASYCUDA (§16, §21.8).
  '/payables/pd',
  // REQ-AP-001 Stage 5 — B/Ls and containers (§17, §18, §21.9).
  '/payables/shipments',
  '/payables/containers',
  // REQ-AP-001 Stage 6 — bank loans (§15.7, §21.10).
  '/payables/loans',
  // REQ-AP-001 Stage 8 — the sheet import and its sign-off (§24.3).
  '/administration/payables-migration',
  // REQ-IMPROVE-001 Stage 1 — the two screens the menu promised (OP-4).
  '/administration/jobs',
  '/administration/backup-health',
  // REQ-LEGACY-001 — the old system's books, once.
  '/administration/legacy-import',
  // REQ-HR-001 Stage HR-1 — people and organisation.
  '/hr/employees',
  '/hr/organisation',
  '/administration/hr-settings',
  // REQ-WA-001 WA-1/WA-2 — the WhatsApp bridge.
  '/administration/whatsapp',
  // REQ-PM-001 PM-1 — the Project System's structure.
  '/projects',
  '/projects/contracts',
  '/projects/wbs',
  '/projects/plan',
  '/projects/budgets',
  '/projects/change-orders',
  '/projects/costs',
  '/projects/procurement',
  '/projects/progress',
  '/projects/material-issues',
  '/administration/project-settings',
]);

export function isDelivered(route: string): boolean {
  return DELIVERED.has(route);
}

export interface ScreenRoute {
  readonly item: MenuItem;
  readonly section: MenuSection;
  readonly archetype: ScreenArchetype;
  readonly route: string;
  /** False while the screen is drawn but not yet reading real data. */
  readonly wired: boolean;
}

/**
 * Route → screen, for the renderer that serves them.
 *
 * Built once from the tree, so adding a menu item adds its screen and no route
 * file has to be written by hand.
 */
export function screenRoutes(): ReadonlyMap<string, ScreenRoute> {
  const routes = new Map<string, ScreenRoute>();
  for (const section of MENU) {
    for (const item of section.items) {
      const archetype = SCREENS[item.key];
      if (!archetype) continue; // catalogueGaps() reports this; callers stay total.
      const route = routeFor(item, section.key);
      // Five routes are reached from two places in the tree (Business Partners,
      // UoM and Exchange Rates sit in a module menu and in Master Data; two
      // more share an Administration path). One address renders one screen, so
      // the first placement in Appendix A order serves it. Overwriting instead
      // would silently drop the earlier menu item.
      if (routes.has(route)) continue;
      routes.set(route, { item, section, archetype, route, wired: isDelivered(route) });
    }
  }
  return routes;
}
