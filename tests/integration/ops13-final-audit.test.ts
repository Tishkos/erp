/**
 * The final audit against the Operations build (2026-09-26), as the system
 * will actually be run.
 *
 * Two things make this file different from the block suites before it.
 *
 *   The postings are configured only through what the Posting Mappings screen
 *   offers (`POSTING_MAP`) and the accounts on the item — nothing is inserted
 *   behind the screen's back. A document that needs a mapping nobody can set
 *   fails here, the way it would fail on the live install.
 *
 *   Approval is by a CEO who is nothing else, and the Accounting Manager is
 *   only an Accounting Manager. Blocks 4 and 5: "not posted until it receives
 *   CEO approval".
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as banks from '@/server/services/bank-cash-accounts';
import * as gr from '@/server/services/goods-return';
import * as inventory from '@/server/services/inventory';
import * as opening from '@/server/services/opening-stock';
import * as partners from '@/server/services/partners';
import * as paymentTerms from '@/server/services/payment-terms';
import * as departments from '@/server/services/departments';
import * as costCentres from '@/server/services/cost-centres';
import * as paymentMethods from '@/server/services/payment-methods';
import * as items from '@/server/services/items';
import * as shipments from '@/server/services/supplier-shipment';
import * as sr from '@/server/services/sales-return';
import * as statement from '@/server/services/partner-statement';
import * as stock from '@/server/services/stock-operations';
import * as subledger from '@/server/services/subledger';
import * as trialBalance from '@/server/services/trial-balance';
import { mappedLines } from '@/server/domain/posting-map';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const MAIN = 'WH-MAIN';
const SECOND = 'WH-SECOND';
const IN_PROCESS = 'WH-INPROC';
const ON_BOARD = 'WH-BOARD';
const ON_PORT = 'WH-PORT';
const ON = '2026-04-01';
const YEAR = { from: '2026-01-01', to: '2026-12-31' } as const;

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let ceo: ActorContext;
let supplierA: string;
let supplierB: string;
let customerId: string;
let bankAccountId: string;
let accounts: Record<string, string>;

async function createUser(...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  for (const role of roles) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')
     on conflict do nothing`,
    [id],
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
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict do nothing`,
  );

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  ceo = await createUser('ceo');

  // The accounts a person would create, and the mappings a person could set:
  // every (event, role) the Posting Mappings screen lists, and nothing else.
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
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    serial += 1;
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [
        `${parent.slice(0, 1)}8${String(serial).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        control,
      ],
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

  // The item and its base unit in one transaction: the check that an item's
  // base unit is among its units is deferred to COMMIT.
  const client = await ownerPool.connect();
  let itemId: string;
  try {
    await client.query('begin');
    const { rows: item } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking,
                         inventory_account_id, cogs_account_id, sales_account_id)
       values ($1,'Solar Panel 550W',true,'EA','batch',$2,$3,$4) returning id`,
      [PANEL, accounts.inventory, accounts.cogs, accounts.sales_revenue],
    );
    itemId = item[0].id;
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1,'EA',1,1)`,
      [itemId],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  for (const [code, name, stage] of [
    [MAIN, 'Main Warehouse', null],
    [SECOND, 'Second Warehouse', null],
    [IN_PROCESS, 'In Process', 'in_process'],
    [ON_BOARD, 'On Board', 'on_board'],
    [ON_PORT, 'On Port', 'on_port'],
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
  supplierA = await partner('SUP-A', 'Supplier A', false);
  supplierB = await partner('SUP-B', 'Supplier B', false);
  customerId = await partner('CUS-1', 'Customer One', true);
  for (const supplierId of [supplierA, supplierB]) {
    await ownerPool.query(
      `insert into item_supplier (item_id, supplier_id, active) values ($1,$2,true)`,
      [itemId, supplierId],
    );
  }

  const bank = await withScope(scope(manager), (tx) =>
    banks.create(tx, manager, 'bank', {
      name: 'Rafidain Current Account',
      bankName: 'Rafidain Bank',
      accountNumber: 'RF-9001',
      currency: 'IQD',
      glAccountId: accounts.bank!,
    }),
  );
  const { rows: banked } = await ownerPool.query(
    `select id from bank_cash_account where code = $1`,
    [bank.code],
  );
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
});

let seq = 0;

/** Raised by the clerk and submitted. Not posted: that is the CEO's. */
async function raisePurchase(
  supplierId: string,
  quantity: string,
  unitPrice: string,
  warehouseCode = MAIN,
) {
  seq += 1;
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
}

async function buy(supplierId: string, quantity: string, unitPrice: string, warehouseCode = MAIN) {
  const made = await raisePurchase(supplierId, quantity, unitPrice, warehouseCode);
  await withScope(scope(ceo), (tx) => ap.post(tx, ceo, made.id));
  const { rows } = await ownerPool.query(
    `select id from ap_invoice_line where ap_invoice_id = $1`,
    [made.id],
  );
  return { ...made, lineId: rows[0].id as string };
}

async function sell(quantity: string, unitPrice: string, supplierId: string | null = null) {
  const made = await withScope(scope(clerk), (tx) =>
    ar.createDirect(tx, clerk, {
      customerId,
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: '2026-05-20',
      lines: [
        {
          itemCode: PANEL,
          quantity: qty(quantity),
          unitPriceIqd: price(unitPrice),
          warehouseCode: MAIN,
          supplierId,
        },
      ],
    }),
  );
  await withScope(scope(ceo), (tx) => ar.approve(tx, ceo, made.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, made.id));
  const { rows } = await ownerPool.query(
    `select id from ar_invoice_line where ar_invoice_id = $1`,
    [made.id],
  );
  return { ...made, lineId: rows[0].id as string };
}

const onHand = async (warehouseCode: string) =>
  Number(
    (await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, warehouseCode, BAGHDAD),
    )).onHand,
  ) / 1_000_000;

async function ledger(role: string): Promise<number> {
  const { rows } = await ownerPool.query(
    `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
       from journal_line l join journal_entry e on e.id = l.journal_entry_id
      where l.account_id = $1 and e.status in ('posted','reversed')`,
    [accounts[role]],
  );
  return Number(rows[0].balance);
}

/** Every layer left in a warehouse, as (supplier, quantity, unit cost). */
async function layersIn(warehouseCode: string) {
  const { rows } = await ownerPool.query(
    `select l.supplier_id, l.remaining_quantity::float as quantity, l.unit_cost_iqd::float as cost
       from cost_layer l
      where l.item_code = $1 and l.warehouse_code = $2 and l.remaining_quantity > 0
      order by l.layer_date, l.sequence`,
    [PANEL, warehouseCode],
  );
  return rows.map((r) => ({ supplier: r.supplier_id, quantity: r.quantity, cost: r.cost }));
}

async function booksAgree() {
  const balance = await withScope(scope(manager), (tx) =>
    trialBalance.trialBalance(tx, { ...YEAR, branchCode: BAGHDAD }),
  );
  const reconciliation = await withScope(scope(manager), (tx) => subledger.reconciliation(tx));
  return {
    balances: trialBalance.totalsOf(balance).balances,
    adrift: reconciliation.filter((row) => Number(row.difference) !== 0),
  };
}

// ---------------------------------------------------------------------------
describe('blocks 4 and 5 · nothing posts until the CEO approves it', () => {
  it('refuses the Accounting Manager a purchase invoice, and moves no stock', async () => {
    const made = await raisePurchase(supplierA, '10', '1000');

    const refused = await rejection(withScope(scope(manager), (tx) => ap.post(tx, manager, made.id)));
    expect(refused).toMatch(/Permission denied/);
    expect(await onHand(MAIN)).toBe(0);
    const { rows } = await ownerPool.query(`select status from ap_invoice where id = $1`, [made.id]);
    expect(rows[0].status).toBe('submitted');
  });

  it('refuses the clerk who raised it', async () => {
    const made = await raisePurchase(supplierA, '10', '1000');
    expect(await rejection(withScope(scope(clerk), (tx) => ap.post(tx, clerk, made.id)))).toMatch(
      /Permission denied/,
    );
  });

  it('posts when the CEO approves it: the stock arrives and the journal is Inventory Dr / AP Cr', async () => {
    await buy(supplierA, '10', '1000');
    expect(await onHand(MAIN)).toBe(10);
    expect(await ledger('inventory')).toBe(10_000);
    expect(await ledger('supplier_payable')).toBe(-10_000);
  });

  it('refuses the Accounting Manager the approval of a sales invoice', async () => {
    await buy(supplierA, '10', '1000');
    const made = await withScope(scope(clerk), (tx) =>
      ar.createDirect(tx, clerk, {
        customerId,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        dueDate: '2026-05-20',
        lines: [{ itemCode: PANEL, quantity: qty('2'), unitPriceIqd: price('2000'), warehouseCode: MAIN }],
      }),
    );
    expect(
      await rejection(withScope(scope(manager), (tx) => ar.approve(tx, manager, made.id))),
    ).toMatch(/Permission denied/);
    // and nothing posts from draft, whoever asks
    expect(await rejection(withScope(scope(ceo), (tx) => ar.post(tx, ceo, made.id)))).toMatch(
      /draft|transition|not allowed/i,
    );
    expect(await onHand(MAIN)).toBe(10);

    await withScope(scope(ceo), (tx) => ar.approve(tx, ceo, made.id));
    await withScope(scope(manager), (tx) => ar.post(tx, manager, made.id));
    expect(await onHand(MAIN)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
describe('block 5 · FIFO follows the item, the supplier and the warehouse', () => {
  it('costs a sale from the named supplier’s oldest stock, and leaves the other supplier’s alone', async () => {
    await buy(supplierA, '10', '100');
    await buy(supplierB, '10', '150');
    await buy(supplierA, '5', '120');

    await sell('12', '500', supplierA);

    // 10 at 100 and 2 at 120, from supplier A only. Any-supplier FIFO would
    // have been 10 at 100 and 2 at 150 = 1,300.
    expect(await ledger('cogs')).toBe(1_240);
    expect(await ledger('sales_revenue')).toBe(-6_000);
    expect(await ledger('customer_receivable')).toBe(6_000);
    expect(await layersIn(MAIN)).toEqual([
      { supplier: supplierB, quantity: 10, cost: 150 },
      { supplier: supplierA, quantity: 3, cost: 120 },
    ]);
  });

  it('refuses to sell more of a supplier’s stock than that supplier has there', async () => {
    await buy(supplierA, '3', '100');
    await buy(supplierB, '10', '150');
    expect(await rejection(sell('4', '500', supplierA))).toMatch(/[Nn]egative stock/);
    expect(await onHand(MAIN)).toBe(13);
  });
});

// ---------------------------------------------------------------------------
describe('block 8 · a shipment carries its own goods, supplier and cost to the shelf', () => {
  it('moves only this invoice’s goods, and they can be sold by their supplier at the end', async () => {
    const a = await buy(supplierA, '5', '200', IN_PROCESS);
    await buy(supplierB, '5', '300', IN_PROCESS);

    const [tracked] = await withScope(scope(manager), (tx) => shipments.list(tx));
    const shipmentA = (await withScope(scope(manager), (tx) => shipments.list(tx))).find(
      (row) => row.invoiceNo === a.invoiceNo,
    )!;
    expect(tracked).toBeDefined();

    for (const stage of ['on_board', 'on_port'] as const) {
      await withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipmentA.id, stage));
    }
    await withScope(scope(manager), (tx) =>
      shipments.advance(tx, manager, shipmentA.id, 'in_bounded', MAIN),
    );

    // Supplier B's container never left In Process.
    expect(await layersIn(IN_PROCESS)).toEqual([{ supplier: supplierB, quantity: 5, cost: 300 }]);
    expect(await layersIn(ON_BOARD)).toEqual([]);
    expect(await layersIn(ON_PORT)).toEqual([]);
    expect(await layersIn(MAIN)).toEqual([{ supplier: supplierA, quantity: 5, cost: 200 }]);

    // …and a sale that names supplier A finds them.
    await sell('5', '400', supplierA);
    expect(await ledger('cogs')).toBe(1_000);
    expect(await onHand(MAIN)).toBe(0);
  });

  it('never duplicates stock however the status is pushed', async () => {
    const a = await buy(supplierA, '5', '200', IN_PROCESS);
    const shipment = (await withScope(scope(manager), (tx) => shipments.list(tx))).find(
      (row) => row.invoiceNo === a.invoiceNo,
    )!;
    await withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'on_board'));
    expect(
      await rejection(
        withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'on_board')),
      ),
    ).toMatch(/one stage at a time/);
    expect(
      await rejection(
        withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'in_process')),
      ),
    ).toMatch(/one stage at a time/);
    const total =
      (await onHand(IN_PROCESS)) + (await onHand(ON_BOARD)) + (await onHand(ON_PORT)) + (await onHand(MAIN));
    expect(total).toBe(5);
    expect(await onHand(ON_BOARD)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('block 7 · Transfer', () => {
  it('takes the stock out of one warehouse and into the other, creating and destroying nothing', async () => {
    await buy(supplierA, '10', '100');
    await buy(supplierB, '10', '150');

    const made = await withScope(scope(clerk), (tx) =>
      stock.transfer(tx, clerk, {
        itemCode: PANEL,
        fromWarehouseCode: MAIN,
        toWarehouseCode: SECOND,
        quantity: qty('12'),
        transferDate: ON,
      }),
    );

    expect(made.transferNo).toMatch(/^TRF-BGW-2026-\d{6}$/);
    expect(await onHand(MAIN)).toBe(8);
    expect(await onHand(SECOND)).toBe(12);
    // The oldest first, each layer keeping its supplier and cost.
    expect(await layersIn(SECOND)).toEqual([
      { supplier: supplierA, quantity: 10, cost: 100 },
      { supplier: supplierB, quantity: 2, cost: 150 },
    ]);
    // Same goods, same account: the inventory balance does not move.
    expect(await ledger('inventory')).toBe(2_500);

    const movements = await withScope(scope(manager), (tx) =>
      stock.movements(tx, manager, { itemCode: PANEL }),
    );
    const transfers = movements.filter((row) => row.type === 'transfer');
    expect(transfers.filter((row) => row.direction === 'out').every((row) => row.warehouseCode === MAIN)).toBe(true);
    expect(transfers.filter((row) => row.direction === 'in').every((row) => row.warehouseCode === SECOND)).toBe(true);
    expect(new Set(transfers.map((row) => row.documentNo))).toEqual(new Set([made.transferNo]));
  });

  it('refuses more than the source holds, and moves nothing', async () => {
    await buy(supplierA, '5', '100');
    const refused = await rejection(
      withScope(scope(clerk), (tx) =>
        stock.transfer(tx, clerk, {
          itemCode: PANEL,
          fromWarehouseCode: MAIN,
          toWarehouseCode: SECOND,
          quantity: qty('6'),
          transferDate: ON,
        }),
      ),
    );
    expect(refused).toMatch(/Negative stock is not allowed/);
    expect(await onHand(MAIN)).toBe(5);
    expect(await onHand(SECOND)).toBe(0);
  });

  it('refuses a transfer to the same warehouse', async () => {
    await buy(supplierA, '5', '100');
    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          stock.transfer(tx, clerk, {
            itemCode: PANEL,
            fromWarehouseCode: MAIN,
            toWarehouseCode: MAIN,
            quantity: qty('1'),
            transferDate: ON,
          }),
        ),
      ),
    ).toMatch(/two different warehouses/);
  });
});

// ---------------------------------------------------------------------------
describe('block 7 · Item Reconciliation', () => {
  it('takes missing stock Out at its FIFO cost, and posts it', async () => {
    await buy(supplierA, '5', '100');
    await buy(supplierA, '5', '120');

    const made = await withScope(scope(manager), (tx) =>
      stock.adjust(tx, manager, {
        itemCode: PANEL,
        warehouseCode: MAIN,
        direction: 'out',
        quantity: qty('6'),
        adjustmentDate: ON,
      }),
    );
    expect(made.adjustmentNo).toMatch(/^ADJ-BGW-2026-\d{6}$/);
    expect(await onHand(MAIN)).toBe(4);
    // 5 at 100 and 1 at 120.
    expect(await ledger('inventory_adjustment')).toBe(620);
    expect(await ledger('inventory')).toBe(1_100 - 620);
  });

  it('brings found stock In at what the item already costs', async () => {
    await buy(supplierA, '5', '100');
    await buy(supplierA, '5', '120');
    await withScope(scope(manager), (tx) =>
      stock.adjust(tx, manager, {
        itemCode: PANEL,
        warehouseCode: MAIN,
        direction: 'in',
        quantity: qty('2'),
        adjustmentDate: ON,
      }),
    );
    expect(await onHand(MAIN)).toBe(12);
    // At the average of what is left: 1,100 / 10 = 110.
    expect(await ledger('inventory')).toBe(1_320);
    expect(await ledger('inventory_adjustment')).toBe(-220);
  });

  it('refuses an Out that would leave the warehouse negative', async () => {
    await buy(supplierA, '5', '100');
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          stock.adjust(tx, manager, {
            itemCode: PANEL,
            warehouseCode: MAIN,
            direction: 'out',
            quantity: qty('6'),
            adjustmentDate: ON,
          }),
        ),
      ),
    ).toMatch(/Negative stock is not allowed/);
    expect(await onHand(MAIN)).toBe(5);
  });

  it('is the Accounting Manager’s, not the clerk’s', async () => {
    await buy(supplierA, '5', '100');
    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          stock.adjust(tx, clerk, {
            itemCode: PANEL,
            warehouseCode: MAIN,
            direction: 'out',
            quantity: qty('1'),
            adjustmentDate: ON,
          }),
        ),
      ),
    ).toMatch(/Permission denied/);
  });
});

// ---------------------------------------------------------------------------
describe('block 7 · Opening Stock', () => {
  it('brings the stock in at total ÷ quantity when someone else approves it', async () => {
    const raised = await withScope(scope(clerk), (tx) =>
      opening.raise(tx, clerk, {
        branchCode: BAGHDAD,
        warehouseCode: MAIN,
        documentDate: ON,
        lines: [
          { itemCode: PANEL, quantity: qty('4'), uomCode: '', unitCostIqd: price('250'), costLayerDate: ON },
        ],
      }),
    );
    expect(raised.documentNo).toMatch(/^OPN-BGW-2026-\d{6}$/);
    expect(await onHand(MAIN)).toBe(0);

    expect(
      await rejection(
        withScope(scope(clerk), (tx) => opening.approve(tx, clerk, raised.id, { post: true })),
      ),
    ).toMatch(/Permission denied|cannot approve/);

    await withScope(scope(manager), (tx) => opening.approve(tx, manager, raised.id, { post: true }));
    expect(await onHand(MAIN)).toBe(4);
    expect(await ledger('inventory')).toBe(1_000);
    expect(await ledger('opening_balance')).toBe(-1_000);
  });
});

// ---------------------------------------------------------------------------
describe('block 9 · a sales return settles the customer and restores stock at the sale’s cost', () => {
  async function returnGoods(
    invoice: { id: string; lineId: string },
    quantity: string,
    offset:
      | { offsetKind: 'receivable' }
      | { offsetKind: 'bank'; offsetBankAccountId: string } = { offsetKind: 'receivable' },
  ) {
    const created = await withScope(scope(clerk), (tx) =>
      sr.request(tx, clerk, {
        arInvoiceId: invoice.id,
        requestedOn: ON,
        reason: 'Returned by the customer',
        ...offset,
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty(quantity) }],
      }),
    );
    const view = await withScope(scope(manager), (tx) => sr.view(tx, created.id));
    await withScope(scope(manager), (tx) =>
      sr.receiveGoods(tx, manager, created.id, {
        receivedOn: ON,
        lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: qty(quantity) }],
      }),
    );
    // What the screen's Accept does.
    await withScope(scope(manager), async (tx) => {
      const document = await sr.view(tx, created.id);
      await sr.inspect(
        tx,
        manager,
        created.id,
        document.lines.map((line) => ({
          salesReturnLineId: line.id,
          acceptedQuantity: parseQuantity(line.receivedQuantity ?? line.requestedQuantity),
          disposition: 'saleable' as const,
          destinationWarehouseCode: MAIN,
        })),
      );
      return sr.acceptAndSettle(tx, manager, created.id);
    });
    return created;
  }

  it('takes the returned cost from the whole sold line, not its first FIFO layer', async () => {
    await buy(supplierA, '5', '100');
    await buy(supplierA, '5', '120');
    const sale = await sell('8', '300'); // 5 at 100 + 3 at 120 = 860 → 107.5 each

    await returnGoods(sale, '4');

    expect(await onHand(MAIN)).toBe(6);
    // Back on the shelf as supplier A's, at the sale's own cost.
    expect(await layersIn(MAIN)).toContainEqual({ supplier: supplierA, quantity: 4, cost: 107.5 });
    // COGS 860 less 4 × 107.5 = 430.
    expect(await ledger('cogs')).toBe(430);
    // Sales Return Dr 1,200 / Accounts Receivable Cr 1,200.
    expect(await ledger('sales_returns')).toBe(1_200);
    expect(await ledger('customer_receivable')).toBe(2_400 - 1_200);
    const closing = await withScope(scope(manager), (tx) =>
      statement.statementFor(tx, 'customer', 'CUS-1', YEAR),
    );
    expect(Number(closing.closing)).toBe(1_200);
    const { rows } = await ownerPool.query(
      `select allocated_iqd::text as allocated, status from ar_invoice where id = $1`,
      [sale.id],
    );
    expect(rows[0]).toEqual({ allocated: '1200.0000', status: 'partially_executed' });
    expect((await booksAgree()).adrift).toEqual([]);
  });

  it('credits the bank when the money went back to the customer', async () => {
    await buy(supplierA, '5', '100');
    const sale = await sell('5', '300');
    await returnGoods(sale, '2', { offsetKind: 'bank', offsetBankAccountId: bankAccountId });
    expect(await ledger('bank')).toBe(-600);
    expect(await ledger('customer_receivable')).toBe(1_500);
  });

  it('never returns more than is left to return', async () => {
    await buy(supplierA, '5', '100');
    const sale = await sell('5', '300');
    await returnGoods(sale, '3');
    await returnGoods(sale, '2');
    expect(await rejection(returnGoods(sale, '1'))).toMatch(/return|exceed|more than/i);
    expect(await onHand(MAIN)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
describe('block 10 · a purchase return follows the goods wherever they moved', () => {
  it('returns goods after they were transferred, in one journal: AP Dr / Inventory Cr', async () => {
    const invoice = await buy(supplierA, '10', '100');
    await withScope(scope(clerk), (tx) =>
      stock.transfer(tx, clerk, {
        itemCode: PANEL,
        fromWarehouseCode: MAIN,
        toWarehouseCode: SECOND,
        quantity: qty('4'),
        transferDate: ON,
      }),
    );

    const created = await withScope(scope(clerk), (tx) =>
      gr.createFromInvoice(tx, clerk, {
        apInvoiceId: invoice.id,
        returnDate: ON,
        reason: 'Damaged',
        offsetKind: 'payable',
        lines: [{ apInvoiceLineId: invoice.lineId, quantity: qty('3'), warehouseCode: SECOND }],
      }),
    );
    await withScope(scope(manager), (tx) => gr.approve(tx, manager, created.id));
    await withScope(scope(manager), (tx) => gr.post(tx, manager, created.id));

    expect(await onHand(SECOND)).toBe(1);
    expect(await onHand(MAIN)).toBe(6);
    expect(await ledger('inventory')).toBe(700);
    expect(await ledger('supplier_payable')).toBe(-700);
    expect(await ledger('return_clearing')).toBe(0);
    const closing = await withScope(scope(manager), (tx) =>
      statement.statementFor(tx, 'supplier', 'SUP-A', YEAR),
    );
    expect(Number(closing.closing)).toBe(700);
    expect((await booksAgree()).adrift).toEqual([]);
  });

  it('can still return goods from an invoice that has been part paid', async () => {
    const invoice = await buy(supplierA, '10', '100');
    await ownerPool.query(
      `update ap_invoice set status = 'partially_executed', settled_amount_iqd = 200 where id = $1`,
      [invoice.id],
    );
    const created = await withScope(scope(clerk), (tx) =>
      gr.createFromInvoice(tx, clerk, {
        apInvoiceId: invoice.id,
        returnDate: ON,
        reason: 'Damaged',
        offsetKind: 'payable',
        lines: [{ apInvoiceLineId: invoice.lineId, quantity: qty('2') }],
      }),
    );
    expect(created.returnNo).toMatch(/^GRT-/);
  });
});

// ---------------------------------------------------------------------------
describe('Critical Rule 1 · every code and number is the system’s', () => {
  async function superUser(): Promise<ActorContext> {
    const id = randomUUID();
    await ownerPool.query(
      `insert into app_user (id, email, display_name, is_super_user) values ($1,$2,'Admin',true)`,
      [id, `${id}@example.com`],
    );
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      id,
      BAGHDAD,
    ]);
    const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
      authz.loadPrincipal(tx, id),
    );
    return { principal, branchCode: BAGHDAD };
  }

  it('gives a customer CUS- and a supplier SUP-, and ignores a code slipped into the request', async () => {
    const customer = await withScope(scope(clerk), (tx) =>
      partners.createInRole(tx, clerk, 'customer', {
        legalName: 'Minted Customer',
        code: 'TYPED-C',
      } as never),
    );
    const supplier = await withScope(scope(clerk), (tx) =>
      partners.createInRole(tx, clerk, 'supplier', { legalName: 'Minted Supplier' }),
    );
    expect(customer.code).toMatch(/^CUS-\d{6}$/);
    expect(supplier.code).toMatch(/^SUP-\d{6}$/);
    const { rows } = await ownerPool.query(`select 1 from business_partner where code = 'TYPED-C'`);
    expect(rows).toHaveLength(0);
  });

  it('makes an existing supplier a customer too, rather than a second record', async () => {
    const supplier = await withScope(scope(clerk), (tx) =>
      partners.createInRole(tx, clerk, 'supplier', { legalName: 'Both Ways Trading' }),
    );
    const again = await withScope(scope(manager), (tx) =>
      partners.createInRole(tx, manager, 'customer', { legalName: 'both ways trading ' }),
    );
    expect(again.code).toBe(supplier.code);
    const { rows } = await ownerPool.query(
      `select is_customer, is_supplier from business_partner where code = $1`,
      [supplier.code],
    );
    expect(rows[0]).toEqual({ is_customer: true, is_supplier: true });
  });

  it('never hands two partners created at once the same code', async () => {
    const made = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        withScope(scope(clerk), (tx) =>
          partners.createInRole(tx, clerk, 'customer', {
            legalName: `Concurrent ${index} ${randomUUID()}`,
            confirmedNotDuplicate: true,
          }),
        ),
      ),
    );
    expect(new Set(made.map((row) => row.code)).size).toBe(6);
  });

  it('mints item, payment term, department, cost centre and payment method codes', async () => {
    const admin = await superUser();
    const item = await withScope(scope(admin), (tx) =>
      items.create(tx, admin, {
        name: 'Minted Item',
        isStock: true,
        baseUomCode: 'EA',
        tracking: 'batch',
        inventoryAccountId: accounts.inventory!,
        salesAccountId: accounts.sales_revenue!,
        cogsAccountId: accounts.cogs!,
        code: 'TYPED-ITEM',
      } as never),
    );
    const term = await withScope(scope(admin), (tx) =>
      paymentTerms.create(tx, admin, { name: 'Net 30', basis: 'document_date', dueDays: 30 }),
    );
    const department = await withScope(scope(admin), (tx) =>
      departments.create(tx, admin, { name: 'Sales Department' }),
    );
    const centre = await withScope(scope(admin), (tx) =>
      costCentres.create(tx, admin, { name: 'Fleet' }),
    );
    const method = await withScope(scope(admin), (tx) =>
      paymentMethods.create(tx, admin, { name: 'Wire', kind: 'transfer' }),
    );

    expect(item.code).toMatch(/^ITM-\d{6}$/);
    expect(term.code).toMatch(/^PT-\d{4}$/);
    expect(department.code).toMatch(/^DEP-\d{4}$/);
    expect(centre.code).toMatch(/^CC-\d{4}$/);
    expect(method.code).toMatch(/^PM-\d{4}$/);
  });

  it('numbers every document from its own sequence', async () => {
    const purchase = await buy(supplierA, '5', '100');
    const sale = await sell('1', '300');
    expect(purchase.invoiceNo).toMatch(/^API-BGW-2026-\d{6}$/);
    expect(sale.invoiceNo).toMatch(/^INV-BGW-2026-\d{6}$/);
  });
});
