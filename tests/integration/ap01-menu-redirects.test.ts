/**
 * REQ-AP-001 A7 — Purchasing became Payables, and nothing a user had breaks.
 *
 * The menu shows one Payables section (en and ar labelled), the former
 * finance_ap items live inside it, every old /purchasing/* route redirects —
 * the two renamed segments by name before the catch-all — and permissions
 * ride on unchanged object names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import { MENU, allMenuItems } from '@domain/menu';
import { isDelivered } from '@domain/screens';
import config from '../../next.config';

describe('ap01 · one module, one place, nothing bookmarked breaks', () => {
  it('the tree has a Payables section where Purchasing stood, and no finance_ap', () => {
    const keys = MENU.map((section) => section.key);
    expect(keys).toContain('payables');
    expect(keys).not.toContain('purchasing');
    expect(keys).not.toContain('finance_ap');
    expect(MENU.find((section) => section.key === 'payables')?.ordinal).toBe(4);
  });

  it('the former finance_ap items live inside Payables', () => {
    // REQ-FIX-001 FIX-1 — the module is four headings now; the items are in one of them.
    const keys = MENU.filter((section) => ['payables', 'payables_payments', 'payables_suppliers', 'payables_setup'].includes(section.key)).flatMap((section) =>
      section.items.map((item) => item.key),
    );
    for (const moved of [
      'supplier_ledger',
      'ap_advances',
      'ap_payments',
      'ap_allocations',
      'ap_ageing',
      'ap_reconciliation',
    ]) {
      expect(keys, moved).toContain(moved);
    }
    // And Stage 1's own doors.
    expect(keys).toContain('payables_workbench');
    expect(keys).toContain('payables_settings');
  });

  it('both languages name the section and the new screens', () => {
    for (const lang of ['en', 'ar'] as const) {
      const messages = JSON.parse(
        readFileSync(join(process.cwd(), 'messages', `${lang}.json`), 'utf8'),
      ) as Record<string, Record<string, unknown>>;
      expect(messages.nav!.payables, `${lang} nav`).toBeTypeOf('string');
      for (const key of ['payables_workbench', 'payment_applications', 'payables_settings']) {
        expect(messages.page![key], `${lang} page.${key}`).toBeTypeOf('string');
      }
    }
  });

  it('every /purchasing/* address redirects, the renamed segments by name', async () => {
    const redirects = await config.redirects!();
    const bySource = new Map(redirects.map((rule) => [rule.source, rule]));

    const renamedInvoices = bySource.get('/purchasing/ap-invoices/:path*');
    expect(renamedInvoices?.destination).toBe('/payables/invoices/:path*');
    expect(renamedInvoices?.permanent).toBe(true);

    const renamedOpenItems = bySource.get('/purchasing/payables');
    expect(renamedOpenItems?.destination).toBe('/payables/open-items');

    const catchAll = bySource.get('/purchasing/:path*');
    expect(catchAll?.destination).toBe('/payables/:path*');

    // Order matters: the named renames must outrank the catch-all, or
    // /purchasing/ap-invoices would land on a /payables/ap-invoices 404.
    const sources = redirects.map((rule) => rule.source);
    expect(sources.indexOf('/purchasing/ap-invoices/:path*')).toBeLessThan(
      sources.indexOf('/purchasing/:path*'),
    );
    expect(sources.indexOf('/purchasing/payables')).toBeLessThan(
      sources.indexOf('/purchasing/:path*'),
    );
  });

  it('the moved screens are delivered at their new addresses, and only there', () => {
    for (const route of [
      '/payables',
      '/payables/invoices',
      '/payables/open-items',
      '/payables/supplier-payments',
      '/payables/supplier-statements',
      '/payables/suppliers',
      '/payables/goods-returns',
      '/administration/payables-settings',
    ]) {
      expect(isDelivered(route), route).toBe(true);
    }
    expect(isDelivered('/purchasing/ap-invoices')).toBe(false);
  });

  it('permissions ride on unchanged object names (A7)', async () => {
    // The rename moved screens, not objects: yesterday's grants still answer.
    const { rows } = await ownerPool.query(`
      select object, count(*)::int as n from role_grant
       where object in ('ap_invoice', 'supplier_payment', 'goods_return', 'business_partner')
       group by object order by object
    `);
    expect(rows.length).toBe(4);
    for (const row of rows) expect(Number(row.n)).toBeGreaterThan(0);

    // And the new object is granted to the roles D1 names.
    const { rows: payable } = await ownerPool.query(`
      select role_code from role_grant where object = 'payable' and verb = 'view'
       order by role_code
    `);
    expect(payable.map((row) => row.role_code)).toEqual([
      'accounting_manager',
      'accounting_officer',
      'ceo',
      'customs_officer',
      'logistics_officer',
    ]);
  });

  it('no menu item names a dead /purchasing address', () => {
    for (const item of allMenuItems()) {
      if (item.href) expect(item.href).not.toMatch(/^\/purchasing\//);
    }
  });
});
