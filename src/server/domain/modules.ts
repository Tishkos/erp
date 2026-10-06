/**
 * The modules of the top bar, and the menu headings each one opens.
 *
 * Kept here, beside the menu itself, because two things draw it and must draw
 * the same thing: the shell (`components/erp-shell.tsx`, which adds the icons)
 * and Noah's `screens` tool (`services/system-guide.ts`), which tells a person
 * where to click — "Payables → Supplier Balances → Suppliers" — and is wrong
 * the day the two lists differ.
 *
 * A module's dropdown is its sections, one heading each (REQ-FIX-001 FIX-1);
 * a section with no served screen draws nothing.
 */
export const MODULES = [
  { key: 'dashboard', sectionKeys: ['home'] },
  {
    key: 'accounting',
    // The Accounting navbar (by direction, 2026-10-04): General Ledger, then
    // Treasury & Banking, then Master Data & Configuration in its four
    // headings. The sections after them have no built screen yet, so they
    // draw nothing until one is delivered.
    sectionKeys: [
      'finance_gl',
      // finance_ap merged into the Payables module (REQ-AP-001 §21.1).
      'treasury',
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
  { key: 'sales', sectionKeys: ['sales'] },
  // Purchasing became Payables — one module for everything owed (REQ-AP-001 D7).
  // Three headings (2026-10-04): purchasing & invoices, supplier payments &
  // credits, supplier balances. Its settings and sheet migration are
  // Administration's; the supplier master heads Supplier Balances (by
  // direction, 2026-10-04), as Customers heads Sales & Receivables.
  { key: 'payables', sectionKeys: ['payables', 'payables_payments', 'payables_suppliers'] },
  // Transfers & Applications (by direction, 2026-10-06): the import
  // application and the payment application, beside Payables in the top bar
  // — "these two for now".
  { key: 'transfers', sectionKeys: ['payables_transfers'] },
  // Everything logistics in the system (by direction, 2026-10-02) — the
  // owner's four headings (REQ-LOG-001). The client jobs (`logistics`) are
  // out of the dropdown until they have a screen (Q3).
  { key: 'logistics', sectionKeys: ['logistics_customs', 'logistics_shipping', 'logistics_in_transit', 'logistics_landed_costs'] },
  { key: 'money_transfer', sectionKeys: ['money_transfer'] },
  { key: 'crm', sectionKeys: ['crm'] },
  { key: 'projects', sectionKeys: ['projects'] },
  { key: 'inventory', sectionKeys: ['inventory'] },
  { key: 'hr', sectionKeys: ['hr_payroll'] },
  { key: 'documents', sectionKeys: ['documents'] },
  { key: 'monitoring', sectionKeys: ['monitoring'] },
  { key: 'reports', sectionKeys: ['reports'] },
  { key: 'settings', sectionKeys: ['administration', 'integrations'] },
] as const satisfies readonly { readonly key: string; readonly sectionKeys: readonly string[] }[];

export type ModuleKey = (typeof MODULES)[number]['key'];
