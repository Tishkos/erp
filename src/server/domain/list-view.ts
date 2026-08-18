/**
 * The list framework — Phase 01.12, Appendix A global UI rule 1.
 *
 * *"Every list supports permission-controlled search, filters, sorting, saved
 * views and export."*
 *
 * And the 01.12 gate that gives it teeth:
 *
 * *"Export returns exactly the rows the on-screen list would return for that
 * user — no more."*
 *
 * That gate is the reason this module exists. Export is where row-level
 * security is usually lost: the screen goes through a carefully scoped query
 * and the export goes through a "quick" second one that forgets a filter. So
 * there is one description of what a list *is* — a `ListQuery` — and both the
 * screen and the export are handed the same one. The only difference the export
 * is permitted is that it stops paginating, which is expressed here as a flag
 * on the same object rather than as a separate code path.
 *
 * Pure: no SQL, no request. `services/list.ts` compiles a `ListQuery` to SQL
 * once, and scope filtering is applied there and again by RLS in the database.
 */
import type { PermissionVerb, Principal } from './permissions';
import { can } from './permissions';

/** What kind of thing a column holds — decides which operators make sense. */
export const COLUMN_KINDS = ['text', 'number', 'money', 'date', 'enum', 'boolean', 'uuid'] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const FILTER_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'starts_with',
  'in',
  'between',
  'is_null',
  'is_not_null',
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/**
 * Which operators each kind accepts.
 *
 * Declared rather than inferred so that "contains" can never reach a date
 * column and turn into a cast error at the database, surfacing to the user as
 * the generic failure §25 forbids.
 */
const OPERATORS_BY_KIND: Readonly<Record<ColumnKind, readonly FilterOperator[]>> = Object.freeze({
  text: ['eq', 'neq', 'contains', 'starts_with', 'in', 'is_null', 'is_not_null'],
  number: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'in', 'is_null', 'is_not_null'],
  money: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'is_null', 'is_not_null'],
  date: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'is_null', 'is_not_null'],
  enum: ['eq', 'neq', 'in', 'is_null', 'is_not_null'],
  boolean: ['eq', 'is_null', 'is_not_null'],
  uuid: ['eq', 'neq', 'in', 'is_null', 'is_not_null'],
});

export function operatorsFor(kind: ColumnKind): readonly FilterOperator[] {
  return OPERATORS_BY_KIND[kind];
}

export interface ColumnDefinition {
  /** Identifier used in queries, saved views and export headers. */
  readonly key: string;
  readonly kind: ColumnKind;
  /** Included in the free-text search box. Only meaningful for text columns. */
  readonly searchable?: boolean;
  readonly sortable?: boolean;
  readonly filterable?: boolean;
  /**
   * A column the user may not see without this verb — e.g. cost on a sales
   * list. Absent means the list's own view permission is enough.
   */
  readonly requires?: { readonly verb: PermissionVerb; readonly object: string };
  /** Allowed values, for enum columns. Rejecting anything else at the edge. */
  readonly values?: readonly string[];
}

export interface ListDefinition {
  /** Matches the menu item and the permission object (§5.3). */
  readonly key: string;
  readonly object: string;
  readonly columns: readonly ColumnDefinition[];
  readonly defaultSort: readonly SortSpec[];
  /** Hard ceiling on one page. Export is not bound by this. */
  readonly maxPageSize?: number;
}

export interface SortSpec {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

export interface FilterSpec {
  readonly column: string;
  readonly operator: FilterOperator;
  /** Absent for is_null / is_not_null; two-element for between; array for in. */
  readonly value?: string | number | boolean | readonly (string | number)[];
}

export interface ListQuery {
  readonly listKey: string;
  readonly search?: string;
  readonly filters: readonly FilterSpec[];
  readonly sort: readonly SortSpec[];
  readonly page: number;
  readonly pageSize: number;
  /**
   * Export mode: same predicates, no page window.
   *
   * A flag rather than a second function, so that the export cannot drift from
   * the screen. Anything that narrows rows is above this line and shared.
   */
  readonly unpaged: boolean;
  /** Columns actually returned, after permission pruning. */
  readonly columns: readonly string[];
  /**
   * D10 — *"All Permitted Branches"*.
   *
   * A list opens on the Active Branch, because that keeps daily work focused. A
   * user with several branches may switch to another one — which is an ordinary
   * filter — or ask for all of them, which is this. It widens the *default*, not
   * the permission: `app_branch_allowed` still applies, so "all" means all the
   * user is authorised for and never more.
   */
  readonly allPermittedBranches?: boolean;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * §25: *"Validation messages identify the field, reason and corrective action;
 * no generic 'something went wrong' for business errors."*
 */
export class ListQueryError extends Error {
  readonly code = 'LIST_QUERY_INVALID';
  constructor(
    readonly field: string,
    readonly reason: string,
    readonly correction: string,
  ) {
    super(`${field}: ${reason} ${correction}`);
    this.name = 'ListQueryError';
  }
}

export function columnOf(definition: ListDefinition, key: string): ColumnDefinition {
  const column = definition.columns.find((c) => c.key === key);
  if (!column) {
    throw new ListQueryError(
      key,
      `'${key}' is not a column of the ${definition.key} list.`,
      `Choose one of: ${definition.columns.map((c) => c.key).join(', ')}.`,
    );
  }
  return column;
}

/**
 * Columns this principal may see.
 *
 * Pruned rather than blanked: a column the user cannot see should not appear in
 * the header row of their export either, or the shape of the file tells them
 * what was withheld.
 */
export function visibleColumns(
  definition: ListDefinition,
  principal: Principal,
): readonly ColumnDefinition[] {
  return definition.columns.filter(
    (column) => !column.requires || can(principal, column.requires.verb, column.requires.object),
  );
}

function assertValueShape(column: ColumnDefinition, filter: FilterSpec): void {
  const { operator, value } = filter;

  if (operator === 'is_null' || operator === 'is_not_null') {
    if (value !== undefined) {
      throw new ListQueryError(
        column.key,
        `'${operator}' does not take a value.`,
        'Remove the value, or choose an operator that compares.',
      );
    }
    return;
  }

  if (value === undefined || value === null || value === '') {
    throw new ListQueryError(
      column.key,
      `'${operator}' needs a value to compare against.`,
      'Enter a value, or use "is empty" to match blank records.',
    );
  }

  if (operator === 'between') {
    if (!Array.isArray(value) || value.length !== 2) {
      throw new ListQueryError(
        column.key,
        'A range filter needs exactly two values, a start and an end.',
        'Enter both ends of the range.',
      );
    }
    return;
  }

  if (operator === 'in') {
    if (!Array.isArray(value) || value.length === 0) {
      throw new ListQueryError(
        column.key,
        'A list filter needs at least one value.',
        'Select one or more values, or remove the filter.',
      );
    }
  } else if (Array.isArray(value)) {
    throw new ListQueryError(
      column.key,
      `'${operator}' compares against a single value.`,
      'Use "is one of" to match several values.',
    );
  }

  if (column.kind === 'enum' && column.values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      if (!column.values.includes(String(candidate))) {
        throw new ListQueryError(
          column.key,
          `'${String(candidate)}' is not a value of ${column.key}.`,
          `Choose one of: ${column.values.join(', ')}.`,
        );
      }
    }
  }
}

export interface RawListQuery {
  readonly listKey?: string;
  readonly search?: string;
  readonly filters?: readonly FilterSpec[];
  readonly sort?: readonly SortSpec[];
  readonly page?: number;
  readonly pageSize?: number;
  readonly unpaged?: boolean;
  readonly allPermittedBranches?: boolean;
}

/**
 * Validate a query from a URL, an API call or a saved view into one the service
 * layer can compile without further checking.
 *
 * Everything the user can influence is checked here, once. A saved view is
 * re-validated on use rather than trusted, because the list it was saved
 * against may have lost a column since, and because the permissions of the
 * person opening a shared view are not the permissions of the one who saved it.
 */
export function normaliseQuery(
  definition: ListDefinition,
  principal: Principal,
  raw: RawListQuery,
): ListQuery {
  const allowed = visibleColumns(definition, principal);
  const allowedKeys = new Set(allowed.map((c) => c.key));

  for (const filter of raw.filters ?? []) {
    const column = columnOf(definition, filter.column);

    if (!allowedKeys.has(column.key)) {
      // Not "unknown column" — that would confirm the column exists to someone
      // who may not see it. Filtering by a hidden column is refused as a
      // permission matter, which is what it is.
      throw new ListQueryError(
        column.key,
        `You do not have permission to filter by ${column.key}.`,
        'Remove this filter, or ask an administrator for the permission.',
      );
    }
    if (column.filterable === false) {
      throw new ListQueryError(
        column.key,
        `${column.key} cannot be filtered.`,
        'Use search, or filter on another column.',
      );
    }
    if (!operatorsFor(column.kind).includes(filter.operator)) {
      throw new ListQueryError(
        column.key,
        `'${filter.operator}' cannot be used on a ${column.kind} column.`,
        `Use one of: ${operatorsFor(column.kind).join(', ')}.`,
      );
    }
    assertValueShape(column, filter);
  }

  for (const sort of raw.sort ?? []) {
    const column = columnOf(definition, sort.column);
    if (!allowedKeys.has(column.key)) {
      throw new ListQueryError(
        column.key,
        `You do not have permission to sort by ${column.key}.`,
        'Sort by another column.',
      );
    }
    if (column.sortable === false) {
      throw new ListQueryError(
        column.key,
        `${column.key} cannot be sorted.`,
        'Sort by another column.',
      );
    }
  }

  const ceiling = definition.maxPageSize ?? MAX_PAGE_SIZE;
  const pageSize = raw.pageSize ?? DEFAULT_PAGE_SIZE;
  if (pageSize < 1 || pageSize > ceiling) {
    throw new ListQueryError(
      'pageSize',
      `A page holds between 1 and ${ceiling} rows.`,
      `Ask for at most ${ceiling}, or export the list instead.`,
    );
  }

  const page = raw.page ?? 1;
  if (!Number.isInteger(page) || page < 1) {
    throw new ListQueryError('page', 'Page numbers start at 1.', 'Ask for page 1 or later.');
  }

  return {
    listKey: definition.key,
    ...(raw.search?.trim() ? { search: raw.search.trim() } : {}),
    filters: raw.filters ?? [],
    sort: (raw.sort ?? []).length > 0 ? (raw.sort ?? []) : definition.defaultSort,
    page,
    pageSize,
    unpaged: raw.unpaged ?? false,
    allPermittedBranches: raw.allPermittedBranches ?? false,
    columns: allowed.map((c) => c.key),
  };
}

/**
 * The export query for a screen query.
 *
 * Deliberately the only supported way to build one: it copies the screen's
 * query and removes the page window, so no filter, no scope and no column
 * pruning can be lost between the two. The 01.12 gate is this function.
 */
export function toExportQuery(query: ListQuery): ListQuery {
  return { ...query, unpaged: true, page: 1 };
}

/** Text columns the free-text box searches. */
export function searchableColumns(
  definition: ListDefinition,
  principal: Principal,
): readonly ColumnDefinition[] {
  return visibleColumns(definition, principal).filter(
    (c) => c.searchable && (c.kind === 'text' || c.kind === 'enum'),
  );
}
