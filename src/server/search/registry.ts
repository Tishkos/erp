/**
 * The registry of searchable record types.
 *
 * Global Search owns it; every module that has records a person looks for
 * registers them here (the Task Center registers tasks, the Document Center its
 * documents). A registration is a declaration (`types.ts`) — the search service
 * does the rest: the grant, the row policy, the ranking, the display.
 *
 * `registerSearchType` replaces a type of the same key, so a module may be
 * loaded twice (a hot reload, a test) without doubling its results.
 */
import type { SearchType } from './types';

/**
 * Held on `globalThis`: the route handler, the /search page and a server action
 * are separate bundles of the same process, and each would otherwise see its own
 * (empty) copy of the module's map.
 */
const STORE = Symbol.for('qimah.search.types');
const holder = globalThis as unknown as Record<symbol, Map<string, SearchType> | undefined>;
const types: Map<string, SearchType> = (holder[STORE] ??= new Map<string, SearchType>());

export function registerSearchType(type: SearchType): void {
  types.set(type.key, type);
}

export function unregisterSearchType(key: string): void {
  types.delete(key);
}

/** Every registered type, earliest priority first. */
export function searchTypes(): readonly SearchType[] {
  return [...types.values()].sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key));
}

export function searchType(key: string): SearchType | undefined {
  return types.get(key);
}
