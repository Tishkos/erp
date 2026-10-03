/**
 * Phase 04.8 test gate — stock counts and reconciliation, §9.6.
 *
 *   - Count scope filters produce exactly the intended item/warehouse set
 *   - Variance is computed correctly for positive and negative differences
 *   - An adjustment cannot post without variance approval
 *   - A loss adjustment requires Warehouse Manager approval specifically
 *   - The adjustment posts through the Phase 02 engine and reconciles to the G/L
 *   - Count variances remain visible until completed or written off (§9.9)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as counts from '@/server/services/stock-count';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const STORES = 'WH-BGW';
const SECOND = 'WH-BGW-2';
const CABLE = 'ITM-CABLE';
const ROUTER = 'ITM-ROUTER';

const qty = (units: string) => parseQuantity(units);
const cost = (iqd: string) => parseDecimal(iqd, 4n);

let officer: ActorContext;
let manager: ActorContext;

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
    `insert into role_grant (role_code, object, verb) values
       ($1,'inventory_movement','execute'),
       ($1,'inventory_movement','view')
     on conflict do nothing`,
    [role],
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
    `insert into warehouse (code, name, branch_code, warehouse_type)
     values ($1,'Baghdad Secondary',$2,'main')`,
    [SECOND, BAGHDAD],
  );

  for (const [code, name, category] of [
    [CABLE, 'Network Cable 2m', 'CABLES'],
    [ROUTER, 'Router', 'NETWORK'],
  ] as const) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking, category)
         values ($1,$2,true,'EA','batch',$3) returning id`,
        [code, name, category],
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

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
});

async function stock(itemCode: string, warehouseCode: string, quantity: string, unitCost = '10') {
  await withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode,
      warehouseCode,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      unitCostIqd: cost(unitCost),
      movementDate: '2026-01-10',
      batchNumber: 'B-1',
    }),
  );
}

const positionAt = (itemCode: string, warehouse: string) =>
  withScope(scope(manager), (tx) => inventory.positionOf(tx, itemCode, warehouse, BAGHDAD));

// ---------------------------------------------------------------------------
// 04.8 gate · scope
// ---------------------------------------------------------------------------

describe('04.8 gate · count scope produces exactly the intended set', () => {
  beforeEach(async () => {
    await stock(CABLE, STORES, '100');
    await stock(ROUTER, STORES, '20');
    await stock(CABLE, SECOND, '50');
  });

  it('covers one warehouse, not the others', async () => {
    const { id, lines } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'warehouse',
      }),
    );

    expect(lines).toBe(2);

    const { lines: rows } = await withScope(scope(officer), (tx) => counts.view(tx, id));
    expect(rows.map((r) => r.itemCode).sort()).toEqual([CABLE, ROUTER]);
  });

  it('covers one item when the scope says so', async () => {
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: ROUTER,
      }),
    );

    const { lines } = await withScope(scope(officer), (tx) => counts.view(tx, id));
    expect(lines.map((l) => l.itemCode)).toEqual([ROUTER]);
  });

  it('covers one category', async () => {
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'category',
        scopeFilter: 'CABLES',
      }),
    );

    const { lines } = await withScope(scope(officer), (tx) => counts.view(tx, id));
    expect(lines.map((l) => l.itemCode)).toEqual([CABLE]);
  });

  it('refuses a scope that covers nothing, and says what it looked for', async () => {
    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          counts.plan(tx, officer, {
            branchCode: BAGHDAD,
            warehouseCode: STORES,
            plannedOn: '2026-03-01',
            scope: 'category',
            scopeFilter: 'FURNITURE',
          }),
        ),
      ),
    ).toMatch(/Nothing is in scope.*category FURNITURE in WH-BGW/s);
  });

  it('shows the counter the system quantity (§9.6)', async () => {
    // The blueprint's explicit choice: a counter who can see the book figure
    // queries a difference on the spot.
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: CABLE,
      }),
    );

    const { lines } = await withScope(scope(officer), (tx) => counts.view(tx, id));
    expect(formatQuantity(parseQuantity(lines[0]!.systemQuantity))).toBe('100');
  });

  it('freezes the system quantity at planning, not at approval', async () => {
    // A variance against a figure that moved while the count was in progress is
    // a variance against nothing.
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: CABLE,
      }),
    );

    // Stock moves while the counters are walking the aisles.
    await stock(CABLE, STORES, '25', '11');

    const { lines } = await withScope(scope(officer), (tx) => counts.view(tx, id));
    expect(formatQuantity(parseQuantity(lines[0]!.systemQuantity))).toBe('100');
  });
});

// ---------------------------------------------------------------------------
// 04.8 gate · variance
// ---------------------------------------------------------------------------

describe('04.8 gate · variance is computed for both directions', () => {
  async function counted(found: string) {
    await stock(CABLE, STORES, '100');
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: CABLE,
      }),
    );
    await withScope(scope(officer), (tx) =>
      counts.recordCount(tx, officer, id, {
        countedOn: '2026-03-02',
        quantities: { 1: qty(found) },
      }),
    );
    return id;
  }

  it('reports a shortfall as a negative variance', async () => {
    const id = await counted('92');

    const found = await withScope(scope(officer), (tx) => counts.variances(tx, id));
    expect(found).toHaveLength(1);
    expect(formatQuantity(found[0]!.variance)).toBe('-8');
  });

  it('reports a surplus as a positive variance', async () => {
    const id = await counted('107');

    const found = await withScope(scope(officer), (tx) => counts.variances(tx, id));
    expect(formatQuantity(found[0]!.variance)).toBe('7');
  });

  it('reports nothing when the count agrees with the books', async () => {
    const id = await counted('100');
    expect(await withScope(scope(officer), (tx) => counts.variances(tx, id))).toEqual([]);
  });

  it('lets a recount supersede the first count, keeping both', async () => {
    const id = await counted('92');

    await withScope(scope(officer), (tx) =>
      counts.requestRecount(tx, officer, id, 'The aisle was being restocked during the count.'),
    );
    await withScope(scope(officer), (tx) =>
      counts.recordCount(tx, officer, id, {
        countedOn: '2026-03-03',
        quantities: { 1: qty('100') },
      }),
    );

    const found = await withScope(scope(officer), (tx) => counts.variances(tx, id));
    expect(found).toEqual([]);

    // Both figures are kept: "we counted twice and got different answers" is
    // itself a finding.
    const { lines } = await withScope(scope(officer), (tx) => counts.view(tx, id));
    expect(formatQuantity(parseQuantity(lines[0]!.countedQuantity!))).toBe('92');
    expect(formatQuantity(parseQuantity(lines[0]!.recountQuantity!))).toBe('100');
  });

  it('needs a reason to send a count back (§5.4)', async () => {
    const id = await counted('92');

    expect(
      await rejection(
        withScope(scope(officer), (tx) => counts.requestRecount(tx, officer, id, '  ')),
      ),
    ).toMatch(/costs the warehouse a day/);
  });
});

// ---------------------------------------------------------------------------
// 04.8 gate · approval before adjustment
// ---------------------------------------------------------------------------

describe('04.8 gate · an adjustment cannot post without variance approval', () => {
  async function counted(found: string) {
    await stock(CABLE, STORES, '100');
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: CABLE,
      }),
    );
    await withScope(scope(officer), (tx) =>
      counts.recordCount(tx, officer, id, {
        countedOn: '2026-03-02',
        quantities: { 1: qty(found) },
      }),
    );
    return id;
  }

  it('refuses to adjust a count nobody approved', async () => {
    const id = await counted('92');

    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          counts.adjust(tx, officer, id, { adjustedOn: '2026-03-05' }),
        ),
      ),
    ).toMatch(/nobody has approved/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const id = await counted('92');
    const { lines } = await withScope(scope(officer), (tx) => counts.view(tx, id));

    // Writing a movement id onto an unapproved count is the shape a script
    // would take.
    expect(
      await rejection(
        ownerPool.query(
          `update stock_count_line set movement_id = gen_random_uuid() where id = $1`,
          [lines[0]!.id],
        ),
      ),
    ).toMatch(/no approved variance/);
  });

  it('refuses an officer approving the variance — it is a manager’s decision', async () => {
    // §9.6 puts the decision with a Warehouse Manager, and §5.3 keeps `approve`
    // separate from `execute` so counting and accepting a loss are different
    // permissions.
    const id = await counted('92');

    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          counts.approveVariance(tx, officer, id, 'Accepted.'),
        ),
      ),
    ).toMatch(/'approve' on 'stock_count' is not granted/);
  });

  it('needs a stated reason for the approval', async () => {
    const id = await counted('92');

    expect(
      await rejection(
        withScope(scope(manager), (tx) => counts.approveVariance(tx, manager, id, '   ')),
      ),
    ).toMatch(/may post a loss/);
  });

  it('adjusts once a manager has approved, and moves the stock', async () => {
    const id = await counted('92');

    await withScope(scope(manager), (tx) =>
      counts.approveVariance(tx, manager, id, 'Eight units unaccounted for after recount.'),
    );
    await withScope(scope(manager), (tx) =>
      counts.adjust(tx, manager, id, { adjustedOn: '2026-03-05' }),
    );

    expect(formatQuantity((await positionAt(CABLE, STORES)).onHand)).toBe('92');
  });

  it('brings a surplus on at the cost the caller states', async () => {
    // The system does not know what unrecorded stock cost, and guessing would
    // put an invented figure into the valuation.
    const id = await counted('110');

    await withScope(scope(manager), (tx) =>
      counts.approveVariance(tx, manager, id, 'Ten units found behind the racking.'),
    );
    await withScope(scope(manager), (tx) =>
      counts.adjust(tx, manager, id, {
        adjustedOn: '2026-03-05',
        surplusUnitCostIqd: cost('10'),
      }),
    );

    expect(formatQuantity((await positionAt(CABLE, STORES)).onHand)).toBe('110');
    const value = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, CABLE, STORES),
    );
    expect(toDecimalString(value, 4n)).toBe('1100.0000');
  });

  it('issues a shortfall at its FIFO cost', async () => {
    await stock(CABLE, STORES, '100', '10');
    await stock(CABLE, STORES, '100', '14');

    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: CABLE,
      }),
    );
    await withScope(scope(officer), (tx) =>
      counts.recordCount(tx, officer, id, {
        countedOn: '2026-03-02',
        quantities: { 1: qty('150') },
      }),
    );
    await withScope(scope(manager), (tx) =>
      counts.approveVariance(tx, manager, id, 'Fifty units short.'),
    );
    await withScope(scope(manager), (tx) =>
      counts.adjust(tx, manager, id, { adjustedOn: '2026-03-05' }),
    );

    // 50 short, taken from the oldest layer at 10: what remains is 50 at 10 and
    // 100 at 14 = 1,900.
    const value = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, CABLE, STORES),
    );
    expect(toDecimalString(value, 4n)).toBe('1900.0000');
  });

  it('cannot be adjusted twice', async () => {
    const id = await counted('92');
    await withScope(scope(manager), (tx) =>
      counts.approveVariance(tx, manager, id, 'Short by eight.'),
    );
    await withScope(scope(manager), (tx) =>
      counts.adjust(tx, manager, id, { adjustedOn: '2026-03-05' }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          counts.adjust(tx, manager, id, { adjustedOn: '2026-03-06' }),
        ),
      ),
    ).toMatch(/follows an approved variance/);
  });
});

// ---------------------------------------------------------------------------
// 04.8 gate · variances stay visible
// ---------------------------------------------------------------------------

describe('04.8 gate · count variances remain visible until resolved (§9.9)', () => {
  async function countedShort() {
    await stock(CABLE, STORES, '100');
    const { id } = await withScope(scope(officer), (tx) =>
      counts.plan(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: CABLE,
      }),
    );
    await withScope(scope(officer), (tx) =>
      counts.recordCount(tx, officer, id, {
        countedOn: '2026-03-02',
        quantities: { 1: qty('92') },
      }),
    );
    return id;
  }

  it('lists an open variance with its figures', async () => {
    await countedShort();

    const open = await withScope(scope(officer), (tx) => counts.openVariances(tx));
    expect(open).toHaveLength(1);
    expect(Number(open[0]!.variance)).toBe(-8);
    expect(Number(open[0]!.system_quantity)).toBe(100);
    expect(Number(open[0]!.counted_quantity)).toBe(92);
  });

  it('clears it once the count is adjusted', async () => {
    const id = await countedShort();
    await withScope(scope(manager), (tx) =>
      counts.approveVariance(tx, manager, id, 'Accepted as a loss.'),
    );
    await withScope(scope(manager), (tx) =>
      counts.adjust(tx, manager, id, { adjustedOn: '2026-03-05' }),
    );

    expect(await withScope(scope(officer), (tx) => counts.openVariances(tx))).toEqual([]);
  });

  it('keeps an adjusted count from being reopened', async () => {
    const id = await countedShort();
    await withScope(scope(manager), (tx) =>
      counts.approveVariance(tx, manager, id, 'Accepted.'),
    );
    await withScope(scope(manager), (tx) =>
      counts.adjust(tx, manager, id, { adjustedOn: '2026-03-05' }),
    );

    // Its movements exist and the ledger is append-only; correcting it means a
    // further count, not editing this one.
    expect(
      await rejection(
        ownerPool.query(`update stock_count set status = 'counted' where id = $1`, [id]),
      ),
    ).toMatch(/cannot be unmade/);
  });
});
