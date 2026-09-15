/**
 * Operations build, block 11 — System Inventory Control (2026-09-14).
 *
 *   Negative Stock   Negative stock is not allowed.
 *
 * One sentence, and the whole of it is in the word *not*. A rule that holds on
 * the path somebody tested and gives way on the one they did not is worth less
 * than no rule, because the books will show stock that was never bought and
 * nobody will be looking.
 *
 * Phase 04 already proved the three paths the blueprint names — the service,
 * the importer, and that no configuration turns the check off — and that two
 * concurrent issues cannot both take the last of something. What it did not
 * prove is the one its own header promises: the database. Nor did anything
 * hold the rule against *every kind of movement*, which is what a system
 * control means. A check that lives in one branch of one function is one
 * refactor away from applying to sales and not to transfers.
 *
 * So: every way stock can leave, the boundary it may reach and not cross, and
 * the constraint underneath that would catch all of them if the code above ever
 * stopped.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const MAIN = 'WH-MAIN';
const SPARE = 'WH-SPARE';
const ON = '2026-04-01';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;

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

const receive = (quantity: string, unitCost = '100000', warehouseCode = MAIN, batch = 'B-1') =>
  withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: PANEL,
      warehouseCode,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      unitCostIqd: price(unitCost),
      movementDate: ON,
      kind: 'goods_receipt',
      batchNumber: batch,
    }),
  );

/** Stock out by whichever kind is being held to the rule. */
const issue = (
  quantity: string,
  kind: Parameters<typeof inventory.issue>[2]['kind'] = 'delivery',
  warehouseCode = MAIN,
) =>
  withScope(scope(manager), (tx) =>
    inventory.issue(tx, manager, {
      itemCode: PANEL,
      warehouseCode,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      movementDate: ON,
      kind,
      batchNumber: 'B-1',
    }),
  );

const onHand = async (warehouseCode = MAIN) =>
  Number(
    (await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, warehouseCode, BAGHDAD),
    )).onHand,
  ) / 1_000_000;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict do nothing`,
  );
  manager = await createManager();

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Solar Panel 550W',true,'EA','batch') returning id`,
      [PANEL],
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
describe('ops 11 · no kind of movement may take a warehouse below zero', () => {
  // The sponsor's own list of what moves stock, in block 7's words: purchases
  // are In, sales are Out, transfers are Out of one and In to the other, and
  // reconciliation adjusts either way. Each is a separate test because each is
  // a separate branch, and a check that stops applying to one of them is a bug
  // nothing else here would catch.
  const outward = [
    ['a sale', 'delivery'],
    ['a transfer out', 'transfer_issue'],
    ['a reconciliation shortfall', 'count_adjustment'],
    ['a return to a supplier', 'goods_return'],
    ['a write-off', 'write_off'],
    ['damage', 'damage'],
    ['an issue to a project', 'project_issue'],
  ] as const;

  for (const [what, kind] of outward) {
    it(`refuses ${what} for more than is there`, async () => {
      await receive('10');

      const message = await rejection(issue('11', kind));
      expect(message).toMatch(/Negative inventory is prohibited/);

      // And nothing moved: a refusal that had already written the movement
      // would leave the rule true and the warehouse wrong.
      expect(await onHand()).toBe(10);
    });
  }

  for (const [what, kind] of outward) {
    it(`refuses ${what} out of an empty warehouse`, async () => {
      const message = await rejection(issue('1', kind));
      expect(message).toMatch(/Negative inventory is prohibited/);
      expect(await onHand()).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
describe('ops 11 · the boundary', () => {
  it('allows exactly what is there, and nothing beyond it', async () => {
    await receive('10');

    await issue('10');
    expect(await onHand()).toBe(0);

    // Zero is not negative. One more is.
    const message = await rejection(issue('1'));
    expect(message).toMatch(/Negative inventory is prohibited/);
    expect(await onHand()).toBe(0);
  });

  it('counts each warehouse on its own', async () => {
    await receive('10', '100000', MAIN);

    // Ten panels exist in the company, none of them in the spare warehouse.
    // Stock cannot be taken from where it is not, however much of it the
    // company holds elsewhere.
    const message = await rejection(issue('1', 'delivery', SPARE));
    expect(message).toMatch(/Negative inventory is prohibited/);
    expect(await onHand(MAIN)).toBe(10);
    expect(await onHand(SPARE)).toBe(0);
  });

  it('refuses a zero or negative quantity outright', async () => {
    await receive('10');

    expect(await rejection(issue('0'))).toMatch(/Negative inventory is prohibited/);
    expect(await onHand()).toBe(10);
  });

  it('holds across a sequence that ends exactly at zero', async () => {
    await receive('10');

    await issue('4');
    await issue('3');
    await issue('3');
    expect(await onHand()).toBe(0);

    expect(await rejection(issue('1'))).toMatch(/Negative inventory is prohibited/);
  });
});

// ---------------------------------------------------------------------------
describe('ops 11 · the transfer moves stock, it does not create it', () => {
  it('refuses to send more than the source holds', async () => {
    await receive('5', '100000', MAIN);

    expect(await rejection(issue('6', 'transfer_issue', MAIN))).toMatch(
      /Negative inventory is prohibited/,
    );
    expect(await onHand(MAIN)).toBe(5);
    expect(await onHand(SPARE)).toBe(0);
  });

  it('leaves the company holding the same total either way', async () => {
    await receive('10', '100000', MAIN);

    await issue('4', 'transfer_issue', MAIN);
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

    expect(await onHand(MAIN)).toBe(6);
    expect(await onHand(SPARE)).toBe(4);
    expect((await onHand(MAIN)) + (await onHand(SPARE))).toBe(10);
  });
});

// ---------------------------------------------------------------------------
describe('ops 11 · the database refuses it too', () => {
  /**
   * The path phase 04's header promised and did not test.
   *
   * The service check is the one that gives a person a sentence they can act
   * on, and it is also the one a future refactor can move, narrow or skip. The
   * constraint underneath cannot be skipped by anything holding a connection:
   * a script, a migration, a hand-run UPDATE at two in the morning.
   */
  it('will not let a cost layer go below zero', async () => {
    await receive('10');

    const { rows } = await ownerPool.query(
      `select id, remaining_quantity from cost_layer
        where item_code = $1 and warehouse_code = $2`,
      [PANEL, MAIN],
    );
    expect(Number(rows[0].remaining_quantity)).toBe(10);

    await expect(
      ownerPool.query(`update cost_layer set remaining_quantity = -1 where id = $1`, [rows[0].id]),
    ).rejects.toThrow(/cost_layer_remaining_within_original/);
  });

  it('will not let a layer be consumed past what it holds', async () => {
    await receive('10');

    const { rows } = await ownerPool.query(
      `select id from cost_layer where item_code = $1 and warehouse_code = $2`,
      [PANEL, MAIN],
    );

    // Eleven out of a layer of ten, written straight to the table.
    await expect(
      ownerPool.query(
        `update cost_layer set remaining_quantity = remaining_quantity - 11 where id = $1`,
        [rows[0].id],
      ),
    ).rejects.toThrow(/cost_layer_remaining_within_original/);
  });

  it('will not let a layer be created holding nothing', async () => {
    // A real movement, so the constraint under test is the one that refuses
    // rather than a missing foreign key beating it to it.
    const { movementId } = await receive('10');

    await expect(
      ownerPool.query(
        `insert into cost_layer
           (item_code, warehouse_code, branch_code, layer_date, sequence,
            original_quantity, remaining_quantity, unit_cost_iqd, created_by_movement_id)
         values ($1,$2,$3,$4,99,0,0,100000,$5)`,
        [PANEL, MAIN, BAGHDAD, ON, movementId],
      ),
    ).rejects.toThrow(/cost_layer_original_positive/);
  });

  it('leaves the stock as it was after every refusal', async () => {
    await receive('10');
    expect(await onHand()).toBe(10);
  });
});
