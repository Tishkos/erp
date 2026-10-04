/**
 * Saved views of screens, and pinning them to Home (platform phase, Agent 8) —
 * against a real database, as the people who would use them.
 *
 *   • a view keeps a screen's declared filters and nothing else; every change
 *     (save, rename, duplicate, delete, default, pin) is audited in the same
 *     transaction, and a refused one leaves neither a row nor an event
 *   • relative dates are stored as rules and worked out on the day they are
 *     opened
 *   • a view is its owner's alone: not read, changed or deleted by anyone else,
 *     a super user included — and the database, not only the service, refuses
 *     sharing, a foreign shape, a moved owner and a hundred-and-first view
 *   • every run applies the person's grants *now*: a revoked grant shows the
 *     view as unavailable (not hidden), offers no menu, no default and no
 *     count; a branch change empties the count without a stored number
 *   • `pinnedFor` is what Home reads: title, route, params and the screen's own
 *     count, oldest pin first
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asApp, ownerPool, resetTestData, seedBranch } from './setup';
import { withScope, type Tx } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as sv from '@/server/services/saved-views';
import type { ActorContext } from '@/server/services/administration';
import type { Principal } from '@/server/domain/permissions';
import { SavedViewInputError } from '@domain/saved-views';
import { VIEWABLE_ROUTES } from '@domain/saved-view-routes';

const BGW = 'BGW';
const EBL = 'EBL';
const MSL = 'MSL';

interface Actor {
  readonly principal: Principal;
  readonly scope: { userId: string; branchCode: string; isSuperUser: boolean };
  readonly role: string;
}

/** What a purchasing clerk can open: the screens a saved view may point at. */
const OBJECTS = [
  'ap_invoice',
  'ar_invoice',
  'customer_receipt',
  'business_partner',
  'shipment_container',
  'bill_of_lading',
  'customs_pd',
  'customs_declaration',
  'in_transit',
  'inventory_movement',
  'stock_movement',
  'exception',
];

let admin: Actor;
let buyer: Actor;
let other: Actor;
let clerk: Actor;
let capped: Actor;

const ids: Record<string, string> = {};

async function makeActor(
  name: string,
  options: { branches: readonly string[]; objects: readonly string[]; superUser?: boolean },
): Promise<Actor> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [
    id,
    `${name}-${id}@example.com`,
    name,
    options.superUser ?? false,
  ]);
  const role = `sv_${name}`;
  if (options.objects.length > 0) {
    await ownerPool.query(`insert into role (code, name) values ($1,$2)`, [role, `Saved views test ${name}`]);
    for (const object of options.objects) {
      await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,$2,'view')`, [role, object]);
    }
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  for (const branch of options.branches) {
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  }
  const branchCode = options.branches[0] ?? '';
  const isSuperUser = options.superUser ?? false;
  const principal = await withScope({ userId: id, branchCode, isSuperUser }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, scope: { userId: id, branchCode, isSuperUser }, role };
}

/** Run as the person: their scope, their principal as it is loaded now. */
const as = <T>(actor: Actor, fn: (tx: Tx, ctx: ActorContext) => Promise<T>, scope = actor.scope, principal = actor.principal) =>
  withScope(scope, (tx) => fn(tx, { principal, branchCode: scope.branchCode }));

const reload = (actor: Actor, scope = actor.scope) =>
  withScope(scope, (tx) => authz.loadPrincipal(tx, actor.scope.userId));

async function audits(objectId: string) {
  const { rows } = await ownerPool.query(
    `select action, actor_user_id, before_value, after_value, related_object_id, outcome
       from audit_event where object_type = 'saved_view' and object_id = $1 order by id`,
    [objectId],
  );
  return rows as {
    action: string;
    actor_user_id: string;
    before_value: Record<string, unknown> | null;
    after_value: Record<string, unknown> | null;
    related_object_id: string | null;
    outcome: string;
  }[];
}

async function rowOf(id: string) {
  const { rows } = await ownerPool.query(`select * from saved_view where id = $1`, [id]);
  return rows[0] as
    | {
        kind: string;
        list_key: string;
        name: string;
        owner_user_id: string;
        is_shared: boolean;
        is_default: boolean;
        pinned_at: Date | null;
        query: { v: number; params: Record<string, string>; dates?: Record<string, string> };
      }
    | undefined;
}

const countRows = async (owner: string) =>
  Number((await ownerPool.query(`select count(*) from saved_view where kind='route' and owner_user_id=$1`, [owner])).rows[0].count);

async function one(query: string, values: unknown[]): Promise<string> {
  const { rows } = await ownerPool.query(query, values);
  return rows[0].id as string;
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BGW, 'Baghdad');
  await seedBranch(EBL, 'Erbil');
  await seedBranch(MSL, 'Mosul');

  admin = await makeActor('admin', { branches: [], objects: [], superUser: true });
  buyer = await makeActor('buyer', { branches: [BGW], objects: OBJECTS });
  other = await makeActor('other', { branches: [BGW], objects: OBJECTS });
  clerk = await makeActor('clerk', { branches: [BGW], objects: ['ap_invoice'] });
  capped = await makeActor('capped', { branches: [BGW], objects: OBJECTS });

  // Purchase invoices: two in Baghdad (one overdue, one not yet due), one in Erbil.
  ids.supplier = await one(
    `insert into business_partner (code, legal_name, is_supplier) values ('SUP-SV0001','Saved Views Supplier', true) returning id`,
    [],
  );
  const by = admin.principal.userId;
  const invoice = (no: string, branch: string, due: string, total: number) =>
    ownerPool.query(
      `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
       values ($1,$2,$3,$4,'2026-08-01',$5,$6,$7,true)`,
      [no, `SV-${no}`, ids.supplier, branch, due, total, by],
    );
  await invoice('API-BGW-2026-960001', BGW, '2026-09-01', 1250000);
  await invoice('API-BGW-2026-960002', BGW, '2099-01-01', 90000);
  await invoice('API-EBL-2026-960003', EBL, '2026-09-02', 480000);
});

afterAll(async () => {
  await resetTestData();
});

describe('saving a view', () => {
  it('keeps the declared, well-formed filters and nothing else — and audits it', async () => {
    const view = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, {
        routeKey: 'payables.invoices',
        name: 'Overdue and large',
        params: { q: ' acme ', view: 'overdue', min_amount: '1250000', bogus: '1', page: '3', sv: 'none', saved: '1' },
      }),
    );
    ids.overdue = view.id;
    expect(view.params).toEqual({ q: 'acme', view: 'overdue', min_amount: '1250000' });
    expect(view.href).toBe('/payables/invoices?q=acme&view=overdue&min_amount=1250000');
    expect(view.available).toBe(true);

    const row = (await rowOf(view.id))!;
    expect(row).toMatchObject({ kind: 'route', list_key: 'payables.invoices', name: 'Overdue and large', is_shared: false, is_default: false });
    expect(row.owner_user_id).toBe(buyer.scope.userId);
    expect(row.pinned_at).toBeNull();
    // The stored configuration is the question, not the answer.
    expect(row.query).toEqual({ v: 1, params: { q: 'acme', view: 'overdue', min_amount: '1250000' } });

    const events = await audits(view.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'saved_view.created', actor_user_id: buyer.scope.userId, outcome: 'success' });
    expect(events[0]!.after_value).toMatchObject({ screen: 'payables.invoices', name: 'Overdue and large', pinned: false });
  });

  it('drops a value the screen would not accept, and says nothing is stored for it', async () => {
    const view = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, {
        routeKey: 'payables.invoices',
        name: 'Garbage in',
        params: { q: 'x', view: 'nonsense', min_amount: '12abc' },
      }),
    );
    expect((await rowOf(view.id))!.query.params).toEqual({ q: 'x' });
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, view.id));
  });

  it('refuses a name that is empty, too long, not one line, or already used on the screen — leaving no row and no event', async () => {
    const events = async () =>
      Number((await ownerPool.query(`select count(*) from audit_event where object_type='saved_view' and actor_user_id=$1`, [buyer.scope.userId])).rows[0].count);
    const before = { rows: await countRows(buyer.scope.userId), events: await events() };
    const create = (name: string, routeKey = 'payables.invoices') =>
      as(buyer, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey, name, params: { q: 'z' } }));

    await expect(create('   ')).rejects.toMatchObject({ reason: 'name_required' });
    await expect(create('x'.repeat(81))).rejects.toMatchObject({ reason: 'name_too_long' });
    await expect(create('bell\u0007name')).rejects.toMatchObject({ reason: 'name_invalid' });
    await expect(create('a\u202Eb')).rejects.toMatchObject({ reason: 'name_invalid' });
    await expect(create('Overdue and large')).rejects.toMatchObject({ code: 'name_taken' });
    expect({ rows: await countRows(buyer.scope.userId), events: await events() }).toEqual(before);

    // The same name on another screen is fine; whitespace is tidied, not refused.
    const elsewhere = await create('  Overdue   and large ', 'sales.invoices');
    expect(elsewhere).toMatchObject({ routeKey: 'sales.invoices', name: 'Overdue and large' });
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, elsewhere.id));
  });

  it('refuses a screen that is not in the registry', async () => {
    await expect(
      as(buyer, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey: 'made.up', name: 'Nope', params: {} })),
    ).rejects.toMatchObject({ code: 'unknown_route' });
  });
});

describe('relative dates are rules, worked out on the day', () => {
  it('stores the rule, not the dates, and evaluates it for the day it is opened', async () => {
    const view = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, {
        routeKey: 'imports.containers',
        name: 'Arriving this month',
        params: { view: 'in_transit', eta_from: '2026-01-01', eta_to: '2026-01-31' },
        rules: { eta: 'this_month' },
      }),
    );
    ids.arriving = view.id;
    expect((await rowOf(view.id))!.query).toEqual({ v: 1, params: { view: 'in_transit' }, dates: { eta: 'this_month' } });

    const on = async (today: string) =>
      (await as(buyer, (tx, ctx) => sv.listRouteViews(tx, ctx.principal, { routeKey: 'imports.containers', today }))).find(
        (found) => found.id === view.id,
      )!;
    expect((await on('2026-02-15')).params).toEqual({ view: 'in_transit', eta_from: '2026-02-01', eta_to: '2026-02-28' });
    expect((await on('2028-02-10')).params).toMatchObject({ eta_from: '2028-02-01', eta_to: '2028-02-29' });
    expect((await on('2026-12-31')).params).toMatchObject({ eta_from: '2026-12-01', eta_to: '2026-12-31' });
    expect((await on('2026-03-05')).href).toBe('/payables/containers?view=in_transit&eta_from=2026-03-01&eta_to=2026-03-31');
    expect((await on('2026-03-05')).rules).toEqual({ eta: 'this_month' });
  });

  it('a point slot ("as at") keeps its rule too', async () => {
    const view = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, {
        routeKey: 'payables.open_items',
        name: 'Overdue suppliers, to month end',
        params: { show: 'overdue', as_at: '2026-01-10' },
        rules: { as_at: 'month_end' },
      }),
    );
    const found = (await as(buyer, (tx, ctx) => sv.listRouteViews(tx, ctx.principal, { routeKey: 'payables.open_items', today: '2026-04-09' }))).find(
      (candidate) => candidate.id === view.id,
    )!;
    expect(found.params).toEqual({ show: 'overdue', as_at: '2026-04-30' });
  });

  it('refuses a rule the screen does not offer, and keeps dates "as shown" when none is chosen', async () => {
    await expect(
      as(buyer, (tx, ctx) =>
        sv.createRouteView(tx, ctx, { routeKey: 'imports.containers', name: 'Bad rule', params: {}, rules: { eta: 'next_century' } }),
      ),
    ).rejects.toMatchObject({ reason: 'unknown_rule' });

    const literal = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, {
        routeKey: 'imports.containers',
        name: 'Fixed window',
        params: { eta_from: '2026-05-01', eta_to: '2026-05-31' },
      }),
    );
    expect((await rowOf(literal.id))!.query).toEqual({ v: 1, params: { eta_from: '2026-05-01', eta_to: '2026-05-31' } });
  });
});

describe('rename, duplicate, default, pin, delete', () => {
  it('renames, audits the old and new name, and refuses a name already used', async () => {
    const renamed = await as(buyer, (tx, ctx) => sv.renameRouteView(tx, ctx, ids.overdue!, '  Large overdue  '));
    expect(renamed.name).toBe('Large overdue');
    const events = (await audits(ids.overdue!)).filter((event) => event.action === 'saved_view.renamed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ before_value: { name: 'Overdue and large' }, after_value: { name: 'Large overdue' } });

    // The same name again changes nothing and writes no event.
    await as(buyer, (tx, ctx) => sv.renameRouteView(tx, ctx, ids.overdue!, 'Large overdue'));
    expect((await audits(ids.overdue!)).filter((event) => event.action === 'saved_view.renamed')).toHaveLength(1);

    const second = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, { routeKey: 'payables.invoices', name: 'Unpaid', params: { view: 'unpaid' } }),
    );
    ids.unpaid = second.id;
    await expect(as(buyer, (tx, ctx) => sv.renameRouteView(tx, ctx, second.id, 'Large overdue'))).rejects.toMatchObject({
      code: 'name_taken',
    });
    expect((await rowOf(second.id))!.name).toBe('Unpaid');
  });

  it('duplicates under a fresh name — not the default, not pinned — and links the audit to the source', async () => {
    const copy = await as(buyer, (tx, ctx) => sv.duplicateRouteView(tx, ctx, ids.overdue!));
    expect(copy.id).not.toBe(ids.overdue);
    expect(copy.name).toBe('Large overdue (2)');
    expect(copy).toMatchObject({ isDefault: false, pinnedAt: null, params: { q: 'acme', view: 'overdue', min_amount: '1250000' } });
    const events = await audits(copy.id);
    expect(events[0]).toMatchObject({ action: 'saved_view.duplicated', related_object_id: ids.overdue });

    const named = await as(buyer, (tx, ctx) => sv.duplicateRouteView(tx, ctx, ids.overdue!, 'Large overdue (copy)'));
    expect(named.name).toBe('Large overdue (copy)');
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, copy.id));
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, named.id));
  });

  it('makes one default per screen; setting another clears the first, and both changes are audited', async () => {
    await as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, ids.overdue!, true));
    expect((await rowOf(ids.overdue!))!.is_default).toBe(true);
    await as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, ids.unpaid!, true));
    expect((await rowOf(ids.overdue!))!.is_default).toBe(false);
    expect((await rowOf(ids.unpaid!))!.is_default).toBe(true);

    expect((await audits(ids.overdue!)).map((event) => event.action)).toEqual([
      'saved_view.created',
      'saved_view.renamed',
      'saved_view.default_set',
      'saved_view.default_cleared',
    ]);
    expect((await audits(ids.unpaid!)).map((event) => event.action)).toEqual(['saved_view.created', 'saved_view.default_set']);

    // Another screen's default is its own.
    const containers = await as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, ids.arriving!, true));
    expect(containers.isDefault).toBe(true);
    expect((await rowOf(ids.unpaid!))!.is_default).toBe(true);

    // Clearing, twice: one event.
    await as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, ids.arriving!, false));
    await as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, ids.arriving!, false));
    expect((await audits(ids.arriving!)).filter((event) => event.action === 'saved_view.default_cleared')).toHaveLength(1);
  });

  it('pins and unpins — each once, however many times the button is pressed', async () => {
    const pinned = await as(buyer, (tx, ctx) => sv.pinRouteView(tx, ctx, ids.overdue!, true));
    expect(pinned.pinnedAt).toEqual(expect.any(String));
    expect(new Date(pinned.pinnedAt!).toISOString()).toBe(pinned.pinnedAt);

    // A double submit: both finish, one event.
    await Promise.all([
      as(buyer, (tx, ctx) => sv.pinRouteView(tx, ctx, ids.unpaid!, true)),
      as(buyer, (tx, ctx) => sv.pinRouteView(tx, ctx, ids.unpaid!, true)),
    ]);
    expect((await audits(ids.unpaid!)).filter((event) => event.action === 'saved_view.pinned')).toHaveLength(1);
    const events = (await audits(ids.unpaid!)).filter((event) => event.action === 'saved_view.pinned');
    expect(typeof events[0]!.after_value!['pinnedAt']).toBe('string');

    await as(buyer, (tx, ctx) => sv.pinRouteView(tx, ctx, ids.unpaid!, false));
    expect((await rowOf(ids.unpaid!))!.pinned_at).toBeNull();
    expect((await audits(ids.unpaid!)).map((event) => event.action).slice(-1)).toEqual(['saved_view.unpinned']);
  });

  it('keeps at most one default after a race between two views', async () => {
    const a = await as(buyer, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey: 'sales.invoices', name: 'A', params: { q: 'a' } }));
    const b = await as(buyer, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey: 'sales.invoices', name: 'B', params: { q: 'b' } }));
    const settled = await Promise.allSettled([
      as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, a.id, true)),
      as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, b.id, true)),
    ]);
    expect(settled.some((result) => result.status === 'fulfilled')).toBe(true);
    const defaults = Number(
      (await ownerPool.query(`select count(*) from saved_view where owner_user_id=$1 and list_key='sales.invoices' and is_default`, [buyer.scope.userId]))
        .rows[0].count,
    );
    expect(defaults).toBe(1);
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, a.id));
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, b.id));
  });

  it('deletes a view, and the audit event keeps what it was', async () => {
    const doomed = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, { routeKey: 'sales.receipts', name: 'Doomed', params: { q: 'gone' } }),
    );
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, doomed.id));
    expect(await rowOf(doomed.id)).toBeUndefined();
    const events = await audits(doomed.id);
    expect(events.map((event) => event.action)).toEqual(['saved_view.created', 'saved_view.deleted']);
    expect(events[1]!.before_value).toMatchObject({ name: 'Doomed', screen: 'sales.receipts', query: { v: 1, params: { q: 'gone' } } });
    await expect(as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, doomed.id))).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a view is its owner’s alone', () => {
  it('is invisible to every other person — a super user included — and cannot be changed by them', async () => {
    for (const who of [other, admin]) {
      expect(await as(who, (tx, ctx) => sv.listRouteViews(tx, ctx.principal))).toEqual([]);
      // Nor through the table itself, as the application role reads it.
      const seen = await asApp(who.scope, (query) =>
        query(`select count(*)::int as n from saved_view where kind = 'route'`),
      );
      expect(seen.rows[0].n).toBe(0);

      const acts: ((tx: Tx, ctx: ActorContext) => Promise<unknown>)[] = [
        (tx, ctx) => sv.renameRouteView(tx, ctx, ids.overdue!, 'Mine now'),
        (tx, ctx) => sv.duplicateRouteView(tx, ctx, ids.overdue!),
        (tx, ctx) => sv.deleteRouteView(tx, ctx, ids.overdue!),
        (tx, ctx) => sv.setDefaultRouteView(tx, ctx, ids.overdue!, true),
        (tx, ctx) => sv.pinRouteView(tx, ctx, ids.overdue!, true),
      ];
      for (const act of acts) {
        await expect(as(who, act)).rejects.toMatchObject({ code: 'not_found' });
      }
    }
    expect((await rowOf(ids.overdue!))!.name).toBe('Large overdue');
    expect(await as(other, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { branchCode: BGW }))).toEqual([]);
  });

  it('may hold the same name as someone else', async () => {
    const mine = await as(other, (tx, ctx) =>
      sv.createRouteView(tx, ctx, { routeKey: 'payables.invoices', name: 'Large overdue', params: { view: 'overdue' } }),
    );
    expect(mine.name).toBe('Large overdue');
    expect(await as(buyer, (tx, ctx) => sv.listRouteViews(tx, ctx.principal, { routeKey: 'payables.invoices' }))).not.toContainEqual(
      expect.objectContaining({ id: mine.id }),
    );
    await as(other, (tx, ctx) => sv.deleteRouteView(tx, ctx, mine.id));
  });
});

describe('the database holds the line, not only the service', () => {
  it('refuses sharing a screen view', async () => {
    await expect(ownerPool.query(`update saved_view set is_shared = true where id = $1`, [ids.overdue])).rejects.toThrow(
      /saved_view_route_private/,
    );
    await expect(
      ownerPool.query(
        `insert into saved_view (list_key, name, owner_user_id, kind, is_shared, query) values ('payables.invoices','Shared',$1,'route',true,'{"v":1,"params":{}}')`,
        [buyer.scope.userId],
      ),
    ).rejects.toThrow(/saved_view_route_private/);
  });

  it('refuses a key that is not a screen key, a foreign shape, a long name and an oversized configuration', async () => {
    const insert = (key: string, name: string, query: string) =>
      ownerPool.query(
        `insert into saved_view (list_key, name, owner_user_id, kind, query) values ($1,$2,$3,'route',$4::jsonb)`,
        [key, name, buyer.scope.userId, query],
      );
    await expect(insert('nodot', 'N', '{"v":1,"params":{}}')).rejects.toThrow(/saved_view_route_keyed/);
    await expect(insert('a.b', 'N', '[]')).rejects.toThrow(/saved_view_route_config/);
    await expect(insert('a.b', 'N', '{"v":2,"params":{}}')).rejects.toThrow(/saved_view_route_config/);
    await expect(insert('a.b', 'N', '{"v":1}')).rejects.toThrow(/saved_view_route_config/);
    await expect(insert('a.b', 'N', JSON.stringify({ v: 1, params: { big: 'x'.repeat(5000) } }))).rejects.toThrow(/saved_view_route_config/);
    await expect(insert('a.b', 'x'.repeat(81), '{"v":1,"params":{}}')).rejects.toThrow(/saved_view_route_name/);
  });

  it('does not let a view change hands, change screen or change kind', async () => {
    for (const set of [`owner_user_id = '${other.scope.userId}'`, `list_key = 'sales.invoices'`, `kind = 'list'`]) {
      await expect(ownerPool.query(`update saved_view set ${set} where id = $1`, [ids.overdue])).rejects.toThrow(
        /keeps its owner and its screen|saved_view_/,
      );
    }
    expect((await rowOf(ids.overdue!))).toMatchObject({ owner_user_id: buyer.scope.userId, list_key: 'payables.invoices', kind: 'route' });
  });

  it('keeps pinning to screen views', async () => {
    const listView = await one(
      `insert into saved_view (list_key, name, owner_user_id, kind, query) values ('chart_of_account','List one',$1,'list','{}'::jsonb) returning id`,
      [buyer.scope.userId],
    );
    await expect(ownerPool.query(`update saved_view set pinned_at = now() where id = $1`, [listView])).rejects.toThrow(
      /saved_view_pin_is_route/,
    );
    await ownerPool.query(`delete from saved_view where id = $1`, [listView]);
  });

  it('holds a hundred views and twelve pins, in the service and in the table', async () => {
    const owner = capped.scope.userId;
    await ownerPool.query(
      `insert into saved_view (list_key, name, owner_user_id, kind, query)
       select 'sales.invoices', 'View ' || n, $1, 'route', '{"v":1,"params":{}}'::jsonb from generate_series(1, 100) n`,
      [owner],
    );
    expect(await countRows(owner)).toBe(100);
    await expect(
      as(capped, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey: 'sales.invoices', name: 'One too many', params: {} })),
    ).rejects.toMatchObject({ code: 'limit_views' });
    await expect(
      ownerPool.query(
        `insert into saved_view (list_key, name, owner_user_id, kind, query) values ('sales.invoices','One too many',$1,'route','{"v":1,"params":{}}')`,
        [owner],
      ),
    ).rejects.toThrow(/at most 100/i);

    // Twelve pins, then the thirteenth.
    await ownerPool.query(
      `update saved_view set pinned_at = now() where id in (select id from saved_view where owner_user_id = $1 order by name limit 12)`,
      [owner],
    );
    const { rows } = await ownerPool.query(
      `select id from saved_view where owner_user_id = $1 and pinned_at is null order by name limit 1`,
      [owner],
    );
    await expect(as(capped, (tx, ctx) => sv.pinRouteView(tx, ctx, rows[0].id as string, true))).rejects.toMatchObject({
      code: 'limit_pins',
    });
    await expect(ownerPool.query(`update saved_view set pinned_at = now() where id = $1`, [rows[0].id])).rejects.toThrow(
      /at most 12/i,
    );
    await ownerPool.query(`delete from saved_view where owner_user_id = $1`, [owner]);
  });
});

describe('what the person may open is re-applied on every run', () => {
  it('shows a view of a screen the person can no longer open as unavailable — not hidden — and runs nothing for it', async () => {
    const view = await as(clerk, (tx, ctx) =>
      sv.createRouteView(tx, ctx, { routeKey: 'payables.invoices', name: 'Overdue bills', params: { view: 'overdue' } }),
    );
    await as(clerk, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, view.id, true));
    await as(clerk, (tx, ctx) => sv.pinRouteView(tx, ctx, view.id, true));
    const fine = await as(clerk, (tx, ctx) => sv.stateFor(tx, ctx.principal, 'payables.invoices', {}));
    expect(fine?.redirectTo).toBe('/payables/invoices?view=overdue');
    expect((await as(clerk, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { branchCode: BGW })))[0]).toMatchObject({
      available: true,
      count: 1,
    });

    // A real revocation: the grant row goes, and the principal is loaded again as the session would.
    await ownerPool.query(`delete from role_grant where role_code = $1 and object = 'ap_invoice'`, [clerk.role]);
    const revoked = await reload(clerk);

    const listed = await as(clerk, (tx, ctx) => sv.listRouteViews(tx, ctx.principal), clerk.scope, revoked);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: 'Overdue bills',
      available: false,
      unavailable: 'no_access',
      href: null,
      params: { view: 'overdue' },
      isDefault: true,
    });

    // No menu, so no redirect into a screen the person cannot open.
    expect(await as(clerk, (tx, ctx) => sv.stateFor(tx, ctx.principal, 'payables.invoices', {}), clerk.scope, revoked)).toBeNull();

    // Home shows the tile as unavailable, with no count and nowhere to go.
    const tiles = await as(clerk, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { branchCode: BGW }), clerk.scope, revoked);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ title: 'Overdue bills', available: false, unavailable: 'no_access', href: null, count: null });

    // It cannot be used, extended or pinned again — but it can be tidied away.
    await expect(
      as(clerk, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey: 'payables.invoices', name: 'Another', params: {} }), clerk.scope, revoked),
    ).rejects.toMatchObject({ code: 'unavailable', reason: 'no_access' });
    await expect(
      as(clerk, (tx, ctx) => sv.duplicateRouteView(tx, ctx, view.id), clerk.scope, revoked),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await as(clerk, (tx, ctx) => sv.pinRouteView(tx, ctx, view.id, false), clerk.scope, revoked);
    await expect(
      as(clerk, (tx, ctx) => sv.pinRouteView(tx, ctx, view.id, true), clerk.scope, revoked),
    ).rejects.toMatchObject({ code: 'unavailable' });

    // Given back, the same view works again: nothing was destroyed by being unavailable.
    await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,'ap_invoice','view')`, [clerk.role]);
    const regranted = await reload(clerk);
    const again = await as(clerk, (tx, ctx) => sv.listRouteViews(tx, ctx.principal), clerk.scope, regranted);
    expect(again[0]).toMatchObject({ available: true, unavailable: null, href: '/payables/invoices?view=overdue' });

    await as(clerk, (tx, ctx) => sv.deleteRouteView(tx, ctx, view.id));
  });

  it('shows a view whose screen has left the registry as unavailable, and lets it be deleted', async () => {
    const stray = await one(
      `insert into saved_view (list_key, name, owner_user_id, kind, query) values ('gone.screen','Orphaned',$1,'route','{"v":1,"params":{"q":"x"}}'::jsonb) returning id`,
      [buyer.scope.userId],
    );
    const listed = await as(buyer, (tx, ctx) => sv.listRouteViews(tx, ctx.principal));
    expect(listed.find((found) => found.id === stray)).toMatchObject({
      available: false,
      unavailable: 'unknown_screen',
      route: null,
      href: null,
    });
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, stray));
    expect(await rowOf(stray)).toBeUndefined();
  });

  it('drops a stored filter the screen has since lost, and says so', async () => {
    const stray = await one(
      `insert into saved_view (list_key, name, owner_user_id, kind, query)
       values ('payables.invoices','Old filters',$1,'route','{"v":1,"params":{"q":"keep","view":"retired_value","gone_param":"1"}}'::jsonb) returning id`,
      [buyer.scope.userId],
    );
    const found = (await as(buyer, (tx, ctx) => sv.listRouteViews(tx, ctx.principal, { routeKey: 'payables.invoices' }))).find(
      (candidate) => candidate.id === stray,
    )!;
    expect(found.params).toEqual({ q: 'keep' });
    expect(found.dropped.map((item) => item.name).sort()).toEqual(['gone_param', 'view']);
    expect(found.href).toBe('/payables/invoices?q=keep');
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, stray));
  });

  it('counts through the screen’s own query: a branch change empties the count, and no number is ever stored', async () => {
    const mine = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, { routeKey: 'payables.invoices', name: 'Pinned overdue', params: { view: 'overdue' } }),
    );
    await as(buyer, (tx, ctx) => sv.pinRouteView(tx, ctx, mine.id, true));

    const here = await as(buyer, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { branchCode: BGW }));
    expect(here.find((tile) => tile.id === mine.id)).toMatchObject({ available: true, count: 1 });

    // Move the person to another branch, for real: the scope row, the principal, the session scope.
    await ownerPool.query(`delete from user_branch_scope where user_id = $1`, [buyer.scope.userId]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [buyer.scope.userId, MSL]);
    const moved = { ...buyer.scope, branchCode: MSL };
    const principal = await reload(buyer, moved);
    const away = await as(buyer, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { branchCode: MSL }), moved, principal);
    expect(away.find((tile) => tile.id === mine.id)).toMatchObject({ available: true, count: 0 });

    // The view itself did not change, and holds no number.
    const row = (await rowOf(mine.id))!;
    expect(row.query).toEqual({ v: 1, params: { view: 'overdue' } });
    expect(JSON.stringify(row)).not.toMatch(/count|total/i);

    await ownerPool.query(`delete from user_branch_scope where user_id = $1`, [buyer.scope.userId]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [buyer.scope.userId, BGW]);
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, mine.id));
  });
});

describe('pinnedFor — what Home reads', () => {
  it('gives title, route, params and the screen’s own count, oldest pin first, for the person asking', async () => {
    const make = (routeKey: string, name: string, params: Record<string, string>, rules?: Record<string, string>) =>
      as(buyer, (tx, ctx) => sv.createRouteView(tx, ctx, { routeKey, name, params, ...(rules ? { rules } : {}) }));
    const overdue = await make('payables.invoices', 'Overdue bills', { view: 'overdue' });
    const large = await make('payables.invoices', 'Large bills', { min_amount: '1250000' });
    const larger = await make('payables.invoices', 'Larger bills', { min_amount: '1250000.0001' });
    const arriving = await make('imports.containers', 'Arriving this month (pinned)', {}, { eta: 'this_month' });
    const stock = await make('inventory.availability', 'In stock', { in_stock: '1' });
    const receipts = await make('sales.receipts', 'Receipts (no count)', { q: 'cash' });
    const unpinned = await make('payables.suppliers', 'Not on Home', { status: 'active' });
    for (const view of [overdue, large, larger, arriving, stock, receipts]) {
      await as(buyer, (tx, ctx) => sv.pinRouteView(tx, ctx, view.id, true));
      // The pin timestamps are the database's clock; make the order unambiguous.
      await ownerPool.query(`update saved_view set pinned_at = pinned_at + (interval '1 second' * $2) where id = $1`, [
        view.id,
        [overdue, large, larger, arriving, stock, receipts].indexOf(view),
      ]);
    }

    const tiles = await as(buyer, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { branchCode: BGW, today: '2026-10-04' }));
    const mine = tiles.filter((tile) => [overdue, large, larger, arriving, stock, receipts].some((view) => view.id === tile.id));
    expect(mine.map((tile) => tile.title)).toEqual([
      'Overdue bills',
      'Large bills',
      'Larger bills',
      'Arriving this month (pinned)',
      'In stock',
      'Receipts (no count)',
    ]);
    expect(tiles.some((tile) => tile.id === unpinned.id)).toBe(false);

    const byTitle = Object.fromEntries(mine.map((tile) => [tile.title, tile]));
    expect(byTitle['Overdue bills']).toMatchObject({
      route: '/payables/invoices',
      params: { view: 'overdue' },
      href: '/payables/invoices?view=overdue',
      count: 1, // Baghdad's one overdue invoice; Erbil's is not this person's
      available: true,
    });
    // Money is compared as scaled integers: 1,250,000 is at least 1,250,000, and not at least 1,250,000.0001.
    expect(byTitle['Large bills']!.count).toBe(1);
    expect(byTitle['Larger bills']!.count).toBe(0);
    // A rule is worked out for the day Home is drawn.
    expect(byTitle['Arriving this month (pinned)']).toMatchObject({
      route: '/payables/containers',
      params: { eta_from: '2026-10-01', eta_to: '2026-10-31' },
      count: 0,
    });
    expect(byTitle['In stock']).toMatchObject({ route: '/inventory/availability', params: { in_stock: '1' }, count: 0 });
    // A screen without a counter is a link, never a made-up number.
    expect(byTitle['Receipts (no count)']).toMatchObject({ route: '/sales/customer-receipts', count: null, available: true });

    // Links only, when asked.
    const links = await as(buyer, (tx, ctx) => sv.pinnedFor(tx, ctx.principal, { counts: false }));
    expect(links.every((tile) => tile.count === null)).toBe(true);

    for (const view of [overdue, large, larger, arriving, stock, receipts, unpinned]) {
      await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, view.id));
    }
  });
});

describe('the Views menu state', () => {
  it('sends a bare arrival to the default view, and leaves an address with filters alone', async () => {
    const view = await as(buyer, (tx, ctx) =>
      sv.createRouteView(tx, ctx, { routeKey: 'payables.invoices', name: 'My start', params: { view: 'unpaid', q: 'acme' } }),
    );
    await as(buyer, (tx, ctx) => sv.setDefaultRouteView(tx, ctx, view.id, true));
    const state = (raw: Record<string, string>) =>
      as(buyer, (tx, ctx) => sv.stateFor(tx, ctx.principal, 'payables.invoices', raw));

    expect((await state({}))!.redirectTo).toBe('/payables/invoices?q=acme&view=unpaid');
    // The outcome of the action that brought the person here travels with them.
    expect((await state({ saved: '1' }))!.redirectTo).toBe('/payables/invoices?q=acme&view=unpaid&saved=1');
    expect((await state({ view: 'overdue' }))!.redirectTo).toBeNull();
    expect((await state({ q: '' }))!.redirectTo).toBeNull();
    expect((await state({ sv: 'none' }))!.redirectTo).toBeNull();

    const active = (await state({ view: 'unpaid', q: 'acme' }))!;
    expect(active.activeId).toBe(view.id);
    expect(active.views.find((found) => found.id === view.id)!.active).toBe(true);
    expect(active.current).toMatchObject({
      params: { q: 'acme', view: 'unpaid' },
      returnTo: '/payables/invoices?q=acme&view=unpaid',
    });
    // Active means the same question, not a similar one: "Unpaid" (view=unpaid alone) is the one that matches.
    expect((await state({ view: 'unpaid' }))!.activeId).toBe(ids.unpaid);
    expect((await state({ view: 'imports' }))!.activeId).toBeNull();
    expect((await state({}))!.slots).toEqual([]);
    expect((await as(buyer, (tx, ctx) => sv.stateFor(tx, ctx.principal, 'imports.containers', {})))!.slots).toEqual([
      expect.objectContaining({ id: 'eta', kind: 'range' }),
    ]);

    // A screen that is not registered has no menu.
    expect(await as(buyer, (tx, ctx) => sv.stateFor(tx, ctx.principal, 'made.up', {}))).toBeNull();
    await as(buyer, (tx, ctx) => sv.deleteRouteView(tx, ctx, view.id));
  });

  it('every registered screen answers for a person who may open it', async () => {
    for (const route of VIEWABLE_ROUTES) {
      const state = await as(buyer, (tx, ctx) => sv.stateFor(tx, ctx.principal, route.key, {}));
      expect(state, route.key).not.toBeNull();
      expect(state!.route).toBe(route.route);
    }
    // A clerk who holds only the purchase-invoice grant gets the menu on the two screens that grant opens.
    for (const route of VIEWABLE_ROUTES) {
      const opens = ['payables.invoices', 'payables.open_items'].includes(route.key);
      expect((await as(clerk, (tx, ctx) => sv.stateFor(tx, ctx.principal, route.key, {}))) !== null, route.key).toBe(opens);
    }
  });
});
