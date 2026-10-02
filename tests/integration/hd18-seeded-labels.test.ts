/**
 * REQ-HARDEN-001 H2 / HD18 — every code the database seeds for a screen has a
 * label in both locales.
 *
 * The PD statuses, container statuses, landed-cost charge types and bases are
 * rows, not enums: a migration that seeds a new one shows its stored English
 * name to an Arabic reader until somebody adds the key. This reads what the
 * migrations seeded and holds each code to `admin.customs_pd.ps.<code>`,
 * `admin.shipments.cs.<code>`, `admin.landed_cost.type_name.<code>` and
 * `admin.landed_cost.basis_name.<code>` in English and Arabic.
 */
import { describe, expect, it } from 'vitest';
import { ownerPool } from './setup';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';

type Tree = { readonly [key: string]: string | Tree };

function at(tree: Tree, path: string): string | undefined {
  let node: string | Tree | undefined = tree;
  for (const part of path.split('.')) node = typeof node === 'object' ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

const TABLES: ReadonlyArray<{ table: string; prefix: string }> = [
  { table: 'pd_status', prefix: 'admin.customs_pd.ps' },
  { table: 'container_status', prefix: 'admin.shipments.cs' },
  { table: 'landed_cost_type', prefix: 'admin.landed_cost.type_name' },
  { table: 'landed_cost_basis', prefix: 'admin.landed_cost.basis_name' },
];

describe('H2 · the seeded codes have their labels', () => {
  for (const { table, prefix } of TABLES) {
    it(`every ${table} has ${prefix}.<code> in English and Arabic`, async () => {
      const { rows } = await ownerPool.query<{ code: string }>(`select code from ${table} order by code`);
      expect(rows.length).toBeGreaterThan(0);
      const missing: string[] = [];
      for (const { code } of rows) {
        if (!at(en as unknown as Tree, `${prefix}.${code}`)) missing.push(`en ${prefix}.${code}`);
        if (!at(ar as unknown as Tree, `${prefix}.${code}`)) missing.push(`ar ${prefix}.${code}`);
      }
      expect(missing).toEqual([]);
    });
  }
});
