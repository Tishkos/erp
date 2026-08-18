/**
 * Phase 05.3 test gate — Service Receipt / Expense Confirmation, §8.6.
 *
 *   - Only the benefiting department can confirm the service
 *   - Confirmation is required before the A/P Invoice for a service line
 *   - No inventory movement is created for a service line
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as sr from '@/server/services/service-receipt';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const SERVICE = 'ITM-SERVICE';
/** The department that commissions the work — §8.6's benefiting department. */
const OPERATIONS = 'OPS';
/** A department that did not, and therefore cannot confirm it. */
const FINANCE = 'FIN';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let raiser: ActorContext;
let opsManager: ActorContext;
let financeManager: ActorContext;
let supplierId: string;

async function createUser(role: string, departments: string[]): Promise<ActorContext> {
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
  for (const code of departments) {
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code) values ($1,$2)`,
      [id, code],
    );
  }

  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({
  userId: ctx.principal.userId,
  branchCode: BAGHDAD,
});

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  await ownerPool.query(
    `insert into department (code, name, is_finance)
     values ('FIN','Finance',true), ('OPS','Operations',false)
     on conflict (code) do nothing`,
  );
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

  raiser = await createUser('accounting_officer', [OPERATIONS]);
  opsManager = await createUser('accounting_manager', [OPERATIONS]);
  financeManager = await createUser('accounting_manager', [FINANCE]);

  const { rows } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','SUP-001', true, 'active', true) returning id`,
  );
  supplierId = rows[0].id;
});

const serviceLine = (overrides: Partial<po.PurchaseLineInput> = {}): po.PurchaseLineInput => ({
  lineType: 'service',
  itemCode: SERVICE,
  description: 'Annual maintenance, 12 months',
  quantity: qty('12'),
  uomCode: 'EA',
  unitPriceIqd: price('500'),
  branchCode: BAGHDAD,
  costCentreCode: 'CC-OPS',
  ...overrides,
});

async function approvedOrder(
  lines: po.PurchaseLineInput[] = [serviceLine()],
): Promise<{ id: string; orderNo: string; lineIds: string[] }> {
  const order = await withScope(scope(raiser), (tx) =>
    po.create(tx, raiser, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines,
    }),
  );
  await withScope(scope(raiser), (tx) => po.submit(tx, raiser, order.id));
  await withScope(scope(opsManager), (tx) => po.approve(tx, opsManager, order.id));

  const { rows } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1 order by line_no`,
    [order.id],
  );
  return { ...order, lineIds: rows.map((r) => r.id) };
}

async function draftConfirmation(
  orderId: string,
  lines: sr.ConfirmationLineInput[],
  departmentCode = OPERATIONS,
) {
  return withScope(scope(raiser), (tx) =>
    sr.create(tx, raiser, {
      purchaseOrderId: orderId,
      departmentCode,
      branchCode: BAGHDAD,
      serviceDate: '2026-02-28',
      lines,
    }),
  );
}

// ---------------------------------------------------------------------------

describe('05.3 gate · only the benefiting department can confirm the service', () => {
  it('lets a member of the owning department approve it', async () => {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);
    await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));

    const result = await withScope(scope(opsManager), (tx) =>
      sr.approve(tx, opsManager, receipt.id),
    );

    expect(result.orderStatus).toBe('executed');
    const { rows } = await ownerPool.query(
      `select status, approved_by from service_receipt where id = $1`,
      [receipt.id],
    );
    expect(rows[0].status).toBe('approved');
    expect(rows[0].approved_by).toBe(opsManager.principal.userId);
  });

  it('refuses a manager from another department, however senior', async () => {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);
    await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));

    // Finance will pay this invoice and holds every permission the Operations
    // manager holds. It still cannot say whether the work was done.
    const error = await rejection(
      withScope(scope(financeManager), (tx) => sr.approve(tx, financeManager, receipt.id)),
    );

    expect(error).toMatch(/owned by department OPS/);
    expect(error).toMatch(/Only the department that asked for the work can confirm/);
  });

  it('refuses at the database too, bypassing the service', async () => {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);

    await expect(
      ownerPool.query(
        `update service_receipt set status = 'approved', approved_by = $1, approved_at = now()
          where id = $2`,
        [financeManager.principal.userId, receipt.id],
      ),
    ).rejects.toThrow(/the approver does not belong to it/);
  });

  it('refuses the person who raised it, even inside the department (§5.2)', async () => {
    // A manager of the benefiting department who raises the confirmation
    // themselves: every other rule is satisfied, and this one still is not.
    const order = await approvedOrder();
    const receipt = await withScope(scope(opsManager), (tx) =>
      sr.create(tx, opsManager, {
        purchaseOrderId: order.id,
        departmentCode: OPERATIONS,
        branchCode: BAGHDAD,
        serviceDate: '2026-02-28',
        lines: [{ purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') }],
      }),
    );
    await withScope(scope(opsManager), (tx) => sr.submit(tx, opsManager, receipt.id));

    const error = await rejection(
      withScope(scope(opsManager), (tx) => sr.approve(tx, opsManager, receipt.id)),
    );
    expect(error).toMatch(/cannot approve it/);

    // A second person from the same department can, which is what makes the
    // refusal about self-approval rather than about the department.
    const colleague = await createUser('accounting_manager', [OPERATIONS]);
    await withScope(scope(colleague), (tx) => sr.approve(tx, colleague, receipt.id));

    const { rows } = await ownerPool.query(`select status from service_receipt where id = $1`, [
      receipt.id,
    ]);
    expect(rows[0].status).toBe('approved');
  });

  it('shows a department the confirmations waiting on it', async () => {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('6') },
    ]);
    await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));

    const waiting = await withScope(scope(opsManager), (tx) =>
      sr.awaitingDepartment(tx, OPERATIONS),
    );
    const financeQueue = await withScope(scope(financeManager), (tx) =>
      sr.awaitingDepartment(tx, FINANCE),
    );

    expect(waiting.map((r) => r.receiptNo)).toEqual([receipt.receiptNo]);
    expect(financeQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('05.3 gate · no inventory movement is created for a service line', () => {
  it('moves no stock when a service is confirmed', async () => {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);
    await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));
    await withScope(scope(opsManager), (tx) => sr.approve(tx, opsManager, receipt.id));

    const { rows } = await ownerPool.query(`select count(*)::int as n from inventory_movement`);
    expect(rows[0].n).toBe(0);
  });

  it('has no movement column to fill in — the rule is a table property', async () => {
    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name in ('service_receipt','service_receipt_line')
          and column_name in ('movement_id','journal_entry_id')`,
    );
    // Appendix C lists no posting for this document and it moves no stock;
    // neither link exists to be written by mistake.
    expect(rows).toHaveLength(0);
  });

  it('posts nothing to the ledger', async () => {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);
    await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));
    await withScope(scope(opsManager), (tx) => sr.approve(tx, opsManager, receipt.id));

    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    // The expense reaches the ledger at the A/P Invoice (Appendix C). Whether a
    // period-end accrual is also wanted is D11, open.
    expect(rows[0].n).toBe(0);
  });

  it('refuses to confirm an inventory line', async () => {
    const order = await approvedOrder([
      {
        lineType: 'inventory_item',
        itemCode: CABLE,
        description: 'Network Cable 2m',
        quantity: qty('100'),
        uomCode: 'EA',
        unitPriceIqd: price('10'),
        branchCode: BAGHDAD,
        warehouseCode: `WH-${BAGHDAD}`,
      },
    ]);

    const error = await rejection(
      draftConfirmation(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('100') },
      ]),
    );

    expect(error).toMatch(/Goods are received on a Goods Receipt/);
  });

  it('refuses an inventory line at the database too', async () => {
    const order = await approvedOrder([
      serviceLine(),
      {
        lineType: 'inventory_item',
        itemCode: CABLE,
        description: 'Network Cable 2m',
        quantity: qty('100'),
        uomCode: 'EA',
        unitPriceIqd: price('10'),
        branchCode: BAGHDAD,
        warehouseCode: `WH-${BAGHDAD}`,
      },
    ]);
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);

    await expect(
      ownerPool.query(
        `insert into service_receipt_line
           (service_receipt_id, line_no, purchase_order_line_id, description, quantity, uom_code)
         values ($1, 2, $2, 'Smuggled cable', 1, 'EA')`,
        [receipt.id, order.lineIds[1]],
      ),
    ).rejects.toThrow(/Goods are received on a Goods Receipt/);
  });
});

// ---------------------------------------------------------------------------

describe('05.3 · the confirmation answers to its order', () => {
  it('refuses a confirmation against a draft order', async () => {
    const order = await withScope(scope(raiser), (tx) =>
      po.create(tx, raiser, {
        supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-01',
        lines: [serviceLine()],
      }),
    );
    const { rows } = await ownerPool.query(
      `select id from purchase_order_line where purchase_order_id = $1`,
      [order.id],
    );

    const error = await rejection(
      draftConfirmation(order.id, [{ purchaseOrderLineId: rows[0].id, quantity: qty('12') }]),
    );
    expect(error).toMatch(/An approved order is what authorises the work/);
  });

  it('refuses a line belonging to a different order', async () => {
    const first = await approvedOrder();
    const second = await approvedOrder();

    const error = await rejection(
      draftConfirmation(first.id, [
        { purchaseOrderLineId: second.lineIds[0]!, quantity: qty('12') },
      ]),
    );
    expect(error).toMatch(/does not belong to purchase order/);
  });

  it('accumulates partial confirmations and closes the order at the last one', async () => {
    const order = await approvedOrder();

    for (const months of ['6', '6']) {
      const receipt = await draftConfirmation(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty(months) },
      ]);
      await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));
      await withScope(scope(opsManager), (tx) => sr.approve(tx, opsManager, receipt.id));
    }

    const open = await withScope(scope(opsManager), (tx) => sr.outstanding(tx, order.id));
    expect(open[0]!.confirmed).toBe(qty('12'));
    expect(open[0]!.outstanding).toBe(0n);

    const { rows } = await ownerPool.query(`select status from purchase_order where id = $1`, [
      order.id,
    ]);
    expect(rows[0].status).toBe('executed');
  });

  it('refuses to confirm more than was ordered', async () => {
    const order = await approvedOrder();

    // §8.4's quantity tolerance is about a lorry arriving with an extra pallet.
    // Nobody accidentally delivers a thirteenth month of a twelve-month
    // contract, so this is refused rather than tolerated.
    const error = await rejection(
      draftConfirmation(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('13') },
      ]),
    );
    expect(error).toMatch(/against 12 ordered/);
    expect(error).toMatch(/the order is varied first/);
  });

  it('counts two lines of one document against the same ordered line', async () => {
    const order = await approvedOrder();

    const error = await rejection(
      draftConfirmation(order.id, [
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('7') },
        { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('7') },
      ]),
    );
    expect(error).toMatch(/against 12 ordered/);
  });

  it('counts only approved confirmations, never drafts', async () => {
    const order = await approvedOrder();

    // A confirmation somebody is still typing is not evidence that anything was
    // delivered. Two half-finished documents must not between them confirm the
    // whole order.
    await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);

    const second = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);
    expect(second.receiptNo).toBeTruthy();

    expect(
      await withScope(scope(opsManager), (tx) => sr.confirmedQuantity(tx, order.lineIds[0]!)),
    ).toBe(0n);
  });
});

// ---------------------------------------------------------------------------

describe('05.3 · an approved confirmation is evidence', () => {
  async function approvedConfirmation() {
    const order = await approvedOrder();
    const receipt = await draftConfirmation(order.id, [
      { purchaseOrderLineId: order.lineIds[0]!, quantity: qty('12') },
    ]);
    await withScope(scope(raiser), (tx) => sr.submit(tx, raiser, receipt.id));
    await withScope(scope(opsManager), (tx) => sr.approve(tx, opsManager, receipt.id));
    return { order, receipt };
  }

  it('answers the question the A/P Invoice will ask (§8.4)', async () => {
    const { order } = await approvedConfirmation();
    expect(
      await withScope(scope(opsManager), (tx) => sr.isConfirmed(tx, order.lineIds[0]!)),
    ).toBe(true);
  });

  it('says no for an order line nobody has confirmed', async () => {
    const order = await approvedOrder();
    expect(
      await withScope(scope(opsManager), (tx) => sr.isConfirmed(tx, order.lineIds[0]!)),
    ).toBe(false);
  });

  it('cannot be edited once approved', async () => {
    const { receipt } = await approvedConfirmation();

    await expect(
      ownerPool.query(`update service_receipt set service_date = '2026-03-01' where id = $1`, [
        receipt.id,
      ]),
    ).rejects.toThrow(/Reverse it and confirm again/);
  });

  it('cannot have its lines changed once approved', async () => {
    const { receipt } = await approvedConfirmation();

    await expect(
      ownerPool.query(`update service_receipt_line set quantity = 1 where service_receipt_id = $1`, [
        receipt.id,
      ]),
    ).rejects.toThrow(/cannot be changed/);
  });

  it('is withdrawn by reversal, with a reason (Appendix B)', async () => {
    const { order, receipt } = await approvedConfirmation();

    await withScope(scope(opsManager), (tx) =>
      sr.reverse(tx, opsManager, receipt.id, 'Contractor did not attend in February'),
    );

    const { rows } = await ownerPool.query(
      `select status, reversal_reason from service_receipt where id = $1`,
      [receipt.id],
    );
    expect(rows[0].status).toBe('reversed');
    expect(rows[0].reversal_reason).toMatch(/did not attend/);

    // The order reopens: nothing is confirmed against it any more.
    expect(
      await withScope(scope(opsManager), (tx) => sr.isConfirmed(tx, order.lineIds[0]!)),
    ).toBe(false);
  });

  it('refuses a reversal with no reason', async () => {
    const { receipt } = await approvedConfirmation();

    const error = await rejection(
      withScope(scope(opsManager), (tx) => sr.reverse(tx, opsManager, receipt.id, '   ')),
    );
    expect(error).toMatch(/needs a reason/);
  });

  it('refuses a reversal recorded without a reason at the database', async () => {
    const { receipt } = await approvedConfirmation();

    await expect(
      ownerPool.query(
        `update service_receipt set reversed_by = $1, reversed_at = now() where id = $2`,
        [opsManager.principal.userId, receipt.id],
      ),
    ).rejects.toThrow(/service_receipt_reversal_has_reason|Reverse it and confirm again/);
  });
});
