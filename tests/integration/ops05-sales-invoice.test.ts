/**
 * Operations build, block 5 — the Sales Invoice sells stock (2026-09-12).
 *
 *   Effect   A Sales Invoice decreases stock from the selected warehouse.
 *   Journal  Accounts Receivable Dr. / Revenue Cr. / Inventory Cr. / COGS Dr.
 *   COGS     FIFO. "The item cost follows the selected item, supplier and
 *            warehouse stock."
 *   Supplier "The same item can be entered on separate invoice lines under
 *            different suppliers when required."
 *
 * The last two sentences are the whole of the difficulty. Cost has always been
 * FIFO per item and per warehouse; the sponsor adds the supplier, which makes
 * the same panel bought from two suppliers two pools of stock that must not be
 * consumed from each other. This file is mostly that claim, tested from the
 * directions it could fail in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as ap from '@/server/services/ap-invoice';
import * as ar from '@/server/services/ar-invoice';
import * as inventory from '@/server/services/inventory';
import * as journal from '@/server/services/journal';
import * as audit from '@/server/services/audit';
import * as posting from '@/server/services/posting';
import * as subledger from '@/server/services/subledger';
import * as trialBalance from '@/server/services/trial-balance';
import { parseDecimal } from '@/server/domain/money';
import { PermissionDeniedError } from '@/server/domain/permissions';
import { NoPostingRuleError } from '@/server/domain/posting';
import { parseQuantity } from '@/server/domain/uom';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const PANEL = 'ITM-PANEL';
const WAREHOUSE = 'WH-MAIN';
const OTHER = 'WH-SPARE';
const BUY_ON = '2026-04-01';
const SELL_ON = '2026-04-20';

const qty = (units: string) => parseQuantity(units);
const price = (iqd: string) => parseDecimal(iqd, 4n);

let clerk: ActorContext;
let manager: ActorContext;
let customerId: string;
let jinko: string;
let longi: string;
let accounts: Record<string, string>;

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
    ['grni', 'L000001', 'Goods Received Not Invoiced'],
    ['supplier_payable', 'L000001', 'Trade Payables'],
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
    for (const event of ['purchasing.ap_invoice', 'sales.ar_invoice'] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
         values ($1, $2, $3, true, $4) on conflict do nothing`,
        [event, role, rows[0].id, manager.principal.userId],
      );
    }
    await withScope(scope(manager), (tx) =>
      coa.setRequiredDimensions(tx, manager, rows[0].id, []),
    );
  }

  // The item knows where its stock lives and what it costs — Operations 1.
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

  for (const [code, name] of [
    [WAREHOUSE, 'Main Warehouse'],
    [OTHER, 'Spare Warehouse'],
  ] as const) {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type)
       values ($1,$2,$3,'main') on conflict do nothing`,
      [code, name, BAGHDAD],
    );
  }

  const partner = async (code: string, name: string, kind: 'customer' | 'supplier') => {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
       values ($1,$2,$3,$4,'active',true) returning id`,
      [code, name, kind === 'customer', kind === 'supplier'],
    );
    return rows[0].id as string;
  };
  customerId = await partner('CUST-001', 'Al Noor Trading', 'customer');
  jinko = await partner('SUP-JINKO', 'Jinko Solar', 'supplier');
  longi = await partner('SUP-LONGI', 'Longi Green', 'supplier');

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
  for (const documentType of ['ap_invoice', 'ar_invoice']) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
      [documentType],
    );
  }
});

let seq = 0;

/** Stock in: a purchase invoice from one supplier at one price. */
async function buy(
  supplierId: string,
  options: { quantity?: string; unitPrice?: string; warehouseCode?: string; itemCode?: string; description?: string } = {},
) {
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
          itemCode: options.itemCode ?? PANEL,
          description: options.description ?? 'Solar Panel 550W',
          quantity: qty(options.quantity ?? '10'),
          unitPriceIqd: price(options.unitPrice ?? '100000'),
          uomCode: 'EA',
          isInventory: true,
          warehouseCode: options.warehouseCode ?? WAREHOUSE,
        },
      ],
    }),
  );
  await withScope(scope(clerk), (tx) => ap.submit(tx, clerk, made.id));
  await withScope(scope(manager), (tx) => ap.post(tx, manager, made.id));
}

/** Stock out: a sales invoice raised on its own. */
async function sell(
  lines: Array<{
    quantity: string;
    unitPrice: string;
    discount?: string;
    supplierId?: string | null;
    warehouseCode?: string;
    itemCode?: string;
  }>,
  accounting: Partial<ar.InvoiceAccountingDimensions> = {},
) {
  return withScope(scope(clerk), (tx) =>
    ar.createDirect(tx, clerk, {
      customerId,
      branchCode: BAGHDAD,
      invoiceDate: SELL_ON,
      dueDate: '2026-05-20',
      ...accounting,
      lines: lines.map((line) => ({
        itemCode: line.itemCode ?? PANEL,
        quantity: qty(line.quantity),
        unitPriceIqd: price(line.unitPrice),
        warehouseCode: line.warehouseCode ?? WAREHOUSE,
        ...(line.discount ? { discountIqd: price(line.discount) } : {}),
        ...('supplierId' in line ? { supplierId: line.supplierId } : {}),
      })),
    }),
  );
}

/**
 * The sponsor: "the invoice is not posted until CEO approval." Approval is a
 * manager's, and posting is a separate step after it — so a clerk cannot do
 * both, and nothing moves until somebody with the authority says so.
 */
const postSale = async (id: string) => {
  await withScope(scope(manager), (tx) => ar.approve(tx, manager, id));
  return withScope(scope(manager), (tx) => ar.post(tx, manager, id));
};

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

const stockOf = async (itemCode: string, warehouseCode = WAREHOUSE) =>
  Number(
    (
      await withScope(scope(manager), (tx) =>
        inventory.positionOf(tx, itemCode, warehouseCode, BAGHDAD),
      )
    ).onHand,
  ) / 1_000_000;
const onHand = async (warehouseCode = WAREHOUSE) => stockOf(PANEL, warehouseCode);

describe('ops 5 · approval, posting, stock and the ledger stay in step', () => {
  it('refuses a clerk approval and leaves the direct sale in draft', async () => {
    const invoice = await sell([{ quantity: '2', unitPrice: '150000' }]);

    await expect(
      withScope(scope(clerk), (tx) => ar.approve(tx, clerk, invoice.id)),
    ).rejects.toThrow(PermissionDeniedError);

    const { rows } = await ownerPool.query(`select status from ar_invoice where id = $1`, [
      invoice.id,
    ]);
    expect(rows[0].status).toBe('draft');
  });

  it('moves nothing on approval and reconciles stock, journal, statement and trial balance on post', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150000' }]);

    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
    expect(await onHand()).toBe(10);
    expect(
      await withScope(scope(manager), (tx) =>
        subledger.statementFor(tx, 'customer', 'CUST-001'),
      ),
    ).toEqual([]);

    const { journalEntryId } = await withScope(scope(manager), (tx) =>
      ar.post(tx, manager, invoice.id),
    );
    expect(await onHand()).toBe(8);
    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Cost of Goods Sold', debit: 200_000, credit: 0 },
      { account: 'Inventory', debit: 0, credit: 200_000 },
      { account: 'Product Sales', debit: 0, credit: 300_000 },
      { account: 'Trade Receivables', debit: 300_000, credit: 0 },
    ]);

    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'customer', 'CUST-001'),
    );
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({
      debitIqd: '300000.0000',
      creditIqd: '0.0000',
      sourceDocId: invoice.id,
    });

    const balance = await withScope(scope(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: BUY_ON, to: SELL_ON, branchCode: BAGHDAD }),
    );
    expect(balance.find((row) => row.accountName === 'Inventory')).toMatchObject({
      debit: '1000000.0000',
      credit: '200000.0000',
    });
    expect(balance.find((row) => row.accountName === 'Trade Payables')).toMatchObject({
      credit: '1000000.0000',
    });
    expect(balance.find((row) => row.accountName === 'Trade Receivables')).toMatchObject({
      debit: '300000.0000',
    });
    expect(balance.find((row) => row.accountName === 'Product Sales')).toMatchObject({
      credit: '300000.0000',
    });
    expect(balance.find((row) => row.accountName === 'Cost of Goods Sold')).toMatchObject({
      debit: '200000.0000',
    });
    expect(trialBalance.totalsOf(balance)).toMatchObject({
      difference: '0.0000',
      balances: true,
    });
  });

  it('requires post permission after approval and leaves the sale approved without moving stock', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150000' }]);
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
    const deniedCtx: ActorContext = {
      ...manager,
      principal: {
        ...manager.principal,
        grants: manager.principal.grants.filter(
          (grant) => !(grant.object === ar.PERMISSION_OBJECT && grant.verb === 'post'),
        ),
      },
    };

    await expect(
      withScope(scope(deniedCtx), (tx) => ar.post(tx, deniedCtx, invoice.id)),
    ).rejects.toThrow(PermissionDeniedError);

    const { rows } = await ownerPool.query(
      `select status, journal_entry_id from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(rows[0]).toMatchObject({ status: 'approved', journal_entry_id: null });
    expect(await onHand()).toBe(10);
  });

  it('keeps an approved sale atomic until a missing revenue mapping is restored', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150000' }]);
    await ownerPool.query(
      `update posting_rule set is_active = false where event_type = $1 and line_role = $2`,
      ['sales.ar_invoice', 'sales_revenue'],
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    await expect(
      withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)),
    ).rejects.toThrow(NoPostingRuleError);

    const { rows } = await ownerPool.query(
      `select status, journal_entry_id from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(rows[0]).toMatchObject({ status: 'approved', journal_entry_id: null });
    expect(await onHand()).toBe(10);
    expect(
      await withScope(scope(manager), (tx) =>
        subledger.statementFor(tx, 'customer', 'CUST-001'),
      ),
    ).toEqual([]);

    await withScope(scope(manager), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: 'sales.ar_invoice',
        lineRole: 'sales_revenue',
        accountId: accounts.sales_revenue!,
      }),
    );
    await withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id));

    expect(await onHand()).toBe(8);
    expect(
      await withScope(scope(manager), (tx) =>
        subledger.statementFor(tx, 'customer', 'CUST-001'),
      ),
    ).toHaveLength(1);
  });

  it('refuses a saved receivable mapping that is not customer-controlled until the chosen account is designated', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    await ownerPool.query(
      `update posting_rule set account_id = $1
        where event_type = 'sales.ar_invoice' and line_role = 'customer_receivable'`,
      [accounts.inventory],
    );
    const invoice = await sell([{ quantity: '2', unitPrice: '150000' }]);
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    await expect(
      withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)),
    ).rejects.toThrow(/customer control account/);

    const { rows: invoices } = await ownerPool.query(
      `select status, journal_entry_id from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(invoices[0]).toMatchObject({ status: 'approved', journal_entry_id: null });
    const { rows: journals } = await ownerPool.query(
      `select count(*)::int as n from journal_entry where source_doc_id = $1`,
      [invoice.id],
    );
    expect(journals[0].n).toBe(0);
    const { rows: movements } = await ownerPool.query(
      `select count(*)::int as n from inventory_movement
        where source_document_type = 'ar_invoice' and source_document_id = $1`,
      [invoice.id],
    );
    expect(movements[0].n).toBe(0);
    const { rows: subledgerRows } = await ownerPool.query(
      `select count(*)::int as n from subledger_entry where source_doc_id = $1`,
      [invoice.id],
    );
    expect(subledgerRows[0].n).toBe(0);
    expect(await onHand()).toBe(10);

    const { rows: assets } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const chosen = await withScope(scope(clerk), (tx) =>
      coa.createAccount(tx, clerk, {
        name: 'User-selected receivables',
        parentId: assets[0].id,
        currencyRestriction: 'IQD',
      }),
    );
    await withScope(scope(clerk), (tx) => coa.submitForApproval(tx, clerk, chosen.id));
    await withScope(scope(manager), (tx) => coa.approve(tx, manager, chosen.id));
    await withScope(scope(manager), (tx) =>
      coa.setControlAccount(tx, manager, chosen.id, 'customer'),
    );
    await withScope(scope(manager), (tx) =>
      coa.setRequiredDimensions(tx, manager, chosen.id, []),
    );
    await withScope(scope(manager), (tx) =>
      posting.setMapping(tx, manager, {
        eventType: 'sales.ar_invoice',
        lineRole: 'customer_receivable',
        accountId: chosen.id,
      }),
    );

    const { journalEntryId } = await withScope(scope(manager), (tx) =>
      ar.post(tx, manager, invoice.id),
    );
    expect(await onHand()).toBe(8);

    const { rows: journalLines } = await ownerPool.query(
      `select account_id, debit_iqd, credit_iqd from journal_line
        where journal_entry_id = $1 order by line_no`,
      [journalEntryId],
    );
    expect(journalLines).toEqual([
      { account_id: chosen.id, debit_iqd: '300000.0000', credit_iqd: '0.0000' },
      { account_id: accounts.sales_revenue, debit_iqd: '0.0000', credit_iqd: '300000.0000' },
      { account_id: accounts.cogs, debit_iqd: '200000.0000', credit_iqd: '0.0000' },
      { account_id: accounts.inventory, debit_iqd: '0.0000', credit_iqd: '200000.0000' },
    ]);

    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'customer', 'CUST-001'),
    );
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({
      debitIqd: '300000.0000',
      creditIqd: '0.0000',
      sourceDocId: invoice.id,
    });
    const balance = await withScope(scope(manager), (tx) =>
      trialBalance.trialBalance(tx, { from: BUY_ON, to: SELL_ON, branchCode: BAGHDAD }),
    );
    expect(trialBalance.totalsOf(balance)).toMatchObject({
      difference: '0.0000',
      balances: true,
    });
  });
});

// ---------------------------------------------------------------------------
describe('ops 5 · a sales invoice takes the stock and charges its cost', () => {
  it('posts all four parts: receivable, revenue, inventory and cost', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    const invoice = await sell([{ quantity: '4', unitPrice: '250000' }]);
    const { journalEntryId } = await postSale(invoice.id);

    expect(await journalOf(journalEntryId)).toEqual([
      { account: 'Cost of Goods Sold', debit: 400_000, credit: 0 },
      { account: 'Inventory', debit: 0, credit: 400_000 },
      { account: 'Product Sales', debit: 0, credit: 1_000_000 },
      { account: 'Trade Receivables', debit: 1_000_000, credit: 0 },
    ]);
  });

  it('decreases the stock in the warehouse it names', async () => {
    await buy(jinko, { quantity: '10' });
    expect(await onHand()).toBe(10);

    await postSale((await sell([{ quantity: '4', unitPrice: '250000' }])).id);
    expect(await onHand()).toBe(6);
  });

  it('costs the oldest stock first', async () => {
    await buy(jinko, { quantity: '5', unitPrice: '100000' });
    await buy(jinko, { quantity: '5', unitPrice: '140000' });

    // Seven sold: five at 100,000 and two at 140,000 — 780,000, not 7 × 140,000.
    const { journalEntryId } = await postSale(
      (await sell([{ quantity: '7', unitPrice: '250000' }])).id,
    );
    const posted = await journalOf(journalEntryId);
    expect(posted.find((l) => l.account === 'Cost of Goods Sold')!.debit).toBe(780_000);
  });

  it('takes the discount off the revenue and the receivable, not off the cost', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    const invoice = await sell([{ quantity: '4', unitPrice: '250000', discount: '200000' }]);
    const { journalEntryId } = await postSale(invoice.id);

    const posted = await journalOf(journalEntryId);
    expect(posted.find((l) => l.account === 'Product Sales')!.credit).toBe(800_000);
    expect(posted.find((l) => l.account === 'Trade Receivables')!.debit).toBe(800_000);
    // What the goods cost did not change because they were sold cheaper.
    expect(posted.find((l) => l.account === 'Cost of Goods Sold')!.debit).toBe(400_000);
  });
});

// ---------------------------------------------------------------------------
describe('ops 5 · the cost follows the supplier', () => {
  it('consumes the named supplier’s stock, not the oldest of all', async () => {
    // Jinko's is older and cheaper; Longi's is newer and dearer.
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    await buy(longi, { quantity: '10', unitPrice: '150000' });

    const { journalEntryId } = await postSale(
      (await sell([{ quantity: '4', unitPrice: '250000', supplierId: longi }])).id,
    );

    const posted = await journalOf(journalEntryId);
    // 4 × 150,000 — Longi's. Oldest-first across both would have said 400,000.
    expect(posted.find((l) => l.account === 'Cost of Goods Sold')!.debit).toBe(600_000);
  });

  it('sells the same item twice on one invoice, under two suppliers', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100000' });
    await buy(longi, { quantity: '10', unitPrice: '150000' });

    const invoice = await sell([
      { quantity: '3', unitPrice: '250000', supplierId: jinko },
      { quantity: '2', unitPrice: '250000', supplierId: longi },
    ]);
    const { journalEntryId } = await postSale(invoice.id);

    const posted = await journalOf(journalEntryId);
    // 3 × 100,000 + 2 × 150,000.
    expect(posted.find((l) => l.account === 'Cost of Goods Sold')!.debit).toBe(600_000);
    expect(posted.find((l) => l.account === 'Product Sales')!.credit).toBe(1_250_000);
    expect(await onHand()).toBe(15);
  });

  it('will not sell one supplier’s stock out of another’s pool', async () => {
    await buy(jinko, { quantity: '2', unitPrice: '100000' });
    await buy(longi, { quantity: '10', unitPrice: '150000' });

    // Ten of Jinko's, when only two of theirs are on hand. Twelve panels are
    // in the warehouse, but ten of them are not Jinko's to sell.
    const invoice = await sell([{ quantity: '10', unitPrice: '250000', supplierId: jinko }]);
    await expect(postSale(invoice.id)).rejects.toThrow();
    expect(await onHand()).toBe(12);
  });

  it('consumes oldest-first across every supplier when the line names none', async () => {
    await buy(jinko, { quantity: '5', unitPrice: '100000' });
    await buy(longi, { quantity: '5', unitPrice: '150000' });

    const { journalEntryId } = await postSale(
      (await sell([{ quantity: '7', unitPrice: '250000', supplierId: null }])).id,
    );
    const posted = await journalOf(journalEntryId);
    // 5 × 100,000 + 2 × 150,000.
    expect(posted.find((l) => l.account === 'Cost of Goods Sold')!.debit).toBe(800_000);
  });

  it('keeps one warehouse’s stock out of another’s', async () => {
    await buy(jinko, { quantity: '10', warehouseCode: WAREHOUSE });
    await buy(jinko, { quantity: '10', warehouseCode: OTHER });

    await postSale((await sell([{ quantity: '4', unitPrice: '250000' }])).id);
    expect(await onHand(WAREHOUSE)).toBe(6);
    expect(await onHand(OTHER)).toBe(10);
  });
});

// ---------------------------------------------------------------------------
describe('ops 11 · negative stock is not allowed', () => {
  it('refuses to sell more than the warehouse holds', async () => {
    await buy(jinko, { quantity: '3', unitPrice: '100000' });
    const invoice = await sell([{ quantity: '5', unitPrice: '250000' }]);

    await expect(postSale(invoice.id)).rejects.toThrow();
    // And nothing moved: the whole posting is one transaction.
    expect(await onHand()).toBe(3);
  });

  it('refuses to sell from a warehouse that holds none of it', async () => {
    await buy(jinko, { quantity: '10', warehouseCode: WAREHOUSE });
    const invoice = await sell([
      { quantity: '1', unitPrice: '250000', warehouseCode: OTHER },
    ]);
    await expect(postSale(invoice.id)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('ops 5 · the line says what it needs to', () => {
  it('brings the item name from the item, rather than taking one on trust', async () => {
    await buy(jinko);
    const invoice = await sell([{ quantity: '1', unitPrice: '250000' }]);
    const { rows } = await ownerPool.query(
      `select description from ar_invoice_line where ar_invoice_id = $1`,
      [invoice.id],
    );
    expect(rows[0].description).toBe('Solar Panel 550W');
  });

  it('refuses a discount larger than the line', async () => {
    await buy(jinko);
    await expect(
      sell([{ quantity: '1', unitPrice: '100000', discount: '150000' }]),
    ).rejects.toThrow(/credit note/);
  });

  it('refuses to post when the item names no COGS account', async () => {
    await buy(jinko);
    await ownerPool.query(`update item set cogs_account_id = null where code = $1`, [PANEL]);
    const invoice = await sell([{ quantity: '1', unitPrice: '250000' }]);
    await expect(postSale(invoice.id)).rejects.toThrow(/no COGS account/);
  });
});

describe('ops 5 · direct invoice accounting dimensions', () => {
  beforeEach(async () => {
    await ownerPool.query(
      `delete from document_type_dimension
        where document_type_code = 'ar_invoice' and dimension = 'business_line'`,
    );
    await withScope(scope(manager), async (tx) => {
      await coa.inheritDimensions(tx, manager, accounts.sales_revenue!);
      await coa.inheritDimensions(tx, manager, accounts.cogs!);
    });
    await ownerPool.query(
      `insert into business_line (code, name, active) values
         ('DIM_SALES','Dimension Sales',true),
         ('DIM_OTHER','Dimension Other',true),
         ('DIM_OFF','Inactive Line',false)
       on conflict (code) do update set active = excluded.active`,
    );
    await ownerPool.query(
      `insert into department (code, name, active) values ('OFF','Inactive Department',false)
       on conflict (code) do update set active = false`,
    );
  });

  const noEffects = async (invoiceId: string) => {
    const { rows: invoices } = await ownerPool.query(
      `select status, journal_entry_id from ar_invoice where id = $1`,
      [invoiceId],
    );
    expect(invoices[0]).toMatchObject({ status: 'approved', journal_entry_id: null });
    const { rows: journals } = await ownerPool.query(
      `select count(*)::int as n from journal_entry where source_doc_id = $1`,
      [invoiceId],
    );
    const { rows: movements } = await ownerPool.query(
      `select count(*)::int as n from inventory_movement
        where source_document_type = 'ar_invoice' and source_document_id = $1`,
      [invoiceId],
    );
    const { rows: subledgerRows } = await ownerPool.query(
      `select count(*)::int as n from subledger_entry where source_doc_id = $1`,
      [invoiceId],
    );
    expect(journals[0].n).toBe(0);
    expect(movements[0].n).toBe(0);
    expect(subledgerRows[0].n).toBe(0);
    expect(await onHand()).toBe(10);
  };

  it('stores direct dimensions and posts every journal line under them', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell(
      [{ quantity: '5', unitPrice: '20', discount: '25' }],
      { businessLineCode: 'DIM_SALES', departmentCode: 'FIN' },
    );

    const { rows: headers } = await ownerPool.query(
      `select business_line_code, department_code from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(headers[0]).toMatchObject({
      business_line_code: 'DIM_SALES',
      department_code: 'FIN',
    });

    const { journalEntryId } = await postSale(invoice.id);
    const { rows: lines } = await ownerPool.query(
      `select l.business_line_code, l.department_code, a.name,
              l.debit_iqd::text as debit, l.credit_iqd::text as credit
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 order by l.line_no`,
      [journalEntryId],
    );
    expect(lines).toEqual([
      { business_line_code: 'DIM_SALES', department_code: 'FIN', name: 'Trade Receivables', debit: '75.0000', credit: '0.0000' },
      { business_line_code: 'DIM_SALES', department_code: 'FIN', name: 'Product Sales', debit: '0.0000', credit: '75.0000' },
      { business_line_code: 'DIM_SALES', department_code: 'FIN', name: 'Cost of Goods Sold', debit: '500.0000', credit: '0.0000' },
      { business_line_code: 'DIM_SALES', department_code: 'FIN', name: 'Inventory', debit: '0.0000', credit: '500.0000' },
    ]);
    expect(await onHand()).toBe(5);
    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'customer', 'CUST-001'),
    );
    expect(statement).toHaveLength(1);
    expect(statement[0]).toMatchObject({ debitIqd: '75.0000', sourceDocId: invoice.id });
  });

  it('approves without dimensions but refuses posting until Business Line is supplied', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '5', unitPrice: '20' }]);
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    await expect(
      withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)),
    ).rejects.toThrow(/Business Line/);
    await noEffects(invoice.id);
  });

  it('requires Department too when Business Line is present', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell(
      [{ quantity: '5', unitPrice: '20' }],
      { businessLineCode: 'DIM_SALES' },
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    await expect(
      withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)),
    ).rejects.toThrow(/Department/);
    await noEffects(invoice.id);
  });

  it.each([
    ['businessLineCode', 'NO_SUCH'],
    ['businessLineCode', 'DIM_OFF'],
    ['departmentCode', 'NO_SUCH'],
    ['departmentCode', 'OFF'],
  ] as const)('rejects %s=%s at create', async (key, value) => {
    await expect(
      sell([{ quantity: '1', unitPrice: '20' }], { [key]: value }),
    ).rejects.toThrow(/not an active/);
  });

  it.each([
    ['businessLineCode', 'NO_SUCH'],
    ['businessLineCode', 'DIM_OFF'],
    ['departmentCode', 'NO_SUCH'],
    ['departmentCode', 'OFF'],
  ] as const)('rejects %s=%s on a draft without discarding saved values', async (key, value) => {
    const invoice = await sell(
      [{ quantity: '1', unitPrice: '20' }],
      { businessLineCode: 'DIM_SALES', departmentCode: 'FIN' },
    );

    await expect(
      withScope(scope(clerk), (tx) =>
        ar.setAccountingDimensions(tx, clerk, invoice.id, {
          businessLineCode: 'DIM_SALES',
          departmentCode: 'FIN',
          [key]: value,
        }),
      ),
    ).rejects.toThrow(/not an active/);

    const { rows } = await ownerPool.query(
      `select business_line_code, department_code from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(rows[0]).toMatchObject({
      business_line_code: 'DIM_SALES',
      department_code: 'FIN',
    });
  });

  it('requires draft-edit authority to set accounting dimensions', async () => {
    const invoice = await sell([{ quantity: '1', unitPrice: '20' }]);
    const denied: ActorContext = {
      ...manager,
      principal: {
        ...manager.principal,
        grants: manager.principal.grants.filter(
          (grant) => !(grant.object === ar.PERMISSION_OBJECT && grant.verb === 'edit_draft'),
        ),
      },
    };

    await expect(
      withScope(scope(denied), (tx) =>
        ar.setAccountingDimensions(tx, denied, invoice.id, {
          businessLineCode: 'DIM_SALES',
          departmentCode: 'FIN',
        }),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it.each(['approve', 'edit_draft'] as const)(
    'return to draft requires %s authority',
    async (verb) => {
      const invoice = await sell(
        [{ quantity: '1', unitPrice: '20' }],
        { businessLineCode: 'DIM_SALES', departmentCode: 'FIN' },
      );
      await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
      const denied: ActorContext = {
        ...manager,
        principal: {
          ...manager.principal,
          grants: manager.principal.grants.filter(
            (grant) => !(grant.object === ar.PERMISSION_OBJECT && grant.verb === verb),
          ),
        },
      };

      await expect(
        withScope(scope(denied), (tx) =>
          ar.returnToDraft(tx, denied, invoice.id, 'Correction required.'),
        ),
      ).rejects.toThrow(PermissionDeniedError);
    },
  );

  it('returns approved work to draft with a reason, then posts the corrected values after fresh approval', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell(
      [{ quantity: '5', unitPrice: '20', discount: '25' }],
      { businessLineCode: 'DIM_SALES', departmentCode: 'FIN' },
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    await expect(
      withScope(scope(manager), (tx) => ar.returnToDraft(tx, manager, invoice.id, ' ')),
    ).rejects.toThrow(/reason/);
    await withScope(scope(manager), (tx) =>
      ar.returnToDraft(tx, manager, invoice.id, 'Correct the accounting dimensions.'),
    );

    const { rows: draft } = await ownerPool.query(
      `select status, approved_by, approved_at, net_iqd::text as net
         from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(draft[0]).toMatchObject({
      status: 'draft',
      approved_by: null,
      approved_at: null,
      net: '75.0000',
    });
    const { rows: events } = await ownerPool.query(
      `select before_value, reason from audit_event
        where object_id = $1 and action = 'ar_invoice.returned_to_draft'
        order by id desc limit 1`,
      [invoice.id],
    );
    expect(events[0].reason).toBe('Correct the accounting dimensions.');
    expect(events[0].before_value.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(
      withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)),
    ).rejects.toThrow(/cannot move from 'draft' to 'posted'/);

    await withScope(scope(clerk), (tx) =>
      ar.setAccountingDimensions(tx, clerk, invoice.id, {
        businessLineCode: 'DIM_OTHER',
        departmentCode: 'FIN',
      }),
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
    const { journalEntryId } = await withScope(scope(manager), (tx) =>
      ar.post(tx, manager, invoice.id),
    );
    const { rows: dimensions } = await ownerPool.query(
      `select business_line_code, department_code from journal_line
        where journal_entry_id = $1`,
      [journalEntryId],
    );
    expect(dimensions).toHaveLength(4);
    expect(new Set(dimensions.map((row) => row.business_line_code))).toEqual(new Set(['DIM_OTHER']));
    expect(new Set(dimensions.map((row) => row.department_code))).toEqual(new Set(['FIN']));
  });

  it('locks approved and posted invoices against service or direct-table dimension changes', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell(
      [{ quantity: '5', unitPrice: '20' }],
      { businessLineCode: 'DIM_SALES', departmentCode: 'FIN' },
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    await expect(
      withScope(scope(manager), (tx) =>
        ar.setAccountingDimensions(tx, manager, invoice.id, {
          businessLineCode: 'DIM_OTHER',
          departmentCode: 'FIN',
        }),
      ),
    ).rejects.toThrow(/approved/);
    await expect(
      ownerPool.query(
        `update ar_invoice set business_line_code = 'DIM_OTHER' where id = $1`,
        [invoice.id],
      ),
    ).rejects.toThrow(/draft invoice/);
    await expect(
      ownerPool.query(
        `update ar_invoice set status = 'draft', department_code = 'OFF' where id = $1`,
        [invoice.id],
      ),
    ).rejects.toThrow(/draft invoice/);

    const { journalEntryId } = await withScope(scope(manager), (tx) =>
      ar.post(tx, manager, invoice.id),
    );
    await expect(
      withScope(scope(manager), (tx) =>
        ar.returnToDraft(tx, manager, invoice.id, 'Try to change posted work.'),
      ),
    ).rejects.toThrow(/posted/);
    await expect(
      withScope(scope(manager), (tx) =>
        ar.setAccountingDimensions(tx, manager, invoice.id, {
          businessLineCode: 'DIM_OTHER',
          departmentCode: 'FIN',
        }),
      ),
    ).rejects.toThrow(/posted/);
    await expect(
      ownerPool.query(
        `update ar_invoice set business_line_code = 'DIM_OTHER' where id = $1`,
        [invoice.id],
      ),
    ).rejects.toThrow(/draft invoice/);

    const { rows: posted } = await ownerPool.query(
      `select i.status, i.business_line_code, i.department_code,
              count(l.*)::int as lines
         from ar_invoice i left join journal_line l on l.journal_entry_id = i.journal_entry_id
        where i.id = $1 group by i.id`,
      [invoice.id],
    );
    expect(posted[0]).toMatchObject({
      status: 'posted',
      business_line_code: 'DIM_SALES',
      department_code: 'FIN',
      lines: 4,
    });
    const { rows: journal } = await ownerPool.query(
      `select status from journal_entry where id = $1`,
      [journalEntryId],
    );
    expect(journal[0].status).toBe('posted');
  });

  it('makes a posting waiting behind return-to-draft see the draft and refuse', async () => {
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell(
      [{ quantity: '5', unitPrice: '20' }],
      { businessLineCode: 'DIM_SALES', departmentCode: 'FIN' },
    );
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));

    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const invoiceLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const reopen = withScope(scope(manager), async (tx) => {
      await ar.returnToDraft(tx, manager, invoice.id, 'Accounting correction.');
      locked();
      await hold;
    });
    await invoiceLocked;

    let postingPid: number | null = null;
    const postingResult = withScope(scope(manager), async (tx) => {
      const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      postingPid = pid.rows[0]!.pid;
      return ar.post(tx, manager, invoice.id);
    }).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    try {
      await vi.waitFor(
        async () => {
          expect(postingPid).not.toBeNull();
          const { rows } = await ownerPool.query(
            `select exists(
               select 1 from pg_stat_activity
                where pid = $1 and wait_event_type = 'Lock'
             ) as blocked`,
            [postingPid],
          );
          expect(rows[0].blocked).toBe(true);
        },
        { timeout: 10_000, interval: 50 },
      );
    } finally {
      release();
    }
    await reopen;
    const result = await postingResult;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toMatch(/cannot move from 'draft' to 'posted'/);
    }

    const { rows } = await ownerPool.query(
      `select status, journal_entry_id from ar_invoice where id = $1`,
      [invoice.id],
    );
    expect(rows[0]).toMatchObject({ status: 'draft', journal_entry_id: null });
    expect(await onHand()).toBe(10);
  });
});

describe('item sales account routing', () => {
  async function revenueAccount(code: string, name: string) {
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code = 'R000001'`,
    );
    const { rows } = await ownerPool.query(
      `insert into chart_of_account
         (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
          currency_restriction, control_account, declares_dimensions)
       values ($1,$2,'revenue',$3,false,true,'approved',1,'IQD',null,true) returning id`,
      [code, name, parents[0].id],
    );
    return rows[0].id as string;
  }

  it('posts revenue to the item sales account before the general mapping', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [
      itemSales,
      PANEL,
    ]);
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    const { journalEntryId } = await postSale(invoice.id);
    const { rows } = await ownerPool.query(
      `select l.credit_iqd::text as credit, a.code, l.posting_rule_id
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.line_role = 'sales_revenue'`,
      [journalEntryId],
    );
    expect(rows).toEqual([{ credit: '300.0000', code: 'R980001', posting_rule_id: null }]);
    const { rows: audits } = await ownerPool.query(
      `select after_value->'revenueAccounts'->0 as selection from audit_event
        where object_type = 'ar_invoice' and object_id = $1 and action = 'ar_invoice.posted'`,
      [invoice.id],
    );
    expect(audits[0].selection).toMatchObject({
      accountCode: 'R980001',
      postingRuleId: null,
      source: 'item',
    });
  });

  it('posts with the item account when no general sales mapping exists', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [itemSales, PANEL]);
    await ownerPool.query(
      `update posting_rule set is_active = false
        where event_type = 'sales.ar_invoice' and line_role = 'sales_revenue'`,
    );
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    const { journalEntryId } = await postSale(invoice.id);
    const { rows } = await ownerPool.query(
      `select a.code, l.posting_rule_id from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = $1 and l.line_role = 'sales_revenue'`,
      [journalEntryId],
    );
    expect(rows).toEqual([{ code: 'R980001', posting_rule_id: null }]);
  });

  it('uses a matching warehouse exception, and an unmatching warehouse keeps the item account', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    const override = await revenueAccount('R980003', 'Override Sales');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [itemSales, PANEL]);
    const { rows: rules } = await ownerPool.query(
      `insert into posting_rule
         (event_type, line_role, account_id, warehouse_code, is_active, created_by)
       values ('sales.ar_invoice','sales_revenue',$1,$2,true,$3) returning id`,
      [override, WAREHOUSE, manager.principal.userId],
    );
    await buy(jinko, { quantity: '20', unitPrice: '100' });
    await buy(jinko, { quantity: '2', unitPrice: '100', warehouseCode: OTHER });
    const first = await sell([{ quantity: '2', unitPrice: '150' }]);
    const second = await sell([{ quantity: '2', unitPrice: '150', warehouseCode: OTHER }]);
    const firstJournal = (await postSale(first.id)).journalEntryId;
    const secondJournal = (await postSale(second.id)).journalEntryId;
    const { rows } = await ownerPool.query(
      `select l.journal_entry_id, a.code, l.posting_rule_id
         from journal_line l join chart_of_account a on a.id = l.account_id
        where l.journal_entry_id = any($1::uuid[]) and l.line_role = 'sales_revenue'
        order by l.journal_entry_id`,
      [[firstJournal, secondJournal]],
    );
    expect(rows.find((row) => row.journal_entry_id === firstJournal)?.code).toBe('R980003');
    expect(rows.find((row) => row.journal_entry_id === secondJournal)?.code).toBe('R980001');
    expect(rows.find((row) => row.journal_entry_id === firstJournal)?.posting_rule_id).toBe(rules[0].id);
    expect(rows.find((row) => row.journal_entry_id === secondJournal)?.posting_rule_id).toBeNull();
  });

  it('refuses equally specific matching exceptions and reports the draft configuration', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    const branchSales = await revenueAccount('R980002', 'Item Sales B');
    const warehouseSales = await revenueAccount('R980003', 'Override Sales');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [itemSales, PANEL]);
    for (const [accountId, criterion] of [
      [branchSales, 'branch_code'],
      [warehouseSales, 'warehouse_code'],
    ] as const) {
      await ownerPool.query(
        `insert into posting_rule (event_type,line_role,account_id,${criterion},is_active,created_by)
         values ('sales.ar_invoice','sales_revenue',$1,$2,true,$3)`,
        [accountId, criterion === 'branch_code' ? BAGHDAD : WAREHOUSE, manager.principal.userId],
      );
    }
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
    await expect(withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)))
      .rejects.toThrow(/More than one accounting mapping/);
    const trace = await withScope(scope(manager), async (tx) =>
      ar.revenueAccountsFor(tx, await ar.view(tx, invoice.id)),
    );
    expect(trace.lines[0]?.error).toMatch(/More than one accounting mapping/);
    expect(await onHand()).toBe(10);
    const { rows: effects } = await ownerPool.query(
      `select
         (select count(*)::int from journal_entry where source_module='sales' and source_doc_id=$1) as journals,
         (select count(*)::int from inventory_movement where source_document_type='ar_invoice' and source_document_id=$1) as movements,
         (select count(*)::int from subledger_entry where source_doc_id=$1) as subledger`,
      [invoice.id],
    );
    expect(effects[0]).toEqual({ journals: 0, movements: 0, subledger: 0 });
  });

  it('shows an inactive item account instead of silently falling back', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [itemSales, PANEL]);
    await ownerPool.query(`update chart_of_account set is_active = false where id = $1`, [itemSales]);
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    const trace = await withScope(scope(manager), async (tx) =>
      ar.revenueAccountsFor(tx, await ar.view(tx, invoice.id)),
    );
    expect(trace.lines[0]).toMatchObject({ accountCode: 'R980001', source: 'item' });
    expect(trace.lines[0]?.error).toMatch(/not active|Cannot post/);
    await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
    await expect(withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)))
      .rejects.toThrow(/not active|Cannot post/);
    const { rows: effects } = await ownerPool.query(
      `select
         (select count(*)::int from journal_entry where source_module='sales' and source_doc_id=$1) as journals,
         (select count(*)::int from inventory_movement where source_document_type='ar_invoice' and source_document_id=$1) as movements,
         (select count(*)::int from subledger_entry where source_doc_id=$1) as subledger`,
      [invoice.id],
    );
    expect(effects[0]).toEqual({ journals: 0, movements: 0, subledger: 0 });
    expect(await onHand()).toBe(10);
  });

  it('keeps the recorded account after setup changes and lists a draft adjustment separately', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    const laterSales = await revenueAccount('R980002', 'Item Sales B');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [itemSales, PANEL]);
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    const { journalEntryId } = await postSale(invoice.id);
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [laterSales, PANEL]);
    const correction = await withScope(scope(manager), async (tx) => {
      const draft = await journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: SELL_ON,
        postingDate: SELL_ON,
        description: 'Revenue correction.',
      });
      await journal.addLine(tx, manager, draft.id, {
        accountId: accounts.sales_revenue!,
        debit: '300.0000',
        currency: 'IQD',
        dimensions: { branch: BAGHDAD, department: 'FIN' },
      });
      await journal.addLine(tx, manager, draft.id, {
        accountId: itemSales,
        credit: '300.0000',
        currency: 'IQD',
        dimensions: { branch: BAGHDAD, department: 'FIN' },
      });
      await audit.record(tx, {
        actorUserId: manager.principal.userId,
        action: 'ar_invoice.reclassification_draft_linked',
        objectType: 'ar_invoice',
        objectId: invoice.id,
        branchCode: BAGHDAD,
        after: { journalEntryId: draft.id },
        outcome: 'success',
      });
      return draft;
    });
    const trace = await withScope(scope(manager), async (tx) =>
      ar.revenueAccountsFor(tx, await ar.view(tx, invoice.id)),
    );
    expect(trace.posted).toBe(true);
    expect(trace.lines[0]).toMatchObject({ accountCode: 'R980001', source: 'item' });
    expect(trace.adjustments).toContainEqual(expect.objectContaining({
      id: correction.id,
      entryNo: correction.entryNo,
      status: 'draft',
    }));
    const { rows } = await ownerPool.query(
      `select a.code from journal_line l join chart_of_account a on a.id=l.account_id
        where l.journal_entry_id=$1 and l.line_role='sales_revenue'`,
      [journalEntryId],
    );
    expect(rows[0].code).toBe('R980001');
  });

  it('routes mixed invoice lines to their own item sales accounts', async () => {
    const salesA = await revenueAccount('R980001', 'Item Sales A');
    const salesB = await revenueAccount('R980002', 'Item Sales B');
    await ownerPool.query(`update item set sales_account_id = $1 where code = $2`, [salesA, PANEL]);
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code,name,is_stock,base_uom_code,tracking,
                          inventory_account_id,cogs_account_id,sales_account_id)
         values ('ITM-BATT','Battery Bank',true,'EA','batch',$1,$2,$3) returning id`,
        [accounts.inventory, accounts.cogs, salesB],
      );
      await client.query(
        `insert into item_uom (item_id,uom_code,conversion_numerator,conversion_denominator)
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

    await buy(jinko, { quantity: '10', unitPrice: '100' });
    await buy(jinko, {
      quantity: '10',
      unitPrice: '50',
      itemCode: 'ITM-BATT',
      description: 'Battery Bank',
    });
    const invoice = await sell([
      { quantity: '2', unitPrice: '150' },
      { quantity: '3', unitPrice: '200', itemCode: 'ITM-BATT' },
    ]);
    const preview = await withScope(scope(manager), async (tx) =>
      ar.revenueAccountsFor(tx, await ar.view(tx, invoice.id)),
    );
    expect(preview.lines).toEqual([
      expect.objectContaining({ accountId: salesA, accountCode: 'R980001', source: 'item' }),
      expect.objectContaining({ accountId: salesB, accountCode: 'R980002', source: 'item' }),
    ]);
    const { journalEntryId } = await postSale(invoice.id);
    const { rows } = await ownerPool.query(
      `select l.line_role, a.code, sum(l.debit_iqd)::text as debit, sum(l.credit_iqd)::text as credit
         from journal_line l join chart_of_account a on a.id=l.account_id
        where l.journal_entry_id=$1 group by l.line_role,a.code order by l.line_role,a.code`,
      [journalEntryId],
    );
    expect(rows).toEqual([
      { line_role: 'cogs', code: expect.any(String), debit: '350.0000', credit: '0.0000' },
      { line_role: 'customer_receivable', code: expect.any(String), debit: '900.0000', credit: '0.0000' },
      { line_role: 'inventory', code: expect.any(String), debit: '0.0000', credit: '350.0000' },
      { line_role: 'sales_revenue', code: 'R980001', debit: '0.0000', credit: '300.0000' },
      { line_role: 'sales_revenue', code: 'R980002', debit: '0.0000', credit: '600.0000' },
    ]);
    const { rows: customer } = await ownerPool.query(
      `select count(*)::int as n, sum(debit_iqd)::text as debit from subledger_entry
        where subledger_type='customer' and party_code='CUST-001' and journal_entry_id=$1`,
      [journalEntryId],
    );
    expect(customer[0]).toEqual({ n: 1, debit: '900.0000' });
    expect(await stockOf(PANEL)).toBe(8);
    expect(await stockOf('ITM-BATT')).toBe(7);
  });

  it('writes the warehouse inventory subledger for receipt and sale', async () => {
    await withScope(scope(manager), (tx) =>
      coa.setControlAccount(tx, manager, accounts.inventory!, 'inventory'),
    );
    await buy(jinko, { quantity: '10', unitPrice: '100' });
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    await postSale(invoice.id);
    const { rows } = await ownerPool.query(
      `select sum(debit_iqd)::text as debit, sum(credit_iqd)::text as credit
         from subledger_entry where subledger_type='inventory' and party_code=$1`,
      [WAREHOUSE],
    );
    expect(rows[0]).toEqual({ debit: '1000.0000', credit: '200.0000' });
    const { rows: fifo } = await ownerPool.query(
      `select sum(remaining_quantity * unit_cost_iqd)::numeric(19,4)::text as value
         from cost_layer where item_code=$1 and warehouse_code=$2`,
      [PANEL, WAREHOUSE],
    );
    expect(fifo[0].value).toBe('800.0000');
    const { rows: customer } = await ownerPool.query(
      `select count(*)::int as n, sum(debit_iqd)::text as debit from subledger_entry
        where subledger_type='customer' and party_code='CUST-001'`,
    );
    expect(customer[0]).toEqual({ n: 1, debit: '300.0000' });
  });

  it('rejects non-revenue and control accounts at configuration and posting', async () => {
    const { rows: parents } = await ownerPool.query(
      `select id from chart_of_account where code='A000001'`,
    );
    const { rows: assetRows } = await ownerPool.query(
      `insert into chart_of_account
        (code,name,account_type,parent_id,is_group,is_active,approval_status,level,currency_restriction)
       values ('A980099','Not Revenue','asset',$1,false,true,'approved',1,'IQD') returning id`,
      [parents[0].id],
    );
    const asset = assetRows[0].id as string;
    const controlled = await revenueAccount('R980003', 'Controlled Revenue');
    await withScope(scope(manager), (tx) =>
      coa.setControlAccount(tx, manager, controlled, 'customer'),
    );
    for (const accountId of [asset, controlled]) {
      await expect(
        withScope(scope(manager), (tx) =>
          posting.setMapping(tx, manager, {
            eventType: 'sales.ar_invoice',
            lineRole: 'sales_revenue',
            accountId,
          }),
        ),
      ).rejects.toThrow(/cannot receive sales revenue|control account/);
    }

    await buy(jinko, { quantity: '10', unitPrice: '100' });
    for (const accountId of [asset, controlled]) {
      await ownerPool.query(`update item set sales_account_id=$1 where code=$2`, [accountId, PANEL]);
      const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
      const trace = await withScope(scope(manager), async (tx) =>
        ar.revenueAccountsFor(tx, await ar.view(tx, invoice.id)),
      );
      expect(trace.lines[0]?.error).toMatch(/cannot receive sales revenue|control account/);
      await withScope(scope(manager), (tx) => ar.approve(tx, manager, invoice.id));
      await expect(withScope(scope(manager), (tx) => ar.post(tx, manager, invoice.id)))
        .rejects.toThrow(/cannot receive sales revenue|control account/);
      const { rows: saved } = await ownerPool.query(
        `select status, journal_entry_id from ar_invoice where id=$1`,
        [invoice.id],
      );
      expect(saved[0]).toEqual({ status: 'approved', journal_entry_id: null });
      const { rows: effects } = await ownerPool.query(
        `select
           (select count(*)::int from journal_entry where source_module='sales' and source_doc_id=$1) as journals,
           (select count(*)::int from inventory_movement where source_document_type='ar_invoice' and source_document_id=$1) as movements,
           (select count(*)::int from subledger_entry where source_doc_id=$1) as subledger`,
        [invoice.id],
      );
      expect(effects[0]).toEqual({ journals: 0, movements: 0, subledger: 0 });
    }
    expect(await onHand()).toBe(10);
  });

  it('does not infer historical revenue accounts from current setup', async () => {
    const itemSales = await revenueAccount('R980001', 'Item Sales A');
    await ownerPool.query(`update item set sales_account_id=$1 where code=$2`, [itemSales, PANEL]);
    const invoice = await sell([{ quantity: '2', unitPrice: '150' }]);
    const trace = await withScope(scope(manager), async (tx) => {
      const loaded = await ar.view(tx, invoice.id);
      const missingJournal = await ar.revenueAccountsFor(tx, {
        ...loaded,
        status: 'posted',
        journalEntryId: null,
      });
      const legacyJournal = await journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: SELL_ON,
        postingDate: SELL_ON,
        description: 'Legacy posting without revenue rows.',
      });
      const draftRows = await ar.revenueAccountsFor(tx, {
        ...loaded,
        status: 'posted',
        journalEntryId: legacyJournal.id,
      });
      return { missingJournal, draftRows };
    });
    expect(trace.missingJournal).toEqual({ posted: true, lines: [], adjustments: [] });
    expect(trace.draftRows).toEqual({ posted: true, lines: [], adjustments: [] });
  });
});
