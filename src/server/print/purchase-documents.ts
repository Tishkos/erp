/**
 * The purchase records that could not be printed — REQ-PAY-001 PAY4
 * (2026-10-04): "every invoice — notes, attachments, audit, print — after the
 * draft is created".
 *
 * The purchase order, the goods receipt, the payment application, the
 * supplier advance, the recurring contract and the supplier credit note. Each
 * builder reads the service its record screen reads, through the reader's own
 * row security, and lays out the same fields and line columns under the same
 * labels — so the paper, the workbook, the Word file and the screen are one
 * set of figures. A debit note is a purchase invoice (D-PAY-2) and prints as
 * one.
 */
import { eq } from 'drizzle-orm';
import { formatBusinessDate, formatMoney, type Locale } from '@/i18n/config';
import { toDecimalString } from '@domain/money';
import { businessPartner } from '../db/schema';
import * as orders from '../services/purchase-order';
import * as receipts from '../services/goods-receipt';
import * as applications from '../services/payment-applications';
import * as advances from '../services/supplier-advance';
import * as contracts from '../services/recurring-contracts';
import * as notes from '../services/supplier-notes';
import { decimalString, lineTotal, scaled, sumMoney, sumQuantity } from './decimal';
import type { BuildContext, Built } from './documents';
import type { Column, Fact, PrintModel, Row } from './model';

const date = (value: string | null | undefined, locale: Locale) => (value ? formatBusinessDate(value, locale) : '—');
const money = (value: string | bigint, locale: Locale) =>
  formatMoney(typeof value === 'bigint' ? toDecimalString(value, 4n) : value, 'IQD', locale);

const document = (
  input: Pick<PrintModel, 'title' | 'fields' | 'tables' | 'number' | 'status' | 'posted'> &
    Partial<Pick<PrintModel, 'summary' | 'signatures'>> & { readonly fileName: string },
): PrintModel => ({
  kind: 'document',
  orientation: 'portrait',
  filters: [],
  summary: input.summary ?? [],
  signatures: input.signatures ?? false,
  currency: 'IQD',
  sheetName: input.title,
  ...input,
});

async function supplierOf(ctx: BuildContext, id: string) {
  const [row] = await ctx.tx
    .select({ code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, id))
    .limit(1);
  return row ?? null;
}

/** Purchase Order — its lines with ordered, received, remaining, invoiced and price (PAY5). */
export async function purchaseOrder(ctx: BuildContext, orderNo: string): Promise<Built | null> {
  const { m, locale } = ctx;
  const found = await orders.viewByNo(ctx.tx, orderNo);
  if (!found) return null;
  const { order, lines, supplier, payableNo } = found;
  const t = (key: string) => m.admin(`payables_orders.${key}`);
  // What is still to come: ordered, less received, less what a cancellation
  // closed — the order's own arithmetic (`openCommitments`), in exact decimals.
  const remaining = (line: (typeof lines)[number]) =>
    decimalString(scaled(line.quantity, 6n) - scaled(line.receivedQuantity, 6n) - scaled(line.closedQuantity, 6n), 6n);
  const columns: Column[] = [
    { key: 'line_no', label: '#', kind: 'code', weight: 0.45 },
    { key: 'item_code', label: t('line_item'), kind: 'code' },
    { key: 'description', label: t('line_description'), kind: 'text', weight: 2 },
    { key: 'ordered', label: t('line_quantity'), kind: 'quantity' },
    { key: 'received', label: t('line_received'), kind: 'quantity' },
    { key: 'remaining', label: t('line_remaining'), kind: 'quantity' },
    { key: 'invoiced', label: t('line_invoiced'), kind: 'quantity' },
    { key: 'price', label: t('line_price'), kind: 'money' },
    { key: 'total', label: m.column('total_price'), kind: 'money' },
  ];
  const rows: Row[] = lines.map((line) => ({
    cells: {
      line_no: String(line.lineNo),
      item_code: line.itemCode ?? '—',
      description: line.description,
      ordered: line.quantity,
      received: line.receivedQuantity,
      remaining: remaining(line),
      invoiced: line.invoicedQuantity,
      price: line.unitPrice,
      total: lineTotal(line.quantity, line.unitPrice, '0'),
    },
  }));
  const fields: Fact[] = [
    { label: t('col_no'), value: order.orderNo, ltr: true },
    { label: m.column('status'), value: m.status(order.status) },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.legalName ?? '—' },
    { label: t('col_date'), value: date(order.orderDate, locale), ltr: true },
    { label: t('expected_date'), value: date(order.expectedDate, locale), ltr: true },
    { label: t('currency'), value: order.currency, ltr: true },
    { label: t('reference'), value: order.reference ?? '—' },
    { label: m.column('branch_code'), value: order.branchCode, ltr: true },
    ...(payableNo ? [{ label: t('col_payable'), value: payableNo, ltr: true }] : []),
  ];
  return {
    model: document({
      title: m.print('titles.purchase_order'),
      number: order.orderNo,
      status: m.status(order.status),
      // An order commits; it never posts. Approved is the moment it binds.
      posted: !['draft', 'submitted', 'rejected'].includes(order.status),
      fields,
      tables: [
        {
          columns,
          rows,
          empty: m.admin('journals.no_lines'),
          totals: {
            label: m.admin('reports.totals'),
            cells: {
              ordered: sumQuantity(lines.map((line) => line.quantity)),
              received: sumQuantity(lines.map((line) => line.receivedQuantity)),
              total: sumMoney(rows.map((row) => row.cells.total ?? null)),
            },
          },
        },
      ],
      signatures: true,
      fileName: order.orderNo,
    }),
    branchCode: order.branchCode,
    objectId: order.id,
  };
}

/** Goods Receipt — what arrived, against the order line it answers (PAY6). */
export async function goodsReceipt(ctx: BuildContext, receiptNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await receipts.viewByNo(tx, receiptNo);
  if (!found) return null;
  const { receipt, lines, orderNo, orderLines } = found;
  const t = (key: string) => m.admin(`payables_goods.${key}`);
  const supplier = found.supplierId ? await supplierOf(ctx, found.supplierId) : null;
  const columns: Column[] = [
    { key: 'line_no', label: '#', kind: 'code', weight: 0.45 },
    { key: 'item_code', label: t('line_item'), kind: 'code' },
    { key: 'ordered', label: t('line_ordered'), kind: 'quantity' },
    { key: 'quantity', label: t('line_quantity'), kind: 'quantity' },
    { key: 'received_to_date', label: t('line_received_to_date'), kind: 'quantity' },
    { key: 'uom', label: t('line_uom'), kind: 'code' },
    { key: 'warehouse', label: m.column('warehouse_code'), kind: 'code' },
    { key: 'batch', label: t('line_batch'), kind: 'code' },
  ];
  const rows: Row[] = lines.map((line) => {
    const order = orderLines.get(line.purchaseOrderLineId);
    return {
      cells: {
        line_no: String(line.lineNo),
        item_code: line.itemCode,
        ordered: order?.quantity ?? null,
        quantity: line.quantity,
        received_to_date: order?.receivedQuantity ?? null,
        uom: line.uomCode,
        warehouse: line.warehouseCode,
        batch: line.batchNumber ?? '—',
      },
    };
  });
  const fields: Fact[] = [
    { label: t('col_no'), value: receipt.receiptNo, ltr: true },
    { label: m.column('status'), value: m.status(receipt.status) },
    { label: t('col_order'), value: orderNo ?? '—', ltr: true },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.name ?? '—' },
    { label: t('col_date'), value: date(receipt.receiptDate, locale), ltr: true },
    { label: t('delivery_note'), value: receipt.supplierDeliveryNote ?? '—' },
    { label: m.column('branch_code'), value: receipt.branchCode, ltr: true },
  ];
  return {
    model: document({
      title: m.print('titles.goods_receipt'),
      number: receipt.receiptNo,
      status: m.status(receipt.status),
      posted: receipt.status === 'executed' || receipt.status === 'reversed',
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
      fileName: receipt.receiptNo,
    }),
    branchCode: receipt.branchCode,
    objectId: receipt.id,
  };
}

/** Payment Application — the request to the bank, as it was approved and sent. */
export async function paymentApplication(ctx: BuildContext, applicationNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await applications.view(tx, applicationNo).catch(() => null);
  if (!found) return null;
  const { application: row, payable, method, account, supplier, payee, instalment, people } = found;
  const t = (key: string) => m.admin(`payment_applications.${key}`);
  const statusLabel = m.admin(`payment_applications.status_${row.status}`);
  const fields: Fact[] = [
    { label: t('col_no'), value: row.applicationNo, ltr: true },
    { label: m.column('status'), value: statusLabel },
    { label: t('col_import'), value: payable.payableNo, ltr: true },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.name ?? '—' },
    { label: t('col_method'), value: method.name },
    { label: t('col_account'), value: `${account.code} · ${account.name}` },
    { label: t('payee'), value: payee ? [payee.bankName, payee.iban ?? payee.accountNumber].filter(Boolean).join(' · ') : '—' },
    { label: t('col_amount'), value: `${row.amountTxn} ${row.currency}`, ltr: true },
    { label: t('instalment'), value: instalment ? `${instalment.sequence} · ${instalment.label ?? instalment.triggerName}` : t('no_instalment') },
    { label: t('funding'), value: found.fundingName },
    { label: t('col_application_date'), value: date(row.applicationDate, locale), ltr: true },
    { label: t('raised_by'), value: people.createdBy ?? '—' },
    { label: t('approved_by'), value: people.approvedBy ?? '—' },
    { label: t('sent_by'), value: people.sentBy ?? '—' },
    { label: t('confirmed_by'), value: people.confirmedBy ?? '—' },
    ...(found.documentNo ? [{ label: t('posted_as'), value: found.documentNo, ltr: true }] : []),
  ];
  return {
    model: document({
      title: m.print('titles.payment_application'),
      number: row.applicationNo,
      status: statusLabel,
      posted: ['confirmed', 'debited'].includes(row.status),
      fields,
      tables: [],
      summary: [{ label: t('col_amount'), value: `${row.amountTxn} ${row.currency}`, ltr: true }],
      signatures: true,
      fileName: row.applicationNo,
    }),
    branchCode: row.branchCode,
    objectId: row.id,
  };
}

/** Supplier Advance — what was paid in front, and where it was applied. */
export async function supplierAdvance(ctx: BuildContext, advanceNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await advances.viewByNo(tx, advanceNo).catch(() => null);
  if (!found) return null;
  const { advance, balance, supplier, orderNo, payableNo, settlements } = found;
  const t = (key: string) => m.admin(`supplier_advances.${key}`);
  const fields: Fact[] = [
    { label: t('col_no'), value: advance.advanceNo, ltr: true },
    { label: m.column('status'), value: m.status(advance.status) },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.name ?? '—' },
    { label: t('order'), value: orderNo ?? '—', ltr: true },
    { label: t('import'), value: payableNo ?? '—', ltr: true },
    { label: t('request_date'), value: date(advance.requestDate, locale), ltr: true },
    { label: t('paid_date'), value: date(advance.paidDate, locale), ltr: true },
    { label: t('amount'), value: money(advance.amountIqd, locale), ltr: true },
    { label: t('unapplied'), value: money(balance, locale), ltr: true },
    { label: t('reason'), value: advance.reason ?? '—' },
    { label: t('requested_by'), value: found.requestedBy ?? '—' },
    { label: t('approved_by'), value: found.approvedBy ?? '—' },
    { label: t('paid_by'), value: found.paidBy ?? '—' },
  ];
  const live = settlements.filter((row) => !row.reversedAt);
  return {
    model: document({
      title: m.print('titles.supplier_advance'),
      number: advance.advanceNo,
      status: m.status(advance.status),
      posted: advance.paidDate !== null,
      fields,
      tables: [
        {
          title: t('settlements'),
          columns: [
            { key: 'invoice', label: t('invoice'), kind: 'code' },
            { key: 'date', label: t('settlement_date'), kind: 'date' },
            { key: 'amount', label: t('amount'), kind: 'money' },
          ],
          rows: live.map((row) => ({ cells: { invoice: row.invoiceNo, date: row.settlementDate, amount: row.amountIqd } })),
          empty: t('no_settlements'),
          totals: { label: m.admin('reports.totals'), cells: { amount: sumMoney(live.map((row) => row.amountIqd)) } },
        },
      ],
      signatures: true,
      fileName: advance.advanceNo,
    }),
    branchCode: advance.branchCode,
    objectId: advance.id,
  };
}

/** Recurring Contract — its terms and the period invoices it has raised. */
export async function recurringContract(ctx: BuildContext, contractNo: string): Promise<Built | null> {
  const { m, locale } = ctx;
  const found = await contracts.view(ctx.tx, contractNo).catch(() => null);
  if (!found) return null;
  const { contract, periods } = found;
  const t = (key: string) => m.admin(`payables_contracts.${key}`);
  const supplier = await supplierOf(ctx, contract.supplierId);
  const fields: Fact[] = [
    { label: t('col_no'), value: contract.contractNo, ltr: true },
    { label: m.column('status'), value: t(`status_${contract.status}`) },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.name ?? '—' },
    { label: t('description'), value: contract.description },
    { label: t('amount'), value: `${contract.amountPerPeriodTxn} ${contract.currency}`, ltr: true },
    { label: t('frequency'), value: t(contract.frequency) },
    { label: t('start_date'), value: date(contract.startDate, locale), ltr: true },
    { label: t('end_date'), value: date(contract.endDate, locale), ltr: true },
    { label: t('due_rule'), value: contract.dueRule, ltr: true },
    { label: m.column('branch_code'), value: contract.branchCode, ltr: true },
  ];
  return {
    model: document({
      title: m.print('titles.recurring_contract'),
      number: contract.contractNo,
      status: t(`status_${contract.status}`),
      posted: contract.status !== 'draft',
      fields,
      tables: [
        {
          title: t('periods'),
          columns: [
            { key: 'invoice', label: m.column('invoice_no'), kind: 'code' },
            { key: 'period', label: t('col_period'), kind: 'text' },
            { key: 'due', label: m.column('due_date'), kind: 'date' },
            { key: 'status', label: m.column('status'), kind: 'text' },
            { key: 'total', label: m.column('total_price'), kind: 'money' },
            { key: 'settled', label: m.column('allocated'), kind: 'money' },
          ],
          rows: periods.map((row) => ({
            cells: {
              invoice: row.invoiceNo,
              period: `${date(row.periodStart, locale)} – ${date(row.periodEnd, locale)}`,
              due: row.dueDate,
              status: m.status(row.status),
              total: row.totalIqd,
              settled: row.settledAmountIqd,
            },
          })),
          empty: t('no_periods'),
          totals: {
            label: m.admin('reports.totals'),
            cells: {
              total: sumMoney(periods.map((row) => row.totalIqd)),
              settled: sumMoney(periods.map((row) => row.settledAmountIqd)),
            },
          },
        },
      ],
      fileName: contract.contractNo,
    }),
    branchCode: contract.branchCode,
    objectId: contract.id,
  };
}

/** Supplier Credit Note — what was credited, against which invoice, and where it went. */
export async function supplierCreditNote(ctx: BuildContext, memoNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await notes.viewCreditByNo(tx, memoNo);
  if (!found) return null;
  const { memo, invoice, supplier, returnNo, account, applications: applied } = found;
  const t = (key: string) => m.admin(`supplier_notes.${key}`);
  const fields: Fact[] = [
    { label: t('col_no'), value: memo.memoNo, ltr: true },
    { label: m.column('status'), value: m.status(memo.status) },
    { label: m.column('supplier_code'), value: supplier?.code ?? '—', ltr: true },
    { label: m.column('supplier_name'), value: supplier?.name ?? '—' },
    { label: t('supplier_note_no'), value: memo.supplierMemoNo, ltr: true },
    { label: m.column('invoice_no'), value: invoice?.invoiceNo ?? '—', ltr: true },
    ...(returnNo ? [{ label: t('return'), value: returnNo, ltr: true }] : []),
    { label: m.column('posting_date'), value: date(memo.memoDate, locale), ltr: true },
    { label: t('amount'), value: money(memo.amountIqd, locale), ltr: true },
    { label: t('unapplied'), value: money(found.unappliedIqd, locale), ltr: true },
    { label: t('credit_account'), value: account ? `${account.code} · ${account.name}` : t('credit_account_default') },
    { label: t('reason'), value: memo.note ?? '—' },
    { label: m.column('raised_by'), value: found.raisedBy ?? '—' },
    { label: t('approved_by'), value: found.approvedBy ?? '—' },
    { label: t('posted_by'), value: found.postedBy ?? '—' },
  ];
  const live = applied.filter((row) => !row.reversedAt);
  return {
    model: document({
      title: m.print('titles.supplier_credit_note'),
      number: memo.memoNo,
      status: m.status(memo.status),
      posted: memo.journalEntryId !== null,
      fields,
      tables: [
        {
          title: t('applications'),
          columns: [
            { key: 'invoice', label: m.column('invoice_no'), kind: 'code' },
            { key: 'date', label: m.column('date'), kind: 'date' },
            { key: 'amount', label: t('amount'), kind: 'money' },
          ],
          rows: live.map((row) => ({ cells: { invoice: row.invoiceNo, date: row.appliedAt, amount: row.amountIqd } })),
          empty: t('no_applications'),
          totals: { label: m.admin('reports.totals'), cells: { amount: sumMoney(live.map((row) => row.amountIqd)) } },
        },
      ],
      signatures: true,
      fileName: memo.memoNo,
    }),
    branchCode: memo.branchCode,
    objectId: memo.id,
  };
}
