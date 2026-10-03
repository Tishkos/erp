/**
 * Phase 04.10 test gate — inventory reports.
 *
 *   - FIFO Valuation total equals the inventory G/L control account balance
 *   - Serial/Batch Trace returns the complete movement history for an identifier
 *   - Every report respects branch and department data scope
 *   - Reports distinguish posted from provisional data (§22)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as reports from '@/server/services/inventory-reports';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';
const ITEM = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const cost = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;
let inventoryAccountId: string;

async function createManager(branches: readonly string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Manager')`, [
    id,
    `${id}@example.com`,
  ]);
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
    [id],
  );
  for (const branch of branches) {
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      id,
      branch,
    ]);
  }
  await ownerPool.query(
    `insert into role_grant (role_code, object, verb) values
       ('accounting_manager','inventory_movement','execute'),
       ('accounting_manager','inventory_movement','view')
     on conflict do nothing`,
  );

  const principal = await withScope({ userId: id, branchCode: branches[0]! }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: branches[0]! };
}

const scope = (branchCode = BAGHDAD) => ({
  userId: manager.principal.userId,
  branchCode,
});

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(ERBIL, 'Erbil');

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Network Cable 2m',true,'EA','batch') returning id`,
      [ITEM],
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

  manager = await createManager([BAGHDAD, ERBIL]);

  // A fiscal calendar, a rate and the two mapped accounts, so movements can post.
  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on)
     values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31')`,
  );
  const { rows: years } = await ownerPool.query(
    `select id from fiscal_year where code = 'FY2026'`,
  );
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,1,'January 2026','2026-01-01','2026-01-31')`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1)`,
    [manager.principal.userId],
  );
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );

  for (const [role, parent, code, name] of [
    ['inventory', 'A000001', 'A900001', 'Inventory'],
    ['grni', 'L000001', 'L900001', 'Goods Received Not Invoiced'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [code, name, parents[0].account_type, parents[0].id],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('inventory.goods_receipt', $1, $2, true, $3)`,
      [role, rows[0].id, manager.principal.userId],
    );
    if (role === 'inventory') inventoryAccountId = rows[0].id;
  }
});

async function receive(
  branchCode: string,
  quantity: string,
  unitCost: string,
  options: { post?: boolean; batch?: string; expiry?: string } = {},
) {
  return withScope(scope(branchCode), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: ITEM,
      warehouseCode: `WH-${branchCode}`,
      branchCode,
      quantity: qty(quantity),
      unitCostIqd: cost(unitCost),
      movementDate: '2026-01-10',
      batchNumber: options.batch ?? 'B-1',
      expiryDate: options.expiry ?? null,
      post: options.post ?? false,
      ...(options.post
        ? { dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' } }
        : {}),
    }),
  );
}

// ---------------------------------------------------------------------------

describe('04.10 gate · FIFO valuation equals the G/L control balance', () => {
  it('reports the same total the ledger holds', async () => {
    await receive(BAGHDAD, '100', '10', { post: true });
    await receive(BAGHDAD, '50', '12', { post: true });

    const rows = await withScope(scope(), (tx) => reports.valuation(tx, manager.principal));
    const reported = rows.reduce((sum, r) => sum + Number(r.valueIqd), 0);

    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [inventoryAccountId],
    );

    expect(reported).toBe(1600);
    expect(Number(ledger[0].balance)).toBe(reported);
  });

  it('agrees with the domain’s own valuation, computed a different way', async () => {
    // The report sums in SQL and `domain/fifo.ts` sums in TypeScript. Two
    // implementations of one rule is the thing that drifts, so they are checked
    // against each other rather than trusted separately.
    await receive(BAGHDAD, '100', '10.3333');
    await receive(BAGHDAD, '50', '7.6667');

    const [rows, domainValue] = await withScope(scope(), async (tx) => [
      await reports.valuation(tx, manager.principal),
      await inventory.valuationOf(tx, ITEM, `WH-${BAGHDAD}`),
    ]);

    expect(Number(rows[0]!.valueIqd)).toBeCloseTo(Number(toDecimalString(domainValue, 4n)), 4);
  });

  it('follows an issue down', async () => {
    await receive(BAGHDAD, '100', '10', { post: true });
    await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: ITEM,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: qty('40'),
        movementDate: '2026-01-20',
        batchNumber: 'B-1',
      }),
    );

    const rows = await withScope(scope(), (tx) => reports.valuation(tx, manager.principal));
    expect(Number(rows[0]!.valueIqd)).toBe(600);
  });
});

describe('04.10 gate · reports distinguish posted from provisional (§22)', () => {
  it('splits the value by whether the movement reached the ledger', async () => {
    await receive(BAGHDAD, '100', '10', { post: true });
    await receive(BAGHDAD, '50', '10'); // not posted

    const rows = await withScope(scope(), (tx) => reports.valuation(tx, manager.principal));
    const row = rows[0]!;

    expect(Number(row.valueIqd)).toBe(1500);
    expect(Number(row.postedValueIqd)).toBe(1000);
    expect(Number(row.provisionalValueIqd)).toBe(500);
  });

  it('shows nothing as provisional when everything has posted', async () => {
    await receive(BAGHDAD, '100', '10', { post: true });

    const rows = await withScope(scope(), (tx) => reports.valuation(tx, manager.principal));
    expect(Number(rows[0]!.provisionalValueIqd)).toBe(0);
  });

  it('makes the posted figure the one that ties to the G/L', async () => {
    // The reason §22 asks for the split: a report that mixed the two would say
    // the warehouse and the ledger disagree without saying which to trust.
    await receive(BAGHDAD, '100', '10', { post: true });
    await receive(BAGHDAD, '50', '10');

    const rows = await withScope(scope(), (tx) => reports.valuation(tx, manager.principal));
    const { rows: ledger } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
         from journal_line l join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [inventoryAccountId],
    );

    expect(Number(rows[0]!.postedValueIqd)).toBe(Number(ledger[0].balance));
  });
});

describe('04.10 gate · trace returns the complete history', () => {
  it('returns every movement of a batch, oldest first', async () => {
    await receive(BAGHDAD, '100', '10', { batch: 'B-TRACE' });
    await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: ITEM,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-01-20',
        batchNumber: 'B-TRACE',
      }),
    );

    const trail = await withScope(scope(), (tx) =>
      reports.trace(tx, manager.principal, { batchNumber: 'B-TRACE' }),
    );

    expect(trail.map((r) => r.kind)).toEqual(['goods_receipt', 'delivery']);
    expect(trail.map((r) => r.movementDate)).toEqual(['2026-01-10', '2026-01-20']);
  });

  it('carries the source document and the journal on each step', async () => {
    await receive(BAGHDAD, '10', '10', { post: true, batch: 'B-TRACE' });

    const trail = await withScope(scope(), (tx) =>
      reports.trace(tx, manager.principal, { batchNumber: 'B-TRACE' }),
    );
    expect(trail[0]!.journalEntryId).not.toBeNull();
  });

  it('refuses a trace with no identifier — that is a stock ledger, not a trace', async () => {
    expect(
      await rejection(
        withScope(scope(), (tx) => reports.trace(tx, manager.principal, { itemCode: ITEM })),
      ),
    ).toMatch(/needs a serial or a batch number/);
  });

  it('finds a batch across warehouses, without being told where to look', async () => {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type)
       values ('WH-BGW-2','Baghdad Secondary',$1,'main')`,
      [BAGHDAD],
    );

    await receive(BAGHDAD, '10', '10', { batch: 'B-HERE' });
    await withScope(scope(), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: ITEM,
        warehouseCode: 'WH-BGW-2',
        branchCode: BAGHDAD,
        quantity: qty('5'),
        unitCostIqd: cost('10'),
        movementDate: '2026-01-12',
        batchNumber: 'B-HERE',
      }),
    );

    const trail = await withScope(scope(), (tx) =>
      reports.trace(tx, manager.principal, { batchNumber: 'B-HERE' }),
    );

    expect(trail).toHaveLength(2);
    expect(trail.map((r) => r.warehouseCode)).toEqual(['WH-BGW', 'WH-BGW-2']);
  });

  it('follows a unit into another branch the user holds (§9.9, D10)', async () => {
    // The trace is the report that must not stop at the Active Branch. This
    // manager is permitted both branches, so a batch that moved to Erbil is
    // found from a Baghdad seat — which is what "traceability end to end" means
    // when a company has more than one branch. Under the superseded session-branch
    // model this returned nothing, and a recall would have stopped there.
    await receive(ERBIL, '5', '10', { batch: 'B-EBL-ONLY' });

    const fromBaghdad = await withScope(scope(BAGHDAD), (tx) =>
      reports.trace(tx, manager.principal, { batchNumber: 'B-EBL-ONLY' }),
    );
    const fromErbil = await withScope(scope(ERBIL), (tx) =>
      reports.trace(tx, manager.principal, { batchNumber: 'B-EBL-ONLY' }),
    );

    expect(fromBaghdad).toHaveLength(1);
    expect(fromBaghdad[0]!.warehouseCode).toBe(`WH-${ERBIL}`);
    // And the seat makes no difference to the answer, which is the point.
    expect(fromErbil).toEqual(fromBaghdad);
  });

  it('stops at the permitted-branch boundary, because row-level security does (§22)', async () => {
    // The limit that is real under D10: not where you are sitting, but what you
    // hold. A user permitted Baghdad alone traces an Erbil batch and finds
    // nothing — from either seat, because selecting a branch you are not
    // permitted grants nothing.
    await receive(ERBIL, '5', '10', { batch: 'B-EBL-CLOSED' });

    const baghdadOnly = await createManager([BAGHDAD]);

    const fromBaghdad = await withScope(
      { userId: baghdadOnly.principal.userId, branchCode: BAGHDAD },
      (tx) => reports.trace(tx, baghdadOnly.principal, { batchNumber: 'B-EBL-CLOSED' }),
    );
    const claimingErbil = await withScope(
      { userId: baghdadOnly.principal.userId, branchCode: ERBIL },
      (tx) => reports.trace(tx, baghdadOnly.principal, { batchNumber: 'B-EBL-CLOSED' }),
    );

    expect(fromBaghdad).toEqual([]);
    expect(claimingErbil).toEqual([]);
  });
});

describe('04.10 gate · reports respect data scope', () => {
  it('opens a Baghdad session on Baghdad’s stock', async () => {
    // D10 — the Active Branch as a *default*: a valuation is a daily working
    // figure, so it opens on the branch the user is working in.
    await receive(BAGHDAD, '100', '10');
    await receive(ERBIL, '40', '10');

    const rows = await withScope(scope(BAGHDAD), (tx) =>
      reports.valuation(tx, manager.principal),
    );

    expect(rows.map((r) => r.branchCode)).toEqual([BAGHDAD]);
    expect(Number(rows[0]!.quantity)).toBe(100);
  });

  it('shows the same user Erbil’s stock once they switch branch', async () => {
    await receive(BAGHDAD, '100', '10');
    await receive(ERBIL, '40', '10');

    const rows = await withScope(scope(ERBIL), (tx) => reports.valuation(tx, manager.principal));

    expect(rows.map((r) => r.branchCode)).toEqual([ERBIL]);
    expect(Number(rows[0]!.quantity)).toBe(40);
  });

  it('consolidates every permitted branch when asked, from either seat (D10)', async () => {
    // What the session-branch model could not express at all: this manager holds
    // both branches, and at month end wants one figure rather than two reports
    // stapled together.
    await receive(BAGHDAD, '100', '10');
    await receive(ERBIL, '40', '10');

    const rows = await withScope(scope(BAGHDAD), (tx) =>
      reports.valuation(tx, manager.principal, { allPermittedBranches: true }),
    );

    expect(rows.map((r) => r.branchCode).sort()).toEqual([BAGHDAD, ERBIL]);
    expect(rows.reduce((total, r) => total + Number(r.quantity), 0)).toBe(140);
  });

  it('will not consolidate a branch the user does not hold', async () => {
    // "All permitted branches" is not "all branches". The database decides which
    // is which, so the widening flag cannot be turned into a way in.
    await receive(BAGHDAD, '100', '10');
    await receive(ERBIL, '40', '10');

    const baghdadOnly = await createManager([BAGHDAD]);

    const rows = await withScope(
      { userId: baghdadOnly.principal.userId, branchCode: BAGHDAD },
      (tx) => reports.valuation(tx, baghdadOnly.principal, { allPermittedBranches: true }),
    );

    expect(rows.map((r) => r.branchCode)).toEqual([BAGHDAD]);
  });

  it('refuses a named branch the user does not hold, rather than silently widening', async () => {
    await receive(ERBIL, '40', '10');

    const baghdadOnly = await createManager([BAGHDAD]);

    const rows = await withScope(
      { userId: baghdadOnly.principal.userId, branchCode: BAGHDAD },
      (tx) => reports.valuation(tx, baghdadOnly.principal, { branchCode: ERBIL }),
    );

    expect(rows).toEqual([]);
  });

  it('refuses a report to someone without the view permission', async () => {
    const outsider = {
      ...manager.principal,
      grants: manager.principal.grants.filter((g) => g.object !== 'inventory_movement'),
    };

    expect(
      await rejection(withScope(scope(), (tx) => reports.valuation(tx, outsider))),
    ).toMatch(/'view' on 'inventory_movement' is not granted/);
  });

  it('scopes the trace to permitted branches, not to the seat', async () => {
    // The scope test for the trace, restated under D10: the boundary is what the
    // user holds. A Baghdad-only user finds nothing; the two-branch manager
    // finds it from the same seat.
    await receive(ERBIL, '5', '10', { batch: 'B-EBL' });

    const baghdadOnly = await createManager([BAGHDAD]);

    const denied = await withScope(
      { userId: baghdadOnly.principal.userId, branchCode: BAGHDAD },
      (tx) => reports.trace(tx, baghdadOnly.principal, { batchNumber: 'B-EBL' }),
    );
    const permitted = await withScope(scope(BAGHDAD), (tx) =>
      reports.trace(tx, manager.principal, { batchNumber: 'B-EBL' }),
    );

    expect(denied).toEqual([]);
    expect(permitted).toHaveLength(1);
  });
});

describe('§9.9 · the integrity report', () => {
  it('returns nothing when inventory reconciles', async () => {
    await receive(BAGHDAD, '100', '10');
    await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: ITEM,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: qty('30'),
        movementDate: '2026-01-20',
        batchNumber: 'B-1',
      }),
    );

    expect(await withScope(scope(), (tx) => reports.integrity(tx, manager.principal))).toEqual([]);
  });

  it('reports expiring stock by batch', async () => {
    await receive(BAGHDAD, '10', '10', { batch: 'B-SOON', expiry: '2026-03-01' });
    await receive(BAGHDAD, '10', '10', { batch: 'B-LATER', expiry: '2027-03-01' });

    const rows = await withScope(scope(), (tx) =>
      reports.expiring(tx, manager.principal, '2026-06-30'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.batchNumber).toBe('B-SOON');
  });

  it('leaves a fully issued batch out of the expiry report', async () => {
    // What is expiring is a question about what is on the shelf.
    await receive(BAGHDAD, '10', '10', { batch: 'B-GONE', expiry: '2026-03-01' });
    await withScope(scope(), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: ITEM,
        warehouseCode: `WH-${BAGHDAD}`,
        branchCode: BAGHDAD,
        quantity: qty('10'),
        movementDate: '2026-01-20',
        batchNumber: 'B-GONE',
      }),
    );

    const rows = await withScope(scope(), (tx) =>
      reports.expiring(tx, manager.principal, '2026-06-30'),
    );
    expect(rows).toEqual([]);
  });
});
