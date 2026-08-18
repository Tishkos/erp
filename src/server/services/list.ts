/**
 * List execution — Phase 01.12.
 *
 * One compiler from `ListQuery` to SQL, used by the screen and by the export.
 * The 01.12 gate is *"Export returns exactly the rows the on-screen list would
 * return for that user — no more"*, and the only way to be sure of that is for
 * there to be nothing to keep in step: `rows()` and `exportRows()` below differ
 * by the presence of LIMIT and by nothing else.
 *
 * Every value the user supplies is bound as a parameter. Column and table names
 * cannot be parameterised, so they are never taken from input — they come from
 * the registered `ListDefinition`, which is code. A filter naming an unknown
 * column is refused in the domain layer before it reaches here.
 *
 * Row scope is applied twice on purpose: the branch predicate is added here so
 * the query is sane and indexed, and RLS applies it again in the database so a
 * query that forgets cannot leak (TECHSTACK A3).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  normaliseQuery,
  toExportQuery,
  visibleColumns,
  searchableColumns,
  type FilterSpec,
  type ListDefinition,
  type ListQuery,
  type RawListQuery,
} from '../domain/list-view';
import type { Principal } from '../domain/permissions';
import { assertCan } from '../domain/permissions';
import * as audit from './audit';

/**
 * How a list definition reaches its data.
 *
 * `from` is a SQL fragment — a table or a join — and `columnSql` maps a column
 * key to the expression that produces it. Modules register these; nothing here
 * knows what a journal entry is.
 */
export interface ListSource {
  readonly definition: ListDefinition;
  readonly from: SQL;
  readonly columnSql: Readonly<Record<string, SQL>>;
  /**
   * Extra predicate always applied — a soft-delete flag, a document-type
   * discriminator on a shared table. Applied to screen and export alike.
   */
  readonly baseWhere?: SQL;
  /**
   * The column holding the branch, if the list is branch-scoped. Named rather
   * than assumed, because not every list is (the user list is not).
   */
  readonly branchColumn?: string;
}

const registry = new Map<string, ListSource>();

/** Modules call this at load time. Re-registering replaces, for hot reload. */
export function registerList(source: ListSource): void {
  registry.set(source.definition.key, source);
}

export class UnknownListError extends Error {
  readonly code = 'UNKNOWN_LIST';
  constructor(listKey: string) {
    super(`No list named '${listKey}' is registered.`);
    this.name = 'UnknownListError';
  }
}

export function listSource(listKey: string): ListSource {
  const source = registry.get(listKey);
  if (!source) throw new UnknownListError(listKey);
  return source;
}

export function registeredLists(): readonly string[] {
  return [...registry.keys()].sort();
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

/**
 * Escapes the characters ILIKE treats as wildcards.
 *
 * Someone typing `%` into a search box is looking for a percent sign. Passed
 * through unescaped it matches every row, which reads as a broken filter — and
 * `_` silently matches any single character, which is worse because the result
 * looks plausible. Both are escaped, and the backslash first so it does not
 * escape the escapes.
 */
function escapeLike(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function filterSql(source: ListSource, filter: FilterSpec): SQL {
  const column = source.columnSql[filter.column];
  if (!column) {
    // Registered definition and registered source disagree — a programming
    // error, not a user one, so it is not a ListQueryError.
    throw new Error(
      `List '${source.definition.key}' declares column '${filter.column}' but maps no SQL for it.`,
    );
  }

  const value = filter.value;

  switch (filter.operator) {
    case 'eq':
      return sql`${column} = ${value}`;
    case 'neq':
      return sql`${column} <> ${value}`;
    case 'lt':
      return sql`${column} < ${value}`;
    case 'lte':
      return sql`${column} <= ${value}`;
    case 'gt':
      return sql`${column} > ${value}`;
    case 'gte':
      return sql`${column} >= ${value}`;
    case 'contains':
      return sql`${column} ILIKE ${`%${escapeLike(String(value))}%`} ESCAPE '\\'`;
    case 'starts_with':
      return sql`${column} ILIKE ${`${escapeLike(String(value))}%`} ESCAPE '\\'`;
    case 'in': {
      const values = value as readonly (string | number)[];
      // sql.param binds the whole array as one parameter. Interpolating it
      // directly makes drizzle expand it into ($1, $2, …), which is a row
      // constructor rather than an array and fails against ANY().
      return sql`${column} = ANY(${sql.param(values)})`;
    }
    case 'between': {
      const [from, to] = value as readonly [unknown, unknown];
      return sql`${column} BETWEEN ${from} AND ${to}`;
    }
    case 'is_null':
      return sql`${column} IS NULL`;
    case 'is_not_null':
      return sql`${column} IS NOT NULL`;
  }
}

function searchSql(source: ListSource, principal: Principal, term: string): SQL | null {
  const columns = searchableColumns(source.definition, principal);
  if (columns.length === 0) return null;

  const pattern = `%${escapeLike(term)}%`;
  const parts = columns
    .map((c) => source.columnSql[c.key])
    .filter((c): c is SQL => c !== undefined)
    .map((c) => sql`${c}::text ILIKE ${pattern} ESCAPE '\\'`);

  return parts.length > 0 ? sql`(${sql.join(parts, sql` OR `)})` : null;
}

/**
 * The predicate. Shared by the screen, the export and the row count, so the
 * three can never disagree about which rows the list contains.
 */
function whereSql(source: ListSource, principal: Principal, query: ListQuery): SQL {
  const parts: SQL[] = [];

  if (source.baseWhere) parts.push(source.baseWhere);

  // §22 — row-level security in the query layer, not only in the screen. And
  // D10 (2026-08-17) — two different things, applied here as two:
  //
  //   **Security** is the user's *permitted* branches. `app_branch_allowed` is
  //   the same function the row-level policies use, so the list and the database
  //   cannot disagree about which rows exist. Without this the list would ask
  //   for rows the policy then filtered out, and the count would not match the
  //   page.
  //
  //   **The Active Branch** is a *default filter*, not a permission: "a normal
  //   list should initially show the Active Branch to keep daily work clean and
  //   focused", and a user with several branches may switch to another or to all
  //   of them. So it is applied only when the caller has not filtered on branch
  //   themselves — an explicit filter is the user having switched.
  if (source.branchColumn && !principal.isSuperUser) {
    const branchColumn = source.columnSql[source.branchColumn];
    if (!branchColumn) {
      throw new Error(
        `List '${source.definition.key}' names branch column '${source.branchColumn}' but maps no SQL for it.`,
      );
    }

    // Security — always.
    parts.push(sql`(${branchColumn} IS NULL OR app_branch_allowed(${branchColumn}))`);

    // Convenience — unless the user said otherwise.
    const filteredOnBranch = query.filters.some(
      (filter) => filter.column === source.branchColumn,
    );
    if (!filteredOnBranch && !query.allPermittedBranches) {
      parts.push(
        sql`(${branchColumn} IS NULL OR ${branchColumn} = current_setting('app.branch_code', true))`,
      );
    }
  }

  for (const filter of query.filters) parts.push(filterSql(source, filter));

  if (query.search) {
    const search = searchSql(source, principal, query.search);
    if (search) parts.push(search);
  }

  return parts.length === 0 ? sql`true` : sql.join(parts, sql` AND `);
}

function orderSql(source: ListSource, query: ListQuery): SQL {
  const parts = query.sort
    .map((s) => {
      const column = source.columnSql[s.column];
      if (!column) return null;
      return s.direction === 'desc' ? sql`${column} DESC NULLS LAST` : sql`${column} ASC`;
    })
    .filter((p): p is SQL => p !== null);

  return parts.length > 0 ? sql.join(parts, sql`, `) : sql`1`;
}

function selectSql(source: ListSource, query: ListQuery): SQL {
  const parts = query.columns
    .map((key) => {
      const column = source.columnSql[key];
      // Quoting the alias keeps a column named e.g. "order" from colliding with
      // a keyword; the key itself comes from code, never from the request.
      return column ? sql`${column} AS "${sql.raw(key.replace(/"/g, ''))}"` : null;
    })
    .filter((p): p is SQL => p !== null);

  return sql.join(parts, sql`, `);
}

export interface ListResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly query: ListQuery;
  /** Total matching rows, ignoring the page window. Null when not counted. */
  readonly total: number | null;
}

export interface ListOptions {
  /** Counting costs a second query; a screen wants it, an export does not. */
  readonly withTotal?: boolean;
}

async function execute(
  tx: Tx,
  principal: Principal,
  query: ListQuery,
  options: ListOptions = {},
): Promise<ListResult> {
  const source = listSource(query.listKey);
  const where = whereSql(source, principal, query);

  const statement = query.unpaged
    ? sql`SELECT ${selectSql(source, query)} FROM ${source.from} WHERE ${where} ORDER BY ${orderSql(source, query)}`
    : sql`SELECT ${selectSql(source, query)} FROM ${source.from} WHERE ${where} ORDER BY ${orderSql(source, query)} LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`;

  const result = await tx.execute(statement);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;

  let total: number | null = null;
  if (options.withTotal) {
    const counted = await tx.execute(
      sql`SELECT count(*)::bigint AS total FROM ${source.from} WHERE ${where}`,
    );
    const countRows = (counted as unknown as { rows: { total: string }[] }).rows;
    total = Number(countRows[0]?.total ?? 0);
  }

  return { rows, query, total };
}

/**
 * A page of a list.
 *
 * `view` is checked here as well as in the route, because §23 requires the API
 * and the UI to enforce the same rules and this function is reachable from
 * both.
 */
export async function rows(
  tx: Tx,
  principal: Principal,
  listKey: string,
  raw: RawListQuery,
  options: ListOptions = { withTotal: true },
): Promise<ListResult> {
  const source = listSource(listKey);
  assertCan(principal, 'view', source.definition.object);

  const query = normaliseQuery(source.definition, principal, { ...raw, unpaged: false });
  return execute(tx, principal, query, options);
}

/**
 * The same rows, unpaged, for an export — and recorded, because who took a copy
 * of what is an audit question (§5.4).
 *
 * Takes the screen's own query and widens only the page window. There is no
 * parameter here that could re-open a filter or a column the screen had closed.
 */
export async function exportRows(
  tx: Tx,
  principal: Principal,
  listKey: string,
  raw: RawListQuery,
): Promise<ListResult> {
  const source = listSource(listKey);
  assertCan(principal, 'view', source.definition.object);
  assertCan(principal, 'export', source.definition.object);

  const screenQuery = normaliseQuery(source.definition, principal, { ...raw, unpaged: false });
  const result = await execute(tx, principal, toExportQuery(screenQuery), { withTotal: false });

  await audit.record(tx, {
    actorUserId: principal.userId,
    action: `${source.definition.object}.exported`,
    objectType: source.definition.object,
    objectId: listKey,
    outcome: 'success',
    // What was taken, not the rows themselves — an audit trail that copies the
    // export defeats the point of restricting the export.
    after: {
      rowCount: result.rows.length,
      columns: result.query.columns,
      filters: result.query.filters,
      search: result.query.search ?? null,
    },
  });

  return result;
}

/** The header row of an export, in the order the columns are returned. */
export function exportColumns(
  principal: Principal,
  listKey: string,
): readonly string[] {
  const source = listSource(listKey);
  return visibleColumns(source.definition, principal).map((c) => c.key);
}
