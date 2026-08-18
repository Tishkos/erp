/**
 * Phase 06.1, 06.2 and 06.3 test gates — pricing control, the Sales Order with
 * automatic reservation, and credit control. §7.2, §7.3, §7.4, §7.7, §16.
 *
 * 06.1
 *   - The unit price field is not editable in the Sales Order
 *   - A price override submitted via the API is rejected, not silently accepted
 *   - A price override submitted via import is rejected
 *   - A header-level discount is impossible; only line-level discount exists
 *   - Price resolves by the document date against the effective-dated price list
 *
 * 06.2
 *   - Approval with insufficient Available Stock is rejected — no partial reservation
 *   - Approval reserves exactly the ordered quantity and Available drops by it
 *   - One order spanning three branches and warehouses reserves correctly in each
 *   - A Sales Manager's order finalises without a second approval; an ordinary
 *     user's order does not
 *   - A service line cannot be added to a product Sales Order
 *   - Cancelling an order releases the reservation in full
 *
 * 06.3
 *   - Exposure recomputes immediately — no batch lag
 *   - Exceeding the credit limit blocks approval for a non-manager
 *   - The override requires reason, amount, expiry and approver, all stored
 *   - An expired override no longer permits approval
 *   - A credit hold immediately affects order confirmation
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as so from '@/server/services/sales-order';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';
const BASRA = 'BSR';
const CABLE = 'ITM-CABLE';
const SERVICE = 'ITM-INSTALL';
const LIST = 'PL-RETAIL';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let salesUser: ActorContext;
let salesManager: ActorContext;
let customerId: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  for (const branchCode of [BAGHDAD, ERBIL, BASRA]) {
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

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

/** Puts stock on a shelf, so an order has something to reserve. */
async function stock(warehouseCode: string, branchCode: string, quantity: bigint, batch: string) {
  await withScope({ userId: salesManager.principal.userId, branchCode }, (tx) =>
    inventory.receive(
      tx,
      { principal: salesManager.principal, branchCode },
      {
        itemCode: CABLE,
        warehouseCode,
        branchCode,
        quantity,
        unitCostIqd: price('6'),
        movementDate: '2026-02-01',
        kind: 'opening_stock',
        batchNumber: batch,
      },
    ),
  );
}

beforeEach(async () => {
  await resetTestData();
  for (const [code, name] of [
    [BAGHDAD, 'Baghdad'],
    [ERBIL, 'Erbil'],
    [BASRA, 'Basra'],
  ] as const) {
    await seedBranch(code, name);
  }

  for (const [code, name, isStock] of [
    [CABLE, 'Network Cable 2m', true],
    [SERVICE, 'Cable Installation', false],
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

  salesUser = await createUser('accounting_officer');
  salesManager = await createUser('accounting_manager');

  // §7.3 — the customer's designated price list, effective-dated.
  await ownerPool.query(
    `insert into price_list (code, name, currency, active) values ($1,'Retail','IQD',true)`,
    [LIST],
  );
  const { rows: items } = await ownerPool.query(`select id, code from item`);
  const cableId = items.find((r) => r.code === CABLE)!.id;
  const serviceId = items.find((r) => r.code === SERVICE)!.id;

  await ownerPool.query(
    `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
     values ($1,$2,'EA',10.0000,'2026-01-01'),
            ($1,$2,'EA',12.0000,'2026-03-01'),
            ($1,$3,'EA',500.0000,'2026-01-01')`,
    [LIST, cableId, serviceId],
  );

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner
       (code, legal_name, is_customer, status, active, price_list_code, credit_limit_iqd)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true, $1, 1000000.0000)
     returning id`,
    [LIST],
  );
  customerId = partner[0].id;

  await stock(`WH-${BAGHDAD}`, BAGHDAD, qty('500'), 'B-BGW');
});

const line = (overrides: Partial<so.SalesLineInput> = {}): so.SalesLineInput => ({
  itemCode: CABLE,
  quantity: qty('100'),
  uomCode: 'EA',
  warehouseCode: `WH-${BAGHDAD}`,
  branchCode: BAGHDAD,
  ...overrides,
});

function createOrder(lines: so.SalesLineInput[] = [line()], orderDate = '2026-02-10') {
  return withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      orderDate,
      lines,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('06.1 gate · the price comes from the price list and cannot be edited', () => {
  it('has no unit-price field to submit — the rule is a property of the type', async () => {
    const order = await createOrder();

    const { rows } = await ownerPool.query(
      `select unit_price, price_list_item_id from sales_order_line where sales_order_id = $1`,
      [order.id],
    );
    // §7.3 — resolved from the list, and the row it came from is recorded so the
    // quote can be traced.
    expect(Number(rows[0].unit_price)).toBe(10);
    expect(rows[0].price_list_item_id).not.toBeNull();
  });

  it('rejects a price written straight to the table — the API route (§7.7)', async () => {
    const order = await createOrder();

    // Whatever route wrote it: an API that invented a price, an import that
    // carried one, a hand-written UPDATE. All end at the same trigger.
    expect(
      await rejection(
        ownerPool.query(`update sales_order_line set unit_price = 1 where sales_order_id = $1`, [
          order.id,
        ]),
      ),
    ).toMatch(/cannot be edited in the Sales Order|what was sold cannot be changed/);
  });

  it('rejects a line inserted with a price that is not the list price', async () => {
    const order = await createOrder();
    const { rows: listItem } = await ownerPool.query(
      `select id from price_list_item where unit_price = 10.0000 limit 1`,
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into sales_order_line
             (sales_order_id, line_no, item_code, description, quantity, uom_code, unit_price,
              price_list_item_id, gross_iqd, net_iqd, branch_code, warehouse_code)
           values ($1, 9, $2, 'Smuggled', 1, 'EA', 3.0000, $3, 3, 3, $4, $5)`,
          [order.id, CABLE, listItem[0].id, BAGHDAD, `WH-${BAGHDAD}`],
        ),
      ),
    ).toMatch(/price list PL-RETAIL says 10/);
  });

  it('rejects a line with no price-list row behind it at all', async () => {
    const order = await createOrder();

    expect(
      await rejection(
        ownerPool.query(
          `insert into sales_order_line
             (sales_order_id, line_no, item_code, description, quantity, uom_code, unit_price,
              gross_iqd, net_iqd, branch_code, warehouse_code)
           values ($1, 9, $2, 'No list', 1, 'EA', 10.0000, 10, 10, $3, $4)`,
          [order.id, CABLE, BAGHDAD, `WH-${BAGHDAD}`],
        ),
      ),
    ).toMatch(/names no price-list row/);
  });

  it('resolves the price by the order date against the effective-dated list', async () => {
    // Two prices: 10 from January, 12 from March.
    const february = await createOrder([line()], '2026-02-10');
    const march = await createOrder([line()], '2026-03-10');

    const { rows } = await ownerPool.query(
      `select o.order_date, l.unit_price
         from sales_order_line l join sales_order o on o.id = l.sales_order_id
        order by o.order_date`,
    );
    expect(Number(rows[0].unit_price)).toBe(10);
    expect(Number(rows[1].unit_price)).toBe(12);
    void february;
    void march;
  });

  it('refuses a customer with no price list', async () => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, status, active)
       values ('CUST-NOLIST','No List Ltd', true, 'active', true) returning id`,
    );

    const error = await rejection(
      withScope(scope(salesUser), (tx) =>
        so.create(tx, salesUser, {
          customerId: rows[0].id,
          branchCode: BAGHDAD,
          orderDate: '2026-02-10',
          lines: [line()],
        }),
      ),
    );
    expect(error).toMatch(/has no price list/);
    expect(error).toMatch(/a price typed on the order is exactly what/);
  });

  it('refuses an item with no price on the list for that date', async () => {
    const error = await rejection(createOrder([line()], '2025-12-01'));
    expect(error).toMatch(/No price is effective/);
  });
});

// ---------------------------------------------------------------------------

describe('06.1 gate · discount is line-level only', () => {
  it('has no header discount column to set', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'sales_order' and column_name like '%discount%'`,
    );
    // `discount_iqd` is the *total* of the line discounts, not a discount that
    // can be entered. There is no percent or amount field on the header.
    expect(rows.map((r) => r.column_name).sort()).toEqual(['discount_iqd']);
  });

  it('applies a line percentage', async () => {
    const order = await createOrder([line({ discount: { percent: price('10') } })]);
    expect(order.netIqd).toBe(price('900'));
  });

  it('applies a line amount', async () => {
    const order = await createOrder([line({ discount: { amountIqd: price('150') } })]);
    expect(order.netIqd).toBe(price('850'));
  });

  it('refuses a percentage and an amount together', async () => {
    const error = await rejection(
      createOrder([line({ discount: { percent: price('10'), amountIqd: price('50') } })]),
    );
    expect(error).toMatch(/the order of application undecided/);
  });

  it('refuses both forms at the database too', async () => {
    const order = await createOrder();
    expect(
      await rejection(
        ownerPool.query(
          `update sales_order_line set discount_percent = 10, discount_amount_iqd = 50
            where sales_order_id = $1`,
          [order.id],
        ),
      ),
    ).toMatch(/sales_order_line_one_discount_form|what was sold cannot be changed/);
  });

  it('keeps the document total equal to the sum of its lines', async () => {
    const order = await createOrder([
      line({ quantity: qty('100'), discount: { percent: price('10') } }),
      line({ quantity: qty('50') }),
    ]);

    const { rows } = await ownerPool.query(
      `select gross_iqd, discount_iqd, net_iqd from sales_order where id = $1`,
      [order.id],
    );
    expect(Number(rows[0].gross_iqd)).toBe(1500);
    expect(Number(rows[0].discount_iqd)).toBe(100);
    expect(Number(rows[0].net_iqd)).toBe(1400);
  });
});

// ---------------------------------------------------------------------------

describe('06.2 gate · a product order carries products only (§7.2)', () => {
  it('refuses a service line', async () => {
    const error = await rejection(createOrder([line({ itemCode: SERVICE })]));
    expect(error).toMatch(/is a service, and the product-sale process carries product items only/);
  });

  it('refuses a service line at the database too', async () => {
    const order = await createOrder();
    const { rows: listItem } = await ownerPool.query(
      `select id from price_list_item where unit_price = 500.0000 limit 1`,
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into sales_order_line
             (sales_order_id, line_no, item_code, description, quantity, uom_code, unit_price,
              price_list_item_id, gross_iqd, net_iqd, branch_code, warehouse_code)
           values ($1, 9, $2, 'Installation', 1, 'EA', 500.0000, $3, 500, 500, $4, $5)`,
          [order.id, SERVICE, listItem[0].id, BAGHDAD, `WH-${BAGHDAD}`],
        ),
      ),
    ).toMatch(/carries product items only/);
  });

  it('has no line-type column to choose a service in', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'sales_order_line' and column_name = 'line_type'`,
    );
    expect(rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('06.2 gate · approval reserves the stock (§7.4)', () => {
  it('reserves exactly the ordered quantity, and Available drops by it', async () => {
    const before = await withScope(scope(salesManager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );

    const order = await createOrder();
    const result = await withScope(scope(salesManager), (tx) =>
      so.approve(tx, salesManager, order.id),
    );

    const after = await withScope(scope(salesManager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );

    expect(result.reservations).toHaveLength(1);
    expect(after.reserved - before.reserved).toBe(qty('100'));
    expect(availableQuantity(before) - availableQuantity(after)).toBe(qty('100'));
    // The stock has not moved — a reservation is a promise, not a movement.
    expect(after.onHand).toBe(before.onHand);
  });

  it('refuses approval when Available is insufficient — and reserves nothing', async () => {
    // 500 on the shelf; this order wants 600.
    const order = await createOrder([line({ quantity: qty('600') })]);

    const error = await rejection(
      withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id)),
    );
    expect(error).toMatch(/has 500 of ITM-CABLE available and this order needs 600/);
    expect(error).toMatch(/promise the same goods twice/);

    const after = await withScope(scope(salesManager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(after.reserved).toBe(0n);
  });

  it('reserves nothing when one line of several does not fit', async () => {
    const order = await createOrder([
      line({ quantity: qty('300') }),
      line({ quantity: qty('300') }),
    ]);

    // Each line fits on its own; together they do not. §24 — the document is the
    // unit, so a partial reservation must not survive.
    await rejection(withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id)));

    const after = await withScope(scope(salesManager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(after.reserved).toBe(0n);
  });

  it('counts stock already reserved by another order', async () => {
    const first = await createOrder([line({ quantity: qty('400') })]);
    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, first.id));

    const second = await createOrder([line({ quantity: qty('200') })]);
    const error = await rejection(
      withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, second.id)),
    );
    // 500 on hand, 400 promised: 100 available.
    expect(error).toMatch(/has 100 of ITM-CABLE available/);
  });

  it('reserves across three branches and warehouses on one order (§7.2)', async () => {
    await stock(`WH-${ERBIL}`, ERBIL, qty('200'), 'B-EBL');
    await stock(`WH-${BASRA}`, BASRA, qty('200'), 'B-BSR');

    const order = await createOrder([
      line({ quantity: qty('100'), warehouseCode: `WH-${BAGHDAD}`, branchCode: BAGHDAD }),
      line({ quantity: qty('80'), warehouseCode: `WH-${ERBIL}`, branchCode: ERBIL }),
      line({ quantity: qty('60'), warehouseCode: `WH-${BASRA}`, branchCode: BASRA }),
    ]);

    const result = await withScope(scope(salesManager), (tx) =>
      so.approve(tx, salesManager, order.id),
    );
    expect(result.reservations).toHaveLength(3);

    for (const [warehouse, branch, expected] of [
      [`WH-${BAGHDAD}`, BAGHDAD, qty('100')],
      [`WH-${ERBIL}`, ERBIL, qty('80')],
      [`WH-${BASRA}`, BASRA, qty('60')],
    ] as const) {
      const position = await withScope({ userId: salesManager.principal.userId, branchCode: branch }, (tx) =>
        inventory.positionOf(tx, CABLE, warehouse, branch),
      );
      expect(position.reserved).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------

describe('06.2 gate · the approval route (§7.3)', () => {
  it('leaves an ordinary user’s order awaiting approval', async () => {
    const order = await createOrder();
    const result = await withScope(scope(salesUser), (tx) => so.submit(tx, salesUser, order.id));

    expect(result.awaitingApproval).toBe(true);
    expect(so.finalisesDirectly(salesUser.principal)).toBe(false);
  });

  it('lets a manager’s order finalise directly', async () => {
    expect(so.finalisesDirectly(salesManager.principal)).toBe(true);

    const order = await withScope(scope(salesManager), (tx) =>
      so.create(tx, salesManager, {
        customerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-10',
        lines: [line()],
      }),
    );

    // Their own order, approved by themselves — which §7.3 allows in terms.
    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id));

    const { rows } = await ownerPool.query(`select status from sales_order where id = $1`, [
      order.id,
    ]);
    expect(rows[0].status).toBe('approved');
  });

  it('refuses an ordinary user approving anything at all', async () => {
    const order = await createOrder();
    const error = await rejection(
      withScope(scope(salesUser), (tx) => so.approve(tx, salesUser, order.id)),
    );
    expect(error).toMatch(/Permission denied: 'approve' on 'sales_order'/);
  });
});

// ---------------------------------------------------------------------------

describe('06.2 gate · cancelling releases the reservation in full', () => {
  it('gives every reserved unit back', async () => {
    const order = await createOrder();
    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id));

    const result = await withScope(scope(salesManager), (tx) =>
      so.cancel(tx, salesManager, order.id, 'Customer withdrew the order.'),
    );

    expect(result.released).toBe(1);
    const after = await withScope(scope(salesManager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    // Releasing part of it would leave goods committed to nothing, and the next
    // order refused for stock that is sitting there.
    expect(after.reserved).toBe(0n);
    expect(availableQuantity(after)).toBe(qty('500'));
  });

  it('releases every line of a multi-warehouse order', async () => {
    await stock(`WH-${ERBIL}`, ERBIL, qty('200'), 'B-EBL2');

    const order = await createOrder([
      line({ quantity: qty('100') }),
      line({ quantity: qty('80'), warehouseCode: `WH-${ERBIL}`, branchCode: ERBIL }),
    ]);
    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id));

    const result = await withScope(scope(salesManager), (tx) =>
      so.cancel(tx, salesManager, order.id, 'Customer withdrew.'),
    );
    expect(result.released).toBe(2);
  });

  it('needs a reason', async () => {
    const order = await createOrder();
    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id));

    const error = await rejection(
      withScope(scope(salesManager), (tx) => so.cancel(tx, salesManager, order.id, '  ')),
    );
    expect(error).toMatch(/state why/);
  });

  it('cancels a draft that reserved nothing', async () => {
    const order = await createOrder();
    const result = await withScope(scope(salesManager), (tx) =>
      so.cancel(tx, salesManager, order.id, 'Raised in error.'),
    );
    expect(result.released).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('06.3 gate · credit control (§7.3, §16)', () => {
  async function setLimit(limitIqd: string) {
    await ownerPool.query(`update business_partner set credit_limit_iqd = $1 where id = $2`, [
      limitIqd,
      customerId,
    ]);
  }

  it('recomputes exposure the moment an order is approved — no batch lag', async () => {
    const before = await withScope(scope(salesManager), (tx) =>
      so.creditPositionFor(tx, customerId, '2026-02-10'),
    );
    expect(before.exposureIqd).toBe(0n);

    const order = await createOrder();
    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id));

    const after = await withScope(scope(salesManager), (tx) =>
      so.creditPositionFor(tx, customerId, '2026-02-10'),
    );
    // Read from the documents, so there is no cache to refresh and no window in
    // which the two disagree.
    expect(after.components.openOrdersIqd).toBe(price('1000'));
    expect(after.exposureIqd).toBe(price('1000'));
  });

  it('blocks approval when the order would cross the limit', async () => {
    await setLimit('500.0000');
    const order = await createOrder();

    const error = await rejection(
      withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id)),
    );
    expect(error).toMatch(/500 of credit available and this order needs 1000/);
    expect(error).toMatch(/Sales Manager can raise the limit/);
  });

  it('reserves nothing when credit blocks the approval', async () => {
    await setLimit('500.0000');
    const order = await createOrder();
    await rejection(withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id)));

    const after = await withScope(scope(salesManager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    expect(after.reserved).toBe(0n);
  });

  it('lets a manager override, and stores all four things §16 asks for', async () => {
    await setLimit('500.0000');
    const order = await createOrder();

    await withScope(scope(salesManager), (tx) =>
      so.approve(tx, salesManager, order.id, {
        creditOverride: {
          amountIqd: price('1000'),
          expiresOn: '2026-06-30',
          approvedByUserId: salesManager.principal.userId,
          reason: 'Ramadan stock build; paid on time for two years.',
        },
      }),
    );

    const { rows } = await ownerPool.query(
      `select credit_override_by, credit_override_at, credit_override_reason,
              credit_override_amount_iqd, credit_override_expires_on, status
         from sales_order where id = $1`,
      [order.id],
    );
    expect(rows[0].status).toBe('approved');
    expect(rows[0].credit_override_by).toBe(salesManager.principal.userId);
    expect(rows[0].credit_override_at).not.toBeNull();
    expect(rows[0].credit_override_reason).toMatch(/Ramadan/);
    expect(Number(rows[0].credit_override_amount_iqd)).toBe(1000);
    expect(rows[0].credit_override_expires_on).toBe('2026-06-30');
  });

  it('refuses an override missing any of the four', async () => {
    await setLimit('500.0000');
    const order = await createOrder();

    const complete = {
      amountIqd: price('1000'),
      expiresOn: '2026-06-30',
      approvedByUserId: salesManager.principal.userId,
      reason: 'A reason',
    };

    for (const [broken, expected] of [
      [{ ...complete, amountIqd: 0n }, /an override of nothing raises nothing/],
      [
        { ...complete, expiresOn: 'never' },
        /a permanent override is the credit limit being changed/,
      ],
      [{ ...complete, approvedByUserId: '' }, /a named approver/],
      [{ ...complete, reason: '   ' }, /the blueprint calls it mandatory/],
    ] as const) {
      const error = await rejection(
        withScope(scope(salesManager), (tx) =>
          so.approve(tx, salesManager, order.id, { creditOverride: broken }),
        ),
      );
      expect(error).toMatch(expected);
    }
  });

  it('refuses an override that has already expired', async () => {
    await setLimit('500.0000');
    const order = await createOrder();

    const error = await rejection(
      withScope(scope(salesManager), (tx) =>
        so.approve(tx, salesManager, order.id, {
          creditOverride: {
            amountIqd: price('1000'),
            expiresOn: '2026-01-31',
            approvedByUserId: salesManager.principal.userId,
            reason: 'Expired last month.',
          },
        }),
      ),
    );
    // Ordered on 10 February; the override ran out on 31 January.
    expect(error).toMatch(/500 of credit available/);
  });

  it('refuses a partial override record at the database', async () => {
    const order = await createOrder();
    expect(
      await rejection(
        ownerPool.query(
          `update sales_order set credit_override_by = $1, credit_override_at = now()
            where id = $2`,
          [salesManager.principal.userId, order.id],
        ),
      ),
    ).toMatch(/sales_order_credit_override_complete/);
  });
});

// ---------------------------------------------------------------------------

describe('06.3 gate · a credit hold takes effect immediately (§16 criterion 3)', () => {
  async function hold() {
    await ownerPool.query(
      `update business_partner
          set on_credit_hold = true, credit_hold_reason = 'Two invoices 90 days overdue.',
              credit_hold_by = $1, credit_hold_at = now()
        where id = $2`,
      [salesManager.principal.userId, customerId],
    );
  }

  it('blocks approval, whatever the limit says', async () => {
    await hold();
    const order = await createOrder();

    const error = await rejection(
      withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id)),
    );
    expect(error).toMatch(/CUST-001 is on credit hold/);
  });

  it('is not lifted by an override', async () => {
    await hold();
    const order = await createOrder();

    const error = await rejection(
      withScope(scope(salesManager), (tx) =>
        so.approve(tx, salesManager, order.id, {
          creditOverride: {
            amountIqd: price('100000'),
            expiresOn: '2026-12-31',
            approvedByUserId: salesManager.principal.userId,
            reason: 'Trying to get round the hold.',
          },
        }),
      ),
    );
    expect(error).toMatch(/A credit-limit override does not lift a hold/);
    expect(error).toMatch(/A cash sale is a different document/);
  });

  it('blocks at the database too — "immediately" leaves no window', async () => {
    await hold();
    const order = await createOrder();

    // A service that read the flag and then approved could have the hold applied
    // in between. The trigger closes that window.
    expect(
      await rejection(
        ownerPool.query(`update sales_order set status = 'approved' where id = $1`, [order.id]),
      ),
    ).toMatch(/is on credit hold/);
  });

  it('refuses a hold with no reason', async () => {
    expect(
      await rejection(
        ownerPool.query(`update business_partner set on_credit_hold = true where id = $1`, [
          customerId,
        ]),
      ),
    ).toMatch(/business_partner_credit_hold_has_reason/);
  });

  it('lets the order through once the hold is lifted', async () => {
    await hold();
    const order = await createOrder();
    await rejection(withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id)));

    await ownerPool.query(
      `update business_partner set on_credit_hold = false, credit_hold_reason = null,
              credit_hold_by = null, credit_hold_at = null
        where id = $1`,
      [customerId],
    );

    await withScope(scope(salesManager), (tx) => so.approve(tx, salesManager, order.id));
    const { rows } = await ownerPool.query(`select status from sales_order where id = $1`, [
      order.id,
    ]);
    expect(rows[0].status).toBe('approved');
  });
});
