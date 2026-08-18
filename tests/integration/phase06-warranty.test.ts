/**
 * Phase 06.7 test gate — Warranty. §7.4, §9.3.
 *
 *   - Warranty end date = invoice date + item warranty duration, computed
 *     automatically
 *   - Warranty lookup by serial number returns the correct invoice and end date
 *   - Items without a warranty duration produce no warranty record rather than a
 *     zero-length one
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
import * as warranty from '@/server/services/warranty';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
/** Serial-tracked and covered for a year. */
const LAPTOP = 'ITM-LAPTOP';
/** Batch-tracked and sold without cover — §9.3's optional fields. */
const CABLE = 'ITM-CABLE';
const LIST = 'PL-RETAIL';
const WAREHOUSE = `WH-${BAGHDAD}`;

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

async function receive(
  itemCode: string,
  quantity: bigint,
  identity: { serialNumber?: string; batchNumber?: string },
) {
  await withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity,
      unitCostIqd: price('6'),
      movementDate: '2026-02-01',
      kind: 'opening_stock',
      ...identity,
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

  // §9.3 — warranty fields are optional. The laptop carries a year; the cable
  // carries nothing, which is a different thing from zero.
  for (const [code, name, tracking, months] of [
    [LAPTOP, 'Field Laptop', 'serial', 12],
    [CABLE, 'Network Cable 2m', 'batch', null],
  ] as const) {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, is_stock, base_uom_code, tracking, warranty_months)
         values ($1,$2,true,'EA',$3,$4) returning id`,
        [code, name, tracking, months],
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
  manager = await createUser('accounting_manager');

  await ownerPool.query(
    `insert into price_list (code, name, currency, active) values ($1,'Retail','IQD',true)`,
    [LIST],
  );
  const { rows: items } = await ownerPool.query(`select id from item`);
  for (const row of items) {
    await ownerPool.query(
      `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
       values ($1,$2,'EA',20.0000,'2026-01-01')`,
      [LIST, row.id],
    );
  }

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
    ['sales.ar_invoice', 'customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['sales.ar_invoice', 'sales_revenue', 'R000001', 'Sales Revenue', null],
  ] as const) {
    const code = `${parent.slice(0, 1)}9${role.slice(0, 4).toUpperCase()}`;
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

/** Order → pick → deliver → invoice → post, for one item. */
async function sell(
  itemCode: string,
  quantity: bigint,
  units: readonly { serialNumber?: string; batchNumber?: string; quantity: bigint }[],
  deliveryDate = '2026-02-13',
) {
  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-10',
      departmentCode: 'SALES',
      businessLineCode: 'PRODUCT_SALES',
      lines: [
        { itemCode, quantity, uomCode: 'EA', warehouseCode: WAREHOUSE, branchCode: BAGHDAD },
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
      { pickListLineId: sheetView.lines[0]!.id, quantity, units },
    ]),
  );

  const note = await withScope(scope(manager), (tx) =>
    dn.create(tx, manager, { pickListId: sheet.id, deliveryDate }),
  );
  await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

  const signature = await attachment('signature.png', 'image/png');
  const photo = await attachment('van.jpg');
  await withScope(scope(manager), (tx) =>
    dn.recordProofOfDelivery(tx, manager, note.id, {
      recipientName: 'Ahmed Kareem',
      signatureAttachmentId: signature,
      photoAttachmentIds: [photo],
      receivedAt: new Date(`${deliveryDate}T09:30:00Z`),
    }),
  );
  await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));

  const invoice = await withScope(scope(salesUser), (tx) =>
    ar.create(tx, salesUser, { deliveryNoteId: note.id }),
  );
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));

  return invoice;
}


// ---------------------------------------------------------------------------

describe('06.7 gate · the end date is calculated automatically (§7.4)', () => {
  it('registers a year from the invoice date', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });

    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    const rows = await withScope(scope(manager), (tx) => warranty.forInvoice(tx, invoice.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.startsOn).toBe('2026-02-13');
    expect(rows[0]!.endsOn).toBe('2027-02-13');
    expect(rows[0]!.warrantyMonths).toBe(12);
  });

  it('refuses an end date typed by hand, whatever route wrote it (§7.4)', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    const { rows } = await ownerPool.query(
      `select id from warranty_registration where ar_invoice_id = $1`,
      [invoice.id],
    );

    // The register is append-only, so an extension cannot even be attempted by
    // editing — which is the point: a warranty the company can quietly lengthen
    // or shorten is not a warranty certificate.
    expect(
      await rejection(
        ownerPool.query(`update warranty_registration set ends_on = '2030-01-01' where id = $1`, [
          rows[0].id,
        ]),
      ),
    ).toMatch(/append-only/);
  });

  it('refuses an inserted registration whose dates were not calculated', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    const { rows } = await ownerPool.query(
      `select ar_invoice_line_id, item_code from warranty_registration where ar_invoice_id = $1`,
      [invoice.id],
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into warranty_registration
             (ar_invoice_id, ar_invoice_line_id, customer_id, branch_code, item_code,
              serial_number, quantity, warranty_months, starts_on, ends_on, created_by)
           values ($1, $2, $3, $4, $5, 'SN-FORGED', 1, 12, '2026-02-13', '2099-01-01', $6)`,
          [
            invoice.id,
            rows[0].ar_invoice_line_id,
            customerId,
            BAGHDAD,
            rows[0].item_code,
            manager.principal.userId,
          ],
        ),
      ),
    ).toMatch(/end date is calculated, not entered/);
  });

  it('refuses a start date that is not the invoice date (§7.4)', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    const { rows } = await ownerPool.query(
      `select ar_invoice_line_id, item_code from warranty_registration where ar_invoice_id = $1`,
      [invoice.id],
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into warranty_registration
             (ar_invoice_id, ar_invoice_line_id, customer_id, branch_code, item_code,
              serial_number, quantity, warranty_months, starts_on, ends_on, created_by)
           values ($1, $2, $3, $4, $5, 'SN-BACKDATED', 1, 12, '2026-01-01', '2027-01-01', $6)`,
          [
            invoice.id,
            rows[0].ar_invoice_line_id,
            customerId,
            BAGHDAD,
            rows[0].item_code,
            manager.principal.userId,
          ],
        ),
      ),
    ).toMatch(/starts on the A\/R Invoice date/);
  });

  it('keeps what was sold when the item’s duration later changes', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    // Product Management shortens the standard cover next year.
    await ownerPool.query(`update item set warranty_months = 3 where code = $1`, [LAPTOP]);

    const found = await withScope(scope(manager), (tx) => warranty.lookupBySerial(tx, 'SN-1'));

    // The customer keeps the two years they bought. The duration was copied at
    // the moment of sale, not looked up on read.
    expect(found!.warrantyMonths).toBe(12);
    expect(found!.endsOn).toBe('2027-02-13');
    expect(invoice.invoiceNo).toBe(found!.invoiceNo);
  });
});

// ---------------------------------------------------------------------------

describe('06.7 gate · lookup by serial returns the invoice and the end date (§7.4)', () => {
  it('answers the question a counter actually asks', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-A' });
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-B' });

    const first = await sell(LAPTOP, qty('1'), [{ serialNumber: 'SN-A', quantity: qty('1') }]);
    const second = await sell(
      LAPTOP,
      qty('1'),
      [{ serialNumber: 'SN-B', quantity: qty('1') }],
      '2026-02-20',
    );

    const a = await withScope(scope(manager), (tx) => warranty.lookupBySerial(tx, 'SN-A'));
    const b = await withScope(scope(manager), (tx) => warranty.lookupBySerial(tx, 'SN-B'));

    expect(a!.invoiceNo).toBe(first.invoiceNo);
    expect(a!.endsOn).toBe('2027-02-13');
    expect(a!.customerCode).toBe('CUST-001');

    // The same item, a week later, is covered a week longer.
    expect(b!.invoiceNo).toBe(second.invoiceNo);
    expect(b!.endsOn).toBe('2027-02-20');
  });

  it('returns nothing for a serial that was never sold', async () => {
    const found = await withScope(scope(manager), (tx) =>
      warranty.lookupBySerial(tx, 'SN-NEVER-SOLD'),
    );
    expect(found).toBeNull();
  });

  it('registers one row per serial, not one per line', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-2' });

    const invoice = await sell(LAPTOP, qty('2'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
      { serialNumber: 'SN-2', quantity: qty('1') },
    ]);

    const rows = await withScope(scope(manager), (tx) => warranty.forInvoice(tx, invoice.id));

    // §7.4's lookup is by serial, which only works if a serial has its own row.
    expect(rows.map((r) => r.serialNumber)).toEqual(['SN-1', 'SN-2']);
    expect(rows.every((r) => Number(r.quantity) === 1)).toBe(true);
  });

  it('reports what is expiring in a window', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    await sell(LAPTOP, qty('1'), [{ serialNumber: 'SN-1', quantity: qty('1') }]);

    const expiring = await withScope(scope(manager), (tx) =>
      warranty.expiringBetween(tx, '2027-02-01', '2027-02-28'),
    );
    expect(expiring).toHaveLength(1);

    const none = await withScope(scope(manager), (tx) =>
      warranty.expiringBetween(tx, '2027-03-01', '2027-03-31'),
    );
    expect(none).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('06.7 gate · no duration means no record, not a zero-length one (§9.3)', () => {
  it('registers nothing for an item sold without cover', async () => {
    await receive(CABLE, qty('100'), { batchNumber: 'B-1' });

    const invoice = await sell(CABLE, qty('60'), [
      { batchNumber: 'B-1', quantity: qty('60') },
    ]);

    const rows = await withScope(scope(manager), (tx) => warranty.forInvoice(tx, invoice.id));

    // Not a row with zero months — no row. The two look alike in a database and
    // behave differently at a counter.
    expect(rows).toEqual([]);
  });

  it('has no way to record a zero-month warranty at all', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    const { rows } = await ownerPool.query(
      `select ar_invoice_line_id, item_code from warranty_registration where ar_invoice_id = $1`,
      [invoice.id],
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into warranty_registration
             (ar_invoice_id, ar_invoice_line_id, customer_id, branch_code, item_code,
              serial_number, quantity, warranty_months, starts_on, ends_on, created_by)
           values ($1, $2, $3, $4, $5, 'SN-ZERO', 1, 0, '2026-02-13', '2026-02-13', $6)`,
          [
            invoice.id,
            rows[0].ar_invoice_line_id,
            customerId,
            BAGHDAD,
            rows[0].item_code,
            manager.principal.userId,
          ],
        ),
      ),
    ).toMatch(/months_positive|ends_after_start/);
  });

  it('bills both items on one order and covers only the one with a duration', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    await receive(CABLE, qty('100'), { batchNumber: 'B-1' });

    const laptop = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);
    const cable = await sell(
      CABLE,
      qty('60'),
      [{ batchNumber: 'B-1', quantity: qty('60') }],
      '2026-02-14',
    );

    expect(
      await withScope(scope(manager), (tx) => warranty.forInvoice(tx, laptop.id)),
    ).toHaveLength(1);
    expect(
      await withScope(scope(manager), (tx) => warranty.forInvoice(tx, cable.id)),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('06.7 · one physical unit is covered once (§9.3, §9.9)', () => {
  it('refuses a second registration of the same serial', async () => {
    await receive(LAPTOP, qty('1'), { serialNumber: 'SN-1' });
    const invoice = await sell(LAPTOP, qty('1'), [
      { serialNumber: 'SN-1', quantity: qty('1') },
    ]);

    const { rows } = await ownerPool.query(
      `select ar_invoice_line_id, item_code from warranty_registration where ar_invoice_id = $1`,
      [invoice.id],
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into warranty_registration
             (ar_invoice_id, ar_invoice_line_id, customer_id, branch_code, item_code,
              serial_number, quantity, warranty_months, starts_on, ends_on, created_by)
           values ($1, $2, $3, $4, $5, 'SN-1', 1, 12, '2026-02-13', '2027-02-13', $6)`,
          [
            invoice.id,
            rows[0].ar_invoice_line_id,
            customerId,
            BAGHDAD,
            rows[0].item_code,
            manager.principal.userId,
          ],
        ),
      ),
    ).toMatch(/warranty_registration_serial_uniq|duplicate key/);
  });
});
