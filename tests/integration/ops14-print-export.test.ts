/**
 * Printing and exporting — every Operations Build document and report.
 *
 * The claims under test are the ones a person relies on when they hand a
 * printed invoice to a supplier or an exported statement to an auditor:
 *
 *   - the file's figures are the service's figures, and the ledger's;
 *   - a statement's closing balance is the one on the screen;
 *   - an unposted document cannot pass for a posted one;
 *   - a reader without `print` or `export` gets nothing, and another branch's
 *     document does not exist for them;
 *   - every copy taken is in the audit trail, with an ISO timestamp;
 *   - Arabic is right to left, in the embedded font, with no glyph missing.
 *
 * Each file is read back the way a reader's software reads it (see
 * tests/support/export-files.ts), not inspected as a model.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as banks from '@/server/services/bank-cash-accounts';
import * as gr from '@/server/services/goods-return';
import * as opening from '@/server/services/opening-stock';
import * as pay from '@/server/services/supplier-payment';
import * as receipts from '@/server/services/customer-receipt';
import * as shipments from '@/server/services/supplier-shipment';
import * as sr from '@/server/services/sales-return';
import * as statement from '@/server/services/partner-statement';
import * as stock from '@/server/services/stock-operations';
import * as inventoryReports from '@/server/services/inventory-reports';
import * as trialBalance from '@/server/services/trial-balance';
import { mappedLines } from '@/server/domain/posting-map';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { formatStatementAmount } from '@/i18n/config';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { mayExport, EXPORT_KEYS, type ExportKey } from '@/server/print/access';
import { runExport, type ExportRequest, type ExportResult } from '@/server/print/export';
import { messagesFor } from '@/server/print/i18n';
import type { ExportFormat, PrintModel } from '@/server/print/model';
import { renderPdf } from '@/server/print/pdf';
import { letterheadFor } from '@/server/print/letterhead';
import { evaluateSum, readPdf, readWord, readWorkbook, type Workbook } from '../support/export-files';

const BAGHDAD = 'BGW';
const BASRA = 'BSR';
const PANEL = 'ITM-PANEL';
const MAIN = 'WH-MAIN';
const SECOND = 'WH-SECOND';
const ON = '2026-04-01';
const YEAR = { from: '2026-01-01', to: '2026-12-31' } as const;
const AT = '2026-09-26T10:00:00.000Z';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);
const money = (amount: string | number) => formatStatementAmount(amount, 'IQD', 'en');

let clerk: ActorContext;
let manager: ActorContext;
let ceo: ActorContext;
let viewer: ActorContext;
let basraManager: ActorContext;
let supplierId: string;
let customerId: string;
let bankCode: string;
let bankAccountId: string;
let accounts: Record<string, string>;

const doc: Record<string, { id: string; no: string }> = {};

async function createUser(branch: string, ...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    `User ${roles.join('+') || 'none'}`,
  ]);
  for (const role of roles) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: ctx.branchCode });

/** Take a copy, as the export route does: the reader's own scope and transaction. */
async function take(
  reader: ActorContext,
  key: ExportKey,
  format: ExportFormat,
  input: { id?: string | null; query?: Record<string, string> } = {},
  locale: 'en' | 'ar' = 'en',
) {
  const request: ExportRequest = {
    key,
    format,
    locale,
    at: AT,
    input: { id: input.id ?? null, query: new URLSearchParams(input.query ?? {}) },
  };
  return withScope(scope(reader), (tx) =>
    runExport(tx, { principal: reader.principal, branchCode: reader.branchCode }, request),
  );
}

async function takeAll(key: ExportKey, input: { id?: string | null; query?: Record<string, string> } = {}) {
  const [pdf, xlsx, docx] = await Promise.all(
    (['pdf', 'xlsx', 'docx'] as const).map((format) => take(manager, key, format, input)),
  );
  for (const result of [pdf, xlsx, docx]) expect(result!.status).toBe(200);
  const body = (r: typeof pdf) => (r!.status === 200 ? r!.body : Buffer.alloc(0));
  return {
    pdf: readPdf(body(pdf)),
    xlsx: readWorkbook(body(xlsx)),
    docx: readWord(body(docx)),
    fileNames: [pdf, xlsx, docx].map((r) => (r!.status === 200 ? r!.fileName : '')),
  };
}

/** The total row of a workbook's first table: its formula evaluated, and the value stored beside it. */
function workbookTotals(book: Workbook) {
  return [...book.cells.values()]
    .filter((cell) => cell.formula)
    .map((cell) => ({ ref: cell.ref, stored: cell.number, evaluated: evaluateSum(cell.formula!, book.cells) }));
}

/** A long document for the page rules: n lines of wrapping names, unposted. */
function sample(lines: number, locale: 'en' | 'ar', names: readonly string[] = []): PrintModel {
  const m = messagesFor(locale);
  return {
    kind: 'document',
    title: m.print('titles.purchase_invoice'),
    number: 'API-BGW-2026-999999',
    status: m.status('draft'),
    posted: false,
    orientation: 'portrait',
    fields: [{ label: m.column('supplier_name'), value: 'شركة النور للتجارة العامة' }],
    filters: [],
    tables: [
      {
        columns: [
          { key: 'item_code', label: m.column('item_code'), kind: 'code' },
          { key: 'item_name', label: m.column('item_name'), kind: 'text' },
          { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
          { key: 'total', label: m.column('total_price'), kind: 'money' },
        ],
        rows: Array.from({ length: lines }, (_, i) => ({
          cells: {
            item_code: `ITM-${String(i + 1).padStart(6, '0')}`,
            item_name: names[i] ?? `Split air conditioner ${i + 1} with a description long enough to wrap`,
            quantity: '2.000000',
            total: '1250000.0000',
          },
        })),
        empty: '—',
        totals: { label: m.admin('reports.totals'), cells: { total: String(1_250_000 * lines) } },
      },
    ],
    summary: [],
    signatures: true,
    currency: 'IQD',
    fileName: 'API-BGW-2026-999999',
    sheetName: 'Sample',
  };
}

const head = (locale: 'en' | 'ar') =>
  withScope(scope(manager), (tx) =>
    letterheadFor(tx, { locale, userId: manager.principal.userId, branchCode: BAGHDAD, at: AT }),
  );

async function ledger(role: string): Promise<number> {
  const { rows } = await ownerPool.query(
    `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
       from journal_line l join journal_entry e on e.id = l.journal_entry_id
      where l.account_id = $1 and e.status in ('posted','reversed')`,
    [accounts[role]],
  );
  return Number(rows[0].balance);
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(BASRA, 'Basra');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`,
  );

  clerk = await createUser(BAGHDAD, 'accounting_officer');
  manager = await createUser(BAGHDAD, 'accounting_manager');
  ceo = await createUser(BAGHDAD, 'ceo');
  basraManager = await createUser(BASRA, 'accounting_manager');
  // Somebody who may read a purchase invoice and nothing more.
  await ownerPool.query(
    `insert into role (code, name, description, is_system) values ('invoice_reader','Invoice reader','Reads invoices',false)
     on conflict do nothing`,
  );
  await ownerPool.query(
    `insert into role_grant (role_code, object, verb) values ('invoice_reader','ap_invoice','view') on conflict do nothing`,
  );
  viewer = await createUser(BAGHDAD, 'invoice_reader');

  accounts = {};
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['inventory', 'A000001', 'Inventory', null],
    ['bank', 'A000001', 'Bank Current Account', null],
    // REQ-AP-001 §9.2 — the posting map's landed-cost clearing role (Stage 2).
    ['landed_cost_clearing', 'A000001', 'Landed Cost Clearing', null],
    // REQ-AP-001 §15.7 — the loan register's roles (Stage 6).
    ['loan_liability', 'L000001', 'Bank Loans', 'loan'],
    ['bank_commission', 'X000001', 'Bank Commission', null],
    ['loan_interest', 'X000001', 'Loan Interest', null],
    ['customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['customer_clearing', 'A000001', 'Receipts Not Yet Identified', null],
    ['supplier_payable', 'L000001', 'Trade Payables', 'supplier'],
    ['grni', 'L000001', 'Goods Received Not Invoiced', null],
    ['return_clearing', 'L000001', 'Return Clearing', null],
    ['opening_balance', 'E000001', 'Opening Balance Equity', null],
    ['sales_revenue', 'R000001', 'Product Sales', null],
    ['sales_returns', 'R000001', 'Sales Returns', null],
    ['cogs', 'X000001', 'Cost of Goods Sold', null],
    ['expense', 'X000001', 'Service and Expense Cost', null],
    ['purchase_variance', 'X000001', 'Purchase Price Variance', null],
    ['inventory_adjustment', 'X000001', 'Inventory Adjustments', null],
    // REQ-PM-001 PM-5 — a project certificate's and a recognition run's roles.
    ['project_revenue', 'R000001', 'Contract Revenue', null],
    ['project_retention_receivable', 'A000001', 'Retention Receivable', 'customer'],
    ['project_wip', 'A000001', 'Unbilled Contract Work', null],
    ['project_deferred_revenue', 'L000001', 'Billings in Excess of Work', null],
    // REQ-PM-001 PM-6 — material issues, labour and settlement.
    ['project_material_cost', 'X000001', 'Project Material Cost', null],
    ['project_labour', 'X000001', 'Project Labour Cost', null],
    ['labour_absorption', 'X000001', 'Labour Absorbed', null],
    ['project_auc', 'A000001', 'Assets Under Construction', null],
    ['project_cost', 'X000001', 'Project Cost Settled', null],
    // REQ-FIX-001 FIX-3 — the supplier advance's events and the import's exchange difference.
    ['supplier_advance', 'A000001', 'Supplier Advances', null],
    ['exchange_gain', 'R000001', 'Realised Exchange Gain', null],
    ['exchange_loss', 'X000001', 'Realised Exchange Loss', null],
    // REQ-HR-001 HR-3 — a payroll run's cost, what it withholds and the net it owes.
    ['salary_expense', 'X000001', 'Salaries and Wages', null],
    ['payroll_employer_cost', 'X000001', 'Employer Social Security', null],
    ['payroll_withholding', 'L000001', 'Payroll Deductions Payable', null],
    ['net_pay', 'L000001', 'Salaries Payable', null],
    // REQ-HR-001 HR-4 — what people owe on advances and loans.
    ['employee_advance', 'A000001', 'Employee Advances and Loans', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [
      parent,
    ]);
    serial += 1;
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`${parent.slice(0, 1)}8${String(serial).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
    await withScope(scope(manager), (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }
  for (const mapped of mappedLines()) {
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ($1,$2,$3,true,$4) on conflict do nothing`,
      [mapped.event, mapped.role, accounts[mapped.role], manager.principal.userId],
    );
  }

  const client = await ownerPool.connect();
  let itemId: string;
  try {
    await client.query('begin');
    const { rows: item } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking,
                         inventory_account_id, cogs_account_id, sales_account_id)
       values ($1,'لوح شمسي 550 واط',true,'EA','batch',$2,$3,$4) returning id`,
      [PANEL, accounts.inventory, accounts.cogs, accounts.sales_revenue],
    );
    itemId = item[0].id;
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator) values ($1,'EA',1,1)`,
      [itemId],
    );
    await client.query('commit');
  } finally {
    client.release();
  }

  for (const [code, name, stage] of [
    [MAIN, 'Main Warehouse', null],
    [SECOND, 'Second Warehouse', null],
    ['WH-INPROC', 'In Process', 'in_process'],
    ['WH-BOARD', 'On Board', 'on_board'],
    ['WH-PORT', 'On Port', 'on_port'],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type, shipment_stage)
       values ($1,$2,$3,'main',$4) on conflict do nothing`,
      [code, name, BAGHDAD, stage],
    );
  }

  const partner = async (code: string, name: string, customer: boolean) => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
       values ($1,$2,$3,$4,'active',true) returning id`,
      [code, name, customer, !customer],
    );
    return rows[0].id as string;
  };
  supplierId = await partner('SUP-A', 'شركة النور للتجارة العامة', false);
  customerId = await partner('CUS-1', 'Customer One', true);
  await ownerPool.query(`insert into item_supplier (item_id, supplier_id, active) values ($1,$2,true)`, [
    itemId,
    supplierId,
  ]);

  const bank = await withScope(scope(manager), (tx) =>
    banks.create(tx, manager, 'bank', {
      name: 'Rafidain Current Account',
      bankName: 'Rafidain Bank',
      accountNumber: 'RF-9001',
      currency: 'IQD',
      glAccountId: accounts.bank!,
    }),
  );
  bankCode = bank.code;
  const { rows: banked } = await ownerPool.query(`select id from bank_cash_account where code = $1`, [bank.code]);
  bankAccountId = banked[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code='FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,4,'April 2026','2026-04-01','2026-04-30') on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  // ── The documents ──────────────────────────────────────────────────────
  const purchase = async (quantity: string, unitPrice: string, warehouseCode = MAIN) => {
    const made = await withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: '',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        dueDate: '2026-05-01',
        lines: [
          {
            itemCode: PANEL,
            description: null,
            quantity: qty(quantity),
            unitPriceIqd: price(unitPrice),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode,
          },
        ],
      }),
    );
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, made.id));
    return made;
  };

  // A posted purchase invoice: 20 panels at 1,250,000.
  const posted = await purchase('20', '1250000');
  await withScope(scope(ceo), (tx) => ap.post(tx, ceo, posted.id));
  doc.purchase = { id: posted.id, no: posted.invoiceNo };
  const { rows: apLines } = await ownerPool.query(`select id from ap_invoice_line where ap_invoice_id = $1`, [posted.id]);

  // One still waiting for the CEO: it must say so on every copy.
  const waiting = await purchase('3', '1000000');
  doc.draftPurchase = { id: waiting.id, no: waiting.invoiceNo };

  // A posted sales invoice: 8 panels at 1,500,000.
  const sale = await withScope(scope(clerk), (tx) =>
    ar.createDirect(tx, clerk, {
      customerId,
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: '2026-05-20',
      lines: [{ itemCode: PANEL, quantity: qty('8'), unitPriceIqd: price('1500000'), warehouseCode: MAIN, supplierId }],
    }),
  );
  await withScope(scope(ceo), (tx) => ar.approve(tx, ceo, sale.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, sale.id));
  doc.sale = { id: sale.id, no: sale.invoiceNo };
  const { rows: arLines } = await ownerPool.query(`select id from ar_invoice_line where ar_invoice_id = $1`, [sale.id]);

  // A payment of 10,000,000, part of it allocated to the purchase.
  const payment = await withScope(scope(clerk), (tx) =>
    pay.create(tx, clerk, {
      supplierId,
      bankCashAccountId: bankAccountId,
      branchCode: BAGHDAD,
      paymentDate: ON,
      amountIqd: price('10000000'),
      reference: 'CHQ-100',
    }),
  );
  await withScope(scope(manager), (tx) => pay.post(tx, manager, payment.id));
  await withScope(scope(manager), (tx) =>
    pay.allocate(tx, manager, { supplierPaymentId: payment.id, apInvoiceId: posted.id, amountIqd: price('7500000') }),
  );
  const { rows: paid } = await ownerPool.query(`select payment_no from supplier_payment where id = $1`, [payment.id]);
  doc.payment = { id: payment.id, no: paid[0].payment_no };

  // A receipt of 6,000,000, all of it allocated to the sale.
  const receipt = await withScope(scope(manager), (tx) =>
    receipts.create(tx, manager, {
      customerId,
      branchCode: BAGHDAD,
      receiptDate: ON,
      bankCashAccountId: bankAccountId,
      amountIqd: price('6000000'),
      bankReference: 'TRF-2',
    }),
  );
  await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));
  await withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id));
  await withScope(scope(manager), (tx) =>
    receipts.allocate(tx, manager, receipt.id, [{ arInvoiceId: sale.id, amountIqd: price('6000000') }]),
  );
  const { rows: received } = await ownerPool.query(`select receipt_no from customer_receipt where id = $1`, [receipt.id]);
  doc.receipt = { id: receipt.id, no: received[0].receipt_no };

  // A sales return of 2, accepted.
  const returned = await withScope(scope(clerk), (tx) =>
    sr.request(tx, clerk, {
      arInvoiceId: sale.id,
      requestedOn: ON,
      reason: 'Returned by the customer',
      offsetKind: 'receivable',
      lines: [{ arInvoiceLineId: arLines[0].id, quantity: qty('2') }],
    }),
  );
  const returnView = await withScope(scope(manager), (tx) => sr.view(tx, returned.id));
  await withScope(scope(manager), (tx) =>
    sr.receiveGoods(tx, manager, returned.id, {
      receivedOn: ON,
      lines: [{ salesReturnLineId: returnView.lines[0]!.id, quantity: qty('2') }],
    }),
  );
  await withScope(scope(manager), async (tx) => {
    const document = await sr.view(tx, returned.id);
    await sr.inspect(
      tx,
      manager,
      returned.id,
      document.lines.map((line) => ({
        salesReturnLineId: line.id,
        acceptedQuantity: parseQuantity(line.receivedQuantity ?? line.requestedQuantity),
        disposition: 'saleable' as const,
        destinationWarehouseCode: MAIN,
      })),
    );
    return sr.acceptAndSettle(tx, manager, returned.id);
  });
  doc.salesReturn = { id: returned.id, no: returned.returnNo };

  // A purchase return of 1, sent back against the payable.
  const sentBack = await withScope(scope(clerk), (tx) =>
    gr.createFromInvoice(tx, clerk, {
      apInvoiceId: posted.id,
      returnDate: ON,
      reason: 'Damaged',
      offsetKind: 'payable',
      lines: [{ apInvoiceLineId: apLines[0].id, quantity: qty('1') }],
    }),
  );
  await withScope(scope(manager), (tx) => gr.approve(tx, manager, sentBack.id));
  await withScope(scope(manager), (tx) => gr.post(tx, manager, sentBack.id));
  doc.purchaseReturn = { id: sentBack.id, no: sentBack.returnNo };

  // A transfer, an opening stock approved by someone else, and a reconciliation.
  const moved = await withScope(scope(clerk), (tx) =>
    stock.transfer(tx, clerk, {
      itemCode: PANEL,
      fromWarehouseCode: MAIN,
      toWarehouseCode: SECOND,
      quantity: qty('4'),
      transferDate: ON,
    }),
  );
  doc.transfer = { id: moved.id, no: moved.transferNo };
  const opened = await withScope(scope(clerk), (tx) =>
    opening.raise(tx, clerk, {
      branchCode: BAGHDAD,
      warehouseCode: SECOND,
      documentDate: ON,
      lines: [{ itemCode: PANEL, quantity: qty('3'), uomCode: '', unitCostIqd: price('1100000'), costLayerDate: ON }],
    }),
  );
  await withScope(scope(manager), (tx) => opening.approve(tx, manager, opened.id, { post: true }));
  doc.opening = { id: opened.id, no: opened.documentNo };
  const adjusted = await withScope(scope(manager), (tx) =>
    stock.adjust(tx, manager, {
      itemCode: PANEL,
      warehouseCode: SECOND,
      direction: 'out',
      quantity: qty('1'),
      adjustmentDate: ON,
    }),
  );
  doc.adjustment = { id: adjusted.id, no: adjusted.adjustmentNo };

  // A shipment through its first stage, for Invoice Status Tracking.
  const shipped = await purchase('2', '900000', 'WH-INPROC');
  await withScope(scope(ceo), (tx) => ap.post(tx, ceo, shipped.id));
  const { rows: opens } = await ownerPool.query(`select id from supplier_shipment where ap_invoice_id = $1`, [shipped.id]);
  if (opens[0]) await withScope(scope(manager), (tx) => shipments.advance(tx, manager, opens[0].id, 'on_board', null));
  doc.shipment = { id: shipped.id, no: shipped.invoiceNo };
}, 120_000);

// ---------------------------------------------------------------------------
describe('documents · every format carries the number and the service’s totals', () => {
  it('Purchase Invoice: the total equals the invoice, the payable it posted, and every format', async () => {
    const { rows } = await ownerPool.query(`select total_iqd::float as total from ap_invoice where id = $1`, [doc.purchase!.id]);
    expect(rows[0].total).toBe(25_000_000);
    // AP Cr 25,000,000 for this invoice and 1,800,000 for the shipment's;
    // Dr 10,000,000 paid and 1,250,000 returned.
    expect(await ledger('supplier_payable')).toBe(-25_000_000 - 1_800_000 + 10_000_000 + 1_250_000);

    const files = await takeAll('purchase_invoice', { id: doc.purchase!.no });
    expect(files.fileNames).toEqual(['pdf', 'xlsx', 'docx'].map((ext) => `${doc.purchase!.no}.${ext}`));
    for (const text of [files.pdf.text, files.docx.text]) {
      expect(text).toContain(doc.purchase!.no);
      expect(text).toContain('Purchase Invoice');
      expect(text).toContain(money(25_000_000));
      expect(text).toContain('Prepared by');
      expect(text).toContain('Approved by (CEO)');
      expect(text).toContain('Received by');
    }
    expect(workbookTotals(files.xlsx)).toEqual([expect.objectContaining({ stored: 25_000_000, evaluated: 25_000_000 })]);
    expect(files.xlsx.strings).toContain(doc.purchase!.no);
    expect(files.pdf.unmappedGlyphs).toBe(0);
  });

  it('Sales Invoice: the total equals the invoice and the receivable it posted', async () => {
    const { rows } = await ownerPool.query(`select net_iqd::float as net from ar_invoice where id = $1`, [doc.sale!.id]);
    expect(rows[0].net).toBe(12_000_000);
    // AR Dr / Revenue Cr 12,000,000.
    expect(await ledger('sales_revenue')).toBe(-12_000_000);
    const files = await takeAll('sales_invoice', { id: doc.sale!.no });
    expect(files.pdf.text).toContain(doc.sale!.no);
    expect(files.pdf.text).toContain(money(12_000_000));
    expect(files.docx.text).toContain(money(12_000_000));
    expect(workbookTotals(files.xlsx)).toEqual([expect.objectContaining({ stored: 12_000_000, evaluated: 12_000_000 })]);
    // The line names the supplier its stock was sold from.
    expect(files.pdf.text).toContain('SUP-A');
  });

  it('Supplier Payment: lists its invoice allocation, and totals what the payment says it allocated', async () => {
    const files = await takeAll('supplier_payment', { id: doc.payment!.no });
    for (const text of [files.pdf.text, files.docx.text]) {
      expect(text).toContain(doc.payment!.no);
      expect(text).toContain(doc.purchase!.no); // the allocation
      expect(text).toContain(money(7_500_000));
      expect(text).toContain('SUP-A');
      expect(text).toContain(bankCode);
    }
    expect(workbookTotals(files.xlsx)).toEqual([expect.objectContaining({ stored: 7_500_000, evaluated: 7_500_000 })]);
    const { rows } = await ownerPool.query(
      `select amount_iqd::float as amount, allocated_amount_iqd::float as allocated from supplier_payment where id = $1`,
      [doc.payment!.id],
    );
    expect(rows[0]).toEqual({ amount: 10_000_000, allocated: 7_500_000 });
  });

  it('Customer Receipt: lists its invoice allocation', async () => {
    const files = await takeAll('customer_receipt', { id: doc.receipt!.no });
    expect(files.pdf.text).toContain(doc.receipt!.no);
    expect(files.pdf.text).toContain(doc.sale!.no);
    expect(files.docx.text).toContain(money(6_000_000));
    expect(workbookTotals(files.xlsx)).toEqual([expect.objectContaining({ stored: 6_000_000, evaluated: 6_000_000 })]);
  });

  it('Sales and Purchase Returns: the returned quantities, the number, and the signature boxes', async () => {
    const sales = await takeAll('sales_return', { id: doc.salesReturn!.no });
    expect(sales.pdf.text).toContain(doc.salesReturn!.no);
    expect(sales.pdf.text).toContain('Received by');
    expect(workbookTotals(sales.xlsx)).toEqual([expect.objectContaining({ stored: 2, evaluated: 2 })]);
    const purchase = await takeAll('purchase_return', { id: doc.purchaseReturn!.no });
    expect(purchase.docx.text).toContain(doc.purchaseReturn!.no);
    expect(workbookTotals(purchase.xlsx)).toEqual([expect.objectContaining({ stored: 1, evaluated: 1 })]);
  });

  it('Transfer, Opening Stock and Item Reconciliation print, and Opening Stock totals its lines', async () => {
    const transfer = await takeAll('transfer', { id: doc.transfer!.no });
    expect(transfer.pdf.text).toContain(doc.transfer!.no);
    expect(transfer.pdf.text).toContain(SECOND);
    const openingStock = await takeAll('opening_stock', { id: doc.opening!.no });
    // 3 × 1,100,000, and the average unit price it was brought in at.
    expect(openingStock.pdf.text).toContain(money(3_300_000));
    expect(openingStock.pdf.text).toContain('1,100,000');
    expect(workbookTotals(openingStock.xlsx)).toEqual([expect.objectContaining({ stored: 3_300_000, evaluated: 3_300_000 })]);
    expect(await ledger('opening_balance')).toBe(-3_300_000);
    const reconciliation = await takeAll('item_reconciliation', { id: doc.adjustment!.no });
    expect(reconciliation.docx.text).toContain(doc.adjustment!.no);
    expect(reconciliation.docx.text).toContain('Out');
  });
});

// ---------------------------------------------------------------------------
describe('a document that has not posted can never pass for one that has', () => {
  it('marks the waiting invoice DRAFT / NOT POSTED in all three formats, and the posted one in none', async () => {
    const draft = await takeAll('purchase_invoice', { id: doc.draftPurchase!.no });
    expect(draft.pdf.text).toContain('DRAFT / NOT POSTED');
    // Word: the watermark image sits behind the text in the page header.
    expect(draft.docx.headers).toMatch(/behindDoc="1"/);
    expect(draft.xlsx.strings).toContain('DRAFT / NOT POSTED');

    const posted = await takeAll('purchase_invoice', { id: doc.purchase!.no });
    expect(posted.pdf.text).not.toContain('DRAFT / NOT POSTED');
    expect(posted.docx.headers).not.toMatch(/behindDoc="1"/);
    expect(posted.xlsx.strings).not.toContain('DRAFT / NOT POSTED');
  });
});

// ---------------------------------------------------------------------------
describe('statements · the export closes where the screen does', () => {
  it.each([
    ['customer_statement', 'customer', 'CUS-1'],
    ['supplier_statement', 'supplier', 'SUP-A'],
  ] as const)('%s', async (key, side, code) => {
    // What the screen shows: the same service, the same default period.
    const screen = await withScope(scope(manager), (tx) =>
      statement.statementFor(tx, side, code, { ...YEAR, currency: 'IQD' }),
    );
    const query = { code, from: YEAR.from, to: YEAR.to, currency: 'IQD' };
    const files = await takeAll(key, { query });
    const closing = money(screen.closing);
    expect(files.pdf.text).toContain(closing);
    expect(files.docx.text).toContain(closing);
    expect(files.pdf.text).toContain('Opening balance');
    expect(files.pdf.text).toContain('Closing balance');
    /*
     * The workbook: debit and credit are formulas over the lines; the closing
     * balance is the running balance's last figure, stored as the number.
     *
     * Both must be *among* the formula totals rather than the whole of them.
     * The sheet also carries "What is still owed", whose own totals row is
     * three more formulas — and that table now appears whenever the account
     * has a balance, including one raised by journal with no invoice behind
     * it, which is exactly the case these fixtures build. Asserting equality
     * with the set would be asserting that the second table is absent.
     */
    const evaluated = workbookTotals(files.xlsx).map((t) => t.evaluated);
    expect(evaluated).toContain(Number(screen.totalDebit));
    expect(evaluated).toContain(Number(screen.totalCredit));
    expect([...files.xlsx.cells.values()].some((cell) => cell.number === Number(screen.closing))).toBe(true);
    // And the filters it was run with are on it.
    expect(files.pdf.text).toContain(code);
  });

  it('customer statement: sale Debit, receipt and return Credit, closing at what is still owed', async () => {
    const screen = await withScope(scope(manager), (tx) =>
      statement.statementFor(tx, 'customer', 'CUS-1', { ...YEAR, currency: 'IQD' }),
    );
    // 12,000,000 sold, 6,000,000 received, 3,000,000 returned.
    expect(Number(screen.closing)).toBe(3_000_000);
    expect(await ledger('customer_receivable')).toBe(3_000_000);
  });

  it('Bank Account Statement: money in Debit, out Credit, closing as the account stands', async () => {
    // What the account's own screen shows: its ledger account's postings.
    const screen = await withScope(scope(manager), (tx) =>
      statement.ledgerStatementFor(tx, { code: bankCode, glAccountCode: 'A800002' }, { ...YEAR, currency: 'IQD' }),
    );
    expect(Number(screen.closing)).toBe(6_000_000 - 10_000_000);
    // The receipt in as Debit, the payment out as Credit, each by its number.
    expect(screen.lines.map((line) => [line.document?.number, Number(line.debit), Number(line.credit)])).toEqual([
      [doc.payment!.no, 0, 10_000_000],
      [doc.receipt!.no, 6_000_000, 0],
    ]);
    const files = await takeAll('bank_statement', { id: bankCode, query: { from: YEAR.from, to: YEAR.to } });
    expect(files.pdf.text).toContain(money(screen.closing));
    expect(files.pdf.text).toContain('Bank Account Statement');
    expect(await ledger('bank')).toBe(Number(screen.closing));
  });
});

// ---------------------------------------------------------------------------
describe('reports · the filters on the screen, and the figures', () => {
  it('Trial Balance: the totals equal the service, the formula sums only the top-level rows', async () => {
    const rows = await withScope(scope(manager), (tx) =>
      trialBalance.trialBalance(tx, { ...YEAR, currency: 'IQD', allPermittedBranches: true }),
    );
    const totals = trialBalance.totalsOf(rows);
    expect(totals.balances).toBe(true);
    for (const level of ['1', '2']) {
      const files = await takeAll('trial_balance', { query: { ...YEAR, currency: 'IQD', level } });
      const formulas = workbookTotals(files.xlsx);
      expect(formulas.map((f) => f.evaluated)).toEqual([Number(totals.debit), Number(totals.credit)]);
      expect(formulas.map((f) => f.stored)).toEqual([Number(totals.debit), Number(totals.credit)]);
      expect(files.pdf.text).toContain(money(totals.debit));
      expect(files.pdf.text).toContain(`Level ${level}`);
    }
  });

  it('Warehouses Report, Stock Movement and Invoice Status Tracking print what the screen filters to', async () => {
    const warehouses = await takeAll('warehouses_report', { query: { warehouse: SECOND } });
    expect(warehouses.pdf.text).toContain('Second Warehouse');
    expect(warehouses.pdf.text).not.toContain('Main Warehouse');
    const valued = await withScope(scope(manager), (tx) =>
      inventoryReports.valuation(tx, manager.principal, { allPermittedBranches: true, warehouseCode: SECOND }),
    );
    const value = valued.reduce((sum, row) => sum + Number(row.valueIqd), 0);
    expect(value).toBeGreaterThan(0);
    expect(workbookTotals(warehouses.xlsx)).toEqual([expect.objectContaining({ stored: value, evaluated: value })]);

    const movements = await takeAll('stock_movement', { query: { from: ON, to: ON, warehouse: SECOND } });
    expect(movements.pdf.text).toContain(doc.transfer!.no);
    expect(movements.pdf.text).toContain(doc.adjustment!.no);
    expect(movements.pdf.text).not.toContain(doc.sale!.no); // sold from the main warehouse

    const tracking = await takeAll('invoice_status_tracking', { query: {} });
    expect(tracking.pdf.text).toContain(doc.shipment!.no);
    expect(tracking.pdf.text).toContain('Stage history');
    expect(tracking.docx.text).toContain('On Board');
  });

  it('Stock Ledger: a table per warehouse, the service’s closing figure, and no copy without an item', async () => {
    const ledger = await withScope(scope(manager), (tx) =>
      stock.ledger(tx, { principal: manager.principal, branchCode: BAGHDAD }, { itemCode: PANEL, from: YEAR.from, to: YEAR.to }),
    );
    // The panel moved in both warehouses, so the copy has two ledgers in it.
    expect(ledger.length).toBeGreaterThan(1);
    const titleOf = (account: (typeof ledger)[number]) => `${account.warehouseName} · ${account.warehouseCode}`;

    const files = await takeAll('stock_ledger', { query: { item: PANEL, ...YEAR } });
    const figures = [...files.xlsx.cells.values()].flatMap((cell) => (cell.number === undefined ? [] : [cell.number]));
    for (const account of ledger) {
      // Each warehouse is its own named table, closing where the service says
      // it closes — the figure the Warehouses Report states.
      expect(files.pdf.text).toContain(account.warehouseName);
      expect(files.xlsx.strings).toContain(titleOf(account));
      expect(files.docx.text).toContain(account.warehouseName);
      expect(figures).toContain(Number(account.closing));
    }
    expect(files.pdf.text).toContain(doc.transfer!.no);
    expect(files.pdf.unmappedGlyphs).toBe(0);

    // One warehouse asked for is one ledger printed. The other warehouse's
    // name still appears in the From column of the transfer — that is the
    // row saying where the stock came from, not a second ledger.
    const second = ledger.find((account) => account.warehouseCode === SECOND)!;
    const main = ledger.find((account) => account.warehouseCode === MAIN)!;
    const one = await takeAll('stock_ledger', { query: { item: PANEL, warehouse: SECOND, ...YEAR } });
    expect(one.xlsx.strings).toContain(titleOf(second));
    expect(one.xlsx.strings).not.toContain(titleOf(main));

    // A ledger is of one thing: without an item there is nothing to copy.
    expect((await take(manager, 'stock_ledger', 'pdf', { query: { ...YEAR } })).status).toBe(404);
  });

  it('the financial statements and the General Ledger export with their own figures', async () => {
    for (const key of ['income_statement', 'balance_sheet', 'changes_in_equity', 'cash_flow', 'gl_inquiry'] as const) {
      const files = await takeAll(key, { query: { ...YEAR, currency: 'IQD' } });
      expect(files.pdf.pages).toBeGreaterThan(0);
      expect(files.pdf.unmappedGlyphs).toBe(0);
    }
    const account = await takeAll('gl_account', { id: 'A800002', query: { ...YEAR } });
    expect(account.pdf.text).toContain('A800002');
  });
});

// ---------------------------------------------------------------------------
describe('who may take a copy', () => {
  it('gives the officer the PDF (print) but not Excel or Word (export), and audits the refusal', async () => {
    expect((await take(clerk, 'purchase_invoice', 'pdf', { id: doc.purchase!.no })).status).toBe(200);
    expect((await take(clerk, 'purchase_invoice', 'xlsx', { id: doc.purchase!.no })).status).toBe(403);
    expect((await take(clerk, 'purchase_invoice', 'docx', { id: doc.purchase!.no })).status).toBe(403);
    const { rows } = await ownerPool.query(
      `select outcome, after_value from audit_event
        where action = 'ap_invoice.exported' and actor_user_id = $1 order by occurred_at`,
      [clerk.principal.userId],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'denied', 'denied']);
  });

  it('offers a reader with neither verb no menu, and refuses every format', async () => {
    for (const format of ['pdf', 'xlsx', 'docx'] as const) {
      expect(mayExport(viewer.principal, 'purchase_invoice', format)).toBe(false);
      expect((await take(viewer, 'purchase_invoice', format, { id: doc.purchase!.no })).status).toBe(403);
    }
    // Not even the existence of a document they may not see.
    expect((await take(viewer, 'sales_invoice', 'pdf', { id: doc.sale!.no })).status).toBe(404);
  });

  it('never hands another branch its documents or its figures by URL', async () => {
    for (const [key, id] of [
      ['purchase_invoice', doc.purchase!.no],
      ['supplier_payment', doc.payment!.no],
      ['transfer', doc.transfer!.no],
      ['opening_stock', doc.opening!.no],
    ] as const) {
      expect((await take(basraManager, key, 'pdf', { id })).status).toBe(404);
    }
    // The statement exists for them — the partner is shared — but carries
    // none of Baghdad's postings.
    const files = await take(basraManager, 'customer_statement', 'xlsx', { query: { code: 'CUS-1', ...YEAR } });
    expect(files.status).toBe(200);
    if (files.status === 200) {
      const book = readWorkbook(files.body);
      expect(book.strings).not.toContain(doc.sale!.no);
      expect(workbookTotals(book).map((t) => t.evaluated)).toEqual([0, 0]);
    }
  });

  it('gives every Operations Build export a print and an export grant to the roles that read it', async () => {
    // REQ-HR-001 HR-3 — the payroll run is a sheet of salaries: the clerk,
    // who reads no compensation (D-HR-7), has no copy of it; a payslip goes to
    // whoever row security lets read it.
    const COMPENSATION_GATED: readonly ExportKey[] = ['payroll_run'];
    for (const key of EXPORT_KEYS) {
      expect(mayExport(manager.principal, key, 'pdf')).toBe(true);
      expect(mayExport(manager.principal, key, 'xlsx')).toBe(true);
      expect(mayExport(clerk.principal, key, 'pdf')).toBe(!COMPENSATION_GATED.includes(key));
    }
  });
});

// ---------------------------------------------------------------------------
describe('every copy is in the audit trail', () => {
  it('records who, which document, which format and language, and when — as an ISO string', async () => {
    const before = await ownerPool.query(`select count(*)::int as n from audit_event where action = 'ar_invoice.exported'`);
    const result = await take(manager, 'sales_invoice', 'docx', { id: doc.sale!.no }, 'ar');
    expect(result.status).toBe(200);
    const { rows } = await ownerPool.query(
      `select actor_user_id, object_id, branch_code, outcome, after_value from audit_event
        where action = 'ar_invoice.exported' order by occurred_at desc limit 1`,
    );
    expect(Number(before.rows[0].n) + 1).toBe(
      Number((await ownerPool.query(`select count(*)::int as n from audit_event where action = 'ar_invoice.exported'`)).rows[0].n),
    );
    expect(rows[0]).toMatchObject({
      actor_user_id: manager.principal.userId,
      object_id: doc.sale!.id,
      branch_code: BAGHDAD,
      outcome: 'success',
    });
    expect(rows[0].after_value).toMatchObject({
      format: 'docx',
      language: 'ar',
      document: doc.sale!.no,
      fileName: `${doc.sale!.no}.docx`,
      exportedAt: AT,
    });
  });

  it('records a report with the filters it was run with', async () => {
    await take(manager, 'trial_balance', 'xlsx', { query: { from: '2026-04-01', to: '2026-04-30', currency: 'IQD' } });
    const { rows } = await ownerPool.query(
      `select after_value from audit_event where action = 'trial_balance.exported' order by occurred_at desc limit 1`,
    );
    expect(rows[0].after_value).toMatchObject({
      format: 'xlsx',
      report: 'trial_balance',
      filters: { from: '2026-04-01', to: '2026-04-30', currency: 'IQD' },
    });
  });
});

// ---------------------------------------------------------------------------
describe('Arabic · right to left, in the embedded font, with nothing missing', () => {
  it('lays each format out right to left and names the document in Arabic', async () => {
    const [pdf, xlsx, docx] = await Promise.all(
      (['pdf', 'xlsx', 'docx'] as const).map((format) =>
        take(manager, 'purchase_invoice', format, { id: doc.purchase!.no }, 'ar'),
      ),
    );
    const body = (r: ExportResult | undefined) => (r?.status === 200 ? r.body : Buffer.alloc(0));
    const paper = readPdf(body(pdf));
    // Drawn in visual order, so an Arabic word reads back reversed.
    expect(paper.text).toContain([...'فاتورة'].reverse().join(''));
    expect(paper.text).toContain(doc.purchase!.no);
    expect(paper.text).toContain(money(25_000_000));
    expect(paper.fonts).toEqual(expect.arrayContaining(['IBMPlexSansArabic-Regular', 'IBMPlexSansArabic-Bold']));
    expect(paper.unmappedGlyphs).toBe(0);

    const book = readWorkbook(body(xlsx));
    expect(book.rightToLeft).toBe(true);
    expect(book.sheetName).toBe('فاتورة شراء');
    expect(book.frozenRows).toBeGreaterThan(0);

    const word = readWord(body(docx));
    expect(word.body).toMatch(/<w:bidiVisual\/>/);
    expect(word.body).toMatch(/<w:tblHeader\/>/);
    expect(word.body).toMatch(/<w:cantSplit\/>/);
    expect(word.text).toContain('فاتورة شراء');
    expect(word.text).toContain('شركة النور للتجارة العامة');
    expect(word.fontNames).toEqual(['IBM Plex Sans Arabic']);
  });

  it('draws every character the Arabic prints use from the embedded font — no box anywhere', async () => {
    const m = messagesFor('ar');
    const titles = Object.values(
      JSON.parse(readFileSync('messages/ar.json', 'utf8')).print.titles as Record<string, string>,
    );
    const words = [
      ...titles,
      m.print('watermark'),
      m.print('allocations'),
      m.print('history'),
      m.admin('reports.totals'),
      m.admin('partners.statement_opening'),
      m.admin('partners.statement_closing'),
      'شركة النور للتجارة العامة (Al-Noor) — 1,250,000 د.ع. ٠١٢٣٤٥٦٧٨٩ «مرحّل»',
    ];
    const paper = readPdf(await renderPdf(sample(words.length, 'ar', words), await head('ar')));
    // A glyph the font does not have is drawn as glyph 0, the box.
    expect(paper.unmappedGlyphs).toBe(0);
    expect(paper.text).toContain([...'مسودة'].reverse().join(''));
  });

  it.each(['en', 'ar'] as const)(
    'prints a long %s document with the letterhead, the table heading and "Page n of N" on every page',
    async (locale) => {
      const paper = readPdf(await renderPdf(sample(90, locale), await head(locale)));
      expect(paper.pages).toBeGreaterThan(2);
      const heading = locale === 'ar' ? [...'رمز الصنف'].reverse().join('') : 'Item Code';
      for (const [index, page] of paper.pageText.entries()) {
        expect(page).toContain('Qimah Al-Safinah');
        expect(page).toContain(heading);
        // "Page 2 of 5" — in Arabic "صفحة 2 من 5", read back in the order it is drawn.
        expect(page).toMatch(
          locale === 'ar'
            ? new RegExp(`${paper.pages}\\s*نم\\s*${index + 1}\\s*ةحفص`)
            : new RegExp(`Page ${index + 1} of ${paper.pages}`),
        );
      }
      // Every line whole on one page: each of the 90 codes appears exactly once.
      for (let n = 1; n <= 90; n += 1) {
        const code = `ITM-${String(n).padStart(6, '0')}`;
        expect(paper.pageText.filter((page) => page.includes(code))).toHaveLength(1);
      }
    },
  );
});
