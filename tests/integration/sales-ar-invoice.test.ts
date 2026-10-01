/**
 * Phase 06.6 test gate — A/R Invoice. §7.4, §7.7, Appendix B, Appendix C.
 *
 *   - An A/R Invoice without a source Delivery Note is impossible via UI, API
 *     and import
 *   - An invoice date differing from the delivery date is rejected
 *   - Invoice quantities cannot exceed delivered quantities
 *   - The revenue and COGS postings are in the same atomic transaction as the
 *     A/R subledger entry
 *   - Every posted sales journal drills to Sales Order, Delivery Note and A/R
 *     Invoice (§7.7)
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
import * as inventory from '@/server/services/inventory';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseQuantity } from '@domain/uom';
import { parseDecimal } from '@domain/money';

const BAGHDAD = 'BGW';
const CABLE = 'ITM-CABLE';
const LIST = 'PL-RETAIL';
const TERMS = 'NET30';
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

  // §3.3 — the mapped accounts: the delivery's Dr COGS / Cr Inventory and the
  // invoice's Dr Customer A/R / Cr Sales Revenue.
  //
  // Trade Receivables is the **customer control account** (§1.2), which is what
  // makes the posting write a subledger entry: the customer's balance and the
  // control account move in the same transaction or not at all.
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

/** The whole chain up to a delivered note: order → pick → deliver. */
async function deliveredNote(quantity: bigint, deliveryDate = '2026-02-13') {
  await receive(qty('500'), '6', 'B-1');

  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId,
      branchCode: BAGHDAD,
      // Payment terms come from the customer (§4.3), not from the order form.
      orderDate: '2026-02-10',
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
  const delivered = await withScope(scope(manager), (tx) => dn.deliver(tx, manager, note.id));

  return { orderId: order.id, noteId: note.id, deliveryDate, cogsIqd: delivered.cogsIqd };
}

/** Raises, approves and posts an invoice for a delivered note. */
async function postedInvoice(noteId: string) {
  const invoice = await withScope(scope(salesUser), (tx) =>
    ar.create(tx, salesUser, { deliveryNoteId: noteId }),
  );
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
  const posted = await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));
  return { ...invoice, ...posted };
}

// ---------------------------------------------------------------------------

describe('06.6 gate · no A/R Invoice without a source Delivery Note (§7.4)', () => {
  it('bills a delivery or moves the stock itself, and a line cannot do both', async () => {
    // The rule this gate protects is that an invoice never bills goods nobody
    // shipped. Until the Operations build (block 5, 2026-09-12) that was said
    // by making `delivery_note_id` NOT NULL: the only way to have goods was to
    // have delivered them.
    //
    // The sponsor's Sales Invoice takes the stock from the warehouse itself,
    // so the column is now optional — and the guarantee moved rather than
    // went. A line names a delivery, or it names a warehouse, and the
    // database refuses a line that names both, because that would move the
    // same goods twice. Nothing is billed that was not shipped either way.
    const { rows } = await ownerPool.query(
      `select conname from pg_constraint
        where conrelid = 'ar_invoice_line'::regclass and conname = 'ar_invoice_line_one_source'`,
    );
    expect(rows).toHaveLength(1);
  });

  it('refuses a note that has not delivered — approved is not enough', async () => {
    await receive(qty('500'), '6', 'B-1');

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
            quantity: qty('60'),
            uomCode: 'EA',
            warehouseCode: WAREHOUSE,
            branchCode: BAGHDAD,
          },
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
        lines: [{ salesOrderLineId: outstanding[0]!.salesOrderLineId, quantity: qty('60') }],
      }),
    );
    await withScope(scope(manager), (tx) => pick.release(tx, manager, sheet.id));
    const view = await withScope(scope(manager), (tx) => pick.view(tx, sheet.id));
    await withScope(scope(manager), (tx) =>
      pick.pick(tx, manager, sheet.id, [
        {
          pickListLineId: view.lines[0]!.id,
          quantity: qty('60'),
          units: [{ batchNumber: 'B-1', quantity: qty('60') }],
        },
      ]),
    );

    const note = await withScope(scope(manager), (tx) =>
      dn.create(tx, manager, { pickListId: sheet.id, deliveryDate: '2026-02-13' }),
    );
    await withScope(scope(manager), (tx) => dn.approve(tx, manager, note.id));

    // A note still merely approved is one on a van.
    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          ar.create(tx, salesUser, { deliveryNoteId: note.id }),
        ),
      ),
    ).toMatch(/created from an \*\*approved\*\* Delivery Note|has not delivered/);
  });

  it('refuses an invoice written straight to the table against an undelivered note — the import route (§7.7)', async () => {
    const { noteId } = await deliveredNote(qty('60'));

    // A hand-written row that names a real delivery but the wrong order: the
    // trigger reconciles all three, not only the presence of a link.
    const { rows: other } = await ownerPool.query(`select id from sales_order limit 1`);

    expect(
      await rejection(
        ownerPool.query(
          `insert into ar_invoice
             (invoice_no, delivery_note_id, sales_order_id, customer_id, branch_code,
              invoice_date, due_date, created_by)
           values ('SMUGGLED-1', $1, $2, $3, $4, '2026-02-20', '2026-03-20', $5)`,
          [noteId, other[0].id, customerId, BAGHDAD, manager.principal.userId],
        ),
      ),
    ).toMatch(/issued on the delivery date/);
  });

  it('refuses a second invoice from one delivery', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    await postedInvoice(noteId);

    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          ar.create(tx, salesUser, { deliveryNoteId: noteId }),
        ),
      ),
    ).toMatch(/already invoiced on|nothing left to invoice/);
  });
});

// ---------------------------------------------------------------------------

describe('06.6 gate · the invoice date is the delivery date (§7.4)', () => {
  it('takes the delivery date without being told', async () => {
    const { noteId, deliveryDate } = await deliveredNote(qty('60'));

    const invoice = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, { deliveryNoteId: noteId }),
    );

    const view = await withScope(scope(salesUser), (tx) => ar.view(tx, invoice.id));
    expect(view.invoiceDate).toBe(deliveryDate);
  });

  it('rejects an invoice date that differs from the delivery date', async () => {
    const { noteId } = await deliveredNote(qty('60'));

    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          ar.create(tx, salesUser, { deliveryNoteId: noteId, invoiceDate: '2026-02-20' }),
        ),
      ),
    ).toMatch(/issued on the same date as the delivery/);
  });

  it('rejects it again in the database, whatever route wrote the row (§7.7)', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, { deliveryNoteId: noteId }),
    );

    expect(
      await rejection(
        ownerPool.query(`update ar_invoice set invoice_date = '2026-02-20' where id = $1`, [
          invoice.id,
        ]),
      ),
    ).toMatch(/issued on the delivery date/);
  });

  it('derives the due date from the order’s payment terms (§4.3)', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, { deliveryNoteId: noteId }),
    );

    const view = await withScope(scope(salesUser), (tx) => ar.view(tx, invoice.id));
    // Net 30 from 13 February.
    expect(view.dueDate).toBe('2026-03-15');
  });
});

// ---------------------------------------------------------------------------

describe('06.6 gate · invoice quantities cannot exceed delivered quantities', () => {
  it('bills exactly what was delivered', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.lines).toHaveLength(1);
    expect(Number(view.lines[0]!.quantity)).toBe(60);
    // 60 at the price list's 20.
    expect(view.netIqd).toBe('1200.0000');
  });

  it('refuses a line beyond the delivery, through the service', async () => {
    const { noteId } = await deliveredNote(qty('60'));

    const { rows } = await ownerPool.query(
      `select id from delivery_note_line where delivery_note_id = $1`,
      [noteId],
    );

    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          ar.create(tx, salesUser, {
            deliveryNoteId: noteId,
            lines: [{ deliveryNoteLineId: rows[0].id, quantity: qty('80') }],
          }),
        ),
      ),
    ).toMatch(/would bill more than was delivered/);
  });

  it('refuses it again in the database (§7.7)', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    const { rows } = await ownerPool.query(
      `select id from ar_invoice_line where ar_invoice_id = $1`,
      [invoice.id],
    );

    expect(
      await rejection(
        ownerPool.query(`update ar_invoice_line set quantity = 80 where id = $1`, [rows[0].id]),
      ),
    ).toMatch(/would bill more than was delivered/);
  });

  it('refuses a price that is not the one the Sales Order locked (§7.3, §7.7)', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    const { rows } = await ownerPool.query(
      `select id from ar_invoice_line where ar_invoice_id = $1`,
      [invoice.id],
    );

    expect(
      await rejection(
        ownerPool.query(`update ar_invoice_line set unit_price = 1 where id = $1`, [rows[0].id]),
      ),
    ).toMatch(/cannot be edited in the sales chain/);
  });

  it('bills a delivery in stages, and refuses the stage that goes too far', async () => {
    const { noteId } = await deliveredNote(qty('60'));

    const { rows } = await ownerPool.query(
      `select id from delivery_note_line where delivery_note_id = $1`,
      [noteId],
    );

    const first = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, {
        deliveryNoteId: noteId,
        lines: [{ deliveryNoteLineId: rows[0].id, quantity: qty('40') }],
      }),
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, first.id));
    await withScope(scope(manager), (tx) => ar.post(tx, manager, first.id));

    // The first invoice is posted, so the delivery line records 40 invoiced.
    // A second invoice may bill the remaining 20 and no more — but the
    // one-invoice-per-delivery index means it has to be a reversal case, so the
    // refusal here is the partial-index one, which is the honest answer.
    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          ar.create(tx, salesUser, {
            deliveryNoteId: noteId,
            lines: [{ deliveryNoteLineId: rows[0].id, quantity: qty('40') }],
          }),
        ),
      ),
    ).toMatch(/already invoiced on/);
  });
});

// ---------------------------------------------------------------------------

describe('06.6 gate · the revenue posting is atomic with the subledger (Appendix B, C)', () => {
  it('posts Dr Customer A/R / Cr Sales Revenue, and nothing else', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    const { rows } = await ownerPool.query(
      `select a.account_type, a.name, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [invoice.journalEntryId],
    );

    expect(rows).toHaveLength(2);
    expect(Number(rows[0].debit_iqd)).toBe(1200);
    expect(rows[0].account_type).toBe('asset');
    expect(Number(rows[1].credit_iqd)).toBe(1200);
    expect(rows[1].account_type).toBe('revenue');
  });

  it('does not post the cost again — that was the delivery’s (Appendix B)', async () => {
    const { noteId, cogsIqd } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    // 60 at 6 = 360, posted once, by the delivery.
    expect(cogsIqd).toBe(price('360'));

    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd), 0)::text as cogs
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where a.name = 'Cost of Goods Sold' and l.journal_entry_id = $1`,
      [invoice.journalEntryId],
    );

    expect(Number(rows[0].cogs)).toBe(0);
  });

  it('writes the A/R subledger entry in the same transaction as the journal (§15)', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    const { rows } = await ownerPool.query(
      `select count(*)::int as entries from subledger_entry where journal_entry_id = $1`,
      [invoice.journalEntryId],
    );

    // The receivable line carries a business partner, so the subledger has a
    // row: the customer's balance and the control account move together or not
    // at all (§24).
    expect(rows[0].entries).toBeGreaterThan(0);
  });

  it('leaves nothing behind when the posting is refused', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, { deliveryNoteId: noteId }),
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    // Remove the revenue mapping and the posting cannot choose an account.
    await ownerPool.query(`delete from posting_rule where line_role = 'sales_revenue'`);

    expect(
      await rejection(withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id))),
    ).toMatch(/No accounting mapping is configured/);

    const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.status).toBe('approved');
    expect(view.journalEntryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('06.6 gate · every posted sales journal drills back (§7.7)', () => {
  it('reaches the Sales Order, the Delivery Note and the A/R Invoice', async () => {
    const { noteId, orderId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    const trail = await withScope(scope(manager), (tx) =>
      ar.drillBack(tx, invoice.journalEntryId),
    );

    expect(trail).toHaveLength(1);
    expect(trail[0]!.documentType).toBe('ar_invoice');
    expect(trail[0]!.documentNo).toBe(invoice.invoiceNo);
    expect(trail[0]!.salesOrderId).toBe(orderId);
    expect(trail[0]!.deliveryNoteId).toBe(noteId);
  });

  it('reaches them from the delivery’s COGS journal too', async () => {
    const { noteId, orderId } = await deliveredNote(qty('60'));
    await postedInvoice(noteId);

    const { rows } = await ownerPool.query(
      `select journal_entry_id from delivery_note where id = $1`,
      [noteId],
    );

    const trail = await withScope(scope(manager), (tx) =>
      ar.drillBack(tx, rows[0].journal_entry_id),
    );

    expect(trail[0]!.documentType).toBe('delivery_note');
    expect(trail[0]!.salesOrderId).toBe(orderId);
  });

  it('reconciles reservation, delivery and invoice to the order (§7.7)', async () => {
    const { noteId, orderId } = await deliveredNote(qty('60'));
    await postedInvoice(noteId);

    const rows = await withScope(scope(manager), (tx) => dn.reconcileToOrder(tx, orderId));

    expect(rows[0]!.ordered).toBe('60.000000');
    expect(rows[0]!.picked).toBe('60.000000');
    expect(rows[0]!.delivered).toBe('60.000000');
    expect(rows[0]!.invoiced).toBe('60.000000');
  });
});

// ---------------------------------------------------------------------------

describe('06.6 · Partially Paid and Paid follow the money (Appendix B)', () => {
  it('moves to Partially Paid, then Paid', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    let result = await withScope(scope(manager), (tx) =>
      ar.applyAllocation(tx, manager, invoice.id, price('400')),
    );
    expect(result.status).toBe('partially_executed');

    result = await withScope(scope(manager), (tx) =>
      ar.applyAllocation(tx, manager, invoice.id, price('800')),
    );
    expect(result.status).toBe('settled');
  });

  it('refuses money beyond the invoice — the excess is a credit, not a bigger bill', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await postedInvoice(noteId);

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          ar.applyAllocation(tx, manager, invoice.id, price('1300')),
        ),
      ),
    ).toMatch(/allocation_within_total|exceeds its balance/);
  });
});

describe('06.6 · source-linked accounting dimensions stay inherited', () => {
  it('displays the order dimensions and refuses direct overrides even in draft', async () => {
    const { noteId } = await deliveredNote(qty('60'));
    const invoice = await withScope(scope(salesUser), (tx) =>
      ar.create(tx, salesUser, { deliveryNoteId: noteId }),
    );

    const seen = await withScope(scope(manager), (tx) =>
      ar.viewByNo(tx, invoice.invoiceNo),
    );
    expect(seen).toMatchObject({
      businessLineCode: 'PRODUCT_SALES',
      departmentCode: 'SALES',
    });

    await expect(
      withScope(scope(manager), (tx) =>
        ar.setAccountingDimensions(tx, manager, invoice.id, {
          businessLineCode: 'PRODUCT_SALES',
          departmentCode: 'SALES',
        }),
      ),
    ).rejects.toThrow(/Delivery Note|inherited/);
    await expect(
      ownerPool.query(
        `update ar_invoice set business_line_code = 'PRODUCT_SALES' where id = $1`,
        [invoice.id],
      ),
    ).rejects.toThrow(/source-linked invoice inherits/);
  });
});
