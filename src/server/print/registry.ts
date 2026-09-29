import { EXPORT_ACCESS, type ExportKey } from './access';
import * as documents from './documents';
import type { BuildContext, Built } from './documents';
import * as reports from './reports';

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
  sales_return: byId(documents.salesReturn),
  purchase_return: byId(documents.purchaseReturn),
  transfer: byId(documents.transfer),
  opening_stock: byId(documents.openingStock),
  journal_entry: byId(documents.journalEntry),
  item_reconciliation: byId(documents.itemReconciliation),
  customer_statement: (ctx, input) => reports.partnerStatement(ctx, 'customer', input.query),
  supplier_statement: (ctx, input) => reports.partnerStatement(ctx, 'supplier', input.query),
  bank_statement: (ctx, input) => (input.id ? reports.bankStatement(ctx, input.id, input.query, 'bank') : Promise.resolve(null)),
  cash_statement: (ctx, input) => (input.id ? reports.bankStatement(ctx, input.id, input.query, 'cash') : Promise.resolve(null)),
  warehouses_report: (ctx, input) => reports.warehousesReport(ctx, input.query),
  stock_movement: (ctx, input) => reports.stockMovement(ctx, input.query),
  stock_ledger: (ctx, input) => reports.stockLedger(ctx, input.query),
  invoice_status_tracking: (ctx, input) => reports.invoiceStatusTracking(ctx, input.query),
  trial_balance: (ctx, input) => reports.trialBalance(ctx, input.query),
  income_statement: (ctx, input) => reports.incomeStatement(ctx, input.query),
  balance_sheet: (ctx, input) => reports.balanceSheet(ctx, input.query),
  changes_in_equity: (ctx, input) => reports.changesInEquity(ctx, input.query),
  cash_flow: (ctx, input) => reports.cashFlow(ctx, input.query),
  gl_inquiry: (ctx, input) => reports.glInquiry(ctx, input.query),
  gl_account: (ctx, input) => (input.id ? reports.glAccount(ctx, input.id, input.query) : Promise.resolve(null)),
} satisfies Record<ExportKey, Builder>;

export function exportable(key: ExportKey): Exportable {
  return { key, ...EXPORT_ACCESS[key], build: BUILDERS[key] };
}
