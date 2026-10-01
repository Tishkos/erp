import { isDelivered, screenRoutes } from './domain/screens';

/**
 * Which screens exist for the user.
 *
 * The approved tree (`domain/menu.ts`) names every screen the system will
 * ever have; the catalogue (`domain/screens.ts`) records which of them are
 * built and read the real database. This module turns that record into the
 * one question every surface asks — may this route be served? — so the
 * navigation, the launcher, the search, the tabs and the dashboard all give
 * the same answer, and typing the URL gets the same refusal.
 *
 * The foundation was delivered and accepted in full; from 2026-10-01 the
 * system grows screen by screen, driven by the company's own requirements
 * (docs/requirements/). A route joins `DELIVERED` in the catalogue on the day
 * its screen reads real data — never before, because a route that is visible
 * and unbuilt is a menu item that leads to an apology.
 *
 * `SHOW_UNBUILT_SCREENS=1` lifts the refusal — used only by the local test
 * server, so suites that exercise machinery with no screen yet keep running.
 * Production does not set it.
 */
export function unbuiltScreensShown(): boolean {
  return process.env.SHOW_UNBUILT_SCREENS === '1';
}

/** May this route be served right now? Record pages inherit their list's answer. */
export function visibleRoute(route: string): boolean {
  if (unbuiltScreensShown()) return true;
  if (isDelivered(route)) return true;
  // A record under a delivered document list ( /master-data/branches/HQ ) is
  // served too. Only a document's children inherit: a workspace at /documents
  // being live says nothing about /documents/templates, which is its own
  // screen and must earn its own place on the list.
  const parent = route.replace(/\/[^/]+$/, '');
  if (parent.length <= 1 || !isDelivered(parent)) return false;
  return screenRoutes().get(parent)?.archetype === 'document';
}

/**
 * The permission objects behind the screens that exist. A grant over a
 * section nobody can open would be a promise the system cannot keep, so the
 * permissions editor does not offer one.
 */
export function liveObjects(): ReadonlySet<string> {
  const objects = new Set<string>();
  for (const screen of screenRoutes().values()) {
    if (visibleRoute(screen.route)) objects.add(screen.item.object);
  }
  return objects;
}
