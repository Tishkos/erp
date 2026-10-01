/**
 * Phase 05.2 test gate — Goods Receipt, §8.4.
 *
 *   - Partial and multiple receipts against one PO line accumulate correctly
 *     and close the line at full receipt
 *   - Over-receipt beyond tolerance requires manager approval with a stored reason
 *   - Receipt into a different warehouse succeeds and the variance from the
 *     source line is visible
 *   - Goods Receipt creates a FIFO layer at the PO price (Phase 04.2)
 *   - The posting is Dr Inventory / Cr GRNI and is atomic with the stock movement
 *   - A receipt without a PO is impossible
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';
const CABLE = 'ITM-CABLE';
const SERVICE = 'ITM-SERVICE';
const QUARANTINE = 'WH-QUAR';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let officer: ActorContext;
let manager: ActorContext;
let supplierId: string;
let accounts: Record<string, string>;

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

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(ERBIL, 'Erbil');

  await ownerPool.query(
    `insert into cost_centre (code, name) values ('CC-OPS','Operations')
     on conflict (code) do nothing`,
  );

  // A quarantine warehouse — §8.4's "Received in Quarantine" is a place, not a
  // flag, and Phase 04 (§9.5, migration 0027) already keeps quarantine stock
  // out of Available on the strength of the warehouse type.
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type)
     values ($1, 'Baghdad Quarantine', $2, 'quarantine')
     on conflict (code) do nothing`,
    [QUARANTINE, BAGHDAD],
  );

  for (const [code, name, isStock] of [
    [CABLE, 'Network Cable 2m', true],
    [SERVICE, 'Annual Maintenance', false],
  ] as const) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking)
         values ($1,$2,$3,'EA',$4) returning id`,
        [code, name, isStock, isStock ? 'batch' : null],
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

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','SUP-001', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  // The fiscal calendar the posting lands in.
  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,1,'January 2026','2026-01-01','2026-01-31'),
            ($1,2,'February 2026','2026-02-01','2026-02-28')
     on conflict do nothing`,
    [years[0].id],
  );

  // §14.5 — the posting engine converts every line to IQD, so a rate must
  // exist even where nothing here is in USD.
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1)
     on conflict do nothing`,
    [manager.principal.userId],
  );

  // Appendix C — Dr Inventory / Cr GRNI. Mapped by role (§3.3), never by
  // account number.
  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
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
      [`${parent.slice(0, 1)}90000${role.length}`, name, parents[0].account_type, parents[0].id],
    );
    accounts[role] = rows[0].id;
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('inventory.goods_receipt', $1, $2, true, $3) on conflict do nothing`,
      [role, rows[0].id, manager.principal.userId],
    );
  }
});

/** An approved order, ready to receive against. */
async function approvedOrder(
  lines: po.PurchaseLineInput[] = [
    {
      lineType: 'inventory_item',
      itemCode: CABLE,
      description: 'Network Cable 2m',
      quantity: qty('100'),
      uomCode: 'EA',
      unitPriceIqd: price('10'),
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
      costCentreCode: 'CC-OPS',
    },
  ],
): Promise<{ id: string; orderNo: string; lineIds: string[] }> {
  const order = await withScope(scope(officer), (tx) =>
    po.create(tx, officer, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines,
    }),
  );
  await withScope(scope(officer), (tx) => po.submit(tx, officer, order.id));
  await withScope(scope(manager), (tx) => po.approve(tx, manager, order.id));

  const { rows } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1 order by line_no`,
    [order.id],
  );
  return { ...order, lineIds: rows.map((r) => r.id) };
}

/**
 * Raise, submit and post a receipt in one go.
 *
 * A batch number is supplied for every line unless the test names its own:
 * §9.3 makes the cable batch-tracked, and a delivery of a tracked item that
 * arrived without its batch is a different test from the ones here.
 */
let batchSeq = 0;
async function receive(
  orderId: string,
  lines: gr.ReceiptLineInput[],
  options: gr.PostOptions = {},
) {
  const identified = lines.map((l) => ({
    batchNumber: l.batchNumber ?? `B-${(batchSeq += 1)}`,
    ...l,
  }));

  const receipt = await withScope(scope(officer), (tx) =>
    gr.create(tx, officer, {
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: identified,
    }),
  );
  await withScope(scope(officer), (tx) => gr.submit(tx, officer, receipt.id));
  const posted = await withScope(scope(manager), (tx) =>
    gr.post(tx, manager, receipt.id, options),
  );
  return { ...receipt, ...posted };
}

// ---------------------------------------------------------------------------

describe('05.2 gate · a receipt without a purchase order is impossible', () => {
  it('has no nullable order to leave empty — the column is NOT NULL', async () => {
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'goods_receipt' and column_name = 'purchase_order_id'`,
    );
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('refuses a receipt against a draft order', async () => {
    const order = await withScope(scope(officer), (tx) =>
      po.create(tx, officer, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [
          {
            lineType: 'inventory_item',
            itemCode: CABLE,
            description: 'Cable',
            quantity: qty('10'),
            uomCode: 'EA',
            unitPriceIqd: price('10'),
            branchCode: BAGHDAD,
            warehouseCode: `WH-${BAGHDAD}`,
          },
        ],
      }),
    );
    const { rows } = await ownerPool.query(
      `select id from purchase_order_line where purchase_order_id = $1`,
      [order.id],
    );

    const error = await rejection(
      withScope(scope(officer), (tx) =>
        gr.create(tx, officer, {
          purchaseOrderId: order.id,
          branchCode: BAGHDAD,
          receiptDate: '2026-02-05',
          lines: [{ purchaseOrderLineId: rows[0].id, quantity: qty('10') }],
        }),
      ),
    );

    expect(error).toMatch(/is 'draft', so nothing can be received against it/);
    expect(error).toMatch(/An approved order is what authorises a receipt/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const order = await withScope(scope(officer), (tx) =>
      po.create(tx, officer, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [
          {
            lineType: 'inventory_item',
            itemCode: CABLE,
            description: 'Cable',
            quantity: qty('10'),
            uomCode: 'EA',
            unitPriceIqd: price('10'),
            branchCode: BAGHDAD,
            warehouseCode: `WH-${BAGHDAD}`,
          },
        ],
      }),
    );

    await expect(
      ownerPool.query(
        `insert into goods_receipt (receipt_no, purchase_order_id, branch_code, receipt_date, created_by)
         values ('GRN-SMUGGLED', $1, $2, '2026-02-05', $3)`,
        [order.id, BAGHDAD, officer.principal.userId],
      ),
    ).rejects.toThrow(/nothing can be received against it/);
  });

  it('refuses a line belonging to a different order', async () => {
    const first = await approvedOrder();
    const second = await approvedOrder();

    const error = await rejection(
      withScope(scope(officer), (tx) =>
        gr.create(tx, officer, {
          purchaseOrderId: first.id,
          branchCode: BAGHDAD,
          receiptDate: '2026-02-05',
          lines: [{ purchaseOrderLineId: second.lineIds[0]!, quantity: qty('10') }],
        }),
      ),
    );

    expect(error).toMatch(/does not belong to purchase order/);
  });
});

// ---------------------------------------------------------------------------

describe('05.2 gate · partial and multiple receipts accumulate', () => {
  it('adds each receipt to the ordered line', async () => {
    const order = await approvedOrder();

    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('30') }]);
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('45') }]);

    const open = await withScope(scope(officer), (tx) => gr.outstanding(tx, order.id));
    expect(open[0]!.received).toBe(qty('75'));
    expect(open[0]!.outstanding).toBe(qty('25'));
  });

  it('moves the order to Partially Received after the first delivery', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('30') },
    ]);

    expect(posted.orderStatus).toBe('partially_executed');
  });

  it('closes the line and the order at full receipt', async () => {
    const order = await approvedOrder();
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('60') }]);
    const final = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40') },
    ]);

    expect(final.orderStatus).toBe('executed');

    const open = await withScope(scope(officer), (tx) => gr.outstanding(tx, order.id));
    expect(open[0]!.outstanding).toBe(0n);
  });

  it('leaves an under-received order open — under-receipt is normal', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('99.5') },
    ]);

    expect(posted.orderStatus).toBe('partially_executed');
    const open = await withScope(scope(officer), (tx) => gr.outstanding(tx, order.id));
    expect(open[0]!.outstanding).toBe(qty('0.5'));
  });

  it('accumulates stock across the deliveries', async () => {
    const order = await approvedOrder();
    await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('30'), batchNumber: 'B-1' },
    ]);
    await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('45'), batchNumber: 'B-2' },
    ]);

    const position = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(position.onHand).toBe(qty('75'));
  });
});

// ---------------------------------------------------------------------------

describe('05.2 gate · over-receipt beyond tolerance needs a manager and a reason', () => {
  it('refuses the excess when the tolerance is the default zero', async () => {
    const order = await approvedOrder();

    const error = await rejection(
      receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('104') }]),
    );

    expect(error).toMatch(/beyond the 0.*% tolerance/);
    expect(error).toMatch(/A manager can accept the over-receipt/);
  });

  it('allows it silently within a configured tolerance', async () => {
    await withScope(scope(manager), (tx) =>
      gr.setTolerance(tx, manager, { percent: '5', note: 'Purchasing, February 2026' }),
    );

    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('104') },
    ]);

    expect(posted.movementIds).toHaveLength(1);

    const { rows } = await ownerPool.query(
      `select tolerance_override_by from goods_receipt where id = $1`,
      [posted.id],
    );
    // Within tolerance is not an override. Nobody was asked, so nobody is
    // recorded as having decided.
    expect(rows[0].tolerance_override_by).toBeNull();
  });

  it('takes an item tolerance over the company default', async () => {
    await withScope(scope(manager), (tx) =>
      gr.setTolerance(tx, manager, { percent: '0' }),
    );
    await withScope(scope(manager), (tx) =>
      gr.setTolerance(tx, manager, { itemCode: CABLE, percent: '10', note: 'Cable comes on reels' }),
    );

    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('108') },
    ]);

    expect(posted.movementIds).toHaveLength(1);
  });

  it('accepts the over-receipt when a manager gives a reason', async () => {
    const order = await approvedOrder();
    const posted = await receive(
      order.id,
      [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('104') }],
      { acceptOverReceipt: true, overReceiptReason: 'Supplier shipped a full reel; agreed by phone.' },
    );

    const { rows } = await ownerPool.query(
      `select tolerance_override_by, tolerance_override_at, tolerance_override_reason
         from goods_receipt where id = $1`,
      [posted.id],
    );
    expect(rows[0].tolerance_override_by).toBe(manager.principal.userId);
    expect(rows[0].tolerance_override_at).not.toBeNull();
    expect(rows[0].tolerance_override_reason).toMatch(/full reel/);
  });

  it('refuses an override with no reason', async () => {
    const order = await approvedOrder();

    const error = await rejection(
      receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('104') }], {
        acceptOverReceipt: true,
        overReceiptReason: '   ',
      }),
    );

    expect(error).toMatch(/Accepting an over-receipt needs a reason/);
  });

  it('refuses at the database an override recorded without a reason', async () => {
    const order = await approvedOrder();
    const receipt = await withScope(scope(officer), (tx) =>
      gr.create(tx, officer, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        lines: [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('10'), batchNumber: 'B-OV' }],
      }),
    );

    await expect(
      ownerPool.query(
        `update goods_receipt set tolerance_override_by = $1, tolerance_override_at = now()
          where id = $2`,
        [manager.principal.userId, receipt.id],
      ),
    ).rejects.toThrow(/goods_receipt_override_complete/);
  });

  it('judges the cumulative quantity, not the delivery in isolation', async () => {
    const order = await approvedOrder();
    // Three of forty against a hundred ordered: the third is the over-receipt,
    // and no single delivery looks like one.
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40') }]);
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40') }]);

    const error = await rejection(
      receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40') }]),
    );
    expect(error).toMatch(/beyond the/);
  });

  it('adds up two receipt lines against the same ordered line', async () => {
    const order = await approvedOrder();

    // Two batches on one delivery. Neither line exceeds the hundred ordered;
    // together they do, and neither has been written to the order yet — so a
    // check against the stored received quantity would let both through.
    const error = await rejection(
      receive(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('60'), batchNumber: 'B-A' },
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('60'), batchNumber: 'B-B' },
      ]),
    );

    expect(error).toMatch(/beyond the/);
  });

  it('accepts two lines against one ordered line when they fit', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('60'), batchNumber: 'B-A' },
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40'), batchNumber: 'B-B' },
    ]);

    expect(posted.movementIds).toHaveLength(2);
    expect(posted.orderStatus).toBe('executed');
  });

  it('moves no stock at all when one line of several is refused', async () => {
    const order = await approvedOrder([
      {
        lineType: 'inventory_item',
        itemCode: CABLE,
        description: 'Cable',
        quantity: qty('100'),
        uomCode: 'EA',
        unitPriceIqd: price('10'),
        branchCode: BAGHDAD,
        warehouseCode: `WH-${BAGHDAD}`,
      },
      {
        lineType: 'inventory_item',
        itemCode: CABLE,
        description: 'Cable, second line',
        quantity: qty('50'),
        uomCode: 'EA',
        unitPriceIqd: price('10'),
        branchCode: BAGHDAD,
        warehouseCode: `WH-${BAGHDAD}`,
      },
    ]);

    await rejection(
      receive(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') },
        { purchaseOrderLineId: order.lineIds[1]!, quantity: qty('60') },
      ]),
    );

    // §24 — the document is the unit of atomicity, not the line. The good line
    // must not have landed.
    const position = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(position.onHand).toBe(0n);
  });
});

// ---------------------------------------------------------------------------

describe('05.2 gate · receipt into a different warehouse', () => {
  it('succeeds, and puts the stock where it actually went', async () => {
    const order = await approvedOrder();
    await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), warehouseCode: QUARANTINE },
    ]);

    const ordered = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    const actual = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, CABLE, QUARANTINE, BAGHDAD),
    );

    expect(ordered.onHand).toBe(0n);
    expect(actual.onHand).toBe(qty('100'));
  });

  it('shows the variance from the source line', async () => {
    const order = await approvedOrder();
    await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), warehouseCode: QUARANTINE },
    ]);

    const variances = await withScope(scope(officer), (tx) =>
      gr.warehouseVariances(tx, order.id),
    );

    expect(variances).toHaveLength(1);
    expect(variances[0]!.orderedWarehouse).toBe(`WH-${BAGHDAD}`);
    expect(variances[0]!.receivedWarehouse).toBe(QUARANTINE);
  });

  it('reports no variance when the goods went where they were ordered', async () => {
    const order = await approvedOrder();
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') }]);

    const variances = await withScope(scope(officer), (tx) =>
      gr.warehouseVariances(tx, order.id),
    );
    expect(variances).toHaveLength(0);
  });

  it('leaves the ordered warehouse on the PO line untouched', async () => {
    const order = await approvedOrder();
    await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), warehouseCode: QUARANTINE },
    ]);

    const { rows } = await ownerPool.query(
      `select warehouse_code from purchase_order_line where id = $1`,
      [order.lineIds[0]],
    );
    // Overwriting it would erase the question the variance report exists to ask.
    expect(rows[0].warehouse_code).toBe(`WH-${BAGHDAD}`);
  });

  it('keeps quarantine stock out of Available while leaving it on hand (§8.4, §9.5)', async () => {
    const order = await approvedOrder();
    await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), warehouseCode: QUARANTINE },
    ]);

    const position = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, CABLE, QUARANTINE, BAGHDAD),
    );

    expect(position.onHand).toBe(qty('100'));
    expect(position.inQuarantine).toBe(qty('100'));
  });
});

// ---------------------------------------------------------------------------

describe('05.2 gate · the FIFO layer is created at the PO price', () => {
  it('values the layer at what was ordered, not at anything the receipt says', async () => {
    const order = await approvedOrder();
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') }]);

    const layers = await withScope(scope(officer), (tx) =>
      inventory.layersOf(tx, CABLE, `WH-${BAGHDAD}`),
    );

    expect(layers).toHaveLength(1);
    expect(layers[0]!.unitCostIqd).toBe(price('10'));
    expect(layers[0]!.remainingQuantity).toBe(qty('100'));
  });

  it('creates one layer per delivery, consumed oldest first', async () => {
    const order = await approvedOrder([
      {
        lineType: 'inventory_item',
        itemCode: CABLE,
        description: 'Cable',
        quantity: qty('100'),
        uomCode: 'EA',
        unitPriceIqd: price('10'),
        branchCode: BAGHDAD,
        warehouseCode: `WH-${BAGHDAD}`,
      },
    ]);

    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('40') }]);
    await receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('60') }]);

    const layers = await withScope(scope(officer), (tx) =>
      inventory.layersOf(tx, CABLE, `WH-${BAGHDAD}`),
    );
    expect(layers).toHaveLength(2);
    expect(layers[0]!.remainingQuantity).toBe(qty('40'));
  });

  it('carries the receipt as the movement source, so the layer can be traced back', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), batchNumber: 'B-1' },
    ]);

    const { rows } = await ownerPool.query(
      `select source_document_type, source_document_id, batch_number
         from inventory_movement where id = $1`,
      [posted.movementIds[0]],
    );
    expect(rows[0].source_document_type).toBe('goods_receipt');
    expect(rows[0].source_document_id).toBe(posted.id);
    expect(rows[0].batch_number).toBe('B-1');
  });
});

// ---------------------------------------------------------------------------

describe('05.2 gate · Dr Inventory / Cr GRNI, atomic with the movement', () => {
  it('posts the two sides at the FIFO cost of what arrived', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') },
    ]);

    const { rows: movement } = await ownerPool.query(
      `select journal_entry_id from inventory_movement where id = $1`,
      [posted.movementIds[0]],
    );
    expect(movement[0].journal_entry_id).not.toBeNull();

    const { rows: lines } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line
        where journal_entry_id = $1 order by debit_iqd desc`,
      [movement[0].journal_entry_id],
    );

    expect(lines).toHaveLength(2);
    expect(lines[0].account_id).toBe(accounts.inventory);
    expect(Number(lines[0].debit_iqd)).toBe(1000);
    expect(lines[1].account_id).toBe(accounts.grni);
    expect(Number(lines[1].credit_iqd)).toBe(1000);
  });

  it('leaves neither the movement nor the journal behind when posting fails', async () => {
    // No mapping, no posting, no receipt. The failure has to take the stock
    // movement with it — §24: all of it commits or none of it does.
    await ownerPool.query(`delete from posting_rule where line_role = 'grni'`);

    const order = await approvedOrder();
    await rejection(
      receive(order.id, [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') }]),
    );

    const position = await withScope(scope(officer), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(position.onHand).toBe(0n);

    const { rows } = await ownerPool.query(`select count(*)::int as n from inventory_movement`);
    expect(rows[0].n).toBe(0);
  });

  it('records the receipt against the branch it was received in (§14.3)', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') },
    ]);

    const { rows } = await ownerPool.query(
      `select je.branch_code from journal_entry je
         join inventory_movement m on m.journal_entry_id = je.id
        where m.id = $1`,
      [posted.movementIds[0]],
    );
    expect(rows[0].branch_code).toBe(BAGHDAD);
  });
});

// ---------------------------------------------------------------------------

describe('05.2 · what a receipt is not', () => {
  it('refuses to receive into another branch’s warehouse (§14.3)', async () => {
    const order = await approvedOrder();

    const error = await rejection(
      withScope(scope(officer), (tx) =>
        gr.create(tx, officer, {
          purchaseOrderId: order.id,
          branchCode: BAGHDAD,
          receiptDate: '2026-02-05',
          lines: [
            {
              purchaseOrderLineId: order.lineIds[0]!,
              quantity: qty('100'),
              warehouseCode: `WH-${ERBIL}`,
              batchNumber: 'B-X',
            },
          ],
        }),
      ),
    );

    // Otherwise the inventory account of the wrong branch carries the stock,
    // and the branch trial balances stop agreeing with the warehouses.
    expect(error).toMatch(/A receipt posts to one branch/);
  });

  it('refuses a tracked item with no batch, when the line is written (§9.3)', async () => {
    const order = await approvedOrder();

    const error = await rejection(
      withScope(scope(officer), (tx) =>
        gr.create(tx, officer, {
          purchaseOrderId: order.id,
          branchCode: BAGHDAD,
          receiptDate: '2026-02-05',
          // No batch number, on an item §9.3 tracks by batch.
          lines: [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') }],
        }),
      ),
    );

    // Caught as the line is entered, not when the receipt posts: by then the
    // whole delivery has been typed in and the message names a movement.
    expect(error).toMatch(/needs a batch number/);
  });

  it('refuses to receive a service line into a warehouse (§8.2)', async () => {
    const order = await approvedOrder([
      {
        lineType: 'service',
        itemCode: SERVICE,
        description: 'Annual Maintenance',
        quantity: qty('1'),
        uomCode: 'EA',
        unitPriceIqd: price('500'),
        branchCode: BAGHDAD,
        costCentreCode: 'CC-OPS',
      },
    ]);

    const error = await rejection(
      withScope(scope(officer), (tx) =>
        gr.create(tx, officer, {
          purchaseOrderId: order.id,
          branchCode: BAGHDAD,
          receiptDate: '2026-02-05',
          lines: [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('1') }],
        }),
      ),
    );

    expect(error).toMatch(/Only an inventory item is received into a warehouse/);
  });

  it('cannot be edited once posted — it is corrected by reversal (§3.2)', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') },
    ]);

    await expect(
      ownerPool.query(`update goods_receipt set receipt_date = '2026-02-06' where id = $1`, [
        posted.id,
      ]),
    ).rejects.toThrow(/Reverse it and receive again/);
  });

  it('cannot have its posted lines changed', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') },
    ]);

    await expect(
      ownerPool.query(`update goods_receipt_line set quantity = 500 where goods_receipt_id = $1`, [
        posted.id,
      ]),
    ).rejects.toThrow(/what arrived cannot be edited/);
  });

  it('is posted by someone with authority, not by whoever raised it', async () => {
    const order = await approvedOrder();
    const receipt = await withScope(scope(officer), (tx) =>
      gr.create(tx, officer, {
        purchaseOrderId: order.id,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-05',
        lines: [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100'), batchNumber: 'B-AUTH' }],
      }),
    );
    await withScope(scope(officer), (tx) => gr.submit(tx, officer, receipt.id));

    // The officer may raise and submit, but has no 'approve' on goods_receipt.
    const error = await rejection(
      withScope(scope(officer), (tx) => gr.post(tx, officer, receipt.id)),
    );
    expect(error).toMatch(/Permission denied: 'approve' on 'goods_receipt'/);
  });

  it('cannot be posted twice', async () => {
    const order = await approvedOrder();
    const posted = await receive(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('50') },
    ]);

    const error = await rejection(
      withScope(scope(manager), (tx) => gr.post(tx, manager, posted.id)),
    );
    expect(error).toMatch(/a receipt is posted from submitted/);
  });
});
