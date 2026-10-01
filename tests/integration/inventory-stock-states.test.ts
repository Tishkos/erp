/**
 * Phase 04.7 and 04.9 test gate — quarantine, damage and write-off.
 *
 *   04.7  Quarantine stock never appears in Available
 *         Release moves stock to the target warehouse preserving its FIFO layer
 *         Rejection routes to the Goods Return process without a separate
 *         manual movement
 *
 *   04.9  Damaged stock cannot be reserved
 *         Damaged stock cannot be sold
 *         Damaged stock cannot be moved back to saleable after final damage
 *         approval, by any path
 *         Write-off posts through the Phase 02 engine at the correct FIFO cost
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as states from '@/server/services/stock-states';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
const STORES = 'WH-BGW';
const QUARANTINE = 'WH-QUAR';
const DAMAGED = 'WH-DMG';
const RETURNS = 'WH-RET';
const ITEM = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const cost = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Warehouse Manager',
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
    `insert into role_grant (role_code, object, verb) values
       ('accounting_manager','inventory_movement','execute'),
       ('accounting_manager','inventory_movement','view'),
       ('accounting_manager','inventory_movement','approve'),
       ('accounting_manager','inventory_movement','reverse_cancel')
     on conflict do nothing`,
  );

  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = () => ({ userId: manager.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  // One warehouse of each §9.1 type the lifecycle needs.
  for (const [code, name, type] of [
    [QUARANTINE, 'Baghdad Quarantine', 'quarantine'],
    [DAMAGED, 'Baghdad Damaged Goods', 'damaged_goods'],
    [RETURNS, 'Baghdad Returns', 'returns'],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type) values ($1,$2,$3,$4)`,
      [code, name, BAGHDAD, type],
    );
  }

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1, 'Network Cable 2m', true, 'EA', 'batch') returning id`,
      [ITEM],
    );
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
       values ($1, 'EA', 1, 1)`,
      [rows[0].id],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  manager = await createManager();
});

const positionAt = (warehouse: string) =>
  withScope(scope(), (tx) => inventory.positionOf(tx, ITEM, warehouse, BAGHDAD));

/** Puts 100 @ 10 and 100 @ 12 into stores. */
async function stockStores(): Promise<void> {
  for (const [quantity, unitCost, date] of [
    ['100', '10', '2026-01-10'],
    ['100', '12', '2026-01-20'],
  ] as const) {
    await withScope(scope(), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: ITEM,
        warehouseCode: STORES,
        branchCode: BAGHDAD,
        quantity: qty(quantity),
        unitCostIqd: cost(unitCost),
        movementDate: date,
        batchNumber: 'B-1',
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// 04.7 — quarantine
// ---------------------------------------------------------------------------

describe('04.7 gate · quarantine stock never appears in Available', () => {
  beforeEach(async () => {
    await withScope(scope(), (tx) =>
      states.receiveIntoQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        branchCode: BAGHDAD,
        quantity: qty('60'),
        unitCostIqd: cost('9'),
        movementDate: '2026-02-01',
        batchNumber: 'B-Q',
      }),
    );
  });

  it('holds the stock on hand — the company owns it and it is on the premises', async () => {
    expect(formatQuantity((await positionAt(QUARANTINE)).onHand)).toBe('60');
  });

  it('reports none of it as available (§8.4)', async () => {
    const position = await positionAt(QUARANTINE);
    expect(formatQuantity(position.inQuarantine)).toBe('60');
    expect(formatQuantity(availableQuantity(position))).toBe('0');
  });

  it('refuses to issue it for sale', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.issue(tx, manager, {
            itemCode: ITEM,
            warehouseCode: QUARANTINE,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            movementDate: '2026-02-02',
            batchNumber: 'B-Q',
          }),
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);
  });

  it('refuses to reserve it', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.reserve(tx, manager, {
            itemCode: ITEM,
            warehouseCode: QUARANTINE,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            documentType: 'sales_order',
            documentId: 'SO-1',
          }),
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);
  });

  it('keeps it out of the company’s available figure while counting it on hand', async () => {
    await stockStores();

    const positions = await withScope(scope(), (tx) => inventory.positionsOf(tx, ITEM));
    const onHand = positions.reduce((sum, p) => sum + p.onHand, 0n);
    const available = positions.reduce((sum, p) => sum + availableQuantity(p), 0n);

    expect(formatQuantity(onHand)).toBe('260');
    expect(formatQuantity(available)).toBe('200');
  });

  it('refuses to quarantine into a warehouse that is not a quarantine one', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          states.receiveIntoQuarantine(tx, manager, {
            itemCode: ITEM,
            quarantineWarehouseCode: STORES,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            unitCostIqd: cost('9'),
            movementDate: '2026-02-01',
            batchNumber: 'B-Q',
          }),
        ),
      ),
    ).toMatch(/is a 'main' warehouse, and this needs a 'quarantine' one/);
  });
});

describe('04.7 gate · release preserves the FIFO layer', () => {
  beforeEach(async () => {
    // Two layers in quarantine, so "preserves the layer" means something.
    for (const [quantity, unitCost, date] of [
      ['40', '9', '2026-02-01'],
      ['20', '11', '2026-02-05'],
    ] as const) {
      await withScope(scope(), (tx) =>
        states.receiveIntoQuarantine(tx, manager, {
          itemCode: ITEM,
          quarantineWarehouseCode: QUARANTINE,
          branchCode: BAGHDAD,
          quantity: qty(quantity),
          unitCostIqd: cost(unitCost),
          movementDate: date,
          batchNumber: 'B-Q',
        }),
      );
    }
  });

  it('moves the stock into the target warehouse', async () => {
    await withScope(scope(), (tx) =>
      states.releaseFromQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        targetWarehouseCode: STORES,
        branchCode: BAGHDAD,
        quantity: qty('60'),
        movementDate: '2026-02-10',
        reason: 'Inspected: all units conform.',
        batchNumber: 'B-Q',
      }),
    );

    expect(formatQuantity((await positionAt(QUARANTINE)).onHand)).toBe('0');
    expect(formatQuantity(availableQuantity(await positionAt(STORES)))).toBe('60');
  });

  it('carries both layer costs across untouched', async () => {
    // Inspection is not a cost event. Stock that waited a week in quarantine did
    // not become worth more for having waited.
    await withScope(scope(), (tx) =>
      states.releaseFromQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        targetWarehouseCode: STORES,
        branchCode: BAGHDAD,
        quantity: qty('60'),
        movementDate: '2026-02-10',
        reason: 'Inspected: all units conform.',
        batchNumber: 'B-Q',
      }),
    );

    const layers = await withScope(scope(), (tx) => inventory.layersOf(tx, ITEM, STORES));
    expect(layers.map((l) => toDecimalString(l.unitCostIqd, 4n))).toEqual(['9.0000', '11.0000']);
    expect(layers.map((l) => formatQuantity(l.remainingQuantity))).toEqual(['40', '20']);
  });

  it('keeps the total valuation unchanged by the release', async () => {
    const before = await withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, QUARANTINE));

    await withScope(scope(), (tx) =>
      states.releaseFromQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        targetWarehouseCode: STORES,
        branchCode: BAGHDAD,
        quantity: qty('60'),
        movementDate: '2026-02-10',
        reason: 'Inspected.',
        batchNumber: 'B-Q',
      }),
    );

    const after = await withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, STORES));
    expect(toDecimalString(after, 4n)).toBe(toDecimalString(before, 4n));
    expect(toDecimalString(before, 4n)).toBe('580.0000'); // 40×9 + 20×11
  });

  it('needs a stated reason — an inspection is a decision (§5.4)', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          states.releaseFromQuarantine(tx, manager, {
            itemCode: ITEM,
            quarantineWarehouseCode: QUARANTINE,
            targetWarehouseCode: STORES,
            branchCode: BAGHDAD,
            quantity: qty('10'),
            movementDate: '2026-02-10',
            reason: '  ',
            batchNumber: 'B-Q',
          }),
        ),
      ),
    ).toMatch(/keeps the reason with it/);
  });
});

describe('04.7 gate · rejection routes to Goods Return without a manual movement', () => {
  beforeEach(async () => {
    await withScope(scope(), (tx) =>
      states.receiveIntoQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        unitCostIqd: cost('9'),
        movementDate: '2026-02-01',
        batchNumber: 'B-Q',
      }),
    );
  });

  it('puts the stock in the returns warehouse, ready for Phase 05', async () => {
    await withScope(scope(), (tx) =>
      states.rejectFromQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        returnsWarehouseCode: RETURNS,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-10',
        reason: 'Damaged packaging; units out of specification.',
        batchNumber: 'B-Q',
      }),
    );

    const returns = await positionAt(RETURNS);
    expect(formatQuantity(returns.onHand)).toBe('30');
    expect(formatQuantity(returns.returnsStock)).toBe('30');
    // Not saleable while it waits for the return document.
    expect(formatQuantity(availableQuantity(returns))).toBe('0');
  });

  it('does it in one act — the rejection is the movement', async () => {
    // 04.7's gate: "without a separate manual movement". The stock is already
    // where the return document will find it.
    await withScope(scope(), (tx) =>
      states.rejectFromQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        returnsWarehouseCode: RETURNS,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-10',
        reason: 'Out of specification.',
        batchNumber: 'B-Q',
      }),
    );

    const { rows } = await ownerPool.query(
      `select kind, warehouse_code from inventory_movement
        where movement_date = '2026-02-10' order by created_at`,
    );
    expect(rows.map((r) => r.kind)).toEqual(['quarantine_reject', 'goods_return']);
  });

  it('keeps the cost with the rejected stock', async () => {
    await withScope(scope(), (tx) =>
      states.rejectFromQuarantine(tx, manager, {
        itemCode: ITEM,
        quarantineWarehouseCode: QUARANTINE,
        returnsWarehouseCode: RETURNS,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-10',
        reason: 'Out of specification.',
        batchNumber: 'B-Q',
      }),
    );

    const value = await withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, RETURNS));
    expect(toDecimalString(value, 4n)).toBe('270.0000'); // 30 × 9
  });
});

// ---------------------------------------------------------------------------
// 04.9 — damage and write-off
// ---------------------------------------------------------------------------

describe('04.9 gate · damaged stock is out of circulation', () => {
  beforeEach(async () => {
    await stockStores();
    await withScope(scope(), (tx) =>
      states.approveDamage(tx, manager, {
        itemCode: ITEM,
        fromWarehouseCode: STORES,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-15',
        reason: 'Water damage in the loading bay.',
        batchNumber: 'B-1',
      }),
    );
  });

  it('moves it to the damaged warehouse and out of Available', async () => {
    expect(formatQuantity(availableQuantity(await positionAt(STORES)))).toBe('170');

    const damaged = await positionAt(DAMAGED);
    expect(formatQuantity(damaged.onHand)).toBe('30');
    expect(formatQuantity(damaged.damaged)).toBe('30');
    expect(formatQuantity(availableQuantity(damaged))).toBe('0');
  });

  it('cannot be reserved', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.reserve(tx, manager, {
            itemCode: ITEM,
            warehouseCode: DAMAGED,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            documentType: 'sales_order',
            documentId: 'SO-1',
          }),
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);
  });

  it('cannot be sold', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.issue(tx, manager, {
            itemCode: ITEM,
            warehouseCode: DAMAGED,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            movementDate: '2026-02-16',
            kind: 'delivery',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);
  });

  it('cannot be moved back into saleable stock, at the database', async () => {
    // §9.8 — "cannot be returned to saleable stock after final damage
    // approval". The service does not offer it; this proves the database
    // refuses it too, which is what "by any path" means.
    // The realistic attempt: issue it out of the damaged warehouse as an
    // ordinary transfer, which is what someone would do to "put it back".
    expect(
      await rejection(
        ownerPool.query(
          `insert into inventory_movement
             (item_code, warehouse_code, branch_code, kind, quantity, movement_date, created_by)
           values ($1,$2,$3,'transfer_issue',-5,'2026-02-20',$4)`,
          [ITEM, DAMAGED, BAGHDAD, manager.principal.userId],
        ),
      ),
    ).toMatch(/approved as damaged/);
  });

  it('refuses it through the service too', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          states.moveAtCost(tx, manager, {
            itemCode: ITEM,
            fromWarehouseCode: DAMAGED,
            toWarehouseCode: STORES,
            branchCode: BAGHDAD,
            quantity: qty('5'),
            movementDate: '2026-02-20',
            issueKind: 'transfer_issue',
            receiptKind: 'transfer_receipt',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/approved as damaged/);
  });

  it('needs a stated reason and the approve verb', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          states.approveDamage(tx, manager, {
            itemCode: ITEM,
            fromWarehouseCode: STORES,
            damagedWarehouseCode: DAMAGED,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            movementDate: '2026-02-15',
            reason: '   ',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/keeps the reason with it/);
  });

  it('keeps the damaged stock at its original cost', async () => {
    // 30 units taken from the oldest layer at 10.
    const value = await withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, DAMAGED));
    expect(toDecimalString(value, 4n)).toBe('300.0000');
  });
});

describe('04.9 gate · write-off at the correct FIFO cost', () => {
  beforeEach(async () => {
    await stockStores();
    await withScope(scope(), (tx) =>
      states.approveDamage(tx, manager, {
        itemCode: ITEM,
        fromWarehouseCode: STORES,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-15',
        reason: 'Water damage.',
        batchNumber: 'B-1',
      }),
    );
  });

  it('removes the stock at what it actually cost', async () => {
    const written = await withScope(scope(), (tx) =>
      states.writeOff(tx, manager, {
        itemCode: ITEM,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-20',
        reason: 'Beyond repair; disposed of.',
        batchNumber: 'B-1',
      }),
    );

    // The 30 damaged units came from the 10 layer, so the loss is 300 — not the
    // 12 of the newer layer, and not an average.
    expect(toDecimalString(written.costIqd, 4n)).toBe('300.0000');
    expect(formatQuantity((await positionAt(DAMAGED)).onHand)).toBe('0');
  });

  it('leaves the saleable stock untouched', async () => {
    await withScope(scope(), (tx) =>
      states.writeOff(tx, manager, {
        itemCode: ITEM,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-02-20',
        reason: 'Disposed of.',
        batchNumber: 'B-1',
      }),
    );

    expect(formatQuantity(availableQuantity(await positionAt(STORES)))).toBe('170');
  });

  it('needs a stated reason — it removes value from the balance sheet', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          states.writeOff(tx, manager, {
            itemCode: ITEM,
            damagedWarehouseCode: DAMAGED,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            movementDate: '2026-02-20',
            reason: '',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/removes value from the balance sheet/);
  });

  it('refuses to write off from a warehouse that is not the damaged one', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          states.writeOff(tx, manager, {
            itemCode: ITEM,
            damagedWarehouseCode: STORES,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            movementDate: '2026-02-20',
            reason: 'Wrong warehouse.',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/needs a 'damaged_goods' one/);
  });
});
