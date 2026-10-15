/**
 * Register paging — REQ-HARDEN-001 G5 / HD15.
 *
 * Every register pages at fifty with a true count. A register's screen read
 * builds one WHERE from every filter the screen offers, counts the rows it
 * selects and reads one window of them with LIMIT/OFFSET, so the count in
 * the header, the page and the pager all describe the same set. Before this
 * three registers stopped silently at 200 rows and five read every row and
 * filtered in JavaScript.
 *
 * Callers other than the register screens (the payable page's sections, the
 * sweep) keep their own reads, bounded by the document they belong to.
 */
import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { likeEscape, searchWords } from '../domain/search';

export const REGISTER_PAGE_SIZE = 50;

export interface RegisterPage<T> {
  readonly rows: T[];
  /** Rows matching the filters, over every page. */
  readonly total: number;
  /** The page returned — clamped to the last page there is. */
  readonly page: number;
  readonly pageSize: number;
  /** At least 1, so a screen can always say "page 1 of 1". */
  readonly pages: number;
}

/** What every register's screen read takes besides its own filters. */
export interface RegisterPaging {
  readonly page?: number | null;
  readonly pageSize?: number | null;
}

/**
 * Counts, then reads the window. Sequential on purpose: one transaction is
 * one connection, and the count decides which page exists.
 */
export async function registerPage<T>(input: {
  readonly paging: RegisterPaging;
  readonly count: () => Promise<number>;
  readonly rows: (window: { readonly limit: number; readonly offset: number }) => Promise<T[]>;
}): Promise<RegisterPage<T>> {
  const pageSize = Math.max(1, Math.floor(input.paging.pageSize ?? REGISTER_PAGE_SIZE));
  const total = Number(await input.count());
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const asked = Math.max(1, Math.floor(Number(input.paging.page ?? 1)) || 1);
  const page = Math.min(asked, pages);
  const rows = total === 0 ? [] : await input.rows({ limit: pageSize, offset: (page - 1) * pageSize });
  return { rows, total, page, pageSize, pages };
}

/** `select count(*)` over a raw statement's FROM … WHERE. */
export async function countOf(tx: Tx, fromWhere: SQL): Promise<number> {
  const result = await tx.execute(sql`select count(*)::int as n ${fromWhere}`);
  const [row] = (result as unknown as { rows: { n: number }[] }).rows;
  return Number(row?.n ?? 0);
}

/** `where a and b …`, or nothing when there is no predicate. */
export function whereOf(parts: readonly (SQL | null | undefined | false)[]): SQL {
  const kept = parts.filter((part): part is SQL => Boolean(part));
  return kept.length === 0 ? sql`` : sql`where ${sql.join(kept, sql` and `)}`;
}

/**
 * A search box over the given columns, case-insensitive, with `%`, `_` and
 * `\` taken literally (as `list.ts` does) — someone typing a percent sign is
 * looking for one. Null when there is nothing to search for.
 */
export function searchOf(
  columns: readonly (SQL | AnyColumn)[],
  term: string | null | undefined,
): SQL | null {
  const needle = (term ?? '').trim();
  if (!needle || columns.length === 0) return null;
  const pattern = `%${needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
  return sql`(${sql.join(
    columns.map((column) => sql`coalesce(${column}::text, '') ilike ${pattern} escape '\\'`),
    sql` or `,
  )})`;
}

/**
 * A search box that reads words rather than one phrase (2026-10-15): every
 * word must be found somewhere among the columns — "ham" finds Hama, "hama
 * 2026" finds Hama's rows that say 2026 anywhere, and the order the words are
 * typed in does not matter. Both sides go through `search_fold` (case, Arabic
 * diacritics and letter forms, Arabic-Indic digits — Global Search's folding),
 * so شركه finds شركة. A column may be an expression, such as the numbers of a
 * record's related documents gathered with `string_agg`. Null when nothing is
 * asked.
 *
 * Every row the filter sees is folded once per word, so it suits a register
 * of thousands, not a table of hundreds of thousands (see Global Search for
 * those).
 */
export function wordSearchOf(
  columns: readonly (SQL | AnyColumn)[],
  term: string | null | undefined,
): SQL | null {
  const words = searchWords(term);
  if (words.length === 0 || columns.length === 0) return null;
  const haystack = sql`search_fold(concat_ws(' ', ${sql.join(
    columns.map((column) => sql`${column}::text`),
    sql`, `,
  )}))`;
  return sql`(${sql.join(
    words.map((word) => sql`${haystack} like ${`%${likeEscape(word)}%`} escape '\\'`),
    sql` and `,
  )})`;
}
