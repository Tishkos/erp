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
  /**
   * Appendix A's own numbering, kept so the tree can be diffed against it;
   * 21 onwards are the headings REQ-FIX-001 split out of a module (Payables'
   * four, Logistics' customs and shipping), numbered after Appendix A's twenty.
   */
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
      // The Exception Center (platform phase, Agent 7): what in the books and the work needs a person,
      // found by the system and kept until its cause is gone. One object `exception`, every role may view.
      page('exceptions', 'exception', '/exceptions'),
      // The ERP Control Center (platform phase, Agent 9): real checks of whether Qimah is internally consistent, with the
      // figures behind each and the way to the record. Read only. One object `control_center`, granted to the CEO, the
      // accounting manager and the system administrator (migration 0390).
      page('control_center', 'control_center', '/control-center'),
      // Internal chat (platform phase, Agent 1): conversations between people
      // inside the ERP, one object `chat` every role may view.
      page('chat', 'chat', '/chat'),
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
    /*
     * Sales & Receivables — the module's one heading, in the order a
     * receivable lives (by direction, 2026-10-04): the customer it is owed
     * by, the invoice that creates it, the receipt that pays it, the credits
     * a customer holds, the statement and the ageing that read it, the notes
     * and returns that correct it, and the reconciliation that proves it to
     * the ledger.
     *
     * Customers came back here from Master Data (by direction, 2026-10-04:
     * "move … customer [to] receivable"), first, before the documents that
     * name them. Listed once; the route did not move (D-FX-1).
     *
     * Credits & Advances and Customer Reconciliation are Appendix A's
     * Allocations and Reconciliation (finance_ar), brought here and given
     * routes; the rest of Finance — Receivables stays where it was.
     */
    key: 'sales',
    ordinal: 3,
    items: [
      page('customers', 'business_partner', '/sales/customers'),
      page('ar_invoices', 'ar_invoice'),
      page('customer_receipts', 'customer_receipt'),
      // An object anybody who reads receipts already holds: the credits are
      // receipts' remainders first, and applying one is the receipt's own
      // `execute`.
      page('ar_allocations', 'customer_receipt', '/sales/customer-credits'),
      // A customer's account statement. Appendix A filed it under Receivables;
      // it grants over `business_partner` because that is the record it reads
      // and the object the page authorises on.
      page('ar_statements', 'business_partner', '/sales/customer-statements'),
      // The ageing, beside the invoices it ages (2026-09-30).
      page('ar_open_items', 'ar_invoice', '/sales/receivables'),
      page('customer_credit_memos', 'customer_credit_memo', '/sales/credit-notes'),
      page('sales_returns', 'sales_return'),
      // The subledger against the control account. Read under the invoices'
      // object, as the ageing's tie is.
      page('ar_reconciliation', 'ar_invoice', '/sales/customer-reconciliation'),
      // Not built yet — kept in the tree (Appendix A), hidden until they are.
      page('sales_dashboard', 'sales_dashboard'),
      page('customer_price_lists', 'price_list'),
      page('sales_orders', 'sales_order'),
      page('reservations', 'stock_reservation'),
      page('pick_lists', 'pick_list'),
      page('delivery_notes', 'delivery_note'),
      page('cash_sales', 'cash_sale'),
      page('credit_control', 'credit_control'),
      page('warranty_inquiry', 'warranty'),
      page('sales_reports', 'sales_report'),
      page('sales_settings', 'sales_settings'),
    ],
  },
  {
    /*
     * Purchasing became Payables — REQ-AP-001 (D7, §21.1): one module for
     * everything the company owes, of every type; the import application is
     * one payable type. The former finance_ap section's items live here now —
     * one module, one place — and every old /purchasing/* route redirects.
     *
     * The Purchasing & Payables finalisation (2026-10-04) — three headings, in
     * the order a payable lives: what is bought and invoiced, how it is paid
     * and what the supplier holds, and the balances. The customs
     * declarations, bills of lading and containers went to Logistics and the
     * bank loans to Treasury & Banking (FIX-1); the module's settings and
     * sheet migration went to Administration. The supplier master went to
     * Master Data and came back the same day, by direction (2026-10-04:
     * "move the suppliers to payable"), first under Supplier Balances.
     * Routes did not move (D-FX-1), so every item that left the section it
     * was derived from names its route.
     *
     * Five never-built items were the same screens under a second name and
     * are gone: Payments (Supplier Payments), Advances (Supplier Advances),
     * Allocations (each payment's own "allocated to" table), Ageing (Payables
     * Ageing) and Supplier Ledger (Supplier Statements).
     */
    key: 'payables',
    ordinal: 4,
    items: [
      // The import application is born at its purchase invoice (D12/D13);
      // the list of them is the module's front door.
      page('payables_workbench', 'payable', '/payables'),
      page('purchase_orders', 'purchase_order'),
      page('goods_receipts', 'goods_receipt'),
      page('ap_invoices', 'ap_invoice', '/payables/invoices'),
      // Labelled Expenses: an expense is a purchase invoice raised and
      // confirmed here (D12), route kept.
      page('service_receipts', 'service_receipt'),
      page('recurring_contracts', 'recurring_contract', '/payables/contracts'),
      page('goods_returns', 'goods_return', '/payables/goods-returns'),
      // Not built yet (Appendix A).
      page('match_exceptions', 'match_exception'),
      page('procurement_dashboard', 'procurement_dashboard'),
    ],
  },
  {
    // How the supplier is paid, and what the supplier holds of ours.
    key: 'payables_payments',
    // The ordinal the former setup heading held (it went to Administration).
    ordinal: 22,
    items: [
      page('supplier_payments', 'supplier_payment', '/payables/supplier-payments'),
      page('payment_applications', 'payment_application', '/payables/payment-applications'),
      page('supplier_advances', 'supplier_advance', '/payables/advances'),
      // Read from the payments, advances and credit notes themselves — the
      // money of ours the supplier still holds, never a balance kept apart.
      page('supplier_credits', 'supplier_payment', '/payables/supplier-credits'),
      page('supplier_credit_memos', 'supplier_credit_memo', '/payables/credit-memos'),
    ],
  },
  {
    // Who is owed, how much, how late — and does it tie to the ledger.
    key: 'payables_suppliers',
    ordinal: 21,
    items: [
      // The supplier master — whom the balances below are owed to; its
      // profile shows the payables position (by direction, 2026-10-04). The
      // address stays /payables/suppliers (D-FX-1).
      page('suppliers', 'business_partner', '/payables/suppliers'),
      // The supplier's side of the same mirror. See the note under Sales.
      page('ap_statements', 'business_partner', '/payables/supplier-statements'),
      page('ap_open_items', 'ap_invoice', '/payables/open-items'),
      // Over the same invoices as the ageing, so whoever reads one reads both.
      page('ap_reconciliation', 'ap_invoice', '/payables/reconciliation'),
      // Not built yet (Appendix A).
      page('purchasing_reports', 'purchasing_report'),
    ],
  },
  {
    /*
     * IMPROVEMENT-002 (sponsor, 2026-10-04) — the twelve inventory screens, in
     * the order the work is done: what is where, what came in and went out,
     * the counts and corrections, the checks and the valuations. Items, units
     * and warehouses are master data and live there (one screen, one home).
     * The unbuilt placeholders (quarantine, returns, damaged goods, serial /
     * batch, reports, settings) are off the tree until a requirement names
     * them: the quarantine, damaged and returns buckets are Availability's
     * columns, and the reports are the three valuation screens.
     */
    key: 'inventory',
    ordinal: 5,
    items: [
      page('availability', 'inventory_movement', '/inventory/availability'),
      page('opening_stock', 'opening_stock', '/inventory/opening-stock'),
      page('stock_receipts', 'stock_movement', '/inventory/stock-receipts'),
      page('stock_issues', 'stock_movement', '/inventory/stock-issues'),
      page('transfer_requests', 'warehouse_transfer', '/inventory/transfers'),
      page('stock_movements', 'stock_movement', '/inventory/stock-movements'),
      page('stock_ledger', 'stock_movement', '/inventory/stock-ledger'),
      page('stock_count', 'stock_count', '/inventory/stock-count'),
      page('stock_reconciliation', 'stock_reconciliation', '/inventory/stock-reconciliation'),
      page('inventory_checks', 'inventory_movement', '/inventory/checks'),
      page('inventory_valuation', 'inventory_movement', '/inventory/valuation'),
      page('fifo_valuation', 'fifo_valuation'),
    ],
  },
  {
    key: 'projects',
    ordinal: 6,
    items: [
      // REQ-PM-001 PM-1 — the Project System's master screens.
      page('project_master', 'project', '/projects'),
      page('contracts', 'project', '/projects/contracts'),
      page('wbs', 'project', '/projects/wbs'),
      // REQ-PM-001 PM-2 — the plan, the budget documents and the change orders.
      page('cost_plan', 'project', '/projects/plan'),
      page('project_budgets', 'project', '/projects/budgets'),
      page('change_orders', 'project', '/projects/change-orders'),
      // REQ-PM-001 PM-3 — execution: the line items, the orders and payables, the issues.
      page('project_costs', 'project', '/projects/costs'),
      page('project_procurement', 'project', '/projects/procurement'),
      page('material_issues', 'project', '/projects/material-issues'),
      // REQ-PM-001 PM-4 — progress, earned value, the milestones and their trend.
      page('progress', 'project', '/projects/progress'),
      // REQ-PM-001 PM-5 — the billing plan, certificates, recognition; the forecast at completion.
      page('project_billing', 'project', '/projects/billing'),
      page('project_forecast', 'project', '/projects/forecast'),
      // REQ-PM-001 PM-6 — close and settlement; the four reports.
      page('project_close', 'project', '/projects/close'),
      page('project_reports', 'project', '/projects/reports'),
    ],
  },
  {
    /*
     * REQ-FIX-001 FIX-1 — Logistics holds everything logistics in the whole
     * system (by direction, 2026-10-02): the customs declarations and the
     * ASYCUDA list, the shipping (bills of lading, containers, the goods in
     * transit on ordinary invoices), and the logistics jobs. The built
     * screens keep their routes (D-FX-1).
     */
    key: 'logistics_customs',
    ordinal: 23,
    /*
     * REQ-LOG-001 — the owner's four Logistics headings (2026-10-04), fifteen
     * items in his order. Logistics owns nothing financial: the registers of
     * duties, freight and landed cost read the import's charges and locks and
     * link to the import; their menu objects (`customs_duty`, `freight_cost`,
     * `landed_cost_register`, `cost_allocation`) are read-only, so a role
     * given a Logistics heading gains no power over the money (0300). New
     * screens live under /logistics/…; the old ones keep their routes (D-FX-1).
     */
    items: [
      page('pds', 'customs_pd', '/payables/pd'),
      page('customs_declarations', 'customs_declaration', '/logistics/customs-declarations'),
      { key: 'asycuda_update', object: 'customs_pd', verb: 'import', href: '/payables/pd/asycuda' },
      page('customs_duties', 'customs_duty', '/logistics/customs-duties'),
      page('customs_documents', 'customs_pd', '/logistics/customs-documents'),
    ],
  },
  {
    key: 'logistics_shipping',
    ordinal: 24,
    items: [
      page('import_shipments', 'bill_of_lading', '/logistics/shipments'),
      page('shipments', 'bill_of_lading', '/payables/shipments'),
      page('containers', 'shipment_container', '/payables/containers'),
      page('ports_routes', 'port', '/logistics/ports'),
      page('freight_costs', 'freight_cost', '/logistics/freight-costs'),
      page('shipment_documents', 'bill_of_lading', '/logistics/shipment-documents'),
    ],
  },
  {
    // REQ-LOG-001 — what is owned and not yet on hand. In-Transit Inventory
    // absorbed Invoice Status Tracking; /inventory/in-transit redirects here.
    key: 'logistics_in_transit',
    ordinal: 29,
    items: [
      page('in_transit', 'in_transit', '/logistics/in-transit'),
      page('shipment_tracking', 'shipment_container', '/logistics/shipment-tracking'),
    ],
  },
  {
    // REQ-LOG-001 — the landed cost, read: the engine and its actions stay on
    // the import page (`/payables/[payableNo]#landed-cost`).
    key: 'logistics_landed_costs',
    ordinal: 30,
    items: [
      page('landed_costs', 'landed_cost_register', '/logistics/landed-costs'),
      page('cost_allocation', 'cost_allocation', '/logistics/cost-allocation'),
    ],
  },
  {
    // The client logistics jobs (Phase 10, Appendix A menu 7). No screen yet;
    // REQ-LOG-001 Q3 took them out of the Logistics dropdown (`erp-shell.tsx`)
    // and kept them here, so their routes and objects stay reserved.
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
    /*
     * The Accounting navbar (by direction, 2026-10-04): what was accounted
     * for — the journals and their controls first, the close, the
     * configuration that says how business events post, the reconciliation of
     * every control account to its subledger, then the four statements.
     *
     * Each item names the object its service authorises on, never one nobody
     * holds (see Posting Mappings below): the closing screen is the periods'
     * own (`fiscal_period`, which the periods service authorises on), recurring journals
     * raise journal entries (`journal_entry`), and Account Reconciliation is a
     * ledger report read under the Trial Balance's grant.
     */
    key: 'finance_gl',
    ordinal: 10,
    items: [
      page('journal_entry', 'journal_entry', '/finance/journals'),
      page('reversals', 'journal_reversal', '/finance/reversals'),
      page('gl_inquiry', 'gl_inquiry', '/finance/gl-inquiry'),
      page('trial_balance', 'trial_balance', '/finance/trial-balance'),
      // `fiscal_period` is what the periods service and its page authorise
      // on; the tree named `accounting_period`, which no role holds, so
      // Accounting Periods was missing from every menu but a Super User's.
      page('soft_close', 'fiscal_period', '/finance/periods'),
      page('year_end_close', 'fiscal_period', '/finance/closing'),
      // `posting_rule` is the object the grants are written against and the
      // one the service authorises on. The tree used to name a second object
      // nobody could hold, so the screen was invisible to everyone but a
      // Super User — including the Accounting Manager whose role may
      // configure it.
      page('posting_mappings', 'posting_rule', '/finance/posting-mappings'),
      page('recurring_journals', 'journal_entry', '/finance/recurring-journals'),
      page('account_reconciliation', 'trial_balance', '/finance/account-reconciliation'),
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
      // Allocations and Reconciliation moved to Sales & Receivables
      // (2026-10-04), where the receivable is worked.
      page('credit_limits', 'credit_limit'),
      page('collections', 'collection'),
      page('ar_ageing', 'ar_ageing'),
    ],
  },
  {
    /*
     * Treasury & Banking — what money moved, or is expected to (by direction,
     * 2026-10-04). The accounts themselves are master records and live under
     * Master Data › Banking; this heading holds what happens to them.
     *
     * Every item names the object its service authorises on: the transfers,
     * the deposits and the forecast are `bank_cash_account` work
     * (treasury.ts, bank-deposits.ts, cash-forecast.ts), the two reports read
     * under `bank_account` (treasury-reports.ts), the reconciliation under its
     * own grant. Payments & Receipts replaces Appendix A's separate Receipts
     * and Payments: it is one view of the money that moved, and the receipts
     * and payments themselves stay with Sales and Payables, which own them.
     */
    key: 'treasury',
    ordinal: 12,
    items: [
      page('bank_reconciliation', 'bank_reconciliation', '/treasury/bank-reconciliation'),
      page('bank_transfers', 'bank_cash_account', '/treasury/transfers'),
      // REQ-FIX-001 FIX-1 — the bank's side of the company's money: its loans
      // (route kept, D-FX-1) and the deposits made into it by hand (D-FX-2).
      page('loans', 'bank_loan', '/treasury/loans'),
      page('bank_deposits', 'bank_cash_account', '/treasury/deposits'),
      page('payments_receipts', 'bank_account', '/treasury/payments-receipts'),
      // Bank and Cash Reporting — every account's balance and what it is
      // made of (2026-09-29).
      page('treasury_reports', 'bank_account', '/treasury/reporting'),
      page('cash_forecast', 'bank_cash_account', '/treasury/cash-forecast'),
      // Not built as screens of their own: a statement is entered and read
      // inside the reconciliation it is for, and the daily position is the
      // forecast's opening and Bank and Cash Reporting's closing.
      page('bank_statements', 'bank_statement'),
      page('daily_position', 'daily_position'),
    ],
  },
  {
    key: 'fixed_assets',
    ordinal: 13,
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
    ordinal: 14,
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
    ordinal: 15,
    items: [
      // REQ-FIX-001 FIX-5 — the sponsor's order (2026-10-02). The screens
      // live under /hr; with REQ-HR-001 HR-6 every one of them is built.
      page('hr_dashboard', 'hr_report', '/hr/dashboard'),
      page('employees', 'employee', '/hr/employees'),
      page('hr_departments', 'org_structure', '/hr/departments'),
      page('hr_positions', 'org_structure', '/hr/positions'),
      page('attendance', 'attendance', '/hr/attendance'),
      page('leave', 'leave_request', '/hr/leave'),
      page('payroll', 'payroll_run', '/hr/payroll'),
      page('employee_advances', 'employee_advance', '/hr/advances'),
      page('recruitment', 'recruitment', '/hr/recruitment'),
      page('performance', 'performance_review', '/hr/performance'),
      page('employee_requests', 'employee_request', '/hr/requests'),
      page('hr_documents', 'employee_document', '/hr/documents'),
      page('hr_reports', 'hr_report', '/hr/reports'),
    ],
  },
  {
    key: 'documents',
    ordinal: 16,
    items: [
      page('document_centre', 'cloud_files', '/documents'),
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
    ordinal: 17,
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
  /*
   * Master Data & Configuration — what exists (by direction, 2026-10-04), in
   * four headings: Financial, Banking, Organization and Inventory Reference.
   * `master_data` keeps its key, so the unbuilt items that derive their route
   * from it keep their addresses; the other three are sections 26–28.
   *
   * Bank and Cash Accounts are master records — a transfer, a receipt, a
   * reconciliation each *refer* to one — so they moved here from Treasury,
   * keeping their routes (D-FX-1).
   */
  {
    key: 'master_data',
    ordinal: 18,
    items: [
      // Customers and Suppliers went back to Receivables and Payables, by
      // direction (2026-10-04), so this heading holds reference data only.
      page('chart_of_accounts', 'chart_of_account', '/master-data/chart-of-accounts'),
      page('statement_mapping', 'financial_statement', '/master-data/statement-mapping'),
      page('currencies_rates', 'exchange_rate', '/master-data/exchange-rates'),
      page('tax_codes', 'tax_code', '/master-data/tax-codes'),
      page('payment_terms', 'payment_term', '/master-data/payment-terms'),
      page('payment_methods', 'payment_method', '/master-data/payment-methods'),
      page('supplier_item_codes', 'supplier_item_code'),
      page('barcodes', 'barcode'),
      page('price_lists', 'price_list'),
    ],
  },
  {
    key: 'master_banking',
    ordinal: 26,
    items: [
      page('banks', 'bank', '/master-data/banks'),
      page('bank_cash_accounts', 'bank_account', '/master-data/bank-accounts'),
      page('cash_accounts', 'bank_account', '/master-data/cash-accounts'),
    ],
  },
  {
    key: 'master_organization',
    ordinal: 27,
    items: [
      page('branches', 'branch', '/master-data/branches'),
      page('departments', 'department', '/master-data/departments'),
      page('cost_centres', 'cost_centre', '/master-data/cost-centres'),
    ],
  },
  {
    key: 'master_inventory',
    ordinal: 28,
    // Items and units keep the routes they were derived under (D-FX-1).
    items: [
      page('items', 'item', '/inventory/items'),
      page('uom', 'uom', '/inventory/uom'),
      page('warehouses', 'warehouse', '/master-data/warehouses'),
    ],
  },
  {
    key: 'administration',
    ordinal: 19,
    items: [
      page('company', 'company', '/administration/company'),
      page('users', 'app_user', '/administration/users'),
      page('department_manager_toggles', 'user_department_scope', '/administration/managers'),
      page('roles', 'role', '/administration/roles'),
      page('permissions', 'permission', '/administration/permissions'),
      page('numbering', 'number_series', '/administration/numbering'),
      // Platform phase, Agent 4 — QS Cloud Files: on/off, address, role -> group mapping.
      page('cloud_files_settings', 'cloud_setting', '/administration/cloud-files'),
      page('audit_trail', 'audit_event', '/administration/audit'),
      page('system_parameters', 'system_parameter', '/administration/parameters'),
      page('background_jobs', 'job', '/administration/jobs'),
      page('backup_health', 'system_health'),
      // REQ-LEGACY-001 — the old system's books, once.
      page('legacy_import', 'legacy_import', '/administration/legacy-import'),
      // REQ-AP-001 Stage 8 — the one-time sheet import (§24.3), a data
      // migration utility beside the other one, not Payables work (2026-10-04).
      page('payables_migration', 'payables_migration', '/administration/payables-migration'),
      // REQ-HR-001 §12 — positions, pay components, leave types, calendars.
      page('hr_settings', 'hr_setting', '/administration/hr-settings'),
      // REQ-WA-001 §6 — the bridge, the allow-list, the rules, the log.
      page('whatsapp', 'whatsapp', '/administration/whatsapp'),
      // REQ-PM-001 R4 — project types, tolerance profiles, cost codes.
      page('project_settings', 'project_setting', '/administration/project-settings'),
      // REQ-AP-001 §21.11 — payable types, stages, time limits, reason codes,
      // expense categories and event codes: the module's own configuration,
      // beside the other modules' settings (2026-10-04).
      page('payables_settings', 'payables_settings', '/administration/payables-settings'),
    ],
  },
  /*
   * Monitoring — by direction, 2026-10-03.
   *
   * Its three screens are drawn and read nothing yet. They are in the tree all
   * the same, because a menu item that is not in the tree has no route, no
   * permission object and no place in the roles that hold every section — and
   * adding it later would mean doing all three again.
   */
  {
    key: 'monitoring',
    ordinal: 25,
    items: [
      page('customer_list', 'monitoring'),
      page('history', 'monitoring'),
      page('reports', 'monitoring'),
    ],
  },
  {
    key: 'integrations',
    ordinal: 20,
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
