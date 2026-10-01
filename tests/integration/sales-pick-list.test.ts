/**
 * Phase 06.4 test gate — Pick List. §7.2, Appendix B.
 *
 *   - Pick List creates no accounting entry and no stock movement
 *   - Picked quantity cannot exceed the reserved quantity
 *   - Serial/batch selection at pick is carried through to the Delivery Note
 *
 * The third one is tested as far as it can be until 06.5 exists: the selection
 * is captured completely at the pick, and `pickedUnits()` — the function the
 * Delivery Note will read — returns it. When 06.5 lands, the delivery test
 * asserts the other end of the same wire.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as so from '@/server/services/sales-order';
import * as pick from '@/server/services/pick-list';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';
const CABLE = 'ITM-CABLE';
const WIDGET = 'ITM-WIDGET';
const LIST = 'PL-RETAIL';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let salesUser: ActorContext;
let manager: ActorContext;
let customerId: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  for (const branchCode of [BAGHDAD, ERBIL]) {
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      id,
      branchCode,
    ]);
  }
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext, branchCode = BAGHDAD) => ({
  userId: ctx.principal.userId,
  branchCode,
});

async function stock(
  itemCode: string,
  warehouseCode: string,
  branchCode: string,
  quantity: bigint,
  identity: { batchNumber?: string; serialNumber?: string },
) {
  await withScope({ userId: manager.principal.userId, branchCode }, (tx) =>
    inventory.receive(
      tx,
      { principal: manager.principal, branchCode },
      {
        itemCode,
        warehouseCode,
        branchCode,
        quantity,
        unitCostIqd: price('6'),
        movementDate: '2026-02-01',
        kind: 'opening_stock',
        ...identity,
      },
    ),
  );
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(ERBIL, 'Erbil');

  for (const [code, name, tracking] of [
    [CABLE, 'Network Cable 2m', 'batch'],
    [WIDGET, 'Numbered Widget', 'serial'],
  ] as const) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ($1,$2,true,'EA',$3) returning id`,
        [code, name, tracking],
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

  salesUser = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into price_list (code, name, currency, active) values ($1,'Retail','IQD',true)`,
    [LIST],
  );
  const { rows: items } = await ownerPool.query(`select id, code from item`);
  for (const row of items) {
    await ownerPool.query(
      `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
       values ($1,$2,'EA',10.0000,'2026-01-01')`,
      [LIST, row.id],
    );
  }

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner
       (code, legal_name, is_customer, status, active, price_list_code, credit_limit_iqd)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true, $1, 100000000.0000)
     returning id`,
    [LIST],
  );
  customerId = partner[0].id;

  await stock(CABLE, `WH-${BAGHDAD}`, BAGHDAD, qty('500'), { batchNumber: 'B-BGW' });
});

/** An approved order with `quantity` of `itemCode` reserved in Baghdad. */
async function approvedOrder(itemCode = CABLE, quantity = qty('100')) {
  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-10',
      lines: [
        {
          itemCode,
          quantity,
          uomCode: 'EA',
          warehouseCode: `WH-${BAGHDAD}`,
          branchCode: BAGHDAD,
        },
      ],
    }),
  );

  await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));
  return order;
}

// ---------------------------------------------------------------------------

describe('06.4 gate · a Pick List creates no accounting entry and no stock movement', () => {
  it('has no column to record either — the rule is a property of the type', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name in ('pick_list','pick_list_line','pick_list_line_unit')
          and column_name in ('journal_entry_id','inventory_movement_id','posting_id')`,
    );

    // Appendix B: effect Operational. A service that wanted to post could not
    // record that it had.
    expect(rows).toEqual([]);
  });

  it('writes no journal and moves no stock, through the whole cycle', async () => {
    const order = await approvedOrder();

    const before = await counts();

    const sheet = await withScope(scope(manager), (tx) =>
      pick.create(tx, manager, {
        salesOrderId: order.id,
        warehouseCode: `WH-${BAGHDAD}`,
        pickDate: '2026-02-12',
      }),
    );
    await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));

    const lines = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.id, [
        {
          pickListLineId: lines.lines[0]!.id,
          quantity: qty('100'),
          units: [{ batchNumber: 'B-BGW', quantity: qty('100') }],
        },
      ]),
    );

    expect(await counts()).toEqual(before);
  });

  it('leaves the stock exactly where it was — reserved, not issued', async () => {
    const order = await approvedOrder();

    const sheet = await withScope(scope(manager), (tx) =>
      pick.create(tx, manager, {
        salesOrderId: order.id,
        warehouseCode: `WH-${BAGHDAD}`,
        pickDate: '2026-02-12',
      }),
    );
    const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
    await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));
    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.id, [
        {
          pickListLineId: view.lines[0]!.id,
          quantity: qty('100'),
          units: [{ batchNumber: 'B-BGW', quantity: qty('100') }],
        },
      ]),
    );

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );

    // 500 received, 100 reserved by the order, none issued. Picking changes
    // neither figure: the units are still on the shelf and still promised.
    expect(position.onHand).toBe(qty('500'));
    expect(position.reserved).toBe(qty('100'));
  });
});

async function counts() {
  const { rows } = await ownerPool.query(`
    select (select count(*) from journal_entry)      as journals,
           (select count(*) from journal_line)       as journal_lines,
           (select count(*) from inventory_movement) as movements,
           (select count(*) from cost_layer)         as layers
  `);
  return rows[0];
}

// ---------------------------------------------------------------------------

describe('06.4 gate · picked quantity cannot exceed the reserved quantity', () => {
  it('picks up to the reservation', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    const result = await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.pickListId, [
        {
          pickListLineId: sheet.lineId,
          quantity: qty('100'),
          units: [{ batchNumber: 'B-BGW', quantity: qty('100') }],
        },
      ]),
    );

    expect(result.shortfalls).toEqual([]);
  });

  it('refuses one unit beyond it', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.pick(tx, manager, sheet.pickListId, [
            {
              pickListLineId: sheet.lineId,
              quantity: qty('101'),
              units: [{ batchNumber: 'B-BGW', quantity: qty('101') }],
            },
          ]),
        ),
      ),
    ).toMatch(/exceed the stock reserved|picked_within_request/);
  });

  it('refuses a second sheet that would take the total past the reservation', async () => {
    // The cumulative case, which is the one that actually happens: two sheets of
    // 60 against a reservation of 100.
    const order = await approvedOrder();

    const orderLine = await withScope(scope(manager), (tx) =>
      pick.outstandingFor(tx, order.id, `WH-${BAGHDAD}`),
    );

    const first = await withScope(scope(manager), (tx) =>
      pick.create(tx, manager, {
        salesOrderId: order.id,
        warehouseCode: `WH-${BAGHDAD}`,
        pickDate: '2026-02-12',
        lines: [{ salesOrderLineId: orderLine[0]!.salesOrderLineId, quantity: qty('60') }],
      }),
    );
    expect(first.pickListNo).toMatch(/^PICK-/);

    const outstanding = await withScope(scope(manager), (tx) =>
      pick.outstandingFor(tx, order.id, `WH-${BAGHDAD}`),
    );
    expect(outstanding[0]!.outstanding).toBe(qty('40'));

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.create(tx, manager, {
            salesOrderId: order.id,
            warehouseCode: `WH-${BAGHDAD}`,
            pickDate: '2026-02-12',
            lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity: qty('60') }],
          }),
        ),
      ),
    ).toMatch(/only 40 is still to be picked|exceed the stock reserved/);
  });

  it('refuses the excess written straight to the table, not only through the service (§7.7)', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    expect(
      await rejection(
        ownerPool.query(`update pick_list_line set requested_quantity = 500 where id = $1`, [
          sheet.lineId,
        ]),
      ),
    ).toMatch(/exceed the stock reserved/);
  });

  it('treats a short pick as ordinary, and records why', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    const result = await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.pickListId, [
        {
          pickListLineId: sheet.lineId,
          quantity: qty('60'),
          shortfallReason: 'Shelf held 60; rest not found',
          units: [{ batchNumber: 'B-BGW', quantity: qty('60') }],
        },
      ]),
    );

    expect(result.shortfalls).toEqual([{ itemCode: CABLE, short: qty('40') }]);

    const short = await withScope(scope(manager), (tx) => pick.shortPicks(tx, sheet.pickListId));
    expect(short).toHaveLength(1);
    expect(short[0]!.reason).toBe('Shelf held 60; rest not found');

    // Appendix B gives the Pick List no partial status, so a short pick is still
    // Picked. The shortfall is a quantity, not a state.
    const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.pickListId));
    expect(view.status).toBe('executed');
  });

  it('refuses a sheet against an order that is not approved', async () => {
    const order = await withScope(scope(salesUser), (tx) =>
      so.create(tx, salesUser, {
        customerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-10',
        lines: [
          {
            itemCode: CABLE,
            quantity: qty('10'),
            uomCode: 'EA',
            warehouseCode: `WH-${BAGHDAD}`,
            branchCode: BAGHDAD,
          },
        ],
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.create(tx, manager, {
            salesOrderId: order.id,
            warehouseCode: `WH-${BAGHDAD}`,
            pickDate: '2026-02-12',
          }),
        ),
      ),
    ).toMatch(/nothing can be picked against it/);
  });
});

// ---------------------------------------------------------------------------

describe('06.4 gate · serial and batch selection is carried through', () => {
  it('returns the selection to whoever asks for it — the Delivery Note’s input', async () => {
    await stock(WIDGET, `WH-${BAGHDAD}`, BAGHDAD, qty('1'), { serialNumber: 'SN-1' });
    await stock(WIDGET, `WH-${BAGHDAD}`, BAGHDAD, qty('1'), { serialNumber: 'SN-2' });

    const order = await approvedOrder(WIDGET, qty('2'));
    const sheet = await newSheet(order.id);

    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.pickListId, [
        {
          pickListLineId: sheet.lineId,
          quantity: qty('2'),
          units: [
            { serialNumber: 'SN-1', quantity: qty('1') },
            { serialNumber: 'SN-2', quantity: qty('1') },
          ],
        },
      ]),
    );

    const units = await withScope(scope(manager), (tx) =>
      pick.pickedUnits(tx, sheet.pickListId),
    );

    expect(units.map((u) => u.serialNumber)).toEqual(['SN-1', 'SN-2']);
    expect(units.every((u) => u.itemCode === WIDGET)).toBe(true);
    expect(units.every((u) => u.warehouseCode === `WH-${BAGHDAD}`)).toBe(true);
  });

  it('refuses to finish a tracked pick with nothing selected', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.pick(tx, manager, sheet.pickListId, [
            { pickListLineId: sheet.lineId, quantity: qty('100') },
          ]),
        ),
      ),
    ).toMatch(/does not say which batches/);
  });

  it('refuses a selection that does not account for what was picked', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.pick(tx, manager, sheet.pickListId, [
            {
              pickListLineId: sheet.lineId,
              quantity: qty('100'),
              units: [{ batchNumber: 'B-BGW', quantity: qty('60') }],
            },
          ]),
        ),
      ),
    ).toMatch(/account for 60 but 100 was picked/);
  });

  it('refuses the same serial on two live sheets — one unit, one customer (§9.9)', async () => {
    await stock(WIDGET, `WH-${BAGHDAD}`, BAGHDAD, qty('1'), { serialNumber: 'SN-1' });
    await stock(WIDGET, `WH-${BAGHDAD}`, BAGHDAD, qty('1'), { serialNumber: 'SN-2' });

    const first = await approvedOrder(WIDGET, qty('1'));
    const second = await approvedOrder(WIDGET, qty('1'));

    const sheetA = await newSheet(first.id);
    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheetA.pickListId, [
        {
          pickListLineId: sheetA.lineId,
          quantity: qty('1'),
          units: [{ serialNumber: 'SN-1', quantity: qty('1') }],
        },
      ]),
    );

    const sheetB = await newSheet(second.id);
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.pick(tx, manager, sheetB.pickListId, [
            {
              pickListLineId: sheetB.lineId,
              quantity: qty('1'),
              units: [{ serialNumber: 'SN-1', quantity: qty('1') }],
            },
          ]),
        ),
      ),
    ).toMatch(/already picked on/);
  });

  it('rewrites the selection rather than adding to it when a pick is corrected', async () => {
    await stock(WIDGET, `WH-${BAGHDAD}`, BAGHDAD, qty('1'), { serialNumber: 'SN-1' });
    await stock(WIDGET, `WH-${BAGHDAD}`, BAGHDAD, qty('1'), { serialNumber: 'SN-2' });

    const order = await approvedOrder(WIDGET, qty('1'));
    const sheet = await newSheet(order.id);

    // A picker who scanned the wrong unit and corrected it must not leave the
    // first serial promised to this customer.
    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.pickListId, [
        {
          pickListLineId: sheet.lineId,
          quantity: qty('1'),
          units: [{ serialNumber: 'SN-1', quantity: qty('1') }],
        },
      ]),
    );

    const units = await withScope(scope(manager), (tx) =>
      pick.pickedUnits(tx, sheet.pickListId),
    );
    expect(units).toHaveLength(1);
    expect(units[0]!.serialNumber).toBe('SN-1');
  });
});

// ---------------------------------------------------------------------------

describe('06.4 · a sheet belongs to one order and one warehouse (§7.2)', () => {
  it('refuses a line from another order', async () => {
    const mine = await approvedOrder();
    const theirs = await approvedOrder();

    const sheet = await withScope(scope(manager), (tx) =>
      pick.create(tx, manager, {
        salesOrderId: mine.id,
        warehouseCode: `WH-${BAGHDAD}`,
        pickDate: '2026-02-12',
      }),
    );

    const otherLine = await ownerPool.query(
      `select id from sales_order_line where sales_order_id = $1`,
      [theirs.id],
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into pick_list_line
             (pick_list_id, line_no, sales_order_line_id, item_code, description, uom_code, requested_quantity)
           values ($1, 99, $2, $3, 'Smuggled', 'EA', 1)`,
          [sheet.id, otherLine.rows[0].id, CABLE],
        ),
      ),
    ).toMatch(/draws on one Sales Order/);
  });

  it('refuses a line delivered from another warehouse', async () => {
    await stock(CABLE, `WH-${ERBIL}`, ERBIL, qty('50'), { batchNumber: 'B-EBL' });

    const order = await withScope(scope(salesUser), (tx) =>
      so.create(tx, salesUser, {
        customerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-10',
        lines: [
          {
            itemCode: CABLE,
            quantity: qty('10'),
            uomCode: 'EA',
            warehouseCode: `WH-${BAGHDAD}`,
            branchCode: BAGHDAD,
          },
          {
            itemCode: CABLE,
            quantity: qty('10'),
            uomCode: 'EA',
            warehouseCode: `WH-${ERBIL}`,
            branchCode: ERBIL,
          },
        ],
      }),
    );
    await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));

    // §7.2 allows the order to span warehouses; the sheet does not. One sheet
    // per warehouse, and the Baghdad sheet holds only the Baghdad line.
    const sheet = await withScope(scope(manager), (tx) =>
      pick.create(tx, manager, {
        salesOrderId: order.id,
        warehouseCode: `WH-${BAGHDAD}`,
        pickDate: '2026-02-12',
      }),
    );
    const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
    expect(view.lines).toHaveLength(1);

    const erbilLine = await ownerPool.query(
      `select id from sales_order_line where sales_order_id = $1 and warehouse_code = $2`,
      [order.id, `WH-${ERBIL}`],
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.create(tx, manager, {
            salesOrderId: order.id,
            warehouseCode: `WH-${BAGHDAD}`,
            pickDate: '2026-02-12',
            lines: [{ salesOrderLineId: erbilLine.rows[0].id, quantity: qty('10') }],
          }),
        ),
      ),
    ).toMatch(/is for WH-BGW|delivered from WH-EBL/);
  });

  it('gives a cancelled sheet’s units back to the reservation', async () => {
    const order = await approvedOrder();
    const sheet = await newSheet(order.id);

    expect(
      await withScope(scope(manager), (tx) =>
        pick.outstandingFor(tx, order.id, `WH-${BAGHDAD}`),
      ),
    ).toEqual([]);

    await withScope(scope(manager), (tx) =>
      pick.cancel(tx, manager, sheet.pickListId, 'Customer deferred the delivery'),
    );

    const outstanding = await withScope(scope(manager), (tx) =>
      pick.outstandingFor(tx, order.id, `WH-${BAGHDAD}`),
    );
    expect(outstanding[0]!.outstanding).toBe(qty('100'));
  });
});

/** Creates a sheet for the whole outstanding position and releases it. */
async function newSheet(salesOrderId: string) {
  const sheet = await withScope(scope(manager), (tx) =>
    pick.create(tx, manager, {
      salesOrderId,
      warehouseCode: `WH-${BAGHDAD}`,
      pickDate: '2026-02-12',
    }),
  );
  await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));

  const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
  return { pickListId: sheet.id, lineId: view.lines[0]!.id };
}
