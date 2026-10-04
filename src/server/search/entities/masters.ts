/**
 * Master records: the people and things documents are written about.
 *
 * Priority 10–29 — a name hit on one of these outranks a name hit on a document,
 * "Al Noor" finding the customer before the invoices that name it. Pay is never
 * here: an employee is a number, a name and a status, nothing else.
 */
import { sql } from 'drizzle-orm';
import { profileHref } from '../../domain/profiles';
import type { SearchTableType } from '../types';

const partner = (role: 'customer' | 'supplier'): SearchTableType => ({
  kind: 'table',
  key: role,
  priority: role === 'customer' ? 10 : 11,
  // The partner's page is read under this grant for both roles (the menu's Customers and Suppliers).
  grant: { object: 'business_partner' },
  route: role === 'customer' ? '/sales/customers' : '/payables/suppliers',
  table: 'business_partner',
  where: role === 'customer' ? sql`t.is_customer` : sql`t.is_supplier`,
  id: sql`t.id`,
  series: [role === 'customer' ? 'CUSTOMER_CODE' : 'SUPPLIER_CODE'],
  number: sql`t.code`,
  text: [sql`t.legal_name`, sql`t.trade_name`],
  title: sql`t.legal_name`,
  status: sql`t.status`,
  party: sql`t.trade_name`,
  href: (row) => profileHref(role, row.number),
});

export const customer = partner('customer');
export const supplier = partner('supplier');

export const employee: SearchTableType = {
  kind: 'table',
  key: 'employee',
  priority: 12,
  grant: { object: 'employee' },
  route: '/hr/employees',
  table: 'employee',
  id: sql`t.id`,
  series: ['EMPLOYEE'],
  number: sql`t.employee_no`,
  text: [sql`t.full_name_en`, sql`t.full_name_ar`],
  title: sql`coalesce(nullif(t.full_name_en, ''), t.full_name_ar)`,
  titleAlt: sql`coalesce(nullif(t.full_name_ar, ''), t.full_name_en)`,
  status: sql`t.status`,
  date: sql`t.hire_date`,
  recent: sql`t.hire_date`,
  // No `amount`, ever: what a person is paid is `employee_compensation`'s, behind its own grant.
  href: (row) => profileHref('employee', row.number),
};

export const item: SearchTableType = {
  kind: 'table',
  key: 'item',
  priority: 13,
  grant: { object: 'item' },
  route: '/inventory/items',
  table: 'item',
  id: sql`t.id`,
  series: ['ITEM_CODE'],
  number: sql`t.code`,
  text: [sql`t.name`, sql`t.supplier_item_code`],
  title: sql`t.name`,
  status: sql`case when t.active then 'active' else 'inactive' end`,
  // A selling price is a price list's matter: shown to whoever may see price lists, not to everyone who may see the item.
  amount: { value: sql`t.selling_price_iqd`, currency: sql`'IQD'`, grant: { object: 'price_list' } },
  href: (row) => profileHref('item', row.number),
};

export const warehouse: SearchTableType = {
  kind: 'table',
  key: 'warehouse',
  priority: 14,
  grant: { object: 'warehouse' },
  route: '/master-data/warehouses',
  table: 'warehouse',
  // The table has no row policy; a warehouse belongs to one branch, and a branch the asker is not in is not theirs to find.
  where: sql`app_branch_allowed(t.branch_code)`,
  id: sql`t.code`,
  textId: true,
  series: ['WAREHOUSE_CODE'],
  number: sql`t.code`,
  text: [sql`t.name`],
  title: sql`t.name`,
  status: sql`case when t.active then 'active' else 'inactive' end`,
  href: (row) => profileHref('warehouse', row.number),
};

export const bankCashAccount: SearchTableType = {
  kind: 'table',
  key: 'bank_cash_account',
  priority: 15,
  // The master Bank / Cash Accounts screens' own object (the treasury registers ask `bank_cash_account`).
  grant: { object: 'bank_account' },
  route: '/master-data/bank-accounts',
  table: 'bank_cash_account',
  id: sql`t.id`,
  series: ['BANK_ACCOUNT_CODE', 'CASH_ACCOUNT_CODE'],
  number: sql`t.code`,
  text: [sql`t.name`, sql`t.account_number`, sql`t.iban`],
  title: sql`t.name`,
  status: sql`case when t.active then 'active' else 'inactive' end`,
  party: sql`t.bank_name`,
  extras: { type: sql`t.account_type` },
  href: (row) => profileHref(row.extras.type === 'cash' ? 'cash_account' : 'bank_account', row.number),
};

export const chartOfAccount: SearchTableType = {
  kind: 'table',
  key: 'chart_of_account',
  priority: 16,
  grant: { object: 'chart_of_account' },
  route: '/master-data/chart-of-accounts',
  table: 'chart_of_account',
  id: sql`t.id`,
  series: [
    'ACCOUNT_CODE_ASSET',
    'ACCOUNT_CODE_LIABILITY',
    'ACCOUNT_CODE_EQUITY',
    'ACCOUNT_CODE_REVENUE',
    'ACCOUNT_CODE_EXPENSE',
  ],
  number: sql`t.code`,
  text: [sql`t.name`],
  title: sql`t.name`,
  status: sql`case when t.is_active then 'active'
                   when t.approval_status = 'approved' then 'inactive'
                   else t.approval_status::text end`,
  href: (row) => profileHref('gl_account', row.number),
};

export const project: SearchTableType = {
  kind: 'table',
  key: 'project',
  priority: 17,
  grant: { object: 'project' },
  route: '/projects',
  table: 'project',
  id: sql`t.code`,
  textId: true,
  attachmentType: 'project',
  series: ['PROJECT'],
  number: sql`t.code`,
  text: [sql`t.name`],
  partyKey: sql`t.partner_id`,
  joins: sql`left join business_partner p on p.id = t.partner_id`,
  title: sql`t.name`,
  status: sql`t.status`,
  date: sql`t.created_at::date`,
  recent: sql`t.created_at`,
  party: sql`p.legal_name`,
  amount: { value: sql`t.contract_value_iqd`, currency: sql`'IQD'` },
  href: (row) => profileHref('project', row.number),
};
