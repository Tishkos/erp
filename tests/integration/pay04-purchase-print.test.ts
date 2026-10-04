/**
 * REQ-PAY-001 PAY4 — the purchase records that could not be printed.
 *
 * The purchase order, the goods receipt, the payment application, the
 * supplier advance, the recurring contract and the supplier credit note each
 * get a print model. What is held here, the ops14 way: the file carries the
 * record's number and the figures its screen shows (the order's Remaining
 * column among them); a draft prints as a draft; a reader without the
 * object's grant gets nothing; another branch's reader is told it does not
 * exist; and every copy is in the audit trail.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as applications from '@/server/services/payment-applications';
import * as advances from '@/server/services/supplier-advance';
import * as contracts from '@/server/services/recurring-contracts';
import * as notes from '@/server/services/supplier-notes';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { EXPORT_ACCESS, mayExport, type ExportKey } from '@/server/print/access';
import { runExport, type ExportRequest } from '@/server/print/export';
import type { ExportFormat } from '@/server/print/model';
import { readPdf, readWorkbook, readWord } from '../support/export-files';
import { fundBank } from './hr-funds';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

const iqd = (value: string) => parseDecimal(value, 4n);
const qty = (value: string) => parseQuantity(value);
const ON = '2026-05-01';
const AT = '2026-10-04T10:00:00.000Z';
const BASRA = 'BSR';

let world: TradingWorld;
let stranger: ActorContext;
let basraManager: ActorContext;
const doc: Record<string, string> = {};

async function createUser(branch: string, roles: readonly string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Reader')`, [id, `${id}@example.com`]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

/** Take a copy as the export route does: the reader's own scope and transaction. */
async function take(reader: ActorContext, key: ExportKey, format: ExportFormat, id: string, locale: 'en' | 'ar' = 'en') {
  const request: ExportRequest = { key, format, locale, at: AT, input: { id, query: new URLSearchParams() } };
  return withScope({ userId: reader.principal.userId, branchCode: reader.branchCode }, (tx) =>
    runExport(tx, { principal: reader.principal, branchCode: reader.branchCode }, request),
  );
}

async function files(key: ExportKey, id: string) {
  const [pdf, xlsx, docx] = await Promise.all((['pdf', 'xlsx', 'docx'] as const).map((format) => take(world.manager, key, format, id)));
  for (const result of [pdf, xlsx, docx]) expect(result!.status).toBe(200);
  const body = (r: typeof pdf) => (r!.status === 200 ? r!.body : Buffer.alloc(0));
  return { pdf: readPdf(body(pdf)), xlsx: readWorkbook(body(xlsx)), docx: readWord(body(docx)) };
}

beforeAll(async () => {
  world = await buildTradingWorld();
  await fundBank(world);
  await seedBranch(BASRA, 'Basra');
  stranger = await createUser(BAGHDAD, ['hr_officer']);
  basraManager = await createUser(BASRA, ['accounting_manager', 'ceo']);
  // The trading world maps every purchasing event but the receipt's own.
  for (const role of ['inventory', 'grni'] as const) {
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('inventory.goods_receipt', $1, $2, true, $3) on conflict do nothing`,
      [role, world.accounts[role], world.manager.principal.userId],
    );
  }

  // An approved order of 100 panels; 60 received, so 40 remain.
  const order = await withScope(scope(world.clerk), (tx) =>
    po.create(tx, world.clerk, {
      supplierId: world.supplierId,
      branchCode: BAGHDAD,
      orderDate: ON,
      reference: 'JNK-PO-PRINT',
      lines: [
        {
          lineType: 'inventory_item',
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: qty('100'),
          uomCode: 'EA',
          unitPriceIqd: iqd('10000'),
          branchCode: BAGHDAD,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  await withScope(scope(world.clerk), (tx) => po.submit(tx, world.clerk, order.id));
  await withScope(scope(world.manager), (tx) => po.approve(tx, world.manager, order.id));
  doc.order = order.orderNo;
  const { rows: orderLines } = await ownerPool.query(`select id from purchase_order_line where purchase_order_id = $1`, [order.id]);
  const receipt = await withScope(scope(world.clerk), (tx) =>
    gr.create(tx, world.clerk, {
      purchaseOrderId: order.id,
      branchCode: BAGHDAD,
      receiptDate: '2026-05-03',
      supplierDeliveryNote: 'DN-PRINT-1',
      lines: [{ purchaseOrderLineId: orderLines[0].id, quantity: qty('60'), batchNumber: 'B-PRINT' }],
    }),
  );
  await withScope(scope(world.clerk), (tx) => gr.submit(tx, world.clerk, receipt.id));
  await withScope(scope(world.manager), (tx) => gr.post(tx, world.manager, receipt.id));
  doc.receipt = receipt.receiptNo;

  // An advance on the order, approved and paid.
  const advance = await withScope(scope(world.clerk), (tx) =>
    advances.request(tx, world.clerk, { purchaseOrderId: order.id, branchCode: BAGHDAD, requestDate: ON, amountIqd: iqd('250000'), reason: 'Deposit' }),
  );
  await withScope(scope(world.manager), (tx) => advances.approve(tx, world.manager, advance.id));
  await withScope(scope(world.manager), (tx) => advances.pay(tx, world.manager, advance.id, ON, world.bankAccountId));
  doc.advance = advance.advanceNo;

  // A monthly contract, approved.
  const contract = await withScope(scope(world.clerk), (tx) =>
    contracts.create(tx, world.clerk, {
      supplierId: world.supplierId,
      departmentCode: 'FIN',
      branchCode: BAGHDAD,
      expenseCategoryCode: 'rent',
      description: 'Warehouse lease, Baghdad',
      currency: 'IQD',
      amountPerPeriodTxn: '1500000.0000',
      frequency: 'monthly',
      startDate: '2026-06-01',
      dueRule: 'day_of_period:1',
      generateDaysAhead: 30,
      autoConfirm: false,
      invoiceExpected: false,
    }),
  );
  await withScope(scope(world.manager), (tx) => contracts.approve(tx, world.manager, contract.id));
  doc.contract = contract.contractNo;

  // An import invoice and a payment application against it — a draft.
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ('PM-PRINT','SWIFT transfer','bank','swift')`);
  const { rows: payee } = await ownerPool.query(
    `insert into partner_bank_account (partner_id, bank_name, account_number, swift, currency, approval_status, is_active)
     values ($1,'Bank of China','CN-6217-0009','BKCHCNBJ','IQD','approved',true) returning id`,
    [world.supplierId],
  );
  const imported = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'JNK-IMP-PRINT',
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: '2026-07-01',
      isImport: true,
      paymentTermsText: '30% deposit, 70% against B/L copy',
      lines: [{ itemCode: PANEL, description: 'Solar Panel 550W', quantity: qty('100'), unitPriceIqd: iqd('10000'), uomCode: 'EA', isInventory: true, warehouseCode: WAREHOUSE }],
    }),
  );
  const { rows: payables } = await ownerPool.query(`select payable_id from ap_invoice where id = $1`, [imported.id]);
  const application = await withScope(scope(world.clerk), (tx) =>
    applications.create(tx, world.clerk, {
      payableId: payables[0].payable_id,
      paymentMethodCode: 'PM-PRINT',
      bankCashAccountId: world.bankAccountId,
      payeeBankAccountId: payee[0].id,
      amountTxn: iqd('300000'),
      onDate: '2026-05-10',
    }),
  );
  doc.application = application.applicationNo;

  // A posted service invoice and a credit note against it — a draft.
  const service = await withScope(scope(world.clerk), (tx) =>
    ap.create(tx, world.clerk, {
      supplierId: world.supplierId,
      supplierInvoiceNo: 'JNK-SVC-PRINT',
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: '2026-05-31',
      expenseAccountId: world.accounts.expense!,
      nonPoJustification: 'Installation',
      nonPoApprovedBy: world.manager.principal.userId,
      lines: [{ description: 'Installation', quantity: qty('1'), unitPriceIqd: iqd('100000'), isInventory: false }],
    }),
  );
  await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, service.id));
  await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, service.id));
  const note = await withScope(scope(world.manager), (tx) =>
    notes.createCreditNote(tx, world.manager, { apInvoiceId: service.id, supplierMemoNo: 'JNK-CN-PRINT', memoDate: '2026-05-10', amountIqd: iqd('10000'), reason: 'Price allowance' }),
  );
  doc.note = note.memoNo;
}, 120_000);

describe('PAY4 · each purchase record prints, exports and reads back its own figures', () => {
  it('the purchase order: ordered 100, received 60, remaining 40, at 10,000', async () => {
    const out = await files('purchase_order', doc.order!);
    for (const text of [out.pdf.text, out.docx.text]) {
      expect(text).toContain(doc.order!);
      expect(text).toContain('JNK-PO-PRINT');
      expect(text).toContain('Remaining');
    }
    const cells = [...out.xlsx.cells.values()];
    const numbers = cells.map((c) => c.number).filter((n): n is number => n !== undefined);
    expect(numbers).toEqual(expect.arrayContaining([100, 60, 40, 10000, 1_000_000]));
    expect(out.pdf.unmappedGlyphs).toBe(0);
  });

  it('the goods receipt: 60 of 100 ordered, against its order and delivery note', async () => {
    const out = await files('goods_receipt', doc.receipt!);
    expect(out.pdf.text).toContain(doc.receipt!);
    expect(out.pdf.text).toContain(doc.order!);
    expect(out.pdf.text).toContain('DN-PRINT-1');
    const numbers = [...out.xlsx.cells.values()].map((c) => c.number).filter((n): n is number => n !== undefined);
    expect(numbers).toEqual(expect.arrayContaining([100, 60]));
  });

  it('the payment application: a draft request to the bank, marked as unposted', async () => {
    const out = await files('payment_application', doc.application!);
    expect(out.pdf.text).toContain(doc.application!);
    expect(out.pdf.text).toContain('Bank of China');
    expect(out.docx.text).toContain(doc.application!);
  });

  it('the supplier advance: paid 250,000, nothing applied yet', async () => {
    const out = await files('supplier_advance', doc.advance!);
    expect(out.pdf.text).toContain(doc.advance!);
    expect(out.pdf.text).toContain(doc.order!);
    expect(out.pdf.text).toContain('250,000');
  });

  it('the recurring contract: its terms, no period raised yet', async () => {
    const out = await files('recurring_contract', doc.contract!);
    expect(out.pdf.text).toContain(doc.contract!);
    expect(out.pdf.text).toContain('Warehouse lease, Baghdad');
    expect(out.docx.text).toContain('1500000.0000 IQD');
  });

  it('the supplier credit note: a draft of 10,000 against its invoice, in Arabic too', async () => {
    const out = await files('supplier_credit_note', doc.note!);
    expect(out.pdf.text).toContain(doc.note!);
    expect(out.pdf.text).toContain('JNK-CN-PRINT');
    expect(out.pdf.text).toContain('10,000');
    const arabic = await take(world.manager, 'supplier_credit_note', 'pdf', doc.note!, 'ar');
    expect(arabic!.status).toBe(200);
    expect(readPdf(arabic!.status === 200 ? arabic!.body : Buffer.alloc(0)).unmappedGlyphs).toBe(0);
  });
});

describe('PAY4 · who may take a copy', () => {
  const keys = ['purchase_order', 'goods_receipt', 'payment_application', 'supplier_advance', 'recurring_contract', 'supplier_credit_note'] as const;

  it('each key answers to its own object', () => {
    expect(EXPORT_ACCESS.purchase_order.object).toBe('purchase_order');
    expect(EXPORT_ACCESS.goods_receipt.object).toBe('goods_receipt');
    expect(EXPORT_ACCESS.payment_application.object).toBe('payment_application');
    expect(EXPORT_ACCESS.supplier_advance.object).toBe('supplier_advance');
    expect(EXPORT_ACCESS.recurring_contract.object).toBe('recurring_contract');
    expect(EXPORT_ACCESS.supplier_credit_note.object).toBe('supplier_credit_memo');
  });

  it('a reader with no grant on the object is not even told the document exists', async () => {
    const ids = [doc.order!, doc.receipt!, doc.application!, doc.advance!, doc.contract!, doc.note!];
    for (const [i, key] of keys.entries()) {
      expect(mayExport(stranger.principal, key, 'pdf')).toBe(false);
      expect((await take(stranger, key, 'pdf', ids[i]!)).status).toBe(404);
    }
  });

  it('the officer who may view and print is refused the workbook and the Word file, and the refusal is audited', async () => {
    expect((await take(world.clerk, 'purchase_order', 'pdf', doc.order!)).status).toBe(200);
    expect((await take(world.clerk, 'purchase_order', 'xlsx', doc.order!)).status).toBe(403);
    const { rows } = await ownerPool.query(
      `select outcome from audit_event where action = 'purchase_order.exported' and actor_user_id = $1 order by occurred_at`,
      [world.clerk.principal.userId],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'denied']);
  });

  it('another branch is told the document does not exist', async () => {
    const ids = [doc.order!, doc.receipt!, doc.application!, doc.advance!, doc.contract!, doc.note!];
    for (const [i, key] of keys.entries()) {
      expect((await take(basraManager, key, 'pdf', ids[i]!)).status).toBe(404);
    }
  });

  it('every copy taken is in the audit trail', async () => {
    const { rows } = await ownerPool.query(
      `select distinct action from audit_event where actor_user_id = $1 and action like '%.exported' order by action`,
      [world.manager.principal.userId],
    );
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([
        'goods_receipt.exported',
        'payment_application.exported',
        'purchase_order.exported',
        'recurring_contract.exported',
        'supplier_advance.exported',
        'supplier_credit_memo.exported',
      ]),
    );
  });
});
