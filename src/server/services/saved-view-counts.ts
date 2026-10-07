/**
 * What a pinned view counts (platform phase, Agent 8).
 *
 * Home shows, beside a pinned view, how many rows its screen would list. That
 * number is never stored and never computed by a second query of its own: each
 * counter below calls the *screen's* service (or the shared register function
 * the page itself calls — `screen-registers.ts`), inside the caller's
 * transaction, with the view's parameters re-validated for today. So a
 * person's count is what they would see on opening the screen — their grants,
 * their branch, their row policies — and a person who has lost access gets no
 * count at all (`pinnedFor` does not ask for an unavailable screen).
 *
 * A screen with no counter here is shown on Home as a link only. To add one:
 * one entry in `COUNTERS`, keyed by the registry key.
 */
import type { Tx } from '../db/client';
import type { Principal } from '../domain/permissions';
import { pickOne } from '../domain/pick';
import { registerDatesOf } from '../domain/register-dates';
import * as availability from './availability';
import * as declarations from './customs-declarations';
import * as customs from './customs-pd';
import * as openItems from './open-items';
import * as partners from './partners';
import * as registers from './screen-registers';

export interface CountWho {
  readonly principal: Principal;
  /** The branch the person is working in — the scope the screen's query runs under. */
  readonly branchCode: string;
}

export type Counter = (
  tx: Tx,
  who: CountWho,
  params: Readonly<Record<string, string>>,
  today: string,
) => Promise<number>;

type PdView = NonNullable<customs.PdListFilter['view']>;
type ContainerView = NonNullable<Parameters<typeof registers.containerRegister>[1]['view']>;

/** A customer or supplier whose code or name was typed — the ageing screens' own resolution. */
async function typedParty(tx: Tx, side: openItems.Side, asked: string | undefined) {
  if (!asked) return { party: undefined, unresolved: false };
  const roll = await partners.listByRole(tx, side);
  const chosen = pickOne(roll, asked, (row) => row.code, (row) => [row.code, row.legalName, row.tradeName]);
  return chosen ? { party: chosen.code, unresolved: false } : { party: undefined, unresolved: true };
}

const COUNTERS: Readonly<Record<string, Counter>> = {
  'payables.invoices': async (tx, _who, p, today) =>
    (
      await registers.invoiceRegister(
        tx,
        {
          q: p['q'] ?? null,
          view: p['view'] ?? null,
          minAmount: p['min_amount'] ?? null,
          importLink: p['import'] ?? null,
          dates: registerDatesOf(p),
        },
        today,
      )
    ).shown.length,

  // Overdue suppliers: the ageing's own query, narrowed the way the screen narrows it.
  'payables.open_items': async (tx, who, p, today) => {
    const { party, unresolved } = await typedParty(tx, 'supplier', p['code']);
    if (unresolved) return 0;
    const show = p['show'] ?? 'all';
    const items = await openItems.openItems(tx, who.principal, 'supplier', p['as_at'] ?? today, {
      branchCode: who.branchCode,
      ...(party ? { partyCode: party } : {}),
      outstandingOnly: show !== 'all',
      overdueOnly: show === 'overdue',
    });
    return items.length;
  },

  // Sales invoices awaiting payment: the Receivables Ageing's own query and narrowing.
  'sales.receivables': async (tx, who, p, today) => {
    const { party, unresolved } = await typedParty(tx, 'customer', p['code']);
    if (unresolved) return 0;
    const items = await openItems.openItems(tx, who.principal, 'customer', p['as_at'] ?? today, {
      branchCode: openItems.branchFrom(p['branch'], who.principal.branchCodes, who.branchCode),
      ...(party ? { partyCode: party } : {}),
    });
    return openItems.narrowList(items, { show: openItems.showFrom(p['show'] ?? 'all'), currency: p['currency'] ?? null }).length;
  },

  'imports.containers': async (tx, _who, p) =>
    (
      await registers.containerRegister(tx, {
        view: (p['view'] ?? 'in_transit') as ContainerView,
        q: p['q'] ?? null,
        etaFrom: p['eta_from'] ?? null,
        etaTo: p['eta_to'] ?? null,
      })
    ).shown.length,

  'imports.pd': async (tx, _who, p) =>
    (await customs.listForScreen(tx, { view: (p['view'] ?? 'live') as PdView, search: p['q'] ?? null, pageSize: 1 })).total,

  'logistics.customs_declarations': async (tx, _who, p) =>
    (
      await declarations.listForScreen(tx, {
        view: (p['view'] ?? 'open') as NonNullable<declarations.DeclarationFilter['view']>,
        search: p['q'] ?? null,
        pageSize: 1,
      })
    ).total,

  'inventory.availability': async (tx, who, p) =>
    (
      await availability.forScreen(tx, who.principal, {
        search: p['q'] ?? null,
        warehouseCode: p['warehouse'] ?? null,
        category: p['category'] ?? null,
        branchCode: p['branch'] ?? null,
        inStock: p['in_stock'] === '1',
        pageSize: 1,
      })
    ).total,

  'payables.suppliers': async (tx, _who, p) =>
    (await registers.partnerRegister(tx, 'supplier', { q: p['q'] ?? null, status: p['status'] ?? null })).shown.length,

  'sales.customers': async (tx, _who, p) =>
    (await registers.partnerRegister(tx, 'customer', { q: p['q'] ?? null, status: p['status'] ?? null })).shown.length,
};

/** The counter for a screen, or undefined when the screen is shown on Home as a link only. */
export function counterFor(routeKey: string): Counter | undefined {
  return COUNTERS[routeKey];
}

/** The screens that have a counter — for the registry test. */
export function countedRoutes(): readonly string[] {
  return Object.keys(COUNTERS);
}
