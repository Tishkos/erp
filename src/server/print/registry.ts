import { EXPORT_ACCESS, type ExportKey } from './access';
import * as documents from './documents';
import * as shipmentDocuments from './shipment-documents';
import * as customsDocuments from './customs-documents';
import * as logisticsDocuments from './logistics-documents';
import * as importDocuments from './import-documents';
import * as purchaseDocuments from './purchase-documents';
import * as landedCostDocuments from './landed-cost-documents';
import * as inventoryDocuments from './inventory-documents';
import * as inventoryReports from './inventory-reports';
import type { BuildContext, Built } from './documents';
import * as reports from './reports';
import * as projectReports from './project-reports';
import * as hrReports from './hr-reports';
import * as accountingDocuments from './accounting-documents';
import * as projectDocuments from './project-documents';
import * as hrDocuments from './hr-documents';

export type { ExportKey } from './access';

/**
 * How each document and report is built. Who may have it, and which screen
 * it belongs to, is `access.ts`.
 */
export interface Exportable {
  readonly key: ExportKey;
  readonly kind: 'document' | 'report';
  readonly route: string;
  readonly object: string;
  readonly build: (ctx: BuildContext, input: ExportInput) => Promise<Built | null>;
}

export interface ExportInput {
  /** A document's number, or the account a per-account report is about. */
  readonly id: string | null;
  /** The screen's query string: a report's filters. */
  readonly query: URLSearchParams;
}

type Builder = (ctx: BuildContext, input: ExportInput) => Promise<Built | null>;

const byId =
  (build: (ctx: BuildContext, id: string) => Promise<Built | null>) =>
  (ctx: BuildContext, input: ExportInput) =>
    input.id ? build(ctx, input.id) : Promise.resolve(null);

const BUILDERS = {
  purchase_invoice: byId(documents.purchaseInvoice),
  sales_invoice: byId(documents.salesInvoice),
  supplier_payment: byId(documents.supplierPayment),
  customer_receipt: byId(documents.customerReceipt),
  customer_note: byId(documents.customerNote),
  sales_return: byId(documents.salesReturn),
  purchase_return: byId(documents.purchaseReturn),
  transfer: byId(documents.transfer),
  opening_stock: byId(documents.openingStock),
  journal_entry: byId(documents.journalEntry),
  item_reconciliation: byId(documents.itemReconciliation),
  stock_count: byId(inventoryDocuments.stockCount),
  bill_of_lading: byId(shipmentDocuments.billOfLading),
  asycuda_reading: byId(customsDocuments.asycudaReading),
  import_application: byId(importDocuments.importApplication),
  internal_transfer: byId(accountingDocuments.internalTransfer),
  bank_reconciliation: byId(accountingDocuments.bankReconciliation),
  bank_deposit: byId(accountingDocuments.bankDeposit),
  bank_loan: byId(accountingDocuments.bankLoan),
  payments_receipts: (ctx, input) => accountingDocuments.paymentsReceipts(ctx, input.query),
  cash_forecast: (ctx, input) => accountingDocuments.cashForecast(ctx, input.query),
  account_reconciliation: (ctx, input) => accountingDocuments.accountReconciliation(ctx, input.query),
  tax_code: byId(accountingDocuments.taxCode),
  recurring_journal: byId(accountingDocuments.recurringJournal),
  period_close: byId(accountingDocuments.periodClose),
  purchase_order: byId(purchaseDocuments.purchaseOrder),
  goods_receipt: byId(purchaseDocuments.goodsReceipt),
  payment_application: byId(purchaseDocuments.paymentApplication),
  supplier_advance: byId(purchaseDocuments.supplierAdvance),
  recurring_contract: byId(purchaseDocuments.recurringContract),
  supplier_credit_note: byId(purchaseDocuments.supplierCreditNote),
  customs_pd: byId(logisticsDocuments.customsPd),
  shipment_container: byId(logisticsDocuments.shipmentContainer),
  container_receipt: byId(logisticsDocuments.containerReceipt),
  customs_declaration: byId(logisticsDocuments.customsDeclaration),
  port: byId(logisticsDocuments.port),
  landed_cost_final: byId(landedCostDocuments.finalCostOfImport),
  customer_statement: (ctx, input) => reports.partnerStatement(ctx, 'customer', input.query),
  supplier_statement: (ctx, input) => reports.partnerStatement(ctx, 'supplier', input.query),
  bank_statement: (ctx, input) => (input.id ? reports.bankStatement(ctx, input.id, input.query, 'bank') : Promise.resolve(null)),
  cash_statement: (ctx, input) => (input.id ? reports.bankStatement(ctx, input.id, input.query, 'cash') : Promise.resolve(null)),
  warehouses_report: (ctx, input) => reports.warehousesReport(ctx, input.query),
  inventory_valuation: (ctx, input) => inventoryReports.inventoryValuation(ctx, input.query),
  inventory_checks: (ctx, input) => inventoryReports.inventoryChecks(ctx, input.query),
  stock_movement: (ctx, input) => reports.stockMovement(ctx, input.query),
  stock_ledger: (ctx, input) => reports.stockLedger(ctx, input.query),
  treasury_reporting: (ctx, input) => reports.treasuryReporting(ctx, input.query),
  receivables: (ctx, input) => reports.openItems(ctx, 'customer', input.query),
  payables: (ctx, input) => reports.openItems(ctx, 'supplier', input.query),
  invoice_status_tracking: (ctx, input) => reports.invoiceStatusTracking(ctx, input.query),
  trial_balance: (ctx, input) => reports.trialBalance(ctx, input.query),
  income_statement: (ctx, input) => reports.incomeStatement(ctx, input.query),
  balance_sheet: (ctx, input) => reports.balanceSheet(ctx, input.query),
  changes_in_equity: (ctx, input) => reports.changesInEquity(ctx, input.query),
  cash_flow: (ctx, input) => reports.cashFlow(ctx, input.query),
  gl_inquiry: (ctx, input) => reports.glInquiry(ctx, input.query),
  gl_account: (ctx, input) => (input.id ? reports.glAccount(ctx, input.id, input.query) : Promise.resolve(null)),
  project_cost_report: (ctx, input) => projectReports.costReport(ctx, input.query),
  project_line_items: (ctx, input) => projectReports.lineItems(ctx, input.query),
  project_milestone_trend: (ctx, input) => projectReports.milestoneTrend(ctx, input.query),
  project_earned_value: (ctx, input) => projectReports.earnedValue(ctx, input.query),
  payroll_run: byId(documents.payrollRun),
  payslip: byId(documents.payslip),
  hr_letter: byId(hrReports.letter),
  hr_headcount: (ctx, input) => hrReports.headcount(ctx, input.query),
  hr_leave_balances: (ctx, input) => hrReports.leaveBalances(ctx, input.query),
  hr_payroll_register: (ctx, input) => hrReports.payrollRegister(ctx, input.query),
  hr_unsettled_advances: (ctx, input) => hrReports.unsettledAdvances(ctx, input.query),
  project_certificate: byId(projectDocuments.projectCertificate),
  project_budget: byId(projectDocuments.projectBudget),
  project_change_order: byId(projectDocuments.changeOrder),
  project_material_issue: byId(projectDocuments.materialIssue),
  employee_advance: byId(hrDocuments.employeeAdvance),
  leave_request: byId(hrDocuments.leaveRequest),
  employee_document: byId(hrDocuments.employeeDocument),
  performance_review: byId(hrDocuments.performanceReview),
  vacancy: byId(hrDocuments.vacancy),
  applicant: byId(hrDocuments.applicant),
  employee_request: byId(hrDocuments.employeeRequest),
} satisfies Record<ExportKey, Builder>;

export function exportable(key: ExportKey): Exportable {
  return { key, ...EXPORT_ACCESS[key], build: BUILDERS[key] };
}
