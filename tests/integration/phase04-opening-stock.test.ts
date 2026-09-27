/**
 * Phase 04.5 test gate — opening stock, §9.7.
 *
 *   - Approval creates cost layers dated to the cost-layer date, not the
 *     approval date
 *   - The opening accounting entry balances and posts through the Phase 02
 *     engine
 *   - Serial/batch data from opening stock is traceable in the same way as
 *     received stock
 *   - Opening stock cannot be entered for an item without its required tracking
 *     data
 *
 * Plus 04.3's end-to-end trace, which now has every stage to travel through.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as inventory from '@/server/services/inventory';
import * as opening from '@/server/services/opening-stock';
import * as states from '@/server/services/stock-states';
import * as transfers from '@/server/services/transfers';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';

const BAGHDAD = 'BGW';
const STORES = 'WH-BGW';
const SECOND = 'WH-BGW-2';
const DAMAGED = 'WH-DMG';
const ITEM = 'ITM-CABLE';
const TRACKED = 'ITM-SERIAL';

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
       ($1,'inventory_movement','view'),
       ($1,'inventory_movement','approve'),
       ($1,'warehouse_transfer','view'),
       ($1,'warehouse_transfer','create'),
       ($1,'warehouse_transfer','execute'),
       ($1,'warehouse_transfer','approve')
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

  for (const [code, name, type] of [
    [SECOND, 'Baghdad Secondary', 'main'],
    [DAMAGED, 'Baghdad Damaged Goods', 'damaged_goods'],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type) values ($1,$2,$3,$4)`,
      [code, name, BAGHDAD, type],
    );
  }

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

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
});

/** A submitted opening stock document, raised by the officer. */
async function submitted(lines: opening.OpeningStockLineInput[]): Promise<string> {
  const { id } = await withScope(scope(officer), (tx) =>
    opening.create(tx, officer, {
      branchCode: BAGHDAD,
      warehouseCode: STORES,
      documentDate: '2026-01-31',
      description: 'Go-live opening position',
      lines,
    }),
  );
  await withScope(scope(officer), (tx) => opening.submit(tx, officer, id));
  return id;
}

describe('§9.7 · the document', () => {
  it('numbers it by branch and year', async () => {
    const { documentNo } = await withScope(scope(officer), (tx) =>
      opening.create(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        documentDate: '2026-01-31',
        lines: [
          {
            itemCode: ITEM,
            quantity: qty('100'),
            uomCode: 'EA',
            unitCostIqd: cost('10'),
            costLayerDate: '2025-11-01',
            batchNumber: 'B-OPEN',
          },
        ],
      }),
    );

    expect(documentNo).toMatch(/^OPN-BGW-2026-\d{6}$/);
  });

  it('moves no stock while it is a draft', async () => {
    await withScope(scope(officer), (tx) =>
      opening.create(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        documentDate: '2026-01-31',
        lines: [
          {
            itemCode: ITEM,
            quantity: qty('100'),
            uomCode: 'EA',
            unitCostIqd: cost('10'),
            costLayerDate: '2025-11-01',
            batchNumber: 'B-OPEN',
          },
        ],
      }),
    );

    const position = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, ITEM, STORES, BAGHDAD),
    );
    expect(formatQuantity(position.onHand)).toBe('0');
  });

  it('refuses a document with no lines', async () => {
    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          opening.create(tx, officer, {
            branchCode: BAGHDAD,
            warehouseCode: STORES,
            documentDate: '2026-01-31',
            lines: [],
          }),
        ),
      ),
    ).toMatch(/brings nothing onto the system/);
  });

  it('lets the raiser approve their own opening stock (§14.4 lifted, 2026-09-27)', async () => {
    // §14.4 asked that the person who typed the opening figures not be the
    // person who confirms them. The owner removed that requirement on
    // 2026-09-27: the company runs this with one person who holds both roles,
    // and a control nobody can satisfy stops the books being opened at all.
    // `approve` is still a permission — the test below shows an officer is
    // refused — but holding it is enough. This test used to assert the old
    // rule and sat red for a day after the rule changed; a rule and the test
    // that describes it now land together.
    const { id } = await withScope(scope(manager), (tx) =>
      opening.create(tx, manager, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        documentDate: '2026-01-31',
        lines: [
          {
            itemCode: ITEM,
            quantity: qty('100'),
            uomCode: 'EA',
            unitCostIqd: cost('10'),
            costLayerDate: '2025-11-01',
            batchNumber: 'B-OPEN',
          },
        ],
      }),
    );
    await withScope(scope(manager), (tx) => opening.submit(tx, manager, id));

    const approved = await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));
    expect(approved.movementIds).toHaveLength(1);
  });

  it('refuses an officer approving at all — they do not hold the verb', async () => {
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('100'),
        uomCode: 'EA',
        unitCostIqd: cost('10'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-OPEN',
      },
    ]);

    expect(
      await rejection(withScope(scope(officer), (tx) => opening.approve(tx, officer, id))),
    ).toMatch(/'approve' on 'opening_stock' is not granted/);
  });
});

describe('04.5 gate · cannot be entered without required tracking data', () => {
  it('refuses a serial-tracked item with no serial', async () => {
    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          opening.create(tx, officer, {
            branchCode: BAGHDAD,
            warehouseCode: STORES,
            documentDate: '2026-01-31',
            lines: [
              {
                itemCode: TRACKED,
                quantity: qty('1'),
                uomCode: 'EA',
                unitCostIqd: cost('500'),
                costLayerDate: '2025-11-01',
              },
            ],
          }),
        ),
      ),
    ).toMatch(/needs a serial number/);
  });

  it('gives a batch-tracked item with no batch the document number as its batch', async () => {
    // Operations block 7's Opening Stock asks for no batch. The document that
    // put the units on the system is their batch, the way a Purchase
    // Invoice's number is the batch of what it brings in (§9.3 still holds:
    // every unit traces to the paper that brought it in).
    const created = await withScope(scope(officer), (tx) =>
      opening.create(tx, officer, {
        branchCode: BAGHDAD,
        warehouseCode: STORES,
        documentDate: '2026-01-31',
        lines: [
          {
            itemCode: ITEM,
            quantity: qty('10'),
            uomCode: 'EA',
            unitCostIqd: cost('10'),
            costLayerDate: '2025-11-01',
          },
        ],
      }),
    );
    const { rows } = await ownerPool.query(
      `select batch_number from opening_stock_line where opening_stock_id = $1`,
      [created.id],
    );
    expect(rows[0].batch_number).toBe(created.documentNo);
  });

  it('refuses an item that does not exist', async () => {
    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          opening.create(tx, officer, {
            branchCode: BAGHDAD,
            warehouseCode: STORES,
            documentDate: '2026-01-31',
            lines: [
              {
                itemCode: 'ITM-NOPE',
                quantity: qty('1'),
                uomCode: 'EA',
                unitCostIqd: cost('1'),
                costLayerDate: '2025-11-01',
              },
            ],
          }),
        ),
      ),
    ).toMatch(/No item 'ITM-NOPE'/);
  });

  it('refuses an expiry date before the manufacture date', async () => {
    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          opening.create(tx, officer, {
            branchCode: BAGHDAD,
            warehouseCode: STORES,
            documentDate: '2026-01-31',
            lines: [
              {
                itemCode: ITEM,
                quantity: qty('10'),
                uomCode: 'EA',
                unitCostIqd: cost('10'),
                costLayerDate: '2025-11-01',
                batchNumber: 'B-OPEN',
                manufacturedOn: '2026-01-01',
                expiryDate: '2025-06-01',
              },
            ],
          }),
        ),
      ),
    ).toMatch(/expiry_after_manufacture/);
  });
});

describe('04.5 gate · layers are dated to the cost-layer date', () => {
  it('dates the layer to when the stock was acquired, not to today', async () => {
    // The whole reason §9.7 has the field: stock bought in November must consume
    // before stock bought in January, however the two were entered.
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('100'),
        uomCode: 'EA',
        unitCostIqd: cost('10'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-OPEN',
      },
    ]);

    await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));

    const layers = await withScope(scope(manager), (tx) => inventory.layersOf(tx, ITEM, STORES));
    expect(layers[0]!.layerDate).toBe('2025-11-01');
  });

  it('consumes opening stock before stock received later', async () => {
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('50'),
        uomCode: 'EA',
        unitCostIqd: cost('8'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-OPEN',
      },
    ]);
    await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));

    // Received after go-live, at a different cost.
    await withScope(scope(manager), (tx) =>
      inventory.receive(tx, manager, {
        itemCode: ITEM,
        warehouseCode: STORES,
        branchCode: BAGHDAD,
        quantity: qty('50'),
        unitCostIqd: cost('12'),
        movementDate: '2026-02-10',
        batchNumber: 'B-NEW',
      }),
    );

    const issued = await withScope(scope(manager), (tx) =>
      inventory.issue(tx, manager, {
        itemCode: ITEM,
        warehouseCode: STORES,
        branchCode: BAGHDAD,
        quantity: qty('60'),
        movementDate: '2026-03-01',
        batchNumber: 'B-OPEN',
      }),
    );

    // 50 at 8 + 10 at 12 = 520. An average would give 600.
    expect(toDecimalString(issued.costIqd!, 4n)).toBe('520.0000');
  });

  it('records the movement against the document line', async () => {
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('30'),
        uomCode: 'EA',
        unitCostIqd: cost('9'),
        costLayerDate: '2025-12-01',
        batchNumber: 'B-OPEN',
      },
    ]);
    await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));

    const { lines } = await withScope(scope(manager), (tx) => opening.view(tx, id));
    expect(lines[0]!.movementId).not.toBeNull();

    const { rows } = await ownerPool.query(
      `select kind, movement_date from inventory_movement where id = $1`,
      [lines[0]!.movementId],
    );
    expect(rows[0].kind).toBe('opening_stock');
  });

  it('cannot be changed once approved', async () => {
    // Its lines are the FIFO layers every margin since rests on.
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('30'),
        uomCode: 'EA',
        unitCostIqd: cost('9'),
        costLayerDate: '2025-12-01',
        batchNumber: 'B-OPEN',
      },
    ]);
    await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));

    expect(
      await rejection(
        ownerPool.query(`update opening_stock set description = 'edited' where id = $1`, [id]),
      ),
    ).toMatch(/approved and cannot be changed/);
  });
});

describe('04.5 gate · the opening entry balances and posts', () => {
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

    // Inventory and the opening balance account, mapped by role (§3.3).
    for (const [role, parent, code, name] of [
      ['inventory', 'A000001', 'A900001', 'Inventory'],
      ['opening_balance', 'E000001', 'E900001', 'Opening Balance Equity'],
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
         values ('inventory.opening_stock', $1, $2, true, $3)`,
        [role, rows[0].id, manager.principal.userId],
      );
    }
  });

  it('posts one balanced journal for the whole document', async () => {
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('100'),
        uomCode: 'EA',
        unitCostIqd: cost('10'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-OPEN',
      },
      {
        itemCode: ITEM,
        quantity: qty('50'),
        uomCode: 'EA',
        unitCostIqd: cost('12'),
        costLayerDate: '2025-12-01',
        batchNumber: 'B-OPEN-2',
      },
    ]);

    const result = await withScope(scope(manager), (tx) =>
      opening.approve(tx, manager, id, {
        post: true,
        dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' },
      }),
    );

    expect(result.journalEntryId).not.toBeNull();

    const { rows } = await ownerPool.query(
      `select total_debit_iqd, total_credit_iqd, status from journal_entry where id = $1`,
      [result.journalEntryId],
    );

    // 100 × 10 + 50 × 12 = 1,600.
    expect(Number(rows[0].total_debit_iqd)).toBe(1600);
    expect(Number(rows[0].total_credit_iqd)).toBe(1600);
    expect(rows[0].status).toBe('posted');
  });

  it('makes the inventory valuation equal the posted debit', async () => {
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('100'),
        uomCode: 'EA',
        unitCostIqd: cost('10'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-OPEN',
      },
    ]);
    await withScope(scope(manager), (tx) =>
      opening.approve(tx, manager, id, {
        post: true,
        dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' },
      }),
    );

    const valuation = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, ITEM, STORES),
    );
    expect(toDecimalString(valuation, 4n)).toBe('1000.0000');
  });

  it('writes no stock at all when the posting fails', async () => {
    // §24's atomicity, applied to a document: stock the ledger does not know
    // about is the discrepancy §9.9 exists to prevent.
    await ownerPool.query(`delete from posting_rule where line_role = 'opening_balance'`);

    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('100'),
        uomCode: 'EA',
        unitCostIqd: cost('10'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-OPEN',
      },
    ]);

    await rejection(
      withScope(scope(manager), (tx) =>
        opening.approve(tx, manager, id, {
          post: true,
          dimensions: { department: 'FIN', business_line: 'PRODUCT_SALES' },
        }),
      ),
    );

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, ITEM, STORES, BAGHDAD),
    );
    expect(formatQuantity(position.onHand)).toBe('0');
  });
});

describe('04.3 gate · a serial is traceable end to end', () => {
  it('follows one unit from opening stock through transfer, damage and write-off', async () => {
    // The gate asks for receipt → transfer → delivery → return → write-off. The
    // path below covers every stage the module can produce today, and each is a
    // movement carrying the serial, so the trail is one query.
    const id = await submitted([
      {
        itemCode: TRACKED,
        quantity: qty('1'),
        uomCode: 'EA',
        unitCostIqd: cost('500'),
        costLayerDate: '2025-10-01',
        serialNumber: 'SN-TRACE',
        manufacturedOn: '2025-09-01',
        warrantyMonths: 24,
      },
    ]);
    await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));

    // Transferred to the second warehouse.
    const { id: transferId } = await withScope(scope(officer), (tx) =>
      transfers.request(tx, officer, {
        sourceWarehouseCode: STORES,
        destinationWarehouseCode: SECOND,
        branchCode: BAGHDAD,
        requestedOn: '2026-02-01',
        lines: [{ itemCode: TRACKED, quantity: qty('1'), serialNumber: 'SN-TRACE' }],
      }),
    );
    await withScope(scope(manager), (tx) => transfers.approve(tx, manager, transferId));
    await withScope(scope(manager), (tx) =>
      transfers.issue(tx, manager, transferId, { issuedOn: '2026-02-05' }),
    );
    await withScope(scope(manager), (tx) =>
      transfers.receive(tx, manager, transferId, {
        receivedOn: '2026-02-08',
        quantities: { 1: qty('1') },
      }),
    );

    // Damaged, then written off.
    await withScope(scope(manager), (tx) =>
      states.approveDamage(tx, manager, {
        itemCode: TRACKED,
        fromWarehouseCode: SECOND,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        movementDate: '2026-03-01',
        reason: 'Dropped during handling.',
        serialNumber: 'SN-TRACE',
      }),
    );
    await withScope(scope(manager), (tx) =>
      states.writeOff(tx, manager, {
        itemCode: TRACKED,
        damagedWarehouseCode: DAMAGED,
        branchCode: BAGHDAD,
        quantity: qty('1'),
        movementDate: '2026-03-05',
        reason: 'Beyond economic repair.',
        serialNumber: 'SN-TRACE',
      }),
    );

    const trail = await withScope(scope(manager), (tx) =>
      inventory.traceIdentity(tx, TRACKED, { serialNumber: 'SN-TRACE' }),
    );

    expect(trail.map((m) => m.kind)).toEqual([
      'opening_stock',
      'transfer_issue',
      'transfer_receipt',
      'transfer_issue',
      'damage',
      'write_off',
    ]);

    // And it ends nowhere, because it was written off.
    const positions = await withScope(scope(manager), (tx) => inventory.positionsOf(tx, TRACKED));
    expect(positions.reduce((sum, p) => sum + p.onHand, 0n)).toBe(0n);
  });

  it('keeps the manufacture and expiry data with the movement', async () => {
    // 04.3's gate: "Expiry dates are captured and reportable where configured."
    const id = await submitted([
      {
        itemCode: ITEM,
        quantity: qty('20'),
        uomCode: 'EA',
        unitCostIqd: cost('10'),
        costLayerDate: '2025-11-01',
        batchNumber: 'B-EXP',
        manufacturedOn: '2025-10-15',
        expiryDate: '2027-10-15',
      },
    ]);
    await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));

    const { rows } = await ownerPool.query(
      `select manufactured_on, expiry_date from inventory_movement
        where item_code = $1 and batch_number = 'B-EXP'`,
      [ITEM],
    );

    expect(rows[0].manufactured_on).toBe('2025-10-15');
    expect(rows[0].expiry_date).toBe('2027-10-15');
  });

  it('reports what is expiring, by batch', async () => {
    for (const [batch, expiry] of [
      ['B-SOON', '2026-04-01'],
      ['B-LATER', '2027-12-31'],
    ] as const) {
      const id = await submitted([
        {
          itemCode: ITEM,
          quantity: qty('10'),
          uomCode: 'EA',
          unitCostIqd: cost('10'),
          costLayerDate: '2025-11-01',
          batchNumber: batch,
          expiryDate: expiry,
        },
      ]);
      await withScope(scope(manager), (tx) => opening.approve(tx, manager, id));
    }

    const { rows } = await ownerPool.query(
      `select batch_number, expiry_date from inventory_movement
        where expiry_date is not null and expiry_date <= '2026-06-30'
        order by expiry_date`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].batch_number).toBe('B-SOON');
  });
});
