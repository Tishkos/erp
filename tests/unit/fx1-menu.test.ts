/**
 * REQ-FIX-001 FX1 — the menu the sponsor asked for (2026-10-02).
 *
 * Payables holds payables work only, in four headings in the order a payable
 * lives; Logistics holds everything logistics; Treasury & Banking holds the
 * bank's side — accounts, loans, deposits, reporting. The routes did not
 * move (D-FX-1): only where the screens are found.
 */
import { describe, expect, it } from 'vitest';
import { MENU } from '@domain/menu';
import { MODULES } from '@domain/modules';
import { routeFor } from '@domain/screens';

const section = (key: string) => {
  const found = MENU.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found;
};
const keysOf = (key: string) => section(key).items.map((item) => item.key);

describe('FX1 · Payables, Logistics and Treasury & Banking', () => {
  it('Payables is three headings, in the order a payable lives', () => {
    // FIX-1 made it four; the owner asked for three on 2026-10-03; the
    // Purchasing & Payables finalisation (2026-10-04) settled which three:
    // what is bought and invoiced, how the supplier is paid and what they hold
    // of ours, and the balances. The setup went to Administration; the
    // supplier master heads the balances (by direction, 2026-10-04).
    // Transfers & Applications (by direction, 2026-10-06) took the import
    // application and the payment application into a module of its own.
    expect(keysOf('payables_transfers')).toEqual(['payables_workbench', 'payment_applications']);
    expect(MODULES.find((module) => module.key === 'transfers')?.sectionKeys).toEqual(['payables_transfers']);
    expect(keysOf('payables').slice(0, 6)).toEqual([
      'purchase_orders',
      'goods_receipts',
      'ap_invoices',
      'service_receipts',
      'recurring_contracts',
      'goods_returns',
    ]);
    expect(keysOf('payables_payments')).toEqual([
      'supplier_payments',
      'supplier_advances',
      'supplier_credits',
      'supplier_credit_memos',
    ]);
    expect(keysOf('payables_suppliers').slice(0, 4)).toEqual([
      'suppliers',
      'ap_statements',
      'ap_open_items',
      'ap_reconciliation',
    ]);
    expect(MENU.some((s) => s.key === 'payables_setup')).toBe(false);
  });

  it('the supplier master is Payables’, the settings and the sheet migration Administration’s', () => {
    // By direction, 2026-10-04: "move the suppliers to payable". Once, under
    // Supplier Balances, at the address every supplier link already uses.
    const everywhere = MENU.flatMap((s) => s.items.filter((item) => item.key === 'suppliers').map(() => s.key));
    expect(everywhere).toEqual(['payables_suppliers']);
    expect(keysOf('master_data')).not.toContain('suppliers');
    expect(keysOf('administration')).toEqual(expect.arrayContaining(['payables_settings', 'payables_migration']));
    const payables = ['payables', 'payables_transfers', 'payables_payments', 'payables_suppliers'].flatMap(keysOf);
    for (const gone of ['payables_settings', 'payables_migration']) {
      expect(payables, gone).not.toContain(gone);
    }
  });

  it('the never-built second names of Payables screens are gone', () => {
    const all = MENU.flatMap((s) => s.items.map((item) => item.key));
    for (const gone of ['ap_payments', 'ap_advances', 'ap_allocations', 'ap_ageing', 'supplier_ledger']) {
      expect(all, gone).not.toContain(gone);
    }
  });

  it('nothing logistics or banking is left under Payables', () => {
    const payables = ['payables', 'payables_transfers', 'payables_payments', 'payables_suppliers'].flatMap(keysOf);
    for (const gone of ['pds', 'asycuda_update', 'shipments', 'containers', 'in_transit', 'loans', 'bank_deposits']) {
      expect(payables, gone).not.toContain(gone);
    }
  });

  it('Logistics is the owner’s four headings, fifteen items in his order (REQ-LOG-001)', () => {
    expect(keysOf('logistics_customs')).toEqual([
      'pds',
      'customs_declarations',
      'asycuda_update',
      'customs_duties',
      'customs_documents',
    ]);
    expect(keysOf('logistics_shipping')).toEqual([
      'import_shipments',
      'shipments',
      'containers',
      'ports_routes',
      'freight_costs',
      'shipment_documents',
    ]);
    expect(keysOf('logistics_in_transit')).toEqual(['in_transit', 'shipment_tracking']);
    expect(keysOf('logistics_landed_costs')).toEqual(['landed_costs', 'cost_allocation']);
    // The client jobs stay in the tree (Appendix A) but leave the dropdown (Q3).
    expect(keysOf('logistics')).toContain('logistics_jobs');
  });

  it('Treasury & Banking holds what money moved, in the Accounting navbar’s order (2026-10-04)', () => {
    expect(keysOf('treasury').slice(0, 7)).toEqual([
      'bank_reconciliation',
      'bank_transfers',
      'loans',
      'bank_deposits',
      'payments_receipts',
      'treasury_reports',
      'cash_forecast',
    ]);
    // The accounts are master records: they sit under Master Data › Banking.
    expect(keysOf('treasury')).not.toContain('bank_cash_accounts');
    expect(keysOf('master_banking')).toEqual(['banks', 'bank_cash_accounts', 'cash_accounts']);
  });

  it('Receivables is one heading, Sales & Receivables, in the order a receivable lives (2026-10-04)', () => {
    expect(keysOf('sales').slice(0, 9)).toEqual([
      'customers',
      'ar_invoices',
      'customer_receipts',
      'ar_allocations',
      'ar_statements',
      'ar_open_items',
      'customer_credit_memos',
      'sales_returns',
      'ar_reconciliation',
    ]);
    const route = (itemKey: string) =>
      routeFor(section('sales').items.find((item) => item.key === itemKey)!, 'sales');
    expect(route('ar_allocations')).toBe('/sales/customer-credits');
    expect(route('customer_credit_memos')).toBe('/sales/credit-notes');
    expect(route('ar_reconciliation')).toBe('/sales/customer-reconciliation');
  });

  it('Customers live in Sales & Receivables only, at the route every customer link uses', () => {
    // By direction, 2026-10-04: "customer [to] receivable".
    const everywhere = MENU.flatMap((s) => s.items.filter((item) => item.key === 'customers').map(() => s.key));
    expect(everywhere).toEqual(['sales']);
    expect(routeFor(section('sales').items.find((item) => item.key === 'customers')!, 'sales')).toBe(
      '/sales/customers',
    );
  });

  it('Master Data — Financial holds reference data only, no partners', () => {
    const financial = keysOf('master_data');
    expect(financial).not.toContain('customers');
    expect(financial).not.toContain('suppliers');
    expect(financial.slice(0, 6)).toEqual([
      'chart_of_accounts',
      'statement_mapping',
      'currencies_rates',
      'tax_codes',
      'payment_terms',
      'payment_methods',
    ]);
  });

  it('the moved screens keep their routes (D-FX-1)', () => {
    const route = (sectionKey: string, itemKey: string) =>
      routeFor(
        section(sectionKey).items.find((item) => item.key === itemKey)!,
        sectionKey,
      );
    expect(route('logistics_customs', 'pds')).toBe('/payables/pd');
    expect(route('logistics_shipping', 'shipments')).toBe('/payables/shipments');
    expect(route('logistics_shipping', 'containers')).toBe('/payables/containers');
    // REQ-LOG-001 Q4 — the one route that moved: In-Transit Inventory absorbed
    // Invoice Status Tracking, and the old address redirects to it.
    expect(route('logistics_in_transit', 'in_transit')).toBe('/logistics/in-transit');
    expect(route('logistics_customs', 'customs_declarations')).toBe('/logistics/customs-declarations');
    expect(route('logistics_shipping', 'ports_routes')).toBe('/logistics/ports');
    expect(route('treasury', 'loans')).toBe('/treasury/loans');
    expect(route('master_banking', 'bank_cash_accounts')).toBe('/master-data/bank-accounts');
    expect(route('master_banking', 'cash_accounts')).toBe('/master-data/cash-accounts');
    expect(route('payables_transfers', 'payment_applications')).toBe('/payables/payment-applications');
    expect(route('payables_transfers', 'payables_workbench')).toBe('/payables');
    expect(route('payables', 'purchase_orders')).toBe('/payables/purchase-orders');
    expect(route('payables', 'goods_receipts')).toBe('/payables/goods-receipts');
    expect(route('payables', 'service_receipts')).toBe('/payables/service-receipts');
    expect(route('payables_suppliers', 'suppliers')).toBe('/payables/suppliers');
    expect(route('sales', 'customers')).toBe('/sales/customers');
    expect(route('administration', 'payables_settings')).toBe('/administration/payables-settings');
    expect(route('administration', 'payables_migration')).toBe('/administration/payables-migration');
  });
});
