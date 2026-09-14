/**
 * Operations build, block 10 — Purchase Return (2026-09-14).
 *
 *   Header    Supplier Name; Supplier Code; Date; Offset Account (Accounts
 *             Payable or Bank — one must be selected); Original Purchase
 *             Invoice Number.
 *   Lines     Item Name; Item Code; Return Quantity; Item Price from the
 *             original invoice; Warehouse from which the item will be returned.
 *   Control   The return quantity cannot exceed the remaining returnable
 *             quantity from the original Purchase Invoice after considering
 *             previous returns.
 *   Journal   Accounts Payable or Bank Dr. / Inventory Cr.
 *
 * Two things were missing and they are the two the Sales Return needed.
 *
 * The offset: goods going back either shrink what the company owes the
 * supplier or the supplier refunds the money. Booking a refund as a reduced
 * payable leaves the company still expecting to pay a debt that is already
 * settled — and, as with a sales return, nothing fails while it happens.
 *
 * And the source. The module was built for purchase order → goods receipt →
 * invoice, keying the return to the receipt line because that line carries the
 * cost layer. The sponsor's own route books stock straight off the invoice, and
 * a return against one of those could not be raised at all. The sponsor is
 * explicit that the quantity is controlled against *the invoice*, so that is
 * what this file holds it to.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as banks from '@/server/services/bank-cash-accounts';
import * as gr from '@/server/services/goods-return';
import * as inventory from '@/server/services/inventory';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const WAREHOUSE = 'WH-MAIN';
const BUY_ON = '2026-04-01';
const BACK_ON = '2026-04-10';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let supplierId: string;
let accounts: Record<string, string>;
let bankAccountId: string;

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

  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['customer_receivable', 'A000001', 'Trade Receivables'],
    ['bank', 'A000001', 'Bank Current Account'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
    ['return_clearing', 'L000001', 'Return Clearing'],
    ['sales_revenue', 'R000001', 'Product Sales'],
    ['cogs', 'X000001', 'Cost of Goods Sold'],
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
        `${parent.slice(0, 1)}9${String(name.length).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        role === 'supplier_payable' ? 'supplier' : role === 'customer_receivable' ? 'customer' : null,
      ],
    );
    accounts[role] = rows[0].id;
    for (const event of [
      'purchasing.ap_invoice',
      'purchasing.supplier_credit_memo',
      'inventory.goods_return',
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
    await withScope(scope(manager), (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, is_stock, base_uom_code, tracking,
                         inventory_account_id, cogs_account_id)
       values ($1,'Solar Panel 550W',true,'EA','batch',$2,$3) returning id`,
      [PANEL, accounts.inventory, accounts.cogs],
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
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ('SUP-JINKO','Jinko Solar',false,true,'active',true) returning id`,
  );
  supplierId = partner[0].id;

  const bank = await withScope(scope(manager), (tx) =>
    banks.create(tx, manager, 'bank', {
      name: 'Rafidain Current Account',
      bankName: 'Rafidain Bank',
      accountNumber: 'RF-9001',
      currency: 'IQD',
      glAccountId: accounts.bank!,
      branchCode: BAGHDAD,
    }),
  );
  const { rows: banked } = await ownerPool.query(
    `select id from bank_cash_account where code = $1`,
    [bank.code],
  );
  bankAccountId = banked[0].id;

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
  for (const documentType of ['ap_invoice', 'goods_return', 'supplier_credit_memo']) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
      [documentType],
    );
  }
});

let seq = 0;

/** A posted Purchase Invoice that booked its own stock — block 4's route. */
async function buy(options: { quantity?: string; unitPrice?: string } = {}) {
  seq += 1;
  const made = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SI-${seq}`,
      purchaseOrderId: null,
      branchCode: BAGHDAD,
      invoiceDate: BUY_ON,
      dueDate: '2026-05-01',
      nonPoJustification: 'Bought directly.',
      nonPoApprovedBy: manager.principal.userId,
      lines: [
        {
          itemCode: PANEL,
          description: 'Solar Panel 550W',
          quantity: qty(options.quantity ?? '10'),
          unitPriceIqd: price(options.unitPrice ?? '100000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, made.id));
  await withScope(scope(manager), (tx) => ap.post(tx, manager, made.id));

  const { rows } = await ownerPool.query(
    `select id from ap_invoice_line where ap_invoice_id = $1 order by line_no`,
    [made.id],
  );
  return { ...made, lineId: rows[0].id as string };
}

type Offset =
  | { readonly offsetKind: 'payable' }
  | { readonly offsetKind: 'bank'; readonly offsetBankAccountId: string };

/** Raise a return against the invoice, approve it, and ship the goods back. */
async function sendBack(
  invoice: { id: string; lineId: string },
  quantity: string,
  offset: Offset = { offsetKind: 'payable' },
) {
  const created = await withScope(scope(clerk), (tx) =>
    gr.createFromInvoice(tx, clerk, {
      apInvoiceId: invoice.id,
      returnDate: BACK_ON,
      reason: 'Panels arrived cracked',
      ...offset,
      lines: [{ apInvoiceLineId: invoice.lineId, quantity: qty(quantity) }],
    }),
  );
  await withScope(scope(manager), (tx) => gr.approve(tx, manager, created.id));
  const posted = await withScope(scope(manager), (tx) => gr.post(tx, manager, created.id));
  return { ...created, ...posted };
}

/** The credit half: the supplier agrees the amount and the debt or cash moves. */
async function settle(goodsReturnId: string, amountIqd: bigint) {
  seq += 1;
  return withScope(scope(manager), (tx) =>
    gr.creditMemo(tx, manager, {
      goodsReturnId,
      supplierMemoNo: `SCM-${seq}`,
      memoDate: BACK_ON,
      amountIqd,
    }),
  );
}

const journalOf = async (journalEntryId: string) => {
  const { rows } = await ownerPool.query(
    `select a.name, sum(l.debit_iqd) debit, sum(l.credit_iqd) credit
       from journal_line l join chart_of_account a on a.id = l.account_id
      where l.journal_entry_id = $1 group by a.name order by a.name`,
    [journalEntryId],
  );
  return rows.map((r) => ({
    account: r.name as string,
    debit: Number(r.debit),
    credit: Number(r.credit),
  }));
};

const onHand = async () =>
  Number(
    (await withScope(scope(manager), (tx) => inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD)))
      .onHand,
  ) / 1_000_000;

const balanceOf = async (accountId: string) => {
  const { rows } = await ownerPool.query(
    `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0) balance
       from journal_line l where l.account_id = $1`,
    [accountId],
  );
  return Number(rows[0].balance);
};

// ---------------------------------------------------------------------------
describe('ops 10 · one offset account must be selected', () => {
  it('refuses a bank offset that does not say which bank', async () => {
    const invoice = await buy();

    await expect(
      withScope(scope(clerk), (tx) =>
        gr.createFromInvoice(tx, clerk, {
          apInvoiceId: invoice.id,
          returnDate: BACK_ON,
          reason: 'Cracked',
          offsetKind: 'bank',
          lines: [{ apInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/must name which bank or cash account/i);
  });

  it('refuses a payable offset that also names a bank', async () => {
    const invoice = await buy();

    await expect(
      withScope(scope(clerk), (tx) =>
        gr.createFromInvoice(tx, clerk, {
          apInvoiceId: invoice.id,
          returnDate: BACK_ON,
          reason: 'Cracked',
          offsetKind: 'payable',
          offsetBankAccountId: bankAccountId,
          lines: [{ apInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/reduces what the company owes the supplier/i);
  });

  it('refuses a closed bank account', async () => {
    const invoice = await buy();
    const { rows } = await ownerPool.query(`select code from bank_cash_account where id = $1`, [
      bankAccountId,
    ]);
    await withScope(scope(manager), (tx) =>
      banks.setActive(tx, manager, rows[0].code, false, 'Closed by the bank.'),
    );

    await expect(
      withScope(scope(clerk), (tx) =>
        gr.createFromInvoice(tx, clerk, {
          apInvoiceId: invoice.id,
          returnDate: BACK_ON,
          reason: 'Cracked',
          offsetKind: 'bank',
          offsetBankAccountId: bankAccountId,
          lines: [{ apInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/closed/i);
  });

  it('keeps the choice on the return, where it was made', async () => {
    const invoice = await buy();
    const sent = await sendBack(invoice, '2', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });

    const { rows } = await ownerPool.query(
      `select offset_kind, offset_bank_account_id from goods_return where id = $1`,
      [sent.id],
    );
    expect(rows[0].offset_kind).toBe('bank');
    expect(rows[0].offset_bank_account_id).toBe(bankAccountId);
  });
});

// ---------------------------------------------------------------------------
describe('ops 10 · a return can be raised against the invoice itself', () => {
  it('sends stock back out of the warehouse the invoice booked it into', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });
    expect(await onHand()).toBe(10);

    await sendBack(invoice, '3');
    expect(await onHand()).toBe(7);
  });

  it('values the return at what the invoice paid', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });
    const sent = await sendBack(invoice, '3');

    // Three panels at 100,000. Cr Inventory 300,000 against Return Clearing.
    expect(sent.costIqd).toBe(price('300000'));
    expect(await balanceOf(accounts.inventory!)).toBe(700_000);
  });

  it('refuses a line from a different invoice', async () => {
    const first = await buy();
    const second = await buy();

    await expect(
      withScope(scope(clerk), (tx) =>
        gr.createFromInvoice(tx, clerk, {
          apInvoiceId: first.id,
          returnDate: BACK_ON,
          reason: 'Cracked',
          offsetKind: 'payable',
          lines: [{ apInvoiceLineId: second.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/does not belong to purchase invoice/i);
  });

  it('refuses a return against an invoice that has not posted', async () => {
    seq += 1;
    const made = await withScope(scope(clerk), (tx) =>
      ap.create(tx, clerk, {
        supplierId,
        supplierInvoiceNo: `SI-${seq}`,
        purchaseOrderId: null,
        branchCode: BAGHDAD,
        invoiceDate: BUY_ON,
        dueDate: '2026-05-01',
        nonPoJustification: 'Bought directly.',
        nonPoApprovedBy: manager.principal.userId,
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: qty('5'),
            unitPriceIqd: price('100000'),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );
    const { rows } = await ownerPool.query(
      `select id from ap_invoice_line where ap_invoice_id = $1`,
      [made.id],
    );

    // Nothing is in the warehouse yet, so nothing can leave it.
    await expect(
      withScope(scope(clerk), (tx) =>
        gr.createFromInvoice(tx, clerk, {
          apInvoiceId: made.id,
          returnDate: BACK_ON,
          reason: 'Cracked',
          offsetKind: 'payable',
          lines: [{ apInvoiceLineId: rows[0].id, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/until it posts/i);
  });
});

// ---------------------------------------------------------------------------
describe('ops 10 · the journal follows the offset that was chosen', () => {
  it('debits Accounts Payable when the debt is reduced', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });
    const sent = await sendBack(invoice, '3');
    const memo = await settle(sent.id, price('300000'));

    expect(await journalOf(memo.journalEntryId)).toEqual([
      { account: 'Return Clearing', debit: 0, credit: 300_000 },
      { account: 'Trade Payables', debit: 300_000, credit: 0 },
    ]);
  });

  it('debits the bank when the supplier refunds the money', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });
    const sent = await sendBack(invoice, '3', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });
    const memo = await settle(sent.id, price('300000'));

    expect(await journalOf(memo.journalEntryId)).toEqual([
      { account: 'Bank Current Account', debit: 300_000, credit: 0 },
      { account: 'Return Clearing', debit: 0, credit: 300_000 },
    ]);
  });

  it('leaves the payable alone when the refund came into the bank', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });
    const sent = await sendBack(invoice, '3', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });
    await settle(sent.id, price('300000'));

    // The company still owes the whole invoice: the supplier sent cash, not a
    // credit. Booking this to Accounts Payable would have written off a debt
    // that is still outstanding.
    expect(await balanceOf(accounts.supplier_payable!)).toBe(-1_000_000);
  });

  it('empties the clearing account either way', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });
    const sent = await sendBack(invoice, '3', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });
    await settle(sent.id, price('300000'));

    // Dr Return Clearing when the goods shipped, Cr when the supplier settled.
    // Anything left is a credit the supplier has not given, and it must be
    // visible rather than absorbed.
    expect(await balanceOf(accounts.return_clearing!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('ops 10 · the return cannot exceed what is left to return', () => {
  it('refuses more than the invoice bought', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });

    await expect(sendBack(invoice, '11')).rejects.toThrow();
  });

  it('counts the returns already made', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });

    await sendBack(invoice, '8');
    await expect(sendBack(invoice, '3')).rejects.toThrow();
    await expect(sendBack(invoice, '2')).resolves.toBeDefined();
  });

  it('counts two lines of one document against the same invoice line', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });

    // Six and six on one return is twelve, and neither line is written yet when
    // the other is checked.
    await expect(
      withScope(scope(clerk), (tx) =>
        gr.createFromInvoice(tx, clerk, {
          apInvoiceId: invoice.id,
          returnDate: BACK_ON,
          reason: 'Cracked',
          offsetKind: 'payable',
          lines: [
            { apInvoiceLineId: invoice.lineId, quantity: qty('6') },
            { apInvoiceLineId: invoice.lineId, quantity: qty('6') },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it('reports what remains returnable', async () => {
    const invoice = await buy({ quantity: '10', unitPrice: '100000' });

    expect(
      await withScope(scope(manager), (tx) =>
        gr.availableToReturnFromInvoice(tx, invoice.lineId),
      ),
    ).toBe(qty('10'));

    await sendBack(invoice, '4');

    expect(
      await withScope(scope(manager), (tx) =>
        gr.availableToReturnFromInvoice(tx, invoice.lineId),
      ),
    ).toBe(qty('6'));
  });
});
