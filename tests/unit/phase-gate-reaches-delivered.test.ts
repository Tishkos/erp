/**
 * Every screen that reads real data can be opened.
 *
 * Two separate lists decide whether a screen works. `DELIVERED` in the screen
 * catalogue says the page exists and reads the database; the phase gate says
 * the sponsor has accepted the phase it belongs to. Both are deliberate, and
 * nothing held them together.
 *
 * So a screen could be built, tested, deployed — and refused at the door with
 * "That page does not exist. The address you followed is not part of the
 * approved menu tree." Which is what happened to the Warehouses Report: the
 * page was written and shipped, and the route was never added to the gate.
 *
 * It is a hard failure to catch by hand, because the middleware redirects an
 * unauthenticated request to the sign-in page before the gate check ever runs.
 * A curl against the route answers 307 whether the gate would allow it or not;
 * only a signed-in person sees the refusal. This asserts it directly instead.
 *
 * Both directions are asserted, for the Operations Build's own routes. The
 * other way round is the mirror embarrassment: a menu entry the sponsor can
 * click that leads to a "planned" placeholder. These eleven blocks are accepted
 * one at a time, so a route joins the gate on the day its screen reads real
 * data — not before, and not after.
 *
 * Scoped to those routes rather than every delivered screen because the two
 * lists mean different things elsewhere: `/documents` and `/inventory/
 * availability` are built and deliberately waiting on their phase, and turning
 * them on is the sponsor's decision, not a test's.
 */
import { describe, expect, it } from 'vitest';
import { isDelivered, screenRoutes } from '@/server/domain/screens';
import { OPERATIONS, visibleRoute } from '@/server/phase-gate';

describe('the Operations Build screens can be opened', () => {
  // `SHOW_FUTURE_PHASES` lifts the gate entirely and would make these vacuous.
  const asProductionRuns = () => {
    delete process.env.SHOW_FUTURE_PHASES;
  };

  it('lets a signed-in person open every route the gate opens for it', () => {
    asProductionRuns();
    expect(OPERATIONS.filter((route) => !visibleRoute(route))).toEqual([]);
  });

  it('opens no route that has not been built', () => {
    asProductionRuns();

    // The other half, and the one that would embarrass us the other way: a
    // menu entry the sponsor can click that leads to a "planned" placeholder.
    // The Operations Build is accepted a block at a time, so a route joins the
    // gate on the day its screen reads real data and not before.
    expect(OPERATIONS.filter((route) => !isDelivered(route))).toEqual([]);
  });

  it('names a route the catalogue knows', () => {
    asProductionRuns();

    // A typo in either list is silent: the gate would open an address that
    // does not exist, and the screen would stay unreachable under its real one.
    const known = new Set([...screenRoutes().values()].map((screen) => screen.route));
    expect(OPERATIONS.filter((route) => !known.has(route))).toEqual([]);
  });
});
