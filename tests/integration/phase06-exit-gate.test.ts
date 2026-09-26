/**
 * Phase 06 exit gate — the §26 critical UAT scenario, end to end.
 *
 * > §27 Release 5 acceptance: *"Stock, customer ledger, revenue and COGS
 * > reconcile."*
 * > §26: *"Lead → opportunity → Sales Order → reservation → partial delivery →
 * > A/R Invoice on delivery date → receipt → allocation → customer statement →
 * > G/L and margin report."*
 *
 * The lead and opportunity legs are Phase 08. Everything from the Sales Order
 * onward runs here, **as one test**, because that is the thing the gate is
 * about: each link is proved in its own sub-phase file, and what nobody has
 * proved until this file is that the links form a chain.
 *
 * The four §7.7 acceptance criteria are asserted at the end against the state
 * the scenario left behind, rather than in isolation — a reconciliation that
 * only holds on a purpose-built fixture is not a reconciliation.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as so from '@/server/services/sales-order';
import * as pick from '@/server/services/pick-list';
import * as dn from '@/server/services/delivery-note';
import * as ar from '@/server/services/ar-invoice';
import * as receipts from '@/server/services/customer-receipt';
import * as reports from '@/server/services/ar-reports';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const LIST = 'PL-RETAIL';
const TERMS = 'NET30';
const WAREHOUSE = `WH-${BAGHDAD}`;
const CONTROL = 'A9TRADER';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let salesUser: ActorContext;
let manager: ActorContext;
let customerId: string;
let cashAccountId: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role,
  ]);
  // 'accounting_manager+ceo' is a manager who also holds the CEO's invoice
  // approval (Operations build, blocks 4 and 5).
  for (const code of role.split('+')) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, code]);
  }
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

async function attachment(fileName: string, contentType = 'image/jpeg'): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into attachment
       (id, object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
        scan_status, scanned_at, uploaded_by, branch_code)
     values ($1, 'delivery_note', $2, $3, $4, 2048, $5, $6, 'clean', now(), $7, $8)`,
    [
      id,
      id,
      fileName,
      contentType,
      createHash('sha256').update(id).digest('hex'),
      `pod/${id}`,
      manager.principal.userId,
      BAGHDAD,
    ],
  );
  return id;
}

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

  salesUser = await createUser('accounting_officer');
  manager = await createUser('accounting_manager+ceo');

  await ownerPool.query(
    `insert into payment_terms (code, name, basis, due_days) values ($1,'Net 30','document_date',30)`,
    [TERMS],
  );
  await ownerPool.query(
    `insert into price_list (code, name, currency, active) values ($1,'Retail','IQD',true)`,
    [LIST],
  );
  const { rows: items } = await ownerPool.query(`select id from item where code = $1`, [CABLE]);
  await ownerPool.query(
    `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
     values ($1,$2,'EA',20.0000,'2026-01-01')`,
    [LIST, items[0].id],
  );

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner
       (code, legal_name, is_customer, status, active, price_list_code, credit_limit_iqd,
        payment_terms_code)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true, $1, 100000000.0000, $2)
     returning id`,
    [LIST, TERMS],
  );
  customerId = partner[0].id;

  const { rows: cash } = await ownerPool.query(
    `select id from bank_cash_account where branch_code = $1 limit 1`,
    [BAGHDAD],
  );
  cashAccountId = cash[0].id;

  for (const [code, name, parent, control] of [
    ['A9INVENT', 'Inventory', 'A000001', null],
    ['X9COGS', 'Cost of Goods Sold', 'X000001', null],
    [CONTROL, 'Trade Receivables', 'A000001', 'customer'],
    ['R9REVENU', 'Sales Revenue', 'R000001', null],
    ['A9BANK', 'Bank Current Account', 'A000001', null],
    ['L9CLEAR', 'Customer Clearing', 'L000001', null],
    ['L9OPENBA', 'Opening Balance Suspense', 'L000001', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = $1`,
      [parent],
    );
    await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1, $2,
               (select account_type from chart_of_account where code = $3),
               $4, false, true, 'approved', 1, 'IQD', $5)`,
      [code, name, parent, parents[0].id, control],
    );
  }

  for (const [event, role, code] of [
    ['inventory.delivery', 'inventory', 'A9INVENT'],
    ['inventory.delivery', 'cogs', 'X9COGS'],
    ['inventory.opening_stock', 'inventory', 'A9INVENT'],
    ['inventory.opening_stock', 'cogs', 'X9COGS'],
    ['inventory.opening_stock', 'opening_balance', 'L9OPENBA'],
    ['sales.ar_invoice', 'customer_receivable', CONTROL],
    ['sales.ar_invoice', 'sales_revenue', 'R9REVENU'],
    ['sales.customer_receipt', 'bank_cash', 'A9BANK'],
    ['sales.customer_receipt', 'customer_receivable', CONTROL],
    ['sales.customer_receipt', 'customer_clearing', 'L9CLEAR'],
  ] as const) {
    const { rows: account } = await ownerPool.query(
      `select id from chart_of_account where code = $1`,
      [code],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ($1, $2, $3, true, $4) on conflict do nothing`,
      [event, role, account[0].id, manager.principal.userId],
    );
  }

  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('SALES','Sales',false)
     on conflict (code) do nothing`,
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1000.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: years } = await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on)
     values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31') returning id`,
  );
  for (const [no, name, from, to] of [
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1, $2, $3, $4, $5)`,
      [years[0].id, no, name, from, to],
    );
  }

  // 200 units at 6 each. One layer, so the FIFO arithmetic in the assertions is
  // legible; the multi-layer case is proved in 06.5's own file.
  await withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: CABLE,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity: qty('200'),
      unitCostIqd: price('6'),
      movementDate: '2026-02-01',
      kind: 'opening_stock',
      batchNumber: 'B-1',
      // Posted, so §27's "stock … reconcile" has both sides to compare: the
      // inventory account and the FIFO valuation.
      post: true,
      dimensions: { branch: BAGHDAD },
    }),
  );
});

describe('Phase 06 exit gate · §26 UAT scenario, end to end', () => {
  it('runs Sales Order → reservation → partial delivery → invoice → receipt → allocation → statement → G/L', async () => {
    // ── Sales Order ────────────────────────────────────────────────────────
    // 100 units at the customer's price list. §7.3: no price is submitted.
    const order = await withScope(scope(salesUser), (tx) =>
      so.create(tx, salesUser, {
        customerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-10',
        departmentCode: 'SALES',
        businessLineCode: 'PRODUCT_SALES',
        lines: [
          {
            itemCode: CABLE,
            quantity: qty('100'),
            uomCode: 'EA',
            warehouseCode: WAREHOUSE,
            branchCode: BAGHDAD,
          },
        ],
      }),
    );

    // ── Reservation ────────────────────────────────────────────────────────
    // §7.4 — stock is reserved when the order is approved, and not before.
    let position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );
    expect(position.reserved).toBe(0n);

    await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));

    position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );
    expect(position.reserved).toBe(qty('100'));
    expect(availableQuantity(position)).toBe(qty('100'));

    // ── Partial delivery ───────────────────────────────────────────────────
    // §7.2 — 60 of the 100 go out on the 13th.
    const outstanding = await withScope(scope(manager), (tx) =>
      pick.outstandingFor(tx, order.id, WAREHOUSE),
    );
    const sheet = await withScope(scope(manager), (tx) =>
      pick.create(tx, manager, {
        salesOrderId: order.id,
        warehouseCode: WAREHOUSE,
        pickDate: '2026-02-12',
        lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity: qty('60') }],
      }),
    );
    await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));
    const sheetView = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.id, [
        {
          pickListLineId: sheetView.lines[0]!.id,
          quantity: qty('60'),
          units: [{ batchNumber: 'B-1', quantity: qty('60') }],
        },
      ]),
    );

    const note = await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet.id, deliveryDate: '2026-02-13' }),
    );
    await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));
    const signature = await attachment('signature.png', 'image/png');
    const photo = await attachment('unloaded.jpg');
    await withScope(scope(manager), (tx) =>
      dn.recordProofOfDelivery(tx, manager, note.id, {
        recipientName: 'Ahmed Kareem',
        recipientRole: 'Store manager',
        signatureAttachmentId: signature,
        photoAttachmentIds: [photo],
        receivedAt: new Date('2026-02-13T09:30:00Z'),
      }),
    );
    const delivered = await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));

    // 60 at 6 = 360 of cost, and the order is Partially Delivered.
    expect(delivered.cogsIqd).toBe(price('360'));
    const { rows: orderStatus } = await ownerPool.query(
      `select status from sales_order where id = $1`,
      [order.id],
    );
    expect(orderStatus[0].status).toBe('partially_executed');

    // 60 gone, 40 still promised, and the 100 that were never this order's are
    // still available to everybody else.
    position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );
    expect(position.onHand).toBe(qty('140'));
    expect(position.reserved).toBe(qty('40'));
    expect(availableQuantity(position)).toBe(qty('100'));

    // ── A/R Invoice on the delivery date ───────────────────────────────────
    const invoice = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, { deliveryNoteId: note.id }),
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
    const posted = await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));

    const invoiceView = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    // §7.4 — the same date as the delivery, and Net 30 from it.
    expect(invoiceView.invoiceDate).toBe('2026-02-13');
    expect(invoiceView.dueDate).toBe('2026-03-15');
    expect(invoiceView.netIqd).toBe('1200.0000');

    // ── Receipt and allocation ─────────────────────────────────────────────
    const receipt = await withScope(scope(manager), (tx) =>
      receipts.create(tx, manager, {
        customerId,
        branchCode: BAGHDAD,
        receiptDate: '2026-03-01',
        bankCashAccountId: cashAccountId,
        amountIqd: price('700'),
        bankReference: 'TRF-2026-0301',
      }),
    );
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, receipt.id, [
        { arInvoiceId: invoice.id, amountIqd: price('700') },
      ]),
    );

    const afterAllocation = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(afterAllocation.status).toBe('partially_executed');
    expect(afterAllocation.allocatedIqd).toBe('700.0000');

    // ── Customer statement ─────────────────────────────────────────────────
    const statement = await withScope(scope(manager), (tx) =>
      reports.statement(tx, manager.principal, 'CUST-001', {
        from: '2026-02-01',
        to: '2026-03-31',
      }),
    );

    expect(statement.map((l) => l.documentType)).toEqual(['ar_invoice', 'customer_receipt']);
    expect(statement[1]!.runningBalanceIqd).toBe('500.0000');
    // §16 — both currencies on every line, at the historical rate.
    expect(Number(statement[0]!.amountUsd)).toBe(1.2);

    // ── G/L and margin ─────────────────────────────────────────────────────
    // §27 Release 5: *"stock, customer ledger, revenue and COGS reconcile."*
    const reconciliation = await withScope(scope(manager), (tx) =>
      reports.reconcile(tx, manager.principal, '2026-03-31', CONTROL),
    );
    expect(reconciliation.reconciles).toBe(true);
    expect(reconciliation.ageingTotalIqd).toBe('500.0000');

    const { rows: gl } = await ownerPool.query(
      `select a.name, coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
         from journal_line l
         join journal_entry e on e.id = l.journal_entry_id
         join chart_of_account a on a.id = l.account_id
        where e.status = 'posted'
        group by a.name
        order by a.name`,
    );
    const balance = (name: string) => Number(gl.find((r) => r.name === name)?.balance ?? 0);

    // Inventory: 200 in at 6 = 1,200, less 360 delivered = 840.
    expect(balance('Inventory')).toBe(840);
    // Revenue 1,200 credit, COGS 360 debit → a gross margin of 840.
    expect(balance('Sales Revenue')).toBe(-1200);
    expect(balance('Cost of Goods Sold')).toBe(360);
    expect(-balance('Sales Revenue') - balance('Cost of Goods Sold')).toBe(840);
    // Receivables 1,200 raised less 700 received = 500 — the ageing figure.
    expect(balance('Trade Receivables')).toBe(500);
    // The money arrived in the account the receipt named, so that is where the
    // debit is — not the `bank_cash` mapping, which would put every receipt in
    // the same account whichever bank actually took it (§17).
    const { rows: receiving } = await ownerPool.query(
      `select a.name from bank_cash_account b
         join chart_of_account a on a.id = b.gl_account_id
        where b.id = $1`,
      [cashAccountId],
    );
    expect(balance(receiving[0].name)).toBe(700);

    // And the stock ledger agrees with the inventory account, which is §27's
    // "stock … reconcile" in one line.
    const valuation = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, CABLE, WAREHOUSE),
    );
    expect(valuation).toBe(price('840'));

    // ── §7.7 acceptance criteria, against the state the scenario left ──────

    // 2 — reservation, delivery, invoice and receipt reconcile to the order.
    const chain = await withScope(scope(manager), (tx) => dn.reconcileToOrder(tx, order.id));
    expect(chain[0]!.ordered).toBe('100.000000');
    expect(chain[0]!.picked).toBe('60.000000');
    expect(chain[0]!.delivered).toBe('60.000000');
    expect(chain[0]!.invoiced).toBe('60.000000');
    expect(chain[0]!.reserved).toBe('40.000000');

    // 3 — customer exposure includes the open order and the open invoice.
    const exposure = await withScope(scope(manager), (tx) =>
      so.exposureFor(tx, customerId),
    );
    expect(exposure.openOrdersIqd).toBeGreaterThan(0n);

    // 4 — every posted sales journal drills to order, delivery and invoice.
    const drill = await withScope(scope(manager), (tx) =>
      ar.drillBack(tx, posted.journalEntryId),
    );
    expect(drill[0]!.salesOrderId).toBe(order.id);
    expect(drill[0]!.deliveryNoteId).toBe(note.id);
    expect(drill[0]!.documentNo).toBe(invoice.invoiceNo);
  });

  it('completes the order when the rest is delivered, and still reconciles', async () => {
    const order = await withScope(scope(salesUser), (tx) =>
      so.create(tx, salesUser, {
        customerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-10',
        departmentCode: 'SALES',
        businessLineCode: 'PRODUCT_SALES',
        lines: [
          {
            itemCode: CABLE,
            quantity: qty('100'),
            uomCode: 'EA',
            warehouseCode: WAREHOUSE,
            branchCode: BAGHDAD,
          },
        ],
      }),
    );
    await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));

    for (const [quantity, on] of [
      ['60', '2026-02-13'],
      ['40', '2026-02-20'],
    ] as const) {
      const outstanding = await withScope(scope(manager), (tx) =>
        pick.outstandingFor(tx, order.id, WAREHOUSE),
      );
      const sheet = await withScope(scope(manager), (tx) =>
        pick.create(tx, manager, {
          salesOrderId: order.id,
          warehouseCode: WAREHOUSE,
          pickDate: on,
          lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity: qty(quantity) }],
        }),
      );
      await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));
      const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
      await withScope(scope(manager), (tx) =>
        pick.pick(tx, manager, sheet.id, [
          {
            pickListLineId: view.lines[0]!.id,
            quantity: qty(quantity),
            units: [{ batchNumber: 'B-1', quantity: qty(quantity) }],
          },
        ]),
      );

      const note = await withScope(scope(manager), (tx) =>
        dn.create(tx, manager, { pickListId: sheet.id, deliveryDate: on }),
      );
      await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));
      const signature = await attachment('signature.png', 'image/png');
      const photo = await attachment('unloaded.jpg');
      await withScope(scope(manager), (tx) =>
        dn.recordProofOfDelivery(tx, manager, note.id, {
          recipientName: 'Ahmed Kareem',
          signatureAttachmentId: signature,
          photoAttachmentIds: [photo],
          receivedAt: new Date(`${on}T09:30:00Z`),
        }),
      );
      await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));

      const invoice = await withScope(scope(salesUser), (tx) =>
        ar.create(tx, salesUser, { deliveryNoteId: note.id }),
      );
      await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
      await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));
    }

    // §7.2 — two deliveries against one order accumulate and close the line.
    const { rows } = await ownerPool.query(`select status from sales_order where id = $1`, [
      order.id,
    ]);
    expect(rows[0].status).toBe('executed');

    const chain = await withScope(scope(manager), (tx) => dn.reconcileToOrder(tx, order.id));
    expect(chain[0]!.delivered).toBe('100.000000');
    expect(chain[0]!.invoiced).toBe('100.000000');
    expect(chain[0]!.reserved).toBe('0.000000');

    // Nothing promised, nothing left: 100 gone, 100 free.
    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );
    expect(position.onHand).toBe(qty('100'));
    expect(position.reserved).toBe(0n);

    const reconciliation = await withScope(scope(manager), (tx) =>
      reports.reconcile(tx, manager.principal, '2026-03-31', CONTROL),
    );
    expect(reconciliation.reconciles).toBe(true);
    expect(reconciliation.ageingTotalIqd).toBe('2000.0000');
  });
});
