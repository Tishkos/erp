/**
 * Phase 05.7 test gate — Goods Return and Supplier Credit Memo, §8.7.
 *
 *   - A return exceeding the available return quantity is rejected
 *   - The return reverses the FIFO layers correctly, restoring the original
 *     cost relationship (§9.2)
 *   - No replacement mechanism exists anywhere in the return flow
 *   - The Supplier Credit Memo links to both the Goods Return and the original
 *     A/P Invoice
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as ap from '@/server/services/ap-invoice';
import * as ret from '@/server/services/goods-return';
import * as inventory from '@/server/services/inventory';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let supplierId: string;
let accounts: Record<string, string>;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  // 'accounting_manager+ceo' is a manager who also holds the CEO's invoice
  // approval (Operations build, blocks 4 and 5).
  for (const code of role.split('+')) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, code]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Network Cable 2m',true,'EA','batch') returning id`,
      [CABLE],
    );
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1,'EA',1,1)`,
      [rows[0].id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager+ceo');

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','SUP-001', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,2,'February 2026','2026-02-01','2026-02-28') on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
    ['return_clearing', 'L000001', 'Return Clearing'],
    ['expense', 'X000001', 'Service and Expense Cost'],
    ['purchase_variance', 'X000001', 'Purchase Price Variance'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [
        `${parent.slice(0, 1)}9${String(role.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        role === 'supplier_payable' ? 'supplier' : null,
      ],
    );
    accounts[role] = rows[0].id;

    for (const event of [
      'inventory.goods_receipt',
      'inventory.goods_return',
      'purchasing.ap_invoice',
      'purchasing.supplier_credit_memo',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
  }

  for (const documentType of ['ap_invoice', 'supplier_credit_memo', 'goods_return']) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
      [documentType],
    );
  }

  await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.setRequiredDimensions(tx, manager, accounts.purchase_variance!, []),
  );
});

async function approvedOrder(unitPrice = price('10')) {
  const order = await withScope(scope(clerk), (tx) =>
    po.create(tx, clerk, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines: [
        {
          lineType: 'inventory_item',
          itemCode: CABLE,
          description: 'Network Cable 2m',
          quantity: qty('100'),
          uomCode: 'EA',
          unitPriceIqd: unitPrice,
          branchCode: BAGHDAD,
          warehouseCode: `WH-${BAGHDAD}`,
        },
      ],
    }),
  );
  await withScope(scope(clerk), (tx) => po.submit(tx, clerk, order.id));
  await withScope(scope(manager), (tx) => po.approve(tx, manager, order.id));

  const { rows } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1`,
    [order.id],
  );
  return { ...order, lineIds: rows.map((r) => r.id) as string[] };
}

let seq = 0;
async function receive(orderId: string, poLineId: string, quantity: bigint) {
  const receipt = await withScope(scope(clerk), (tx) =>
    gr.create(tx, clerk, {
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLineId, quantity, batchNumber: `B-${(seq += 1)}` }],
    }),
  );
  await withScope(scope(clerk), (tx) => gr.submit(tx, clerk, receipt.id));
  await withScope(scope(manager), (tx) => gr.post(tx, manager, receipt.id));

  const { rows } = await ownerPool.query(
    `select id from goods_receipt_line where goods_receipt_id = $1`,
    [receipt.id],
  );
  return { ...receipt, lineIds: rows.map((r) => r.id) as string[] };
}

async function postedInvoice(orderId: string, poLineId: string, quantity: bigint) {
  const invoice = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SUP-INV-${(seq += 1)}`,
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      invoiceDate: '2026-02-10',
      dueDate: '2026-03-10',
      lines: [{ purchaseOrderLineId: poLineId, quantity, unitPriceIqd: price('10') }],
    }),
  );
  await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, invoice.id));
  await withScope(scope(manager), (tx) => ap.post(tx, manager, invoice.id));
  return invoice;
}

/** A return, raised, approved and shipped. */
async function shippedReturn(
  receiptId: string,
  receiptLineId: string,
  quantity: bigint,
  apInvoiceId?: string,
) {
  const document = await withScope(scope(clerk), (tx) =>
    ret.create(tx, clerk, {
      goodsReceiptId: receiptId,
      apInvoiceId: apInvoiceId ?? null,
      branchCode: BAGHDAD,
      returnDate: '2026-02-15',
      reason: 'Cable insulation split on 30 reels; supplier agreed collection.',
      offsetKind: 'payable',
      lines: [{ goodsReceiptLineId: receiptLineId, quantity }],
    }),
  );
  await withScope(scope(manager), (tx) => ret.approve(tx, manager, document.id));
  const posted = await withScope(scope(manager), (tx) => ret.post(tx, manager, document.id));
  return { ...document, ...posted };
}

// ---------------------------------------------------------------------------

describe('05.7 gate · a return cannot exceed the available return quantity', () => {
  it('refuses more than the delivery brought in', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('40'));

    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        ret.create(tx, clerk, {
          goodsReceiptId: receipt.id,
          branchCode: BAGHDAD,
          returnDate: '2026-02-15',
          reason: 'Damaged',
          offsetKind: 'payable',
          lines: [{ goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('60') }],
        }),
      ),
    );

    expect(error).toMatch(/Only 40 of ITM-CABLE is available to return/);
    expect(error).toMatch(/goods from another delivery are returned on their own document/i);
  });

  it('counts what has already gone back', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    await shippedReturn(receipt.id, receipt.lineIds[0]!, qty('30'));

    expect(
      await withScope(scope(manager), (tx) => ret.availableToReturn(tx, receipt.lineIds[0]!)),
    ).toBe(qty('70'));

    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        ret.create(tx, clerk, {
          goodsReceiptId: receipt.id,
          branchCode: BAGHDAD,
          returnDate: '2026-02-16',
          reason: 'More damage found',
          offsetKind: 'payable',
          lines: [{ goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('80') }],
        }),
      ),
    );
    expect(error).toMatch(/Only 70 of ITM-CABLE is available/);
  });

  it('adds up two lines of the same document against one delivery line', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));

    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        ret.create(tx, clerk, {
          goodsReceiptId: receipt.id,
          branchCode: BAGHDAD,
          returnDate: '2026-02-15',
          reason: 'Damaged',
          offsetKind: 'payable',
          lines: [
            { goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('60') },
            { goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('60') },
          ],
        }),
      ),
    );
    expect(error).toMatch(/available to return/);
  });

  it('does not let a draft return reserve anything', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));

    // Somebody is thinking about returning 100. Nothing has shipped, so the
    // whole delivery is still available — two drafts must not between them
    // reserve more than exists.
    await withScope(scope(clerk), (tx) =>
      ret.create(tx, clerk, {
        goodsReceiptId: receipt.id,
        branchCode: BAGHDAD,
        returnDate: '2026-02-15',
        reason: 'Considering a return',
        offsetKind: 'payable',
        lines: [{ goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('100') }],
      }),
    );

    expect(
      await withScope(scope(manager), (tx) => ret.availableToReturn(tx, receipt.lineIds[0]!)),
    ).toBe(qty('100'));
  });

  it('refuses a return against a delivery that never posted', async () => {
    const order = await approvedOrder();
    const draft = await withScope(scope(clerk), (tx) =>
      gr.create(tx, clerk, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        lines: [
          { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('50'), batchNumber: 'B-DRAFT' },
        ],
      }),
    );
    const { rows } = await ownerPool.query(
      `select id from goods_receipt_line where goods_receipt_id = $1`,
      [draft.id],
    );

    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        ret.create(tx, clerk, {
          goodsReceiptId: draft.id,
          branchCode: BAGHDAD,
          returnDate: '2026-02-15',
          reason: 'Damaged',
          offsetKind: 'payable',
          lines: [{ goodsReceiptLineId: rows[0].id, quantity: qty('10') }],
        }),
      ),
    );
    expect(error).toMatch(/nothing in stock to return/);
  });
});

// ---------------------------------------------------------------------------

describe('05.7 gate · the return relieves the layer the goods arrived in (§9.2)', () => {
  it('credits inventory at what the supplier charged, not at the oldest cost', async () => {
    // Two deliveries at two prices. The second is the one being returned.
    const cheap = await approvedOrder(price('10'));
    const cheapReceipt = await receive(cheap.id, cheap.lineIds[0]!, qty('100'));
    void cheapReceipt;

    const dear = await approvedOrder(price('25'));
    const dearReceipt = await receive(dear.id, dear.lineIds[0]!, qty('100'));

    const returned = await shippedReturn(dearReceipt.id, dearReceipt.lineIds[0]!, qty('40'));

    // 40 × 25 = 1,000. Taking the oldest layer would credit 400, and the credit
    // memo would then not clear the return.
    expect(returned.costIqd).toBe(price('1000'));
  });

  it('leaves the other layers untouched', async () => {
    const cheap = await approvedOrder(price('10'));
    await receive(cheap.id, cheap.lineIds[0]!, qty('100'));
    const dear = await approvedOrder(price('25'));
    const dearReceipt = await receive(dear.id, dear.lineIds[0]!, qty('100'));

    await shippedReturn(dearReceipt.id, dearReceipt.lineIds[0]!, qty('40'));

    const layers = await withScope(scope(manager), (tx) =>
      inventory.layersOf(tx, CABLE, `WH-${BAGHDAD}`),
    );
    const byCost = new Map(layers.map((l) => [l.unitCostIqd, l.remainingQuantity]));
    expect(byCost.get(price('10'))).toBe(qty('100'));
    expect(byCost.get(price('25'))).toBe(qty('60'));
  });

  it('posts Dr Return Clearing / Cr Inventory (Appendix C)', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    const returned = await shippedReturn(receipt.id, receipt.lineIds[0]!, qty('30'));

    const { rows: movement } = await ownerPool.query(
      `select journal_entry_id from inventory_movement where id = $1`,
      [returned.movementIds[0]],
    );
    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [movement[0].journal_entry_id],
    );

    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    expect(Number(byAccount.get(accounts.return_clearing)?.debit_iqd)).toBe(300);
    expect(Number(byAccount.get(accounts.inventory)?.credit_iqd)).toBe(300);
    // Not GRNI: §8.2 puts the return after the invoice, and the receipt already
    // discharged that liability.
    expect(byAccount.has(accounts.grni)).toBe(false);
  });

  it('takes the stock out of the warehouse', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    await shippedReturn(receipt.id, receipt.lineIds[0]!, qty('30'));

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(position.onHand).toBe(qty('70'));
  });

  it('refuses a return of goods that have already been sold', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));

    // 80 shipped to a customer: only 20 of that delivery are still on the shelf.
    await withScope(scope(manager), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: CABLE,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: qty('80'),
        movementDate: '2026-02-12',
        kind: 'delivery',
        batchNumber: 'B-1',
      }),
    );

    const document = await withScope(scope(clerk), (tx) =>
      ret.create(tx, clerk, {
        goodsReceiptId: receipt.id,
        branchCode: BAGHDAD,
        returnDate: '2026-02-15',
        reason: 'Supplier recall',
        offsetKind: 'payable',
        lines: [{ goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('50') }],
      }),
    );
    await withScope(scope(manager), (tx) => ret.approve(tx, manager, document.id));

    // The available *return* quantity says 100, because 100 arrived. The
    // warehouse says 20, because 80 have gone. The second is what stops it —
    // and it stops it at the same guard that stops any other issue leaving a
    // warehouse negative (§9.4).
    const error = await rejection(
      withScope(scope(manager), (tx) => ret.post(tx, manager, document.id)),
    );
    expect(error).toMatch(/Cannot issue 50 of ITM-CABLE/);
  });
});

// ---------------------------------------------------------------------------

describe('05.7 gate · no replacement mechanism exists anywhere in the return flow', () => {
  it('has no column, status or enum value that offers one', async () => {
    const { rows } = await ownerPool.query(
      `select table_name, column_name from information_schema.columns
        where table_name in ('goods_return','goods_return_line','supplier_credit_memo')
          and (column_name ilike '%replace%' or column_name ilike '%swap%'
               or column_name ilike '%exchange%')`,
    );
    expect(rows).toEqual([]);

    const { rows: enums } = await ownerPool.query(
      `select enumlabel from pg_enum where enumlabel ilike '%replace%'`,
    );
    expect(enums).toEqual([]);
  });

  it('exposes no service function that could create one', () => {
    // §8.7 — "Returned goods do not support replacement. A replacement requires
    // a new Purchase Order." Not a flag left unset: no route exists.
    const offered = Object.keys(ret).filter((name) => /replac|swap|exchange/i.test(name));
    expect(offered).toEqual(['REPLACEMENT_IS_NOT_SUPPORTED']);
    expect(ret.REPLACEMENT_IS_NOT_SUPPORTED).toMatch(/requires a new Purchase Order/);
  });

  it('names no replacement anywhere in the purchasing schema', () => {
    // The strongest form of the rule: the word does not appear as an
    // identifier in the tables this flow touches.
    const dir = join(process.cwd(), 'src/server/db/schema');
    const offenders: string[] = [];

    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const match of source.matchAll(/^\s*(\w*[Rr]eplacement\w*)\s*:/gm)) {
        offenders.push(`${file}:${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('05.7 gate · the credit memo links to both the return and the invoice', () => {
  async function returnAgainstInvoice() {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));
    const returned = await shippedReturn(receipt.id, receipt.lineIds[0]!, qty('30'), invoice.id);
    return { order, receipt, invoice, returned };
  }

  it('carries both links, and neither is optional', async () => {
    const { invoice, returned } = await returnAgainstInvoice();

    const memo = await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-5001',
        memoDate: '2026-02-20',
        amountIqd: price('300'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select goods_return_id, ap_invoice_id from supplier_credit_memo where id = $1`,
      [memo.id],
    );
    expect(rows[0].goods_return_id).toBe(returned.id);
    expect(rows[0].ap_invoice_id).toBe(invoice.id);

    const { rows: nullable } = await ownerPool.query(
      `select column_name, is_nullable from information_schema.columns
        where table_name = 'supplier_credit_memo'
          and column_name in ('goods_return_id','ap_invoice_id')`,
    );
    expect(nullable.every((r) => r.is_nullable === 'NO')).toBe(true);
  });

  it('posts Dr Supplier A/P / Cr Return Clearing', async () => {
    const { returned } = await returnAgainstInvoice();

    const memo = await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-5002',
        memoDate: '2026-02-20',
        amountIqd: price('300'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [memo.journalEntryId],
    );
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    expect(Number(byAccount.get(accounts.supplier_payable)?.debit_iqd)).toBe(300);
    expect(Number(byAccount.get(accounts.return_clearing)?.credit_iqd)).toBe(300);
  });

  it('empties Return Clearing when the credit matches the return', async () => {
    const { returned } = await returnAgainstInvoice();

    await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-5003',
        memoDate: '2026-02-20',
        amountIqd: price('300'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0) as balance
         from journal_line where account_id = $1`,
      [accounts.return_clearing],
    );
    // Sent back and credited: the account is the gap between those two events,
    // and it is now closed.
    expect(Number(rows[0].balance)).toBe(0);
  });

  it('leaves the difference visible when the supplier credits less', async () => {
    const { returned } = await returnAgainstInvoice();

    await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-5004',
        memoDate: '2026-02-20',
        amountIqd: price('250'),
        note: 'Supplier deducted a 50 restocking fee',
      }),
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0) as balance
         from journal_line where account_id = $1`,
      [accounts.return_clearing],
    );
    // 50 dinars still sitting there, for somebody to chase or write off — not
    // silently absorbed into inventory or expense.
    expect(Number(rows[0].balance)).toBe(50);
  });

  it('reduces what is owed on the invoice (§15)', async () => {
    const { invoice, returned } = await returnAgainstInvoice();

    await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-5005',
        memoDate: '2026-02-20',
        amountIqd: price('300'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select total_iqd, settled_amount_iqd, status from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(Number(rows[0].total_iqd)).toBe(1000);
    expect(Number(rows[0].settled_amount_iqd)).toBe(300);
    expect(rows[0].status).toBe('partially_executed');
  });

  it('refuses a credit memo for a return that has not shipped', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const document = await withScope(scope(clerk), (tx) =>
      ret.create(tx, clerk, {
        goodsReceiptId: receipt.id,
        apInvoiceId: invoice.id,
        branchCode: BAGHDAD,
        returnDate: '2026-02-15',
        reason: 'Damaged',
        offsetKind: 'payable',
        lines: [{ goodsReceiptLineId: receipt.lineIds[0]!, quantity: qty('30') }],
      }),
    );

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        ret.creditMemo(tx, manager, {
          goodsReturnId: document.id,
          supplierMemoNo: 'CN-5006',
          memoDate: '2026-02-20',
          amountIqd: price('300'),
        }),
      ),
    );
    expect(error).toMatch(/a return that has actually shipped/);
  });

  it('refuses a credit memo for a return with no invoice behind it', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    const returned = await shippedReturn(receipt.id, receipt.lineIds[0]!, qty('30'));

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        ret.creditMemo(tx, manager, {
          goodsReturnId: returned.id,
          supplierMemoNo: 'CN-5007',
          memoDate: '2026-02-20',
          amountIqd: price('300'),
        }),
      ),
    );
    // Nothing to reduce: the goods were rejected before anybody was invoiced.
    expect(error).toMatch(/no debt for a credit memo to reduce/);
  });

  it('shows what has been sent back and not yet credited', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('100'));
    await shippedReturn(receipt.id, receipt.lineIds[0]!, qty('30'));

    const waiting = await withScope(scope(manager), (tx) => ret.awaitingCredit(tx));

    expect(waiting).toHaveLength(1);
    expect(Number(waiting[0]!.costIqd)).toBe(300);
    expect(waiting[0]!.reason).toMatch(/insulation split/);
  });

  it('drops off that list once the credit memo lands', async () => {
    const { returned } = await returnAgainstInvoice();
    await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-5008',
        memoDate: '2026-02-20',
        amountIqd: price('300'),
      }),
    );

    expect(await withScope(scope(manager), (tx) => ret.awaitingCredit(tx))).toHaveLength(0);
  });

  it('refuses a duplicate supplier credit note number (§15)', async () => {
    const { returned } = await returnAgainstInvoice();
    await withScope(scope(manager), (tx) =>
      ret.creditMemo(tx, manager, {
        goodsReturnId: returned.id,
        supplierMemoNo: 'CN-DUP',
        memoDate: '2026-02-20',
        amountIqd: price('100'),
      }),
    );

    const second = await returnAgainstInvoice();
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          ret.creditMemo(tx, manager, {
            goodsReturnId: second.returned.id,
            supplierMemoNo: 'CN-DUP',
            memoDate: '2026-02-21',
            amountIqd: price('100'),
          }),
        ),
      ),
    ).toMatch(/supplier_credit_memo_supplier_number_uniq/);
  });
});
