/**
 * Operations build, block 4 — the Purchase Invoice receives stock
 * (2026-09-12).
 *
 * The sponsor's document:
 *
 *   Lines    Item Code; Item Name; Quantity; Unit Price; Discount;
 *            Total Price; Warehouse.
 *   Effect   A Purchase Invoice increases stock in the selected warehouse.
 *   Journal  Inventory Dr. / Accounts Payable Cr.
 *
 * A line that names a warehouse takes this route: the invoice brings the goods
 * in itself, and the debit goes to the item's own inventory account. A line
 * that names none keeps the route that existed before, where a Goods Receipt
 * already brought them in and the invoice clears GRNI. One invoice can carry
 * both, which is why the warehouse is on the line.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as inventory from '@/server/services/inventory';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const WAREHOUSE = 'WH-MAIN';
const ON = '2026-04-01';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let supplierId: string;
let accounts: Record<string, string>;
let itemInventoryAccount: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')
     on conflict do nothing`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict do nothing`,
  );

  clerk = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  // The accounts, and the rules that map the roles this document still uses.
  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
    ['expense', 'X000001', 'Service and Expense Cost'],
    ['purchase_variance', 'X000001', 'Purchase Price Variance'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = $1`,
      [parent],
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [
        `${parent.slice(0, 1)}9${String(role.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        role === 'supplier_payable' ? 'supplier' : null,
      ],
    );
    accounts[role] = rows[0].id;
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('purchasing.ap_invoice', $1, $2, true, $3) on conflict do nothing`,
      [role, rows[0].id, manager.principal.userId],
    );
  }
  itemInventoryAccount = accounts.inventory!;

  // An item that knows where its stock is held — Operations block 1.
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking, inventory_account_id)
       values ($1,'Solar Panel 550W',true,'EA','batch',$2) returning id`,
      [PANEL, itemInventoryAccount],
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

  await ownerPool.query(
    `insert into warehouse (code, name, branch_code, warehouse_type)
     values ($1,'Main Warehouse',$2,'main') on conflict do nothing`,
    [WAREHOUSE, BAGHDAD],
  );

  const { rows: partner } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_supplier, status, active)
     values ('SUP-001','Jinko Solar', true, 'active', true) returning id`,
  );
  supplierId = partner[0].id;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code = 'FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
     values ($1,4,'April 2026','2026-04-01','2026-04-30') on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement)
     values ('ap_invoice','business_line','optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
  await withScope(scope(manager), (tx) =>
    coa.setRequiredDimensions(tx, manager, accounts.purchase_variance!, []),
  );
  await withScope(scope(manager), (tx) =>
    coa.setRequiredDimensions(tx, manager, accounts.inventory!, []),
  );
});

let seq = 0;

/** A purchase invoice on the direct route: no order, no receipt, a warehouse. */
async function purchaseInvoice(
  line: {
    quantity?: string;
    unitPrice?: string;
    discount?: string;
    warehouseCode?: string | null;
  } = {},
) {
  seq += 1;
  return withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SI-${seq}`,
      purchaseOrderId: null,
      branchCode: BAGHDAD,
      invoiceDate: ON,
      dueDate: '2026-05-01',
      nonPoJustification: 'Bought directly from the supplier.',
      nonPoApprovedBy: manager.principal.userId,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: qty(line.quantity ?? '10'),
          unitPriceIqd: price(line.unitPrice ?? '100000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: 'warehouseCode' in line ? line.warehouseCode : WAREHOUSE,
          ...(line.discount ? { discountIqd: price(line.discount) } : {}),
        },
      ],
    }),
  );
}

const postIt = async (id: string) => {
  await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, id));
  return withScope(scope(manager), (tx) => ap.post(tx, manager, id));
};

const journalOf = async (journalEntryId: string) => {
  const { rows } = await ownerPool.query(
    `select a.code, a.name, l.debit_iqd, l.credit_iqd
       from journal_line l join chart_of_account a on a.id = l.account_id
      where l.journal_entry_id = $1 order by l.line_no`,
    [journalEntryId],
  );
  return rows.map((r) => ({
    account: r.name as string,
    debit: Number(r.debit_iqd),
    credit: Number(r.credit_iqd),
  }));
};

// ---------------------------------------------------------------------------
describe('ops 4 · a purchase invoice increases stock in the warehouse', () => {
  it('receives the quantity into the warehouse it names', async () => {
    const invoice = await purchaseInvoice({ quantity: '10', unitPrice: '100000' });
    await postIt(invoice.id);

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
    );
    expect(Number(position.onHand) / 1_000_000).toBe(10);
  });

  it('posts Inventory Dr / Accounts Payable Cr, and nothing else', async () => {
    const invoice = await purchaseInvoice({ quantity: '10', unitPrice: '100000' });
    const { journalEntryId } = await postIt(invoice.id);

    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Inventory', debit: 1_000_000, credit: 0 },
      { account: 'Trade Payables', debit: 0, credit: 1_000_000 },
    ]);
  });

  it('values the stock at what the invoice says, discount included', async () => {
    // 10 × 100,000 = 1,000,000, less 150,000 = 850,000.
    const invoice = await purchaseInvoice({
      quantity: '10',
      unitPrice: '100000',
      discount: '150000',
    });
    const { journalEntryId } = await postIt(invoice.id);

    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Inventory', debit: 850_000, credit: 0 },
      { account: 'Trade Payables', debit: 0, credit: 850_000 },
    ]);

    // And the stock is worth what was paid for it, not what was asked.
    const value = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, PANEL, WAREHOUSE),
    );
    expect(Number(value) / 10_000).toBe(850_000);
  });

  it('keeps the warehouse and the ledger at the same figure when it does not divide', async () => {
    // 3 at 100,000 less 10,000 is 290,000 — 96,666.6666 each, which does not
    // come back to 290,000 by multiplication. The ledger is told 290,000; the
    // warehouse must not quietly hold a different number.
    const invoice = await purchaseInvoice({
      quantity: '3',
      unitPrice: '100000',
      discount: '10000',
    });
    const { journalEntryId } = await postIt(invoice.id);

    const posted = await journalOf(journalEntryId);
    expect(posted[0]!.debit).toBe(290_000);

    const value = await withScope(scope(manager), (tx) =>
      inventory.valuationOf(tx, PANEL, WAREHOUSE),
    );
    // Within the smallest unit the ledger records.
    expect(Math.abs(Number(value) / 10_000 - 290_000)).toBeLessThan(1);
  });

  it('owes the supplier what the lines come to', async () => {
    const invoice = await purchaseInvoice({ quantity: '4', unitPrice: '250000' });
    await postIt(invoice.id);

    const { rows } = await ownerPool.query(`select total_iqd from ap_invoice where id = $1`, [
      invoice.id,
    ]);
    expect(Number(rows[0].total_iqd)).toBe(1_000_000);
  });

  it('makes the stock available to be sold, oldest first', async () => {
    await postIt((await purchaseInvoice({ quantity: '5', unitPrice: '100000' })).id);
    await postIt((await purchaseInvoice({ quantity: '5', unitPrice: '140000' })).id);

    const layers = await withScope(scope(manager), (tx) =>
      inventory.layersOf(tx, PANEL, WAREHOUSE),
    );
    // Two layers, in the order they arrived — FIFO reads them this way round.
    expect(layers.map((l) => Number(l.unitCostIqd) / 10_000)).toEqual([100_000, 140_000]);
  });

  it('refuses a line with a warehouse but no item', async () => {
    await expect(
      withScope(scope(clerk), (tx) =>
        ap.create(tx, clerk, {
          supplierId,
          supplierInvoiceNo: 'SI-NOITEM',
          purchaseOrderId: null,
          branchCode: BAGHDAD,
          invoiceDate: ON,
          dueDate: '2026-05-01',
          nonPoJustification: 'Direct',
          nonPoApprovedBy: manager.principal.userId,
          lines: [
            {
              description: 'A charge',
              quantity: qty('1'),
              unitPriceIqd: price('50000'),
              uomCode: 'EA',
              isInventory: true,
              warehouseCode: WAREHOUSE,
            },
          ],
        }),
      ).then((made) => postIt(made.id)),
    ).rejects.toThrow(/no item/);
  });

  it('refuses to post when the item names no inventory account', async () => {
    await ownerPool.query(`update item set inventory_account_id = null where code = $1`, [PANEL]);
    const invoice = await purchaseInvoice();
    await expect(postIt(invoice.id)).rejects.toThrow(/no inventory account/);
  });

  it('refuses a discount larger than the line', async () => {
    await expect(
      purchaseInvoice({ quantity: '1', unitPrice: '100000', discount: '150000' }),
    ).rejects.toThrow();
  });

  it('leaves a line with no warehouse on the route it had before', async () => {
    // No warehouse means no stock moved by this invoice, and the value goes to
    // the accounts the three-way match uses rather than to inventory.
    const invoice = await purchaseInvoice({ warehouseCode: null });
    await postIt(invoice.id);

    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
    );
    expect(Number(position.onHand)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('ops 4 · an invoice that receives its own stock is its own evidence', () => {
  /*
   * §15 asks a non-PO invoice for a written justification and a second
   * approver, because "the three-way match cannot protect a charge that no
   * order and no receipt describe". The sponsor's invoice describes the
   * receipt: it names the warehouse each line arrives in and posting puts them
   * there.
   *
   * Without this, block 4's screen could not raise a single invoice — the form
   * has one person on it, and the rule refuses an approver who is the raiser.
   * It was not caught because the browser test checked that the form rendered
   * and never pressed Create.
   */
  it('takes a stock invoice from one person, with no second approver', async () => {
    const made = await withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: 'EVIDENCE-1',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        dueDate: '2026-05-01',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: qty('4'),
            unitPriceIqd: price('100000'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );

    expect(made.invoiceNo).toBeTruthy();
  });

  it('still asks for evidence when a line receives nothing', async () => {
    // One service line among the stock lines and the evidence is owed again:
    // that line has no receipt of any kind behind it, which is the case §15 was
    // written for.
    await expect(
      withScope(scope(clerk), (tx) =>
        ap.create(tx, clerk, {
          supplierId,
          supplierInvoiceNo: 'EVIDENCE-2',
          purchaseOrderId: null,
          branchCode: BAGHDAD,
          invoiceDate: ON,
          dueDate: '2026-05-01',
          lines: [
            {
              itemCode: PANEL,
              description: 'Solar Panel 550W',
              quantity: qty('4'),
              unitPriceIqd: price('100000'),
              uomCode: 'EA',
              isInventory: true,
              warehouseCode: WAREHOUSE,
            },
            {
              description: 'Delivery charge',
              quantity: qty('1'),
              unitPriceIqd: price('50000'),
              uomCode: 'EA',
              isInventory: false,
            },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it('still refuses the raiser as their own second approver', async () => {
    // The relaxation is about receipts, not about who signs. An invoice with
    // no warehouse on any line is the case the rule guards, and it still does.
    await expect(
      withScope(scope(clerk), (tx) =>
        ap.create(tx, clerk, {
          supplierId,
          supplierInvoiceNo: 'EVIDENCE-3',
          purchaseOrderId: null,
          branchCode: BAGHDAD,
          invoiceDate: ON,
          dueDate: '2026-05-01',
          nonPoJustification: 'Bought on the spot.',
          nonPoApprovedBy: clerk.principal.userId,
          lines: [
            {
              description: 'Consultancy',
              quantity: qty('1'),
              unitPriceIqd: price('250000'),
              uomCode: 'EA',
              isInventory: false,
            },
          ],
        }),
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('ops 4 · the invoice the screen actually raises', () => {
  /*
   * Block 4's header is the invoice number, the two dates and the supplier.
   * The supplier's own number is not among them, so the screen sends none —
   * and every invoice it raised was refused with §15's duplicate message,
   * because a blank number fell to the branch that demands a duplicate reason.
   *
   * The tests above all sent a number, which is exactly why nobody saw it.
   */
  const asTheScreenDoes = (overrides: Partial<Parameters<typeof ap.create>[2]> = {}) =>
    withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: '',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        dueDate: '2026-05-01',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: qty('4'),
            unitPriceIqd: price('100000'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
        ...overrides,
      }),
    );

  it('saves an invoice that carries no supplier invoice number', async () => {
    const made = await asTheScreenDoes();
    expect(made.invoiceNo).toBeTruthy();
  });

  it('numbers it with ours, so the §15 control still means something', async () => {
    const made = await asTheScreenDoes();
    const { rows } = await ownerPool.query(
      `select supplier_invoice_no from ap_invoice where id = $1`,
      [made.id],
    );
    expect(rows[0].supplier_invoice_no).toBe(made.invoiceNo);
  });

  it('raises a second one for the same supplier on the same day', async () => {
    // Two blank numbers are not a duplicate of each other: each takes our own
    // number, and the unique index is on (supplier, number).
    await asTheScreenDoes();
    const second = await asTheScreenDoes();
    expect(second.invoiceNo).toBeTruthy();
  });

  it('still refuses a duplicate exception with no reason behind it', async () => {
    await expect(
      asTheScreenDoes({
        supplierInvoiceNo: 'SI-CLAIMED',
        duplicateApprovedBy: manager.principal.userId,
      }),
    ).rejects.toThrow(/only with a reason/);
  });

  it('still refuses a supplier number the supplier has already billed', async () => {
    await asTheScreenDoes({ supplierInvoiceNo: 'SI-REPEATED' });
    await expect(asTheScreenDoes({ supplierInvoiceNo: 'SI-REPEATED' })).rejects.toThrow(
      /has already been entered as/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('ops 4 · the due date comes from the payment terms (§16)', () => {
  /*
   * "Net 30" is on the supplier's record. Asking the person raising the
   * invoice to count thirty days on a calendar is asking them to get it wrong,
   * and the screen fills the field from the same arithmetic this service uses.
   */
  const invoiceWith = (dueDate?: string) =>
    withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: '',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        ...(dueDate ? { dueDate } : {}),
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: qty('4'),
            unitPriceIqd: price('100000'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );

  const dueDateOf = async (id: string) => {
    const { rows } = await ownerPool.query(`select due_date from ap_invoice where id = $1`, [id]);
    return rows[0].due_date as string;
  };

  const putSupplierOn = async (code: string) =>
    ownerPool.query(`update business_partner set payment_terms_code = $1 where id = $2`, [
      code,
      supplierId,
    ]);

  beforeEach(async () => {
    await ownerPool.query(
      `insert into payment_terms (code, name, basis, due_days)
       values ('NET30','Net 30 days','document_date',30),
              ('EOM60','60 days, end of month','end_of_month',60)
       on conflict (code) do nothing`,
    );
  });

  it('counts the days from the invoice date', async () => {
    await putSupplierOn('NET30');
    const made = await invoiceWith();
    expect(await dueDateOf(made.id)).toBe('2026-05-01');
  });

  it('starts the clock at month end when the terms say so', async () => {
    await putSupplierOn('EOM60');
    const made = await invoiceWith();
    // April ends on the 30th; sixty days after that is 29 June.
    expect(await dueDateOf(made.id)).toBe('2026-06-29');
  });

  it('keeps a due date the invoice states for itself', async () => {
    await putSupplierOn('NET30');
    const made = await invoiceWith('2026-04-15');
    expect(await dueDateOf(made.id)).toBe('2026-04-15');
  });

  it('falls due on presentation when no terms were agreed', async () => {
    const made = await invoiceWith();
    expect(await dueDateOf(made.id)).toBe(ON);
  });
});
