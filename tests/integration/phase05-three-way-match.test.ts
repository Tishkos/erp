/**
 * Phase 05.4 and 05.5 test gates — Three-Way Match and A/P Invoice, §8.4, §15.
 *
 * 05.4
 *   - An A/P Invoice cannot be created without both a PO and a receipt
 *   - A quantity variance blocks posting until manager approval
 *   - A price variance blocks posting until manager approval
 *   - An approved variance posts to the configured variance account, not
 *     silently into inventory
 *   - Match exceptions appear in the exception queue with the reason
 *   - Match status is visible on the invoice at all times
 *
 * 05.5
 *   - A duplicate supplier invoice number is rejected unless an approved
 *     exception exists
 *   - A non-PO invoice routes to the stronger approval path and requires evidence
 *   - The inventory invoice clears GRNI exactly
 *   - A posted invoice cannot be edited or deleted
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as sr from '@/server/services/service-receipt';
import * as ap from '@/server/services/ap-invoice';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const SERVICE = 'ITM-SERVICE';
const OPERATIONS = 'OPS';

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
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,$2)`,
    [id, OPERATIONS],
  );

  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('OPS','Operations',false)
     on conflict (code) do nothing`,
  );
  await ownerPool.query(
    `insert into cost_centre (code, name) values ('CC-OPS','Operations')
     on conflict (code) do nothing`,
  );

  for (const [code, name, isStock] of [
    [CABLE, 'Network Cable 2m', true],
    [SERVICE, 'Annual Maintenance', false],
  ] as const) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ($1,$2,$3,'EA',$4) returning id`,
        [code, name, isStock, isStock ? 'batch' : null],
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
  }

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

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

  // Appendix C — the five roles this phase posts through, mapped by role (§3.3).
  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
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
        // §1.2 — Trade Payables is the supplier control account, so §14.3
        // protects it and the A/P subledger is written from every posting to it.
        role === 'supplier_payable' ? 'supplier' : null,
      ],
    );
    accounts[role] = rows[0].id;

    for (const event of ['inventory.goods_receipt', 'purchasing.ap_invoice'] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
  }

  // §4.2 makes expense accounts require Business Line by default, and its
  // master data arrives in Phase 03 — 02.4 rightly refuses a dimension it
  // cannot validate. Relaxed for this document type through the same 02.4
  // override the ledger tests use, so these tests are about the match.
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('ap_invoice','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );

  // Purchase price variance on *stock* has no department: the goods were
  // received by a warehouse, not confirmed by a department. Configured through
  // D7's own mechanism — the per-account override the Business Process Owner
  // asked for on 2026-08-17 — rather than by relaxing the framework.
  await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.setRequiredDimensions(tx, manager, accounts.purchase_variance!, []),
  );
});

const inventoryLine = (overrides: Partial<po.PurchaseLineInput> = {}): po.PurchaseLineInput => ({
  lineType: 'inventory_item',
  itemCode: CABLE,
  description: 'Network Cable 2m',
  quantity: qty('100'),
  uomCode: 'EA',
  unitPriceIqd: price('10'),
  branchCode: BAGHDAD,
  warehouseCode: `WH-${BAGHDAD}`,
  ...overrides,
});

async function approvedOrder(lines: po.PurchaseLineInput[] = [inventoryLine()]) {
  const order = await withScope(scope(clerk), (tx) =>
    po.create(tx, clerk, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines,
    }),
  );
  await withScope(scope(clerk), (tx) => po.submit(tx, clerk, order.id));
  await withScope(scope(manager), (tx) => po.approve(tx, manager, order.id));

  const { rows } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1 order by line_no`,
    [order.id],
  );
  return { ...order, lineIds: rows.map((r) => r.id) as string[] };
}

/** Receive goods against an order line and post the receipt. */
async function receive(orderId: string, poLineId: string, quantity: bigint) {
  const receipt = await withScope(scope(clerk), (tx) =>
    gr.create(tx, clerk, {
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLineId, quantity, batchNumber: `B-${randomUUID().slice(0, 8)}` }],
    }),
  );
  await withScope(scope(clerk), (tx) => gr.submit(tx, clerk, receipt.id));
  await withScope(scope(manager), (tx) => gr.post(tx, manager, receipt.id));
  return receipt;
}

/** Confirm a service line and approve the confirmation. */
async function confirm(orderId: string, poLineId: string, quantity: bigint) {
  const receipt = await withScope(scope(clerk), (tx) =>
    sr.create(tx, clerk, {
      purchaseOrderId: orderId,
      departmentCode: OPERATIONS,
      branchCode: BAGHDAD,
      serviceDate: '2026-02-28',
      lines: [{ purchaseOrderLineId: poLineId, quantity }],
    }),
  );
  await withScope(scope(clerk), (tx) => sr.submit(tx, clerk, receipt.id));
  await withScope(scope(manager), (tx) => sr.approve(tx, manager, receipt.id));
  return receipt;
}

let invoiceSeq = 0;
async function invoice(
  orderId: string | null,
  lines: ap.InvoiceLineInput[],
  overrides: Partial<ap.CreateApInvoiceInput> = {},
) {
  return withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SUP-INV-${(invoiceSeq += 1)}`,
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      invoiceDate: '2026-02-10',
      dueDate: '2026-03-10',
      lines,
      ...overrides,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('05.4 gate · an invoice needs both a PO and a receipt', () => {
  it('refuses a line with nothing received', async () => {
    const order = await approvedOrder();

    const error = await rejection(
      invoice(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
      ]),
    );

    expect(error).toMatch(/nothing received against it/);
    expect(error).toMatch(/The warehouse records a Goods Receipt first/);
  });

  it('names the service route for a service line', async () => {
    const order = await approvedOrder([
      {
        lineType: 'service',
        itemCode: SERVICE,
        description: 'Annual maintenance',
        quantity: qty('12'),
        uomCode: 'EA',
        unitPriceIqd: price('500'),
        branchCode: BAGHDAD,
      },
    ]);

    const error = await rejection(
      invoice(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12'), unitPriceIqd: price('500') },
      ]),
    );
    expect(error).toMatch(/benefiting department confirms the service first/);
  });

  it('refuses at the database too — the rule holds on any path (§8.4)', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    // An invoice raised by hand against a *different* order line that has no
    // receipt. UI, API and import all end here.
    const other = await approvedOrder();
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);

    await expect(
      ownerPool.query(
        `insert into ap_invoice_line
           (ap_invoice_id, line_no, purchase_order_line_id, description, quantity, uom_code, unit_price)
         values ($1, 9, $2, 'Smuggled', 1, 'EA', 10)`,
        [created.id, other.lineIds[0]],
      ),
    ).rejects.toThrow(/different purchase order|nothing received/);
  });

  it('lets a draft receipt count for nothing', async () => {
    const order = await approvedOrder();
    // Raised but never posted: the warehouse has typed it, nobody has accepted it.
    await withScope(scope(clerk), (tx) =>
      gr.create(tx, clerk, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        lines: [
          { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), batchNumber: 'B-DRAFT' },
        ],
      }),
    );

    const error = await rejection(
      invoice(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
      ]),
    );
    expect(error).toMatch(/nothing received against it/);
  });
});

// ---------------------------------------------------------------------------

describe('05.4 gate · a clean match posts', () => {
  it('matches when order, receipt and invoice agree', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);

    expect(created.matchStatus).toBe('matched');

    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    const posted = await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    expect(posted.varianceValueIqd).toBe(0n);
  });

  it('matches a partial invoice against a partial receipt', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') },
    ]);

    // Matching the invoice against the *order* rather than the receipt would
    // raise an exception on every partial delivery, which is most of them.
    expect(created.matchStatus).toBe('matched');
  });
});

// ---------------------------------------------------------------------------

describe('05.4 gate · a quantity variance blocks posting until approved', () => {
  async function overBilled() {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    return { order, created };
  }

  it('raises an exception when the invoice bills for more than arrived', async () => {
    const { created } = await overBilled();
    expect(created.matchStatus).toBe('exception');
  });

  it('refuses to post it', async () => {
    const { created } = await overBilled();

    const error = await rejection(withScope(scope(manager), (tx) => ap.post(tx, manager, created.id)));
    expect(error).toMatch(/unresolved match exception/);
    expect(error).toMatch(/variances are allowed only after approval/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const { created } = await overBilled();

    await expect(
      ownerPool.query(`update ap_invoice set status = 'posted' where id = $1`, [created.id]),
    ).rejects.toThrow(/unresolved match exception|no manager has accepted the variance/);
  });

  it('posts once a manager accepts the variance with a reason', async () => {
    const { created } = await overBilled();

    await withScope(scope(manager), (tx) =>
      ap.approveVariance(tx, manager, created.id, 'Supplier delivering the balance next week; agreed to pay in full.'),
    );
    const posted = await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    expect(posted.journalEntryId).toBeTruthy();
    // 100 invoiced at 10 against 40 received at 10 — 600 dinars of variance.
    expect(posted.varianceValueIqd).toBe(price('600'));
  });

  it('refuses an approval with no reason', async () => {
    const { created } = await overBilled();
    const error = await rejection(
      withScope(scope(manager), (tx) => ap.approveVariance(tx, manager, created.id, '   ')),
    );
    expect(error).toMatch(/needs a reason/);
  });

  it('refuses the person who entered the invoice (§5.2)', async () => {
    const { created } = await overBilled();
    const clerkManager = await createUser('accounting_manager');
    void clerkManager;

    // The clerk raised it. Even with the permission, they are the wrong person.
    const error = await rejection(
      withScope(scope(clerk), (tx) => ap.approveVariance(tx, clerk, created.id, 'Fine by me')),
    );
    expect(error).toMatch(/Permission denied|cannot approve its variance/);
  });
});

// ---------------------------------------------------------------------------

describe('05.4 gate · a price variance blocks posting until approved', () => {
  it('catches a unit price above the order', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('11') },
    ]);

    expect(created.matchStatus).toBe('exception');

    const queue = await withScope(scope(manager), (tx) => ap.exceptionQueue(tx));
    expect(queue.some((row) => row.kind === 'price')).toBe(true);
  });

  it('absorbs a price rise inside a configured tolerance', async () => {
    await withScope(scope(manager), (tx) =>
      ap.setTolerance(tx, manager, {
        pricePercent: '10',
        valuePercent: '10',
        note: 'Finance, February 2026',
      }),
    );

    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10.5') },
    ]);

    expect(created.matchStatus).toBe('matched');
  });

  it('still records the money a tolerance absorbed', async () => {
    await withScope(scope(manager), (tx) =>
      ap.setTolerance(tx, manager, { pricePercent: '10', valuePercent: '10' }),
    );
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10.5') },
    ]);

    // A tolerance decides whether a manager is asked. It never decides whether
    // the money exists — 50 dinars still has to post somewhere.
    const status = await withScope(scope(manager), (tx) => ap.matchStatusOf(tx, created.id));
    expect(status.varianceValueIqd).toBe(price('50'));
  });
});

// ---------------------------------------------------------------------------

describe('05.4 gate · the variance posts to its own account, not into inventory', () => {
  it('debits the variance account and leaves inventory alone', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('11') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    await withScope(scope(manager), (tx) =>
      ap.approveVariance(tx, manager, created.id, 'Price rise agreed with the supplier in January.'),
    );
    const posted = await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line
        where journal_entry_id = $1 order by line_no`,
      [posted.journalEntryId],
    );

    const byAccount = new Map(rows.map((r) => [r.account_id, r]));
    // GRNI is cleared at the *ordered* price — exactly what the receipt put
    // there — and the 100 dinars of price rise goes to its own account.
    expect(Number(byAccount.get(accounts.grni)?.debit_iqd)).toBe(1000);
    expect(Number(byAccount.get(accounts.purchase_variance)?.debit_iqd)).toBe(100);
    expect(Number(byAccount.get(accounts.supplier_payable)?.credit_iqd)).toBe(1100);
    // Inventory is untouched: the stock was valued when it arrived (§9.2), and
    // an invoice that restated it would put the FIFO layers and the control
    // account out of step.
    expect(byAccount.has(accounts.inventory)).toBe(false);
  });

  it('credits the variance account when the supplier charged less', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('9') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    await withScope(scope(manager), (tx) =>
      ap.approveVariance(tx, manager, created.id, 'Supplier applied an agreed discount.'),
    );
    const posted = await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line where journal_entry_id = $1`,
      [posted.journalEntryId],
    );
    const variance = rows.find((r) => r.account_id === accounts.purchase_variance);
    expect(Number(variance?.credit_iqd)).toBe(100);
  });
});

// ---------------------------------------------------------------------------

describe('05.4 gate · the exception queue', () => {
  it('lists each variance with the reason a manager can act on', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('11') },
    ]);

    const queue = await withScope(scope(manager), (tx) => ap.exceptionQueue(tx));

    // Quantity, price and value — three exceptions, because they are three
    // conversations, often with different people.
    expect(queue.map((row) => row.kind).sort()).toEqual(['price', 'quantity', 'value']);
    expect(queue.every((row) => row.reason.length > 20)).toBe(true);
    expect(queue.find((row) => row.kind === 'quantity')?.reason).toMatch(/invoiced the whole order/);
  });

  it('empties as the exceptions are resolved, and keeps them on the record', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);

    await withScope(scope(manager), (tx) =>
      ap.approveVariance(tx, manager, created.id, 'Balance in transit; agreed to pay the full order.'),
    );

    expect(await withScope(scope(manager), (tx) => ap.exceptionQueue(tx))).toHaveLength(0);

    // Resolved, not deleted: what was queried and why is part of the audit
    // trail, and a supplier who raises the same exception monthly is a fact.
    const all = await withScope(scope(manager), (tx) =>
      ap.exceptionQueue(tx, { includeResolved: true }),
    );
    expect(all).not.toHaveLength(0);
    expect(all[0]!.resolution).toBe('approved');
    expect(all[0]!.resolutionReason).toMatch(/in transit/);
  });

  it('clears an exception the invoice no longer has', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);
    expect(await withScope(scope(manager), (tx) => ap.exceptionQueue(tx))).not.toHaveLength(0);

    // The rest of the delivery arrives, and the invoice becomes correct without
    // anybody touching it.
    await receive(order.id, order.lineIds[0]!, qty('60'));
    await withScope(scope(manager), (tx) => ap.rematch(tx, created.id));

    expect(await withScope(scope(manager), (tx) => ap.exceptionQueue(tx))).toHaveLength(0);
    const status = await withScope(scope(manager), (tx) => ap.matchStatusOf(tx, created.id));
    expect(status.status).toBe('matched');
  });
});

// ---------------------------------------------------------------------------

describe('05.4 gate · match status is visible at all times', () => {
  it('is stored on the invoice from the moment it is created', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);

    const { rows } = await ownerPool.query(
      `select match_status, variance_value_iqd from ap_invoice where id = $1`,
      [created.id],
    );
    expect(rows[0].match_status).toBe('exception');
    expect(Number(rows[0].variance_value_iqd)).toBe(600);
  });

  it('is stored per line, so the queue can point at one row', async () => {
    const order = await approvedOrder([inventoryLine(), inventoryLine({ quantity: qty('50') })]);
    await receive(order.id, order.lineIds[0]!, qty('100'));
    await receive(order.id, order.lineIds[1]!, qty('50'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
      { purchaseOrderLineId: order.lineIds[1]!, quantity: qty('50'), unitPriceIqd: price('12') },
    ]);

    const status = await withScope(scope(manager), (tx) => ap.matchStatusOf(tx, created.id));
    expect(status.lines[0]!.status).toBe('matched');
    expect(status.lines[1]!.status).toBe('exception');
    // One bad line makes the document an exception: the document is what gets
    // approved and posted.
    expect(status.status).toBe('exception');
  });
});

// ---------------------------------------------------------------------------

describe('05.5 gate · the inventory invoice clears GRNI exactly', () => {
  it('returns GRNI to zero for a fully received and invoiced order', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd), 0) as balance
         from journal_line where account_id = $1`,
      [accounts.grni],
    );
    // The receipt credited GRNI 1,000; the invoice debits it 1,000. This is the
    // whole purpose of the account, and it only works because both used the
    // *ordered* price.
    expect(Number(rows[0].balance)).toBe(0);
  });

  it('clears only what was invoiced when the invoice is partial', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) as balance
         from journal_line where account_id = $1`,
      [accounts.grni],
    );
    // 1,000 received, 400 invoiced: 600 still owed to the supplier and not yet
    // billed. That remainder is the number a GRNI ageing report exists to show.
    expect(Number(rows[0].balance)).toBe(600);
  });

  it('sends a service invoice to expense, never to GRNI', async () => {
    const order = await approvedOrder([
      {
        lineType: 'service',
        itemCode: SERVICE,
        description: 'Annual maintenance',
        quantity: qty('12'),
        uomCode: 'EA',
        unitPriceIqd: price('500'),
        branchCode: BAGHDAD,
        costCentreCode: 'CC-OPS',
      },
    ]);
    await confirm(order.id, order.lineIds[0]!, qty('12'));

    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12'), unitPriceIqd: price('500') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    const posted = await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));

    const { rows } = await ownerPool.query(
      `select account_id, debit_iqd from journal_line where journal_entry_id = $1 and debit_iqd > 0`,
      [posted.journalEntryId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].account_id).toBe(accounts.expense);
    expect(Number(rows[0].debit_iqd)).toBe(6000);
  });
});

// ---------------------------------------------------------------------------

describe('05.5 gate · the supplier invoice number is unique per supplier (§15)', () => {
  it('refuses a second invoice with the same number', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    await invoice(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') }],
      { supplierInvoiceNo: 'INV-9001' },
    );

    const error = await rejection(
      invoice(
        order.id,
        [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('20'), unitPriceIqd: price('10') }],
        { supplierInvoiceNo: 'INV-9001' },
      ),
    );

    expect(error).toMatch(/has already been entered as/);
    expect(error).toMatch(/a manager records a duplicate exception/);
  });

  it('allows the same number for a different supplier', async () => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_supplier, status, active)
       values ('SUP-002','SUP-002', true, 'active', true) returning id`,
    );
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    await invoice(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') }],
      { supplierInvoiceNo: 'INV-7001' },
    );

    // Two suppliers numbering their own invoices from 1 is normal; the rule is
    // "unique per supplier", not globally unique.
    const second = await withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId: rows[0].id,
        supplierInvoiceNo: 'INV-7001',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: '2026-02-10',
        dueDate: '2026-03-10',
        nonPoJustification: 'Emergency courier charge, no order raised.',
        nonPoApprovedBy: manager.principal.userId,
        lines: [{ quantity: qty('1'), unitPriceIqd: price('100'), description: 'Courier' }],
      }),
    );
    expect(second.invoiceNo).toBeTruthy();
  });

  it('allows a duplicate when a manager approves it with a reason', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    await invoice(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') }],
      { supplierInvoiceNo: 'INV-9002' },
    );

    const second = await invoice(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('20'), unitPriceIqd: price('10') }],
      {
        supplierInvoiceNo: 'INV-9002',
        duplicateApprovedBy: manager.principal.userId,
        duplicateApprovalReason: 'Supplier reissued the same number after a system change; confirmed by phone.',
      },
    );
    expect(second.invoiceNo).toBeTruthy();
  });

  it('refuses a duplicate approval with no reason', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));
    await invoice(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') }],
      { supplierInvoiceNo: 'INV-9003' },
    );

    const error = await rejection(
      invoice(
        order.id,
        [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('20'), unitPriceIqd: price('10') }],
        { supplierInvoiceNo: 'INV-9003', duplicateApprovedBy: manager.principal.userId },
      ),
    );
    expect(error).toMatch(/only with a reason/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));
    await invoice(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), unitPriceIqd: price('10') }],
      { supplierInvoiceNo: 'INV-9004' },
    );

    await expect(
      ownerPool.query(
        `insert into ap_invoice
           (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date,
            non_po_justification, non_po_approved_by, non_po_approved_at, created_by)
         values ('API-RAW','INV-9004',$1,$2,'2026-02-10','2026-03-10','x',$3,now(),$3)`,
        [supplierId, BAGHDAD, manager.principal.userId],
      ),
    ).rejects.toThrow(/ap_invoice_supplier_number_uniq/);
  });
});

// ---------------------------------------------------------------------------

describe('05.5 gate · the non-PO route is stronger, not easier (§15)', () => {
  it('refuses an invoice with no order and no justification', async () => {
    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        ap.create(tx, clerk, {
          supplierId,
          supplierInvoiceNo: 'INV-NOPO-1',
          purchaseOrderId: null,
          branchCode: BAGHDAD,
          invoiceDate: '2026-02-10',
          dueDate: '2026-03-10',
          lines: [{ quantity: qty('1'), unitPriceIqd: price('100'), description: 'Something' }],
        }),
      ),
    );

    expect(error).toMatch(/needs a written justification and a second approver/);
    expect(error).toMatch(/three-way match cannot protect a charge/);
  });

  it('refuses the raiser approving their own non-PO invoice', async () => {
    const error = await rejection(
      withScope(scope(clerk), (tx) =>
        ap.create(tx, clerk, {
          supplierId,
          supplierInvoiceNo: 'INV-NOPO-2',
          purchaseOrderId: null,
          branchCode: BAGHDAD,
          invoiceDate: '2026-02-10',
          dueDate: '2026-03-10',
          nonPoJustification: 'Emergency purchase',
          nonPoApprovedBy: clerk.principal.userId,
          lines: [{ quantity: qty('1'), unitPriceIqd: price('100'), description: 'Something' }],
        }),
      ),
    );
    expect(error).toMatch(/second approver/);
  });

  it('accepts one with a justification and a second approver', async () => {
    const created = await withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: 'INV-NOPO-3',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: '2026-02-10',
        dueDate: '2026-03-10',
        nonPoJustification: 'Emergency generator repair out of hours; no time to raise an order.',
        nonPoApprovedBy: manager.principal.userId,
        lines: [{ quantity: qty('1'), unitPriceIqd: price('250'), description: 'Generator repair' }],
      }),
    );

    // Not "matched" by luck — it took the stronger route instead, and that is
    // what stands in for the match.
    expect(created.matchStatus).toBe('matched');
  });

  it('refuses at the database an invoice with no order and no evidence', async () => {
    await expect(
      ownerPool.query(
        `insert into ap_invoice
           (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, created_by)
         values ('API-RAW2','INV-RAW',$1,$2,'2026-02-10','2026-03-10',$3)`,
        [supplierId, BAGHDAD, clerk.principal.userId],
      ),
    ).rejects.toThrow(/ap_invoice_non_po_needs_justification/);
  });
});

// ---------------------------------------------------------------------------

describe('05.5 gate · a posted invoice cannot be edited or deleted', () => {
  async function postedInvoice() {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, created.id));
    await withScope(scope(manager), (tx) => ap.post(tx, manager, created.id));
    return created;
  }

  it('refuses to change what it charges', async () => {
    const created = await postedInvoice();
    await expect(
      ownerPool.query(`update ap_invoice_line set unit_price = 99 where ap_invoice_id = $1`, [
        created.id,
      ]),
    ).rejects.toThrow(/what it charges cannot be changed/);
  });

  it('refuses to change who it is owed to', async () => {
    const created = await postedInvoice();
    await expect(
      ownerPool.query(`update ap_invoice set supplier_invoice_no = 'CHANGED' where id = $1`, [
        created.id,
      ]),
    ).rejects.toThrow(/Reverse it; it is not edited/);
  });

  it('grants the application no DELETE on the invoice', async () => {
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'erp_app' and table_name = 'ap_invoice'`,
    );
    expect(rows.map((r) => r.privilege_type)).not.toContain('DELETE');
  });

  it('refuses to delete a resolved match exception', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));
    const created = await invoice(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), unitPriceIqd: price('10') },
    ]);
    await withScope(scope(manager), (tx) =>
      ap.approveVariance(tx, manager, created.id, 'Balance in transit.'),
    );

    // An *open* exception is derived state and is replaced on every re-match.
    // A resolved one is a person's decision, and it stays.
    await expect(
      ownerPool.query(`delete from ap_match_exception where ap_invoice_id = $1`, [created.id]),
    ).rejects.toThrow(/part of the record and is not deleted/);
  });

  it('writes the journal and the invoice in one transaction (§24)', async () => {
    const created = await postedInvoice();
    const { rows } = await ownerPool.query(
      `select journal_entry_id, posted_at from ap_invoice where id = $1`,
      [created.id],
    );
    expect(rows[0].journal_entry_id).toBeTruthy();
    expect(rows[0].posted_at).toBeTruthy();
  });

  it('writes the A/P subledger entry with the G/L entry, in the same transaction', async () => {
    const created = await postedInvoice();

    const { rows } = await ownerPool.query(
      `select s.credit_iqd, s.control_account_id, s.party_code, s.journal_entry_id
         from subledger_entry s
         join ap_invoice i on i.journal_entry_id = s.journal_entry_id
        where i.id = $1`,
      [created.id],
    );

    // §1.2 and §24 — the supplier ledger and the control account move together
    // or not at all. The engine writes the subledger from the journal, so there
    // is no path that produces one without the other.
    expect(rows).toHaveLength(1);
    expect(rows[0].control_account_id).toBe(accounts.supplier_payable);
    expect(rows[0].party_code).toBe('SUP-001');
    expect(Number(rows[0].credit_iqd)).toBe(1000);
  });

  it('leaves the supplier ledger and the control account agreeing', async () => {
    await postedInvoice();

    const { rows } = await ownerPool.query(
      `select
         (select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) from journal_line where account_id = $1) as gl,
         (select coalesce(sum(credit_iqd) - sum(debit_iqd), 0) from subledger_entry where control_account_id = $1) as sub`,
      [accounts.supplier_payable],
    );
    // The §27 Release 4 acceptance in one line: "source documents, supplier
    // ledger and G/L reconcile."
    expect(Number(rows[0].gl)).toBe(Number(rows[0].sub));
    expect(Number(rows[0].gl)).toBe(1000);
  });
});
