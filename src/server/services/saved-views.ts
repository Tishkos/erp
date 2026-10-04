/**
 * Saved views — Phase 01.12, Appendix A global UI rule 1.
 *
 * A view stores a question. Opening one re-validates it against the current
 * list definition and runs it as the *reader*, so:
 *
 *   - a view saved before a column was removed reports that clearly instead of
 *     failing at the database,
 *   - a shared view cannot show its reader anything their own permissions and
 *     data scope would not.
 *
 * The second point is why `open()` returns a normalised query rather than rows
 * the author already fetched.
 *
 * Two kinds of view live in the one table (`saved_view.kind`, migration 0360):
 *
 *   'list'   the list framework's `ListQuery` — everything above, unchanged;
 *   'route'  a *screen's* filters (`payables.invoices` + its query-string
 *            parameters), owned by one person, never shared — the second half
 *            of this file, from "Screen views" down.
 *
 * The first half only ever touches `kind = 'list'` rows, so a screen view can
 * neither be opened as a list query nor overwritten by `save()`.
 */
import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { savedView } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { normaliseQuery, type ListQuery, type RawListQuery } from '../domain/list-view';
import type { Principal } from '../domain/permissions';
import { assertCan, can } from '../domain/permissions';
import { viewableRoute } from '../domain/saved-view-routes';
import {
  SavedViewInputError,
  chooseDefault,
  defaultRedirect,
  hrefOf,
  normaliseName,
  queryOf,
  resolveStored,
  sameParams,
  sanitiseParams,
  storedFrom,
  uniqueName,
  rulesFor,
  type DroppedParam,
  type RawParams,
  type ViewableRoute,
} from '../domain/saved-views';
import { screenRoutes } from '../domain/screens';
import { visibleRoute } from '../delivered';
import * as audit from './audit';
import type { ActorContext } from './chart-of-accounts';
import { listSource } from './list';

export class SavedViewNotFoundError extends Error {
  readonly code = 'SAVED_VIEW_NOT_FOUND';
  constructor(readonly viewId: string) {
    super('That saved view no longer exists, or is not shared with you.');
    this.name = 'SavedViewNotFoundError';
  }
}

export class SavedViewNotOwnedError extends Error {
  readonly code = 'SAVED_VIEW_NOT_OWNED';
  constructor(readonly viewId: string) {
    // §25 — reason and corrective action, not a bare refusal.
    super(
      'Only the person who created a saved view may change it. Save a copy under your own name instead.',
    );
    this.name = 'SavedViewNotOwnedError';
  }
}

export interface SavedViewRecord {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly ownerUserId: string;
  readonly isShared: boolean;
  readonly isDefault: boolean;
  readonly query: RawListQuery;
}

export interface SaveViewInput {
  readonly listKey: string;
  readonly name: string;
  readonly query: RawListQuery;
  readonly isShared?: boolean;
  readonly isDefault?: boolean;
}

/**
 * Create or replace one of the caller's views.
 *
 * The query is validated before it is stored, so an unusable view cannot be
 * saved and then fail for whoever opens it — including its author, a month
 * later, with no memory of what they set.
 */
export async function save(
  tx: Tx,
  principal: Principal,
  input: SaveViewInput,
): Promise<SavedViewRecord> {
  const source = listSource(input.listKey);
  assertCan(principal, 'view', source.definition.object);
  normaliseQuery(source.definition, principal, input.query);

  if (input.isDefault) await clearDefault(tx, principal, input.listKey);

  const [row] = await tx
    .insert(savedView)
    .values({
      listKey: input.listKey,
      name: input.name.trim(),
      ownerUserId: principal.userId,
      isShared: input.isShared ?? false,
      isDefault: input.isDefault ?? false,
      query: input.query,
    })
    .onConflictDoUpdate({
      target: [savedView.ownerUserId, savedView.listKey, savedView.name],
      // A list view only ever replaces a list view of its own name.
      setWhere: eq(savedView.kind, 'list'),
      set: {
        query: input.query,
        isShared: input.isShared ?? false,
        isDefault: input.isDefault ?? false,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  return toRecord(row!);
}

async function clearDefault(tx: Tx, principal: Principal, listKey: string): Promise<void> {
  // Cleared before the new default is written — the partial unique index allows
  // exactly one, and doing it the other way round collides with itself.
  await tx
    .update(savedView)
    .set({ isDefault: false })
    .where(
      and(
        eq(savedView.kind, 'list'),
        eq(savedView.ownerUserId, principal.userId),
        eq(savedView.listKey, listKey),
        eq(savedView.isDefault, true),
      ),
    );
}

/** The caller's own views for a list, plus the ones others shared. */
export async function listFor(
  tx: Tx,
  principal: Principal,
  listKey: string,
): Promise<readonly SavedViewRecord[]> {
  const rows = await tx
    .select()
    .from(savedView)
    .where(
      and(
        eq(savedView.kind, 'list'),
        eq(savedView.listKey, listKey),
        or(eq(savedView.ownerUserId, principal.userId), eq(savedView.isShared, true)),
      ),
    )
    .orderBy(savedView.name);

  return rows.map(toRecord);
}

/**
 * Resolve a saved view into a query this principal may run.
 *
 * Re-validation here is the control: the author's permissions at save time say
 * nothing about the reader's now.
 */
export async function open(
  tx: Tx,
  principal: Principal,
  viewId: string,
): Promise<{ view: SavedViewRecord; query: ListQuery }> {
  const [row] = await tx
    .select()
    .from(savedView)
    .where(and(eq(savedView.id, viewId), eq(savedView.kind, 'list')))
    .limit(1);
  if (!row) throw new SavedViewNotFoundError(viewId);

  const view = toRecord(row);
  const source = listSource(view.listKey);
  assertCan(principal, 'view', source.definition.object);

  return { view, query: normaliseQuery(source.definition, principal, view.query) };
}

/** The view that opens when the user arrives at a list, if they set one. */
export async function defaultFor(
  tx: Tx,
  principal: Principal,
  listKey: string,
): Promise<SavedViewRecord | null> {
  const [row] = await tx
    .select()
    .from(savedView)
    .where(
      and(
        eq(savedView.kind, 'list'),
        eq(savedView.listKey, listKey),
        eq(savedView.ownerUserId, principal.userId),
        eq(savedView.isDefault, true),
      ),
    )
    .limit(1);

  return row ? toRecord(row) : null;
}

export async function remove(tx: Tx, principal: Principal, viewId: string): Promise<void> {
  const [row] = await tx
    .select()
    .from(savedView)
    .where(and(eq(savedView.id, viewId), eq(savedView.kind, 'list')))
    .limit(1);
  if (!row) throw new SavedViewNotFoundError(viewId);
  if (row.ownerUserId !== principal.userId) throw new SavedViewNotOwnedError(viewId);

  await tx.delete(savedView).where(eq(savedView.id, viewId));
}

function toRecord(row: typeof savedView.$inferSelect): SavedViewRecord {
  return {
    id: row.id,
    listKey: row.listKey,
    name: row.name,
    ownerUserId: row.ownerUserId,
    isShared: row.isShared,
    isDefault: row.isDefault,
    query: row.query as RawListQuery,
  };
}

// ===========================================================================
// Screen views — a screen's filters, one person's own (platform phase, Agent 8)
// ===========================================================================
//
// A view of a screen stores the parameters that screen declares
// (`domain/saved-view-routes.ts`) and nothing about what the screen shows. It
// is *run* by sending the person to the screen with those parameters, so the
// screen's own query decides what appears — under the person's grants and
// branch scope as they are that day. The five places that could go wrong, and
// what holds each:
//
//   1. a view that carries something the screen never asked for — the registry
//      validates on save and on every open (`domain/saved-views.ts`);
//   2. a view read by someone else — owner-only row policy, no sharing
//      (migration 0360; `tests/integration/sv01-saved-views.test.ts`);
//   3. a view of a screen the person can no longer open — shown as unavailable
//      with the reason, never run, never pinned to Home as a live count;
//   4. a count on Home that is a stored answer — there is none: `pinnedFor`
//      asks the screen's own query, as the person, in a savepoint of its own;
//   5. a change nobody can account for — each create, rename, duplicate,
//      delete, default and pin writes an audit event in the same transaction.

/** What a person may keep. The table's trigger holds the same limits. */
export const MAX_ROUTE_VIEWS = 100;
export const MAX_PINNED_VIEWS = 12;

export type ViewErrorCode =
  | 'not_found'
  | 'unknown_route'
  | 'unavailable'
  | 'name_taken'
  | 'limit_views'
  | 'limit_pins';

/** A refusal with a code the screen turns into its own sentence (`savedViews.errors.<code>`). */
export class SavedViewError extends Error {
  constructor(
    readonly code: ViewErrorCode,
    message: string,
    readonly reason?: Unavailable,
  ) {
    super(message);
    this.name = 'SavedViewError';
  }
}

/** Why a screen cannot be opened by this person right now. */
export type Unavailable = 'not_delivered' | 'no_access' | 'unknown_screen';

export interface Availability {
  readonly available: boolean;
  readonly reason: Unavailable | null;
  /** The menu item's key, for the screen's title (`page.<key>`). */
  readonly screenKey: string | null;
}

/**
 * May this person open the screen — by the rule the shell and the page apply.
 *
 * The page asks `can(view, <its object>)` and `visibleRoute`; so does this.
 * Evaluated for the caller's *current* principal on every run, which is what
 * makes a revoked grant take effect on the next page load and not at the next
 * sign-in.
 */
export function availabilityOf(principal: Principal, route: ViewableRoute | undefined): Availability {
  if (!route) return { available: false, reason: 'unknown_screen', screenKey: null };
  const screen = screenRoutes().get(route.route);
  const screenKey = screen?.item.key ?? null;
  if (!visibleRoute(route.route)) return { available: false, reason: 'not_delivered', screenKey };
  const object = route.object ?? screen?.item.object;
  if (!object) return { available: false, reason: 'unknown_screen', screenKey };
  const verb = route.verb ?? screen?.item.verb ?? 'view';
  if (!can(principal, verb, object)) return { available: false, reason: 'no_access', screenKey };
  return { available: true, reason: null, screenKey };
}

export interface RouteViewState {
  readonly id: string;
  readonly routeKey: string;
  readonly name: string;
  readonly isDefault: boolean;
  /** ISO 8601, or null when the view is not on Home. */
  readonly pinnedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The screen's path, or null for a screen the registry no longer knows. */
  readonly route: string | null;
  readonly screenKey: string | null;
  readonly available: boolean;
  readonly unavailable: Unavailable | null;
  /** The parameters the screen opens with today — rules already dates. */
  readonly params: Readonly<Record<string, string>>;
  /** Slot id → rule name, for the summary. */
  readonly rules: Readonly<Record<string, string>>;
  /** What the screen no longer accepts; left out of `params`. */
  readonly dropped: readonly DroppedParam[];
  /** The address to open, or null when the screen is unavailable. */
  readonly href: string | null;
}

type ViewRow = typeof savedView.$inferSelect;

function stateOf(row: ViewRow, principal: Principal, today: string): RouteViewState {
  const route = viewableRoute(row.listKey);
  const access = availabilityOf(principal, route);
  const resolved = route
    ? resolveStored(route, row.query, today)
    : { params: {}, rules: {}, dropped: [] as DroppedParam[] };
  return {
    id: row.id,
    routeKey: row.listKey,
    name: row.name,
    isDefault: row.isDefault,
    pinnedAt: row.pinnedAt ? row.pinnedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    route: route?.route ?? null,
    screenKey: access.screenKey,
    available: access.available,
    unavailable: access.reason,
    params: resolved.params,
    rules: resolved.rules,
    dropped: resolved.dropped,
    href: route && access.available ? hrefOf(route, resolved.params) : null,
  };
}

const routeViews = (principal: Principal) =>
  and(eq(savedView.kind, 'route'), eq(savedView.ownerUserId, principal.userId));

/** The caller's screen views — all of them, or one screen's — each run against today's permissions. */
export async function listRouteViews(
  tx: Tx,
  principal: Principal,
  options: { readonly routeKey?: string; readonly today?: string } = {},
): Promise<readonly RouteViewState[]> {
  const rows = await tx
    .select()
    .from(savedView)
    .where(
      options.routeKey
        ? and(routeViews(principal), eq(savedView.listKey, options.routeKey))
        : routeViews(principal),
    )
    .orderBy(asc(savedView.listKey), asc(savedView.name));
  const today = options.today ?? businessToday();
  return rows.map((row) => stateOf(row, principal, today));
}

async function ownRow(tx: Tx, principal: Principal, id: string, lock = false): Promise<ViewRow> {
  const query = tx
    .select()
    .from(savedView)
    .where(and(routeViews(principal), eq(savedView.id, id)))
    .limit(1);
  // A transition reads its row FOR UPDATE, so a double submit changes it once.
  const [row] = await (lock ? query.for('update') : query);
  if (!row) throw new SavedViewError('not_found', 'That view does not exist, or it is not yours.');
  return row;
}

function unavailableError(reason: Unavailable | null): SavedViewError {
  return new SavedViewError(
    'unavailable',
    reason === 'no_access'
      ? 'You can no longer open this screen, so the view cannot be used.'
      : 'This screen is not available, so the view cannot be used.',
    reason ?? 'unknown_screen',
  );
}

async function namesTaken(tx: Tx, principal: Principal, routeKey: string): Promise<Set<string>> {
  const rows = await tx
    .select({ name: savedView.name })
    .from(savedView)
    .where(and(routeViews(principal), eq(savedView.listKey, routeKey)));
  return new Set(rows.map((row) => row.name));
}

async function assertRoom(tx: Tx, principal: Principal): Promise<void> {
  const [{ total } = { total: 0 }] = await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(savedView)
    .where(routeViews(principal));
  if (total >= MAX_ROUTE_VIEWS) {
    throw new SavedViewError('limit_views', `At most ${MAX_ROUTE_VIEWS} views can be kept; delete one first.`);
  }
}

async function note(
  tx: Tx,
  ctx: ActorContext,
  action: string,
  view: { readonly id: string },
  detail: { before?: unknown; after?: unknown; related?: string | null } = {},
): Promise<void> {
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: `saved_view.${action}`,
    objectType: 'saved_view',
    objectId: view.id,
    branchCode: ctx.branchCode,
    before: detail.before,
    after: detail.after,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
    relatedObjectId: detail.related ?? null,
  });
}

const snapshot = (row: ViewRow) => ({
  screen: row.listKey,
  name: row.name,
  isDefault: row.isDefault,
  pinned: row.pinnedAt !== null,
  query: row.query,
});

export interface CreateRouteViewInput {
  readonly routeKey: string;
  readonly name: string;
  /** The screen's parameters as the address carries them; only the declared, valid ones are kept. */
  readonly params: RawParams;
  /** Slot id → date rule chosen by the person; absent or `keep` stores the dates as shown. */
  readonly rules?: Readonly<Record<string, string>>;
}

/**
 * Keep the screen as it is now under a name.
 *
 * The person must be able to open the screen *now* — a view of a screen they
 * cannot open would be a way to name it. What is stored is the declared,
 * well-formed parameters and the chosen date rules, nothing else.
 */
export async function createRouteView(
  tx: Tx,
  ctx: ActorContext,
  input: CreateRouteViewInput,
): Promise<RouteViewState> {
  const route = viewableRoute(input.routeKey);
  if (!route) throw new SavedViewError('unknown_route', `'${input.routeKey}' is not a screen that can be saved.`);
  const access = availabilityOf(ctx.principal, route);
  if (!access.available) throw unavailableError(access.reason);

  const name = normaliseName(input.name);
  const { stored } = storedFrom(route, input.params, input.rules ?? {});
  await assertRoom(tx, ctx.principal);
  if ((await namesTaken(tx, ctx.principal, route.key)).has(name)) {
    throw new SavedViewError('name_taken', `You already have a view named “${name}” on this screen.`);
  }

  const [row] = await tx
    .insert(savedView)
    .values({
      kind: 'route',
      listKey: route.key,
      name,
      ownerUserId: ctx.principal.userId,
      isShared: false,
      isDefault: false,
      query: stored,
    })
    .returning();
  await note(tx, ctx, 'created', row!, { after: snapshot(row!) });
  return stateOf(row!, ctx.principal, businessToday());
}

export async function renameRouteView(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  newName: string,
): Promise<RouteViewState> {
  const row = await ownRow(tx, ctx.principal, id, true);
  const name = normaliseName(newName);
  if (name !== row.name) {
    if ((await namesTaken(tx, ctx.principal, row.listKey)).has(name)) {
      throw new SavedViewError('name_taken', `You already have a view named “${name}” on this screen.`);
    }
    const [renamed] = await tx
      .update(savedView)
      .set({ name, updatedAt: sql`now()` })
      .where(eq(savedView.id, row.id))
      .returning();
    await note(tx, ctx, 'renamed', row, { before: { name: row.name }, after: { name } });
    return stateOf(renamed!, ctx.principal, businessToday());
  }
  return stateOf(row, ctx.principal, businessToday());
}

/**
 * A copy under a new name — not the default, not pinned. The copy is a new
 * view of a screen the person can open now, so it is held to that.
 */
export async function duplicateRouteView(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  wantedName?: string,
): Promise<RouteViewState> {
  const source = await ownRow(tx, ctx.principal, id);
  const access = availabilityOf(ctx.principal, viewableRoute(source.listKey));
  if (!access.available) throw unavailableError(access.reason);
  await assertRoom(tx, ctx.principal);

  const name = uniqueName(await namesTaken(tx, ctx.principal, source.listKey), wantedName?.trim() || source.name);
  const [copy] = await tx
    .insert(savedView)
    .values({
      kind: 'route',
      listKey: source.listKey,
      name,
      ownerUserId: ctx.principal.userId,
      isShared: false,
      isDefault: false,
      query: source.query,
    })
    .returning();
  await note(tx, ctx, 'duplicated', copy!, { after: snapshot(copy!), related: source.id });
  return stateOf(copy!, ctx.principal, businessToday());
}

/** Delete a view — whatever screen it is of, available or not. The audit event keeps what it was. */
export async function deleteRouteView(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const row = await ownRow(tx, ctx.principal, id, true);
  await tx.delete(savedView).where(eq(savedView.id, row.id));
  await note(tx, ctx, 'deleted', row, { before: snapshot(row) });
}

/**
 * Make a view the one a bare arrival at its screen opens, or stop it being.
 * One default per screen: setting one clears the previous (and says so).
 */
export async function setDefaultRouteView(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  on: boolean,
): Promise<RouteViewState> {
  const row = await ownRow(tx, ctx.principal, id, true);
  if (row.isDefault === on) return stateOf(row, ctx.principal, businessToday());

  if (on) {
    const access = availabilityOf(ctx.principal, viewableRoute(row.listKey));
    if (!access.available) throw unavailableError(access.reason);
    // Cleared before the new default is written: the partial unique index allows exactly one.
    const displaced = await tx
      .update(savedView)
      .set({ isDefault: false, updatedAt: sql`now()` })
      .where(
        and(routeViews(ctx.principal), eq(savedView.listKey, row.listKey), eq(savedView.isDefault, true), ne(savedView.id, row.id)),
      )
      .returning();
    for (const old of displaced) await note(tx, ctx, 'default_cleared', old, { before: snapshot(old), related: row.id });
  }
  const [updated] = await tx
    .update(savedView)
    .set({ isDefault: on, updatedAt: sql`now()` })
    .where(eq(savedView.id, row.id))
    .returning();
  await note(tx, ctx, on ? 'default_set' : 'default_cleared', row, { before: { isDefault: !on }, after: { isDefault: on } });
  return stateOf(updated!, ctx.principal, businessToday());
}

/** Pin a view to Home or take it off. Pinning needs a screen the person can open; unpinning never does. */
export async function pinRouteView(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  on: boolean,
): Promise<RouteViewState> {
  const row = await ownRow(tx, ctx.principal, id, true);
  if ((row.pinnedAt !== null) === on) return stateOf(row, ctx.principal, businessToday());

  if (on) {
    const access = availabilityOf(ctx.principal, viewableRoute(row.listKey));
    if (!access.available) throw unavailableError(access.reason);
    const [{ pinned } = { pinned: 0 }] = await tx
      .select({ pinned: sql<number>`count(*)::int` })
      .from(savedView)
      .where(and(routeViews(ctx.principal), sql`${savedView.pinnedAt} is not null`));
    if (pinned >= MAX_PINNED_VIEWS) {
      throw new SavedViewError('limit_pins', `At most ${MAX_PINNED_VIEWS} views can be pinned to Home; unpin one first.`);
    }
  }
  const [updated] = await tx
    .update(savedView)
    .set({ pinnedAt: on ? sql`now()` : null, updatedAt: sql`now()` })
    .where(eq(savedView.id, row.id))
    .returning();
  await note(tx, ctx, on ? 'pinned' : 'unpinned', row, {
    before: { pinned: !on },
    after: { pinned: on, ...(on ? { pinnedAt: updated!.pinnedAt?.toISOString() ?? null } : {}) },
  });
  return stateOf(updated!, ctx.principal, businessToday());
}

// ---------------------------------------------------------------------------
// What a list screen asks when it renders
// ---------------------------------------------------------------------------

export interface SlotChoice {
  readonly id: string;
  readonly kind: 'range' | 'point';
  readonly rules: readonly string[];
}

/** Everything a screen's Views menu draws, and — for a bare arrival — where to go instead. */
export interface SavedViewsState {
  readonly routeKey: string;
  readonly route: string;
  /** The caller's views of this screen, in name order. */
  readonly views: readonly (RouteViewState & { readonly active: boolean })[];
  /** What the screen is showing now, as a view would keep it. */
  readonly current: {
    readonly params: Readonly<Record<string, string>>;
    readonly query: string;
    /** The path and query to come back to after an action. */
    readonly returnTo: string;
  };
  readonly activeId: string | null;
  readonly slots: readonly SlotChoice[];
  readonly used: number;
  /** Where a bare arrival should go instead — the owner's default view — or null. */
  readonly redirectTo: string | null;
}

/**
 * The state of the Views menu for one screen, for the person looking at it.
 *
 * Null when the screen is not registered or the person cannot open it (the
 * page has refused them already; there is nothing to offer). Reads only the
 * caller's own rows.
 */
export async function stateFor(
  tx: Tx,
  principal: Principal,
  routeKey: string,
  raw: RawParams,
  today: string = businessToday(),
): Promise<SavedViewsState | null> {
  const route = viewableRoute(routeKey);
  if (!route || !availabilityOf(principal, route).available) return null;

  const views = await listRouteViews(tx, principal, { routeKey, today });
  const current = sanitiseParams(route, raw);
  const active = views.find((view) => sameParams(route, view.params, current.params)) ?? null;
  const chosen = chooseDefault(views);
  const query = queryOf(route, current.params);

  return {
    routeKey,
    route: route.route,
    views: views.map((view) => ({ ...view, active: view.id === active?.id })),
    current: {
      params: current.params,
      query,
      returnTo: query ? `${route.route}?${query}` : route.route,
    },
    activeId: active?.id ?? null,
    slots: (route.slots ?? []).map((slot) => ({ id: slot.id, kind: slot.kind, rules: rulesFor(slot) })),
    used: views.length,
    redirectTo: defaultRedirect(route, raw, chosen),
  };
}

// ---------------------------------------------------------------------------
// Pinned to Home
// ---------------------------------------------------------------------------

export interface PinnedView {
  readonly id: string;
  /** The view's name. */
  readonly title: string;
  readonly routeKey: string;
  readonly route: string | null;
  /** The menu item's key: the screen's own title is `page.<screenKey>`. */
  readonly screenKey: string | null;
  readonly params: Readonly<Record<string, string>>;
  /** Where the tile goes; null when the person can no longer open the screen. */
  readonly href: string | null;
  readonly available: boolean;
  readonly unavailable: Unavailable | null;
  /**
   * How many rows the screen itself would list for this view, for the person
   * asking — or null: no count is registered for the screen, the screen is
   * unavailable, or the count could not be read. Never a stored number.
   */
  readonly count: number | null;
  readonly dropped: readonly DroppedParam[];
  readonly pinnedAt: string;
}

export interface PinnedForOptions {
  /** The business day relative dates are evaluated on. Default `businessToday()`. */
  readonly today?: string;
  /** The branch the caller is working in (the scope the screen's query runs under). */
  readonly branchCode?: string;
  /** `false` for links only. Default true. */
  readonly counts?: boolean;
}

/**
 * The views a person pinned to Home, resolved for the Dashboard.
 *
 * Each is run *again*, as the asker and now: the screen's availability is
 * checked against the principal passed in, the parameters are re-validated,
 * relative dates are evaluated for today, and the count — where the screen has
 * a cheap one (`services/saved-view-counts.ts`) — is the screen's own query in
 * the caller's transaction, so row security and branch scope apply. A count that
 * fails (or a screen that is no longer available) yields `count: null`, not a
 * stale number and not an error for the page that asked.
 *
 * Oldest pin first. The caller's transaction must carry the asker's scope
 * (`withCurrentUser` does); this reads and counts as whoever that is.
 */
export async function pinnedFor(
  tx: Tx,
  principal: Principal,
  options: PinnedForOptions = {},
): Promise<readonly PinnedView[]> {
  const today = options.today ?? businessToday();
  const rows = await tx
    .select()
    .from(savedView)
    .where(and(routeViews(principal), sql`${savedView.pinnedAt} is not null`))
    .orderBy(asc(savedView.pinnedAt), asc(savedView.name));

  const counters = options.counts === false ? null : await import('./saved-view-counts');
  const branchCode = options.branchCode ?? principal.defaultBranchCode ?? '';
  const pinned: PinnedView[] = [];
  for (const row of rows) {
    const state = stateOf(row, principal, today);
    let count: number | null = null;
    const counter = counters?.counterFor(row.listKey);
    if (counter && state.available) {
      // A savepoint of its own: a screen query that fails cannot take the Home page with it.
      await tx.execute(sql`savepoint saved_view_count`);
      try {
        count = await counter(tx, { principal, branchCode }, state.params, today);
        await tx.execute(sql`release savepoint saved_view_count`);
      } catch {
        await tx.execute(sql`rollback to savepoint saved_view_count`);
        count = null;
      }
    }
    pinned.push({
      id: state.id,
      title: state.name,
      routeKey: state.routeKey,
      route: state.route,
      screenKey: state.screenKey,
      params: state.params,
      href: state.href,
      available: state.available,
      unavailable: state.unavailable,
      count,
      dropped: state.dropped,
      pinnedAt: state.pinnedAt!,
    });
  }
  return pinned;
}

export { SavedViewInputError };
