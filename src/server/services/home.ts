/**
 * Home — the page composed for the person who opened it. Platform phase, Agent 2.
 *
 * `composeFor` (pure, `domain/dashboard-widgets`) says which widgets this
 * person's grants and capabilities earn, in which order. This module runs their
 * loaders (`services/home-loaders`) **as that person**, one at a time, each in
 * a savepoint of its own, and hands back what each found.
 *
 * It decides nothing about who sees what — that is the registry — and computes
 * no figure — that is the loaders, which call the services that own them. Its
 * job is the part that goes wrong quietly if left to each widget:
 *
 * * **One read failing must not blank the page, and must not look like
 *   nothing.** A widget whose read threw is `unreadable` and the page says so;
 *   it is logged with the widget's key.
 * * **One slow read must not hold the page.** A statement timeout bounds every
 *   read, so a runaway query becomes an `unreadable` widget instead of a spinner.
 * * **A widget with nothing to say is not drawn as a promise.** A list marked
 *   `hideWhenEmpty` (the pinned views, the attention slot) disappears when
 *   empty; an unwired slot always does.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import { UNREADABLE, type WidgetOutcome } from '../domain/dashboard-data';
import {
  composeFor,
  type Composition,
  type QuickActionDefinition,
  type WidgetDefinition,
  type WidgetKey,
} from '../domain/dashboard-widgets';
import type { Principal } from '../domain/permissions';
import { registerAllLists } from '../lists';
import { LOADERS, type LoaderContext } from './home-loaders';
import { safeRead } from './safe-read';

export interface HomeContext {
  readonly principal: Principal;
  readonly branchCode: string;
  readonly requestId?: string | null;
}

export interface HomeWidget {
  readonly key: WidgetKey;
  readonly definition: WidgetDefinition;
  readonly outcome: WidgetOutcome;
}

export interface HomeView {
  readonly branchCode: string;
  readonly asOf: string;
  readonly families: Composition['families'];
  readonly unavailable: Composition['unavailable'];
  readonly quickActions: readonly QuickActionDefinition[];
  readonly kpi: readonly HomeWidget[];
  readonly chart: readonly HomeWidget[];
  readonly list: readonly HomeWidget[];
}

/** A read that takes longer than this is a defect to report, not a page to wait for. */
export const READ_TIMEOUT_MS = 15_000;

async function withTimeout<T>(tx: Tx, run: () => Promise<T>): Promise<T> {
  const before = (await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string };
  await tx.execute(sql`select set_config('statement_timeout', ${String(READ_TIMEOUT_MS)}, true)`);
  try {
    return await run();
  } finally {
    await tx.execute(sql`select set_config('statement_timeout', ${before.v}, true)`);
  }
}

/** Whether a widget with this outcome is drawn at all. */
export function drawn(definition: WidgetDefinition, outcome: WidgetOutcome): boolean {
  if (outcome.state === 'unwired') return false;
  if (outcome.state === 'empty' && definition.hideWhenEmpty) return false;
  return true;
}

/**
 * The page for the signed-in person. `served` says whether the shell serves a
 * route (`visibleRoute`); quick actions to a screen that is not built are left
 * out rather than offered and refused.
 */
export async function forViewer(tx: Tx, ctx: HomeContext, served: (route: string) => boolean = () => true): Promise<HomeView> {
  registerAllLists();
  const today = businessToday();
  const composition = composeFor(ctx.principal, served);
  const memo = new Map<string, unknown>();

  const run = async (definition: WidgetDefinition): Promise<HomeWidget> => {
    const key = definition.key as WidgetKey;
    const result = await safeRead(tx, `home.${key}`, (sp) => {
      const loaderContext: LoaderContext = { tx: sp, principal: ctx.principal, branchCode: ctx.branchCode, today, requestId: ctx.requestId ?? null, memo };
      return LOADERS[key](loaderContext);
    });
    return { key, definition, outcome: result.ok ? result.value : UNREADABLE };
  };

  // One at a time: the loaders share one transaction, which is one client.
  const loaded = await withTimeout(tx, async () => {
    const out: Record<'kpi' | 'chart' | 'list', HomeWidget[]> = { kpi: [], chart: [], list: [] };
    for (const zone of ['kpi', 'chart', 'list'] as const) {
      for (const definition of composition[zone]) out[zone].push(await run(definition));
    }
    return out;
  });

  const keep = (widgets: readonly HomeWidget[]) => widgets.filter((widget) => drawn(widget.definition, widget.outcome));
  return {
    branchCode: ctx.branchCode,
    asOf: today,
    families: composition.families,
    unavailable: composition.unavailable,
    quickActions: composition.quickActions,
    kpi: keep(loaded.kpi),
    chart: keep(loaded.chart),
    list: keep(loaded.list),
  };
}
