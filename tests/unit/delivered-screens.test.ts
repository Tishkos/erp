/**
 * Every screen that reads real data can be opened — and nothing else can.
 *
 * `DELIVERED` in the screen catalogue is the one list the server trusts:
 * `visibleRoute` reads it directly, so a screen that is built is served and a
 * screen that is not does not exist on its URL. What this file guards is the
 * list's own hygiene, because a typo in it is silent: the route would be
 * refused at the door with "That page does not exist" while the page sits
 * built and tested behind it — which is what happened to the Warehouses
 * Report when the visibility list and the catalogue were two separate things.
 *
 * It is a hard failure to catch by hand, because the middleware redirects an
 * unauthenticated request to the sign-in page before the check ever runs. A
 * curl against the route answers 307 whether it would be served or not; only
 * a signed-in person sees the refusal. This asserts it directly instead.
 */
import { describe, expect, it } from 'vitest';
import { screenRoutes } from '@/server/domain/screens';
import { visibleRoute } from '@/server/delivered';

describe('the delivered screens can be opened', () => {
  // `SHOW_UNBUILT_SCREENS` lifts the refusal entirely and would make these vacuous.
  const asProductionRuns = () => {
    delete process.env.SHOW_UNBUILT_SCREENS;
  };

  it('serves every route the catalogue marks as reading real data', () => {
    asProductionRuns();
    const wired = [...screenRoutes().values()].filter((screen) => screen.wired);
    expect(wired.filter((screen) => !visibleRoute(screen.route))).toEqual([]);
  });

  it('serves no route that has not been built', () => {
    asProductionRuns();
    const unbuilt = [...screenRoutes().values()].filter((screen) => !screen.wired);
    expect(unbuilt.length).toBeGreaterThan(0);
    expect(unbuilt.filter((screen) => visibleRoute(screen.route))).toEqual([]);
  });

  it('lets a record page inherit its list', () => {
    asProductionRuns();
    // A document screen is a pair: the list, and one record beneath it.
    expect(visibleRoute('/sales/ar-invoices/INV-HQ-2026-000001')).toBe(true);
    expect(visibleRoute('/master-data/price-lists/PL-1')).toBe(false);
  });
});
