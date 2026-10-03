/**
 * Phase 06.5 test gate — Delivery Note and Proof of Delivery. §7.2, §7.4, §7.7.
 *
 *   - Multiple partial deliveries against one order accumulate and close the
 *     line at full delivery
 *   - Delivery consumes the reserved stock, not unreserved stock
 *   - COGS is the FIFO cost of the specific layers consumed (Phase 04.2)
 *   - Proof of Delivery captures all four elements and attaches through the
 *     Phase 01 attachment service
 *   - Delivery quantities reconcile to the source Sales Order (§7.7)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as so from '@/server/services/sales-order';
import * as pick from '@/server/services/pick-list';
import * as dn from '@/server/services/delivery-note';
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal, toDecimalString } from '@domain/money';
import { availableQuantity } from '@domain/inventory';

const BAGHDAD = 'BGW';
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

/** Puts a FIFO layer on the shelf at a stated cost. */
async function receive(quantity: bigint, unitCost: string, batch: string) {
  await withScope(scope(manager), (tx) =>
    inventory.receive(
      tx,
      manager,
      {
        itemCode: CABLE,
        warehouseCode: WAREHOUSE,
        branchCode: BAGHDAD,
        quantity,
        unitCostIqd: price(unitCost),
        movementDate: '2026-02-01',
        kind: 'opening_stock',
        batchNumber: batch,
      },
    ),
  );
}

/**
 * A clean attachment, through the Phase 01 table.
 *
 * §21 refuses to link anything that is not scanned clean, which the Proof of
 * Delivery relies on — so the fixture creates real attachment rows rather than
 * inventing ids.
 */
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

  // §3.3 — *"posting accounts shall be selected through configurable accounting
  // mappings, not hard-coded account numbers."* The delivery posts Dr COGS / Cr
  // Inventory (Appendix C), so both roles need an account mapped before it can
  // post at all. That refusal is itself proved in Phase 02; here it is a
  // precondition of the test rather than the subject of it.
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['cogs', 'X000001', 'Cost of Goods Sold'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = $1`,
      [parent],
    );
    const { rows: account } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction)
       values ($1, $2,
               (select account_type from chart_of_account where code = $3),
               $4, false, true, 'approved', 1, 'IQD')
       returning id`,
      [`${parent.slice(0, 1)}90000${role.length}`, name, parent, parents[0].id],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('inventory.delivery', $1, $2, true, $3)
       on conflict do nothing`,
      [role, account[0].id, manager.principal.userId],
    );
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('inventory.opening_stock', $1, $2, true, $3)
       on conflict do nothing`,
      [role, account[0].id, manager.principal.userId],
    );
  }

  // §4.2 — the department this sale is attributed to. Business lines are seeded
  // by migration 0010, so only the department has to be made here.
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('SALES','Sales',false)
     on conflict (code) do nothing`,
  );

  // §2.3 — every journal line carries a USD equivalent at the historical rate,
  // so a rate has to be effective on the posting date before anything can post.
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1)
     on conflict do nothing`,
    [manager.principal.userId],
  );

  // A period to post into. Without one the delivery's journal has nowhere to go.
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

/** An approved order for `quantity`, with stock already on the shelf. */
async function approvedOrder(quantity: bigint) {
  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      orderDate: '2026-02-10',
      // §4.2 — where this sale lands in the P&L. The COGS account requires both.
      departmentCode: 'SALES',
      businessLineCode: 'PRODUCT_SALES',
      lines: [
        {
          itemCode: CABLE,
          quantity,
          uomCode: 'EA',
          warehouseCode: WAREHOUSE,
          branchCode: BAGHDAD,
        },
      ],
    }),
  );
  await withScope(scope(manager), (tx) => so.approve(tx, manager, order.id));
  return order;
}

/** Picks `quantity` against the order, from `batch`, and returns the sheet. */
async function picked(salesOrderId: string, quantity: bigint, batch: string) {
  const outstanding = await withScope(scope(manager), (tx) =>
    pick.outstandingFor(tx, salesOrderId, WAREHOUSE),
  );

  const sheet = await withScope(scope(manager), (tx) =>
    pick.create(tx, manager, {
      salesOrderId,
      warehouseCode: WAREHOUSE,
      pickDate: '2026-02-12',
      lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity }],
    }),
  );
  await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));

  const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
  await withScope(scope(manager), (tx) =>
    pick.pick(tx, manager, sheet.id, [
      {
        pickListLineId: view.lines[0]!.id,
        quantity,
        units: [{ batchNumber: batch, quantity }],
      },
    ]),
  );

  return sheet.id;
}

/** Raises, approves, proves and delivers a note for a picked sheet. */
async function deliverSheet(pickListId: string, deliveryDate = '2026-02-13') {
  const note = await withScope(scope(manager), (tx) =>
    dn.create(tx, manager, { pickListId, deliveryDate }),
  );
  await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

  const signature = await attachment('signature.png', 'image/png');
  const photo = await attachment('van.jpg');

  await withScope(scope(manager), (tx) =>
    dn.recordProofOfDelivery(tx, manager, note.id, {
      recipientName: 'Ahmed Kareem',
      recipientRole: 'Store manager',
      signatureAttachmentId: signature,
      photoAttachmentIds: [photo],
      receivedAt: new Date('2026-02-13T09:30:00Z'),
    }),
  );

  const result = await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));
  return { ...note, ...result };
}

// ---------------------------------------------------------------------------

describe('06.5 gate · partial and multiple deliveries from one Sales Order (§7.2)', () => {
  it('accumulates across notes and closes the line at full delivery', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));

    await deliverSheet(await picked(order.id, qty('60'), 'B-1'));

    let reconciliation = await withScope(scope(manager), (tx) =>
      dn.reconcileToOrder(tx, order.id),
    );
    expect(reconciliation[0]!.delivered).toBe('60.000000');

    let { rows } = await ownerPool.query(`select status from sales_order where id = $1`, [order.id]);
    expect(rows[0].status).toBe('partially_executed');

    await deliverSheet(await picked(order.id, qty('40'), 'B-1'), '2026-02-14');

    reconciliation = await withScope(scope(manager), (tx) => dn.reconcileToOrder(tx, order.id));
    expect(reconciliation[0]!.delivered).toBe('100.000000');

    ({ rows } = await ownerPool.query(`select status from sales_order where id = $1`, [order.id]));
    expect(rows[0].status).toBe('executed');
  });

  it('refuses the delivery that would take the order past what was ordered (§7.7)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));

    await deliverSheet(await picked(order.id, qty('100'), 'B-1'));

    // The order is Delivered, so the chain refuses at its first link rather than
    // its last: there is no second pick to raise, so no second note, so no
    // over-delivery to catch. The cheapest refusal is the earliest one.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          pick.create(tx, manager, {
            salesOrderId: order.id,
            warehouseCode: WAREHOUSE,
            pickDate: '2026-02-14',
          }),
        ),
      ),
    ).toMatch(/nothing can be picked against it/);
  });

  it('refuses a delivery line written straight to the table beyond the order (§7.7)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));
    const sheet = await picked(order.id, qty('60'), 'B-1');
    const note = await deliverSheet(sheet);

    const { rows } = await ownerPool.query(
      `select id, sales_order_line_id, pick_list_line_id, item_code, description, uom_code
         from delivery_note_line where delivery_note_id = $1`,
      [note.id],
    );

    expect(
      await rejection(
        ownerPool.query(`update delivery_note_line set quantity = 200 where id = $1`, [
          rows[0].id,
        ]),
      ),
    ).toMatch(/would exceed the Sales Order|when 60\.\d+ was picked/);
  });

  it('refuses a second note against a pick already delivered', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));
    const sheet = await picked(order.id, qty('60'), 'B-1');
    await deliverSheet(sheet);

    // Delivering completes the sheet (Appendix B), and a Completed sheet is no
    // longer Picked — so the same units cannot be loaded onto a second van.
    // Two guards, and the status is the one that speaks first.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-14' }),
        ),
      ),
    ).toMatch(/must be Picked before there is anything to deliver/);
  });

  it('refuses a second note even against a pick that is still Picked', async () => {
    // The other guard, on its own: a sheet whose note was raised but not yet
    // delivered is still Picked, and a second note against it would send the
    // same units twice.
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));
    const sheet = await picked(order.id, qty('60'), 'B-1');

    await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-13' }),
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-14' }),
        ),
      ),
    ).toMatch(/already delivered on/);
  });

  it('refuses a note against a sheet that has not been picked', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));

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

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          dn.create(tx, manager, { pickListId: sheet.id, deliveryDate: '2026-02-13' }),
        ),
      ),
    ).toMatch(/must be Picked before there is anything to deliver/);
  });
});

// ---------------------------------------------------------------------------

describe('06.5 gate · a delivery consumes the reserved stock, not unreserved stock', () => {
  it('leaves everybody else’s availability untouched', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));

    const before = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );
    expect(before.onHand).toBe(qty('500'));
    expect(before.reserved).toBe(qty('100'));
    expect(availableQuantity(before)).toBe(qty('400'));

    await deliverSheet(await picked(order.id, qty('100'), 'B-1'));

    const after = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );

    // The 100 that left were the 100 this order had promised. The 400 available
    // to everyone else is the same 400 it was before.
    expect(after.onHand).toBe(qty('400'));
    expect(after.reserved).toBe(0n);
    expect(availableQuantity(after)).toBe(qty('400'));
  });

  it('re-reserves the undelivered remainder on a partial delivery', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));

    await deliverSheet(await picked(order.id, qty('60'), 'B-1'));

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );

    // 60 gone, 40 still promised to this order, 400 still free.
    expect(position.onHand).toBe(qty('440'));
    expect(position.reserved).toBe(qty('40'));
    expect(availableQuantity(position)).toBe(qty('400'));
  });

  it('keeps the released reservation, with the reason it ended (§5.4)', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));
    await deliverSheet(await picked(order.id, qty('60'), 'B-1'));

    const { rows } = await ownerPool.query(
      `select quantity, released_at, release_reason
         from stock_reservation
        where document_id = $1
        order by reserved_at`,
      [order.id],
    );

    // The original promise is kept and marked released; the remainder is a new
    // row. A decremented quantity would answer neither "who let it go" nor "how
    // much was promised in the first place".
    expect(rows).toHaveLength(2);
    expect(rows[0].released_at).not.toBeNull();
    expect(rows[0].release_reason).toMatch(/Delivered on DN-/);
    expect(Number(rows[0].quantity)).toBe(100);
    expect(rows[1].released_at).toBeNull();
    expect(Number(rows[1].quantity)).toBe(40);
  });
});

// ---------------------------------------------------------------------------

describe('06.5 gate · COGS is the FIFO cost of the layers consumed (Phase 04.2)', () => {
  it('costs across two layers at their own prices', async () => {
    // 100 at 6, then 100 at 10. Delivering 150 takes the older layer whole and
    // half of the newer one: 100×6 + 50×10 = 1100.
    await receive(qty('100'), '6', 'B-OLD');
    await receive(qty('100'), '10', 'B-NEW');

    const order = await approvedOrder(qty('150'));
    const result = await deliverSheet(await picked(order.id, qty('150'), 'B-OLD'));

    expect(toDecimalString(result.cogsIqd, 4n)).toBe('1100.0000');

    const { rows } = await ownerPool.query(
      `select cogs_iqd from delivery_note where id = $1`,
      [result.id],
    );
    expect(rows[0].cogs_iqd).toBe('1100.0000');
  });

  it('posts Dr COGS / Cr Inventory in the same transaction as the movement (Appendix C)', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));
    const result = await deliverSheet(await picked(order.id, qty('100'), 'B-1'));

    const { rows: note } = await ownerPool.query(
      `select journal_entry_id from delivery_note where id = $1`,
      [result.id],
    );
    expect(note[0].journal_entry_id).not.toBeNull();

    const { rows: lines } = await ownerPool.query(
      `select a.account_type, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [note[0].journal_entry_id],
    );

    const debit = lines.find((r) => Number(r.debit_iqd) > 0);
    const credit = lines.find((r) => Number(r.credit_iqd) > 0);

    expect(Number(debit.debit_iqd)).toBe(600);
    expect(Number(credit.credit_iqd)).toBe(600);
    expect(debit.account_type).toBe('expense');
    expect(credit.account_type).toBe('asset');
  });

  it('records the cost against the line, and does not recompute it later', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const result = await deliverSheet(await picked(order.id, qty('60'), 'B-1'));

    const { rows } = await ownerPool.query(
      `select cogs_iqd, inventory_movement_id from delivery_note_line where delivery_note_id = $1`,
      [result.id],
    );

    expect(rows[0].cogs_iqd).toBe('360.0000');
    expect(rows[0].inventory_movement_id).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('06.5 gate · Proof of Delivery captures all four elements (§7.2)', () => {
  it('stores the name, the signature, the photos and when they were received', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const sheet = await picked(order.id, qty('60'), 'B-1');

    const note = await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-13' }),
    );
    await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

    const signature = await attachment('signature.png', 'image/png');
    const photos = [await attachment('front.jpg'), await attachment('unloaded.jpg')];

    await withScope(scope(manager), (tx) =>
      dn.recordProofOfDelivery(tx, manager, note.id, {
        recipientName: 'Ahmed Kareem',
        recipientRole: 'Store manager',
        signatureAttachmentId: signature,
        photoAttachmentIds: photos,
        receivedAt: new Date('2026-02-13T09:30:00Z'),
        note: 'Left at the loading bay',
      }),
    );

    const proof = await withScope(scope(manager), (tx) => dn.proofFor(tx, note.id));

    expect(proof!.recipientName).toBe('Ahmed Kareem');
    expect(proof!.signatureAttachmentId).toBe(signature);
    expect(proof!.photos.map((p) => p.attachmentId)).toEqual(photos);
    expect(proof!.receivedAt.toISOString()).toBe('2026-02-13T09:30:00.000Z');
  });

  it('refuses to deliver without a proof', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const sheet = await picked(order.id, qty('60'), 'B-1');

    const note = await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-13' }),
    );
    await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

    expect(
      await rejection(withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id))),
    ).toMatch(/Proof of Delivery is missing/);
  });

  it('refuses a proof with no photograph', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const sheet = await picked(order.id, qty('60'), 'B-1');

    const note = await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-13' }),
    );
    await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

    const signature = await attachment('signature.png', 'image/png');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          dn.recordProofOfDelivery(tx, manager, note.id, {
            recipientName: 'Ahmed Kareem',
            signatureAttachmentId: signature,
            photoAttachmentIds: [],
            receivedAt: new Date('2026-02-13T09:30:00Z'),
          }),
        ),
      ),
    ).toMatch(/at least one delivery photo/);
  });

  it('refuses an attachment that has not been scanned clean (§21)', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const sheet = await picked(order.id, qty('60'), 'B-1');

    const note = await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet, deliveryDate: '2026-02-13' }),
    );
    await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

    const quarantined = randomUUID();
    await ownerPool.query(
      `insert into attachment
         (id, object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key,
          scan_status, scanned_at, uploaded_by, branch_code)
       values ($1,'delivery_note',$2,'suspect.jpg','image/jpeg',2048,$3,$4,'infected',now(),$5,$6)`,
      [
        quarantined,
        quarantined,
        createHash('sha256').update(quarantined).digest('hex'),
        `pod/${quarantined}`,
        manager.principal.userId,
        BAGHDAD,
      ],
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          dn.recordProofOfDelivery(tx, manager, note.id, {
            recipientName: 'Ahmed Kareem',
            signatureAttachmentId: quarantined,
            photoAttachmentIds: [],
            receivedAt: new Date('2026-02-13T09:30:00Z'),
          }),
        ),
      ),
    ).toMatch(/at least one delivery photo/);

    // And with the photo supplied, the quarantined signature is what stops it.
    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          dn.recordProofOfDelivery(tx, manager, note.id, {
            recipientName: 'Ahmed Kareem',
            signatureAttachmentId: quarantined,
            photoAttachmentIds: [quarantined],
            receivedAt: new Date('2026-02-13T09:30:00Z'),
          }),
        ),
      ),
    ).toMatch(/only a clean attachment may be linked/);
  });

  it('keeps the proof: it cannot be edited or deleted afterwards (§5.4)', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const result = await deliverSheet(await picked(order.id, qty('60'), 'B-1'));

    expect(
      await rejection(
        ownerPool.query(
          `update proof_of_delivery set recipient_name = 'Somebody else' where delivery_note_id = $1`,
          [result.id],
        ),
      ),
    ).toMatch(/append-only/);

    expect(
      await rejection(
        ownerPool.query(`delete from proof_of_delivery where delivery_note_id = $1`, [result.id]),
      ),
    ).toMatch(/append-only/);
  });
});

// ---------------------------------------------------------------------------

describe('06.5 · the chain reconciles and carries its identities (§7.7, §9.9)', () => {
  it('reconciles ordered, reserved, picked, delivered and invoiced on one row', async () => {
    await receive(qty('500'), '6', 'B-1');
    const order = await approvedOrder(qty('100'));
    await deliverSheet(await picked(order.id, qty('60'), 'B-1'));

    const rows = await withScope(scope(manager), (tx) => dn.reconcileToOrder(tx, order.id));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.ordered).toBe('100.000000');
    expect(rows[0]!.picked).toBe('60.000000');
    expect(rows[0]!.delivered).toBe('60.000000');
    expect(rows[0]!.invoiced).toBe('0.000000');
    // The **live** reservation: 40, re-reserved when the 60 went out. Not the
    // 100 the order recorded at approval — a report still showing that would
    // contradict the stock position on the next screen, and §7.7 asks these
    // figures to reconcile with each other.
    expect(rows[0]!.reserved).toBe('40.000000');
  });

  it('carries the picked batch onto the note and onto the movement (§9.9)', async () => {
    await receive(qty('100'), '6', 'B-TRACE');
    const order = await approvedOrder(qty('60'));
    const result = await deliverSheet(await picked(order.id, qty('60'), 'B-TRACE'));

    const view = await withScope(scope(manager), (tx) => dn.view(tx, result.id));
    expect(view.units.map((u) => u.batchNumber)).toEqual(['B-TRACE']);

    const trail = await withScope(scope(manager), (tx) =>
      inventory.traceIdentity(tx, CABLE, { batchNumber: 'B-TRACE' }),
    );

    // Receipt then delivery — the two ends of §9.9's chain.
    expect(trail.map((m) => m.kind)).toEqual(['opening_stock', 'delivery']);
  });

  it('completes the pick sheet when the delivery is made (Appendix B)', async () => {
    await receive(qty('100'), '6', 'B-1');
    const order = await approvedOrder(qty('60'));
    const sheet = await picked(order.id, qty('60'), 'B-1');

    await deliverSheet(sheet);

    const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet));
    expect(view.status).toBe('closed');
  });

  it('has no Cancelled state — Appendix B gives it none', async () => {
    const { rows } = await ownerPool.query(
      `select to_status::text from document_status_transition
        where document_type_code = 'delivery_note'
        order by from_status, to_status`,
    );

    // Once stock has moved, the correction is a reversal.
    expect(rows.map((r) => r.to_status)).not.toContain('cancelled');
    expect(rows.map((r) => r.to_status)).toContain('reversed');
  });
});
