/**
 * The inventory ledger as one truth — the 2026-09-27 investigation.
 *
 * Two things were reported that morning. The Transfer page listed three
 * transfers out of WH-HQ (100, 50 and 10) and the Stock Movement page showed
 * only the 10; and the Baghdad warehouse "should have held 250,200 and showed
 * 250,350". The first was real and was not the application: a maintenance
 * script had deleted every movement and left the transfer documents standing.
 * The second was a column of dinars read as a column of units — 10 + 500 − 3
 * is 507, and 7 × 50 + 500 × 500 is 250,350.
 *
 * So this file holds the ledger to the documents and the documents to the
 * ledger, through every way stock moves, and it keeps money and quantity
 * apart. Each block below is one of the questions the investigation asked:
 *
 *   the lifecycle          purchase, purchase, sale, sales return, purchase
 *                          return, transfer, transfer back, sale — with the
 *                          warehouse, the company and the ledger agreeing after
 *                          every step
 *   Baghdad                the live figures, as quantities and as money
 *   sales                  a sale takes from the warehouse it names, no other
 *   returns                both directions, into the warehouse named
 *   transfers              OUT here, IN there, once, on the same document
 *   status tracking        250 stays 250 through In Process → On Board → On
 *                          Port → Head Office
 *   idempotency            a document posts once however often it is asked
 *   negative stock         refused whole, nothing half-written
 *   integrity              a document without its rows is named, not hidden
 *
 * Postings are configured only through what the Posting Mappings screen offers
 * and the accounts on the item, as ops13 does — nothing behind the screen's back.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as gr from '@/server/services/goods-return';
import * as integrity from '@/server/services/inventory-integrity';
import * as inventory from '@/server/services/inventory';
import * as reports from '@/server/services/inventory-reports';
import * as shipments from '@/server/services/supplier-shipment';
import * as sr from '@/server/services/sales-return';
import * as stock from '@/server/services/stock-operations';
import { mappedLines } from '@/server/domain/posting-map';
import { parseDecimal } from '@/server/domain/money';
import { formatQuantity, parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

// The live company's names, so the file reads against the report that raised it.
const BRANCH = 'HQ';
const HQ = 'WH-HQ'; // seedBranch makes WH-<branch>
const BAGHDAD = 'WH-0001';
const IN_PROCESS = 'WH-INPROC';
const ON_BOARD = 'WH-BOARD';
const ON_PORT = 'WH-PORT';
const AIKO = 'ITM-000001';
const FLYFINE = 'ITM-000002';
const ON = '2026-04-01';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);
/** A scaled quantity as the number a person would write. */
const units = (scaled: bigint | string) =>
  Number(typeof scaled === 'bigint' ? formatQuantity(scaled) : scaled);

let clerk: ActorContext;
let manager: ActorContext;
let ceo: ActorContext;
let supplierId: string;
let customerId: string;
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
    BRANCH,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')
     on conflict do nothing`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BRANCH };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BRANCH });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict do nothing`,
  );

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  ceo = await createUser('ceo');

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
        `${parent.slice(0, 1)}7${String(serial).padStart(5, '0')}`,
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

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    for (const [code, name] of [
      [AIKO, 'AIKO 1500'],
      [FLYFINE, 'Flyfine 1'],
    ] as const) {
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking,
                           inventory_account_id, cogs_account_id, sales_account_id)
         values ($1,$2,true,'EA','batch',$3,$4,$5) returning id`,
        [code, name, accounts.inventory, accounts.cogs, accounts.sales_revenue],
      );
      await client.query(
        `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
         values ($1,'EA',1,1)`,
        [rows[0].id],
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  for (const [code, name, stage] of [
    [BAGHDAD, 'Baghdad', null],
    [IN_PROCESS, 'In Process', 'in_process'],
    [ON_BOARD, 'On Board', 'on_board'],
    [ON_PORT, 'On Port', 'on_port'],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type, shipment_stage)
       values ($1,$2,$3,'main',$4) on conflict do nothing`,
      [code, name, BRANCH, stage],
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
  supplierId = await partner('SUP-1', 'Supplier One', false);
  customerId = await partner('CUS-1', 'Customer One', true);

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code='FY2026'`);
  // The whole year, open: the documents are dated in April, and a reversal is
  // dated the day it is made, which has to fall in an open period too.
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     select $1, m, to_char(make_date(2026, m, 1), 'FMMonth 2026'),
            make_date(2026, m, 1), (make_date(2026, m, 1) + interval '1 month - 1 day')::date
       from generate_series(1, 12) m
     on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );
});

// ---------------------------------------------------------------------------
// The documents, driven the way the screens drive them
// ---------------------------------------------------------------------------

/** A Purchase Invoice into a warehouse: raised, submitted, posted by the CEO. */
async function buy(itemCode: string, warehouseCode: string, quantity: string, unitPrice: string) {
  const made = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: '',
      purchaseOrderId: null,
      branchCode: BRANCH,
      invoiceDate: ON,
      dueDate: '2026-05-01',
      lines: [
        {
          itemCode,
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
  await withScope(scope(ceo), (tx) => ap.post(tx, ceo, made.id));
  const { rows } = await ownerPool.query(
    `select id, quantity from ap_invoice_line where ap_invoice_id = $1`,
    [made.id],
  );
  return { ...made, lineId: rows[0].id as string, lineQuantity: rows[0].quantity as string };
}

/** A Sales Invoice out of a warehouse: raised, approved by the CEO, posted. */
async function sell(itemCode: string, warehouseCode: string, quantity: string, unitPrice: string) {
  const made = await withScope(scope(clerk), (tx) =>
    ar.createDirect(tx, clerk, {
      customerId,
      branchCode: BRANCH,
      invoiceDate: ON,
      dueDate: '2026-05-20',
      lines: [{ itemCode, quantity: qty(quantity), unitPriceIqd: price(unitPrice), warehouseCode }],
    }),
  );
  await withScope(scope(ceo), (tx) => ar.approve(tx, ceo, made.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, made.id));
  const { rows } = await ownerPool.query(
    `select id, quantity from ar_invoice_line where ar_invoice_id = $1`,
    [made.id],
  );
  return { ...made, lineId: rows[0].id as string, lineQuantity: rows[0].quantity as string };
}

/** Block 9: the customer sends goods back, into the warehouse named. */
async function returnSale(invoice: { id: string; lineId: string }, quantity: string, into: string) {
  const created = await withScope(scope(clerk), (tx) =>
    sr.request(tx, clerk, {
      arInvoiceId: invoice.id,
      requestedOn: ON,
      reason: 'Returned by the customer',
      offsetKind: 'receivable',
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
  await withScope(scope(manager), (tx) =>
    sr.inspect(tx, manager, created.id, [
      {
        salesReturnLineId: view.lines[0]!.id,
        acceptedQuantity: qty(quantity),
        disposition: 'saleable',
        destinationWarehouseCode: into,
      },
    ]),
  );
  return created;
}

/** Block 10: goods go back to the supplier, out of the warehouse named. */
async function returnPurchase(
  invoice: { id: string; lineId: string },
  quantity: string,
  warehouseCode?: string,
) {
  const created = await withScope(scope(clerk), (tx) =>
    gr.createFromInvoice(tx, clerk, {
      apInvoiceId: invoice.id,
      returnDate: ON,
      reason: 'Damaged',
      offsetKind: 'payable',
      lines: [
        {
          apInvoiceLineId: invoice.lineId,
          quantity: qty(quantity),
          ...(warehouseCode ? { warehouseCode } : {}),
        },
      ],
    }),
  );
  await withScope(scope(manager), (tx) => gr.approve(tx, manager, created.id));
  return created;
}

/** Block 7: a Transfer between two warehouses. */
const transfer = (itemCode: string, from: string, to: string, quantity: string) =>
  withScope(scope(clerk), (tx) =>
    stock.transfer(tx, clerk, {
      itemCode,
      fromWarehouseCode: from,
      toWarehouseCode: to,
      quantity: qty(quantity),
      transferDate: ON,
    }),
  );

// ---------------------------------------------------------------------------
// The figures, read the way the screens read them
// ---------------------------------------------------------------------------

/** What one warehouse holds — `stock_position`, the movements summed. */
const onHand = async (itemCode: string, warehouseCode: string) =>
  units(
    (await withScope(scope(manager), (tx) => inventory.positionOf(tx, itemCode, warehouseCode, BRANCH)))
      .onHand,
  );

/** What the company holds of an item, every warehouse together. */
const companyWide = async (itemCode: string) =>
  (await withScope(scope(manager), (tx) => inventory.positionsOf(tx, itemCode))).reduce(
    (sum, position) => sum + units(position.onHand),
    0,
  );

/** The Stock Movement page. */
const movementsOf = (itemCode: string) =>
  withScope(scope(manager), (tx) => stock.movements(tx, manager, { itemCode }));

/** The Warehouses Report. */
const report = () =>
  withScope(scope(manager), (tx) =>
    reports.valuation(tx, manager.principal, { allPermittedBranches: true }),
  );

/** The Transfer page. */
const transferPage = () => withScope(scope(manager), (tx) => stock.listTransfers(tx));

/** Every ledger row, straight from the table. */
async function ledgerRows(itemCode?: string) {
  const { rows } = await ownerPool.query(
    `select m.item_code, m.warehouse_code, m.kind::text as kind, m.quantity::text as quantity,
            m.source_document_type, m.source_document_id
       from inventory_movement m
      where $1::text is null or m.item_code = $1
      order by m.created_at, m.id`,
    [itemCode ?? null],
  );
  return rows as {
    item_code: string;
    warehouse_code: string;
    kind: string;
    quantity: string;
    source_document_type: string | null;
    source_document_id: string | null;
  }[];
}

/**
 * The one assertion every block ends on: the screens agree with each other
 * and with the table beneath them, for every item in every warehouse.
 *
 *   the position      `positionOf`, the movements summed by the view
 *   the ledger        the movement rows, summed here
 *   the layers        `layerQuantityOf`, what FIFO still holds
 *   the report        the Warehouses Report's Quantity column
 *
 * And no document is without its rows, no row without its document, and no
 * transfer created or destroyed anything.
 */
async function everythingAgrees() {
  const rows = await ledgerRows();
  const keys = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.item_code}|${row.warehouse_code}`;
    keys.set(key, (keys.get(key) ?? 0) + Number(row.quantity));
  }

  const reported = await report();
  for (const [key, ledger] of keys) {
    const [itemCode, warehouseCode] = key.split('|') as [string, string];
    const position = await onHand(itemCode, warehouseCode);
    const layers = units(
      await withScope(scope(manager), (tx) => inventory.layerQuantityOf(tx, itemCode, warehouseCode)),
    );
    const line = reported.find((r) => r.itemCode === itemCode && r.warehouseCode === warehouseCode);

    expect(position, `${key}: position vs ledger`).toBe(ledger);
    expect(layers, `${key}: layers vs ledger`).toBe(ledger);
    expect(line ? Number(line.quantity) : 0, `${key}: report vs ledger`).toBe(ledger);
  }

  const health = await withScope(scope(manager), (tx) => integrity.check(tx));
  expect(health).toMatchObject({
    documentsWithoutLedger: [],
    ledgerWithoutDocument: [],
    unbalancedTransfers: [],
    clean: true,
  });
  expect(await withScope(scope(manager), (tx) => reports.integrity(tx, manager.principal))).toEqual(
    [],
  );
}

// ---------------------------------------------------------------------------
describe('ops 15 · the lifecycle the sponsor asked for, step by step', () => {
  it('purchase, purchase, sale, sales return, purchase return, transfer, back, sale', async () => {
    // Opening stock: nothing.
    expect(await onHand(AIKO, HQ)).toBe(0);

    // Purchase 500 → 500.
    const first = await buy(AIKO, HQ, '500', '7000');
    expect(await onHand(AIKO, HQ)).toBe(500);

    // Purchase another 250 → 750.
    await buy(AIKO, HQ, '250', '7000');
    expect(await onHand(AIKO, HQ)).toBe(750);

    // Sell 300 → 450.
    const sale = await sell(AIKO, HQ, '300', '8000');
    expect(await onHand(AIKO, HQ)).toBe(450);

    // The customer returns 50 → 500.
    const back = await returnSale(sale, '50', HQ);
    await withScope(scope(manager), (tx) => sr.acceptAndSettle(tx, manager, back.id));
    expect(await onHand(AIKO, HQ)).toBe(500);

    // 100 go back to the supplier → 400.
    const sent = await returnPurchase(first, '100');
    await withScope(scope(manager), (tx) => gr.post(tx, manager, sent.id));
    expect(await onHand(AIKO, HQ)).toBe(400);
    await everythingAgrees();

    // Transfer 100 to Baghdad → 300 here, 100 there, 400 in all.
    await transfer(AIKO, HQ, BAGHDAD, '100');
    expect(await onHand(AIKO, HQ)).toBe(300);
    expect(await onHand(AIKO, BAGHDAD)).toBe(100);
    expect(await companyWide(AIKO)).toBe(400);

    // 40 come back → 340 here, 60 there, still 400.
    await transfer(AIKO, BAGHDAD, HQ, '40');
    expect(await onHand(AIKO, HQ)).toBe(340);
    expect(await onHand(AIKO, BAGHDAD)).toBe(60);
    expect(await companyWide(AIKO)).toBe(400);

    // Sell 100 from here → 240 here, 60 there untouched, 300 in all.
    await sell(AIKO, HQ, '100', '8000');
    expect(await onHand(AIKO, HQ)).toBe(240);
    expect(await onHand(AIKO, BAGHDAD)).toBe(60);
    expect(await companyWide(AIKO)).toBe(300);

    await everythingAgrees();
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · Baghdad, with the figures as they stand on the live system', () => {
  it('holds 507 units worth 250,350 IQD — the second is dinars, not units', async () => {
    const invoiceTotal = async (table: 'ap_invoice' | 'ar_invoice', id: string) =>
      Number(
        (
          await ownerPool.query(
            `select ${table === 'ap_invoice' ? 'total_iqd' : 'net_iqd'}::float as total
               from ${table} where id = $1`,
            [id],
          )
        ).rows[0].total,
      );

    // API-HQ-2026-000002: 10 units at 50 IQD. The invoice comes to 500 IQD,
    // which is the figure that was read as "an AP Invoice for 500".
    const small = await buy(FLYFINE, BAGHDAD, '10', '50');
    expect(await invoiceTotal('ap_invoice', small.id)).toBe(500);
    expect(await onHand(FLYFINE, BAGHDAD)).toBe(10);

    // API-HQ-2026-000003: 500 units at 500 IQD — 250,000 IQD of stock.
    const large = await buy(FLYFINE, BAGHDAD, '500', '500');
    expect(await invoiceTotal('ap_invoice', large.id)).toBe(250_000);
    expect(await onHand(FLYFINE, BAGHDAD)).toBe(510);

    // INV-HQ-2026-000002: 3 units at 100 IQD — a sale of 300 IQD.
    const sale = await sell(FLYFINE, BAGHDAD, '3', '100');
    expect(await invoiceTotal('ar_invoice', sale.id)).toBe(300);

    // Opening 0 + purchases 510 − sales 3 + returns 0 − transfers 0 = 507.
    expect(await onHand(FLYFINE, BAGHDAD)).toBe(507);
    expect(await companyWide(FLYFINE)).toBe(507);

    // The Warehouses Report — the screen the figure was read from.
    const [row] = (await report()).filter((r) => r.itemCode === FLYFINE);
    expect(row).toMatchObject({ warehouseCode: BAGHDAD, warehouseName: 'Baghdad' });
    expect(Number(row!.quantity)).toBe(507);
    // FIFO: the 3 sold came off the 10 bought at 50, so 7 × 50 + 500 × 500.
    expect(Number(row!.valueIqd)).toBe(250_350);

    // The three invoice totals are money and appear in no movement.
    const quantities = (await ledgerRows(FLYFINE)).map((r) => Math.abs(Number(r.quantity)));
    expect(quantities.sort((a, b) => a - b)).toEqual([3, 10, 500]);
    expect(quantities).not.toContain(250_000);
    expect(quantities).not.toContain(300);

    // And the ledger, not the money, is what the page shows.
    const shown = await movementsOf(FLYFINE);
    expect(shown.map((m) => [m.type, m.direction, Number(m.quantity)])).toEqual([
      ['sale', 'out', 3],
      ['purchase', 'in', 500],
      ['purchase', 'in', 10],
    ]);

    await everythingAgrees();
  });

  it('never lets a line total, an invoice total or a unit price into the quantity', async () => {
    // Quantity 500 at 500 IQD is 250,000 IQD. Every figure but 500 is money.
    const bought = await buy(FLYFINE, BAGHDAD, '500', '500');
    expect(units(bought.lineQuantity)).toBe(500);

    const [movement] = await ledgerRows(FLYFINE);
    expect(Number(movement!.quantity)).toBe(500);

    const { rows: journal } = await ownerPool.query(
      `select sum(l.debit_iqd)::float as debit from journal_line l
        where l.account_id = $1`,
      [accounts.inventory],
    );
    expect(journal[0].debit).toBe(250_000);

    // A sale of 3 at 100 IQD: the ledger loses 3; the accounts move 300 IQD
    // of revenue. Neither 300 nor 100 is a quantity anywhere.
    await sell(FLYFINE, BAGHDAD, '3', '100');
    expect(await onHand(FLYFINE, BAGHDAD)).toBe(497);
    const { rows: revenue } = await ownerPool.query(
      `select sum(l.credit_iqd)::float as credit from journal_line l where l.account_id = $1`,
      [accounts.sales_revenue],
    );
    expect(revenue[0].credit).toBe(300);
    expect((await ledgerRows(FLYFINE)).map((r) => Math.abs(Number(r.quantity)))).toEqual([500, 3]);
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · a sale takes stock from the warehouse it names, and no other', () => {
  it('decreases Baghdad for a Baghdad sale and WH-HQ for a WH-HQ sale', async () => {
    await buy(AIKO, BAGHDAD, '100', '1000');
    await buy(AIKO, HQ, '100', '1000');

    const fromBaghdad = await sell(AIKO, BAGHDAD, '30', '2000');
    expect(await onHand(AIKO, BAGHDAD)).toBe(70);
    expect(await onHand(AIKO, HQ)).toBe(100);

    const fromHq = await sell(AIKO, HQ, '45', '2000');
    expect(await onHand(AIKO, HQ)).toBe(55);
    expect(await onHand(AIKO, BAGHDAD)).toBe(70); // untouched by the other sale

    // The document's quantity is the ledger's, exactly, at the warehouse named.
    for (const [sale, warehouse, quantity] of [
      [fromBaghdad, BAGHDAD, 30],
      [fromHq, HQ, 45],
    ] as const) {
      const rows = (await ledgerRows(AIKO)).filter((r) => r.source_document_id === sale.id);
      expect(rows.map((r) => [r.kind, r.warehouse_code])).toEqual([['delivery', warehouse]]);
      expect(rows.reduce((sum, r) => sum + Number(r.quantity), 0)).toBe(-quantity);
      expect(units(sale.lineQuantity)).toBe(quantity);
    }
  });

  it('keeps five warehouses independent of one another', async () => {
    const houses = [BAGHDAD, HQ, IN_PROCESS, ON_BOARD, ON_PORT] as const;
    for (const house of houses) await buy(AIKO, house, '20', '1000');

    await sell(AIKO, HQ, '5', '2000');
    await sell(AIKO, BAGHDAD, '7', '2000');
    await sell(AIKO, ON_PORT, '20', '2000');

    expect(await onHand(AIKO, HQ)).toBe(15);
    expect(await onHand(AIKO, BAGHDAD)).toBe(13);
    expect(await onHand(AIKO, IN_PROCESS)).toBe(20);
    expect(await onHand(AIKO, ON_BOARD)).toBe(20);
    expect(await onHand(AIKO, ON_PORT)).toBe(0);
    expect(await companyWide(AIKO)).toBe(100 - 32);

    // The report says the same thing, warehouse by warehouse.
    const rows = await report();
    const byHouse = Object.fromEntries(rows.map((r) => [r.warehouseCode, Number(r.quantity)]));
    expect(byHouse).toEqual({ [HQ]: 15, [BAGHDAD]: 13, [IN_PROCESS]: 20, [ON_BOARD]: 20 });

    await everythingAgrees();
  });

  it('shows each sale on the Stock Movement page as Out of the warehouse it named', async () => {
    await buy(AIKO, BAGHDAD, '10', '1000');
    const sale = await sell(AIKO, BAGHDAD, '4', '2000');

    const shown = (await movementsOf(AIKO)).filter((m) => m.type === 'sale');
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      direction: 'out',
      quantity: '4.000000',
      warehouseCode: BAGHDAD,
      documentNo: sale.invoiceNo,
    });
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · returns, in both directions, into the warehouse named', () => {
  it('a sale of 100 and a return of 30 net to −70', async () => {
    await buy(AIKO, HQ, '200', '1000');
    const sale = await sell(AIKO, HQ, '100', '2000');
    expect(await onHand(AIKO, HQ)).toBe(100);

    const back = await returnSale(sale, '30', HQ);
    await withScope(scope(manager), (tx) => sr.acceptAndSettle(tx, manager, back.id));

    expect(await onHand(AIKO, HQ)).toBe(130); // 200 − 100 + 30
    const rows = (await ledgerRows(AIKO)).filter((r) => r.source_document_id === back.id);
    expect(rows.map((r) => [r.kind, r.warehouse_code, Number(r.quantity)])).toEqual([
      ['sales_return', HQ, 30],
    ]);
    await everythingAgrees();
  });

  it('a sales return goes into the warehouse the inspection names', async () => {
    await buy(AIKO, HQ, '50', '1000');
    const sale = await sell(AIKO, HQ, '20', '2000');

    // Sold from Head Office, sent back to Baghdad.
    const back = await returnSale(sale, '5', BAGHDAD);
    await withScope(scope(manager), (tx) => sr.acceptAndSettle(tx, manager, back.id));

    expect(await onHand(AIKO, HQ)).toBe(30);
    expect(await onHand(AIKO, BAGHDAD)).toBe(5);
    expect(await companyWide(AIKO)).toBe(35);
  });

  it('a purchase of 500 and a return of 200 net to +300', async () => {
    const bought = await buy(AIKO, HQ, '500', '1000');
    const sent = await returnPurchase(bought, '200');
    await withScope(scope(manager), (tx) => gr.post(tx, manager, sent.id));

    expect(await onHand(AIKO, HQ)).toBe(300);
    const rows = (await ledgerRows(AIKO)).filter((r) => r.source_document_id === sent.id);
    expect(rows.map((r) => [r.kind, r.warehouse_code])).toEqual([['goods_return', HQ]]);
    expect(rows.reduce((sum, r) => sum + Number(r.quantity), 0)).toBe(-200);
    await everythingAgrees();
  });

  it('a purchase return leaves the warehouse the goods are actually in', async () => {
    const bought = await buy(AIKO, HQ, '10', '1000');
    await transfer(AIKO, HQ, BAGHDAD, '10');

    const sent = await returnPurchase(bought, '4', BAGHDAD);
    await withScope(scope(manager), (tx) => gr.post(tx, manager, sent.id));

    expect(await onHand(AIKO, HQ)).toBe(0);
    expect(await onHand(AIKO, BAGHDAD)).toBe(6);
    await everythingAgrees();
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · transfers: Out here, In there, once, on the same document', () => {
  it('writes TRF 100, 50 and 10 as three OUT/IN pairs, all on the Stock Movement page', async () => {
    await buy(AIKO, HQ, '250', '7000');

    const made = [
      await transfer(AIKO, HQ, ON_PORT, '100'),
      await transfer(AIKO, HQ, ON_PORT, '50'),
      await transfer(AIKO, HQ, IN_PROCESS, '10'),
    ];
    expect(made.map((t) => t.transferNo)).toEqual([
      'TRF-HQ-2026-000001',
      'TRF-HQ-2026-000002',
      'TRF-HQ-2026-000003',
    ]);

    // 160 left Head Office; nothing left the company.
    expect(await onHand(AIKO, HQ)).toBe(90);
    expect(await onHand(AIKO, ON_PORT)).toBe(150);
    expect(await onHand(AIKO, IN_PROCESS)).toBe(10);
    expect(await companyWide(AIKO)).toBe(250);

    // Every transfer, on the page, both sides, same number, once each.
    const shown = (await movementsOf(AIKO)).filter((m) => m.type === 'transfer');
    for (const [transferNo, from, to, quantity] of [
      ['TRF-HQ-2026-000001', HQ, ON_PORT, '100.000000'],
      ['TRF-HQ-2026-000002', HQ, ON_PORT, '50.000000'],
      ['TRF-HQ-2026-000003', HQ, IN_PROCESS, '10.000000'],
    ] as const) {
      const rows = shown.filter((m) => m.documentNo === transferNo);
      expect(rows.map((m) => [m.direction, m.warehouseCode, m.quantity, m.fromWarehouseCode, m.toWarehouseCode]).sort()).toEqual(
        [
          ['in', to, quantity, from, to],
          ['out', from, quantity, from, to],
        ].sort(),
      );
    }
    expect(shown).toHaveLength(6);

    // The Transfer page and the ledger say the same quantity for each.
    for (const row of await transferPage()) {
      expect(units(row.ledgerQuantity), row.transferNo).toBe(units(row.quantity));
    }

    await everythingAgrees();
  });

  it('carries the layers across at their own cost, so the company is worth the same', async () => {
    await buy(AIKO, HQ, '10', '7000');
    await buy(AIKO, HQ, '10', '9000');
    await transfer(AIKO, HQ, BAGHDAD, '15'); // all of the first, half of the second

    const rows = await report();
    const value = rows.reduce((sum, r) => sum + Number(r.valueIqd), 0);
    expect(value).toBe(160_000);
    expect(Number(rows.find((r) => r.warehouseCode === BAGHDAD)!.valueIqd)).toBe(115_000);
    expect(Number(rows.find((r) => r.warehouseCode === HQ)!.valueIqd)).toBe(45_000);
    await everythingAgrees();
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · invoice status tracking moves the goods without multiplying them', () => {
  it('500 in, 250 back, and 250 through every stage to Head Office', async () => {
    const invoice = await buy(AIKO, IN_PROCESS, '500', '7000');
    expect(await onHand(AIKO, IN_PROCESS)).toBe(500);

    const sent = await returnPurchase(invoice, '250');
    await withScope(scope(manager), (tx) => gr.post(tx, manager, sent.id));
    expect(await onHand(AIKO, IN_PROCESS)).toBe(250);
    expect(await companyWide(AIKO)).toBe(250);

    const shipment = (await withScope(scope(manager), (tx) => shipments.list(tx))).find(
      (row) => row.invoiceNo === invoice.invoiceNo,
    )!;

    await withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'on_board'));
    expect(await onHand(AIKO, IN_PROCESS)).toBe(0);
    expect(await onHand(AIKO, ON_BOARD)).toBe(250);
    expect(await companyWide(AIKO)).toBe(250);

    await withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'on_port'));
    expect(await onHand(AIKO, ON_BOARD)).toBe(0);
    expect(await onHand(AIKO, ON_PORT)).toBe(250);
    expect(await companyWide(AIKO)).toBe(250);

    await withScope(scope(manager), (tx) =>
      shipments.advance(tx, manager, shipment.id, 'in_bounded', HQ),
    );
    expect(await onHand(AIKO, ON_PORT)).toBe(0);
    expect(await onHand(AIKO, HQ)).toBe(250);
    expect(await companyWide(AIKO)).toBe(250);

    // Each stage is an OUT and an IN of 250 on the page, from and to named.
    const stages = (await movementsOf(AIKO)).filter((m) => m.type === 'shipment');
    expect(stages).toHaveLength(6);
    expect(
      stages
        .filter((m) => m.direction === 'out')
        .map((m) => [m.fromWarehouseCode, m.toWarehouseCode, Number(m.quantity)])
        .sort(),
    ).toEqual(
      [
        [IN_PROCESS, ON_BOARD, 250],
        [ON_BOARD, ON_PORT, 250],
        [ON_PORT, HQ, 250],
      ].sort(),
    );

    await everythingAgrees();
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · a document posts once, however many times it is asked', () => {
  it('two posts of one purchase invoice, together, receive the goods once', async () => {
    const made = await withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: '',
        purchaseOrderId: null,
        branchCode: BRANCH,
        invoiceDate: ON,
        dueDate: '2026-05-01',
        lines: [
          {
            itemCode: AIKO,
            description: null,
            quantity: qty('500'),
            unitPriceIqd: price('500'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: BAGHDAD,
          },
        ],
      }),
    );
    await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, made.id));

    const outcomes = await Promise.allSettled([
      withScope(scope(ceo), (tx) => ap.post(tx, ceo, made.id)),
      withScope(scope(ceo), (tx) => ap.post(tx, ceo, made.id)),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    expect(await onHand(AIKO, BAGHDAD)).toBe(500);
    expect((await ledgerRows(AIKO)).filter((r) => r.source_document_id === made.id)).toHaveLength(1);

    // And a third, later, is refused the same way.
    expect(await rejection(withScope(scope(ceo), (tx) => ap.post(tx, ceo, made.id)))).toMatch(
      /posted|submitted/,
    );
    expect(await onHand(AIKO, BAGHDAD)).toBe(500);
  });

  it('two posts of one sales invoice, together, ship the goods once', async () => {
    await buy(AIKO, BAGHDAD, '100', '500');
    const made = await withScope(scope(clerk), (tx) =>
      ar.createDirect(tx, clerk, {
        customerId,
        branchCode: BRANCH,
        invoiceDate: ON,
        dueDate: '2026-05-20',
        lines: [
          { itemCode: AIKO, quantity: qty('30'), unitPriceIqd: price('900'), warehouseCode: BAGHDAD },
        ],
      }),
    );
    await withScope(scope(ceo), (tx) => ar.approve(tx, ceo, made.id));

    const outcomes = await Promise.allSettled([
      withScope(scope(manager), (tx) => ar.post(tx, manager, made.id)),
      withScope(scope(manager), (tx) => ar.post(tx, manager, made.id)),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);

    expect(await onHand(AIKO, BAGHDAD)).toBe(70);
    const rows = (await ledgerRows(AIKO)).filter((r) => r.source_document_id === made.id);
    expect(rows.reduce((sum, r) => sum + Number(r.quantity), 0)).toBe(-30);
  });

  it('two acceptances of one sales return, together, put the goods back once', async () => {
    await buy(AIKO, HQ, '100', '500');
    const sale = await sell(AIKO, HQ, '40', '900');
    const back = await returnSale(sale, '10', HQ);

    const outcomes = await Promise.allSettled([
      withScope(scope(manager), (tx) => sr.accept(tx, manager, back.id)),
      withScope(scope(manager), (tx) => sr.accept(tx, manager, back.id)),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(AIKO, HQ)).toBe(70);
  });

  it('two posts of one purchase return, together, send the goods back once', async () => {
    const bought = await buy(AIKO, HQ, '100', '500');
    const sent = await returnPurchase(bought, '25');

    const outcomes = await Promise.allSettled([
      withScope(scope(manager), (tx) => gr.post(tx, manager, sent.id)),
      withScope(scope(manager), (tx) => gr.post(tx, manager, sent.id)),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(AIKO, HQ)).toBe(75);
  });

  it('two advances of one shipment, together, move the goods one stage', async () => {
    const invoice = await buy(AIKO, IN_PROCESS, '40', '500');
    const shipment = (await withScope(scope(manager), (tx) => shipments.list(tx))).find(
      (row) => row.invoiceNo === invoice.invoiceNo,
    )!;

    const outcomes = await Promise.allSettled([
      withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'on_board')),
      withScope(scope(manager), (tx) => shipments.advance(tx, manager, shipment.id, 'on_board')),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await onHand(AIKO, IN_PROCESS)).toBe(0);
    expect(await onHand(AIKO, ON_BOARD)).toBe(40);
    expect(await companyWide(AIKO)).toBe(40);
  });

  it('opening the Stock Movement page moves nothing', async () => {
    await buy(AIKO, HQ, '10', '500');
    await transfer(AIKO, HQ, BAGHDAD, '4');
    const before = (await ledgerRows()).length;

    for (let i = 0; i < 3; i += 1) await movementsOf(AIKO);
    await transferPage();
    await report();

    expect((await ledgerRows()).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · negative stock is refused whole', () => {
  const journals = async () =>
    Number((await ownerPool.query(`select count(*)::int as n from journal_entry`)).rows[0].n);

  it('a sale of more than the warehouse holds writes no movement and no journal', async () => {
    await buy(AIKO, BAGHDAD, '10', '500');
    const movements = (await ledgerRows()).length;
    const posted = await journals();

    const message = await rejection(sell(AIKO, BAGHDAD, '11', '900'));
    expect(message).toMatch(/[Nn]egative stock|more .* than/);

    expect(await onHand(AIKO, BAGHDAD)).toBe(10);
    expect((await ledgerRows()).length).toBe(movements);
    expect(await journals()).toBe(posted);
  });

  it('a sale from a warehouse that has none of the item, when another has plenty', async () => {
    await buy(AIKO, HQ, '100', '500');
    await expect(sell(AIKO, BAGHDAD, '1', '900')).rejects.toThrow();
    expect(await onHand(AIKO, HQ)).toBe(100);
    expect(await onHand(AIKO, BAGHDAD)).toBe(0);
  });

  it('a transfer of more than the source holds moves nothing at either end', async () => {
    await buy(AIKO, HQ, '10', '500');
    const movements = (await ledgerRows()).length;

    expect(await rejection(transfer(AIKO, HQ, BAGHDAD, '11'))).toMatch(/Negative stock/);

    expect(await onHand(AIKO, HQ)).toBe(10);
    expect(await onHand(AIKO, BAGHDAD)).toBe(0);
    expect((await ledgerRows()).length).toBe(movements);
    expect(await transferPage()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · the ledger and the documents are held to each other', () => {
  it('a transfer whose movements were removed outside the application is named, not hidden', async () => {
    await buy(AIKO, HQ, '250', '7000');
    const [first, second, third] = [
      await transfer(AIKO, HQ, ON_PORT, '100'),
      await transfer(AIKO, HQ, ON_PORT, '50'),
      await transfer(AIKO, HQ, IN_PROCESS, '10'),
    ];
    expect((await withScope(scope(manager), (tx) => integrity.check(tx))).clean).toBe(true);

    // What the format script did on 2026-09-27: the movements go, the
    // documents stay. Done as the owner with the guards lifted, which is the
    // only way it can happen — the application cannot delete a movement.
    const client = await ownerPool.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(
        `delete from cost_layer_consumption where movement_id in
           (select id from inventory_movement where source_document_id in ($1, $2))`,
        [first!.id, second!.id],
      );
      await client.query(
        `delete from cost_layer where created_by_movement_id in
           (select id from inventory_movement where source_document_id in ($1, $2))`,
        [first!.id, second!.id],
      );
      await client.query(`delete from inventory_movement where source_document_id in ($1, $2)`, [
        first!.id,
        second!.id,
      ]);
    } finally {
      await client.query('set session_replication_role = origin').catch(() => {});
      client.release();
    }

    // The check names exactly the two, by number.
    const health = await withScope(scope(manager), (tx) => integrity.check(tx));
    expect(health.clean).toBe(false);
    expect(health.documentsWithoutLedger.map((d) => [d.documentType, d.documentNo])).toEqual([
      ['stock_transfer', first!.transferNo],
      ['stock_transfer', second!.transferNo],
    ]);

    // The Transfer page says which of its rows the ledger holds.
    const page = await transferPage();
    expect(
      page.map((row) => [row.transferNo, units(row.ledgerQuantity), units(row.quantity)]).sort(),
    ).toEqual(
      [
        [first!.transferNo, 0, 100],
        [second!.transferNo, 0, 50],
        [third!.transferNo, 10, 10],
      ].sort(),
    );

    // And the Stock Movement page shows what is actually in the ledger — the
    // 10 — rather than what the documents claim.
    const shown = (await movementsOf(AIKO)).filter((m) => m.type === 'transfer');
    expect(shown.map((m) => m.documentNo)).toEqual([third!.transferNo, third!.transferNo]);
  });

  it('a movement whose document is gone is named too', async () => {
    const made = await transferAfterBuying('10');
    const client = await ownerPool.connect();
    try {
      await client.query('set session_replication_role = replica');
      await client.query(`delete from stock_transfer where id = $1`, [made.id]);
    } finally {
      await client.query('set session_replication_role = origin').catch(() => {});
      client.release();
    }
    const health = await withScope(scope(manager), (tx) => integrity.check(tx));
    expect(health.ledgerWithoutDocument.map((m) => [m.sourceDocumentType, m.kind]).sort()).toEqual([
      ['stock_transfer', 'transfer_issue'],
      ['stock_transfer', 'transfer_receipt'],
    ]);
  });

  async function transferAfterBuying(quantity: string) {
    await buy(AIKO, HQ, '50', '500');
    return transfer(AIKO, HQ, BAGHDAD, quantity);
  }

  it('a receipt reversed takes its layer with it, so the report and the ledger stay one', async () => {
    const received = await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: AIKO,
        warehouseCode: HQ,
        branchCode: BRANCH,
        quantity: qty('10'),
        unitCostIqd: price('500'),
        movementDate: ON,
        kind: 'goods_receipt',
        batchNumber: 'B-1',
      }),
    );
    expect(await onHand(AIKO, HQ)).toBe(10);
    expect((await report()).map((r) => Number(r.quantity))).toEqual([10]);

    await withScope(scope(manager), (tx) =>
      inventory.reverseMovement(tx, manager, received.movementId, 'Entered against the wrong item.'),
    );
    expect(await onHand(AIKO, HQ)).toBe(0);
    expect(
      units(await withScope(scope(manager), (tx) => inventory.layerQuantityOf(tx, AIKO, HQ))),
    ).toBe(0);
    expect(await report()).toEqual([]);
    expect(await withScope(scope(manager), (tx) => reports.integrity(tx, manager.principal))).toEqual(
      [],
    );
  });

  it('a receipt some of which has been sold cannot be reversed', async () => {
    const bought = await buy(AIKO, HQ, '10', '500');
    await sell(AIKO, HQ, '3', '900');
    const { rows } = await ownerPool.query(
      `select id from inventory_movement where source_document_id = $1 and kind = 'goods_receipt'`,
      [bought.id],
    );
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          inventory.reverseMovement(tx, manager, rows[0].id, 'Trying to undo a receipt.'),
        ),
      ),
    ).toMatch(/has since been issued|cannot be reversed/);
    expect(await onHand(AIKO, HQ)).toBe(7);
  });

  it('opening stock counts once, and every screen agrees on it', async () => {
    // Through the movement the Opening Stock document writes — kind and all.
    await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: AIKO,
        warehouseCode: BAGHDAD,
        branchCode: BRANCH,
        quantity: qty('120'),
        unitCostIqd: price('500'),
        movementDate: ON,
        layerDate: '2026-01-01',
        kind: 'opening_stock',
        batchNumber: 'OPEN',
      }),
    );
    await buy(AIKO, BAGHDAD, '30', '500');
    await sell(AIKO, BAGHDAD, '50', '900');

    expect(await onHand(AIKO, BAGHDAD)).toBe(100);
    expect((await movementsOf(AIKO)).map((m) => [m.type, m.direction, Number(m.quantity)])).toEqual([
      ['sale', 'out', 50],
      ['purchase', 'in', 30],
      ['opening', 'in', 120],
    ]);
    await everythingAgrees();
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · a posted invoice is undone whole, or not at all (decided 2026-09-27)', () => {
  const journalBalance = async (role: string) =>
    Number(
      (
        await ownerPool.query(
          `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::float as balance
             from journal_line l join journal_entry e on e.id = l.journal_entry_id
            where l.account_id = $1 and e.status in ('posted', 'reversed')`,
          [accounts[role]],
        )
      ).rows[0].balance,
    );

  it('reverses a sales invoice: the stock comes back on its own layers, the journal is mirrored', async () => {
    await buy(AIKO, BAGHDAD, '10', '500');
    await buy(AIKO, BAGHDAD, '10', '700');
    const sale = await sell(AIKO, BAGHDAD, '15', '1000'); // 10 at 500 + 5 at 700 = 8,500 of cost
    expect(await onHand(AIKO, BAGHDAD)).toBe(5);
    expect(await journalBalance('cogs')).toBe(8_500);
    expect(await journalBalance('customer_receivable')).toBe(15_000);

    const undone = await withScope(scope(manager), (tx) =>
      ar.reverse(tx, manager, sale.id, { reason: 'Sold from the wrong warehouse.' }),
    );
    expect(undone.movementsReversed).toBe(2); // one per layer consumed

    // The warehouse holds what it held, on the layers it held it on.
    expect(await onHand(AIKO, BAGHDAD)).toBe(20);
    const layers = await withScope(scope(manager), (tx) => inventory.layersOf(tx, AIKO, BAGHDAD));
    expect(layers.map((l) => [units(l.remainingQuantity), Number(l.unitCostIqd) / 10_000])).toEqual([
      [10, 500],
      [10, 700],
    ]);

    // Every account is back where it was, and the two journals point at each other.
    expect(await journalBalance('cogs')).toBe(0);
    expect(await journalBalance('customer_receivable')).toBe(0);
    expect(await journalBalance('sales_revenue')).toBe(0);
    const { rows } = await ownerPool.query(
      `select e.status, e.reversed_by_id is not null as linked, i.status as invoice_status, i.reversal_reason
         from ar_invoice i join journal_entry e on e.id = i.journal_entry_id where i.id = $1`,
      [sale.id],
    );
    expect(rows[0]).toMatchObject({
      status: 'reversed',
      linked: true,
      invoice_status: 'reversed',
      reversal_reason: 'Sold from the wrong warehouse.',
    });

    // The ledger says so too: the deliveries and their reversals, nothing else.
    const shown = (await movementsOf(AIKO)).filter((m) => m.documentNo === sale.invoiceNo);
    expect(shown.map((m) => [m.type, m.direction]).sort()).toEqual(
      [['sale', 'out'], ['sale', 'out'], ['other', 'in'], ['other', 'in']].sort(),
    );
    await everythingAgrees();
  });

  it('reverses a purchase invoice while its goods are still all there', async () => {
    const bought = await buy(AIKO, HQ, '40', '500');
    expect(await journalBalance('inventory')).toBe(20_000);
    expect(await journalBalance('supplier_payable')).toBe(-20_000);

    await withScope(scope(manager), (tx) =>
      ap.reverse(tx, manager, bought.id, { reason: 'Duplicate of an invoice already entered.' }),
    );

    expect(await onHand(AIKO, HQ)).toBe(0);
    expect(
      units(await withScope(scope(manager), (tx) => inventory.layerQuantityOf(tx, AIKO, HQ))),
    ).toBe(0);
    expect(await journalBalance('inventory')).toBe(0);
    expect(await journalBalance('supplier_payable')).toBe(0);
    const { rows } = await ownerPool.query(`select status from ap_invoice where id = $1`, [bought.id]);
    expect(rows[0].status).toBe('reversed');
    await everythingAgrees();
  });

  it('refuses to reverse a purchase invoice whose goods have been sold or moved', async () => {
    const bought = await buy(AIKO, HQ, '40', '500');
    await sell(AIKO, HQ, '1', '900');
    expect(
      await rejection(
        withScope(scope(manager), (tx) => ap.reverse(tx, manager, bought.id, { reason: 'Try.' })),
      ),
    ).toMatch(/has since been issued|cannot be reversed/);
    expect(await onHand(AIKO, HQ)).toBe(39);

    const moved = await buy(AIKO, BAGHDAD, '10', '500');
    await transfer(AIKO, BAGHDAD, HQ, '4');
    expect(
      await rejection(
        withScope(scope(manager), (tx) => ap.reverse(tx, manager, moved.id, { reason: 'Try.' })),
      ),
    ).toMatch(/has since been issued|cannot be reversed/);
    expect(await onHand(AIKO, BAGHDAD)).toBe(6);
  });

  it('refuses to reverse a sales invoice with a return behind it, and needs a reason', async () => {
    await buy(AIKO, HQ, '20', '500');
    const sale = await sell(AIKO, HQ, '10', '900');
    expect(
      await rejection(withScope(scope(manager), (tx) => ar.reverse(tx, manager, sale.id, { reason: '  ' }))),
    ).toMatch(/reason/);

    const back = await returnSale(sale, '2', HQ);
    await withScope(scope(manager), (tx) => sr.acceptAndSettle(tx, manager, back.id));
    expect(
      await rejection(
        withScope(scope(manager), (tx) => ar.reverse(tx, manager, sale.id, { reason: 'Wrong.' })),
      ),
    ).toMatch(/Sales Return .* was raised against it/);
    expect(await onHand(AIKO, HQ)).toBe(12);
  });

  it('reverses once: a second reversal, or a reversal of a draft, is refused', async () => {
    await buy(AIKO, HQ, '5', '500');
    const sale = await sell(AIKO, HQ, '2', '900');
    await withScope(scope(manager), (tx) => ar.reverse(tx, manager, sale.id, { reason: 'Once.' }));
    expect(
      await rejection(withScope(scope(manager), (tx) => ar.reverse(tx, manager, sale.id, { reason: 'Twice.' }))),
    ).toMatch(/reversed|transition|status/i);
    expect(await onHand(AIKO, HQ)).toBe(5);
  });

  it('a shipment whose invoice was reversed cannot be moved on, and leaves the tracking list', async () => {
    const invoice = await buy(AIKO, IN_PROCESS, '12', '500');
    const before = await withScope(scope(manager), (tx) => shipments.list(tx));
    expect(before.map((row) => row.invoiceNo)).toContain(invoice.invoiceNo);

    await withScope(scope(manager), (tx) => ap.reverse(tx, manager, invoice.id, { reason: 'Never shipped.' }));

    const after = await withScope(scope(manager), (tx) => shipments.list(tx));
    expect(after.map((row) => row.invoiceNo)).not.toContain(invoice.invoiceNo);
    expect(
      await rejection(
        withScope(scope(manager), (tx) => shipments.advance(tx, manager, before[0]!.id, 'on_board')),
      ),
    ).toMatch(/was reversed/);
    expect(await onHand(AIKO, IN_PROCESS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · a form pressed twice makes one document', () => {
  it('two transfers with the same form id are one transfer', async () => {
    await buy(AIKO, HQ, '50', '500');
    const formId = randomUUID();
    const twice = () =>
      withScope(scope(clerk), (tx) =>
        stock.transfer(tx, clerk, {
          id: formId,
          itemCode: AIKO,
          fromWarehouseCode: HQ,
          toWarehouseCode: BAGHDAD,
          quantity: qty('10'),
          transferDate: ON,
        }),
      );
    const [first, second] = await Promise.all([twice(), twice()]);
    expect(second).toEqual(first);
    expect(await onHand(AIKO, HQ)).toBe(40);
    expect(await onHand(AIKO, BAGHDAD)).toBe(10);
    expect(await transferPage()).toHaveLength(1);

    // A third press, later, still finds the same document.
    expect(await twice()).toEqual(first);
    expect(await onHand(AIKO, BAGHDAD)).toBe(10);
  });

  it('two reconciliations with the same form id are one reconciliation', async () => {
    await buy(AIKO, HQ, '50', '500');
    const formId = randomUUID();
    const twice = () =>
      withScope(scope(manager), (tx) =>
        stock.adjust(tx, manager, {
          id: formId,
          itemCode: AIKO,
          warehouseCode: HQ,
          direction: 'out',
          quantity: qty('3'),
          adjustmentDate: ON,
        }),
      );
    const [first, second] = await Promise.all([twice(), twice()]);
    expect(second).toEqual(first);
    expect(await onHand(AIKO, HQ)).toBe(47);
  });

  it('two different forms are two transfers, as before', async () => {
    await buy(AIKO, HQ, '50', '500');
    await transfer(AIKO, HQ, BAGHDAD, '10');
    await transfer(AIKO, HQ, BAGHDAD, '10');
    expect(await onHand(AIKO, BAGHDAD)).toBe(20);
    expect(await transferPage()).toHaveLength(2);
  });

  it('refuses a form id that is not one', async () => {
    await buy(AIKO, HQ, '5', '500');
    expect(
      await rejection(
        withScope(scope(clerk), (tx) =>
          stock.transfer(tx, clerk, {
            id: 'not-a-uuid',
            itemCode: AIKO,
            fromWarehouseCode: HQ,
            toWarehouseCode: BAGHDAD,
            quantity: qty('1'),
            transferDate: ON,
          }),
        ),
      ),
    ).toMatch(/stale/);
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · a movement carries the branch of its warehouse', () => {
  it('refuses a movement raised under another branch, in the service and in the database', async () => {
    // A second branch with its main warehouse, WH-ERB.
    await seedBranch('ERB', 'Erbil');

    // The service, with the actor's own branch: refused with the two names.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          inventory.receive(tx, manager, {
            itemCode: AIKO,
            warehouseCode: 'WH-ERB',
            branchCode: BRANCH,
            quantity: qty('1'),
            unitCostIqd: price('1'),
            movementDate: ON,
            kind: 'goods_receipt',
            batchNumber: 'B',
          }),
        ),
      ),
    ).toMatch(/WH-ERB belongs to branch ERB/);

    // The database, for anything that does not come through the service.
    const client = await ownerPool.connect();
    try {
      await client.query(`select set_config('app.is_super_user', 'true', false)`);
      await expect(
        client.query(
          `insert into inventory_movement (item_code, warehouse_code, branch_code, kind, quantity, movement_date, created_by)
           values ($1, 'WH-ERB', $2, 'goods_receipt', 1, $3, $4)`,
          [AIKO, BRANCH, ON, manager.principal.userId],
        ),
      ).rejects.toThrow(/recorded under branch ERB, not HQ/);
    } finally {
      client.release();
    }
    expect(await onHand(AIKO, 'WH-ERB')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('ops 15 · the Stock Ledger and the paged Stock Movement page', () => {
  it('carries the balance down every row, per warehouse, and closes at the position', async () => {
    await buy(AIKO, HQ, '100', '500');
    await sell(AIKO, HQ, '30', '900');
    await transfer(AIKO, HQ, BAGHDAD, '20');
    await sell(AIKO, BAGHDAD, '5', '900');

    const accounts = await withScope(scope(manager), (tx) =>
      stock.ledger(tx, manager, { itemCode: AIKO }),
    );
    expect(accounts.map((a) => [a.warehouseCode, Number(a.opening), Number(a.closing)])).toEqual([
      [BAGHDAD, 0, 15],
      [HQ, 0, 50],
    ]);
    const hq = accounts.find((a) => a.warehouseCode === HQ)!;
    expect(hq.rows.map((r) => [r.type, Number(r.signedQuantity), Number(r.balance)])).toEqual([
      ['purchase', 100, 100],
      ['sale', -30, 70],
      ['transfer', -20, 50],
    ]);
    for (const account of accounts) {
      expect(Number(account.closing)).toBe(await onHand(AIKO, account.warehouseCode));
      // Every row names its document, and the type the page links by.
      for (const row of account.rows) {
        expect(row.documentNo).toBeTruthy();
        expect(row.documentType).toBeTruthy();
      }
    }
  });

  it('opens on what the warehouse held before the period', async () => {
    await buy(AIKO, HQ, '100', '500'); // dated ON = 2026-04-01
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       select id, 5, 'May 2026', '2026-05-01', '2026-05-31' from fiscal_year where code = 'FY2026'
       on conflict do nothing`,
    );
    await withScope(scope(clerk), (tx) =>
      stock.transfer(tx, clerk, {
        itemCode: AIKO,
        fromWarehouseCode: HQ,
        toWarehouseCode: BAGHDAD,
        quantity: qty('10'),
        transferDate: '2026-05-02',
      }),
    );

    const [hq] = await withScope(scope(manager), (tx) =>
      stock.ledger(tx, manager, {
        itemCode: AIKO,
        warehouseCode: HQ,
        from: '2026-05-01',
        to: '2026-05-31',
      }),
    );
    expect(hq).toMatchObject({ warehouseCode: HQ, opening: '100', closing: '90' });
    expect(hq!.rows).toHaveLength(1);
  });

  it('pages the movements and counts them all, and finds a document by number', async () => {
    await buy(AIKO, HQ, '10', '500');
    for (let i = 0; i < 5; i += 1) await sell(AIKO, HQ, '1', '900');

    const total = await withScope(scope(manager), (tx) =>
      stock.countMovements(tx, manager, { itemCode: AIKO }),
    );
    expect(total).toBe(6);
    const first = await withScope(scope(manager), (tx) =>
      stock.movements(tx, manager, { itemCode: AIKO, limit: 4, offset: 0 }),
    );
    const second = await withScope(scope(manager), (tx) =>
      stock.movements(tx, manager, { itemCode: AIKO, limit: 4, offset: 4 }),
    );
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second].map((m) => m.id)).size).toBe(6);
    expect(first.every((m) => m.uomCode === 'EA')).toBe(true);

    const [sale] = second.filter((m) => m.type === 'sale');
    const found = await withScope(scope(manager), (tx) =>
      stock.movements(tx, manager, { documentNo: sale!.documentNo!.toLowerCase() }),
    );
    expect(found.map((m) => m.documentNo)).toEqual([sale!.documentNo]);
    // And a fragment matches anywhere in the number, across document types.
    const fragment = await withScope(scope(manager), (tx) =>
      stock.movements(tx, manager, { documentNo: '2026-0000' }),
    );
    expect(fragment).toHaveLength(6);
  });
});
