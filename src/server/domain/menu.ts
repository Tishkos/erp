/**
 * The approved navigation tree — Appendix A.
 *
 * Appendix A: *"The following navigation tree is mandatory at functional level.
 * Screen grouping can be refined for usability without removing required
 * functions or changing permissions, statuses or posting behaviour."*
 *
 * So the tree is data, not markup. It lives here, in the pure layer, because
 * three separate things need the same answer: the sidebar, the global search's
 * "where do I go" index, and the coverage test that proves no required
 * function was dropped. A tree assembled from JSX could not be asserted
 * against.
 *
 * Every item names the permission that reveals it. That is presentation only —
 * §25 is explicit: *"Navigation hiding alone is not access control."* The
 * server-side check in `permissions.ts` is the control; hiding an item the user
 * cannot use is courtesy, and removing this file would weaken nothing.
 *
 * Menus 6–21 include pages whose modules arrive later. They are listed now,
 * so the tree is complete against Appendix A from the start and a module's
 * arrival is a route being filled in rather than a menu being renegotiated.
 * Which of them actually exist today is the screen catalogue's record
 * (`screens.ts`), not this file's.
 *
 * ── One screen, one home (by direction, 2026-08-31) ────────────────────────
 * No route appears under two headings. Appendix A listed several twice — the
 * partners under CRM *and* Master Data, units of measure under Inventory *and*
 * Master Data, the audit trail under Documents *and* Administration — which
 * reads as two different screens until you open both and find the same page.
 *
 * Each now sits under the heading whose work it belongs to: Customers under
 * Sales, Suppliers under Purchasing, Items and Units of Measure under
 * Inventory, Bank and Cash Accounts under Treasury. Master Data keeps the
 * reference data no single module owns — the chart, currencies, branches,
 * departments, cost centres and the payment terms and methods every module
 * quotes. Appendix A permits exactly this: grouping refined for usability
 * without removing a required function.
 */
import { can, type Principal, type PermissionVerb } from './permissions';

export interface MenuItem {
  /** Stable identifier — also the message-catalogue key (§25). */
  readonly key: string;
  /** The permission object this page belongs to (§5.3). */
  readonly object: string;
  /** The verb needed to see it at all. Almost always 'view'. */
  readonly verb?: PermissionVerb;
  /** Route, once the module exists. Null means the page is not built yet. */
  readonly href: string | null;
}

export interface MenuSection {
  readonly key: string;
  /** Appendix A's own numbering, kept so the tree can be diffed against it. */
  readonly ordinal: number;
  readonly items: readonly MenuItem[];
}

/** Shorthand: most pages are `view` on an object named after the page. */
const page = (key: string, object: string, href: string | null = null): MenuItem => ({
  key,
  object,
  href,
});

/**
 * Appendix A, verbatim in content and order.
 *
 * Names are the message keys, not the labels — labels live in the catalogue so
 * Arabic is a translation rather than a redesign (§25).
 */
export const MENU: readonly MenuSection[] = Object.freeze([
  {
    key: 'home',
    ordinal: 1,
    items: [
      page('my_dashboard', 'dashboard', '/'),
      page('my_tasks', 'task', '/tasks'),
      page('my_approvals', 'workflow_instance', '/approvals'),
      page('notifications', 'notification', '/notifications'),
      page('recent_records', 'dashboard', '/recent'),
      page('global_search', 'dashboard', '/search'),
    ],
  },
  {
    key: 'crm',
    ordinal: 2,
    items: [
      page('crm_dashboard', 'crm_dashboard'),
      page('leads', 'lead'),
      page('opportunities', 'opportunity'),
      page('activities', 'crm_activity'),
      page('contacts', 'contact'),
      page('pipeline', 'opportunity'),
      page('crm_reports', 'crm_report'),
      page('crm_settings', 'crm_settings'),
    ],
  },
  {
    key: 'sales',
    ordinal: 3,
    items: [
      page('sales_dashboard', 'sales_dashboard'),
      page('customers', 'business_partner', '/sales/customers'),
      // A customer's account statement, beside the customer whose account it
      // is. Appendix A filed it under Receivables; the sponsor asked for it
      // here (2026-09-23), which is the same refinement that moved Customers
      // out of Master Data — the screen sits under the heading whose work it
      // belongs to, and still only once. It grants over `business_partner`
      // because that is the record it reads and the object the page
      // authorises on; an object nobody can hold would hide the screen from
      // everyone but a Super User.
      page('ar_statements', 'business_partner', '/sales/customer-statements'),
      page('customer_price_lists', 'price_list'),
      page('sales_orders', 'sales_order'),
      page('reservations', 'stock_reservation'),
      page('pick_lists', 'pick_list'),
      page('delivery_notes', 'delivery_note'),
      page('ar_invoices', 'ar_invoice'),
      // Beside the invoices it ages. Appendix A filed it under Receivables; it
      // sits here for the reason the Account Statement does — the screen
      // belongs under the heading whose work it is (2026-09-30).
      page('ar_open_items', 'ar_invoice', '/sales/receivables'),
      page('cash_sales', 'cash_sale'),
      page('customer_receipts', 'customer_receipt'),
      page('credit_control', 'credit_control'),
      page('sales_returns', 'sales_return'),
      page('customer_credit_memos', 'customer_credit_memo'),
      page('warranty_inquiry', 'warranty'),
      page('sales_reports', 'sales_report'),
      page('sales_settings', 'sales_settings'),
    ],
  },
  {
    key: 'purchasing',
    ordinal: 4,
    items: [
      page('procurement_dashboard', 'procurement_dashboard'),
      page('suppliers', 'business_partner', '/purchasing/suppliers'),
      // The supplier's side of the same mirror. See the note under Sales.
      page('ap_statements', 'business_partner', '/purchasing/supplier-statements'),
      page('purchase_orders', 'purchase_order'),
      page('goods_receipts', 'goods_receipt'),
      page('service_receipts', 'service_receipt'),
      page('ap_invoices', 'ap_invoice'),
      // The supplier's side of the same mirror.
      page('ap_open_items', 'ap_invoice', '/purchasing/payables'),
      page('supplier_advances', 'supplier_advance'),
      page('supplier_payments', 'supplier_payment'),
      page('goods_returns', 'goods_return'),
      page('supplier_credit_memos', 'supplier_credit_memo'),
      page('match_exceptions', 'match_exception'),
      page('purchasing_reports', 'purchasing_report'),
      page('purchasing_settings', 'purchasing_settings'),
    ],
  },
  {
    key: 'inventory',
    ordinal: 5,
    items: [
      page('availability', 'inventory_movement', '/inventory/availability'),
      page('opening_stock', 'opening_stock', '/inventory/opening-stock'),
      page('stock_movements', 'stock_movement', '/inventory/stock-movements'),
      page('stock_ledger', 'stock_movement', '/inventory/stock-ledger'),
      page('transfer_requests', 'warehouse_transfer', '/inventory/transfers'),
      page('in_transit', 'in_transit'),
      page('quarantine', 'quarantine'),
      page('inventory_returns', 'inventory_return'),
      page('damaged_goods', 'damage_report'),
      page('serial_batch_tracking', 'serial_batch'),
      page('items', 'item', '/inventory/items'),
      page('uom', 'uom', '/inventory/uom'),
      page('stock_reconciliation', 'stock_reconciliation', '/inventory/stock-reconciliation'),
      page('fifo_valuation', 'fifo_valuation'),
      page('inventory_reports', 'inventory_report'),
      page('inventory_settings', 'inventory_settings'),
    ],
  },
  {
    key: 'projects',
    ordinal: 6,
    items: [
      page('project_master', 'project'),
      page('contracts', 'contract'),
      page('wbs', 'wbs'),
      page('project_budgets', 'project_budget'),
      page('change_orders', 'change_order'),
      page('project_costs', 'project_cost'),
      page('project_procurement', 'project_procurement'),
      page('material_issues', 'material_issue'),
      page('progress', 'project_progress'),
      page('project_billing', 'project_billing'),
      page('project_forecast', 'project_forecast'),
      page('project_close', 'project_close'),
      page('project_reports', 'project_report'),
    ],
  },
  {
    key: 'logistics',
    ordinal: 7,
    items: [
      page('logistics_dashboard', 'logistics_dashboard'),
      page('client_import_files', 'client_import_file'),
      page('logistics_jobs', 'logistics_job'),
      page('routes', 'route'),
      page('carriers', 'carrier'),
      page('shipping_documents', 'shipping_document'),
      page('client_charges', 'client_charge'),
      page('direct_costs', 'logistics_direct_cost'),
      page('delivery_evidence', 'delivery_evidence'),
      page('claims', 'logistics_claim'),
      page('settlement', 'logistics_settlement'),
      page('logistics_margin_reports', 'logistics_margin_report'),
    ],
  },
  {
    key: 'money_transfer',
    ordinal: 8,
    items: [
      page('money_transfer_dashboard', 'money_transfer_dashboard'),
      page('client_accounts', 'client_account'),
      page('deposits', 'client_deposit'),
      page('transfer_instructions', 'transfer_instruction'),
      page('initiate_transfer', 'money_transfer'),
      page('bank_execution_batches', 'bank_execution_batch'),
      page('transfer_fees', 'transfer_fee'),
      page('returned_transfers', 'returned_transfer'),
      page('refunds', 'transfer_refund'),
      page('transfer_reconciliation', 'transfer_reconciliation'),
      page('client_statements', 'client_statement'),
      page('transfer_margin_reports', 'transfer_margin_report'),
    ],
  },
  {
    key: 'investments',
    ordinal: 9,
    items: [
      page('investment_register', 'investment'),
      page('investment_transactions', 'investment_transaction'),
      page('investment_income', 'investment_income'),
      page('valuation', 'investment_valuation'),
      page('impairment', 'investment_impairment'),
      page('maturity', 'investment_maturity'),
      page('disposal', 'investment_disposal'),
      page('investment_reconciliation', 'investment_reconciliation'),
      page('investment_reports', 'investment_report'),
    ],
  },
  {
    key: 'finance_gl',
    ordinal: 10,
    items: [
      page('journal_entry', 'journal_entry', '/finance/journals'),
      page('recurring_journals', 'recurring_journal'),
      page('reversals', 'journal_reversal', '/finance/reversals'),
      page('gl_inquiry', 'gl_inquiry', '/finance/gl-inquiry'),
      page('trial_balance', 'trial_balance', '/finance/trial-balance'),
      page('soft_close', 'accounting_period', '/finance/periods'),
      page('year_end_close', 'year_end_close'),
      // `posting_rule` is the object the grants are written against and the
      // one the service authorises on. The tree used to name a second object
      // nobody could hold, so the screen was invisible to everyone but a
      // Super User — including the Accounting Manager whose role may
      // configure it.
      page('posting_mappings', 'posting_rule', '/finance/posting-mappings'),
      // Each statement is its own screen (by direction, 2026-08-29, extended
      // 2026-08-31 to all four): one report to a window, so a reader is never
      // shown two answers to one question.
      page('income_statement', 'financial_statement', '/finance/income-statement'),
      page('balance_sheet', 'financial_statement', '/finance/balance-sheet'),
      page('changes_in_equity', 'financial_statement', '/finance/changes-in-equity'),
      page('cash_flow', 'financial_statement', '/finance/cash-flow'),
    ],
  },
  {
    key: 'finance_ar',
    ordinal: 11,
    items: [
      page('customer_ledger', 'customer_ledger'),
      page('ar_receipts', 'customer_receipt'),
      page('ar_allocations', 'ar_allocation'),
      page('credit_limits', 'credit_limit'),
      page('collections', 'collection'),
      page('ar_ageing', 'ar_ageing'),
      page('ar_reconciliation', 'ar_reconciliation'),
    ],
  },
  {
    key: 'finance_ap',
    ordinal: 12,
    items: [
      page('supplier_ledger', 'supplier_ledger'),
      page('ap_advances', 'supplier_advance'),
      page('ap_payments', 'supplier_payment'),
      page('ap_allocations', 'ap_allocation'),
      page('ap_ageing', 'ap_ageing'),
      page('ap_reconciliation', 'ap_reconciliation'),
    ],
  },
  {
    key: 'treasury',
    ordinal: 13,
    items: [
      page('bank_cash_accounts', 'bank_account', '/master-data/bank-accounts'),
      page('cash_accounts', 'bank_account', '/master-data/cash-accounts'),
      page('treasury_receipts', 'treasury_receipt'),
      page('treasury_payments', 'treasury_payment'),
      page('bank_transfers', 'bank_transfer'),
      page('bank_statements', 'bank_statement'),
      page('bank_reconciliation', 'bank_reconciliation'),
      page('daily_position', 'daily_position'),
      page('cash_forecast', 'cash_forecast'),
      // Bank and Cash Reporting — every account's balance and what it is
      // made of, beside the accounts themselves (2026-09-29).
      page('treasury_reports', 'bank_account', '/treasury/reporting'),
    ],
  },
  {
    key: 'fixed_assets',
    ordinal: 14,
    items: [
      page('asset_categories', 'asset_category'),
      page('fixed_asset_documents', 'fixed_asset_document'),
      page('asset_register', 'fixed_asset'),
      page('available_for_use', 'asset_available_for_use'),
      page('depreciation', 'depreciation'),
      page('asset_transfers', 'asset_transfer'),
      page('asset_impairment', 'asset_impairment'),
      page('asset_disposal', 'asset_disposal'),
      page('asset_verification', 'asset_verification'),
      page('asset_reports', 'asset_report'),
    ],
  },
  {
    key: 'budgeting',
    ordinal: 15,
    items: [
      page('budget_versions', 'budget_version'),
      page('department_project_budgets', 'budget'),
      page('forecasts', 'forecast'),
      page('budget_revisions', 'budget_revision'),
      page('commitments', 'commitment'),
      page('variance_reports', 'variance_report'),
    ],
  },
  {
    key: 'hr_payroll',
    ordinal: 16,
    items: [
      page('employees', 'employee'),
      page('organisation', 'org_structure'),
      page('attendance', 'attendance'),
      page('leave', 'leave_request'),
      page('payroll', 'payroll_run'),
      page('payslips', 'payslip'),
      page('employee_advances', 'employee_advance'),
      page('expense_claims', 'expense_claim'),
      page('travel', 'travel_request'),
      page('asset_assignment', 'asset_assignment'),
      page('hr_reports', 'hr_report'),
    ],
  },
  {
    key: 'documents',
    ordinal: 17,
    items: [
      page('document_centre', 'attachment', '/documents'),
      page('templates', 'document_template'),
      page('checklists', 'checklist'),
      page('expiring_documents', 'expiring_document'),
      page('tasks', 'task'),
      page('notes', 'note'),
      page('retention', 'retention_policy'),
    ],
  },
  {
    key: 'reports',
    ordinal: 18,
    items: [
      page('executive_reports', 'executive_report'),
      page('financial_reports', 'financial_report'),
      page('sales_analytics', 'sales_report'),
      page('purchase_analytics', 'purchasing_report'),
      page('inventory_analytics', 'inventory_report'),
      page('project_analytics', 'project_report'),
      page('logistics_analytics', 'logistics_margin_report'),
      page('money_transfer_analytics', 'transfer_margin_report'),
      page('investment_analytics', 'investment_report'),
      page('hr_analytics', 'hr_report'),
      page('audit_analytics', 'audit_event'),
      page('scheduled_reports', 'scheduled_report'),
    ],
  },
  {
    key: 'master_data',
    ordinal: 19,
    items: [
      page('chart_of_accounts', 'chart_of_account', '/master-data/chart-of-accounts'),
      page('statement_mapping', 'financial_statement', '/master-data/statement-mapping'),
      page('currencies_rates', 'exchange_rate', '/master-data/exchange-rates'),
      page('branches', 'branch', '/master-data/branches'),
      page('departments', 'department', '/master-data/departments'),
      page('cost_centres', 'cost_centre', '/master-data/cost-centres'),
      page('supplier_item_codes', 'supplier_item_code'),
      page('barcodes', 'barcode'),
      page('price_lists', 'price_list'),
      page('warehouses', 'warehouse', '/master-data/warehouses'),
      page('banks', 'bank', '/master-data/banks'),
      page('payment_terms', 'payment_term', '/master-data/payment-terms'),
      page('payment_methods', 'payment_method', '/master-data/payment-methods'),
    ],
  },
  {
    key: 'administration',
    ordinal: 20,
    items: [
      page('company', 'company', '/administration/company'),
      page('users', 'app_user', '/administration/users'),
      page('department_manager_toggles', 'user_department_scope', '/administration/managers'),
      page('roles', 'role', '/administration/roles'),
      page('permissions', 'permission', '/administration/permissions'),
      page('numbering', 'number_series', '/administration/numbering'),
      page('audit_trail', 'audit_event', '/administration/audit'),
      page('system_parameters', 'system_parameter', '/administration/parameters'),
      page('background_jobs', 'job', '/administration/jobs'),
      page('backup_health', 'system_health'),
    ],
  },
  {
    key: 'integrations',
    ordinal: 21,
    items: [
      page('api_clients', 'api_client'),
      page('imports', 'import_batch', '/integrations/imports'),
      page('bank_import', 'bank_import'),
      page('interface_monitor', 'interface_monitor'),
      page('release_notes', 'release_note'),
      page('data_quality', 'data_quality'),
      page('change_requests', 'change_request'),
      page('uat_evidence', 'uat_evidence'),
      page('support_runbooks', 'support_runbook'),
    ],
  },
]);

/** Every item in the tree, flattened — for search and for coverage tests. */
export function allMenuItems(): readonly MenuItem[] {
  return MENU.flatMap((section) => section.items);
}

export function findMenuItem(key: string): MenuItem | undefined {
  return allMenuItems().find((item) => item.key === key);
}

/**
 * The tree this principal should be shown.
 *
 * A section with nothing visible in it is dropped rather than rendered empty —
 * an empty menu heading advertises a module the user cannot open, which reads
 * as a fault rather than as a permission boundary.
 */
export function visibleMenu(principal: Principal): readonly MenuSection[] {
  return MENU.map((section) => ({
    ...section,
    items: section.items.filter((item) => can(principal, item.verb ?? 'view', item.object)),
  })).filter((section) => section.items.length > 0);
}

/** Objects named by the tree — the permission catalogue's presentation surface. */
export function menuObjects(): readonly string[] {
  return [...new Set(allMenuItems().map((item) => item.object))].sort();
}
