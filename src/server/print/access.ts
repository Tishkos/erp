import { can, type Principal } from '@domain/permissions';
import type { ExportFormat } from './model';

/**
 * Who may have which copy — kept apart from the builders and renderers so a
 * screen deciding whether to show its Print / Export menu loads none of them.
 *
 * `route` is the screen's own route: the export exists only while the phase
 * gate shows that screen. `object` is what the screen authorises `view` on;
 * the export asks the same object for `print` (the PDF) or `export` (the
 * workbook and the Word file).
 */
export const EXPORT_ACCESS = {
  purchase_invoice: { kind: 'document', route: '/payables/invoices', object: 'ap_invoice' },
  sales_invoice: { kind: 'document', route: '/sales/ar-invoices', object: 'ar_invoice' },
  supplier_payment: { kind: 'document', route: '/payables/supplier-payments', object: 'supplier_payment' },
  customer_receipt: { kind: 'document', route: '/sales/customer-receipts', object: 'customer_receipt' },
  sales_return: { kind: 'document', route: '/sales/sales-returns', object: 'sales_return' },
  purchase_return: { kind: 'document', route: '/payables/goods-returns', object: 'goods_return' },
  transfer: { kind: 'document', route: '/inventory/transfers', object: 'warehouse_transfer' },
  opening_stock: { kind: 'document', route: '/inventory/opening-stock', object: 'opening_stock' },
  journal_entry: { kind: 'document', route: '/finance/journals', object: 'journal_entry' },
  item_reconciliation: { kind: 'document', route: '/inventory/stock-reconciliation', object: 'stock_reconciliation' },
  // IMPROVEMENT-002 — the B/L, printed from its own page (its boxes, containers and what each carries).
  bill_of_lading: { kind: 'document', route: '/payables/shipments', object: 'bill_of_lading' },
  customer_statement: { kind: 'report', route: '/sales/customer-statements', object: 'business_partner' },
  supplier_statement: { kind: 'report', route: '/payables/supplier-statements', object: 'business_partner' },
  bank_statement: { kind: 'report', route: '/master-data/bank-accounts', object: 'bank_account' },
  cash_statement: { kind: 'report', route: '/master-data/cash-accounts', object: 'bank_account' },
  warehouses_report: { kind: 'report', route: '/inventory/fifo-valuation', object: 'inventory_movement' },
  stock_movement: { kind: 'report', route: '/inventory/stock-movements', object: 'stock_movement' },
  stock_ledger: { kind: 'report', route: '/inventory/stock-ledger', object: 'stock_movement' },
  treasury_reporting: { kind: 'report', route: '/treasury/reporting', object: 'bank_account' },
  receivables: { kind: 'report', route: '/sales/receivables', object: 'ar_invoice' },
  payables: { kind: 'report', route: '/payables/open-items', object: 'ap_invoice' },
  invoice_status_tracking: { kind: 'report', route: '/inventory/in-transit', object: 'supplier_shipment' },
  trial_balance: { kind: 'report', route: '/finance/trial-balance', object: 'trial_balance' },
  income_statement: { kind: 'report', route: '/finance/income-statement', object: 'financial_statement' },
  balance_sheet: { kind: 'report', route: '/finance/balance-sheet', object: 'financial_statement' },
  changes_in_equity: { kind: 'report', route: '/finance/changes-in-equity', object: 'financial_statement' },
  cash_flow: { kind: 'report', route: '/finance/cash-flow', object: 'financial_statement' },
  gl_inquiry: { kind: 'report', route: '/finance/gl-inquiry', object: 'gl_inquiry' },
  gl_account: { kind: 'report', route: '/finance/gl-inquiry', object: 'gl_inquiry' },
  // REQ-PM-001 PM-6 — the Project System's four reports (PM13).
  project_cost_report: { kind: 'report', route: '/projects/reports', object: 'project' },
  project_line_items: { kind: 'report', route: '/projects/reports', object: 'project' },
  project_milestone_trend: { kind: 'report', route: '/projects/reports', object: 'project' },
  project_earned_value: { kind: 'report', route: '/projects/reports', object: 'project' },
  // REQ-HR-001 HR-3 — the run is read under the payroll grant; a payslip also
  // by the person it pays (R5), whom row security alone lets through.
  payroll_run: { kind: 'document', route: '/hr/payroll', object: 'payroll_run' },
  payslip: { kind: 'document', route: '/hr/payroll', object: 'payroll_run', selfService: true },
  // REQ-HR-001 HR-6 — an issued letter, which the person it is about may print
  // (row security returns only theirs); the four HR reports, each under the
  // grant its figures need (pay under payroll's, advances under theirs).
  hr_letter: { kind: 'document', route: '/hr/requests', object: 'employee_request', selfService: true },
  hr_headcount: { kind: 'report', route: '/hr/reports', object: 'hr_report' },
  hr_leave_balances: { kind: 'report', route: '/hr/reports', object: 'hr_report' },
  hr_payroll_register: { kind: 'report', route: '/hr/reports', object: 'payroll_run' },
  hr_unsettled_advances: { kind: 'report', route: '/hr/reports', object: 'employee_advance' },
} as const satisfies Record<
  string,
  { readonly kind: 'document' | 'report'; readonly route: string; readonly object: string; readonly selfService?: boolean }
>;

export type ExportKey = keyof typeof EXPORT_ACCESS;

export const EXPORT_KEYS = Object.keys(EXPORT_ACCESS) as ExportKey[];

export function verbFor(format: ExportFormat): 'print' | 'export' {
  return format === 'pdf' ? 'print' : 'export';
}

/** May this reader have this format of this export? The menu and the route ask the same. */
export function mayExport(principal: Principal, key: ExportKey, format: ExportFormat): boolean {
  const { object } = EXPORT_ACCESS[key];
  return (can(principal, 'view', object) && can(principal, verbFor(format), object)) || isSelfService(key);
}

/**
 * A copy the person it is about may take without the object's grant — their
 * own payslip (REQ-HR-001 R5). The builder reads through row security, which
 * returns their own row and nobody else's; so the grant is not asked, and
 * the menu is offered wherever the screen itself could be read.
 */
export function isSelfService(key: ExportKey): boolean {
  const entry = EXPORT_ACCESS[key] as { readonly selfService?: boolean };
  return entry.selfService === true;
}

export function isExportKey(value: string): value is ExportKey {
  return Object.prototype.hasOwnProperty.call(EXPORT_ACCESS, value);
}

/** Where a copy is fetched: the one export route, by key and document number. */
export function exportHref(key: ExportKey, id?: string | null): string {
  return `/export/${key}${id ? `/${encodeURIComponent(id)}` : ''}`;
}
