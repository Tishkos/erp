/**
 * Operations build, block 9 — Sales Returns (2026-09-14).
 *
 *   Header    Customer Name; Customer Code; Date; Offset Account (Accounts
 *             Receivable or Bank — one must be selected); Original Sales
 *             Invoice Number.
 *   Quantity  The return quantity cannot exceed the remaining returnable
 *             quantity from the original Sales Invoice after considering
 *             previous returns.
 *   Journal   Sales Return Dr. / Accounts Receivable or Bank Cr. /
 *             Inventory Dr. / COGS Cr.
 *   Cost      The Inventory and COGS amounts for each returned item are taken
 *             from the original Sales Invoice item cost.
 *
 * Three of those four were already built and are re-tested here against the
 * direct Sales Invoice of block 5, which is the document the sponsor's returns
 * actually come from. The new one is the offset.
 *
 * It matters more than it reads. A return settles two ways: if the customer
 * has not paid, the credit reduces what they owe; if they have, the company
 * hands the money back. The system chose Accounts Receivable every time —
 * right for the first case, silently wrong for the second, which leaves a
 * receivable the customer does not owe and a bank balance the company does not
 * have. Nothing fails; the books drift. So most of this file is the offset,
 * tested from both sides and from the ways it could be left half-chosen.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as banks from '@/server/services/bank-cash-accounts';
import * as sr from '@/server/services/sales-return';
import * as memos from '@/server/services/customer-credit-memo';
import * as inventory from '@/server/services/inventory';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const WAREHOUSE = 'WH-MAIN';
const BUY_ON = '2026-04-01';
const SELL_ON = '2026-04-20';
const BACK_ON = '2026-04-25';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let customerId: string;
let supplierId: string;
let accounts: Record<string, string>;
let bankAccountId: string;
let bankGlAccountId: string;

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

  accounts = {};
  for (const [role, parent, name] of [
    ['inventory', 'A000001', 'Inventory'],
    ['customer_receivable', 'A000001', 'Trade Receivables'],
    ['bank', 'A000001', 'Bank Current Account'],
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
    ['sales_revenue', 'R000001', 'Product Sales'],
    ['cogs', 'X000001', 'Cost of Goods Sold'],
    ['sales_returns', 'X000001', 'Sales Returns'],
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
      'sales.ar_invoice',
      'sales.customer_credit_memo',
      'inventory.sales_return',
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

  const partner = async (code: string, name: string, kind: 'customer' | 'supplier') => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
       values ($1,$2,$3,$4,'active',true) returning id`,
      [code, name, kind === 'customer', kind === 'supplier'],
    );
    return rows[0].id as string;
  };
  customerId = await partner('CUST-001', 'Al Noor Trading', 'customer');
  supplierId = await partner('SUP-JINKO', 'Jinko Solar', 'supplier');

  // The bank the refund can come out of — block 6's master data.
  bankGlAccountId = accounts.bank!;
  const bank = await withScope(scope(manager), (tx) =>
    banks.create(tx, manager, 'bank', {
      name: 'Rafidain Current Account',
      bankName: 'Rafidain Bank',
      accountNumber: 'RF-9001',
      currency: 'IQD',
      glAccountId: bankGlAccountId,
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
  for (const documentType of ['ap_invoice', 'ar_invoice', 'customer_credit_memo']) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
      [documentType],
    );
  }
});

let seq = 0;

/** Stock in, so there is something to sell and something to take back. */
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
}

/** A posted Sales Invoice, and the id of its one line. */
async function sell(
  quantity = '4',
  unitPrice = '250000',
  accounting: Partial<ar.InvoiceAccountingDimensions> = {},
) {
  const invoice = await withScope(scope(clerk), (tx) =>
    ar.createDirect(tx, clerk, {
      customerId,
      branchCode: BAGHDAD,
      invoiceDate: SELL_ON,
      dueDate: '2026-05-20',
      ...accounting,
      lines: [
        {
          itemCode: PANEL,
          quantity: qty(quantity),
          unitPriceIqd: price(unitPrice),
          warehouseCode: WAREHOUSE,
        },
      ],
    }),
  );
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));
  const view = await withScope(scope(manager), (tx) => ar.view(tx, invoice.id));
  return { ...invoice, lineId: view.lines[0]!.id };
}

type Offset =
  | { readonly offsetKind: 'receivable' }
  | { readonly offsetKind: 'bank'; readonly offsetBankAccountId: string };

/** Requested → Received → Inspected → Accepted, at the sponsor's four columns. */
async function takeBack(
  invoice: { id: string; lineId: string },
  quantity: string,
  offset: Offset = { offsetKind: 'receivable' },
) {
  const created = await withScope(scope(clerk), (tx) =>
    sr.request(tx, clerk, {
      arInvoiceId: invoice.id,
      requestedOn: BACK_ON,
      reason: 'Customer ordered the wrong panel',
      ...offset,
      lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty(quantity) }],
    }),
  );

  const view = await withScope(scope(manager), (tx) => sr.view(tx, created.id));

  await withScope(scope(manager), (tx) =>
    sr.receiveGoods(tx, manager, created.id, {
      receivedOn: BACK_ON,
      lines: [{ salesReturnLineId: view.lines[0]!.id, quantity: qty(quantity) }],
    }),
  );
  await withScope(scope(manager), (tx) =>
    sr.inspect(tx, manager, created.id, [
      {
        salesReturnLineId: view.lines[0]!.id,
        acceptedQuantity: qty(quantity),
        disposition: 'saleable',
        destinationWarehouseCode: WAREHOUSE,
      },
    ]),
  );
  const accepted = await withScope(scope(manager), (tx) => sr.accept(tx, manager, created.id));

  return { ...created, lineId: view.lines[0]!.id, ...accepted };
}

/** The credit half: raise the memo against the return and post it. */
async function credit(salesReturnId: string) {
  const memo = await withScope(scope(clerk), (tx) =>
    memos.create(tx, clerk, { salesReturnId, memoDate: BACK_ON }),
  );
  await withScope(scope(manager), (tx) => memos.approve(tx, manager, memo.id));
  return withScope(scope(manager), (tx) => memos.post(tx, manager, memo.id));
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

// ---------------------------------------------------------------------------
describe('ops 9 · one offset account must be selected', () => {
  it('refuses a bank offset that does not say which bank', async () => {
    await buy();
    const invoice = await sell();

    await expect(
      withScope(scope(clerk), (tx) =>
        sr.request(tx, clerk, {
          arInvoiceId: invoice.id,
          requestedOn: BACK_ON,
          reason: 'Wrong panel',
          offsetKind: 'bank',
          lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/must name which bank or cash account/i);
  });

  it('refuses a receivable offset that also names a bank', async () => {
    await buy();
    const invoice = await sell();

    // Not pedantry: a return carrying both would leave the posting step to
    // guess, and the guess is the thing this block exists to remove.
    await expect(
      withScope(scope(clerk), (tx) =>
        sr.request(tx, clerk, {
          arInvoiceId: invoice.id,
          requestedOn: BACK_ON,
          reason: 'Wrong panel',
          offsetKind: 'receivable',
          offsetBankAccountId: bankAccountId,
          lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/credits the customer, not a bank account/i);
  });

  it('refuses a bank that does not exist', async () => {
    await buy();
    const invoice = await sell();

    await expect(
      withScope(scope(clerk), (tx) =>
        sr.request(tx, clerk, {
          arInvoiceId: invoice.id,
          requestedOn: BACK_ON,
          reason: 'Wrong panel',
          offsetKind: 'bank',
          offsetBankAccountId: randomUUID(),
          lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/No bank or cash account/i);
  });

  it('refuses a closed bank account', async () => {
    await buy();
    const invoice = await sell();
    const { rows } = await ownerPool.query(`select code from bank_cash_account where id = $1`, [
      bankAccountId,
    ]);
    await withScope(scope(manager), (tx) =>
      banks.setActive(tx, manager, rows[0].code, false, 'Closed by the bank.'),
    );

    await expect(
      withScope(scope(clerk), (tx) =>
        sr.request(tx, clerk, {
          arInvoiceId: invoice.id,
          requestedOn: BACK_ON,
          reason: 'Wrong panel',
          offsetKind: 'bank',
          offsetBankAccountId: bankAccountId,
          lines: [{ arInvoiceLineId: invoice.lineId, quantity: qty('1') }],
        }),
      ),
    ).rejects.toThrow(/closed/i);
  });

  it('keeps the choice on the return, where it was made', async () => {
    await buy();
    const invoice = await sell();
    const taken = await takeBack(invoice, '1', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });

    const { rows } = await ownerPool.query(
      `select offset_kind, offset_bank_account_id from sales_return where id = $1`,
      [taken.id],
    );
    expect(rows[0].offset_kind).toBe('bank');
    expect(rows[0].offset_bank_account_id).toBe(bankAccountId);
  });
});

// ---------------------------------------------------------------------------
describe('ops 9 · the journal follows the offset that was chosen', () => {
  it('credits Accounts Receivable when the customer has not been paid back', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');
    const taken = await takeBack(invoice, '2');
    const posted = await credit(taken.id);

    // Sales Return Dr. 500,000 / Accounts Receivable Cr. 500,000
    expect(await journalOf(posted.journalEntryId)).toEqual([
      { account: 'Sales Returns', debit: 500_000, credit: 0 },
      { account: 'Trade Receivables', debit: 0, credit: 500_000 },
    ]);
  });

  it('credits the bank when the money goes back to the customer', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');
    const taken = await takeBack(invoice, '2', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });
    const posted = await credit(taken.id);

    expect(await journalOf(posted.journalEntryId)).toEqual([
      { account: 'Bank Current Account', debit: 0, credit: 500_000 },
      { account: 'Sales Returns', debit: 500_000, credit: 0 },
    ]);
  });

  it('leaves the receivable alone when the refund came out of the bank', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');
    const taken = await takeBack(invoice, '2', {
      offsetKind: 'bank',
      offsetBankAccountId: bankAccountId,
    });
    await credit(taken.id);

    // The customer still owes the whole invoice: they were handed cash, not a
    // credit. Booking this to Accounts Receivable would have written off half
    // of a debt that is still outstanding.
    const { rows } = await ownerPool.query(
      `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0) balance
         from journal_line l where l.account_id = $1`,
      [accounts.customer_receivable],
    );
    expect(Number(rows[0].balance)).toBe(1_000_000);
  });

  it('carries the direct invoice dimensions through the return without changing contra-revenue', async () => {
    await ownerPool.query(
      `insert into business_line (code,name,active) values ('RET_DIM','Returned Sales',true)
       on conflict (code) do update set active = true`,
    );
    for (const [documentType, name, module] of [
      ['customer_credit_memo', 'Customer Credit Memo', 'sales'],
      ['inventory.sales_return', 'Sales Return', 'inventory'],
    ] as const) {
      await ownerPool.query(
        `insert into document_type (code,name,module) values ($1,$2,$3) on conflict (code) do nothing`,
        [documentType, name, module],
      );
      for (const dimension of ['business_line', 'department']) {
        await ownerPool.query(
          `insert into document_type_dimension (document_type_code,dimension,requirement)
           values ($1,$2,'mandatory') on conflict (document_type_code,dimension)
           do update set requirement = 'mandatory'`,
          [documentType, dimension],
        );
      }
    }
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000', {
      businessLineCode: 'RET_DIM',
      departmentCode: 'FIN',
    });
    const taken = await takeBack(invoice, '2');
    const posted = await credit(taken.id);
    expect(await onHand()).toBe(8);
    expect(await journalOf(posted.journalEntryId)).toEqual([
      { account: 'Sales Returns', debit: 500_000, credit: 0 },
      { account: 'Trade Receivables', debit: 0, credit: 500_000 },
    ]);
    const { rows: memoLines } = await ownerPool.query(
      `select business_line_code, department_code from journal_line where journal_entry_id = $1`,
      [posted.journalEntryId],
    );
    expect(memoLines).toEqual([
      { business_line_code: 'RET_DIM', department_code: 'FIN' },
      { business_line_code: 'RET_DIM', department_code: 'FIN' },
    ]);
    const { rows: returnLines } = await ownerPool.query(
      `select l.business_line_code, l.department_code
         from journal_line l
        where l.journal_entry_id = (select journal_entry_id from inventory_movement where id = $1)`,
      [taken.movementIds?.[0] ?? null],
    );
    expect(returnLines).toEqual([
      { business_line_code: 'RET_DIM', department_code: 'FIN' },
      { business_line_code: 'RET_DIM', department_code: 'FIN' },
    ]);
    const { rows: statement } = await ownerPool.query(
      `select coalesce(sum(debit_iqd) - sum(credit_iqd),0)::text as balance
         from subledger_entry where subledger_type='customer' and party_code='CUST-001'`,
    );
    expect(statement[0].balance).toBe('500000.0000');
  });

  it('puts the stock back and reverses its cost, at the original invoice cost', async () => {
    // Bought at 100,000; sold 4; two come back. Inventory Dr. / COGS Cr. at
    // 200,000 — what the sale took out, not today's price.
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');
    expect(await onHand()).toBe(6);

    const taken = await takeBack(invoice, '2');
    expect(await onHand()).toBe(8);

    const { rows } = await ownerPool.query(
      `select a.name, sum(l.debit_iqd) debit, sum(l.credit_iqd) credit
         from journal_line l
         join chart_of_account a on a.id = l.account_id
         join journal_entry e on e.id = l.journal_entry_id
        where e.id = (select journal_entry_id from inventory_movement where id = $1)
        group by a.name order by a.name`,
      [taken.movementIds?.[0] ?? null],
    );
    expect(
      rows.map((r) => ({ account: r.name, debit: Number(r.debit), credit: Number(r.credit) })),
    ).toEqual([
      { account: 'Cost of Goods Sold', debit: 0, credit: 200_000 },
      { account: 'Inventory', debit: 200_000, credit: 0 },
    ]);
  });

  it('takes the cost from the original invoice even after the price has moved', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');
    // A later, dearer purchase. The return must not be valued at this.
    await buy({ quantity: '10', unitPrice: '175000' });

    const taken = await takeBack(invoice, '2');
    const { rows } = await ownerPool.query(
      `select sum(l.debit_iqd) debit
         from journal_line l
        where l.account_id = $1
          and l.journal_entry_id = (select journal_entry_id from inventory_movement where id = $2)`,
      [accounts.inventory, taken.movementIds?.[0] ?? null],
    );
    expect(Number(rows[0].debit)).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
describe('ops 9 · the return cannot exceed what is left to return', () => {
  it('refuses more than the invoice sold', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');

    await expect(takeBack(invoice, '5')).rejects.toThrow();
  });

  it('counts the returns already made', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');

    await takeBack(invoice, '3');
    // One left of four. Two is one too many.
    await expect(takeBack(invoice, '2')).rejects.toThrow();
    await expect(takeBack(invoice, '1')).resolves.toBeDefined();
  });

  it('reports what remains returnable', async () => {
    await buy({ quantity: '10', unitPrice: '100000' });
    const invoice = await sell('4', '250000');

    const before = await withScope(scope(manager), (tx) => sr.returnableFor(tx, invoice.id));
    expect(Number(before[0]!.returnable)).toBe(4);

    await takeBack(invoice, '3');

    const after = await withScope(scope(manager), (tx) => sr.returnableFor(tx, invoice.id));
    expect(Number(after[0]!.returnable)).toBe(1);
  });
});
