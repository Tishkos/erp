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
import * as posting from '@/server/services/posting';
import * as accountStatement from '@/server/services/partner-statement';
import * as subledger from '@/server/services/subledger';
import * as trialBalance from '@/server/services/trial-balance';
import { parseDecimal } from '@/server/domain/money';
import { PermissionDeniedError } from '@/server/domain/permissions';
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
  // 'accounting_manager+ceo' is a manager who also holds the CEO's invoice
  // approval (Operations build, blocks 4 and 5).
  for (const code of role.split('+')) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, code]);
  }
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
  manager = await createUser('accounting_manager+ceo');

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

// ---------------------------------------------------------------------------
describe('ops 4 · the invoice posts through the mapping, and not without it', () => {
  /*
   * §3.3 — "the posting engine never chooses an account on its own." The
   * invoice above receives its own stock, so the debit is the item's own
   * inventory account; the credit is what the company now owes, and that comes
   * from the mapping.
   *
   * On a system where nobody had set one, every purchase invoice reached its
   * approval and stopped there — with a message naming a screen that did not
   * exist. This is that loop, closed: no mapping refuses the posting, the
   * mapping set the way the screen sets it lets it through.
   */
  const supplierPayableRule = () =>
    ownerPool.query(
      `delete from posting_rule where event_type = 'purchasing.ap_invoice' and line_role = 'supplier_payable'`,
    );

  it.each(['approve', 'post'] as const)(
    'requires the manager to hold %s as well as the other posting grant',
    async (missingVerb) => {
      const invoice = await purchaseInvoice();
      await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, invoice.id));
      const deniedCtx: ActorContext = {
        ...manager,
        principal: {
          ...manager.principal,
          grants: manager.principal.grants.filter(
            (grant) => !(grant.object === ap.PERMISSION_OBJECT && grant.verb === missingVerb),
          ),
        },
      };

      await expect(
        withScope(scope(deniedCtx), (tx) => ap.post(tx, deniedCtx, invoice.id)),
      ).rejects.toThrow(PermissionDeniedError);

      const { rows } = await ownerPool.query(
        `select status, journal_entry_id from ap_invoice where id = $1`,
        [invoice.id],
      );
      expect(rows[0]).toMatchObject({ status: 'submitted', journal_entry_id: null });
      const position = await withScope(scope(manager), (tx) =>
        inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
      );
      expect(position.onHand).toBe(0n);
    },
  );

  it('refuses to post while what the company owes has no account', async () => {
    await supplierPayableRule();
    const invoice = await purchaseInvoice();
    await expect(postIt(invoice.id)).rejects.toThrow(/No accounting mapping is configured/);

    const { rows } = await ownerPool.query(
      `select status, journal_entry_id from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(rows[0]).toMatchObject({ status: 'submitted', journal_entry_id: null });
    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
    );
    expect(position.onHand).toBe(0n);
    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'supplier', 'SUP-001'),
    );
    expect(statement).toEqual([]);
  });

  it('posts once the mapping names one', async () => {
    await supplierPayableRule();
    const invoice = await purchaseInvoice({ quantity: '10', unitPrice: '100000' });

    await withScope(scope(manager), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: 'purchasing.ap_invoice',
        lineRole: 'supplier_payable',
        accountId: accounts.supplier_payable!,
      }),
    );

    const { journalEntryId } = await postIt(invoice.id);
    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Inventory', debit: 1_000_000, credit: 0 },
      { account: 'Trade Payables', debit: 0, credit: 1_000_000 },
    ]);

    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'supplier', 'SUP-001'),
    );
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({
      debitIqd: '0.0000',
      creditIqd: '1000000.0000',
      sourceDocId: invoice.id,
    });

    // Blocks 3 and 4 meet here: the supplier's own Account Statement, with the
    // purchase as Credit and named by the invoice number the buyer raised —
    // not by the journal it produced, and not by the document's id, neither of
    // which anybody in Purchasing has ever seen.
    const account = await withScope(scope(manager), (tx) =>
      accountStatement.statementFor(tx, 'supplier', 'SUP-001', { from: ON, to: ON }),
    );
    expect(account.lines).toHaveLength(1);
    expect(account.lines[0]).toMatchObject({
      debit: '0.0000',
      credit: '1000000.0000',
      balance: '1000000.0000',
      document: { kind: 'ap_invoice', number: invoice.invoiceNo },
    });
    expect(account.closing).toBe('1000000.0000');

    const balance = await withScope(scope(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: ON, to: ON, branchCode: BAGHDAD }),
    );
    expect(balance.find((row) => row.accountName === 'Inventory')).toMatchObject({
      debit: '1000000.0000',
      credit: '0.0000',
    });
    expect(balance.find((row) => row.accountName === 'Trade Payables')).toMatchObject({
      debit: '0.0000',
      credit: '1000000.0000',
    });
    expect(trialBalance.totalsOf(balance)).toMatchObject({
      difference: '0.0000',
      balances: true,
    });
  });

  it('refuses a saved payable mapping that is not supplier-controlled until the chosen account is designated', async () => {
    await ownerPool.query(
      `update posting_rule set account_id = $1
        where event_type = 'purchasing.ap_invoice' and line_role = 'supplier_payable'`,
      [accounts.grni],
    );
    const invoice = await purchaseInvoice({ quantity: '10', unitPrice: '100000' });

    await expect(postIt(invoice.id)).rejects.toThrow(/supplier control account/);

    const { rows: invoices } = await ownerPool.query(
      `select status, journal_entry_id from ap_invoice where id = $1`,
      [invoice.id],
    );
    expect(invoices[0]).toMatchObject({ status: 'submitted', journal_entry_id: null });
    const { rows: journals } = await ownerPool.query(
      `select count(*)::int as n from journal_entry where source_doc_id = $1`,
      [invoice.id],
    );
    expect(journals[0].n).toBe(0);
    const { rows: movements } = await ownerPool.query(
      `select count(*)::int as n from inventory_movement
        where source_document_type = 'ap_invoice' and source_document_id = $1`,
      [invoice.id],
    );
    expect(movements[0].n).toBe(0);
    const { rows: subledgerRows } = await ownerPool.query(
      `select count(*)::int as n from subledger_entry where source_doc_id = $1`,
      [invoice.id],
    );
    expect(subledgerRows[0].n).toBe(0);
    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
    );
    expect(position.onHand).toBe(0n);

    await withScope(scope(manager), (tx) =>
      coa.setControlAccount(tx, manager, accounts.grni!, 'supplier'),
    );
    await withScope(scope(manager), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: 'purchasing.ap_invoice',
        lineRole: 'supplier_payable',
        accountId: accounts.grni!,
      }),
    );

    const { journalEntryId } = await withScope(scope(manager), (tx) =>
      ap.post(tx, manager, invoice.id),
    );
    const { rows: journalLines } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line
        where journal_entry_id = $1 order by line_no`,
      [journalEntryId],
    );
    expect(journalLines).toEqual([
      { account_id: itemInventoryAccount, debit_iqd: '1000000.0000', credit_iqd: '0.0000' },
      { account_id: accounts.grni, debit_iqd: '0.0000', credit_iqd: '1000000.0000' },
    ]);

    const repairedPosition = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
    );
    expect(repairedPosition.onHand).toBe(qty('10'));
    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'supplier', 'SUP-001'),
    );
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({
      debitIqd: '0.0000',
      creditIqd: '1000000.0000',
      sourceDocId: invoice.id,
    });

    // Blocks 3 and 4 meet here: the supplier's own Account Statement, with the
    // purchase as Credit and named by the invoice number the buyer raised —
    // not by the journal it produced, and not by the document's id, neither of
    // which anybody in Purchasing has ever seen.
    const account = await withScope(scope(manager), (tx) =>
      accountStatement.statementFor(tx, 'supplier', 'SUP-001', { from: ON, to: ON }),
    );
    expect(account.lines).toHaveLength(1);
    expect(account.lines[0]).toMatchObject({
      debit: '0.0000',
      credit: '1000000.0000',
      balance: '1000000.0000',
      document: { kind: 'ap_invoice', number: invoice.invoiceNo },
    });
    expect(account.closing).toBe('1000000.0000');

    const balance = await withScope(scope(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: ON, to: ON, branchCode: BAGHDAD }),
    );
    expect(balance.find((row) => row.accountName === 'Inventory')).toMatchObject({
      debit: '1000000.0000',
      credit: '0.0000',
    });
    expect(balance.find((row) => row.accountName === 'Goods Received Not Invoiced')).toMatchObject({
      debit: '0.0000',
      credit: '1000000.0000',
    });
    expect(trialBalance.totalsOf(balance)).toMatchObject({
      difference: '0.0000',
      balances: true,
    });
  });
});

// ---------------------------------------------------------------------------
describe('ops 4 · the invoice may name the accounts it posts to', () => {
  /*
   * By direction, 2026-09-22: name the accounts on the document, the way a
   * journal entry names its own, rather than having them decided elsewhere.
   *
   * Two guardrails, and they are the interesting part. The statement side has
   * to be a supplier control account, or the invoice posts a balanced journal
   * and disappears from the supplier's statement — the failure that started
   * all this. The cost side may not be a control account, because that is
   * somebody's balance and a cost posted there makes the subledger disagree
   * with the account it reconciles to.
   */
  const secondPayable = async () => {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = 'L000001'`,
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ('L950001','Trade Payables — Projects',$1,$2,false,true,'approved',1,'IQD','supplier')
       returning id`,
      [parents[0].account_type, parents[0].id],
    );
    return rows[0].id as string;
  };

  it('posts what is owed to the account the invoice names', async () => {
    const chosen = await secondPayable();
    const invoice = await purchaseInvoice({ quantity: '10', unitPrice: '100000' });

    await withScope(scope(clerk), (tx) =>
      ap.setChosenAccounts(tx, clerk, invoice.id, { payableAccountId: chosen }),
    );
    const { journalEntryId } = await postIt(invoice.id);

    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Inventory', debit: 1_000_000, credit: 0 },
      { account: 'Trade Payables — Projects', debit: 0, credit: 1_000_000 },
    ]);
  });

  it('keeps the supplier statement on the account the invoice named', async () => {
    const chosen = await secondPayable();
    const invoice = await purchaseInvoice({ quantity: '2', unitPrice: '50000' });
    await withScope(scope(clerk), (tx) =>
      ap.setChosenAccounts(tx, clerk, invoice.id, { payableAccountId: chosen }),
    );
    await postIt(invoice.id);

    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'supplier', 'SUP-001'),
    );
    expect(statement.at(-1)).toMatchObject({ creditIqd: '100000.0000' });
  });

  it('refuses an account that is not the supplier control account', async () => {
    const invoice = await purchaseInvoice();
    await expect(
      withScope(scope(clerk), (tx) =>
        ap.setChosenAccounts(tx, clerk, invoice.id, { payableAccountId: accounts.expense! }),
      ),
    ).rejects.toThrow(/never appear on the supplier's statement/);
  });

  it('refuses a control account for the cost', async () => {
    const invoice = await purchaseInvoice();
    await expect(
      withScope(scope(clerk), (tx) =>
        ap.setChosenAccounts(tx, clerk, invoice.id, {
          expenseAccountId: accounts.supplier_payable!,
        }),
      ),
    ).rejects.toThrow(/keeps a partner's balance/);
  });

  it('goes back to the mapping when the field is cleared', async () => {
    const chosen = await secondPayable();
    const invoice = await purchaseInvoice({ quantity: '10', unitPrice: '100000' });
    await withScope(scope(clerk), (tx) =>
      ap.setChosenAccounts(tx, clerk, invoice.id, { payableAccountId: chosen }),
    );
    await withScope(scope(clerk), (tx) =>
      ap.setChosenAccounts(tx, clerk, invoice.id, { payableAccountId: null }),
    );

    const { journalEntryId } = await postIt(invoice.id);
    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Inventory', debit: 1_000_000, credit: 0 },
      { account: 'Trade Payables', debit: 0, credit: 1_000_000 },
    ]);
  });
});

// ---------------------------------------------------------------------------
describe('ops 4 · two invoices, two accounts, and every ledger agrees', () => {
  /*
   * The sponsor's test, in the sponsor's words (2026-09-23): each invoice may
   * select a different account, and the journals, the warehouse and the
   * statements must all reflect it — the way an ERP is expected to behave.
   *
   * So: two invoices against one supplier, each naming its own payable
   * account, raised the way the form raises them — the choice arrives with
   * the document rather than being set afterwards.
   */
  const payableNamed = async (code: string, name: string) => {
    const { rows: parents } = await ownerPool.query(
      `select id, account_type from chart_of_account where code = 'L000001'`,
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD','supplier') returning id`,
      [code, name, parents[0].account_type, parents[0].id],
    );
    return rows[0].id as string;
  };

  const raise = async (payableAccountId: string, quantity: string, unitPrice: string) =>
    withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: '',
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: ON,
        dueDate: '2026-05-01',
        payableAccountId,
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: qty(quantity),
            unitPriceIqd: price(unitPrice),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );

  it('posts each invoice to the account it chose, and the warehouse takes both', async () => {
    const retail = await payableNamed('L970001', 'Payables — Retail');
    const projects = await payableNamed('L970002', 'Payables — Projects');

    const first = await raise(retail, '4', '100000');
    const second = await raise(projects, '6', '100000');
    const firstJournal = await postIt(first.id);
    const secondJournal = await postIt(second.id);

    expect(await journalOf(firstJournal.journalEntryId)).toEqual([
      { account: 'Inventory', debit: 400_000, credit: 0 },
      { account: 'Payables — Retail', debit: 0, credit: 400_000 },
    ]);
    expect(await journalOf(secondJournal.journalEntryId)).toEqual([
      { account: 'Inventory', debit: 600_000, credit: 0 },
      { account: 'Payables — Projects', debit: 0, credit: 600_000 },
    ]);

    // The warehouse does not care which account was chosen: ten arrived.
    const position = await withScope(scope(manager), (tx) =>
      inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD),
    );
    expect(Number(position.onHand) / 1_000_000).toBe(10);
  });

  it('shows both on the supplier statement, whichever account each was kept on', async () => {
    const retail = await payableNamed('L970001', 'Payables — Retail');
    const projects = await payableNamed('L970002', 'Payables — Projects');

    await postIt((await raise(retail, '4', '100000')).id);
    await postIt((await raise(projects, '6', '100000')).id);

    // One supplier, one statement — §1.2's subledger is kept by party, and a
    // second control account does not split the partner in two.
    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'supplier', 'SUP-001'),
    );
    expect(statement.map((row) => row.creditIqd)).toEqual(['400000.0000', '600000.0000']);
  });

  it('reconciles each control account to its own subledger rows', async () => {
    // §9.9's reconciliation, per account: what the ledger says an account
    // holds is what the subledger rows that name it add up to.
    const retail = await payableNamed('L970001', 'Payables — Retail');
    const projects = await payableNamed('L970002', 'Payables — Projects');
    await postIt((await raise(retail, '4', '100000')).id);
    await postIt((await raise(projects, '6', '100000')).id);

    const { rows } = await ownerPool.query(`
      select a.code,
             sum(l.credit_iqd - l.debit_iqd)::text as ledger,
             (select coalesce(sum(s.credit_iqd - s.debit_iqd), 0)::text
                from subledger_entry s where s.control_account_id = a.id) as subledger
        from journal_line l join chart_of_account a on a.id = l.account_id
       where a.control_account = 'supplier'
       group by a.id, a.code order by a.code`);

    expect(rows).toEqual([
      { code: 'L970001', ledger: '400000.0000', subledger: '400000.0000' },
      { code: 'L970002', ledger: '600000.0000', subledger: '600000.0000' },
    ]);
  });
});
