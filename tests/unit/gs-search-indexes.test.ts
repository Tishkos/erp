/**
 * Global search — the declarations and the migration hold together.
 *
 * A table under a row policy cannot use a trigram index (LIKE may not run ahead
 * of the policy), so what a type declares it is looked up by — its number, its
 * `refs`, its `recent` window — must each have a plain btree in 0330, in the
 * order the query asks (`DESC NULLS LAST`). A type added later that forgets one
 * would still answer, by reading every row the person may see; this says so
 * before it reaches a large table. Database-free: the migration is read as text.
 */
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as documents from '@/server/search/entities/documents';
import * as logistics from '@/server/search/entities/logistics';
import * as masters from '@/server/search/entities/masters';
import type { SearchTableType } from '@/server/search/types';

const MIGRATION = readFileSync('src/server/db/migrations/0330_global_search.sql', 'utf8').replace(/\s+/g, ' ');
const dialect = new PgDialect();

/** `t.invoice_date` → `invoice_date`: the plain column an expression names, or null when it is more than that. */
function columnOf(expression: SQL): string | null {
  const { sql: text } = dialect.sqlToQuery(expression);
  const match = /^t\.([a-z_]+)$/.exec(text.trim());
  return match ? match[1]! : null;
}

const types: SearchTableType[] = [documents, logistics, masters]
  .flatMap((module) => Object.values(module))
  .filter((value): value is SearchTableType => typeof value === 'object' && value !== null && (value as SearchTableType).kind === 'table');

/** Tables that have a trigram index in the migration have no row policy: they are matched whole. */
const trigramTables = new Set([...MIGRATION.matchAll(/ON ([a-z_]+) USING gin/g)].map((m) => m[1]!));
const policed = types.filter((type) => !trigramTables.has(type.table));

const hasBtree = (table: string, column: string, order = '') =>
  new RegExp(`CREATE INDEX IF NOT EXISTS [a-z_]+ ON ${table} \\(${column}${order}\\)`).test(MIGRATION) ||
  new RegExp(`CREATE INDEX IF NOT EXISTS [a-z_]+ ON ${table} \\(${column}${order}`).test(MIGRATION);

describe('0330 indexes what the declarations look up', () => {
  it('reads the registered types', () => {
    expect(types.length).toBeGreaterThanOrEqual(20);
    expect(policed.length).toBeGreaterThan(10);
    expect(trigramTables.has('business_partner')).toBe(true);
  });

  it('every type under a row policy has an index on each reference it declares', () => {
    for (const type of policed) {
      for (const ref of type.refs ?? []) {
        const column = columnOf(ref);
        expect(column, `${type.key}: refs must be plain columns of t`).not.toBeNull();
        expect(hasBtree(type.table, column!), `${type.key}: no btree on ${type.table}(${column})`).toBe(true);
      }
    }
  });

  it('every type under a row policy has the newest-first index its window is read in', () => {
    for (const type of policed) {
      if (!type.recent) continue;
      const column = columnOf(type.recent);
      expect(column, `${type.key}: recent must be a plain column of t`).not.toBeNull();
      expect(hasBtree(type.table, column!, ' DESC NULLS LAST'), `${type.key}: no (${column} DESC NULLS LAST) on ${type.table}`).toBe(true);
    }
  });

  it('every number is a plain column, and indexed in full for the shipping tables whose unique index is partial', () => {
    for (const type of types) expect(columnOf(type.number), `${type.key}: number must be a plain column`).not.toBeNull();
    expect(hasBtree('bill_of_lading', 'bl_no')).toBe(true);
    expect(hasBtree('shipment_container', 'container_no')).toBe(true);
  });

  it('a type with names to match but nothing to order a window by is a small table, and says so', () => {
    // The window of a table with no `recent` is arbitrary rows — acceptable only where the table is smaller than the window.
    const unordered = policed.filter((type) => (type.text?.length ?? 0) > 0 && !type.recent).map((type) => type.key);
    expect(unordered).toEqual([]);
  });
});
