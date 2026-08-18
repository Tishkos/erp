/**
 * Phase 05.8 test gate — Purchase Order cancellation, §8.7.
 *
 *   - Cancelling an unexecuted PO requires no journal reversal (§3.2)
 *   - Cancelling a partially received PO closes only the open balance and
 *     leaves receipts intact
 *   - There is no path that reverses a receipt through PO cancellation
 *   - Cancellation requires a reason and releases the commitment
 *
 * The first and last are also covered in `phase05-purchase-order.test.ts`,
 * which could prove them without a receipt. These two needed 05.2.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as po from '@/server/services/purchase-order';
import * as gr from '@/server/services/goods-receipt';
import * as inventory from '@/server/services/inventory';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
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
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking)
       values ($1,'Network Cable 2m',true,'EA','batch') returning id`,
      [CABLE],
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

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','SUP-001', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,2,'February 2026','2026-02-01','2026-02-28') on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

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
      [
        `${parent.slice(0, 1)}9${String(role.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
      ],
    );
    accounts[role] = rows[0].id;
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('inventory.goods_receipt', $1, $2, true, $3) on conflict do nothing`,
      [role, rows[0].id, manager.principal.userId],
    );
  }

  void coa;
});

async function approvedOrder() {
  const order = await withScope(scope(clerk), (tx) =>
    po.create(tx, clerk, {
      supplierId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-01',
      lines: [
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
      ],
    }),
  );
  await withScope(scope(clerk), (tx) => po.submit(tx, clerk, order.id));
  await withScope(scope(manager), (tx) => po.approve(tx, manager, order.id));

  const { rows } = await ownerPool.query(
    `select id from purchase_order_line where purchase_order_id = $1`,
    [order.id],
  );
  return { ...order, lineIds: rows.map((r) => r.id) as string[] };
}

let seq = 0;
async function receive(orderId: string, poLineId: string, quantity: bigint) {
  const receipt = await withScope(scope(clerk), (tx) =>
    gr.create(tx, clerk, {
      purchaseOrderId: orderId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-05',
      lines: [{ purchaseOrderLineId: poLineId, quantity, batchNumber: `B-${(seq += 1)}` }],
    }),
  );
  await withScope(scope(clerk), (tx) => gr.submit(tx, clerk, receipt.id));
  await withScope(scope(manager), (tx) => gr.post(tx, manager, receipt.id));
  return receipt;
}

// ---------------------------------------------------------------------------

describe('05.8 gate · cancelling a partly received order', () => {
  it('closes only the open balance and leaves the receipt alone', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    const result = await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Supplier cannot supply the balance this quarter.'),
    );

    // 100 ordered, 40 arrived, 60 closed. The 40 stay received: they are in the
    // warehouse and in the ledger, and a cancellation reaches neither.
    expect(result.closedQuantity).toBe(qty('60'));

    const { rows } = await ownerPool.query(
      `select received_quantity, closed_quantity from purchase_order_line where id = $1`,
      [order.lineIds[0]],
    );
    expect(parseQuantity(rows[0].received_quantity)).toBe(qty('40'));
    expect(parseQuantity(rows[0].closed_quantity)).toBe(qty('60'));
  });

  it('leaves the stock and the ledger untouched', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    const before = await ownerPool.query(`select count(*)::int as n from journal_entry`);

    await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Balance no longer required.'),
    );

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, `WH-${BAGHDAD}`, BAGHDAD),
    );
    const after = await ownerPool.query(`select count(*)::int as n from journal_entry`);

    // §3.2 — closing an open balance has no accounting effect, because nothing
    // about what already happened has changed.
    expect(position.onHand).toBe(qty('40'));
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('offers no path that reverses a receipt through cancellation', async () => {
    const order = await approvedOrder();
    const receipt = await receive(order.id, order.lineIds[0]!, qty('40'));

    await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Balance cancelled.'),
    );

    // §8.7 — "A prior receipt is reversed only through a separate Goods
    // Return." The receipt is still posted, its movement still stands, and the
    // cancellation touched neither.
    const { rows } = await ownerPool.query(`select status from goods_receipt where id = $1`, [
      receipt.id,
    ]);
    expect(rows[0].status).toBe('executed');

    const { rows: reversals } = await ownerPool.query(
      `select count(*)::int as n from inventory_movement where kind = 'reversal'`,
    );
    expect(reversals[0].n).toBe(0);
  });

  it('calls it Closed, not Cancelled, once anything has been received', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    const result = await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Balance cancelled.'),
    );

    // §8.7's distinction, and it is not cosmetic: **Cancelled** means the order
    // never happened; **Closed** means it did and nothing further is expected.
    // Forty cables arrived, so the first is no longer available.
    expect(result.status).toBe('closed');
  });

  it('calls it Cancelled when nothing was ever received', async () => {
    const order = await approvedOrder();

    const result = await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Requirement withdrawn before delivery.'),
    );

    expect(result.status).toBe('cancelled');
    expect(result.closedQuantity).toBe(qty('100'));
  });

  it('closes nothing on a fully received order', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('100'));

    const result = await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Tidying up a completed order.'),
    );

    expect(result.closedQuantity).toBe(0n);
    expect(result.status).toBe('closed');
  });

  it('still needs a reason, whatever has been received', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    const error = await rejection(
      withScope(scope(manager), (tx) => po.cancel(tx, manager, order.id, '   ')),
    );
    expect(error).toMatch(/state why/i);
  });

  it('refuses to cancel an order that is already finished', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));
    await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Balance cancelled.'),
    );

    const error = await rejection(
      withScope(scope(manager), (tx) => po.cancel(tx, manager, order.id, 'Again')),
    );
    expect(error).toMatch(/already finished/);
  });

  it('releases the commitment for the part that will never arrive', async () => {
    const order = await approvedOrder();
    await receive(order.id, order.lineIds[0]!, qty('40'));

    const before = await withScope(scope(manager), (tx) => po.openCommitments(tx));
    expect(before.length).toBeGreaterThan(0);

    await withScope(scope(manager), (tx) =>
      po.cancel(tx, manager, order.id, 'Balance no longer required.'),
    );

    // Appendix B — an approved order is a commitment. Sixty of it is not coming,
    // and Phase 14's budget must stop reserving for it the moment that is known.
    const after = await withScope(scope(manager), (tx) => po.openCommitments(tx));
    expect(after).toHaveLength(0);
  });
});
