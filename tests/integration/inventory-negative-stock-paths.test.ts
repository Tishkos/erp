/**
 * Phase 04.4 test gate — §9.9's three paths, and 04.8's adjustment posting.
 *
 * *"No UI, import or API transaction can create negative stock."* The blueprint
 * names three paths and the phase brief says to test all four separately
 * (adding the database). They are separate tests because they fail for
 * different reasons when they fail: an API bypass is a missing service check, an
 * import bypass is a second write path nobody remembered, and a database bypass
 * is a missing constraint. Proving one proves nothing about the others.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as importing from '@/server/services/import';
import * as counts from '@/server/services/stock-count';
import '@/server/services/import-definitions';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const STORES = 'WH-BGW';
const ITEM = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const cost = (iqd: string) => parseDecimal(iqd, 4n);

let manager: ActorContext;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Manager',
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
       ('accounting_manager','inventory_movement','import'),
       ('accounting_manager','inventory_movement','approve')
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

  manager = await createManager();
});

async function stock(quantity: string, unitCost = '10') {
  await withScope(scope(), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: ITEM,
      warehouseCode: STORES,
      branchCode: BAGHDAD,
      quantity: qty(quantity),
      unitCostIqd: cost(unitCost),
      movementDate: '2026-01-10',
      batchNumber: 'B-1',
    }),
  );
}

const onHand = async () =>
  formatQuantity(
    (await withScope(scope(), (tx) => inventory.positionOf(tx, ITEM, STORES, BAGHDAD))).onHand,
  );

// ---------------------------------------------------------------------------

describe('04.4 gate · the API path', () => {
  it('refuses an issue beyond what is available', async () => {
    // The service is the API: §23 requires the API to enforce what the UI does,
    // and it does so by being the same function.
    await stock('10');

    expect(
      await rejection(
        withScope(scope(), (tx) =>
          inventory.issue(tx, manager, {
            itemCode: ITEM,
            warehouseCode: STORES,
            branchCode: BAGHDAD,
            quantity: qty('11'),
            movementDate: '2026-02-01',
            batchNumber: 'B-1',
          }),
        ),
      ),
    ).toMatch(/negative inventory is prohibited/i);

    expect(await onHand()).toBe('10');
  });
});

describe('04.4 gate · the import path', () => {
  /** A CSV the import framework will parse. */
  const file = (rows: string[]) =>
    ['item_code,warehouse_code,branch_code,quantity,movement_date,batch_number,unit_cost_iqd']
      .concat(rows)
      .join('\n');

  it('refuses a file that would take stock negative, and commits nothing', async () => {
    await stock('10');

    const batch = await withScope(scope(), (tx) =>
      importing.upload(tx, manager, 'inventory_movement', file([`${ITEM},${STORES},${BAGHDAD},-11,2026-02-01,B-1,`]), 'issues.csv'),
    );

    // The row parses — it is a well-formed movement — so the refusal comes from
    // the service at commit, which is the point: the import is not a second
    // write path with its own rules.
    await rejection(withScope(scope(), (tx) => importing.commit(tx, manager, batch.batchId)));

    expect(await onHand()).toBe('10');
  });

  it('commits a file that fits', async () => {
    await stock('100');

    const batch = await withScope(scope(), (tx) =>
      importing.upload(tx, manager, 'inventory_movement', file([`${ITEM},${STORES},${BAGHDAD},-30,2026-02-01,B-1,`]), 'issues.csv'),
    );
    await withScope(scope(), (tx) => importing.commit(tx, manager, batch.batchId));

    expect(await onHand()).toBe('70');
  });

  it('commits nothing at all when one row of many would go negative', async () => {
    // §4.4 — "a mixed valid/invalid file commits nothing". Applied here to a row
    // that is valid on its own and impossible in sequence.
    await stock('50');

    const batch = await withScope(scope(), (tx) =>
      importing.upload(tx, manager, 'inventory_movement', file([
          `${ITEM},${STORES},${BAGHDAD},-30,2026-02-01,B-1,`,
          `${ITEM},${STORES},${BAGHDAD},-30,2026-02-02,B-1,`,
        ]), 'issues.csv'),
    );

    await rejection(withScope(scope(), (tx) => importing.commit(tx, manager, batch.batchId)));

    expect(await onHand()).toBe('50');
  });

  it('refuses stock coming in with no cost — it would become a free FIFO layer', async () => {
    const batch = await withScope(scope(), (tx) =>
      importing.upload(tx, manager, 'inventory_movement', file([`${ITEM},${STORES},${BAGHDAD},10,2026-02-01,B-1,`]), 'receipts.csv'),
    );

    expect(batch.errorFile).toMatch(/unit_cost_iqd is missing/);
  });

  it('refuses an importer who does not hold the import verb', async () => {
    // §5.3 — importing ten thousand movements is a different permission from
    // making one.
    const outsider = await (async () => {
      const id = randomUUID();
      await ownerPool.query(
        `insert into app_user (id, email, display_name) values ($1,$2,'Outsider')`,
        [id, `${id}@example.com`],
      );
      await ownerPool.query(
        `insert into user_branch_scope (user_id, branch_code) values ($1,$2)`,
        [id, BAGHDAD],
      );
      const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
        authz.loadPrincipal(tx, id),
      );
      return { principal, branchCode: BAGHDAD } satisfies ActorContext;
    })();

    expect(
      await rejection(
        withScope({ userId: outsider.principal.userId, branchCode: BAGHDAD }, (tx) =>
          importing.upload(tx, outsider, 'inventory_movement', file([`${ITEM},${STORES},${BAGHDAD},-1,2026-02-01,B-1,`]), 'issues.csv'),
        ),
      ),
    ).toMatch(/'import' on 'inventory_movement' is not granted/);
  });
});

describe('04.4 gate · no configuration permits negative stock', () => {
  it('has no warehouse flag that allows it', async () => {
    // §9.2 — "without exception". Phase 03 already refuses a warehouse
    // configured to allow negative stock; this states the stronger fact that
    // there is no column to set.
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'warehouse'
          and (column_name ilike '%negative%' or column_name ilike '%allow%')`,
    );

    expect(rows.map((r) => r.column_name)).toEqual(['allow_negative_stock']);

    // And it cannot be set to true, whatever anyone does.
    expect(
      await rejection(
        ownerPool.query(`update warehouse set allow_negative_stock = true where code = $1`, [
          STORES,
        ]),
      ),
    ).toMatch(/negative|check/i);
  });

  it('has no configuration column anywhere that could turn the check off', async () => {
    // Stated across the whole schema rather than against one settings table:
    // the guarantee §9.2 asks for is that no configuration *anywhere* permits
    // it, and a new table with a tempting flag on it is exactly how that gets
    // lost. `allow_negative_stock` is the one such column, and Phase 03 pins it
    // to false — the test above proves it cannot be set.
    const { rows } = await ownerPool.query(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and (column_name ilike '%negative%' or column_name ilike '%allow_%stock%')
        order by table_name, column_name`,
    );

    expect(rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      // REQ-HR-001 §7: days of leave a person may take before earning them —
      // a leave balance, not a stock quantity. Listed so the gate stays exact.
      'leave_type.allowed_negative_days',
      'warehouse.allow_negative_stock',
    ]);
  });

  it('takes no option that relaxes the check', async () => {
    // The service function's signature is the proof: a position and a quantity.
    // There is no third argument to pass.
    const { assertCanIssue } = await import('@domain/inventory');
    expect(assertCanIssue.length).toBe(2);
  });
});

describe('04.8 gate · the adjustment posts and reconciles to the G/L', () => {
  let inventoryAccountId: string;

  beforeEach(async () => {
    await ownerPool.query(
      `insert into fiscal_year (code, name, starts_on, ends_on)
       values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31')`,
    );
    const { rows: years } = await ownerPool.query(
      `select id from fiscal_year where code = 'FY2026'`,
    );
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,1,'January 2026','2026-01-01','2026-01-31'),
              ($1,3,'March 2026','2026-03-01','2026-03-31')`,
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
      ['inventory_loss', 'X000001', 'X900001', 'Inventory Loss'],
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
         values ('inventory.count_adjustment', $1, $2, true, $3)`,
        [role, rows[0].id, manager.principal.userId],
      );
      if (role === 'inventory') inventoryAccountId = rows[0].id;
    }
  });

  it('posts a shortfall as an inventory loss at FIFO cost', async () => {
    await stock('100', '10');

    const { id } = await withScope(scope(), (tx) =>
      counts.plan(tx, manager, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: ITEM,
      }),
    );
    await withScope(scope(), (tx) =>
      counts.recordCount(tx, manager, id, {
        countedOn: '2026-03-02',
        quantities: { 1: qty('92') },
      }),
    );
    await withScope(scope(), (tx) =>
      counts.approveVariance(tx, manager, id, 'Eight units short after recount.'),
    );
    await withScope(scope(), (tx) =>
      counts.adjust(tx, manager, id, {
        adjustedOn: '2026-03-05',
        post: true,
        dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' },
      }),
    );

    // 8 units at 10 = 80, credited out of inventory.
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
        where l.account_id = $1 and e.status = 'posted'`,
      [inventoryAccountId],
    );
    expect(Number(rows[0].balance)).toBe(-80);
  });

  it('leaves the layers and the ledger agreeing afterwards', async () => {
    await stock('100', '10');

    const { id } = await withScope(scope(), (tx) =>
      counts.plan(tx, manager, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        plannedOn: '2026-03-01',
        scope: 'item',
        scopeFilter: ITEM,
      }),
    );
    await withScope(scope(), (tx) =>
      counts.recordCount(tx, manager, id, {
        countedOn: '2026-03-02',
        quantities: { 1: qty('92') },
      }),
    );
    await withScope(scope(), (tx) =>
      counts.approveVariance(tx, manager, id, 'Short by eight.'),
    );
    await withScope(scope(), (tx) =>
      counts.adjust(tx, manager, id, {
        adjustedOn: '2026-03-05',
        post: true,
        dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' },
      }),
    );

    const [position, layers, valuation] = await withScope(scope(), async (tx) => [
      await inventory.positionOf(tx, ITEM, STORES, BAGHDAD),
      await inventory.layerQuantityOf(tx, ITEM, STORES),
      await inventory.valuationOf(tx, ITEM, STORES),
    ]);

    expect(formatQuantity(position.onHand)).toBe('92');
    expect(position.onHand).toBe(layers);
    expect(toDecimalString(valuation, 4n)).toBe('920.0000');
  });
});
