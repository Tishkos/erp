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
import { routeFor } from '@domain/screens';

const section = (key: string) => {
  const found = MENU.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`no section ${key}`);
  return found;
};
const keysOf = (key: string) => section(key).items.map((item) => item.key);

describe('FX1 · Payables, Logistics and Treasury & Banking', () => {
  it('Payables is three headings, in the order a payable lives', () => {
    // FIX-1 made it four; the owner asked for three on 2026-10-03, with the
    // payment screens beside the invoices they pay — a payment is the end of
    // the same job, not a different kind of work. Who is owed, and the setup,
    // stay apart.
    expect(keysOf('payables').slice(0, 10)).toEqual([
      'payables_workbench',
      'ap_invoices',
      'purchase_orders',
      'goods_receipts',
      'service_receipts',
      'recurring_contracts',
      'payment_applications',
      'supplier_payments',
      'supplier_advances',
      'supplier_credit_memos',
    ]);
    expect(MENU.some((s) => s.key === 'payables_payments')).toBe(false);
    expect(keysOf('payables_suppliers').slice(0, 3)).toEqual(['suppliers', 'ap_statements', 'ap_open_items']);
    expect(keysOf('payables_setup')).toEqual(['payables_settings', 'payables_migration']);
  });

  it('nothing logistics or banking is left under Payables', () => {
    const payables = ['payables', 'payables_suppliers', 'payables_setup'].flatMap(keysOf);
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
    expect(route('payables', 'payment_applications')).toBe('/payables/payment-applications');
    expect(route('payables', 'purchase_orders')).toBe('/payables/purchase-orders');
  });
});
