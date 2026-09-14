/**
 * Operations build, block 8 — Invoice Status Tracking (2026-09-12).
 *
 *   In Process   A Purchase Invoice is automatically copied to this section.
 *                The items are booked to the In Process warehouse.
 *   On Board     the items move to the On Board warehouse.
 *   On Port      the items move to the On Port warehouse.
 *   In Bounded   a warehouse must be selected; the items move there.
 *   Notification Every status change notifies the selected system users.
 *
 * Goods bought abroad belong to the company for months before anybody can
 * touch them. The thing worth testing is not the four names — it is that the
 * stock is never lost, never duplicated, and never revalued on the way: the
 * company holds the same ten panels, worth the same money, whether they are in
 * a container or on a shelf.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as inventory from '@/server/services/inventory';
import * as shipments from '@/server/services/supplier-shipment';
import * as reports from '@/server/services/inventory-reports';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const IN_PROCESS = 'WH-INPROC';
const ON_BOARD = 'WH-ONBOARD';
const ON_PORT = 'WH-ONPORT';
const BONDED = 'WH-BONDED';
const ON = '2026-04-01';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let watcher: ActorContext;
let supplierId: string;
let accounts: Record<string, string>;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
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
  watcher = await createUser('accounting_officer');

  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
    ['expense', 'X000001', 'Service Cost'],
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
        `${parent.slice(0, 1)}9${String(name.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        role === 'supplier_payable' ? 'supplier' : null,
      ],
    );
    accounts[role] = rows[0].id;
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('purchasing.ap_invoice', $1, $2, true, $3) on conflict do nothing`,
      [role, rows[0].id, manager.principal.userId],
    );
    await withScope(scope(manager), (tx) =>
      coa.setRequiredDimensions(tx, manager, rows[0].id, []),
    );
  }

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking, inventory_account_id)
       values ($1,'Solar Panel 550W',true,'EA','batch',$2) returning id`,
      [PANEL, accounts.inventory],
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

  // The three staging warehouses, and one real one to land in.
  for (const [code, name, stage] of [
    [IN_PROCESS, 'In Process', 'in_process'],
    [ON_BOARD, 'On Board', 'on_board'],
    [ON_PORT, 'On Port', 'on_port'],
    [BONDED, 'Bonded Store', null],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type, shipment_stage)
       values ($1,$2,$3,'main',$4) on conflict do nothing`,
      [code, name, BAGHDAD, stage],
    );
  }

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','Jinko Solar', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
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
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('ap_invoice','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
});

let seq = 0;

/** A purchase invoice landing in a warehouse, posted. */
async function buy(warehouseCode: string, quantity = '10', unitPrice = '100000') {
  seq += 1;
  const made = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SI-${seq}`,
      purchaseOrderId: null,
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: '2026-05-01',
      nonPoJustification: 'Imported directly.',
      nonPoApprovedBy: manager.principal.userId,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
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
  await withScope(scope(manager), (tx) => ap.post(tx, manager, made.id));
  return made;
}

const shipmentFor = async (invoiceNo: string) => {
  const all = await withScope(scope(manager), (tx) => shipments.list(tx));
  return all.find((row) => row.invoiceNo === invoiceNo)!;
};

const advance = (id: string, to: shipments.ShipmentStatus, warehouseCode?: string) =>
  withScope(scope(manager), (tx) => shipments.advance(tx, manager, id, to, warehouseCode));

const onHand = async (warehouseCode: string) =>
  Number(
    (await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, warehouseCode, BAGHDAD),
    )).onHand,
  ) / 1_000_000;

const inboxOf = async (ctx: ActorContext) => {
  const { rows } = await ownerPool.query(
    `select subject from notification where recipient_user_id = $1 order by id`,
    [ctx.principal.userId],
  );
  return rows.map((r) => r.subject as string);
};

// ---------------------------------------------------------------------------
describe('ops 8 · a purchase invoice into the In Process warehouse is tracked', () => {
  it('opens tracking by itself, at In Process', async () => {
    const invoice = await buy(IN_PROCESS);

    const shipment = await shipmentFor(invoice.invoiceNo);
    expect(shipment.status).toBe('in_process');
    expect(shipment.warehouseCode).toBe(IN_PROCESS);
    expect(await onHand(IN_PROCESS)).toBe(10);
  });

  it('reads the invoice rather than copying it', async () => {
    const invoice = await buy(IN_PROCESS, '4', '250000');
    const shipment = await shipmentFor(invoice.invoiceNo);

    // Supplier, invoice number, date and total all come from the invoice, so
    // they cannot drift from it.
    expect(shipment.supplierName).toBe('Jinko Solar');
    expect(shipment.invoiceDate).toBe(ON);
    expect(Number(shipment.totalIqd)).toBe(1_000_000);
  });

  it('leaves an invoice that landed somewhere else alone', async () => {
    const invoice = await buy(BONDED);
    const all = await withScope(scope(manager), (tx) => shipments.list(tx));
    expect(all.find((row) => row.invoiceNo === invoice.invoiceNo)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe('ops 8 · the stages move the goods', () => {
  it('carries them through all four, and loses none on the way', async () => {
    const invoice = await buy(IN_PROCESS, '10', '100000');
    const shipment = await shipmentFor(invoice.invoiceNo);

    await advance(shipment.id, 'on_board');
    expect(await onHand(IN_PROCESS)).toBe(0);
    expect(await onHand(ON_BOARD)).toBe(10);

    await advance(shipment.id, 'on_port');
    expect(await onHand(ON_BOARD)).toBe(0);
    expect(await onHand(ON_PORT)).toBe(10);

    await advance(shipment.id, 'in_bounded', BONDED);
    expect(await onHand(ON_PORT)).toBe(0);
    expect(await onHand(BONDED)).toBe(10);
  });

  it('carries the cost across unchanged', async () => {
    const invoice = await buy(IN_PROCESS, '10', '100000');
    const shipment = await shipmentFor(invoice.invoiceNo);

    const before = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, PANEL, IN_PROCESS),
    );
    await advance(shipment.id, 'on_board');
    const after = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, PANEL, ON_BOARD),
    );

    // A stage that priced its own stock would be a second opinion about what
    // the company paid.
    expect(Number(after)).toBe(Number(before));
    expect(Number(after) / 10_000).toBe(1_000_000);
  });

  it('never has the company holding more or less than it bought', async () => {
    const invoice = await buy(IN_PROCESS, '10', '100000');
    const shipment = await shipmentFor(invoice.invoiceNo);

    const total = async () => {
      const rows = await withScope(scope(manager), (tx) =>
        reports.valuation(tx, manager.principal, { itemCode: PANEL }),
      );
      return {
        quantity: rows.reduce((t, r) => t + Number(r.quantity), 0),
        value: rows.reduce((t, r) => t + Number(r.valueIqd), 0),
      };
    };

    expect(await total()).toEqual({ quantity: 10, value: 1_000_000 });
    await advance(shipment.id, 'on_board');
    expect(await total()).toEqual({ quantity: 10, value: 1_000_000 });
    await advance(shipment.id, 'on_port');
    expect(await total()).toEqual({ quantity: 10, value: 1_000_000 });
    await advance(shipment.id, 'in_bounded', BONDED);
    expect(await total()).toEqual({ quantity: 10, value: 1_000_000 });
  });

  it('goes forward one stage at a time, and never back', async () => {
    const invoice = await buy(IN_PROCESS);
    const shipment = await shipmentFor(invoice.invoiceNo);

    // Skipping a stage would ask a warehouse to issue goods it never held.
    await expect(advance(shipment.id, 'on_port')).rejects.toThrow(/one stage at a time/);

    await advance(shipment.id, 'on_board');
    await expect(advance(shipment.id, 'in_process' as never)).rejects.toThrow(/do not un-ship/);
  });

  it('insists on a warehouse for the last stage', async () => {
    const invoice = await buy(IN_PROCESS);
    const shipment = await shipmentFor(invoice.invoiceNo);
    await advance(shipment.id, 'on_board');
    await advance(shipment.id, 'on_port');

    await expect(advance(shipment.id, 'in_bounded')).rejects.toThrow(/Choose the warehouse/);
    await expect(advance(shipment.id, 'in_bounded', 'WH-NOWHERE')).rejects.toThrow(/No warehouse/);
  });

  it('ends when the goods arrive', async () => {
    const invoice = await buy(IN_PROCESS);
    const shipment = await shipmentFor(invoice.invoiceNo);
    await advance(shipment.id, 'on_board');
    await advance(shipment.id, 'on_port');
    await advance(shipment.id, 'in_bounded', BONDED);

    await expect(advance(shipment.id, 'in_bounded', BONDED)).rejects.toThrow(/have arrived/);
  });
});

// ---------------------------------------------------------------------------
describe('ops 8 · every status change tells the people who asked', () => {
  it('tells a watcher when the shipment opens and at every stage', async () => {
    await withScope(scope(manager), (tx) =>
      shipments.watch(tx, manager, BAGHDAD, watcher.principal.userId),
    );

    const invoice = await buy(IN_PROCESS);
    const shipment = await shipmentFor(invoice.invoiceNo);
    await advance(shipment.id, 'on_board');
    await advance(shipment.id, 'on_port');
    await advance(shipment.id, 'in_bounded', BONDED);

    const inbox = await inboxOf(watcher);
    expect(inbox).toHaveLength(4);
    expect(inbox[0]).toMatch(/opened/);
    expect(inbox[1]).toMatch(/on board/);
    expect(inbox[2]).toMatch(/on port/);
    expect(inbox[3]).toMatch(/in bounded/);
  });

  it('tells nobody who did not ask', async () => {
    const invoice = await buy(IN_PROCESS);
    const shipment = await shipmentFor(invoice.invoiceNo);
    await advance(shipment.id, 'on_board');

    expect(await inboxOf(watcher)).toEqual([]);
  });

  it('stops telling somebody who asked to stop', async () => {
    await withScope(scope(manager), (tx) =>
      shipments.watch(tx, manager, BAGHDAD, watcher.principal.userId),
    );
    const invoice = await buy(IN_PROCESS);
    const shipment = await shipmentFor(invoice.invoiceNo);

    await withScope(scope(manager), (tx) =>
      shipments.unwatch(tx, manager, BAGHDAD, watcher.principal.userId),
    );
    await advance(shipment.id, 'on_board');

    // The opening message, and nothing after it.
    expect(await inboxOf(watcher)).toHaveLength(1);
  });
});
