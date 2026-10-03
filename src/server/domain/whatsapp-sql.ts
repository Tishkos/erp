/**
 * Letting him write his own query — REQ-WA-001 WA-9.
 *
 * By direction (2026-10-02), after he could not produce a customer's phone
 * number: "it should use the query and give to opius please not only reialble
 * on the tools he has its stupid and not useful", and "be capable of
 * eveyrthing". The twenty-odd hand-written tools are a menu, and a menu is
 * always missing the column somebody actually wants.
 *
 * So he gets SQL. What makes that safe is not this file's cleverness — it is
 * four things, of which only the first two are here:
 *
 *   1. **One SELECT.** A single statement, beginning with SELECT or WITH, no
 *      semicolons inside it, no comments to hide anything in. Anything else
 *      is refused before it reaches the database.
 *   2. **Nothing that reaches outside the data.** No `set_config` (it could
 *      rewrite the row-level-security variables mid-transaction and so change
 *      whose data is being read), no `pg_*` catalogue or file function, no
 *      `dblink`, no large-object import, and not the bot's own pairing
 *      credentials. Columns that look like a secret are blanked out of the
 *      result, so `select *` on a table of users cannot spill a password hash
 *      by accident.
 *   3. **A read-only transaction.** The caller runs it inside
 *      `withReadOnlyScope`, where PostgreSQL itself refuses a write before any
 *      policy is consulted. This is the real guarantee: the parser above is a
 *      courtesy that gives a better error, not the lock.
 *   4. **The asker's own scope.** Row-level security is already applied under
 *      their user and branch, so a query sees exactly the rows their screens
 *      would. Nothing here grants anything.
 *
 * Every query is in the message log and the audit trail with its text (W-R4),
 * so what was read is answerable afterwards.
 */

/** As many rows as are useful in a chat answer, and no more. */
export const ROW_CAP = 200;
/** The whole result as text, so a wide table cannot flood the prompt. */
export const TEXT_CAP = 20_000;
/** One cell, so a JSON blob in a column does not take the whole answer. */
export const CELL_CAP = 300;
/** Longer than this and it is not a question, it is a program. */
export const SQL_CAP = 4_000;

/**
 * Identifiers and functions that are refused outright.
 *
 * A table name in SQL cannot be computed — it is a literal identifier — so
 * matching the word is a sound check rather than a hopeful one.
 */
const FORBIDDEN = [
  // The bot's own WhatsApp pairing: these rows are the keys to the company's
  // number, and nobody needs to read them to answer a question.
  'whatsapp_session',
  // Would let a query rewrite app.user_id / app.branch_code inside the
  // transaction and so read as somebody else.
  'set_config',
  // The server's files and the catalogue, including the roles table that
  // holds password hashes.
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_dir',
  'pg_stat_file',
  'pg_authid',
  'pg_shadow',
  'pg_user_mapping',
  'pg_sleep',
  'pg_terminate_backend',
  'pg_cancel_backend',
  // Reaching another database, or the filesystem through large objects.
  'dblink',
  'lo_import',
  'lo_export',
  'lo_get',
  'postgres_fdw',
  'copy',
];

/** Column names whose values are never shown, whatever the query asked for. */
const SECRET_COLUMN = /password|secret|credential|private_key|api_key|access_token|refresh_token/i;

export type Checked = { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string };

/**
 * Is this one harmless SELECT?
 *
 * Strict on purpose, and the refusals say what to do instead: a model that is
 * told "one statement only" writes one statement, where a vague refusal makes
 * it guess.
 */
export function checkQuery(raw: string): Checked {
  const sql = raw.trim().replace(/;\s*$/, '').trim();
  if (!sql) return { ok: false, reason: 'There is no query there.' };
  if (sql.length > SQL_CAP) return { ok: false, reason: `That query is ${sql.length} characters; keep it under ${SQL_CAP}.` };

  // Comments can hide a second statement from a reader, and nothing in a
  // one-line query needs them.
  if (sql.includes('--') || sql.includes('/*')) {
    return { ok: false, reason: 'No SQL comments — send the query on its own.' };
  }

  // A semicolon anywhere but the end means more than one statement. Inside a
  // string literal it is harmless, but a query that needs one is rare enough
  // that refusing is the better trade.
  if (sql.includes(';')) return { ok: false, reason: 'One statement only, and no semicolons inside it.' };

  if (!/^(select|with)\b/i.test(sql)) {
    return { ok: false, reason: 'Only SELECT (or WITH … SELECT). Nothing can be written from here — use propose_action to change anything.' };
  }

  // `WITH … ( INSERT … )` is a write wearing a SELECT's hat.
  if (/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|vacuum|reindex|call|do|merge)\b/i.test(sql)) {
    return {
      ok: false,
      reason: 'That query contains a writing word, so it is refused whatever it would have done. Reading only — use propose_action to change anything.',
    };
  }

  const lower = sql.toLowerCase();
  for (const word of FORBIDDEN) {
    // Word-boundary match, with the surrounding quotes a query might use.
    if (new RegExp(`(^|[^a-z0-9_"])"?${word}"?($|[^a-z0-9_"])`, 'i').test(lower)) {
      return { ok: false, reason: `\`${word}\` is not readable from here. Everything the company's own tables hold is.` };
    }
  }

  return { ok: true, sql };
}

/** Is this column's value one that is never shown? */
export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMN.test(name);
}

/** One cell as text: null named, long values cut, newlines flattened. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (value instanceof Date) return value.toISOString().slice(0, 19).replace('T', ' ');
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  const flat = text.replace(/\s*\n\s*/g, ' ⏎ ');
  return flat.length > CELL_CAP ? `${flat.slice(0, CELL_CAP)}…` : flat;
}

/**
 * The result as text he can read and quote from.
 *
 * Tab-separated with a header, because the reader is a model: the columns
 * line up for it without spending the cap on drawing a table. Where the cap
 * bites it says so — an answer must never look complete when it was cut.
 */
export function rowsToText(rows: readonly Record<string, unknown>[], limits: { readonly rowCap?: number; readonly textCap?: number } = {}): string {
  const rowCap = limits.rowCap ?? ROW_CAP;
  const textCap = limits.textCap ?? TEXT_CAP;
  if (rows.length === 0) return 'No rows.';

  const columns = Object.keys(rows[0]!);
  const header = columns.join('\t');
  const lines: string[] = [header];
  let spent = header.length;
  let shown = 0;

  for (const row of rows.slice(0, rowCap)) {
    const line = columns.map((column) => (isSecretColumn(column) ? '«not shown»' : cellText(row[column]))).join('\t');
    if (spent + line.length > textCap) break;
    lines.push(line);
    spent += line.length;
    shown += 1;
  }

  const notes: string[] = [];
  if (shown < rows.length) notes.push(`showing ${shown} of ${rows.length} row(s)`);
  if (columns.some((column) => isSecretColumn(column))) notes.push('a column that looks like a secret is not shown');
  return notes.length > 0 ? `${lines.join('\n')}\n(${notes.join('; ')})` : lines.join('\n');
}
