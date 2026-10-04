/**
 * Global search — the service.
 *
 * One phrase, every registered record type, **as the asker**:
 *
 *   1. the phrase is planned against the numbering series (`domain/search.ts`);
 *   2. a type is queried only when the asker holds its grant (`can`) and its
 *      list screen is served (`visibleRoute`) — a type they may not see is never
 *      touched, so it cannot be found by a count or by another field matching;
 *   3. the query runs in the asker's transaction, whose row policies decide the
 *      branch (and which the database holds read-only, with a timeout);
 *   4. each type's page is a savepoint of its own: one that fails is named in
 *      `failed` and the rest are answered;
 *   5. the groups are ordered by the best match they hold, masters first.
 *
 * Search is read-only and keeps no history of what was asked (no audit row, no
 * log of the phrase): a phrase is typed to find something, and what a person
 * looked for is not the company's to keep.
 */
import { sql } from 'drizzle-orm';
import { db, applyScope, type RequestScope, type Tx } from '../db/client';
import { visibleMenu } from '../domain/menu';
import { can, type Principal } from '../domain/permissions';
import { routeFor } from '../domain/screens';
import {
  compareGroups,
  compareHits,
  DEFAULT_GROUP_LIMIT,
  planQuery,
  type QueryPlan,
  type SeriesInfo,
} from '../domain/search';
import { visibleRoute } from '../delivered';
import { registerBuiltInSearchTypes } from '../search/entities';
import { searchTypes } from '../search/registry';
import { runTableType } from '../search/table-query';
import type { SearchRow, SearchType, TypeRequest } from '../search/types';

/** A whole search is cut off after this long; a type that overruns it is `failed`, not waited for. */
export const STATEMENT_TIMEOUT_MS = 5000;
/** The most rows one group is ever asked for (the page's own limit is smaller). */
export const MAX_GROUP_LIMIT = 50;
/** The furthest a group is paged. */
export const MAX_OFFSET = 1000;

export interface SearchInput {
  readonly query: string;
  /** Rows per group (default `DEFAULT_GROUP_LIMIT`). */
  readonly limit?: number;
  readonly offset?: number;
  /** Only these types (keys of the registry) — the /search page's filter. */
  readonly types?: readonly string[];
}

export interface SearchGroup {
  readonly key: string;
  readonly priority: number;
  /** The best tier in the group. */
  readonly best: number;
  readonly rows: readonly SearchRow[];
  /** More rows than these exist for the same phrase. */
  readonly more: boolean;
}

export interface SearchOutcome {
  readonly plan: QueryPlan;
  readonly groups: readonly SearchGroup[];
  /** Types whose query failed or timed out; their results are missing, not empty. */
  readonly failed: readonly string[];
}

/** May the asker search this type at all? */
export function mayView(principal: Principal, type: SearchType): boolean {
  return (
    can(principal, type.grant.verb ?? 'view', type.grant.object) &&
    (type.route === undefined || visibleRoute(type.route))
  );
}

/** May the asker see money for this type — the figure's own grant when it has one, else the record's. */
export function mayAmount(principal: Principal, type: SearchType): boolean {
  if (type.kind !== 'table' || !type.amount) return false;
  const grant = type.amount.grant ?? type.grant;
  return can(principal, grant.verb ?? 'view', grant.object);
}

/** The numbering series — prefix and key — the phrase is read against. Small, indexed by key. */
export async function loadSeries(tx: Tx): Promise<SeriesInfo[]> {
  const result = await tx.execute(sql`select key, prefix from doc_sequence`);
  return (result.rows as unknown as { key: string; prefix: string }[]).map((row) => ({
    key: row.key,
    prefix: row.prefix,
  }));
}

/** The database's own message (drizzle wraps it as the `cause` of a "Failed query"). */
function reasonOf(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}

const clamp = (value: number | undefined, fallback: number, max: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), max);
};

/**
 * The search, on a transaction that already carries the asker's scope
 * (`searchAs` opens one). Rows come back untranslated; `search/present.ts`
 * turns them into what a screen shows.
 */
export async function search(tx: Tx, principal: Principal, input: SearchInput): Promise<SearchOutcome> {
  registerBuiltInSearchTypes();
  const catalog = await loadSeries(tx);
  const plan = planQuery(input.query, catalog);
  if (!plan.records) return { plan, groups: [], failed: [] };

  const limit = Math.max(1, clamp(input.limit, DEFAULT_GROUP_LIMIT, MAX_GROUP_LIMIT));
  const offset = clamp(input.offset, 0, MAX_OFFSET);
  const only = input.types && input.types.length > 0 ? new Set(input.types) : null;

  const groups: SearchGroup[] = [];
  const failed: string[] = [];

  for (const type of searchTypes()) {
    if (only && !only.has(type.key)) continue;
    if (!mayView(principal, type)) continue;
    const request: TypeRequest = {
      plan,
      limit,
      offset,
      principal,
      mayAmount: mayAmount(principal, type),
    };
    // A savepoint per type: a statement that fails (or times out) aborts the
    // transaction until it is rolled back to here; the others carry on.
    await tx.execute(sql`savepoint search_type`);
    try {
      const result = type.kind === 'table' ? await runTableType(tx, type, request) : await type.run(tx, request);
      await tx.execute(sql`release savepoint search_type`);
      if (result.rows.length === 0) continue;
      const rows = [...result.rows].sort(compareHits);
      groups.push({ key: type.key, priority: type.priority, best: rows[0]!.tier, rows, more: result.more });
    } catch (error) {
      await tx.execute(sql`rollback to savepoint search_type`);
      failed.push(type.key);
      // The type and the failure — never the phrase.
      console.error(`[global-search] ${type.key} failed:`, reasonOf(error));
    }
  }
  groups.sort(compareGroups);
  return { plan, groups, failed };
}

/**
 * Opens the asker's transaction — scope applied, the database holding it
 * read-only, a statement timeout on it — and searches.
 */
export async function searchAs(scope: RequestScope, principal: Principal, input: SearchInput): Promise<SearchOutcome> {
  return db.transaction(async (tx) => {
    await applyScope(tx, scope);
    await tx.execute(sql`set local transaction_read_only = on`);
    await tx.execute(sql.raw(`set local statement_timeout = ${STATEMENT_TIMEOUT_MS}`));
    return search(tx, principal, input);
  });
}

// ---------------------------------------------------------------------------
// Screens
// ---------------------------------------------------------------------------

export interface VisibleScreen {
  readonly sectionKey: string;
  readonly itemKey: string;
  readonly href: string;
}

/**
 * The screens the asker may open — **the application shell's own rule**
 * (`components/app-shell.tsx`): the menu tree filtered by grant, then by
 * whether the route is served, the audit trail filed once. Written here as a
 * function so the /search page reads the same list the navigation shows;
 * `gs-global-search.test.ts` holds the two together.
 */
export function visibleScreens(principal: Principal): VisibleScreen[] {
  const seen = new Set<string>();
  const screens: VisibleScreen[] = [];
  for (const section of visibleMenu(principal)) {
    for (const item of section.items) {
      if (item.key === 'document_audit') continue;
      const href = routeFor(item, section.key);
      if (!visibleRoute(href) || seen.has(href)) continue;
      seen.add(href);
      screens.push({ sectionKey: section.key, itemKey: item.key, href });
    }
  }
  return screens;
}
