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
  it('Payables is four headings, in the order a payable lives', () => {
    expect(keysOf('payables').slice(0, 7)).toEqual(['payables_workbench', 'purchase_orders', 'goods_receipts', 'service_receipts', 'recurring_contracts', 'ap_invoices', 'goods_returns']);
    expect(keysOf('payables_payments').slice(0, 4)).toEqual(['payment_applications', 'supplier_payments', 'supplier_advances', 'supplier_credit_memos']);
    expect(keysOf('payables_suppliers').slice(0, 3)).toEqual(['suppliers', 'ap_statements', 'ap_open_items']);
    expect(keysOf('payables_setup')).toEqual(['payables_settings', 'payables_migration']);
  });

  it('nothing logistics or banking is left under Payables', () => {
    const payables = ['payables', 'payables_payments', 'payables_suppliers', 'payables_setup'].flatMap(keysOf);
    for (const gone of ['pds', 'asycuda_update', 'shipments', 'containers', 'in_transit', 'loans', 'bank_deposits']) {
      expect(payables, gone).not.toContain(gone);
    }
  });

  it('Logistics holds the customs declarations, the ASYCUDA list, the shipping and the jobs', () => {
    expect(keysOf('logistics_customs')).toEqual(['pds', 'asycuda_update']);
    expect(keysOf('logistics_shipping')).toEqual(['shipments', 'containers', 'in_transit']);
    expect(keysOf('logistics')).toContain('logistics_jobs');
  });

  it('Treasury & Banking holds the accounts, the loans, the deposits and the reporting, first', () => {
    expect(keysOf('treasury').slice(0, 5)).toEqual(['bank_cash_accounts', 'cash_accounts', 'loans', 'bank_deposits', 'treasury_reports']);
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
    expect(route('logistics_shipping', 'in_transit')).toBe('/inventory/in-transit');
    expect(route('treasury', 'loans')).toBe('/payables/loans');
    expect(route('payables_payments', 'payment_applications')).toBe('/payables/payment-applications');
    expect(route('payables', 'purchase_orders')).toBe('/payables/purchase-orders');
  });
});
