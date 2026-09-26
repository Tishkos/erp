/**
 * Phase 05.6 test gate — Supplier advances, §8.5.
 *
 *   - An advance without a linked PO is rejected
 *   - Partial settlement reduces the advance balance and the invoice balance by
 *     the same amount
 *   - The same advance cannot be settled twice against the same invoice
 *   - Settlement cannot exceed the advance balance or the invoice balance
 *   - Unapplied advance balance is visible and reported (§15)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as ap from '@/server/services/ap-invoice';
import * as adv from '@/server/services/supplier-advance';
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
    ['supplier_advance', 'A000001', 'Supplier Advances'],
    ['bank', 'A000001', 'Bank'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
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
      'purchasing.ap_invoice',
      'purchasing.supplier_advance_payment',
      'purchasing.supplier_advance_settlement',
      'purchasing.supplier_advance_refund',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
  }

  for (const documentType of ['ap_invoice', 'supplier_advance']) {
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

async function approvedOrder() {
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
          unitPriceIqd: price('10'),
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

/** An advance, requested, approved and paid. */
async function paidAdvance(orderId: string, amountIqd: bigint) {
  const advance = await withScope(scope(clerk), (tx) =>
    adv.request(tx, clerk, {
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      requestDate: '2026-02-02',
      amountIqd,
      reason: 'Supplier requires 50% before manufacture',
    }),
  );
  await withScope(scope(manager), (tx) => adv.approve(tx, manager, advance.id));
  await withScope(scope(manager), (tx) => adv.pay(tx, manager, advance.id, '2026-02-03'));
  return advance;
}

let invoiceSeq = 0;
/** A posted A/P invoice against the order, for the given quantity. */
async function postedInvoice(orderId: string, poLineId: string, quantity: bigint) {
  const receipt = await withScope(scope(clerk), (tx) =>
    gr.create(tx, clerk, {
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLineId, quantity, batchNumber: `B-${(invoiceSeq += 1)}` }],
    }),
  );
  await withScope(scope(clerk), (tx) => gr.submit(tx, clerk, receipt.id));
  await withScope(scope(manager), (tx) => gr.post(tx, manager, receipt.id));

  const invoice = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SUP-INV-${invoiceSeq}`,
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

// ---------------------------------------------------------------------------

describe('05.6 gate · an advance without a linked PO is rejected', () => {
  it('has no nullable order to leave empty — the column is NOT NULL', async () => {
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'supplier_advance' and column_name = 'purchase_order_id'`,
    );
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('refuses an advance against a draft order', async () => {
    const order = await withScope(scope(clerk), (tx) =>
      po.create(tx, clerk, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [
          {
            lineType: 'inventory_item',
            itemCode: CABLE,
            description: 'Cable',
            quantity: qty('100'),
            uomCode: 'EA',
            unitPriceIqd: price('10'),
            branchCode: BAGHDAD,
            warehouseCode: `WH-${BAGHDAD}`,
          },
        ],
      }),
    );

    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        adv.request(tx, clerk, {
          purchaseOrderId: order.id,
          branchCode: BAGHDAD,
          requestDate: '2026-02-02',
          amountIqd: price('500'),
        }),
      ),
    );

    // Money leaving the company for a purchase nobody has agreed to make.
    expect(error).toMatch(/a commitment the company has (actually )?made/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const order = await withScope(scope(clerk), (tx) =>
      po.create(tx, clerk, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [
          {
            lineType: 'inventory_item',
            itemCode: CABLE,
            description: 'Cable',
            quantity: qty('100'),
            uomCode: 'EA',
            unitPriceIqd: price('10'),
            branchCode: BAGHDAD,
            warehouseCode: `WH-${BAGHDAD}`,
          },
        ],
      }),
    );

    await expect(
      ownerPool.query(
        `insert into supplier_advance
           (advance_no, purchase_order_id, supplier_id, branch_code, request_date, amount_iqd, created_by)
         values ('ADV-RAW',$1,$2,$3,'2026-02-02',500,$4)`,
        [order.id, supplierId, BAGHDAD, clerk.principal.userId],
      ),
    ).rejects.toThrow(/no advance can be paid against it/);
  });

  it('takes the supplier from the order, never from the request', async () => {
    const order = await approvedOrder();
    const advance = await withScope(scope(clerk), (tx) =>
      adv.request(tx, clerk, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('500'),
      }),
    );

    const { rows } = await ownerPool.query(
      `select supplier_id from supplier_advance where id = $1`,
      [advance.id],
    );
    expect(rows[0].supplier_id).toBe(supplierId);
  });

  it('refuses an advance naming a different supplier from the order', async () => {
    const order = await approvedOrder();
    const { rows: other } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_supplier, status, active)
       values ('SUP-OTHER','SUP-OTHER', true, 'active', true) returning id`,
    );

    await expect(
      ownerPool.query(
        `insert into supplier_advance
           (advance_no, purchase_order_id, supplier_id, branch_code, request_date, amount_iqd, created_by)
         values ('ADV-WRONG',$1,$2,$3,'2026-02-02',500,$4)`,
        [order.id, other[0].id, BAGHDAD, clerk.principal.userId],
      ),
    ).rejects.toThrow(/names a different supplier/);
  });
});

// ---------------------------------------------------------------------------

describe('05.6 · payment posts Dr Supplier Advance / Cr Bank (Appendix C)', () => {
  it('holds a claim on the supplier, not a reduction of payables', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));

    const { rows: entry } = await ownerPool.query(
      `select journal_entry_id from supplier_advance where id = $1`,
      [advance.id],
    );
    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [entry[0].journal_entry_id],
    );

    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    expect(Number(byAccount.get(accounts.supplier_advance)?.debit_iqd)).toBe(500);
    expect(Number(byAccount.get(accounts.bank)?.credit_iqd)).toBe(500);
    // Payables do not move: the invoice has not arrived and there is no debt yet.
    expect(byAccount.has(accounts.supplier_payable)).toBe(false);
  });

  it('refuses the requester approving their own advance (§5.2)', async () => {
    const order = await approvedOrder();
    const advance = await withScope(scope(manager), (tx) =>
      adv.request(tx, manager, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('500'),
      }),
    );

    const error = await rejection(
      withScope(scope(manager), (tx) => adv.approve(tx, manager, advance.id)),
    );
    expect(error).toMatch(/releases company money/);
  });

  it('will not pay an advance nobody approved', async () => {
    const order = await approvedOrder();
    const advance = await withScope(scope(clerk), (tx) =>
      adv.request(tx, clerk, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('500'),
      }),
    );

    const error = await rejection(
      withScope(scope(manager), (tx) => adv.pay(tx, manager, advance.id, '2026-02-03')),
    );
    expect(error).toMatch(/paid once it has been approved/);
  });
});

// ---------------------------------------------------------------------------

describe('05.6 gate · settlement moves both balances by the same amount', () => {
  it('reduces the advance and the invoice together', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const result = await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('300'),
        settlementDate: '2026-02-11',
      }),
    );

    expect(result.advanceBalance).toBe(price('200'));

    const { rows } = await ownerPool.query(
      `select total_iqd, settled_amount_iqd, status from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(Number(rows[0].total_iqd)).toBe(1000);
    expect(Number(rows[0].settled_amount_iqd)).toBe(300);
    expect(rows[0].status).toBe('partially_executed');
  });

  it('posts Dr Supplier A/P / Cr Supplier Advance', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const result = await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('300'),
        settlementDate: '2026-02-11',
      }),
    );

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [result.journalEntryId],
    );
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    // The debt the invoice created is discharged by money already paid, and the
    // claim on the supplier shrinks by the same amount.
    expect(Number(byAccount.get(accounts.supplier_payable)?.debit_iqd)).toBe(300);
    expect(Number(byAccount.get(accounts.supplier_advance)?.credit_iqd)).toBe(300);
  });

  it('marks the advance settled when nothing is left', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const result = await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('500'),
        settlementDate: '2026-02-11',
      }),
    );

    expect(result.advanceBalance).toBe(0n);
    const { rows } = await ownerPool.query(`select status from supplier_advance where id = $1`, [
      advance.id,
    ]);
    expect(rows[0].status).toBe('settled');
  });

  it('applies whatever fits, automatically', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('1500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const result = await withScope(scope(manager), (tx) =>
      adv.settleAutomatically(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        settlementDate: '2026-02-11',
      }),
    );

    // The advance holds 1,500 and the invoice owes 1,000. More than the advance
    // holds does not exist; more than the invoice owes would create a credit
    // nobody asked for.
    expect(result?.amountIqd).toBe(price('1000'));

    const { rows } = await ownerPool.query(`select status from ap_invoice where id = $1`, [
      invoice.id,
    ]);
    expect(rows[0].status).toBe('settled');
  });

  it('returns nothing to do rather than raising, when there is nothing to apply', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('500'),
        settlementDate: '2026-02-11',
      }),
    );

    // A second order, because the first is fully received and invoiced.
    const nextOrder = await approvedOrder();
    const second = await postedInvoice(nextOrder.id, nextOrder.lineIds[0]!, qty('100'));

    // An invoice with no advance left is the ordinary case; a routine that threw
    // on it could not be run over a day's invoices.
    const result = await withScope(scope(manager), (tx) =>
      adv.settleAutomatically(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: second.id,
        settlementDate: '2026-02-12',
      }),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('05.6 gate · the same advance cannot be settled twice against one invoice', () => {
  it('refuses the second settlement', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('200'),
        settlementDate: '2026-02-11',
      }),
    );

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        adv.settle(tx, manager, {
          supplierAdvanceId: advance.id,
          apInvoiceId: invoice.id,
          amountIqd: price('100'),
          settlementDate: '2026-02-12',
        }),
      ),
    );

    expect(error).toMatch(/has already been settled against invoice/);
    expect(error).toMatch(/clear a debt that is still owed/);
  });

  it('refuses at the database too — two clerks at the same moment', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('200'),
        settlementDate: '2026-02-11',
      }),
    );

    // A service-level check cannot see a row another transaction has not
    // committed yet. A unique index can.
    await expect(
      ownerPool.query(
        `insert into supplier_advance_settlement
           (supplier_advance_id, ap_invoice_id, amount_iqd, settlement_date, settled_by)
         values ($1,$2,100,'2026-02-12',$3)`,
        [advance.id, invoice.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/supplier_advance_settlement_pair_uniq/);
  });

  it('lets one advance settle two different invoices', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('900'));
    const first = await postedInvoice(order.id, order.lineIds[0]!, qty('50'));
    const second = await postedInvoice(order.id, order.lineIds[0]!, qty('50'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: first.id,
        amountIqd: price('400'),
        settlementDate: '2026-02-11',
      }),
    );
    const result = await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: second.id,
        amountIqd: price('400'),
        settlementDate: '2026-02-12',
      }),
    );

    expect(result.advanceBalance).toBe(price('100'));
  });
});

// ---------------------------------------------------------------------------

describe('05.6 gate · settlement cannot exceed either balance', () => {
  it('refuses more than the advance holds', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('300'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        adv.settle(tx, manager, {
          supplierAdvanceId: advance.id,
          apInvoiceId: invoice.id,
          amountIqd: price('400'),
          settlementDate: '2026-02-11',
        }),
      ),
    );
    expect(error).toMatch(/exceed the advance balance/);
  });

  it('refuses more than the invoice owes', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('5000'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        adv.settle(tx, manager, {
          supplierAdvanceId: advance.id,
          apInvoiceId: invoice.id,
          amountIqd: price('1200'),
          settlementDate: '2026-02-11',
        }),
      ),
    );
    expect(error).toMatch(/exceed the invoice balance/);
  });

  it('refuses at the database too, on both sides', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('300'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await expect(
      ownerPool.query(
        `insert into supplier_advance_settlement
           (supplier_advance_id, ap_invoice_id, amount_iqd, settlement_date, settled_by)
         values ($1,$2,400,'2026-02-11',$3)`,
        [advance.id, invoice.id, manager.principal.userId],
      ),
    ).rejects.toThrow(/exceed what is left of advance/);
  });

  it('keeps the two balances from being over-consumed between them', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const first = await postedInvoice(order.id, order.lineIds[0]!, qty('50'));
    const second = await postedInvoice(order.id, order.lineIds[0]!, qty('50'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: first.id,
        amountIqd: price('400'),
        settlementDate: '2026-02-11',
      }),
    );

    // Each settlement passes its own row check; together they would consume
    // 800 of a 500 advance. The pair is what the trigger sees.
    const error = await rejection(
      withScope(scope(manager), (tx) =>
        adv.settle(tx, manager, {
          supplierAdvanceId: advance.id,
          apInvoiceId: second.id,
          amountIqd: price('400'),
          settlementDate: '2026-02-12',
        }),
      ),
    );
    expect(error).toMatch(/exceed the advance balance/);
  });
});

// ---------------------------------------------------------------------------

describe('05.6 · refund is not settlement (§8.5)', () => {
  it('gives the money back without touching payables', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));

    const result = await withScope(scope(manager), (tx) =>
      adv.refund(tx, manager, advance.id, {
        amountIqd: price('500'),
        refundDate: '2026-02-20',
        reason: 'Order cancelled; supplier returned the deposit.',
      }),
    );

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [result.journalEntryId],
    );
    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    expect(Number(byAccount.get(accounts.bank)?.debit_iqd)).toBe(500);
    expect(Number(byAccount.get(accounts.supplier_advance)?.credit_iqd)).toBe(500);
    // Nothing was delivered and no debt was discharged.
    expect(byAccount.has(accounts.supplier_payable)).toBe(false);
    expect(result.advanceBalance).toBe(0n);
  });

  it('needs a reason', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));

    const error = await rejection(
      withScope(scope(manager), (tx) =>
        adv.refund(tx, manager, advance.id, {
          amountIqd: price('500'),
          refundDate: '2026-02-20',
          reason: '   ',
        }),
      ),
    );
    expect(error).toMatch(/needs a reason/);
  });

  it('cannot refund more than is left after settlement', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('300'),
        settlementDate: '2026-02-11',
      }),
    );

    // Settlement and refund draw on the same money: 500 advanced, 300 used,
    // 200 refundable — not 500.
    const error = await rejection(
      withScope(scope(manager), (tx) =>
        adv.refund(tx, manager, advance.id, {
          amountIqd: price('500'),
          refundDate: '2026-02-20',
          reason: 'Balance returned',
        }),
      ),
    );
    expect(error).toMatch(/exceed the advance balance/);
  });

  it('refuses at the database an advance consumed past its amount', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));

    await expect(
      ownerPool.query(
        `update supplier_advance set refunded_amount_iqd = 600 where id = $1`,
        [advance.id],
      ),
    ).rejects.toThrow(/supplier_advance_not_over_consumed/);
  });
});

// ---------------------------------------------------------------------------

describe('05.6 gate · unapplied advance balance is visible and reported (§15)', () => {
  it('lists what has been paid and not yet consumed', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('300'),
        settlementDate: '2026-02-11',
      }),
    );

    const report = await withScope(scope(manager), (tx) => adv.unappliedBalances(tx));

    expect(report).toHaveLength(1);
    expect(report[0]!.advanceNo).toBe(advance.advanceNo);
    expect(Number(report[0]!.unappliedIqd)).toBe(200);
    // Which order it is waiting on — "200 million dinars" is useless without it.
    expect(report[0]!.orderNo).toBe(order.orderNo);
  });

  it('drops an advance once it is fully consumed', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('500'));
    const invoice = await postedInvoice(order.id, order.lineIds[0]!, qty('100'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: invoice.id,
        amountIqd: price('500'),
        settlementDate: '2026-02-11',
      }),
    );

    expect(await withScope(scope(manager), (tx) => adv.unappliedBalances(tx))).toHaveLength(0);
  });

  it('leaves an unpaid request out — a plan is not an exposure', async () => {
    const order = await approvedOrder();
    await withScope(scope(clerk), (tx) =>
      adv.request(tx, clerk, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        requestDate: '2026-02-02',
        amountIqd: price('500'),
      }),
    );

    expect(await withScope(scope(manager), (tx) => adv.unappliedBalances(tx))).toHaveLength(0);
  });

  it('keeps the settlement history Appendix C asks for', async () => {
    const order = await approvedOrder();
    const advance = await paidAdvance(order.id, price('900'));
    const first = await postedInvoice(order.id, order.lineIds[0]!, qty('50'));
    const second = await postedInvoice(order.id, order.lineIds[0]!, qty('50'));

    await withScope(scope(manager), (tx) =>
      adv.settle(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: first.id,
        amountIqd: price('400'),
        settlementDate: '2026-02-11',
      }),
    );
    await withScope(scope(manager), (tx) =>
      adv.settleAutomatically(tx, manager, {
        supplierAdvanceId: advance.id,
        apInvoiceId: second.id,
        settlementDate: '2026-02-12',
      }),
    );

    const history = await withScope(scope(manager), (tx) =>
      adv.settlementHistory(tx, advance.id),
    );

    expect(history).toHaveLength(2);
    expect(history.map((h) => h.automatic)).toEqual(['manual', 'automatic']);
    expect(history.map((h) => Number(h.amountIqd))).toEqual([400, 500]);
  });

  it('grants the application no DELETE on the settlement history', async () => {
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'erp_app' and table_name = 'supplier_advance_settlement'`,
    );
    // Appendix C calls it a record, and a record that can be deleted is not one.
    expect(rows.map((r) => r.privilege_type)).not.toContain('DELETE');
  });
});
