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
/**
 * Runs `fn` so that a statement PostgreSQL refuses does not end the question.
 *
 * A question is one read-only transaction, and PostgreSQL aborts a whole
 * transaction on the first error in it: after "column bp.name does not exist"
 * every later statement — the schema look-up that would have corrected the
 * query, any other tool, even the name read before an issue is written down —
 * is refused with "current transaction is aborted". That is how one wrong
 * column name became "I couldn't read the books… my database connection is
 * down" in the group (2026-10-04, the first real question).
 *
 * A savepoint is the boundary: the failure is rolled back to it and the
 * transaction carries on. Allowed in a read-only transaction — it writes
 * nothing.
 */
export async function inSavepoint<T>(tx: Tx, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`savepoint noah_tool`);
  let out: T;
  try {
    out = await fn();
  } catch (error) {
    await tx.execute(sql`rollback to savepoint noah_tool`).catch(() => {});
    await tx.execute(sql`release savepoint noah_tool`).catch(() => {});
    throw error;
  }
  try {
    await tx.execute(sql`release savepoint noah_tool`);
  } catch {
    // `fn` answered, but a statement inside it had failed and been swallowed:
    // the transaction is put back all the same, and the answer stands.
    await tx.execute(sql`rollback to savepoint noah_tool`).catch(() => {});
    await tx.execute(sql`release savepoint noah_tool`).catch(() => {});
  }
  return out;
}

/** What PostgreSQL itself said, when the driver wrapped it in "Failed query: …". */
function databaseSaid(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const inner = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  const outer = error instanceof Error ? error.message : String(error);
  return inner ? inner : outer;
}

export async function runQuery(tx: Tx, raw: string, limit?: number): Promise<QueryResult> {
  const checked = checkQuery(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason };

  const rowCap = Math.min(Math.max(1, Number(limit) || ROW_CAP), ROW_CAP);
  try {
    return await inSavepoint(tx, async () => {
      // Local to this transaction, which is this one question: the next query
      // sets it again. Through `set_config`, not `SET LOCAL … = $1`: SET takes no
      // bound parameter, so the statement was refused and every query with it —
      // "Failed query: set local statement_timeout = $1" (found 2026-10-04 by
      // the first test that ran this against a database).
      await tx.execute(sql`select set_config('statement_timeout', ${String(TIMEOUT_MS)}, true)`);
      const result = (await tx.execute(sql.raw(checked.sql))) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
      const rows = Array.isArray(result) ? result : (result.rows ?? []);
      return { ok: true as const, text: rowsToText(rows, { rowCap }), rows: rows.length, sql: checked.sql };
    });
  } catch (error) {
    const message = databaseSaid(error);
    return {
      ok: false,
      reason: /statement timeout/i.test(message)
        ? `The query ran for more than ${TIMEOUT_MS / 1000} seconds and was stopped. Narrow it — a date range, a party, a limit.`
        : `PostgreSQL refused the query: ${message}. Nothing else was affected.${await correction(tx, checked.sql, message)}`,
    };
  }
}

/**
 * What to write instead, when a query named something that is not there.
 *
 * A wrong column is nearly always a right table: the columns of every table
 * the query named are handed back with the refusal, so the next query is
 * right without a round spent asking for the schema. A wrong table gets the
 * tables whose names are near it.
 */
async function correction(tx: Tx, query: string, message: string): Promise<string> {
  try {
    const missingTable = /relation "([^"]+)" does not exist/i.exec(message)?.[1];
    if (missingTable) {
      const part = missingTable.replace(/[^a-z0-9_]/gi, '').split('_').sort((a, b) => b.length - a.length)[0] ?? '';
      if (part.length < 3) return ' There is no such table: ask the schema tool for the list.';
      const near = await inSavepoint(tx, async () => {
        const result = (await tx.execute(sql`
          select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind in ('r', 'v', 'p') and c.relname ilike ${`%${part}%`} and c.relname <> 'whatsapp_session'
           order by c.relname limit 12`)) as unknown as { rows?: { name: string }[] };
        return (result.rows ?? []).map((row) => row.name);
      });
      return near.length > 0 ? ` There is no table "${missingTable}". Tables with a name like it: ${near.join(', ')}.` : ` There is no table "${missingTable}": ask the schema tool for the list.`;
    }
    if (!/does not exist|missing FROM-clause|ambiguous/i.test(message)) return '';
    const named = [...query.matchAll(/\b(?:from|join)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((match) => (match[1] ?? '').toLowerCase());
    const tables = [...new Set(named)].filter((name) => name && name !== 'whatsapp_session').slice(0, 5);
    if (tables.length === 0) return '';
    const said: string[] = [];
    for (const table of tables) {
      const columns = await inSavepoint(tx, () => columnsOf(tx, table));
      if (columns.length > 0) said.push(`${table}: ${columns.map((column) => column.column_name).join(', ')}`);
    }
    return said.length > 0 ? ` The real columns — write it again with these:${chr10}${said.join(chr10)}` : '';
  } catch {
    return '';
  }
}

const chr10 = String.fromCharCode(10);

async function columnsOf(tx: Tx, table: string): Promise<{ column_name: string; data_type: string; not_null: boolean }[]> {
  const result = (await tx.execute(sql`
    select a.attname as column_name,
           format_type(a.atttypid, a.atttypmod) as data_type,
           a.attnotnull as not_null
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public'
       and c.relname = ${table}
     order by a.attnum
  `)) as unknown as { rows?: { column_name: string; data_type: string; not_null: boolean }[] };
  return result.rows ?? [];
}

/** What a table points at: "supplier_id → business_partner(id)". */
async function referencesOf(tx: Tx, table: string): Promise<string[]> {
  const result = (await tx.execute(sql`
    select pg_get_constraintdef(k.oid) as def
      from pg_constraint k
      join pg_class c on c.oid = k.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = ${table} and k.contype = 'f'
     order by k.conname
  `)) as unknown as { rows?: { def: string }[] };
  return (result.rows ?? [])
    .map((row) => /FOREIGN KEY \(([^)]+)\) REFERENCES ([a-z0-9_."]+)\(([^)]+)\)/i.exec(row.def))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => `${match[1]} → ${match[2]}(${match[3]})`);
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
  // Several at once — "ar_invoice, ar_invoice_line, business_partner" — because
  // a query worth writing joins them, and one round is better than three.
  const several = (table ?? '')
    .split(/[\s,;]+/)
    .map((name) => name.trim().toLowerCase().replace(/[^a-z0-9_]/g, ''))
    .filter(Boolean);
  if (several.length > 1) {
    const parts: string[] = [];
    for (const name of [...new Set(several)].slice(0, 6)) parts.push(await describeSchema(tx, name));
    return parts.join(`${chr10}${chr10}`);
  }
  const asked = several[0] ?? '';

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

  const rows = await columnsOf(tx, asked);
  if (rows.length === 0) return `There is no table called "${asked}". Ask for the list with no table name.`;
  if (asked === 'whatsapp_session') return 'That table is not readable from here.';
  const references = await referencesOf(tx, asked).catch(() => []);

  return [
    `${asked}:`,
    ...rows.map(
      (row) =>
        `${row.column_name} ${row.data_type}${row.not_null ? ' not null' : ''}${isSecretColumn(row.column_name) ? ' — never shown' : ''}`,
    ),
    ...(references.length > 0 ? [`joins: ${references.join('; ')}`] : []),
  ].join('\n');
}
