/**
 * The composition root of "where did the stock go?" — IMPROVEMENT-002.
 *
 * The inventory layer keeps the registry (`services/inventory-departures.ts`)
 * and knows no business module; each module answers for its own movement
 * kinds in `src/server/departures/`. This is the one place they are wired
 * together, so a landed-cost lock never imports sales, projects or
 * purchasing, and none of them imports the lock.
 *
 * Called from `registerAllRecords()` — which every server action that locks a
 * landed cost calls first, because a cold process has registered nothing — and
 * by tests. Idempotent: registering again replaces each handler with itself.
 */
import { registerDepartureHandler, type DepartureHandler } from './services/inventory-departures';
import { PROJECT_DEPARTURES } from './departures/projects';
import { PURCHASING_DEPARTURES } from './departures/purchasing';
import { SALES_DEPARTURES } from './departures/sales';
import { STOCK_DEPARTURES } from './departures/stock';

const MODULES: readonly Readonly<Record<string, DepartureHandler>>[] = [
  SALES_DEPARTURES,
  PROJECT_DEPARTURES,
  PURCHASING_DEPARTURES,
  STOCK_DEPARTURES,
];

export function registerDepartureRuntime(): void {
  const seen = new Set<string>();
  for (const handlers of MODULES) {
    for (const [kind, handler] of Object.entries(handlers)) {
      // One owner per kind: two modules answering for one kind would make the
      // answer depend on the order of this list.
      if (seen.has(kind)) throw new Error(`Two modules answer for the '${kind}' movement kind.`);
      seen.add(kind);
      registerDepartureHandler(kind, handler);
    }
  }
}
