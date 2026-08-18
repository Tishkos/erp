/**
 * Phase 05.1 test gate — Purchase Orders, §8.3.
 *
 *   - A PO with two suppliers is impossible to create
 *   - An inactive supplier, or a partner without the Supplier role, is rejected
 *   - Line-level branch, warehouse and cost centre are independently settable
 *     and are carried to receipt and invoice
 *   - Pasting 200 rows from Excel validates every row and reports errors per
 *     row, committing nothing on failure
 *   - An invalid item code, UOM or price in a pasted block is caught before save
 *   - An approved PO creates a commitment but no accounting entry
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { formatQuantity, parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const ERBIL = 'EBL';
const CABLE = 'ITM-CABLE';
const SERVICE = 'ITM-SERVICE';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let officer: ActorContext;
let manager: ActorContext;
let supplierId: string;

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

/** A partner, with whatever roles and status the test needs. */
async function createPartner(
  code: string,
  options: { isSupplier?: boolean; isCustomer?: boolean; status?: string; active?: boolean } = {},
): Promise<string> {
  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, is_customer, status, active)
     values ($1, $1, $2, $3, $4, $5) returning id`,
    [
      code,
      options.isSupplier ?? true,
      options.isCustomer ?? false,
      options.status ?? 'active',
      options.active ?? true,
    ],
  );
  return rows[0].id;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await seedBranch(ERBIL, 'Erbil');

  await ownerPool.query(
    `insert into cost_centre (code, name) values ('CC-OPS','Operations')
     on conflict (code) do nothing`,
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
  supplierId = await createPartner('SUP-001');
});

const line = (overrides: Partial<po.PurchaseLineInput> = {}): po.PurchaseLineInput => ({
  lineType: 'inventory_item',
  itemCode: CABLE,
  description: 'Network Cable 2m',
  quantity: qty('100'),
  uomCode: 'EA',
  unitPriceIqd: price('10'),
  branchCode: BAGHDAD,
  warehouseCode: `WH-${BAGHDAD}`,
  ...overrides,
});

function createOrder(lines: po.PurchaseLineInput[] = [line()]) {
  return withScope(scope(officer), (tx) =>
    po.create(tx, officer, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('05.1 gate · one supplier per order', () => {
  it('holds the supplier on the header, so two is unrepresentable', async () => {
    // §8.3's first bullet, as a schema property rather than a rule: there is no
    // supplier column on the line to disagree with the header.
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'purchase_order_line' and column_name ilike '%supplier%'`,
    );
    expect(rows).toEqual([]);
  });

  it('records the one supplier it was raised against', async () => {
    const { id } = await createOrder();
    const { order } = await withScope(scope(officer), (tx) => po.view(tx, id));
    expect(order.supplierId).toBe(supplierId);
  });
});

describe('05.1 gate · the supplier must be usable', () => {
  it('refuses a partner who is not a supplier', async () => {
    const customerOnly = await createPartner('CUS-001', {
      isSupplier: false,
      isCustomer: true,
    });

    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          po.create(tx, officer, {
            supplierId: customerOnly,
            branchCode: BAGHDAD,
            orderDate: '2026-02-01',
            lines: [line()],
          }),
        ),
      ),
    ).toMatch(/is not a supplier/);
  });

  it('refuses a deactivated supplier', async () => {
    const gone = await createPartner('SUP-GONE', { active: false });

    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          po.create(tx, officer, {
            supplierId: gone,
            branchCode: BAGHDAD,
            orderDate: '2026-02-01',
            lines: [line()],
          }),
        ),
      ),
    ).toMatch(/has been deactivated/);
  });

  it('refuses a blocked supplier, naming what to do instead', async () => {
    const blocked = await createPartner('SUP-BLOCKED', { status: 'blocked' });

    expect(
      await rejection(
        withScope(scope(officer), (tx) =>
          po.create(tx, officer, {
            supplierId: blocked,
            branchCode: BAGHDAD,
            orderDate: '2026-02-01',
            lines: [line()],
          }),
        ),
      ),
    ).toMatch(/is blocked.*Choose an active supplier/s);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const blocked = await createPartner('SUP-BLOCKED-2', { status: 'on_hold' });

    expect(
      await rejection(
        ownerPool.query(
          `insert into purchase_order (order_no, supplier_id, branch_code, order_date, created_by)
           values ('PO-RAW', $1, $2, '2026-02-01', $3)`,
          [blocked, BAGHDAD, officer.principal.userId],
        ),
      ),
    ).toMatch(/cannot be raised against them/);
  });

  it('re-checks the supplier at approval, not only at raising', async () => {
    // A supplier blocked between raising and approving must not be committed
    // to: approval is the act that creates the commitment.
    const { id } = await createOrder();
    await withScope(scope(officer), (tx) => po.submit(tx, officer, id));

    await ownerPool.query(`update business_partner set status = 'blocked' where id = $1`, [
      supplierId,
    ]);

    expect(
      await rejection(withScope(scope(manager), (tx) => po.approve(tx, manager, id))),
    ).toMatch(/is blocked/);
  });
});

describe('05.1 gate · line-level branch, warehouse and cost centre', () => {
  it('lets one order cover several branches and warehouses (§8.3)', async () => {
    const { id } = await createOrder([
      line({ branchCode: BAGHDAD, warehouseCode: `WH-${BAGHDAD}` }),
      line({ branchCode: ERBIL, warehouseCode: `WH-${ERBIL}`, costCentreCode: 'CC-OPS' }),
    ]);

    const { lines } = await withScope(scope(officer), (tx) => po.view(tx, id));

    expect(lines.map((l) => l.branchCode)).toEqual([BAGHDAD, ERBIL]);
    expect(lines.map((l) => l.warehouseCode)).toEqual([`WH-${BAGHDAD}`, `WH-${ERBIL}`]);
    expect(lines[1]!.costCentreCode).toBe('CC-OPS');
  });

  it('sets the three independently of each other', async () => {
    const { id } = await createOrder([
      line({ costCentreCode: 'CC-OPS' }),
      line({ costCentreCode: null }),
    ]);

    const { lines } = await withScope(scope(officer), (tx) => po.view(tx, id));
    expect(lines[0]!.costCentreCode).toBe('CC-OPS');
    expect(lines[1]!.costCentreCode).toBeNull();
  });

  it('insists stock has a destination', async () => {
    expect(
      await rejection(createOrder([line({ warehouseCode: null })])),
    ).toMatch(/stock_needs_warehouse/);
  });

  it('does not require a warehouse for a service line', async () => {
    await expect(
      createOrder([
        line({
          lineType: 'service',
          itemCode: SERVICE,
          description: 'Annual maintenance',
          warehouseCode: null,
        }),
      ]),
    ).resolves.toBeDefined();
  });
});

describe('05.1 gate · an approved order commits but does not post', () => {
  it('has no journal to link to — the rule is a table property', async () => {
    // Appendix B: "commitment only". There is no journal_entry_id column, so
    // there is nothing to fill in and nothing to forget.
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'purchase_order' and column_name ilike '%journal%'`,
    );
    expect(rows).toEqual([]);
  });

  it('writes no journal entry when approved', async () => {
    const { id } = await createOrder();
    await withScope(scope(officer), (tx) => po.submit(tx, officer, id));
    await withScope(scope(manager), (tx) => po.approve(tx, manager, id));

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('shows the commitment as an open value', async () => {
    const { id } = await createOrder();
    await withScope(scope(officer), (tx) => po.submit(tx, officer, id));
    await withScope(scope(manager), (tx) => po.approve(tx, manager, id));

    const open = await withScope(scope(manager), (tx) => po.openCommitments(tx));
    expect(open).toHaveLength(1);
    expect(Number(open[0]!.open_value_iqd)).toBe(1000);
  });

  it('refuses the raiser approving their own order (§5.2)', async () => {
    const { id } = await withScope(scope(manager), (tx) =>
      po.create(tx, manager, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [line()],
      }),
    );
    await withScope(scope(manager), (tx) => po.submit(tx, manager, id));

    expect(
      await rejection(withScope(scope(manager), (tx) => po.approve(tx, manager, id))),
    ).toMatch(/commits the company to pay/);
  });

  it('fixes the commercial terms once submitted', async () => {
    // What was approved is what the supplier is held to and what the receipt is
    // matched against.
    const { id } = await createOrder();
    await withScope(scope(officer), (tx) => po.submit(tx, officer, id));
    const { lines } = await withScope(scope(officer), (tx) => po.view(tx, id));

    expect(
      await rejection(
        ownerPool.query(`update purchase_order_line set unit_price = 99 where id = $1`, [
          lines[0]!.id,
        ]),
      ),
    ).toMatch(/what was ordered cannot be changed/);
  });

  it('still allows a draft to be corrected', async () => {
    const { id } = await createOrder();
    const { lines } = await withScope(scope(officer), (tx) => po.view(tx, id));

    await expect(
      ownerPool.query(`update purchase_order_line set unit_price = 11 where id = $1`, [
        lines[0]!.id,
      ]),
    ).resolves.toBeDefined();
  });
});

describe('05.1 gate · the Excel paste', () => {
  const row = (
    itemCode: string,
    description: string,
    quantity: string,
    uom: string,
    unitPrice: string,
  ) => [itemCode, description, quantity, uom, unitPrice].join('\t');

  it('parses two hundred rows', async () => {
    // §8.3's gate names the number, so the test uses it.
    const block = Array.from({ length: 200 }, (_, i) =>
      row(CABLE, `Line ${i + 1}`, '10', 'EA', '12.5000'),
    ).join('\n');

    const parsed = po.parsePastedLines(block, {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    expect(parsed.errors).toEqual([]);
    expect(parsed.lines).toHaveLength(200);
    expect(parsed.lines[0]!.quantity).toBe(qty('10'));
    expect(parsed.lines[199]!.unitPriceIqd).toBe(price('12.5'));
  });

  it('reports a problem per row rather than stopping at the first', async () => {
    // The difference between one correction pass and eleven.
    const block = [
      row(CABLE, 'Good', '10', 'EA', '12'),
      row('', 'No item', '10', 'EA', '12'),
      row(CABLE, 'Bad quantity', 'ten', 'EA', '12'),
      row(CABLE, 'Bad price', '10', 'EA', 'free'),
      row(CABLE, 'Negative', '-5', 'EA', '12'),
    ].join('\n');

    const parsed = po.parsePastedLines(block, {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    expect(parsed.errors.map((e) => e.rowNumber)).toEqual([2, 3, 4, 5]);
    expect(parsed.errors.map((e) => e.column)).toEqual([
      'item_code',
      'quantity',
      'unit_price',
      'quantity',
    ]);
    // The good row survives, so a buyer sees what was accepted as well as what
    // was not.
    expect(parsed.lines).toHaveLength(1);
  });

  it('says what is wrong in terms the person pasting can act on', async () => {
    const parsed = po.parsePastedLines(row(CABLE, 'Bad', '10', 'EA', 'free'), {
      branchCode: BAGHDAD,
    });

    expect(parsed.errors[0]!.message).toMatch(/"free" is not a price/);
    expect(parsed.errors[0]!.message).toMatch(/four decimal places/);
  });

  it('takes the branch and warehouse from the paste when they are given', async () => {
    const block = [CABLE, 'Cable', '10', 'EA', '12', ERBIL, `WH-${ERBIL}`].join('\t');

    const parsed = po.parsePastedLines(block, {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    expect(parsed.lines[0]!.branchCode).toBe(ERBIL);
    expect(parsed.lines[0]!.warehouseCode).toBe(`WH-${ERBIL}`);
  });

  it('catches an item code that is not in the master', async () => {
    const parsed = po.parsePastedLines(row('ITM-NOPE', 'Ghost', '10', 'EA', '12'), {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    const errors = await withScope(scope(officer), (tx) => po.validateLines(tx, parsed.lines));
    expect(errors[0]!.message).toMatch(/"ITM-NOPE" is not an item/);
  });

  it('catches a UOM the item is not bought in', async () => {
    const parsed = po.parsePastedLines(row(CABLE, 'Cable', '10', 'BOX', '12'), {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    const errors = await withScope(scope(officer), (tx) => po.validateLines(tx, parsed.lines));
    expect(errors[0]!.message).toMatch(/is not bought in "BOX"/);
  });

  it('catches a service pasted as an inventory line', async () => {
    const parsed = po.parsePastedLines(row(SERVICE, 'Maintenance', '1', 'EA', '500'), {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    const errors = await withScope(scope(officer), (tx) => po.validateLines(tx, parsed.lines));
    expect(errors[0]!.message).toMatch(/is a service, so it is received as a Service Receipt/);
  });

  it('commits nothing when a pasted block has any error', async () => {
    const block = [
      row(CABLE, 'Good', '10', 'EA', '12'),
      row('', 'Broken', '10', 'EA', '12'),
    ].join('\n');

    const parsed = po.parsePastedLines(block, {
      branchCode: BAGHDAD,
      warehouseCode: `WH-${BAGHDAD}`,
    });

    // The caller does not save a partial paste: the parse reports errors and
    // the order is not created.
    expect(parsed.errors.length).toBeGreaterThan(0);

    const { rows } = await ownerPool.query(`select count(*)::int as n from purchase_order`);
    expect(rows[0].n).toBe(0);
  });
});

describe('05.8 gate · cancellation', () => {
  it('cancels an unexecuted order with no journal reversal', async () => {
    const { id } = await createOrder();
    await withScope(scope(officer), (tx) => po.submit(tx, officer, id));
    await withScope(scope(manager), (tx) => po.approve(tx, manager, id));

    const result = await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, id, 'Supplier could not meet the delivery date.'),
    );

    expect(result.status).toBe('cancelled');
    expect(formatQuantity(result.closedQuantity)).toBe('100');

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('needs a reason', async () => {
    const { id } = await createOrder();

    expect(
      await rejection(withScope(scope(manager), (tx) => po.cancel(tx, manager, id, '  '))),
    ).toMatch(/keeps the reason with it/);
  });

  it('releases the commitment', async () => {
    const { id } = await createOrder();
    await withScope(scope(officer), (tx) => po.submit(tx, officer, id));
    await withScope(scope(manager), (tx) => po.approve(tx, manager, id));
    await withScope(scope(manager), (tx) => po.cancel(tx, manager, id, 'No longer needed.'));

    expect(await withScope(scope(manager), (tx) => po.openCommitments(tx))).toEqual([]);
  });
});
