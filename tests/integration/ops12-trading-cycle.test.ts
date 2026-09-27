/**
 * The Operations build as one system — the final pre-production check
 * (2026-09-26).
 *
 * Every other ops file proves one block. This one proves they hold together,
 * because that is a different question: each block can be right on its own and
 * the company can still end the day with stock it does not have and a debt it
 * has already paid. The sponsor asked for it in those words — *"test the system
 * as a complete integrated ERP, not feature by feature only... verify that the
 * data remains correct from the initial entry through inventory, accounting,
 * payments/receipts, returns, warehouse movements, and reporting."*
 *
 * So this is one trading cycle, start to finish, with the same five questions
 * asked after every step:
 *
 *   the warehouse   how many are actually there
 *   the ledger      what the journals say it is worth
 *   the subledger   what the partner's own account says
 *   the report      what the trial balance totals to
 *   and the two     that the subledger and its control account still agree
 *
 * The figures are chosen so FIFO is visible in the arithmetic rather than
 * asserted about: two purchase layers at different costs, and a sale that eats
 * all of the first and part of the second. If the cost of sales comes to
 * 124,000 it consumed the older layer first; any other number and it did not.
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
import * as inventory from '@/server/services/inventory';
import * as pay from '@/server/services/supplier-payment';
import * as receipts from '@/server/services/customer-receipt';
import * as statement from '@/server/services/partner-statement';
import * as subledger from '@/server/services/subledger';
import * as trialBalance from '@/server/services/trial-balance';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const WAREHOUSE = 'WH-MAIN';
const BUY_ON = '2026-04-01';
const SELL_ON = '2026-04-10';
const YEAR = { from: '2026-01-01', to: '2026-12-31' } as const;

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);
const money = (value: string) => Number(value);

let clerk: ActorContext;
let manager: ActorContext;
let supplierId: string;
let customerId: string;
let bankAccountId: string;
let accounts: Record<string, string>;

const SUPPLIER = 'SUP-JINKO';
const CUSTOMER = 'CUST-ALNOOR';

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

/** Every event the cycle posts through, so no step stops on a missing mapping. */
const EVENTS = [
  'purchasing.ap_invoice',
  'purchasing.supplier_payment',
  'purchasing.supplier_credit_memo',
  'sales.ar_invoice',
  'sales.customer_receipt',
  'sales.customer_receipt_identified',
  'sales.customer_credit_memo',
  'inventory.goods_return',
] as const;

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
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['inventory', 'A000001', 'Inventory', null],
    ['customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['customer_clearing', 'A000001', 'Receipts Not Yet Identified', null],
    ['bank', 'A000001', 'Bank Current Account', null],
    ['grni', 'L000001', 'Goods Received Not Invoiced', null],
    ['supplier_payable', 'L000001', 'Trade Payables', 'supplier'],
    ['return_clearing', 'L000001', 'Return Clearing', null],
    ['sales_revenue', 'R000001', 'Product Sales', null],
    ['sales_returns', 'R000001', 'Sales Returns', null],
    ['cogs', 'X000001', 'Cost of Goods Sold', null],
    ['expense', 'X000001', 'Service and Expense Cost', null],
    ['purchase_variance', 'X000001', 'Purchase Price Variance', null],
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
        // A serial, not the name's length: two names of one length ("Product
        // Sales", "Sales Returns") collided on the unique code.
        `${parent.slice(0, 1)}9${String((serial += 1)).padStart(5, '0')}`,
        name,
        parents[0].account_type,
        parents[0].id,
        control,
      ],
    );
    accounts[role] = rows[0].id;
    for (const event of EVENTS) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1,$2,$3,true,$4) on conflict do nothing`,
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
                         inventory_account_id, cogs_account_id, sales_account_id)
       values ($1,'Solar Panel 550W',true,'EA','batch',$2,$3,$4) returning id`,
      [PANEL, accounts.inventory, accounts.cogs, accounts.sales_revenue],
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

  const { rows: supplier } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ($1,'Jinko Solar',false,true,'active',true) returning id`,
    [SUPPLIER],
  );
  supplierId = supplier[0].id;

  const { rows: customer } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ($1,'Al Noor Trading',true,false,'active',true) returning id`,
    [CUSTOMER],
  );
  customerId = customer[0].id;

  const bank = await withScope(scope(manager), (tx) =>
    banks.create(tx, manager, 'bank', {
      name: 'Rafidain Current Account',
      bankName: 'Rafidain Bank',
      accountNumber: 'RF-9001',
      currency: 'IQD',
      glAccountId: accounts.bank!,
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
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code='FY2026'`);
  for (const [no, name, from, to] of [
    [4, 'April 2026', '2026-04-01', '2026-04-30'],
    [5, 'May 2026', '2026-05-01', '2026-05-31'],
  ] as const) {
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [years[0].id, no, name, from, to],
    );
  }
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by)
     values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );
  for (const documentType of [
    'ap_invoice',
    'ar_invoice',
    'customer_receipt',
    'supplier_payment',
    'goods_return',
    'supplier_credit_memo',
    'customer_credit_memo',
    'sales_return',
  ]) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement='optional'`,
      [documentType],
    );
  }
});

let seq = 0;

/** Block 4: a Purchase Invoice that receives its own stock, approved and posted. */
async function buy(quantity: string, unitPrice: string) {
  seq += 1;
  const made = await withScope(scope(clerk), (tx) =>
    ap.create(tx, clerk, {
      supplierId,
      supplierInvoiceNo: `SI-${seq}`,
      purchaseOrderId: null,
      branchCode: BAGHDAD,
      invoiceDate: BUY_ON,
      dueDate: '2026-05-01',
      nonPoJustification: 'Bought directly from the supplier.',
      nonPoApprovedBy: manager.principal.userId,
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
  // "The invoice is not posted until CEO approval" — submit, then post. There
  // is no transition from draft straight to posted for either invoice.
  await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, made.id));
  await withScope(scope(manager), (tx) => ap.post(tx, manager, made.id));
  return made;
}

/** Block 5: a Sales Invoice that ships its own stock, approved and posted. */
async function sell(quantity: string, unitPrice: string) {
  const made = await withScope(scope(clerk), (tx) =>
    ar.createDirect(tx, clerk, {
      customerId,
      branchCode: BAGHDAD,
      invoiceDate: SELL_ON,
      dueDate: '2026-05-20',
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
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, made.id));
  await withScope(scope(manager), (tx) => ar.post(tx, manager, made.id));
  return made;
}

/** What the warehouse actually holds. */
const onHand = async () =>
  Number(
    (await withScope(scope(manager), (tx) => inventory.positionOf(tx, PANEL, WAREHOUSE, BAGHDAD)))
      .onHand,
  ) / 1_000_000; // a position is held at six decimal places

/** What one account's journals come to, debit less credit. */
async function ledger(role: string): Promise<number> {
  const { rows } = await ownerPool.query(
    `select coalesce(sum(l.debit_iqd) - sum(l.credit_iqd), 0)::text as balance
       from journal_line l
       join journal_entry e on e.id = l.journal_entry_id
      where l.account_id = $1 and e.status in ('posted','reversed')`,
    [accounts[role]],
  );
  return Number(rows[0].balance);
}

/** What a partner's own Account Statement closes at. */
const closing = async (side: 'customer' | 'supplier', code: string) =>
  money(
    (await withScope(scope(manager), (tx) => statement.statementFor(tx, side, code, YEAR))).closing,
  );

/**
 * The two questions a set of books must answer at any moment: that every
 * journal balances, and that each control account still equals the subledger
 * kept beside it.
 */
async function booksAgree() {
  const balance = await withScope(scope(manager), (tx) =>
    trialBalance.trialBalance(tx, { ...YEAR, branchCode: BAGHDAD }),
  );
  const totals = trialBalance.totalsOf(balance);

  const reconciliation = await withScope(scope(manager), (tx) => subledger.reconciliation(tx));
  const adrift = reconciliation.filter((row) => Number(row.difference) !== 0);

  return { difference: totals.difference, balances: totals.balances, adrift };
}

// ---------------------------------------------------------------------------

describe('the Operations build, driven as one system', () => {
  it('keeps stock, ledger, subledger and reports agreeing through a whole cycle', async () => {
    // ── Buy, twice, at two different costs ─────────────────────────────────
    // Block 4: "A Purchase Invoice increases stock in the selected warehouse",
    // "Inventory Dr. / Accounts Payable Cr."
    await buy('100', '1000'); // 100,000
    await buy('50', '1200'); //  60,000

    expect(await onHand()).toBe(150);
    expect(await ledger('inventory')).toBe(160_000);
    expect(await ledger('supplier_payable')).toBe(-160_000); // a credit
    expect(await closing('supplier', SUPPLIER)).toBe(160_000); // owed to them

    let state = await booksAgree();
    expect(state.balances).toBe(true);
    expect(state.adrift).toEqual([]);

    // ── Sell 120, which eats the first layer and bites into the second ─────
    // Block 5: "decreases stock from the selected warehouse", "Accounts
    // Receivable Dr. / Revenue Cr. / Inventory Cr. / COGS Dr.", "COGS is
    // calculated using FIFO".
    await sell('120', '2000'); // 240,000 of revenue

    expect(await onHand()).toBe(30);

    // 100 at 1,000 and 20 at 1,200. Any other figure is not FIFO: average cost
    // would be 128,000 and last-in-first-out 122,000.
    expect(await ledger('cogs')).toBe(124_000);
    expect(await ledger('inventory')).toBe(160_000 - 124_000);
    expect(await ledger('sales_revenue')).toBe(-240_000);
    expect(await ledger('customer_receivable')).toBe(240_000);
    expect(await closing('customer', CUSTOMER)).toBe(240_000); // owed by them

    state = await booksAgree();
    expect(state.balances).toBe(true);
    expect(state.adrift).toEqual([]);

    // ── Negative stock is not allowed (block 11) ───────────────────────────
    // Asked for in the middle of a live cycle rather than from a clean start,
    // because that is where it would actually be met.
    await expect(sell('31', '2000')).rejects.toThrow(/[Nn]egative stock|more .* than/);
    expect(await onHand()).toBe(30); // and the refusal moved nothing

    // ── Pay the supplier part of what is owed (block 6) ────────────────────
    const payment = await withScope(scope(clerk), (tx) =>
      pay.create(tx, clerk, {
        supplierId,
        bankCashAccountId: bankAccountId,
        branchCode: BAGHDAD,
        paymentDate: '2026-04-20',
        amountIqd: price('100000'),
        reference: 'TRF-1',
      }),
    );
    // A payment has no approval step of its own: posting it is the act, and
    // the authority to post is what gates it.
    await withScope(scope(manager), (tx) => pay.post(tx, manager, payment.id));

    // "Accounts Payable Dr. / Bank or Cash Cr."
    expect(await ledger('supplier_payable')).toBe(-60_000);
    expect(await ledger('bank')).toBe(-100_000);
    expect(await closing('supplier', SUPPLIER)).toBe(60_000);

    // ── Receive part of what the customer owes (block 6) ───────────────────
    const receipt = await withScope(scope(manager), (tx) =>
      receipts.create(tx, manager, {
        customerId,
        branchCode: BAGHDAD,
        receiptDate: '2026-04-25',
        bankCashAccountId: bankAccountId,
        amountIqd: price('150000'),
        bankReference: 'TRF-2',
      }),
    );
    await withScope(scope(manager), (tx) => receipts.approve(tx, manager, receipt.id));
    await withScope(scope(manager), (tx) => receipts.post(tx, manager, receipt.id));

    // "Bank or Cash Dr. / Accounts Receivable Cr."
    expect(await ledger('customer_receivable')).toBe(90_000);
    expect(await ledger('bank')).toBe(50_000); // 150,000 in less 100,000 out
    expect(await closing('customer', CUSTOMER)).toBe(90_000);

    // ── And the books still agree, after all of it ─────────────────────────
    state = await booksAgree();
    expect(state.difference).toBe('0.0000');
    expect(state.balances).toBe(true);
    expect(state.adrift).toEqual([]);
  });
});
