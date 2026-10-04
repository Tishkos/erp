/**
 * Where each party, account and document has its profile (2026-10-04).
 *
 * By direction: "Like Bank Loans: we can click the bank or the customer; the
 * parts have profiles." Every party or account a record names — the
 * customer, the supplier, the bank, the bank account, the G/L account, the
 * journal, the item, the warehouse, the employee, the project, the import —
 * is a link to its own page. This is the one place that says which page, so
 * every record links to the same door and a moved route is changed once.
 *
 * Pure: a kind and the key a person knows (a code or a number, never an
 * internal id where the page is addressed by number) in, a path out. A kind
 * that has no profile page yet answers null, and the caller shows the text
 * without a link (`ProfileLink` does). When an owner module builds the
 * missing page, its route is filled in here and every record starts linking.
 */

/** The parties, accounts and documents a record can name. */
export const PROFILE_KINDS = [
  // Parties.
  'customer',
  'supplier',
  'partner',
  'bank',
  'employee',
  'user',
  // Accounts.
  'bank_account',
  'cash_account',
  'gl_account',
  'cost_centre',
  // Things.
  'item',
  'warehouse',
  'uom',
  'project',
  'branch',
  'department',
  'position',
  'payment_term',
  'payment_method',
  // Logistics.
  'import',
  'bl',
  'container',
  'pd',
  'asycuda_run',
  'port',
  'carrier',
  // Documents.
  'journal',
  'loan',
  'deposit',
  'purchase_invoice',
  'sales_invoice',
  'supplier_payment',
  'customer_receipt',
  'sales_return',
  'goods_return',
  'purchase_order',
  'goods_receipt',
  'payment_application',
  'supplier_advance',
  'supplier_contract',
  'opening_stock',
  'project_certificate',
  'project_budget',
  'project_variation',
  'project_material_issue',
  // Kinds with no page yet.
  'currency',
  'fixed_asset',
  'investment',
] as const;

export type ProfileKind = (typeof PROFILE_KINDS)[number];

/** What narrows a key that is not unique on its own. */
export interface ProfileQualifier {
  /** A PD number repeats across years; its registration year picks one. */
  readonly year?: number | null;
  /** A container number is reused once the box is received or cancelled; its id picks one. */
  readonly id?: string | null;
}

/**
 * The list each kind's profile sits under — the route the screen catalogue
 * delivers (`domain/screens`), so a caller can ask whether it is served. Null
 * where no profile page exists; the comment names the module that builds it.
 */
const BASES: Readonly<Record<ProfileKind, string | null>> = {
  customer: '/sales/customers',
  supplier: '/payables/suppliers',
  // One partner, read on the side its own role puts it (the page decides).
  partner: '/sales/customers',
  bank: '/master-data/banks',
  employee: '/hr/employees',
  user: '/administration/users',
  bank_account: '/master-data/bank-accounts',
  cash_account: '/master-data/cash-accounts',
  // The account's own page; its ledger (GL inquiry) is one click from there.
  gl_account: '/master-data/chart-of-accounts',
  cost_centre: '/master-data/cost-centres',
  item: '/inventory/items',
  warehouse: '/master-data/warehouses',
  uom: '/inventory/uom',
  project: '/projects',
  branch: '/master-data/branches',
  department: '/master-data/departments',
  position: '/hr/positions',
  payment_term: '/master-data/payment-terms',
  payment_method: '/master-data/payment-methods',
  // The import application — the payable that carries the import.
  import: '/payables',
  bl: '/payables/shipments',
  container: '/payables/containers',
  pd: '/payables/pd',
  asycuda_run: '/payables/pd/asycuda',
  port: null, // missing — logistics builds it
  carrier: null, // missing — logistics builds it
  journal: '/finance/journals',
  loan: '/treasury/loans',
  deposit: '/treasury/deposits',
  purchase_invoice: '/payables/invoices',
  sales_invoice: '/sales/ar-invoices',
  supplier_payment: '/payables/supplier-payments',
  customer_receipt: '/sales/customer-receipts',
  sales_return: '/sales/sales-returns',
  goods_return: '/payables/goods-returns',
  purchase_order: '/payables/purchase-orders',
  goods_receipt: '/payables/goods-receipts',
  payment_application: '/payables/payment-applications',
  supplier_advance: '/payables/advances',
  supplier_contract: '/payables/contracts',
  opening_stock: '/inventory/opening-stock',
  project_certificate: '/projects/billing',
  project_budget: '/projects/budgets',
  project_variation: '/projects/change-orders',
  project_material_issue: '/projects/material-issues',
  currency: null, // missing — accounting builds it
  fixed_asset: null, // missing — shared (no module owns it yet)
  investment: null, // missing — shared (no module owns it yet)
};

/** Is this a kind `profileHref` knows? */
export function isProfileKind(value: string): value is ProfileKind {
  return Object.prototype.hasOwnProperty.call(BASES, value);
}

/** The list a kind's profile sits under, or null when the kind has no profile page. */
export function profileBase(kind: ProfileKind): string | null {
  return BASES[kind] ?? null;
}

/**
 * The profile page of one party, account or document, or null — when the
 * kind has no page yet, or there is no key to address it by.
 *
 * `key` is what the page is addressed by: a code (customer, supplier, bank,
 * bank/cash account, G/L account, item, warehouse, project), a number
 * (employee, journal, loan, B/L, container, PD, every document), the import
 * application's payable number, or a user's id.
 */
export function profileHref(
  kind: ProfileKind,
  key: string | null | undefined,
  qualifier: ProfileQualifier = {},
): string | null {
  const base = BASES[kind];
  const trimmed = key?.trim();
  if (!base || !trimmed) return null;
  const path = `${base}/${encodeURIComponent(trimmed)}`;
  switch (kind) {
    // The partner page reads its side from the query, so a company that is
    // both opens on the side the record means.
    case 'customer':
      return `${path}?role=customer`;
    case 'supplier':
      return `${path}?role=supplier`;
    case 'pd':
      return qualifier.year ? `${path}?year=${qualifier.year}` : path;
    case 'container':
      return qualifier.id ? `${path}?id=${encodeURIComponent(qualifier.id)}` : path;
    default:
      return path;
  }
}
