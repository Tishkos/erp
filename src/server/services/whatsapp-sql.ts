/**
 * Running his query, and telling him what there is to query — WA-9.
 *
 * Both halves run inside the caller's read-only transaction, under the
 * asker's own user and branch, so row-level security decides what comes back
 * exactly as it does on their screens. The statement timeout is set here
 * rather than trusted to the model: a cartesian join across the ledger would
 * otherwise sit on a connection for the rest of the afternoon.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { checkQuery, isSecretColumn, rowsToText, ROW_CAP } from '../domain/whatsapp-sql';

/** Long enough for a real report, short enough that a mistake is cheap. */
const TIMEOUT_MS = 15_000;

export type QueryResult =
  | { readonly ok: true; readonly text: string; readonly rows: number; readonly sql: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One SELECT, as the asker.
 *
 * A refusal — from the parser or from PostgreSQL — comes back as a value:
 * "that column does not exist" is the most useful thing a query tool ever
 * says, because the next query is right. Throwing it would turn a
 * conversation into an apology.
 */
export async function runQuery(tx: Tx, raw: string, limit?: number): Promise<QueryResult> {
  const checked = checkQuery(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const rowCap = Math.min(Math.max(1, Number(limit) || ROW_CAP), ROW_CAP);
  try {
    // `set local` lasts to the end of this transaction, which is this one
    // question: the next query sets it again.
    await tx.execute(sql`set local statement_timeout = ${String(TIMEOUT_MS)}`);
    const result = (await tx.execute(sql.raw(checked.sql))) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    return { ok: true, text: rowsToText(rows, { rowCap }), rows: rows.length, sql: checked.sql };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: /statement timeout/i.test(message)
        ? `The query ran for more than ${TIMEOUT_MS / 1000} seconds and was stopped. Narrow it — a date range, a party, a limit.`
        : message,
    };
  }
}

/**
 * What there is to query.
 *
 * Without a table: every table with how many columns it has, which is enough
 * for him to find the one he wants by name. With a table: its columns, their
 * types and whether they may be null — the thing he would otherwise guess at
 * and get wrong once before getting it right.
 *
 * Read from the catalogue rather than from a list written by hand, so it
 * cannot drift from the database as migrations land.
 */
export async function describeSchema(tx: Tx, table?: string): Promise<string> {
  const asked = (table ?? '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');

  if (!asked) {
    const result = (await tx.execute(sql`
      select c.relname as table_name,
             count(a.attname)::int as columns
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
       where n.nspname = 'public'
         and c.relkind in ('r', 'v', 'p')
         and c.relname <> 'whatsapp_session'
       group by c.relname
       order by c.relname
    `)) as unknown as { rows?: { table_name: string; columns: number }[] };
    const rows = result.rows ?? [];
    if (rows.length === 0) return 'The database has no tables I can see.';
    return [
      `${rows.length} tables. Ask for one by name to see its columns.`,
      '',
      rows.map((row) => `${row.table_name} (${row.columns})`).join(', '),
    ].join('\n');
  }

  const result = (await tx.execute(sql`
    select a.attname as column_name,
           format_type(a.atttypid, a.atttypmod) as data_type,
           a.attnotnull as not_null
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public'
       and c.relname = ${asked}
     order by a.attnum
  `)) as unknown as { rows?: { column_name: string; data_type: string; not_null: boolean }[] };
  const rows = result.rows ?? [];
  if (rows.length === 0) return `There is no table called "${asked}". Ask for the list with no table name.`;
  if (asked === 'whatsapp_session') return 'That table is not readable from here.';

  return [
    `${asked}:`,
    ...rows.map(
      (row) =>
        `${row.column_name} ${row.data_type}${row.not_null ? ' not null' : ''}${isSecretColumn(row.column_name) ? ' — never shown' : ''}`,
    ),
  ].join('\n');
}
