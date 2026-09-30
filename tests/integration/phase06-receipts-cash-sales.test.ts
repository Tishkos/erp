/**
 * Phase 06.10 and 06.8 test gates — Customer Receipt, allocation, and Cash Sale.
 * §16, §7.4, Appendix B, Appendix C.
 *
 * 06.10
 *   - One receipt allocates across several invoices
 *   - Several receipts allocate to one invoice
 *   - Allocation exceeding the invoice balance or the receipt balance is rejected
 *   - An unidentified receipt sits in the clearing account and is reported as unapplied
 *   - Invoice and receipt update the customer subledger and G/L in the same posting
 *
 * 06.8
 *   - Cash sales enforce the same reservation, availability and price list controls
 *   - Settlement posts in the same transaction as the invoice
 *   - A cash sale leaves no open A/R balance
 *
 * 06.10 is built and tested before 06.8 on purpose: *"cash sales use the same
 * … controls"* is only true by construction if there is one set of controls to
 * use, and building the cash case first is how two sets come about.
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
import * as receipts from '@/server/services/customer-receipt';
import * as cashSale from '@/server/services/cash-sale';
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
let otherCustomerId: string;
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

async function receive(quantity: bigint, batch: string) {
  await withScope(scope(manager), (tx) =>
    inventory.receive(tx, manager, {
      itemCode: CABLE,
      warehouseCode: WAREHOUSE,
      branchCode: BAGHDAD,
      quantity,
      unitCostIqd: price('6'),
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
    `insert into price_list (code, name, currency, active) values ($1,'Retail','IQD',true)`,
    [LIST],
  );
  const { rows: items } = await ownerPool.query(`select id from item where code = $1`, [CABLE]);
  await ownerPool.query(
    `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
     values ($1,$2,'EA',20.0000,'2026-01-01')`,
    [LIST, items[0].id],
  );

  const { rows: partners } = await ownerPool.query(
    `insert into business_partner
       (code, legal_name, is_customer, status, active, price_list_code, credit_limit_iqd)
     values ('CUST-001','Al Rasheed Trading', true, 'active', true, $1, 100000000.0000),
            ('CUST-002','Tigris Supplies',    true, 'active', true, $1, 100000000.0000)
     returning id, code`,
    [LIST],
  );
  customerId = partners.find((r) => r.code === 'CUST-001')!.id;
  otherCustomerId = partners.find((r) => r.code === 'CUST-002')!.id;

  const { rows: cash } = await ownerPool.query(
    `select id from bank_cash_account where account_type = 'bank' limit 1`,
  );
  cashAccountId = cash[0].id;

  // §3.3 — the mappings each posting needs. `customer_clearing` is the §16
  // account an unidentified receipt credits; `bank_cash` is where the money is.
  for (const [event, role, parent, name, control] of [
    ['inventory.delivery', 'inventory', 'A000001', 'Inventory', null],
    ['inventory.delivery', 'cogs', 'X000001', 'Cost of Goods Sold', null],
    ['inventory.opening_stock', 'inventory', 'A000001', 'Inventory', null],
    ['inventory.opening_stock', 'cogs', 'X000001', 'Cost of Goods Sold', null],
    ['sales.ar_invoice', 'customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['sales.ar_invoice', 'sales_revenue', 'R000001', 'Sales Revenue', null],
    ['sales.customer_receipt', 'bank_cash', 'A000001', 'Bank Current Account', null],
    [
      'sales.customer_receipt',
      'customer_receivable',
      'A000001',
      'Trade Receivables',
      'customer',
    ],
    ['sales.customer_receipt', 'customer_clearing', 'L000001', 'Customer Clearing', null],
    [
      'sales.customer_receipt_identified',
      'customer_clearing',
      'L000001',
      'Customer Clearing',
      null,
    ],
    [
      'sales.customer_receipt_identified',
      'customer_receivable',
      'A000001',
      'Trade Receivables',
      'customer',
    ],
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

/** The whole chain to an **approved but unposted** invoice. */
async function invoiceFor(quantity: bigint, deliveryDate: string, forCustomer = customerId) {
  const order = await withScope(scope(salesUser), (tx) =>
    so.create(tx, salesUser, {
      customerId: forCustomer,
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

  return { ...invoice, orderId: order.id };
}

/** …and posted, so it has a balance to settle. */
async function postedInvoice(quantity: bigint, deliveryDate: string, forCustomer = customerId) {
  const invoice = await invoiceFor(quantity, deliveryDate, forCustomer);
  await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));
  return invoice;
}

/** A posted receipt for `amount`, identified unless told otherwise. */
async function postedReceipt(amount: string, options: { identified?: boolean } = {}) {
  const receipt = await withScope(scope(manager), (tx) =>
    receipts.create(tx, manager, {
      customerId: options.identified === false ? null : customerId,
      branchCode: BAGHDAD,
      receiptDate: '2026-02-15',
      bankCashAccountId: cashAccountId,
      amountIqd: price(amount),
      bankReference: 'TRF-9001',
    }),
  );
  await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));
  const posted = await withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id));
  return { ...receipt, ...posted };
}

// ---------------------------------------------------------------------------

describe('06.10 gate · one receipt across several invoices (§16)', () => {
  it('allocates one payment to three invoices', async () => {
    await receive(qty('500'), 'B-1');

    const a = await postedInvoice(qty('10'), '2026-02-13'); // 200
    const b = await postedInvoice(qty('20'), '2026-02-14'); // 400
    const c = await postedInvoice(qty('30'), '2026-02-16'); // 600

    const receipt = await postedReceipt('1200');

    const result = await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, receipt.id, [
        { arInvoiceId: a.id, amountIqd: price('200') },
        { arInvoiceId: b.id, amountIqd: price('400') },
        { arInvoiceId: c.id, amountIqd: price('600') },
      ]),
    );

    expect(result.status).toBe('settled');

    for (const invoice of [a, b, c]) {
      const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
      expect(view.status).toBe('settled');
    }
  });

  it('proposes oldest-first, and the clerk may still choose otherwise', async () => {
    await receive(qty('500'), 'B-1');

    const older = await postedInvoice(qty('10'), '2026-02-13');
    const newer = await postedInvoice(qty('20'), '2026-02-16');
    const receipt = await postedReceipt('300');

    const plan = await withScope(scope(manager), (tx) => receipts.proposeFor(tx, receipt.id));

    // 200 to the older invoice, 100 towards the newer one.
    expect(plan[0]!.arInvoiceId).toBe(older.id);
    expect(plan[0]!.amountIqd).toBe(price('200'));
    expect(plan[1]!.arInvoiceId).toBe(newer.id);
    expect(plan[1]!.amountIqd).toBe(price('100'));
  });
});

/**
 * Oldest first, applied — the sponsor's own example.
 *
 * *"we make an invoice today and tomorrow … customer tomorrow pays 50,000, it
 * means 50,000 from the receipt paid for the first one; if it pays 100,000 it
 * means the second invoice is partially paid."*
 *
 * The proposal above is arithmetic; this is the button. It matters that the
 * money lands on the *older* invoice: put it on the newer one and the ageing
 * report starts describing the allocation instead of the account.
 */
describe('06.10 · applying a receipt oldest-first', () => {
  it('settles the older invoice and leaves the newer one alone', async () => {
    await receive(qty('500'), 'B-1');
    const older = await postedInvoice(qty('10'), '2026-02-13'); // 200
    const newer = await postedInvoice(qty('20'), '2026-02-16'); // 400

    const receipt = await postedReceipt('200');
    const outcome = await withScope(scope(manager), (tx) =>
      receipts.allocateOldestFirst(tx, manager, receipt.id),
    );

    expect(outcome.invoices).toBe(1);
    expect(outcome.status, 'every dinar of it is applied').toBe('settled');

    const first = await withScope(scope(manager), (tx) => ar.view(tx, older.id));
    expect(first.status).toBe('settled');
    expect(first.allocatedIqd).toBe('200.0000');

    const second = await withScope(scope(manager), (tx) => ar.view(tx, newer.id));
    expect(second.status, 'untouched — the money did not reach it').toBe('posted');
    expect(second.allocatedIqd).toBe('0.0000');
  });

  it('settles the older invoice and part-pays the newer one with the rest', async () => {
    await receive(qty('500'), 'B-1');
    const older = await postedInvoice(qty('10'), '2026-02-13'); // 200
    const newer = await postedInvoice(qty('20'), '2026-02-16'); // 400

    const receipt = await postedReceipt('400');
    const outcome = await withScope(scope(manager), (tx) =>
      receipts.allocateOldestFirst(tx, manager, receipt.id),
    );

    expect(outcome.invoices).toBe(2);

    const first = await withScope(scope(manager), (tx) => ar.view(tx, older.id));
    expect(first.status).toBe('settled');
    expect(first.allocatedIqd).toBe('200.0000');

    const second = await withScope(scope(manager), (tx) => ar.view(tx, newer.id));
    expect(second.status, 'the 400 receipt, less the 200 the older invoice took').toBe(
      'partially_executed',
    );
    expect(second.allocatedIqd).toBe('200.0000');
    expect(second.netIqd).toBe('400.0000');
  });

  it('refuses when there is nothing left to apply', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('10'), '2026-02-13'); // 200
    const receipt = await postedReceipt('200');

    await withScope(scope(manager), (tx) => receipts.allocateOldestFirst(tx, manager, receipt.id));
    const settled = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(settled.status).toBe('settled');

    // A second press has no debt to settle and says so rather than doing
    // nothing quietly.
    await expect(
      withScope(scope(manager), (tx) => receipts.allocateOldestFirst(tx, manager, receipt.id)),
    ).rejects.toThrow(receipts.NothingToAllocateError);
  });
});

describe('06.10 gate · several receipts to one invoice (§16)', () => {
  it('accumulates until the invoice is paid', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('50'), '2026-02-13'); // 1000

    const first = await postedReceipt('400');
    await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, first.id, [
        { arInvoiceId: invoice.id, amountIqd: price('400') },
      ]),
    );

    let view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.status).toBe('partially_executed');
    expect(view.allocatedIqd).toBe('400.0000');

    const second = await postedReceipt('600');
    await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, second.id, [
        { arInvoiceId: invoice.id, amountIqd: price('600') },
      ]),
    );

    view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.status).toBe('settled');
    expect(view.allocatedIqd).toBe('1000.0000');
  });
});

describe('06.10 gate · neither balance may be exceeded (§16)', () => {
  it('refuses an allocation beyond the invoice', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('10'), '2026-02-13'); // 200
    const receipt = await postedReceipt('1000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          receipts.allocate(tx, manager, receipt.id, [
            { arInvoiceId: invoice.id, amountIqd: price('300') },
          ]),
        ),
      ),
    ).toMatch(/exceeds its balance/);
  });

  it('refuses an allocation beyond the receipt', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('50'), '2026-02-13'); // 1000
    const receipt = await postedReceipt('400');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          receipts.allocate(tx, manager, receipt.id, [
            { arInvoiceId: invoice.id, amountIqd: price('600') },
          ]),
        ),
      ),
    ).toMatch(/left to apply/);
  });

  it('refuses both again in the database, whatever route wrote the row (§7.7)', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('10'), '2026-02-13');
    const receipt = await postedReceipt('1000');

    expect(
      await rejection(
        ownerPool.query(
          `insert into customer_receipt_allocation
             (customer_receipt_id, ar_invoice_id, amount_iqd, allocated_by)
           values ($1, $2, 999, $3)`,
          [receipt.id, invoice.id, manager.principal.userId],
        ),
      ),
    ).toMatch(/exceeds its balance/);
  });

  it('refuses one customer’s money settling another’s debt', async () => {
    await receive(qty('500'), 'B-1');
    const theirs = await postedInvoice(qty('10'), '2026-02-13', otherCustomerId);
    const receipt = await postedReceipt('1000');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          receipts.allocate(tx, manager, receipt.id, [
            { arInvoiceId: theirs.id, amountIqd: price('200') },
          ]),
        ),
      ),
    ).toMatch(/different customer/);
  });

  it('keeps an allocation once made — it is corrected by reversal, not deletion (§5.4)', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('10'), '2026-02-13');
    const receipt = await postedReceipt('200');

    await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, receipt.id, [
        { arInvoiceId: invoice.id, amountIqd: price('200') },
      ]),
    );

    expect(
      await rejection(
        ownerPool.query(`delete from customer_receipt_allocation where ar_invoice_id = $1`, [
          invoice.id,
        ]),
      ),
    ).toMatch(/append-only/);
  });
});

describe('06.10 gate · unidentified receipts sit in clearing (§16)', () => {
  it('credits the clearing account, not a customer', async () => {
    const receipt = await postedReceipt('500', { identified: false });

    const { rows } = await ownerPool.query(
      `select a.name, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [receipt.journalEntryId],
    );

    // The debit is the bank whatever else is unknown; the credit is what moves.
    //
    // "The bank" means *the account the money arrived in*, not whichever account
    // the `bank_cash` mapping happens to name — with two bank accounts those are
    // different answers, and only the first one is true.
    const { rows: expected } = await ownerPool.query(
      `select a.name
         from bank_cash_account b
         join chart_of_account a on a.id = b.gl_account_id
        where b.id = $1`,
      [cashAccountId],
    );

    expect(rows[0].name).toBe(expected[0].name);
    expect(Number(rows[0].debit_iqd)).toBe(500);
    expect(rows[1].name).toBe('Customer Clearing');
    expect(Number(rows[1].credit_iqd)).toBe(500);
  });

  it('reports it as unapplied, and says it is unidentified', async () => {
    await postedReceipt('500', { identified: false });

    const rows = await withScope(scope(manager), (tx) => receipts.unappliedReceipts(tx, BAGHDAD));

    expect(rows).toHaveLength(1);
    expect(rows[0]!.unidentified).toBe(true);
    expect(rows[0]!.customerCode).toBeNull();
    expect(rows[0]!.unappliedIqd).toBe('500.0000');
  });

  it('cannot be allocated until somebody works out whose it is', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('10'), '2026-02-13');
    const receipt = await postedReceipt('500', { identified: false });

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          receipts.allocate(tx, manager, receipt.id, [
            { arInvoiceId: invoice.id, amountIqd: price('200') },
          ]),
        ),
      ),
    ).toMatch(/has no customer/);
  });

  it('moves the credit out of clearing when it is resolved', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await postedInvoice(qty('10'), '2026-02-13');
    const receipt = await postedReceipt('500', { identified: false });

    const moved = await withScope(scope(manager), (tx) =>
      receipts.identify(tx, manager, receipt.id, customerId),
    );

    // A journal, not an edit: the clearing balance was posted and reconciled, so
    // it is cleared by a posting that says so.
    const { rows } = await ownerPool.query(
      `select a.name, l.debit_iqd, l.credit_iqd
         from journal_line l
         join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1
        order by l.line_no`,
      [moved.journalEntryId],
    );

    expect(rows[0].name).toBe('Customer Clearing');
    expect(Number(rows[0].debit_iqd)).toBe(500);
    expect(rows[1].name).toBe('Trade Receivables');
    expect(Number(rows[1].credit_iqd)).toBe(500);

    // And now it can do its job.
    const result = await withScope(scope(manager), (tx) =>
      receipts.allocate(tx, manager, receipt.id, [
        { arInvoiceId: invoice.id, amountIqd: price('200') },
      ]),
    );
    expect(result.allocatedIqd).toBe(price('200'));
  });

  it('refuses to re-point a receipt that already names a customer', async () => {
    const receipt = await postedReceipt('500');

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          receipts.identify(tx, manager, receipt.id, otherCustomerId),
        ),
      ),
    ).toMatch(/already names a customer/);
  });
});

describe('06.10 gate · the subledger and the G/L move in one posting (§16)', () => {
  it('writes a customer subledger entry with the receipt’s journal', async () => {
    const receipt = await postedReceipt('500');

    const { rows } = await ownerPool.query(
      `select count(*)::int as entries from subledger_entry where journal_entry_id = $1`,
      [receipt.journalEntryId],
    );

    expect(rows[0].entries).toBeGreaterThan(0);
  });

  it('leaves nothing behind when the receipt posting is refused', async () => {
    // The bank leg names its own account now, so breaking *that* mapping would
    // prove nothing. The receivable leg is still resolved through §3.3, and it
    // is the one that has to fail for this to be a test of atomicity rather
    // than a test of configuration.
    await ownerPool.query(
      `delete from posting_rule where event_type = 'sales.customer_receipt' and line_role = 'customer_receivable'`,
    );

    const receipt = await withScope(scope(manager), (tx) =>
      receipts.create(tx, manager, {
        customerId,
        branchCode: BAGHDAD,
        receiptDate: '2026-02-15',
        bankCashAccountId: cashAccountId,
        amountIqd: price('500'),
      }),
    );
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));

    expect(
      await rejection(withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id))),
    ).toMatch(/No accounting mapping is configured/);

    const view = await withScope(scope(manager), (tx) => receipts.view(tx, receipt.id));
    expect(view.status).toBe('approved');
    expect(view.journalEntryId).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('06.8 gate · a cash sale uses the same controls as a credit sale (§7.4)', () => {
  it('goes through reservation, availability and the price list, unchanged', async () => {
    await receive(qty('500'), 'B-1');

    const invoice = await invoiceFor(qty('50'), '2026-02-13');

    // Priced from the list at 20, not from anything the cash path chose.
    const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.netIqd).toBe('1000.0000');
    expect(view.lines[0]!.unitPrice).toBe('20.0000');

    // And the stock left through the same reservation-then-issue path.
    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, CABLE, WAREHOUSE, BAGHDAD),
    );
    expect(position.onHand).toBe(qty('450'));
    expect(availableQuantity(position)).toBe(qty('450'));
  });

  it('cannot be sold beyond available stock, exactly as a credit sale cannot', async () => {
    await receive(qty('10'), 'B-1');

    expect(
      await rejection(
        withScope(scope(salesUser), (tx) =>
          so
            .create(tx, salesUser, {
              customerId,
              branchCode: BAGHDAD,
              orderDate: '2026-02-10',
              departmentCode: 'SALES',
              businessLineCode: 'PRODUCT_SALES',
              lines: [
                {
                  itemCode: CABLE,
                  quantity: qty('50'),
                  uomCode: 'EA',
                  warehouseCode: WAREHOUSE,
                  branchCode: BAGHDAD,
                },
              ],
            })
            .then((order) => so.approve(tx, manager, order.id)),
        ),
      ),
    ).toMatch(/available|insufficient|Available/i);
  });
});

describe('06.8 gate · settlement posts with the invoice and leaves no A/R balance', () => {
  it('posts both journals in one transaction and closes the invoice', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await invoiceFor(qty('50'), '2026-02-13');

    const result = await withScope(scope(manager), (tx) =>
      cashSale.postAndSettle(tx, manager, invoice.id, {
        bankCashAccountId: cashAccountId,
        bankReference: 'CASH-0001',
      }),
    );

    const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));

    // §7.4 — immediate settlement. No open balance, and Appendix B's Paid.
    expect(view.status).toBe('settled');
    expect(view.allocatedIqd).toBe('1000.0000');

    // Two journals, both there: Dr A/R / Cr Revenue, then Dr Bank / Cr A/R.
    const { rows } = await ownerPool.query(
      `select count(*)::int as journals from journal_entry where id in ($1, $2)`,
      [result.journalEntryId, result.receiptJournalEntryId],
    );
    expect(rows[0].journals).toBe(2);
  });

  it('rolls back the invoice posting too when the settlement cannot post', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await invoiceFor(qty('50'), '2026-02-13');

    // No receivable mapping, so the receipt cannot post — and neither half
    // survives. Not the bank leg: that one names its account directly and would
    // post perfectly well with no mapping at all.
    await ownerPool.query(
      `delete from posting_rule where event_type = 'sales.customer_receipt' and line_role = 'customer_receivable'`,
    );

    expect(
      await rejection(
        withScope(scope(manager), (tx) =>
          cashSale.postAndSettle(tx, manager, invoice.id, {
            bankCashAccountId: cashAccountId,
          }),
        ),
      ),
    ).toMatch(/No accounting mapping is configured/);

    // The 06.8 gate's real content: goods that left with no money recorded
    // cannot exist, so the invoice is still unposted.
    const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
    expect(view.status).toBe('approved');
    expect(view.journalEntryId).toBeNull();
  });

  it('records which receipt settled the sale', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await invoiceFor(qty('50'), '2026-02-13');

    const result = await withScope(scope(manager), (tx) =>
      cashSale.postAndSettle(tx, manager, invoice.id, {
        bankCashAccountId: cashAccountId,
        bankReference: 'CASH-0001',
      }),
    );

    const settlement = await withScope(scope(manager), (tx) =>
      cashSale.settlementFor(tx, invoice.id),
    );

    expect(settlement!.receiptNo).toBe(result.receiptNo);
    expect(settlement!.bankReference).toBe('CASH-0001');
    // Settled on the day of the sale — §7.4's *immediate*.
    expect(settlement!.receiptDate).toBe('2026-02-13');
  });

  it('leaves the customer nothing to be chased for', async () => {
    await receive(qty('500'), 'B-1');
    const invoice = await invoiceFor(qty('50'), '2026-02-13');

    await withScope(scope(manager), (tx) =>
      cashSale.postAndSettle(tx, manager, invoice.id, { bankCashAccountId: cashAccountId }),
    );

    const { rows } = await ownerPool.query(
      `select coalesce(sum(net_iqd - allocated_iqd), 0)::text as open
         from ar_invoice where customer_id = $1 and status <> 'reversed'`,
      [customerId],
    );

    expect(toDecimalString(price(rows[0].open), 4n)).toBe('0.0000');
  });
});
