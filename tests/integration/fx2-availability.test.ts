/**
 * REQ-FIX-001 FX4 — the Availability register reads the stock_position view,
 * which has no row-level security of its own: the branch rule is in the
 * query. A person sees the branches they may, the warehouse filter narrows to
 * one, "only items with stock" drops the empty rows, and the search finds an
 * item by its name.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as availability from '@/server/services/availability';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

let baghdad: ActorContext;
let basra: ActorContext;

async function userIn(branch: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `Storekeeper ${branch}`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

async function item(code: string, name: string) {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(`insert into item (code, name, is_stock, base_uom_code, tracking) values ($1,$2,true,'EA','batch') returning id`, [code, name]);
    await client.query(`insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator) values ($1,'EA',1,1)`, [rows[0].id]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

const receive = (ctx: ActorContext, itemCode: string, quantity: string) =>
  withScope({ userId: ctx.principal.userId, branchCode: ctx.branchCode }, (tx) =>
    inventory.receive(tx, ctx, {
      itemCode,
      warehouseCode: `WH-${ctx.branchCode}`,
      branchCode: ctx.branchCode,
      quantity: parseQuantity(quantity),
      unitCostIqd: parseDecimal('100', 4n),
      movementDate: '2026-03-01',
      batchNumber: 'B-1',
    }),
  );

beforeAll(async () => {
  await resetTestData();
  await seedBranch('BGW', 'Baghdad');
  await seedBranch('BSR', 'Basra');
  await ownerPool.query(
    `insert into role_grant (role_code, object, verb) values ('accounting_manager','inventory_movement','execute'),('accounting_manager','inventory_movement','view') on conflict do nothing`,
  );
  await item('ITM-CABLE', 'Network Cable 2m');
  await item('ITM-ROUTER', 'Router');
  baghdad = await userIn('BGW');
  basra = await userIn('BSR');
  await receive(baghdad, 'ITM-CABLE', '10');
  await receive(baghdad, 'ITM-ROUTER', '1');
  await receive(basra, 'ITM-CABLE', '7');
  // The router in Baghdad is issued to nothing left: a row with no stock available.
  await withScope({ userId: baghdad.principal.userId, branchCode: 'BGW' }, (tx) =>
    inventory.issue(tx, baghdad, { itemCode: 'ITM-ROUTER', warehouseCode: 'WH-BGW', branchCode: 'BGW', quantity: parseQuantity('1'), movementDate: '2026-03-02', batchNumber: 'B-1' }),
  );
});

const read = (ctx: ActorContext, filter: availability.AvailabilityFilter = {}) =>
  withScope({ userId: ctx.principal.userId, branchCode: ctx.branchCode }, (tx) => availability.forScreen(tx, ctx.principal, filter));

describe('FX4 · the Availability register', () => {
  it('shows a person only the branches they may see', async () => {
    const mine = await read(baghdad);
    expect(mine.rows.map((row) => `${row.itemCode}@${row.warehouseCode}`).sort()).toEqual(['ITM-CABLE@WH-BGW', 'ITM-ROUTER@WH-BGW']);
    expect(mine.total).toBe(2);
    const theirs = await read(basra);
    expect(theirs.rows.map((row) => `${row.itemCode}@${row.warehouseCode}`)).toEqual(['ITM-CABLE@WH-BSR']);
    expect(theirs.rows[0]).toMatchObject({ itemName: 'Network Cable 2m', baseUomCode: 'EA' });
  });

  it("a warehouse outside the person's branches gives nothing, rather than its stock", async () => {
    const peek = await read(baghdad, { warehouseCode: 'WH-BSR' });
    expect(peek.total).toBe(0);
    const warehouses = await withScope({ userId: baghdad.principal.userId, branchCode: 'BGW' }, (tx) => availability.warehouses(tx, baghdad.principal));
    expect(warehouses.map((w) => w.code)).toEqual(['WH-BGW']);
  });

  it('drops the rows with nothing available, and finds an item by its name', async () => {
    const stocked = await read(baghdad, { inStock: true });
    expect(stocked.rows.map((row) => row.itemCode)).toEqual(['ITM-CABLE']);
    expect(Number(stocked.rows[0]!.available)).toBe(10);
    const found = await read(baghdad, { search: 'router' });
    expect(found.rows.map((row) => row.itemCode)).toEqual(['ITM-ROUTER']);
    const issuable = await withScope({ userId: baghdad.principal.userId, branchCode: 'BGW' }, (tx) => availability.issuableItems(tx, baghdad.principal));
    expect(issuable.map((row) => row.code)).toEqual(['ITM-CABLE']);
  });
});
