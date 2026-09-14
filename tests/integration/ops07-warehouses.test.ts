/**
 * Operations build, block 7 — Warehouses (2026-09-12).
 *
 *   Report          Item Name; Item Code; Warehouse Name; Warehouse Code;
 *                   Quantity; Total Price.
 *   Stock Movement  Purchases are stock In. Sales are stock Out. Warehouse
 *                   transfers move stock Out from one and In to another.
 *                   Reconciliation adjusts stock as In or Out.
 *
 * The setup, the transfer, the opening stock and the reconciliation were all
 * here. So was the report — except that it gave codes and no names, which is
 * two of the six columns the sponsor asked for.
 *
 * What this file mostly does is hold the report to the movements: every way
 * stock can move, in and out, and the report agreeing with the warehouse
 * afterwards. A valuation that drifts from the layers it is summing is the
 * failure worth catching, because it is silent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as inventory from '@/server/services/inventory';
import * as reports from '@/server/services/inventory-reports';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const CABLE = 'ITM-CABLE';
const MAIN = 'WH-MAIN';
const SPARE = 'WH-SPARE';
const ON = '2026-04-01';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;
let approver: ActorContext;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Accounting Manager',
  ]);
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
    [id],
  );
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

async function makeItem(code: string, name: string) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,$2,true,'EA','batch') returning id`,
      [code, name],
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

/** Stock in, without a document behind it — the movement is the subject here. */
const receive = (
  itemCode: string,
  warehouseCode: string,
  quantity: string,
  unitCost: string,
  batch = 'B-1',
) =>
  withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode,
      warehouseCode,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      unitCostIqd: price(unitCost),
      movementDate: ON,
      kind: 'goods_receipt',
      batchNumber: batch,
    }),
  );

const issue = (itemCode: string, warehouseCode: string, quantity: string, batch = 'B-1') =>
  withScope(scope(manager), (tx) =>
    inventory.issue(tx, manager, {
      itemCode,
      warehouseCode,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      movementDate: ON,
      kind: 'delivery',
      batchNumber: batch,
    }),
  );

const report = (filter: Parameters<typeof reports.valuation>[2] = {}) =>
  withScope(scope(manager), (tx) => reports.valuation(tx, manager.principal, filter));

/** What the report says, in the sponsor's six columns. */
const rowsOf = async (filter: Parameters<typeof reports.valuation>[2] = {}) =>
  (await report(filter)).map((row) => ({
    itemName: row.itemName,
    itemCode: row.itemCode,
    warehouseName: row.warehouseName,
    warehouseCode: row.warehouseCode,
    quantity: Number(row.quantity),
    totalPrice: Number(row.valueIqd),
  }));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict do nothing`,
  );
  manager = await createManager();
  approver = await createManager();

  await makeItem(PANEL, 'Solar Panel 550W');
  await makeItem(CABLE, 'Network Cable 2m');

  for (const [code, name] of [
    [MAIN, 'Main Warehouse'],
    [SPARE, 'Spare Warehouse'],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type)
       values ($1,$2,$3,'main') on conflict do nothing`,
      [code, name, BAGHDAD],
    );
  }
});

// ---------------------------------------------------------------------------
describe('ops 7 · the warehouses report', () => {
  it('names the item and the warehouse, not only their codes', async () => {
    await receive(PANEL, MAIN, '10', '100000');

    expect(await rowsOf()).toEqual([
      {
        itemName: 'Solar Panel 550W',
        itemCode: PANEL,
        warehouseName: 'Main Warehouse',
        warehouseCode: MAIN,
        quantity: 10,
        totalPrice: 1_000_000,
      },
    ]);
  });

  it('gives one row per item per warehouse', async () => {
    await receive(PANEL, MAIN, '10', '100000');
    await receive(PANEL, SPARE, '4', '100000');
    await receive(CABLE, MAIN, '100', '2000');

    const rows = await rowsOf();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => [r.itemName, r.warehouseName, r.quantity])).toEqual([
      ['Network Cable 2m', 'Main Warehouse', 100],
      ['Solar Panel 550W', 'Main Warehouse', 10],
      ['Solar Panel 550W', 'Spare Warehouse', 4],
    ]);
  });

  it('prices the stock at what the layers hold, not at one average', async () => {
    await receive(PANEL, MAIN, '5', '100000', 'B-1');
    await receive(PANEL, MAIN, '5', '140000', 'B-2');

    const [row] = await rowsOf();
    expect(row!.quantity).toBe(10);
    expect(row!.totalPrice).toBe(1_200_000); // 500,000 + 700,000
  });

  it('narrows to one warehouse, or to one item', async () => {
    await receive(PANEL, MAIN, '10', '100000');
    await receive(PANEL, SPARE, '4', '100000');
    await receive(CABLE, MAIN, '100', '2000');

    expect((await rowsOf({ warehouseCode: SPARE })).map((r) => r.quantity)).toEqual([4]);
    expect((await rowsOf({ itemCode: CABLE })).map((r) => r.itemName)).toEqual([
      'Network Cable 2m',
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('ops 7 · every way stock moves shows in the report', () => {
  it('counts a purchase as In', async () => {
    await receive(PANEL, MAIN, '10', '100000');
    expect((await rowsOf())[0]!.quantity).toBe(10);
  });

  it('counts a sale as Out, and takes its value with it', async () => {
    await receive(PANEL, MAIN, '10', '100000');
    await issue(PANEL, MAIN, '4');

    const [row] = await rowsOf();
    expect(row!.quantity).toBe(6);
    expect(row!.totalPrice).toBe(600_000);
  });

  it('moves a transfer Out of one warehouse and In to the other', async () => {
    await receive(PANEL, MAIN, '10', '100000');

    await withScope(scope(manager), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: PANEL,
        warehouseCode: MAIN,
        branchCode: BAGHDAD,
        quantity: qty('4'),
        movementDate: ON,
        kind: 'transfer_issue',
        batchNumber: 'B-1',
      }),
    );
    await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: PANEL,
        warehouseCode: SPARE,
        branchCode: BAGHDAD,
        quantity: qty('4'),
        unitCostIqd: price('100000'),
        movementDate: ON,
        kind: 'transfer_receipt',
        batchNumber: 'B-1',
      }),
    );

    const rows = await rowsOf();
    expect(rows.map((r) => [r.warehouseName, r.quantity])).toEqual([
      ['Main Warehouse', 6],
      ['Spare Warehouse', 4],
    ]);
    // The company still holds ten panels; they are in two places.
    expect(rows.reduce((total, r) => total + r.quantity, 0)).toBe(10);
    expect(rows.reduce((total, r) => total + r.totalPrice, 0)).toBe(1_000_000);
  });

  it('adjusts In and Out for a reconciliation', async () => {
    await receive(PANEL, MAIN, '10', '100000');

    // Counted nine: one is written off.
    await withScope(scope(manager), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: PANEL,
        warehouseCode: MAIN,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        movementDate: ON,
        kind: 'count_adjustment',
        batchNumber: 'B-1',
      }),
    );
    expect((await rowsOf())[0]!.quantity).toBe(9);

    // Counted eleven the next time: two are brought in.
    await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: PANEL,
        warehouseCode: MAIN,
        branchCode: BAGHDAD,
        quantity: qty('2'),
        unitCostIqd: price('100000'),
        movementDate: ON,
        kind: 'count_adjustment',
        batchNumber: 'B-1',
      }),
    );
    expect((await rowsOf())[0]!.quantity).toBe(11);
  });

  it('drops an item out of the report when the last of it leaves', async () => {
    await receive(PANEL, MAIN, '3', '100000');
    await issue(PANEL, MAIN, '3');

    // Not a row of zero: nothing is there.
    expect(await rowsOf()).toEqual([]);
  });

  it('agrees with the warehouse it is summing', async () => {
    await receive(PANEL, MAIN, '5', '100000', 'B-1');
    await receive(PANEL, MAIN, '5', '140000', 'B-2');
    await issue(PANEL, MAIN, '7', 'B-1');

    const [row] = await rowsOf();
    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, MAIN, BAGHDAD),
    );
    const valued = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, PANEL, MAIN),
    );

    // Two ways of adding up the same layers — the report in SQL, the engine in
    // TypeScript. They are the thing that would drift silently.
    expect(row!.quantity).toBe(Number(position.onHand) / 1_000_000);
    expect(row!.totalPrice).toBe(Number(valued) / 10_000);
    expect(row!.totalPrice).toBe(420_000); // 3 left at 140,000
  });
});
