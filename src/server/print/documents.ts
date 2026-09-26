import { eq, inArray } from 'drizzle-orm';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import type { Principal } from '@domain/permissions';
import { toDecimalString } from '@domain/money';
import type { Tx } from '../db/client';
import { businessPartner, chartOfAccount } from '../db/schema';
import * as ap from '../services/ap-invoice';
import * as ar from '../services/ar-invoice';
import * as goodsReturns from '../services/goods-return';
import * as opening from '../services/opening-stock';
import * as receipts from '../services/customer-receipt';
import * as salesReturns from '../services/sales-return';
import * as stock from '../services/stock-operations';
import * as payments from '../services/supplier-payment';
import { average, lineTotal, sumMoney, sumQuantity } from './decimal';
import type { Messages } from './i18n';
import type { Column, Fact, PrintModel, Row } from './model';

/**
 * The documents of the Operations Build, as their record screens show them.
 *
 * Each builder reads the service its screen reads and lays out the same
 * header fields and the same line columns, under the same labels, in the same
 * order — the screen's `DocumentField` list and table, transcribed. Where the
 * screen computes a figure (a line's Total Price, an invoice's total before it
 * posts) the builder computes it the same way, in exact arithmetic; every
 * other figure is the service's.
 *
 * A builder returns null when the document does not exist *for this reader*:
 * the services read through row-level security, so another branch's document
 * is not found rather than refused, and its number reveals nothing.
 */
export interface BuildContext {
  readonly tx: Tx;
  readonly principal: Principal;
  /** The branch the reader is working in. */
  readonly branchCode: string;
  readonly locale: Locale;
  readonly m: Messages;
}

export interface Built {
  readonly model: PrintModel;
  /** The branch the data belongs to: the letterhead's, and the scope check's. */
  readonly branchCode: string;
  /** What the audit trail records the copy against. */
  readonly objectId: string;
}

const date = (value: string | null | undefined, locale: Locale) =>
  value ? formatBusinessDate(value, locale) : '—';

const money = (value: string | bigint, locale: Locale) =>
  formatMoney(typeof value === 'bigint' ? toDecimalString(value, 4n) : value, 'IQD', locale);

async function accountLabels(tx: Tx, ids: readonly (string | null)[], fallback: string) {
  const wanted = ids.filter((id): id is string => Boolean(id));
  const found = wanted.length
    ? await tx
        .select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name })
        .from(chartOfAccount)
        .where(inArray(chartOfAccount.id, wanted))
    : [];
  return (id: string | null) => {
    const account = id ? found.find((row) => row.id === id) : undefined;
    return account ? `${account.code} · ${account.name}` : fallback;
  };
}

async function partner(tx: Tx, id: string | null) {
  if (!id) return null;
  const [row] = await tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, id))
    .limit(1);
  return row ?? null;
}

const base = (
  input: Pick<PrintModel, 'title' | 'fields' | 'tables'> &
    Partial<Pick<PrintModel, 'number' | 'status' | 'posted' | 'summary' | 'signatures' | 'orientation'>> & {
      readonly fileName: string;
    },
): PrintModel => ({
  kind: 'document',
  orientation: input.orientation ?? 'portrait',
  filters: [],
  summary: input.summary ?? [],
  signatures: input.signatures ?? false,
  currency: 'IQD',
  sheetName: input.title,
  ...input,
});

// ------------------------------------------------------------------ block 4

/** Purchase Invoice — Operations block 4. */
export async function purchaseInvoice(ctx: BuildContext, invoiceNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const document = await ap.viewByNo(tx, invoiceNo);
  if (!document) return null;
  const { invoice, lines, raisedBy, submittedBy, postedBy } = document;
  const supplier = await partner(tx, invoice.supplierId);
  const account = await accountLabels(tx, [invoice.payableAccountId, invoice.expenseAccountId], m.admin('invoices.account_default'));

  const columns: Column[] = [
    { key: 'line_no', label: '#', kind: 'code', weight: 0.45 },
    { key: 'item_code', label: m.column('item_code'), kind: 'code' },
    { key: 'item_name', label: m.column('item_name'), kind: 'text' },
    { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
    { key: 'unit_price', label: m.column('unit_price'), kind: 'money' },
    { key: 'discount', label: m.column('discount'), kind: 'money' },
    { key: 'total_price', label: m.column('total_price'), kind: 'money' },
    { key: 'warehouse', label: m.column('warehouse'), kind: 'code' },
  ];
  const rows: Row[] = lines.map((line) => ({
    cells: {
      line_no: String(line.lineNo),
      item_code: line.itemCode ?? '—',
      item_name: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount: line.discountIqd,
      total_price: lineTotal(line.quantity, line.unitPrice, line.discountIqd),
      warehouse: line.warehouseCode ?? '—',
    },
  }));
  const fields: Fact[] = [
    { label: m.column('invoice_no'), value: invoice.invoiceNo, ltr: true },
    { label: m.column('status'), value: m.status(invoice.status) },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.name ?? '—' },
    { label: m.column('posting_date'), value: date(invoice.invoiceDate, locale), ltr: true },
    { label: m.column('due_date'), value: date(invoice.dueDate, locale), ltr: true },
    { label: m.admin('ap_invoices.raised_by'), value: raisedBy ?? '—' },
    { label: m.admin('invoices.statement_account_supplier'), value: account(invoice.payableAccountId) },
    { label: m.admin('invoices.expense_account'), value: account(invoice.expenseAccountId) },
    { label: m.column('submitted_by'), value: submittedBy ?? m.admin('none') },
    { label: m.admin('ap_invoices.posted_by'), value: postedBy ?? m.admin('none') },
  ];
  const title = m.print('titles.purchase_invoice');
  return {
    model: base({
      title,
      number: invoice.invoiceNo,
      status: m.status(invoice.status),
      posted: invoice.journalEntryId !== null,
      fields,
      tables: [
        {
          columns,
          rows,
          empty: m.admin('journals.no_lines'),
          totals: {
            label: m.admin('reports.totals'),
            cells: { total_price: sumMoney(rows.map((row) => row.cells.total_price)) },
          },
        },
      ],
      signatures: true,
      fileName: invoice.invoiceNo,
    }),
    branchCode: invoice.branchCode,
    objectId: invoice.id,
  };
}

// ------------------------------------------------------------------ block 5

/** Sales Invoice — Operations block 5. */
export async function salesInvoice(ctx: BuildContext, invoiceNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const document = await ar.viewByNo(tx, invoiceNo);
  if (!document) return null;
  const { lines, raisedBy, approvedByName, postedByName, ...invoice } = document;
  const customer = await partner(tx, invoice.customerId);
  const supplierIds = [...new Set(lines.map((line) => line.supplierId).filter((id): id is string => Boolean(id)))];
  const suppliers = supplierIds.length
    ? await tx
        .select({ id: businessPartner.id, code: businessPartner.code })
        .from(businessPartner)
        .where(inArray(businessPartner.id, supplierIds))
    : [];
  const account = await accountLabels(tx, [invoice.receivableAccountId, invoice.revenueAccountId], m.admin('invoices.account_default'));

  const columns: Column[] = [
    { key: 'line_no', label: '#', kind: 'code', weight: 0.45 },
    { key: 'item_code', label: m.column('item_code'), kind: 'code' },
    { key: 'item_name', label: m.column('item_name'), kind: 'text' },
    { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
    { key: 'unit_price', label: m.column('unit_price'), kind: 'money' },
    { key: 'discount', label: m.column('discount'), kind: 'money' },
    { key: 'total_price', label: m.column('total_price'), kind: 'money' },
    { key: 'supplier', label: m.column('supplier'), kind: 'code' },
    { key: 'warehouse', label: m.column('warehouse'), kind: 'code' },
  ];
  const rows: Row[] = lines.map((line) => ({
    cells: {
      line_no: String(line.lineNo),
      item_code: line.itemCode,
      item_name: line.description,
      quantity: line.quantity,
      unit_price: line.unitPrice,
      discount: line.discountAmountIqd ?? '0',
      total_price: line.netIqd,
      supplier: line.supplierId ? (suppliers.find((row) => row.id === line.supplierId)?.code ?? '—') : '—',
      warehouse: line.warehouseCode ?? '—',
    },
  }));
  const fields: Fact[] = [
    { label: m.column('invoice_no'), value: invoice.invoiceNo, ltr: true },
    { label: m.column('status'), value: m.status(invoice.status) },
    { label: m.column('customer_code'), value: customer?.code ?? '—', ltr: true },
    { label: m.column('customer_name'), value: customer?.name ?? '—' },
    { label: m.column('posting_date'), value: date(invoice.invoiceDate, locale), ltr: true },
    { label: m.column('due_date'), value: date(invoice.dueDate, locale), ltr: true },
    { label: m.admin('invoices.statement_account_customer'), value: account(invoice.receivableAccountId) },
    { label: m.admin('invoices.revenue_account'), value: account(invoice.revenueAccountId) },
    { label: m.admin('ar_invoices.raised_by'), value: raisedBy ?? '—' },
    { label: m.admin('ar_invoices.approved_by'), value: approvedByName ?? m.admin('none') },
    { label: m.admin('ar_invoices.posted_by'), value: postedByName ?? m.admin('none') },
  ];
  const title = m.print('titles.sales_invoice');
  return {
    model: base({
      title,
      number: invoice.invoiceNo,
      status: m.status(invoice.status),
      posted: invoice.journalEntryId !== null,
      fields,
      tables: [
        {
          columns,
          rows,
          empty: m.admin('journals.no_lines'),
          totals: {
            label: m.admin('reports.totals'),
            cells: { total_price: sumMoney(lines.map((line) => line.netIqd)) },
          },
        },
      ],
      signatures: true,
      fileName: invoice.invoiceNo,
    }),
    branchCode: invoice.branchCode,
    objectId: invoice.id,
  };
}

// ------------------------------------------------------------------ block 6

function allocationTable(
  m: Messages,
  allocations: readonly { invoiceNo: string; dueDate: string | null; amountIqd: string }[],
  allocatedLabel: string,
  allocatedTotal: string,
) {
  return {
    title: m.print('allocations'),
    columns: [
      { key: 'invoice_no', label: m.column('invoice_no'), kind: 'code' as const },
      { key: 'due_date', label: m.column('due_date'), kind: 'date' as const },
      { key: 'allocated', label: allocatedLabel, kind: 'money' as const },
    ],
    rows: allocations.map((row) => ({
      cells: { invoice_no: row.invoiceNo, due_date: row.dueDate, allocated: row.amountIqd },
    })),
    empty: m.print('no_allocations'),
    totals: { label: m.admin('reports.totals'), cells: { allocated: allocatedTotal } },
  };
}

/** Supplier Payment — Operations block 6, with the invoices it was allocated to. */
export async function supplierPayment(ctx: BuildContext, paymentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const seen = await payments.viewByNo(tx, paymentNo);
  if (!seen) return null;
  const { payment, unallocated } = seen;
  const [parties, allocations] = await Promise.all([
    payments.partiesOf(tx, payment.id),
    payments.allocationsOf(tx, payment.id),
  ]);
  const fields: Fact[] = [
    { label: m.column('reference'), value: payment.paymentNo, ltr: true },
    { label: m.column('status'), value: m.status(payment.status) },
    { label: m.column('supplier_code'), value: parties.supplierCode ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: parties.supplierName ?? '—' },
    { label: m.column('posting_date'), value: date(payment.paymentDate, locale), ltr: true },
    { label: m.column('bank_code'), value: parties.bankCode ?? '—', ltr: true },
    { label: m.column('bank_name'), value: parties.bankName ?? '—' },
    { label: m.column('branch_code'), value: payment.branchCode, ltr: true },
    { label: m.admin('supplier_payments.amount'), value: money(payment.amountIqd, locale), ltr: true },
    { label: m.admin('supplier_payments.unallocated'), value: money(unallocated, locale), ltr: true },
    { label: m.admin('supplier_payments.reference'), value: payment.reference ?? '—' },
  ];
  return {
    model: base({
      title: m.print('titles.supplier_payment'),
      number: payment.paymentNo,
      status: m.status(payment.status),
      posted: payment.journalEntryId !== null,
      fields,
      tables: [
        allocationTable(m, allocations, m.admin('supplier_payments.allocated'), payment.allocatedAmountIqd),
      ],
      summary: [
        { label: m.admin('supplier_payments.amount'), value: money(payment.amountIqd, locale), ltr: true },
        { label: m.admin('supplier_payments.allocated'), value: money(payment.allocatedAmountIqd, locale), ltr: true },
      ],
      signatures: true,
      fileName: payment.paymentNo,
    }),
    branchCode: payment.branchCode,
    objectId: payment.id,
  };
}

/** Customer Receipt — Operations block 6, with the invoices it was allocated to. */
export async function customerReceipt(ctx: BuildContext, receiptNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const receipt = await receipts.viewByNo(tx, receiptNo);
  if (!receipt) return null;
  const [parties, allocations] = await Promise.all([
    receipts.partiesOf(tx, receipt.id),
    receipts.allocationsOf(tx, receipt.id),
  ]);
  const fields: Fact[] = [
    { label: m.column('reference'), value: receipt.receiptNo, ltr: true },
    { label: m.column('status'), value: m.status(receipt.status) },
    { label: m.column('customer_code'), value: parties.customerCode ?? '—', ltr: true },
    { label: m.column('customer_name'), value: parties.customerName ?? '—' },
    { label: m.column('posting_date'), value: date(receipt.receiptDate, locale), ltr: true },
    { label: m.column('bank_code'), value: parties.bankCode ?? '—', ltr: true },
    { label: m.column('bank_name'), value: parties.bankName ?? '—' },
    { label: m.column('branch_code'), value: receipt.branchCode, ltr: true },
    { label: m.admin('customer_receipts.amount'), value: money(receipt.amountIqd, locale), ltr: true },
    { label: m.admin('customer_receipts.unallocated'), value: money(receipt.unappliedIqd, locale), ltr: true },
    { label: m.admin('customer_receipts.reference'), value: receipt.bankReference ?? '—' },
  ];
  return {
    model: base({
      title: m.print('titles.customer_receipt'),
      number: receipt.receiptNo,
      status: m.status(receipt.status),
      posted: receipt.journalEntryId !== null,
      fields,
      tables: [allocationTable(m, allocations, m.admin('customer_receipts.allocated'), receipt.allocatedIqd)],
      summary: [
        { label: m.admin('customer_receipts.amount'), value: money(receipt.amountIqd, locale), ltr: true },
        { label: m.admin('customer_receipts.allocated'), value: money(receipt.allocatedIqd, locale), ltr: true },
      ],
      signatures: true,
      fileName: receipt.receiptNo,
    }),
    branchCode: receipt.branchCode,
    objectId: receipt.id,
  };
}

// ------------------------------------------------------------- blocks 9, 10

/** Sales Return — Operations block 9. */
export async function salesReturn(ctx: BuildContext, returnNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const document = await salesReturns.viewByNo(tx, returnNo);
  if (!document) return null;
  const { lines, ...returnDoc } = document;
  const columns: Column[] = [
    { key: 'line_no', label: '#', kind: 'code', weight: 0.45 },
    { key: 'item_code', label: m.column('item_code'), kind: 'code' },
    { key: 'item_name', label: m.column('item_name'), kind: 'text' },
    { key: 'quantity', label: m.admin('sales_returns.return_quantity'), kind: 'quantity' },
    { key: 'warehouse_code', label: m.column('warehouse_code'), kind: 'code' },
  ];
  const rows: Row[] = lines.map((line) => ({
    cells: {
      line_no: String(line.lineNo),
      item_code: line.itemCode,
      item_name: line.description ?? '—',
      quantity: line.acceptedQuantity ?? line.requestedQuantity,
      warehouse_code: line.destinationWarehouseCode ?? '—',
    },
  }));
  const fields: Fact[] = [
    { label: m.column('reference'), value: returnDoc.returnNo, ltr: true },
    { label: m.column('status'), value: m.status(returnDoc.status) },
    { label: m.column('posting_date'), value: date(returnDoc.requestedOn, locale), ltr: true },
    { label: m.column('branch_code'), value: returnDoc.branchCode, ltr: true },
    {
      label: m.admin('sales_returns.offset'),
      value:
        returnDoc.offsetKind === 'bank'
          ? m.admin('sales_returns.offset_bank')
          : m.admin('sales_returns.offset_receivable'),
    },
    { label: m.admin('sales_returns.reason'), value: returnDoc.reason },
  ];
  return {
    model: base({
      title: m.print('titles.sales_return'),
      number: returnDoc.returnNo,
      status: m.status(returnDoc.status),
      // Accepting a return is what posts it: the goods back into stock and the
      // customer credited, in one step.
      posted: returnDoc.acceptedAt !== null && returnDoc.status !== 'rejected',
      fields,
      tables: [
        {
          columns,
          rows,
          empty: m.admin('journals.no_lines'),
          totals: { label: m.admin('reports.totals'), cells: { quantity: sumQuantity(rows.map((row) => row.cells.quantity)) } },
        },
      ],
      signatures: true,
      fileName: returnDoc.returnNo,
    }),
    branchCode: returnDoc.branchCode,
    objectId: returnDoc.id,
  };
}

/** Purchase Return — Operations block 10. */
export async function purchaseReturn(ctx: BuildContext, returnNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await goodsReturns.viewByNo(tx, returnNo);
  if (!found) return null;
  const { document, lines } = found;
  const columns: Column[] = [
    { key: 'line_no', label: '#', kind: 'code', weight: 0.45 },
    { key: 'item_code', label: m.column('item_code'), kind: 'code' },
    { key: 'quantity', label: m.admin('goods_returns.return_quantity'), kind: 'quantity' },
    { key: 'warehouse_code', label: m.column('warehouse_code'), kind: 'code' },
  ];
  const rows: Row[] = lines.map((line) => ({
    cells: {
      line_no: String(line.lineNo),
      item_code: line.itemCode,
      quantity: line.quantity,
      warehouse_code: line.warehouseCode,
    },
  }));
  const fields: Fact[] = [
    { label: m.column('reference'), value: document.returnNo, ltr: true },
    { label: m.column('status'), value: m.status(document.status) },
    { label: m.column('posting_date'), value: date(document.returnDate, locale), ltr: true },
    { label: m.column('branch_code'), value: document.branchCode, ltr: true },
    {
      label: m.admin('goods_returns.offset'),
      value: document.offsetKind === 'bank' ? m.admin('goods_returns.offset_bank') : m.admin('goods_returns.offset_payable'),
    },
    { label: m.admin('goods_returns.reason'), value: document.reason },
  ];
  return {
    model: base({
      title: m.print('titles.purchase_return'),
      number: document.returnNo,
      status: m.status(document.status),
      posted: document.journalEntryId !== null,
      fields,
      tables: [
        {
          columns,
          rows,
          empty: m.admin('journals.no_lines'),
          totals: { label: m.admin('reports.totals'), cells: { quantity: sumQuantity(lines.map((line) => line.quantity)) } },
        },
      ],
      signatures: true,
      fileName: document.returnNo,
    }),
    branchCode: document.branchCode,
    objectId: document.id,
  };
}

// ------------------------------------------------------------------ block 7

/** Transfer — Operations block 7. Executed when it is saved, so never a draft. */
export async function transfer(ctx: BuildContext, transferNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const row = await stock.transferByNo(tx, transferNo);
  if (!row) return null;
  return {
    model: base({
      title: m.print('titles.transfer'),
      number: row.transferNo,
      posted: true,
      fields: [
        { label: m.column('document_no'), value: row.transferNo, ltr: true },
        { label: m.column('date'), value: date(row.transferDate, locale), ltr: true },
      ],
      tables: [
        {
          columns: [
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'item_name', label: m.column('item_name'), kind: 'text' },
            { key: 'from_warehouse', label: m.column('from_warehouse'), kind: 'code' },
            { key: 'to_warehouse', label: m.column('to_warehouse'), kind: 'code' },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
          ],
          rows: [
            {
              cells: {
                item_code: row.itemCode,
                item_name: row.itemName,
                from_warehouse: row.fromWarehouseCode,
                to_warehouse: row.toWarehouseCode,
                quantity: row.quantity,
              },
            },
          ],
          empty: m.admin('journals.no_lines'),
          totals: { label: m.admin('reports.totals'), cells: { quantity: row.quantity } },
        },
      ],
      fileName: row.transferNo,
    }),
    branchCode: row.branchCode,
    objectId: row.id,
  };
}

/** Opening Stock — Operations block 7. Posts when a second person approves it. */
export async function openingStock(ctx: BuildContext, documentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await opening.viewByNo(tx, documentNo);
  if (!found) return null;
  const { document, lines } = found;
  const rows: Row[] = lines.map((line) => ({
    cells: {
      item_name: line.itemName,
      item_code: line.itemCode,
      quantity: line.quantity,
      total_price: line.totalIqd,
      average_unit_price: average(line.totalIqd, line.quantity),
      warehouse_name: document.warehouseName,
      warehouse_code: document.warehouseCode,
    },
  }));
  return {
    model: base({
      title: m.print('titles.opening_stock'),
      number: document.documentNo,
      status: m.status(document.status),
      posted: document.status === 'approved',
      fields: [
        { label: m.column('document_no'), value: document.documentNo, ltr: true },
        { label: m.column('status'), value: m.status(document.status) },
        { label: m.column('warehouse'), value: `${document.warehouseCode} · ${document.warehouseName}` },
        { label: m.column('date'), value: date(document.documentDate, locale), ltr: true },
      ],
      tables: [
        {
          columns: [
            { key: 'item_name', label: m.column('item_name'), kind: 'text' },
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
            { key: 'total_price', label: m.column('total_price'), kind: 'money' },
            { key: 'average_unit_price', label: m.column('average_unit_price'), kind: 'money', decimals: 4 },
            { key: 'warehouse_name', label: m.column('warehouse_name'), kind: 'text' },
            { key: 'warehouse_code', label: m.column('warehouse_code'), kind: 'code' },
          ],
          rows,
          empty: m.admin('journals.no_lines'),
          totals: {
            label: m.admin('opening_stock.total'),
            cells: { total_price: sumMoney(lines.map((line) => line.totalIqd)) },
          },
        },
      ],
      fileName: document.documentNo,
    }),
    branchCode: document.branchCode,
    objectId: document.id,
  };
}

/** Item Reconciliation — Operations block 7. Executed when it is saved. */
export async function itemReconciliation(ctx: BuildContext, adjustmentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const row = await stock.adjustmentByNo(tx, adjustmentNo);
  if (!row) return null;
  return {
    model: base({
      title: m.print('titles.item_reconciliation'),
      number: row.adjustmentNo,
      posted: true,
      fields: [
        { label: m.column('document_no'), value: row.adjustmentNo, ltr: true },
        { label: m.column('date'), value: date(row.adjustmentDate, locale), ltr: true },
      ],
      tables: [
        {
          columns: [
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'item_name', label: m.column('item_name'), kind: 'text' },
            { key: 'warehouse', label: m.column('warehouse'), kind: 'text' },
            { key: 'in_out', label: m.column('in_out'), kind: 'text' },
            { key: 'quantity', label: m.column('adjustment_quantity'), kind: 'quantity' },
          ],
          rows: [
            {
              cells: {
                item_code: row.itemCode,
                item_name: row.itemName,
                warehouse: `${row.warehouseCode} · ${row.warehouseName}`,
                in_out: row.direction === 'in' ? m.admin('reconciliation.in') : m.admin('reconciliation.out'),
                quantity: row.quantity,
              },
            },
          ],
          empty: m.admin('journals.no_lines'),
          totals: { label: m.admin('reports.totals'), cells: { quantity: row.quantity } },
        },
      ],
      fileName: row.adjustmentNo,
    }),
    branchCode: row.branchCode,
    objectId: row.id,
  };
}
