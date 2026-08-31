/**
 * The approved navigation tree — Phase 01.12, Appendix A.
 *
 * Appendix A: *"The following navigation tree is mandatory at functional level.
 * Screen grouping can be refined for usability without removing required
 * functions or changing permissions, statuses or posting behaviour."*
 *
 * So the tree is data, not markup. It lives here, in the pure layer, because
 * three separate things need the same answer: the sidebar, the global search's
 * "where do I go" index, and the Phase 20 test that proves no required function
 * was dropped. A tree assembled from JSX could not be asserted against.
 *
 * Every item names the permission that reveals it. That is presentation only —
 * §25 is explicit: *"Navigation hiding alone is not access control."* The
 * server-side check in `permissions.ts` is the control; hiding an item the user
 * cannot use is courtesy, and removing this file would weaken nothing.
 *
 * Menus 6–21 include pages whose modules arrive in later phases. They are
 * listed now, with `phase`, so the tree is complete against Appendix A from the
 * start and a module's arrival is a route being filled in rather than a menu
 * being renegotiated.
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
  /** The phase that delivers it — for the roadmap, and for honest empty states. */
  readonly phase: string;
}

export interface MenuSection {
  readonly key: string;
  /** Appendix A's own numbering, kept so the tree can be diffed against it. */
  readonly ordinal: number;
  readonly items: readonly MenuItem[];
}

/** Shorthand: most pages are `view` on an object named after the page. */
const page = (key: string, object: string, phase: string, href: string | null = null): MenuItem => ({
  key,
  object,
  href,
  phase,
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
      page('my_dashboard', 'dashboard', '01.12', '/'),
      page('my_tasks', 'task', '01.12', '/tasks'),
      page('my_approvals', 'workflow_instance', '01.12', '/approvals'),
      page('notifications', 'notification', '01.9', '/notifications'),
      page('recent_records', 'dashboard', '01.12', '/recent'),
      page('global_search', 'dashboard', '01.12', '/search'),
    ],
  },
  {
    key: 'crm',
    ordinal: 2,
    items: [
      page('crm_dashboard', 'crm_dashboard', '08'),
      page('leads', 'lead', '08'),
      page('opportunities', 'opportunity', '08'),
      page('activities', 'crm_activity', '08'),
      page('contacts', 'contact', '08'),
      page('business_partners', 'business_partner', '03', '/master-data/business-partners'),
      page('pipeline', 'opportunity', '08'),
      page('crm_reports', 'crm_report', '08'),
      page('crm_settings', 'crm_settings', '08'),
    ],
  },
  {
    key: 'sales',
    ordinal: 3,
    items: [
      page('sales_dashboard', 'sales_dashboard', '06'),
      page('customers', 'business_partner', '02', '/master-data/customers'),
      page('customer_price_lists', 'price_list', '03'),
      page('sales_orders', 'sales_order', '06'),
      page('reservations', 'stock_reservation', '06'),
      page('pick_lists', 'pick_list', '06'),
      page('delivery_notes', 'delivery_note', '06'),
      page('ar_invoices', 'ar_invoice', '06'),
      page('cash_sales', 'cash_sale', '06'),
      page('customer_receipts', 'customer_receipt', '06'),
      page('credit_control', 'credit_control', '06'),
      page('sales_returns', 'sales_return', '06'),
      page('customer_credit_memos', 'customer_credit_memo', '06'),
      page('warranty_inquiry', 'warranty', '06'),
      page('sales_reports', 'sales_report', '06'),
      page('sales_settings', 'sales_settings', '06'),
    ],
  },
  {
    key: 'purchasing',
    ordinal: 4,
    items: [
      page('procurement_dashboard', 'procurement_dashboard', '05'),
      page('suppliers', 'business_partner', '02', '/master-data/suppliers'),
      page('purchase_orders', 'purchase_order', '05'),
      page('goods_receipts', 'goods_receipt', '05'),
      page('service_receipts', 'service_receipt', '05'),
      page('ap_invoices', 'ap_invoice', '05'),
      page('supplier_advances', 'supplier_advance', '05'),
      page('supplier_payments', 'supplier_payment', '05'),
      page('goods_returns', 'goods_return', '05'),
      page('supplier_credit_memos', 'supplier_credit_memo', '05'),
      page('match_exceptions', 'match_exception', '05'),
      page('purchasing_reports', 'purchasing_report', '05'),
      page('purchasing_settings', 'purchasing_settings', '05'),
    ],
  },
  {
    key: 'inventory',
    ordinal: 5,
    items: [
      page('availability', 'inventory_movement', '04', '/inventory/availability'),
      page('opening_stock', 'opening_stock', '04'),
      page('stock_movements', 'stock_movement', '04'),
      page('transfer_requests', 'warehouse_transfer', '04'),
      page('in_transit', 'in_transit', '04'),
      page('quarantine', 'quarantine', '04'),
      page('inventory_returns', 'inventory_return', '04'),
      page('damaged_goods', 'damage_report', '04'),
      page('serial_batch_tracking', 'serial_batch', '04'),
      page('uom', 'uom', '03', '/master-data/uom'),
      page('stock_reconciliation', 'stock_reconciliation', '04'),
      page('fifo_valuation', 'fifo_valuation', '04'),
      page('inventory_reports', 'inventory_report', '04'),
      page('inventory_settings', 'inventory_settings', '04'),
    ],
  },
  {
    key: 'projects',
    ordinal: 6,
    items: [
      page('project_master', 'project', '11'),
      page('contracts', 'contract', '11'),
      page('wbs', 'wbs', '11'),
      page('project_budgets', 'project_budget', '11'),
      page('change_orders', 'change_order', '11'),
      page('project_costs', 'project_cost', '11'),
      page('project_procurement', 'project_procurement', '11'),
      page('material_issues', 'material_issue', '11'),
      page('progress', 'project_progress', '11'),
      page('project_billing', 'project_billing', '11'),
      page('project_forecast', 'project_forecast', '11'),
      page('project_close', 'project_close', '11'),
      page('project_reports', 'project_report', '11'),
    ],
  },
  {
    key: 'logistics',
    ordinal: 7,
    items: [
      page('logistics_dashboard', 'logistics_dashboard', '10'),
      page('client_import_files', 'client_import_file', '10'),
      page('logistics_jobs', 'logistics_job', '10'),
      page('routes', 'route', '10'),
      page('carriers', 'carrier', '10'),
      page('shipping_documents', 'shipping_document', '10'),
      page('client_charges', 'client_charge', '10'),
      page('direct_costs', 'logistics_direct_cost', '10'),
      page('delivery_evidence', 'delivery_evidence', '10'),
      page('claims', 'logistics_claim', '10'),
      page('settlement', 'logistics_settlement', '10'),
      page('logistics_margin_reports', 'logistics_margin_report', '10'),
    ],
  },
  {
    key: 'money_transfer',
    ordinal: 8,
    items: [
      page('money_transfer_dashboard', 'money_transfer_dashboard', '09'),
      page('client_accounts', 'client_account', '09'),
      page('deposits', 'client_deposit', '09'),
      page('transfer_instructions', 'transfer_instruction', '09'),
      page('initiate_transfer', 'money_transfer', '09'),
      page('bank_execution_batches', 'bank_execution_batch', '09'),
      page('transfer_fees', 'transfer_fee', '09'),
      page('returned_transfers', 'returned_transfer', '09'),
      page('refunds', 'transfer_refund', '09'),
      page('transfer_reconciliation', 'transfer_reconciliation', '09'),
      page('client_statements', 'client_statement', '09'),
      page('transfer_margin_reports', 'transfer_margin_report', '09'),
    ],
  },
  {
    key: 'investments',
    ordinal: 9,
    items: [
      page('investment_register', 'investment', '13'),
      page('investment_transactions', 'investment_transaction', '13'),
      page('investment_income', 'investment_income', '13'),
      page('valuation', 'investment_valuation', '13'),
      page('impairment', 'investment_impairment', '13'),
      page('maturity', 'investment_maturity', '13'),
      page('disposal', 'investment_disposal', '13'),
      page('investment_reconciliation', 'investment_reconciliation', '13'),
      page('investment_reports', 'investment_report', '13'),
    ],
  },
  {
    key: 'finance_gl',
    ordinal: 10,
    items: [
      page('journal_entry', 'journal_entry', '02', '/finance/journals'),
      page('recurring_journals', 'recurring_journal', '16'),
      page('reversals', 'journal_reversal', '02', '/finance/reversals'),
      page('gl_inquiry', 'gl_inquiry', '02', '/finance/gl-inquiry'),
      page('trial_balance', 'trial_balance', '02', '/finance/trial-balance'),
      page('soft_close', 'accounting_period', '02', '/finance/periods'),
      page('year_end_close', 'year_end_close', '16'),
      page('posting_mappings', 'posting_mapping', '02', '/finance/posting-mappings'),
      // Each statement is its own screen (by direction, 2026-08-29, extended
      // 2026-08-31 to all four): one report to a window, so a reader is never
      // shown two answers to one question.
      page('income_statement', 'financial_statement', '02', '/finance/income-statement'),
      page('balance_sheet', 'financial_statement', '02', '/finance/balance-sheet'),
      page('changes_in_equity', 'financial_statement', '02', '/finance/changes-in-equity'),
      page('cash_flow', 'financial_statement', '02', '/finance/cash-flow'),
    ],
  },
  {
    key: 'finance_ar',
    ordinal: 11,
    items: [
      page('customer_ledger', 'customer_ledger', '06'),
      page('ar_open_items', 'ar_open_item', '06'),
      page('ar_receipts', 'customer_receipt', '06'),
      page('ar_allocations', 'ar_allocation', '06'),
      page('credit_limits', 'credit_limit', '06'),
      page('collections', 'collection', '06'),
      page('ar_statements', 'ar_statement', '06'),
      page('ar_ageing', 'ar_ageing', '06'),
      page('ar_reconciliation', 'ar_reconciliation', '06'),
    ],
  },
  {
    key: 'finance_ap',
    ordinal: 12,
    items: [
      page('supplier_ledger', 'supplier_ledger', '05'),
      page('ap_open_items', 'ap_open_item', '05'),
      page('ap_advances', 'supplier_advance', '05'),
      page('ap_payments', 'supplier_payment', '05'),
      page('ap_allocations', 'ap_allocation', '05'),
      page('ap_statements', 'ap_statement', '05'),
      page('ap_ageing', 'ap_ageing', '05'),
      page('ap_reconciliation', 'ap_reconciliation', '05'),
    ],
  },
  {
    key: 'treasury',
    ordinal: 13,
    items: [
      page('bank_cash_accounts', 'bank_account', '02', '/master-data/bank-accounts'),
      page('cash_accounts', 'bank_account', '02', '/master-data/cash-accounts'),
      page('treasury_receipts', 'treasury_receipt', '07'),
      page('treasury_payments', 'treasury_payment', '07'),
      page('bank_transfers', 'bank_transfer', '07'),
      page('bank_statements', 'bank_statement', '07'),
      page('bank_reconciliation', 'bank_reconciliation', '07'),
      page('daily_position', 'daily_position', '07'),
      page('cash_forecast', 'cash_forecast', '07'),
      page('treasury_reports', 'treasury_report', '07'),
    ],
  },
  {
    key: 'fixed_assets',
    ordinal: 14,
    items: [
      page('asset_categories', 'asset_category', '12'),
      page('fixed_asset_documents', 'fixed_asset_document', '12'),
      page('asset_register', 'fixed_asset', '12'),
      page('available_for_use', 'asset_available_for_use', '12'),
      page('depreciation', 'depreciation', '12'),
      page('asset_transfers', 'asset_transfer', '12'),
      page('asset_impairment', 'asset_impairment', '12'),
      page('asset_disposal', 'asset_disposal', '12'),
      page('asset_verification', 'asset_verification', '12'),
      page('asset_reports', 'asset_report', '12'),
    ],
  },
  {
    key: 'budgeting',
    ordinal: 15,
    items: [
      page('budget_versions', 'budget_version', '14'),
      page('department_project_budgets', 'budget', '14'),
      page('forecasts', 'forecast', '14'),
      page('budget_revisions', 'budget_revision', '14'),
      page('commitments', 'commitment', '14'),
      page('variance_reports', 'variance_report', '14'),
    ],
  },
  {
    key: 'hr_payroll',
    ordinal: 16,
    items: [
      page('employees', 'employee', '15'),
      page('organisation', 'org_structure', '15'),
      page('attendance', 'attendance', '15'),
      page('leave', 'leave_request', '15'),
      page('payroll', 'payroll_run', '15'),
      page('payslips', 'payslip', '15'),
      page('employee_advances', 'employee_advance', '15'),
      page('expense_claims', 'expense_claim', '15'),
      page('travel', 'travel_request', '15'),
      page('asset_assignment', 'asset_assignment', '15'),
      page('hr_reports', 'hr_report', '15'),
    ],
  },
  {
    key: 'documents',
    ordinal: 17,
    items: [
      page('document_centre', 'attachment', '01.8', '/documents'),
      page('templates', 'document_template', '17'),
      page('checklists', 'checklist', '17'),
      page('expiring_documents', 'expiring_document', '17'),
      page('tasks', 'task', '17'),
      page('notes', 'note', '17'),
      page('retention', 'retention_policy', '17'),
      page('document_audit', 'audit_event', '01.4', '/administration/audit'),
    ],
  },
  {
    key: 'reports',
    ordinal: 18,
    items: [
      page('executive_reports', 'executive_report', '18'),
      page('financial_reports', 'financial_report', '18'),
      page('sales_analytics', 'sales_report', '18'),
      page('purchase_analytics', 'purchasing_report', '18'),
      page('inventory_analytics', 'inventory_report', '18'),
      page('project_analytics', 'project_report', '18'),
      page('logistics_analytics', 'logistics_margin_report', '18'),
      page('money_transfer_analytics', 'transfer_margin_report', '18'),
      page('investment_analytics', 'investment_report', '18'),
      page('hr_analytics', 'hr_report', '18'),
      page('audit_analytics', 'audit_event', '18'),
      page('scheduled_reports', 'scheduled_report', '18'),
    ],
  },
  {
    key: 'master_data',
    ordinal: 19,
    items: [
      page('chart_of_accounts', 'chart_of_account', '02', '/master-data/chart-of-accounts'),
      page('currencies_rates', 'exchange_rate', '02', '/master-data/exchange-rates'),
      page('branches', 'branch', '01', '/master-data/branches'),
      page('departments', 'department', '01', '/master-data/departments'),
      page('cost_centres', 'cost_centre', '02', '/master-data/cost-centres'),
      page('md_business_partners', 'business_partner', '02', '/master-data/business-partners'),
      page('items', 'item', '02', '/master-data/items'),
      page('supplier_item_codes', 'supplier_item_code', '03'),
      page('barcodes', 'barcode', '03'),
      page('md_uom', 'uom', '02', '/master-data/uom'),
      page('price_lists', 'price_list', '03'),
      page('warehouses', 'warehouse', '03', '/master-data/warehouses'),
      page('banks', 'bank', '03', '/master-data/banks'),
      page('payment_terms', 'payment_term', '02', '/master-data/payment-terms'),
      page('payment_methods', 'payment_method', '02', '/master-data/payment-methods'),
    ],
  },
  {
    key: 'administration',
    ordinal: 20,
    items: [
      page('company', 'company', '01', '/administration/company'),
      page('users', 'app_user', '01', '/administration/users'),
      page('department_manager_toggles', 'user_department_scope', '01', '/administration/managers'),
      page('roles', 'role', '01', '/administration/roles'),
      page('permissions', 'permission', '01', '/administration/permissions'),
      page('numbering', 'number_series', '01', '/administration/numbering'),
      page('audit_trail', 'audit_event', '01', '/administration/audit'),
      page('system_parameters', 'system_parameter', '01', '/administration/parameters'),
      page('background_jobs', 'job', '01', '/administration/jobs'),
      page('backup_health', 'system_health', '20'),
    ],
  },
  {
    key: 'integrations',
    ordinal: 21,
    items: [
      page('api_clients', 'api_client', '19'),
      page('imports', 'import_batch', '01', '/integrations/imports'),
      page('bank_import', 'bank_import', '07'),
      page('interface_monitor', 'interface_monitor', '19'),
      page('error_queue', 'job', '01', '/administration/jobs'),
      page('release_notes', 'release_note', '19'),
      page('data_quality', 'data_quality', '19'),
      page('change_requests', 'change_request', '19'),
      page('uat_evidence', 'uat_evidence', '21'),
      page('support_runbooks', 'support_runbook', '19'),
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
