/**
 * Phase 04 test gate — the inventory ledger against a real database.
 *
 * The pure arithmetic is covered in tests/unit/fifo.test.ts. What needs a
 * database is whether the ledger, the layers and the view agree once concurrency
 * and constraints are involved — which is where an inventory module actually
 * goes wrong.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
const WAREHOUSE = 'WH-BGW';
const ITEM = 'ITM-CABLE';
const TRACKED = 'ITM-SERIAL';

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

  // A batch-tracked item and a serial-tracked one (§9.3). The item and its base
  // unit are written together: the deferred check refuses an item whose base
  // unit is not among its units.
  for (const [code, name, tracking] of [
    [ITEM, 'Network Cable 2m', 'batch'],
    [TRACKED, 'Router', 'serial'],
  ] as const) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ($1, $2, true, 'EA', $3) returning id`,
        [code, name, tracking],
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
  }

  manager = await createManager();
});

/** Receives stock, returning the movement. */
function receive(quantity: string, unitCost: string, options: Record<string, unknown> = {}) {
  return withScope(scope(), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: ITEM,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      unitCostIqd: cost(unitCost),
      movementDate: '2026-01-10',
      batchNumber: 'B-1',
      ...options,
    }),
  );
}

function issue(quantity: string, options: Record<string, unknown> = {}) {
  return withScope(scope(), (tx) =>
    inventory.issue(tx, manager, {
      itemCode: ITEM,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      movementDate: '2026-02-01',
      batchNumber: 'B-1',
      ...options,
    }),
  );
}

// ---------------------------------------------------------------------------
// 04.1 — the position is derived from the movements
// ---------------------------------------------------------------------------

describe('04.1 gate · availability is derived, never stored', () => {
  it('reports a position of zero for an item that has never moved', async () => {
    // Not null, not missing — "how much do we have?" always has an answer.
    const position = await withScope(scope(), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    );

    expect(position.onHand).toBe(0n);
    expect(availableQuantity(position)).toBe(0n);
  });

  it('sums the movements into On Hand', async () => {
    await receive('100', '10');
    await receive('50', '12', { movementDate: '2026-01-20' });

    const position = await withScope(scope(), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    );

    expect(formatQuantity(position.onHand)).toBe('150');
  });

  it('takes an issue back out again', async () => {
    await receive('100', '10');
    await issue('30');

    const position = await withScope(scope(), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    );

    expect(formatQuantity(position.onHand)).toBe('70');
  });

  it('subtracts a live reservation from Available but not from On Hand', async () => {
    await receive('100', '10');
    await withScope(scope(), (tx) =>
      inventory.reserve(tx, manager, {
        itemCode: ITEM,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('40'),
        documentType: 'sales_order',
        documentId: 'SO-1',
      }),
    );

    const position = await withScope(scope(), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    );

    expect(formatQuantity(position.onHand)).toBe('100');
    expect(formatQuantity(position.reserved)).toBe('40');
    expect(formatQuantity(availableQuantity(position))).toBe('60');
  });

  it('returns the stock to Available when the reservation is released', async () => {
    await receive('100', '10');
    const { reservationId } = await withScope(scope(), (tx) =>
      inventory.reserve(tx, manager, {
        itemCode: ITEM,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('40'),
        documentType: 'sales_order',
        documentId: 'SO-1',
      }),
    );

    await withScope(scope(), (tx) =>
      inventory.releaseReservation(tx, manager, reservationId, 'Order cancelled.'),
    );

    const position = await withScope(scope(), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    );
    expect(formatQuantity(availableQuantity(position))).toBe('100');
  });

  it('keeps the released reservation as a record rather than deleting it', async () => {
    // §5.4 — who promised this stock, and when it was let go.
    await receive('100', '10');
    const { reservationId } = await withScope(scope(), (tx) =>
      inventory.reserve(tx, manager, {
        itemCode: ITEM,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('10'),
        documentType: 'sales_order',
        documentId: 'SO-2',
      }),
    );
    await withScope(scope(), (tx) =>
      inventory.releaseReservation(tx, manager, reservationId, 'Superseded.'),
    );

    const { rows } = await ownerPool.query(
      `select released_at, release_reason from stock_reservation where id = $1`,
      [reservationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].released_at).not.toBeNull();
    expect(rows[0].release_reason).toBe('Superseded.');
  });
});

// ---------------------------------------------------------------------------
// 04.2 — FIFO, through the database
// ---------------------------------------------------------------------------

describe('04.2 gate · the worked example, end to end', () => {
  beforeEach(async () => {
    await receive('100', '10', { movementDate: '2026-01-10' });
    await receive('100', '12', { movementDate: '2026-01-20' });
  });

  it('costs an issue of 150 at 1,600', async () => {
    const result = await issue('150');
    expect(toDecimalString(result.costIqd!, 4n)).toBe('1600.0000');
  });

  it('names the layers it consumed, and how much from each', async () => {
    const result = await issue('150');

    const consumptions = await withScope(scope(), (tx) =>
      inventory.consumptionsOf(tx, result.movementId),
    );

    expect(consumptions).toHaveLength(2);
    expect(formatQuantity(parseQuantity(consumptions[0]!.quantity))).toBe('100');
    expect(formatQuantity(parseQuantity(consumptions[1]!.quantity))).toBe('50');
    expect(consumptions[0]!.layerDate).toBe('2026-01-10');
    expect(consumptions[1]!.layerDate).toBe('2026-01-20');
  });

  it('leads from a consumed layer back to the receipt that created it', async () => {
    // 04.2 gate: "Layer-level traceability from any issue back to the receipt
    // that created the layer."
    const first = await receive('10', '9', { movementDate: '2026-01-05' });
    const result = await issue('5');

    const consumptions = await withScope(scope(), (tx) =>
      inventory.consumptionsOf(tx, result.movementId),
    );

    expect(consumptions[0]!.createdByMovementId).toBe(first.movementId);
  });

  it('values what remains at 600, and the layers hold 50', async () => {
    await issue('150');

    const [value, remaining] = await withScope(scope(), async (tx) => [
      await inventory.valuationOf(tx, ITEM, WAREHOUSE),
      await inventory.layerQuantityOf(tx, ITEM, WAREHOUSE),
    ]);

    expect(toDecimalString(value, 4n)).toBe('600.0000');
    expect(formatQuantity(remaining)).toBe('50');
  });

  it('keeps the layer quantities equal to the ledger position', async () => {
    // The reconciliation §9.9 asks for, at its simplest: the layers and the
    // movements are two derivations of the same events and must agree.
    await issue('150');

    const [position, layerQuantity] = await withScope(scope(), async (tx) => [
      await inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
      await inventory.layerQuantityOf(tx, ITEM, WAREHOUSE),
    ]);

    expect(position.onHand).toBe(layerQuantity);
  });
});

describe('04.2 gate · a reversal restores the layers exactly', () => {
  it('puts both layers back and leaves the next issue costing the same', async () => {
    await receive('100', '10', { movementDate: '2026-01-10' });
    await receive('100', '12', { movementDate: '2026-01-20' });

    const issued = await issue('150');
    await withScope(scope(), (tx) =>
      inventory.reverseMovement(tx, manager, issued.movementId, 'Delivery was cancelled.'),
    );

    const [position, value] = await withScope(scope(), async (tx) => [
      await inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
      await inventory.valuationOf(tx, ITEM, WAREHOUSE),
    ]);

    expect(formatQuantity(position.onHand)).toBe('200');
    expect(toDecimalString(value, 4n)).toBe('2200.0000');

    // And the FIFO order is as if the issue never happened.
    const again = await issue('150');
    expect(toDecimalString(again.costIqd!, 4n)).toBe('1600.0000');
  });

  it('records the reversal as a movement pointing at the original', async () => {
    await receive('50', '8');
    const issued = await issue('20');
    const reversal = await withScope(scope(), (tx) =>
      inventory.reverseMovement(tx, manager, issued.movementId, 'Wrong warehouse.'),
    );

    const { rows } = await ownerPool.query(
      `select reverses_movement_id, kind from inventory_movement where id = $1`,
      [reversal.movementId],
    );
    expect(rows[0].reverses_movement_id).toBe(issued.movementId);
    expect(rows[0].kind).toBe('reversal');
  });

  it('refuses to reverse the same movement twice', async () => {
    // Reversing twice would restore the stock twice, and no report flags it.
    await receive('50', '8');
    const issued = await issue('20');
    await withScope(scope(), (tx) =>
      inventory.reverseMovement(tx, manager, issued.movementId, 'First.'),
    );

    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.reverseMovement(tx, manager, issued.movementId, 'Second.'),
        ),
      ),
    ).toMatch(/duplicate key|already/i);
  });

  it('records the restoration as a signed row, so the layer stays reconcilable', async () => {
    // The invariant: remaining = original − sum(consumption). A reversal that
    // adjusted the layer without recording why would break it, and the layer
    // would still have stock for a reason nobody could read.
    await receive('100', '10');
    const issued = await issue('100');
    const reversal = await withScope(scope(), (tx) =>
      inventory.reverseMovement(tx, manager, issued.movementId, 'Cancelled.'),
    );

    const { rows } = await ownerPool.query(
      `select c.quantity, c.movement_id,
              l.original_quantity, l.remaining_quantity
         from cost_layer_consumption c
         join cost_layer l on l.id = c.layer_id
        order by c.id`,
    );

    expect(rows).toHaveLength(2);
    expect(Number(rows[0].quantity)).toBe(100);
    expect(Number(rows[1].quantity)).toBe(-100);
    expect(rows[1].movement_id).toBe(reversal.movementId);

    const net = rows.reduce((sum, r) => sum + Number(r.quantity), 0);
    expect(Number(rows[0].remaining_quantity)).toBe(
      Number(rows[0].original_quantity) - net,
    );
  });

  it('refuses a reversal with no reason', async () => {
    await receive('50', '8');
    const issued = await issue('20');

    expect(
      await rejection(
        withScope(scope(), (tx) => inventory.reverseMovement(tx, manager, issued.movementId, '  ')),
      ),
    ).toMatch(/needs a reason/);
  });
});

// ---------------------------------------------------------------------------
// 04.2 — the layers and the General Ledger describe the same stock
// ---------------------------------------------------------------------------

describe('04.2 gate · inventory valuation equals the G/L control balance', () => {
  /**
   * Release 3's acceptance dependency is *"Inventory subledger and G/L
   * reconcile"*. It can, because both are derived from the same movements at
   * the same FIFO cost — and this proves it rather than assuming it.
   *
   * The accounts here are configured through Accounting Mapping, exactly as
   * §3.3 requires: the module names roles, never account numbers. Which real
   * accounts they map to is D7's, and is not needed to prove the mechanism.
   */
  let inventoryAccountId: string;

  beforeEach(async () => {
    await ownerPool.query(
      `insert into fiscal_year (code, name, starts_on, ends_on)
       values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31')
       on conflict do nothing`,
    );
    const { rows: years } = await ownerPool.query(
      `select id from fiscal_year where code = 'FY2026'`,
    );
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,1,'January 2026','2026-01-01','2026-01-31'),
              ($1,2,'February 2026','2026-02-01','2026-02-28')
       on conflict do nothing`,
      [years[0].id],
    );
    await ownerPool.query(
      `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
       values ('USD','accounting',1310.00000000,'2026-01-01',$1)
       on conflict do nothing`,
      [manager.principal.userId],
    );

    // Three accounts and three mappings: inventory, goods received not
    // invoiced, and cost of goods sold.
    const accounts: Record<string, string> = {};
    for (const [role, parent, name] of [
      ['inventory', 'A000001', 'Inventory'],
      ['grni', 'L000001', 'Goods Received Not Invoiced'],
      ['cogs', 'X000001', 'Cost of Goods Sold'],
    ] as const) {
      const { rows: parents } = await ownerPool.query(
        `select id from chart_of_account where code = $1`,
        [parent],
      );
      const { rows } = await ownerPool.query(
        `insert into chart_of_account
           (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
            currency_restriction)
         values ($1, $2,
                 (select account_type from chart_of_account where code = $3),
                 $4, false, true, 'approved', 1, 'IQD')
         returning id`,
        [`${parent.slice(0, 1)}90000${role.length}`, name, parent, parents[0].id],
      );
      accounts[role] = rows[0].id;

      for (const kind of ['goods_receipt', 'delivery'] as const) {
        await ownerPool.query(
          `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
           values ($1, $2, $3, true, $4)
           on conflict do nothing`,
          [`inventory.${kind}`, role, rows[0].id, manager.principal.userId],
        );
      }
    }
    inventoryAccountId = accounts.inventory!;

    await ownerPool.query(
      `insert into department (code, name, is_finance) values ('FIN','Finance',true)
       on conflict (code) do nothing`,
    );

  });

  /** The movement of the inventory control account, from posted journal lines. */
  async function inventoryGlBalance(): Promise<string> {
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [inventoryAccountId],
    );
    return rows[0].balance;
  }

  it('posts a receipt at its FIFO cost, and the layers agree with the ledger', async () => {
    await receive('100', '10', { post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });

    const [valuation, balance] = await Promise.all([
      withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, WAREHOUSE)),
      inventoryGlBalance(),
    ]);

    expect(toDecimalString(valuation, 4n)).toBe('1000.0000');
    expect(Number(balance)).toBe(1000);
  });

  it('keeps them equal after an issue at FIFO cost', async () => {
    await receive('100', '10', { movementDate: '2026-01-10', post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });
    await receive('100', '12', { movementDate: '2026-01-20', post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });
    await issue('150', { post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });

    const [valuation, balance] = await Promise.all([
      withScope(scope(), (tx) => inventory.valuationOf(tx, ITEM, WAREHOUSE)),
      inventoryGlBalance(),
    ]);

    // Received 2,200; issued 1,600 at FIFO cost; 600 left in both.
    expect(toDecimalString(valuation, 4n)).toBe('600.0000');
    expect(Number(balance)).toBe(600);
  });

  it('credits inventory with exactly what FIFO said the goods cost', async () => {
    // Not the average, and not the latest cost — the specific layers consumed.
    await receive('100', '10', { movementDate: '2026-01-10', post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });
    await receive('100', '12', { movementDate: '2026-01-20', post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });
    const issued = await issue('150', { post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });

    const { rows } = await ownerPool.query(
      `select l.credit_iqd from journal_line l
         join inventory_movement m on m.journal_entry_id = l.journal_entry_id
        where m.id = $1 and l.account_id = $2`,
      [issued.movementId, inventoryAccountId],
    );

    expect(Number(rows[0].credit_iqd)).toBe(1600);
  });

  it('links the movement to the journal it produced (Appendix B)', async () => {
    const received = await receive('10', '7', { post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } });

    const { rows } = await ownerPool.query(
      `select journal_entry_id from inventory_movement where id = $1`,
      [received.movementId],
    );
    expect(rows[0].journal_entry_id).not.toBeNull();
  });

  it('writes no movement at all when the posting fails', async () => {
    // §24's atomicity: a movement without its journal would be stock the ledger
    // does not know about. The role has no mapping, so the posting refuses.
    await ownerPool.query(`delete from posting_rule where line_role = 'grni'`);

    expect(await rejection(receive('5', '3', { post: true, dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } }))).toMatch(
      /No accounting mapping|mapping/i,
    );

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from inventory_movement where item_code = $1`,
      [ITEM],
    );
    expect(rows[0].n).toBe(0);
  });

  it('leaves a movement unposted when it is not asked to post', async () => {
    // A movement that is part of a larger document posts once, with the
    // document — not line by line.
    const received = await receive('10', '7');

    const { rows } = await ownerPool.query(
      `select journal_entry_id from inventory_movement where id = $1`,
      [received.movementId],
    );
    expect(rows[0].journal_entry_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 04.4 — negative stock, by every path
// ---------------------------------------------------------------------------

describe('04.4 gate · negative inventory is prohibited without exception', () => {
  it('refuses an issue beyond Available through the service', async () => {
    await receive('10', '5');

    expect(await rejection(issue('11'))).toMatch(/negative inventory is prohibited/i);
  });

  it('refuses it at the database, bypassing the service entirely', async () => {
    // §9.9 — "No UI, import or API transaction can create negative stock." A
    // direct insert is the shape an import or a script takes.
    await receive('10', '5');

    expect(
      await rejection(
        ownerPool.query(
          `insert into inventory_movement
             (item_code, warehouse_code, branch_code, kind, quantity, movement_date, created_by)
           values ($1,$2,$3,'delivery',-50,'2026-02-01',$4)`,
          [ITEM, WAREHOUSE, BAGHDAD, manager.principal.userId],
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);
  });

  it('refuses an issue that reservations have already spoken for', async () => {
    await receive('100', '10');
    await withScope(scope(), (tx) =>
      inventory.reserve(tx, manager, {
        itemCode: ITEM,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('90'),
        documentType: 'sales_order',
        documentId: 'SO-9',
      }),
    );

    // 100 on hand, 90 promised: only 10 may leave.
    expect(await rejection(issue('20'))).toMatch(/10 is available/);
  });

  it('lets two concurrent issues that jointly exceed stock succeed only once', async () => {
    // 04.4's hardest item. Both issues individually fit; together they do not.
    await receive('100', '10');

    const results = await Promise.allSettled([issue('60'), issue('60')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const position = await withScope(scope(), (tx) =>
      inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    );
    expect(formatQuantity(position.onHand)).toBe('40');
  });

  it('refuses a reservation beyond Available', async () => {
    await receive('10', '5');

    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.reserve(tx, manager, {
            itemCode: ITEM,
            warehouseCode: WAREHOUSE,
            branchCode: BAGHDAD,
            quantity: qty('11'),
            documentType: 'sales_order',
            documentId: 'SO-X',
          }),
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);
  });
});

// ---------------------------------------------------------------------------
// 04.3 — serial and batch
// ---------------------------------------------------------------------------

describe('04.3 gate · tracked items carry their identity', () => {
  it('refuses a movement of a tracked item without its identification', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.receive(tx, manager, {
            itemCode: TRACKED,
            warehouseCode: WAREHOUSE,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            unitCostIqd: cost('500'),
            movementDate: '2026-01-10',
          }),
        ),
      ),
    ).toMatch(/needs a serial number/);
  });

  it('refuses a batch-tracked item with no batch', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.receive(tx, manager, {
            itemCode: ITEM,
            warehouseCode: WAREHOUSE,
            branchCode: BAGHDAD,
            quantity: qty('1'),
            unitCostIqd: cost('5'),
            movementDate: '2026-01-10',
          }),
        ),
      ),
    ).toMatch(/needs a batch number/);
  });

  it('refuses to receive a serial that is already on hand', async () => {
    const receiveRouter = (serial: string) =>
      withScope(scope(), (tx) =>
        inventory.receive(tx, manager, {
          itemCode: TRACKED,
          warehouseCode: WAREHOUSE,
          branchCode: BAGHDAD,
          quantity: qty('1'),
          unitCostIqd: cost('500'),
          movementDate: '2026-01-10',
          serialNumber: serial,
        }),
      );

    await receiveRouter('SN-001');

    expect(await rejection(receiveRouter('SN-001'))).toMatch(/already on hand/);
  });

  it('lets the same serial be received again once it has been issued', async () => {
    // A returned unit is the same physical thing coming back; refusing it
    // forever would make a warranty return impossible.
    await withScope(scope(), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: TRACKED,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        unitCostIqd: cost('500'),
        movementDate: '2026-01-10',
        serialNumber: 'SN-002',
      }),
    );
    await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: TRACKED,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        movementDate: '2026-02-01',
        serialNumber: 'SN-002',
      }),
    );

    await expect(
      withScope(scope(), (tx) =>
        inventory.receive(tx, manager, {
          itemCode: TRACKED,
          warehouseCode: WAREHOUSE,
          branchCode: BAGHDAD,
          quantity: qty('1'),
          unitCostIqd: cost('500'),
          movementDate: '2026-03-01',
          serialNumber: 'SN-002',
          kind: 'sales_return',
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('traces a serial through every movement it made', async () => {
    // 04.3 gate: receipt → issue → return, in order, from one query.
    const steps = [
      { kind: 'goods_receipt' as const, date: '2026-01-10' },
      { kind: 'delivery' as const, date: '2026-02-01' },
      { kind: 'sales_return' as const, date: '2026-03-01' },
    ];

    await withScope(scope(), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: TRACKED,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        unitCostIqd: cost('500'),
        movementDate: steps[0]!.date,
        serialNumber: 'SN-003',
      }),
    );
    await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: TRACKED,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        movementDate: steps[1]!.date,
        serialNumber: 'SN-003',
      }),
    );
    await withScope(scope(), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: TRACKED,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        unitCostIqd: cost('500'),
        movementDate: steps[2]!.date,
        serialNumber: 'SN-003',
        kind: 'sales_return',
      }),
    );

    const trail = await withScope(scope(), (tx) =>
      inventory.traceIdentity(tx, TRACKED, { serialNumber: 'SN-003' }),
    );

    expect(trail.map((m) => m.kind)).toEqual(['goods_receipt', 'delivery', 'sales_return']);
    expect(trail.map((m) => m.movementDate)).toEqual(steps.map((s) => s.date));
  });

  it('reconciles batch quantities to the item’s on-hand total', async () => {
    await receive('60', '10', { batchNumber: 'B-A' });
    await receive('40', '11', { batchNumber: 'B-B' });

    const [a, b, position] = await withScope(scope(), async (tx) => [
      await inventory.traceIdentity(tx, ITEM, { batchNumber: 'B-A' }),
      await inventory.traceIdentity(tx, ITEM, { batchNumber: 'B-B' }),
      await inventory.positionOf(tx, ITEM, WAREHOUSE, BAGHDAD),
    ]);

    const sum = [...a, ...b].reduce((total, m) => total + parseQuantity(m.quantity), 0n);
    expect(sum).toBe(position.onHand);
  });
});

// ---------------------------------------------------------------------------
// The ledger is append-only
// ---------------------------------------------------------------------------

describe('§9.9 · the ledger is what happened', () => {
  it('refuses to edit a movement', async () => {
    const received = await receive('10', '5');

    expect(
      await rejection(
        ownerPool.query(`update inventory_movement set quantity = 999 where id = $1`, [
          received.movementId,
        ]),
      ),
    ).toMatch(/append-only/);
  });

  it('refuses to delete a movement', async () => {
    const received = await receive('10', '5');

    expect(
      await rejection(
        ownerPool.query(`delete from inventory_movement where id = $1`, [received.movementId]),
      ),
    ).toMatch(/append-only/);
  });

  it('withholds UPDATE and DELETE on the ledger from the application role', async () => {
    const { rows } = await ownerPool.query(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'erp_app' and table_name = 'inventory_movement'
        order by privilege_type`,
    );
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });

  it('refuses a movement of zero', async () => {
    expect(
      await rejection(
        ownerPool.query(
          `insert into inventory_movement
             (item_code, warehouse_code, branch_code, kind, quantity, movement_date, created_by)
           values ($1,$2,$3,'goods_receipt',0,'2026-01-10',$4)`,
          [ITEM, WAREHOUSE, BAGHDAD, manager.principal.userId],
        ),
      ),
    ).toMatch(/quantity_not_zero/);
  });
});
