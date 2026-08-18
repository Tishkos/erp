/**
 * Phase 06.9 test gate — Sales Return and Customer Credit Memo. §7.5, Appendix C.
 *
 *   - No exchange mechanism exists anywhere in the return flow
 *   - A return exceeding invoiced quantity less prior accepted returns is rejected
 *   - Inspection routing to saleable, quarantine or damaged works and each
 *     destination behaves per Phase 04
 *   - Goods routed to damaged cannot subsequently be sold
 *   - The credit memo reverses revenue and COGS at the original FIFO cost, not
 *     current cost
 *   - The credit memo links to the Sales Return and the source A/R Invoice
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as so from '@/server/services/sales-order';
import * as pick from '@/server/services/pick-list';
import * as dn from '@/server/services/delivery-note';
import * as ar from '@/server/services/ar-invoice';
import * as sr from '@/server/services/sales-return';
import * as ccm from '@/server/services/customer-credit-memo';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const LIST = 'PL-RETAIL';
const WAREHOUSE = `WH-${BAGHDAD}`;
const QUARANTINE = 'WH-QTN';
const DAMAGED = 'WH-DMG';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let salesUser: ActorContext;
let manager: ActorContext;
let customerId: string;

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

async function receive(quantity: bigint, unitCost: string, batch: string) {
  await withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: CABLE,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity,
      unitCostIqd: price(unitCost),
      movementDate: '2026-02-01',
      kind: 'opening_stock',
      batchNumber: batch,
    }),
  );
}

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

  // §7.5's other two destinations. Phase 04 keeps stock in these out of the
  // available pool by warehouse type, which is what makes the routing a control.
  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type) values
       ($1, 'Baghdad Quarantine', $3, 'quarantine'),
       ($2, 'Baghdad Damaged Goods', $3, 'damaged_goods')`,
    [QUARANTINE, DAMAGED, BAGHDAD],
  );

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
  manager = await createUser('accounting_manager');

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
       (code, legal_name, is_customer, status, active, price_list_code, credit_limit_iqd)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true, $1, 100000000.0000)
     returning id`,
    [LIST],
  );
  customerId = partner[0].id;

  for (const [event, role, parent, name, control] of [
    ['inventory.delivery', 'inventory', 'A000001', 'Inventory', null],
    ['inventory.delivery', 'cogs', 'X000001', 'Cost of Goods Sold', null],
    ['inventory.opening_stock', 'inventory', 'A000001', 'Inventory', null],
    ['inventory.opening_stock', 'cogs', 'X000001', 'Cost of Goods Sold', null],
    ['inventory.sales_return', 'inventory', 'A000001', 'Inventory', null],
    ['inventory.sales_return', 'cogs', 'X000001', 'Cost of Goods Sold', null],
    ['sales.ar_invoice', 'customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['sales.ar_invoice', 'sales_revenue', 'R000001', 'Sales Revenue', null],
    [
      'sales.customer_credit_memo',
      'customer_receivable',
      'A000001',
      'Trade Receivables',
      'customer',
    ],
    ['sales.customer_credit_memo', 'sales_returns', 'X000001', 'Sales Returns', null],
  ] as const) {
    const code = `${parent.slice(0, 1)}9${name.replace(/[^A-Za-z]/g, '').slice(0, 6).toUpperCase()}`;
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = $1`,
      [parent],
    );
    const { rows: account } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1, $2,
               (select account_type from chart_of_account where code = $3),
               $4, false, true, 'approved', 1, 'IQD', $5)
       on conflict (code) do update set name = excluded.name
       returning id`,
      [code, name, parent, parents[0].id, control],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ($1, $2, $3, true, $4)
       on conflict do nothing`,
      [event, role, account[0].id, manager.principal.userId],
    );
  }

  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('SALES','Sales',false)
     on conflict (code) do nothing`,
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1)
     on conflict do nothing`,
    [manager.principal.userId],
  );

  const { rows: years } = await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on)
     values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31') returning id`,
  );
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1, 2, 'February 2026', '2026-02-01', '2026-02-28')`,
    [years[0].id],
  );
});

/** The whole chain to a posted invoice. */
async function soldAndInvoiced(quantity: bigint) {
  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-10',
      departmentCode: 'SALES',
      businessLineCode: 'PRODUCT_SALES',
      lines: [
        { itemCode: CABLE, quantity, uomCode: 'EA', warehouseCode: WAREHOUSE, branchCode: BAGHDAD },
      ],
    }),
  );
  await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));

  const outstanding = await withScope(scope(manager), (tx) =>
    pick.outstandingFor(tx, order.id, WAREHOUSE),
  );
  const sheet = await withScope(scope(manager), (tx) =>
    pick.create(tx, manager, {
      salesOrderId: order.id,
      warehouseCode: WAREHOUSE,
      pickDate: '2026-02-12',
      lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity }],
    }),
  );
  await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));
  const sheetView = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
  await withScope(scope(manager), (tx) =>
    pick.pick(tx, manager, sheet.id, [
      {
        pickListLineId: sheetView.lines[0]!.id,
        quantity,
        units: [{ batchNumber: 'B-1', quantity }],
      },
    ]),
  );

  const note = await withScope(scope(manager), (tx) =>
    dn.create(tx, manager, { pickListId: sheet.id, deliveryDate: '2026-02-13' }),
  );
  await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

  const signature = await attachment('signature.png', 'image/png');
  const photo = await attachment('van.jpg');
  await withScope(scope(manager), (tx) =>
    dn.recordProofOfDelivery(tx, manager, note.id, {
      recipientName: 'Ahmed Kareem',
      signatureAttachmentId: signature,
      photoAttachmentIds: [photo],
      receivedAt: new Date('2026-02-13T09:30:00Z'),
    }),
  );
  const delivered = await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));

  const invoice = await withScope(scope(salesUser), (tx) =>
    ar.create(tx, salesUser, { deliveryNoteId: note.id }),
  );
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));

  const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));

  return { ...invoice, lineId: view.lines[0]!.id, cogsIqd: delivered.cogsIqd };
}

/** A return through Requested → Received → Inspected → Accepted. */
async function returnedAndAccepted(
  invoiceId: string,
  invoiceLineId: string,
  quantity: bigint,
  disposition: 'saleable' | 'quarantine' | 'damaged' = 'saleable',
) {
  const destination =
    disposition === 'saleable' ? WAREHOUSE : disposition === 'quarantine' ? QUARANTINE : DAMAGED;

  const created = await withScope(scope(salesUser), (tx) =>
    sr.request(tx, salesUser, {
      arInvoiceId: invoiceId,
      requestedOn: '2026-02-18',
      reason: 'Customer ordered the wrong length',
      lines: [{ arInvoiceLineId: invoiceLineId, quantity }],
    }),
  );

  const view = await withScope(scope(manager), (tx) => sr.view(tx, created.id));

  await withScope(scope(manager), (tx) =>
    sr.receiveGoods(tx, manager, created.id, {
      receivedOn: '2026-02-19',
      lines: [{ salesReturnLineId: view.lines[0]!.id, quantity }],
    }),
  );

  await withScope(scope(manager), (tx) =>
    sr.inspect(tx, manager, created.id, [
      {
        salesReturnLineId: view.lines[0]!.id,
        acceptedQuantity: quantity,
        disposition,
        destinationWarehouseCode: destination,
      },
    ]),
  );

  const accepted = await withScope(scope(manager), (tx) => sr.accept(tx, manager, created.id));

  return { ...created, lineId: view.lines[0]!.id, ...accepted, destination };
}

// ---------------------------------------------------------------------------

describe('06.9 gate · no exchange mechanism exists (§7.5)', () => {
  it('has no column anywhere that could name a replacement', async () => {
    const { rows } = await ownerPool.query(
      `select table_name, column_name from information_schema.columns
        where table_name in ('sales_return','sales_return_line',
                             'customer_credit_memo','customer_credit_memo_line')
          and (column_name like '%replacement%'
            or column_name like '%exchange%'
            or column_name like '%swap%')`,
    );

    // §7.5: "Product exchange is not supported. Replacement requires a new Sales
    // Order." Enforced by absence — a validation could be routed around, a
    // concept with no column cannot be reached at all.
    expect(rows).toEqual([]);
  });

  it('has no exchange document type and no exchange status', async () => {
    const { rows: types } = await ownerPool.query(
      `select code from document_type where code ilike '%exchange%' or name ilike '%exchange%'`,
    );
    expect(types).toEqual([]);

    const { rows: transitions } = await ownerPool.query(
      `select to_status::text from document_status_transition
        where document_type_code = 'sales_return'`,
    );
    // Requested, Received, Inspected, Accepted, Rejected, Closed — Appendix B's
    // six, in §3.2's words, and nothing that means "swapped".
    expect([...new Set(transitions.map((r) => r.to_status))].sort()).toEqual([
      'approved',
      'closed',
      'executed',
      'partially_executed',
      'rejected',
    ]);
  });
});

// ---------------------------------------------------------------------------

describe('06.9 gate · a return cannot exceed what was invoiced (§7.5)', () => {
  it('refuses more than the invoice, through the service', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          sr.request(tx, salesUser, {
            arInvoiceId: invoice.id,
            requestedOn: '2026-02-18',
            reason: 'Too many',
            lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('80') }],
          }),
        ),
      ),
    ).toMatch(/more than the customer bought/);
  });

  it('counts a previously accepted return', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    await returnedAndAccepted(invoice.id, invoice.lineId, qty('40'));

    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          sr.request(tx, salesUser, {
            arInvoiceId: invoice.id,
            requestedOn: '2026-02-20',
            reason: 'The rest as well',
            lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('30') }],
          }),
        ),
      ),
    ).toMatch(/more than the customer bought/);

    // …but the 20 that are left may still come back.
    const second = await withScope(scope(salesUser), (tx) =>
      sr.request(tx, salesUser, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-02-20',
        reason: 'The rest as well',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('20') }],
      }),
    );
    expect(second.returnNo).toMatch(/^SRN-/);
  });

  it('does not count a rejected return — those goods went back to the customer', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    const refused = await withScope(scope(salesUser), (tx) =>
      sr.request(tx, salesUser, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-02-18',
        reason: 'Claimed faulty',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('60') }],
      }),
    );
    await withScope(scope(manager), (tx) =>
      sr.reject(tx, manager, refused.id, 'Goods were used, not faulty'),
    );

    // One refused claim must not block a legitimate second attempt at the same
    // units — the customer still has them.
    const second = await returnedAndAccepted(invoice.id, invoice.lineId, qty('60'));
    expect(second.movementIds).toHaveLength(1);
  });

  it('refuses it again in the database, whatever route wrote the row (§7.7)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));

    expect(
      await rejection(
        ownerPool.query(`update sales_return_line set accepted_quantity = 80 where id = $1`, [
          returned.lineId,
        ]),
      ),
    ).toMatch(/more than the customer bought|accepted_within_received/);
  });

  it('reports what is still returnable on an invoice', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));

    const rows = await withScope(scope(manager), (tx) => sr.returnableFor(tx, invoice.id));

    expect(rows[0]!.invoiced).toBe('60.000000');
    expect(rows[0]!.returned).toBe('20.000000');
    expect(rows[0]!.returnable).toBe('40.000000');
  });
});

// ---------------------------------------------------------------------------

describe('06.9 gate · inspection routes to saleable, quarantine or damaged (§7.5)', () => {
  it('puts saleable goods back into the selling pool', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    const before = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );

    await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'), 'saleable');

    const after = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );

    expect(after.onHand).toBe(before.onHand + qty('20'));
    expect(availableQuantity(after)).toBe(availableQuantity(before) + qty('20'));
  });

  it('holds quarantined goods out of the available pool (Phase 04)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'), 'quarantine');

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, QUARANTINE, BAGHDAD),
    );

    expect(position.onHand).toBe(qty('20'));
    expect(position.inQuarantine).toBe(qty('20'));
    expect(availableQuantity(position)).toBe(0n);
  });

  it('refuses damaged goods into a saleable warehouse', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    const created = await withScope(scope(salesUser), (tx) =>
      sr.request(tx, salesUser, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-02-18',
        reason: 'Arrived crushed',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('20') }],
      }),
    );
    const view = await withScope(scope(manager), (tx) => sr.view(tx, created.id));
    await withScope(scope(manager), (tx) =>
      sr.receiveGoods(tx, manager, created.id, {
        receivedOn: '2026-02-19',
        lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: qty('20') }],
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          sr.inspect(tx, manager, created.id, [
            {
              salesReturnLineId: view.lines[0]!.id,
              acceptedQuantity: qty('20'),
              disposition: 'damaged',
              destinationWarehouseCode: WAREHOUSE,
            },
          ]),
        ),
      ),
    ).toMatch(/cannot be put into/);
  });

  it('refuses it again in the database (§7.7)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'), 'damaged');

    expect(
      await rejection(
        ownerPool.query(
          `update sales_return_line set destination_warehouse_code = $1 where id = $2`,
          [WAREHOUSE, returned.lineId],
        ),
      ),
    ).toMatch(/cannot be put into/);
  });
});

describe('06.9 gate · goods routed to damaged cannot be sold', () => {
  it('leaves them out of the available pool entirely', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'), 'damaged');

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, DAMAGED, BAGHDAD),
    );

    // §7.5 — "damaged returned goods cannot be sold", enforced by where the
    // stock sits: Phase 04 counts a damaged-goods warehouse as damaged, and
    // damaged is not available.
    expect(position.onHand).toBe(qty('20'));
    expect(position.damaged).toBe(qty('20'));
    expect(availableQuantity(position)).toBe(0n);
  });

  it('refuses an order that tries to sell from the damaged store', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'), 'damaged');

    const order = await withScope(scope(salesUser), (tx) =>
      so.create(tx, salesUser, {
        customerId,
        branchCode: BAGHDAD,
        orderDate: '2026-02-20',
        departmentCode: 'SALES',
        businessLineCode: 'PRODUCT_SALES',
        lines: [
          {
            itemCode: CABLE,
            quantity: qty('10'),
            uomCode: 'EA',
            warehouseCode: DAMAGED,
            branchCode: BAGHDAD,
          },
        ],
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => so.approve(tx, manager, order.id))),
    ).toMatch(/available|Available|insufficient/i);
  });
});

// ---------------------------------------------------------------------------

describe('06.9 gate · the credit memo values the return at the original cost', () => {
  it('puts stock back at what it left at, not at today’s cost', async () => {
    // Two layers: 100 at 6 and 100 at 10. Selling 150 costs 1,100, so those
    // units averaged 7.3333 each.
    await receive(qty('100'), '6', 'B-OLD');
    await receive(qty('100'), '10', 'B-NEW');

    const invoice = await soldAndInvoiced(qty('150'));
    expect(invoice.cogsIqd).toBe(price('1100'));

    // The market moves before the return arrives.
    await receive(qty('100'), '99', 'B-EXPENSIVE');

    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('30'));

    // 30 back at 7.3333 = 219.999 — the original cost, not 99 each.
    expect(returned.valueIqd).toBe(price('219.999'));

    const { rows } = await ownerPool.query(
      `select original_unit_cost_iqd from sales_return_line where sales_return_id = $1`,
      [returned.id],
    );
    expect(rows[0].original_unit_cost_iqd).toBe('7.3333');
  });

  it('posts Dr Inventory / Cr COGS for the return’s stock half (Appendix C)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));

    const { rows } = await ownerPool.query(
      `select a.name, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
         join inventory_movement m on m.journal_entry_id = l.journal_entry_id
        where m.id = $1
        order by l.line_no`,
      [returned.movementIds[0]],
    );

    expect(Number(rows[0].debit_iqd)).toBe(120);
    expect(rows[0].name).toBe('Inventory');
    expect(Number(rows[1].credit_iqd)).toBe(120);
    expect(rows[1].name).toBe('Cost of Goods Sold');
  });

  it('posts Dr Sales Returns / Cr Customer A/R for the money half', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));

    const memo = await withScope(scope(manager), (tx) =>
      ccm.create(tx, manager, { salesReturnId: returned.id, memoDate: '2026-02-20' }),
    );
    await withScope(scope(manager), (tx) => ccm.approve(tx, manager, memo.id));
    const posted = await withScope(scope(manager), (tx) => ccm.post(tx, manager, memo.id));

    // 20 at the invoice's 20 each = 400.
    expect(memo.amountIqd).toBe(price('400'));

    const { rows } = await ownerPool.query(
      `select a.name, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [posted.journalEntryId],
    );

    // Sales Returns, not a reversal of Revenue: gross sales and returns stay
    // separately visible on the P&L.
    expect(rows[0].name).toBe('Sales Returns');
    expect(Number(rows[0].debit_iqd)).toBe(400);
    expect(rows[1].name).toBe('Trade Receivables');
    expect(Number(rows[1].credit_iqd)).toBe(400);
  });

  it('credits what the customer paid, not today’s price list', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    // The list price doubles after the sale.
    const { rows: items } = await ownerPool.query(`select id from item where code = $1`, [CABLE]);
    await ownerPool.query(
      `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
       values ($1,$2,'EA',40.0000,'2026-02-15')`,
      [LIST, items[0].id],
    );

    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));
    const memo = await withScope(scope(manager), (tx) =>
      ccm.create(tx, manager, { salesReturnId: returned.id, memoDate: '2026-02-20' }),
    );

    // 400, at March's price, not 800 at today's.
    expect(memo.amountIqd).toBe(price('400'));
  });
});

// ---------------------------------------------------------------------------

describe('06.9 gate · the credit memo links to the return and the invoice', () => {
  it('names both, and both are required', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));

    const memo = await withScope(scope(manager), (tx) =>
      ccm.create(tx, manager, { salesReturnId: returned.id, memoDate: '2026-02-20' }),
    );

    const view = await withScope(scope(manager), (tx) => ccm.view(tx, memo.id));
    expect(view.salesReturnId).toBe(returned.id);
    expect(view.arInvoiceId).toBe(invoice.id);

    const { rows } = await ownerPool.query(
      `select is_nullable, column_name from information_schema.columns
        where table_name = 'customer_credit_memo'
          and column_name in ('sales_return_id','ar_invoice_id')
        order by column_name`,
    );
    expect(rows.map((r) => r.is_nullable)).toEqual(['NO', 'NO']);
  });

  it('refuses a memo against a return nobody accepted', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    const created = await withScope(scope(salesUser), (tx) =>
      sr.request(tx, salesUser, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-02-18',
        reason: 'Not yet inspected',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('20') }],
      }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          ccm.create(tx, manager, { salesReturnId: created.id, memoDate: '2026-02-20' }),
        ),
      ),
    ).toMatch(/requires an \*\*accepted\*\* return|accepted return/);
  });

  it('settles the invoice when the credit is applied', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60')); // 1,200
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('60'));

    const memo = await withScope(scope(manager), (tx) =>
      ccm.create(tx, manager, { salesReturnId: returned.id, memoDate: '2026-02-20' }),
    );
    await withScope(scope(manager), (tx) => ccm.approve(tx, manager, memo.id));
    await withScope(scope(manager), (tx) => ccm.post(tx, manager, memo.id));

    const result = await withScope(scope(manager), (tx) =>
      ccm.applyTo(tx, manager, memo.id, invoice.id, price('1200')),
    );

    expect(result.status).toBe('settled');

    // The invoice closes the same way a receipt would close it — one rule, in
    // `ar-invoice.applyAllocation`, shared by both.
    const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.status).toBe('settled');
  });

  it('refuses a second live memo for the same return', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));
    const returned = await returnedAndAccepted(invoice.id, invoice.lineId, qty('20'));

    await withScope(scope(manager), (tx) =>
      ccm.create(tx, manager, { salesReturnId: returned.id, memoDate: '2026-02-20' }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          ccm.create(tx, manager, { salesReturnId: returned.id, memoDate: '2026-02-21' }),
        ),
      ),
    ).toMatch(/nothing left to credit|customer_credit_memo_return_uniq/);
  });
});

// ---------------------------------------------------------------------------

describe('06.9 · a rejected return never touches the ledger', () => {
  it('moves no stock and posts nothing', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    const before = await ownerPool.query(`
      select (select count(*)::int from inventory_movement) as movements,
             (select count(*)::int from journal_entry)      as journals
    `);

    const created = await withScope(scope(salesUser), (tx) =>
      sr.request(tx, salesUser, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-02-18',
        reason: 'Claimed faulty',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('20') }],
      }),
    );
    const view = await withScope(scope(manager), (tx) => sr.view(tx, created.id));
    await withScope(scope(manager), (tx) =>
      sr.receiveGoods(tx, manager, created.id, {
        receivedOn: '2026-02-19',
        lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: qty('20') }],
      }),
    );
    await withScope(scope(manager), (tx) =>
      sr.reject(tx, manager, created.id, 'Goods were used, not faulty'),
    );

    const after = await ownerPool.query(`
      select (select count(*)::int from inventory_movement) as movements,
             (select count(*)::int from journal_entry)      as journals
    `);

    // The whole reason the movement waits for acceptance: goods the company
    // never took back leave no reversing entries to explain later.
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it('requires a reason to reject (§5.4)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const invoice = await soldAndInvoiced(qty('60'));

    const created = await withScope(scope(salesUser), (tx) =>
      sr.request(tx, salesUser, {
        arInvoiceId: invoice.id,
        requestedOn: '2026-02-18',
        reason: 'Claimed faulty',
        lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('20') }],
      }),
    );

    expect(
      await rejection(withScope(scope(manager), (tx) => sr.reject(tx, manager, created.id, '  '))),
    ).toMatch(/requires a reason/);
  });
});
