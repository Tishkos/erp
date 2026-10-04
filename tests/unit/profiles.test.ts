/**
 * Profiles (2026-10-04) — "like Bank Loans: we can click the bank or the
 * customer". `profileHref` is the one place a record learns where a party,
 * account or document lives; every route it answers must be a page that
 * exists, and every kind without a page must answer null.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROFILE_KINDS, isProfileKind, profileBase, profileHref, type ProfileKind } from '@domain/profiles';
import { isDelivered } from '@domain/screens';

/** Where the App Router serves each base from, after next.config's rewrites. */
const SERVED_FROM: Readonly<Record<string, string>> = {
  '/sales/customers': 'master-data/business-partners/[code]',
  '/payables/suppliers': 'master-data/business-partners/[code]',
  '/inventory/items': 'master-data/items/[code]',
  '/inventory/uom': 'master-data/uom/[code]',
};

describe('profileHref', () => {
  it('addresses the parties the bank loan links to, as the existing pages are addressed', () => {
    expect(profileHref('supplier', 'SUP-JINKO')).toBe('/payables/suppliers/SUP-JINKO?role=supplier');
    expect(profileHref('customer', 'CUST-ALNOOR')).toBe('/sales/customers/CUST-ALNOOR?role=customer');
    expect(profileHref('bank', 'BNK-0002')).toBe('/master-data/banks/BNK-0002');
    expect(profileHref('bank_account', 'BANK-0001')).toBe('/master-data/bank-accounts/BANK-0001');
    expect(profileHref('cash_account', 'CASH-0001')).toBe('/master-data/cash-accounts/CASH-0001');
    expect(profileHref('gl_account', 'A100100')).toBe('/master-data/chart-of-accounts/A100100');
    expect(profileHref('journal', 'JE-BGW-2026-000001')).toBe('/finance/journals/JE-BGW-2026-000001');
    expect(profileHref('item', 'ITM-PANEL')).toBe('/inventory/items/ITM-PANEL');
    expect(profileHref('warehouse', 'WH-MAIN')).toBe('/master-data/warehouses/WH-MAIN');
    expect(profileHref('employee', 'EMP-000001')).toBe('/hr/employees/EMP-000001');
    expect(profileHref('project', 'PRJ-001')).toBe('/projects/PRJ-001');
    expect(profileHref('import', 'IMP-2026-0001')).toBe('/payables/IMP-2026-0001');
    expect(profileHref('bl', 'MSKU123')).toBe('/payables/shipments/MSKU123');
    expect(profileHref('loan', 'LN-2026-0001')).toBe('/treasury/loans/LN-2026-0001');
    expect(profileHref('project_certificate', 'PC-2026-0001')).toBe('/projects/billing/PC-2026-0001');
  });

  it('carries the qualifier a repeated number needs, and nothing when there is none', () => {
    expect(profileHref('pd', '9330', { year: 2026 })).toBe('/payables/pd/9330?year=2026');
    expect(profileHref('pd', '9330')).toBe('/payables/pd/9330');
    expect(profileHref('container', 'MSCU1234565', { id: 'a b' })).toBe('/payables/containers/MSCU1234565?id=a%20b');
    expect(profileHref('container', 'MSCU1234565')).toBe('/payables/containers/MSCU1234565');
  });

  it('encodes the key, and answers null when there is nothing to address', () => {
    expect(profileHref('gl_account', 'A/1 2')).toBe('/master-data/chart-of-accounts/A%2F1%202');
    expect(profileHref('supplier', '  SUP-1  ')).toBe('/payables/suppliers/SUP-1?role=supplier');
    expect(profileHref('supplier', '')).toBeNull();
    expect(profileHref('supplier', '   ')).toBeNull();
    expect(profileHref('supplier', null)).toBeNull();
    expect(profileHref('supplier', undefined)).toBeNull();
  });

  it('answers null for a kind with no profile page yet', () => {
    for (const kind of ['port', 'carrier', 'currency', 'fixed_asset', 'investment'] as const) {
      expect(profileBase(kind), kind).toBeNull();
      expect(profileHref(kind, 'X'), kind).toBeNull();
    }
  });

  it('knows its own kinds and nothing else', () => {
    expect(isProfileKind('supplier')).toBe(true);
    expect(isProfileKind('nonsense')).toBe(false);
    expect(isProfileKind('toString')).toBe(false);
  });

  it('sends every kind with a page to a delivered screen whose record page exists', () => {
    const app = join(process.cwd(), 'src', 'app', '(app)');
    for (const kind of PROFILE_KINDS as readonly ProfileKind[]) {
      const base = profileBase(kind);
      if (!base) continue;
      expect(isDelivered(base), `${kind} → ${base} is a delivered screen`).toBe(true);
      const folder = SERVED_FROM[base] ?? null;
      const dir = folder ? join(app, folder) : null;
      const found =
        (dir && existsSync(join(dir, 'page.tsx'))) ||
        // Any one dynamic segment under the base: [code], [no], [entryNo] …
        (() => {
          const parent = join(app, ...base.split('/').filter(Boolean));
          if (!existsSync(parent)) return false;
          return readdirSync(parent).some((entry) => /^\[[^.]+\]$/.test(entry) && existsSync(join(parent, entry, 'page.tsx')));
        })();
      expect(found, `${kind} → ${base}/[…]/page.tsx exists`).toBe(true);
    }
  });
});
