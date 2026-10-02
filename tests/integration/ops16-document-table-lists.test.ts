/**
 * The two lists of document tables agree with the schema and with each other.
 *
 * `scripts/ops/format-live-database.sh` and `tests/integration/setup.ts` each
 * keep a hand-written list of the tables a document touches. On 2026-09-27 the
 * first was missing two tables the second had (`stock_transfer`,
 * `stock_adjustment`), and a format left three documents standing with no
 * ledger rows behind them. Nothing said so until a person's arithmetic did.
 *
 * So this asks the database. A table is a *document table* if it references
 * the journal or the stock ledger, or is referenced by one of them, or is one
 * the ledger names as a source document type. Every such table must appear in
 * both lists. The lists may name more — tables of unbuilt phases, evidence
 * tables — but never fewer.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ownerPool } from './setup';

/** Tables the ledger and the journal hang off, or that hang off them. */
async function documentTables(): Promise<string[]> {
  const { rows } = await ownerPool.query<{ table_name: string }>(`
    with anchors as (
      select unnest(array['journal_entry', 'inventory_movement', 'cost_layer']) as table_name
    ),
    -- Foreign keys from pg_catalog rather than information_schema: the latter
    -- joins on constraint *name*, which is unique per table, not per schema,
    -- and a check constraint on one table can share a name with a foreign key
    -- on another.
    fks as (
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
        from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace
       where c.contype = 'f' and n.nspname = 'public'
    ),
    referencing as (
      -- Tables with a foreign key to an anchor: a document that names its
      -- journal, a line that names its movement.
      select distinct child as table_name from fks
       where parent in (select table_name from anchors)
    ),
    sources as (
      -- The document types the ledger writes as source_document_type, which
      -- are table names by convention (stock-operations, ap-invoice, ...).
      select unnest(array['ap_invoice', 'ar_invoice', 'sales_return', 'goods_return',
                          'stock_transfer', 'stock_adjustment', 'opening_stock',
                          'supplier_shipment', 'container_receipt']) as table_name
    ),
    headers as (
      -- The header of every line table found above: the line hangs off it.
      -- A header is recognised by name — ap_invoice_line hangs off
      -- ap_invoice — which keeps the lookups a line also points at (an item,
      -- a reason code, a category) out of the answer. And a header is a
      -- document, with an id: \`bank_loan\` names its lender in \`bank\`, a
      -- master keyed by its code, not a header it hangs off (REQ-AP-001 §15.7).
      select distinct parent as table_name from fks
       where child in (select table_name from referencing)
         and child like parent || '\\_%'
         and exists (select 1 from information_schema.columns c
                      where c.table_schema = 'public' and c.table_name = parent and c.column_name = 'id')
    )
    select table_name from anchors
    union select table_name from referencing
    union select table_name from sources
    union select table_name from headers
    order by 1
  `);
  return rows.map((row) => row.table_name);
}

/** The DOCUMENT_TABLES block of the format script, one name per line. */
function formatScriptTables(): Set<string> {
  const script = readFileSync('scripts/ops/format-live-database.sh', 'utf8');
  const block = /read -r -d '' DOCUMENT_TABLES <<'TABLES' \|\| true\n([\s\S]*?)\nTABLES\n/.exec(script);
  if (!block) throw new Error('format-live-database.sh has no DOCUMENT_TABLES block.');
  return new Set(block[1]!.split('\n').map((line) => line.trim()).filter(Boolean));
}

/** Every table `resetTestData` deletes from or truncates. */
function resetTables(): Set<string> {
  const source = readFileSync('tests/integration/setup.ts', 'utf8');
  const start = source.indexOf('export async function resetTestData');
  const body = source.slice(start);
  const names = new Set<string>();
  for (const match of body.matchAll(
    /\b(?:delete from|truncate)\s+([a-z_,\s]+?)(?:\s+where|\s+restart|\s+cascade|;|\n|`|'|\))/g,
  )) {
    for (const name of match[1]!.split(',')) {
      const trimmed = name.trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return names;
}

// Tables that hold configuration or master data rather than documents, even
// though they touch the anchors: a format keeps them, and so does a reset.
const NOT_DOCUMENTS = new Set([
  'chart_of_account', // journal lines point at accounts
  'fiscal_period',
  'exchange_rate',
  'branch',
  'warehouse',
  'item',
  'business_partner',
  'app_user',
  'posting_rule',
  'purchase_order_line',
  'sales_order_line',
  // A project is a master record and a dimension; its costs are the documents.
  'project',
  // REQ-HR-001 HR-4 — a person is a master record: `employee_advance` names
  // its journal and starts with the person's table name, so the header rule
  // reads `employee` as its header. The advances are the documents.
  'employee',
]);

describe('ops 16 · the document-table lists are complete', () => {
  it('names every document table in the format script', async () => {
    const tables = (await documentTables()).filter((name) => !NOT_DOCUMENTS.has(name));
    const listed = formatScriptTables();
    const missing = tables.filter((name) => !listed.has(name));
    expect(missing, 'add these to DOCUMENT_TABLES in scripts/ops/format-live-database.sh').toEqual([]);
  });

  it('names every document table in resetTestData', async () => {
    const tables = (await documentTables()).filter((name) => !NOT_DOCUMENTS.has(name));
    const listed = resetTables();
    const missing = tables.filter((name) => !listed.has(name));
    expect(missing, 'add these to resetTestData in tests/integration/setup.ts').toEqual([]);
  });

  // The order of the format script's list is not asserted: it lifts the
  // foreign keys for the length of its transaction, so children-before-parents
  // there is how the list reads, not what makes it work. Completeness is what
  // makes it work, and that is what the two tests above hold it to.
});
