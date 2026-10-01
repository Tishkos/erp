/**
 * A world in which a purchase invoice can be raised, posted and paid end to
 * end — the setup of ops12-trading-cycle, shared. Accounts with posting rules
 * for every purchasing and sales event, an IQD bank account, an item, a
 * warehouse, a supplier and a customer, the open periods of 2026 and a USD
 * rate. `manager` holds accounting_manager + ceo (posts invoices and
 * payments); `clerk` is an accounting_officer.
 */
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as banks from '@/server/services/bank-cash-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';

export const BAGHDAD = 'BGW';
export const PANEL = 'ITM-PANEL';
export const WAREHOUSE = 'WH-MAIN';
const SUPPLIER = 'SUP-JINKO';
const CUSTOMER = 'CUST-ALNOOR';

export interface TradingWorld {
  readonly clerk: ActorContext;
  readonly manager: ActorContext;
  readonly supplierId: string;
  readonly customerId: string;
  readonly bankAccountId: string;
  readonly accounts: Record<string, string>;
}

export const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

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
  // REQ-AP-001 Stage 3 — a deposit confirmed before the invoice posts.
  'purchasing.supplier_advance_payment',
  'purchasing.supplier_advance_settlement',
] as const;

export async function buildTradingWorld(): Promise<TradingWorld> {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)
     on conflict do nothing`,
  );

  const clerk = await createUser('accounting_officer');
  const manager = await createUser('accounting_manager+ceo');

  const accounts: Record<string, string> = {};
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['inventory', 'A000001', 'Inventory', null],
    ['customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['customer_clearing', 'A000001', 'Receipts Not Yet Identified', null],
    ['bank', 'A000001', 'Bank Current Account', null],
    ['supplier_advance', 'A000001', 'Supplier Advances', null],
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
  const supplierId = supplier[0].id as string;

  const { rows: customer } = await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ($1,'Al Noor Trading',true,false,'active',true) returning id`,
    [CUSTOMER],
  );
  const customerId = customer[0].id as string;

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
  const bankAccountId = banked[0].id as string;

  await ownerPool.query(
    `insert into fiscal_year (code, name, starts_on, ends_on, status)
     values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
  );
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code='FY2026'`);
  for (const [no, name, from, to] of [
    [1, 'January 2026', '2026-01-01', '2026-01-31'],
    [2, 'February 2026', '2026-02-01', '2026-02-28'],
    [3, 'March 2026', '2026-03-01', '2026-03-31'],
    [4, 'April 2026', '2026-04-01', '2026-04-30'],
    [5, 'May 2026', '2026-05-01', '2026-05-31'],
    [6, 'June 2026', '2026-06-01', '2026-06-30'],
    [7, 'July 2026', '2026-07-01', '2026-07-31'],
    [8, 'August 2026', '2026-08-01', '2026-08-31'],
    [9, 'September 2026', '2026-09-01', '2026-09-30'],
    [10, 'October 2026', '2026-10-01', '2026-10-31'],
    [11, 'November 2026', '2026-11-01', '2026-11-30'],
    [12, 'December 2026', '2026-12-01', '2026-12-31'],
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
    'supplier_advance',
  ]) {
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ($1,'business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement='optional'`,
      [documentType],
    );
  }
  return { clerk, manager, supplierId, customerId, bankAccountId, accounts };
}
