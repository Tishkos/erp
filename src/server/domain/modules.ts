/**
 * The modules of the top bar, and the menu headings each one opens.
 *
 * Kept here, beside the menu itself, because two things draw it and must draw
 * the same thing: the shell (`components/erp-shell.tsx`, which adds the icons)
 * and Noah's `screens` tool (`services/system-guide.ts`), which tells a person
 * where to click — "Accounting → Master Data — Financial → Suppliers" — and is wrong
 * the day the two lists differ.
 *
 * A module's dropdown is its sections, one heading each (REQ-FIX-001 FIX-1);
 * a section with no served screen draws nothing.
 *
 * Each module belongs to one group (2026-10-07, by direction: "for payable and
 * receivable there should be 'Invoicing', a text on top of them; for each of
 * them, if they are related to each other, combine them with a text"): the
 * side panel lists the modules under these headings, in this order, when the
 * person keeps "Grouped" in Appearance. The top bar and the bottom bar do not
 * show them. A group none of whose modules the person sees draws nothing. Its
 * label is `shell.module_group.<key>` in both catalogues. The Dashboard stands
 * alone at the top, under no heading (by direction, 2026-10-07: "dashboard
 * shouldn't have that text header overview") — `group: null`.
 */
export const MODULE_GROUPS = ['finance', 'invoicing', 'operations', 'people', 'workspace', 'system'] as const;
export type ModuleGroupKey = (typeof MODULE_GROUPS)[number];

export const MODULES = [
  { key: 'dashboard', group: null, sectionKeys: ['home'] },
  {
    key: 'accounting',
    group: 'finance',
    // The Accounting navbar (by direction, 2026-10-04): General Ledger, then
    // Treasury & Banking, then Master Data & Configuration in its four
    // headings. The sections after them have no built screen yet, so they
    // draw nothing until one is delivered.
    sectionKeys: [
      'finance_gl',
      // finance_ap merged into the Payables module (REQ-AP-001 §21.1).
      'treasury',
      // Master Data — Financial heads with Customers and Suppliers (2026-10-06).
      'master_data',
      'master_banking',
      'master_organization',
      'master_inventory',
      'finance_ar',
      'fixed_assets',
      'budgeting',
      'investments',
    ],
  },
  // Selling and buying are their own work, with their own screens and their
  // own people. They used to sit inside Accounting because they end in a
  // receivable and a payable — but that is where their *postings* go, not
  // where the work happens, and a salesperson opening Accounting to reach
  // Customers had to read past the general ledger to find them.
  { key: 'sales', group: 'invoicing', sectionKeys: ['sales', 'sales_receipts', 'sales_balances'] },
  // Purchasing became Payables — one module for everything owed (REQ-AP-001 D7).
  // Three headings (2026-10-04): purchasing & invoices, supplier payments &
  // credits, supplier balances. Its settings and sheet migration are
  // Administration's; the supplier master, like the customer master, is
  // Master Data — Financial's (by direction, 2026-10-06).
  { key: 'payables', group: 'invoicing', sectionKeys: ['payables', 'payables_payments', 'payables_suppliers'] },
  // Transfers & Applications (by direction, 2026-10-06): the import
  // application and the payment application, beside Payables in the top bar
  // — "these two for now".
  { key: 'transfers', group: 'invoicing', sectionKeys: ['payables_transfers'] },
  // Everything logistics in the system (by direction, 2026-10-02) — the
  // owner's four headings (REQ-LOG-001). The client jobs (`logistics`) are
  // out of the dropdown until they have a screen (Q3).
  { key: 'logistics', group: 'operations', sectionKeys: ['logistics_customs', 'logistics_shipping', 'logistics_in_transit', 'logistics_landed_costs'] },
  { key: 'money_transfer', group: 'operations', sectionKeys: ['money_transfer'] },
  { key: 'crm', group: 'operations', sectionKeys: ['crm'] },
  { key: 'projects', group: 'operations', sectionKeys: ['projects', 'projects_execution', 'projects_billing'] },
  { key: 'inventory', group: 'operations', sectionKeys: ['inventory', 'inventory_in_out', 'inventory_control'] },
  { key: 'hr', group: 'people', sectionKeys: ['hr_payroll', 'hr_time_pay', 'hr_talent'] },
  { key: 'documents', group: 'workspace', sectionKeys: ['documents'] },
  { key: 'monitoring', group: 'workspace', sectionKeys: ['monitoring'] },
  { key: 'reports', group: 'workspace', sectionKeys: ['reports'] },
  { key: 'settings', group: 'system', sectionKeys: ['administration', 'integrations'] },
] as const satisfies readonly { readonly key: string; readonly group: ModuleGroupKey | null; readonly sectionKeys: readonly string[] }[];

export type ModuleKey = (typeof MODULES)[number]['key'];
