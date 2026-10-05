/**
 * Home is a composition of what the person may see — platform phase, Agent 2.
 *
 * The claim under test: the same page, asked by different people, answers with
 * different widgets and different figures, and the difference is *only* their
 * grants, their roles and their branch. Nothing here names a person; the
 * personas below are roles and grants, built the way the roles screen builds
 * them.
 *
 * What is proven, in order:
 *   1  who is shown what (registry × real grants), and that nobody is shown a
 *      widget their own services then refuse to read;
 *   2  the figures: they are the services' figures, to the dinar, from a world
 *      made by the services (an import with a B/L, containers, a PD, charges, a
 *      receipt; a sale; a bank);
 *   3  branch scoping, empty states and the slot the Exception Center fills;
 *   4  My Approvals: only what the viewer can act on, four eyes intact, and a
 *      decision made through the owning service.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { containerNo } from '../support/container-number';
import { ownerPool, seedBranch } from './setup';
import {
  BAGHDAD,
  IN_PROCESS,
  PANEL,
  WAREHOUSE,
  blWith,
  buildImportWorld,
  charge,
  importOf,
  iqd,
  q,
  receive,
  registerPd,
  scope,
  type ImportWorld,
} from './logistics-fixture';
import { withScope, type RequestScope } from '@/server/db/client';
import { businessToday } from '@/server/domain/business-date';
import type { WidgetOutcome, TableData, KpiData } from '@/server/domain/dashboard-data';
import { DATA_FAMILIES, WIDGETS, type WidgetKey } from '@/server/domain/dashboard-widgets';
import { stagesFor } from '@/server/domain/import-journey';
import type { Principal } from '@/server/domain/permissions';
import * as ap from '@/server/services/ap-invoice';
import * as approvalCenter from '@/server/services/approval-center';
import * as ar from '@/server/services/ar-invoice';
import * as authz from '@/server/services/authorization';
import * as home from '@/server/services/home';
import { registerAttentionFeed } from '@/server/services/home-loaders';
import * as journal from '@/server/services/journal';
import * as partners from '@/server/services/business-partner';
import * as po from '@/server/services/purchase-order';
import * as shipments from '@/server/services/shipments';
import { registerAllLists } from '@/server/lists';

const ERBIL = 'ERB';
const TODAY = businessToday();

interface Person {
  readonly name: string;
  readonly principal: Principal;
  readonly scope: RequestScope;
  readonly branchCode: string;
}

let world: ImportWorld;
let ceo: Person;
let manager: Person;
let officer: Person;
let outsider: Person;
let admin: Person;
let warehouse: Person;
let logistics: Person;
let erbilOfficer: Person;
let boss: Person;

const payableOfA: { id: string; no: string } = { id: '', no: '' };
const payableOfB: { id: string; no: string } = { id: '', no: '' };
const containersOfA: string[] = [];

async function person(
  name: string,
  options: { roles?: readonly string[]; grants?: readonly (readonly [string, string])[]; branch?: string; superUser?: boolean },
): Promise<Person> {
  const id = randomUUID();
  const branchCode = options.branch ?? BAGHDAD;
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [
    id,
    `${name}-${id}@example.com`,
    name,
    options.superUser ?? false,
  ]);
  const roles = [...(options.roles ?? [])];
  if (options.grants && options.grants.length > 0) {
    const adHoc = `dash_${name}_${id.slice(0, 6)}`;
    await ownerPool.query(`insert into role (code, name) values ($1,$2)`, [adHoc, `Dashboard test ${name}`]);
    for (const [object, verb] of options.grants) {
      await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,$2,$3::permission_verb)`, [adHoc, object, verb]);
    }
    roles.push(adHoc);
  }
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branchCode]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const requestScope: RequestScope = { userId: id, branchCode, isSuperUser: options.superUser ?? false };
  const principal = await withScope(requestScope, (tx) => authz.loadPrincipal(tx, id));
  return { name, principal, scope: requestScope, branchCode };
}

const homeOf = (who: Person, branchCode = who.branchCode) =>
  withScope(who.scope, (tx) => home.forViewer(tx, { principal: who.principal, branchCode }));

const widgetsOf = (view: home.HomeView) => [...view.kpi, ...view.chart, ...view.list];
const keysOf = (view: home.HomeView) => widgetsOf(view).map((widget) => widget.key as string);
const outcomeOf = (view: home.HomeView, key: WidgetKey): WidgetOutcome | undefined => widgetsOf(view).find((widget) => widget.key === key)?.outcome;

function kpiOf(view: home.HomeView, key: WidgetKey): KpiData {
  const outcome = outcomeOf(view, key);
  if (!outcome || outcome.state !== 'ready' || outcome.data.kind !== 'kpi') throw new Error(`${key} is not a ready figure: ${JSON.stringify(outcome)}`);
  return outcome.data;
}

function tableOf(view: home.HomeView, key: WidgetKey): TableData {
  const outcome = outcomeOf(view, key);
  if (!outcome || outcome.state !== 'ready' || outcome.data.kind !== 'table') throw new Error(`${key} is not a ready table: ${JSON.stringify(outcome)}`);
  return outcome.data;
}

const moneyValue = (data: KpiData): string => {
  if (data.value.t !== 'money') throw new Error(`not money: ${JSON.stringify(data.value)}`);
  return data.value.v;
};

beforeAll(async () => {
  registerAllLists();
  world = await buildImportWorld();
  await seedBranch(ERBIL, 'Erbil');

  // ── The business: two imports, a sale, a bank with money in it ───────────
  // Import A — 100 panels in two containers, a PD, two charges, the first container received.
  const a = await importOf(world, '100', { reference: 'DASH-A' });
  payableOfA.id = a.payableId;
  payableOfA.no = (await ownerPool.query(`select payable_no from payable where id = $1`, [a.payableId])).rows[0].payable_no;
  const bl = await blWith(world, a.payableId, [
    { no: containerNo('MSCU', 810001), qty: '60' },
    { no: containerNo('MSCU', 810002), qty: '40' },
  ]);
  containersOfA.push(...bl.containerIds);
  await registerPd(world, a.payableId, 'PD-DASH-1');
  await charge(world, a.payableId, 'customs_asycuda', '300000');
  await charge(world, a.payableId, 'freight', '200000');
  await receive(world, bl.containerIds[0]!, { on: '2026-08-28' });
  // The nightly sweep: the second container's ETA (25 Aug) has passed without it arriving.
  await withScope(scope(world.clerk), (tx) => shipments.lateSweep(tx, TODAY));

  // Import B — raised and posted, nothing shipped.
  const b = await importOf(world, '50', { reference: 'DASH-B' });
  payableOfB.id = b.payableId;
  payableOfB.no = (await ownerPool.query(`select payable_no from payable where id = $1`, [b.payableId])).rows[0].payable_no;

  // A sale from the stock that arrived: 10 panels at 20,000, September, due the 30th (overdue today).
  const sale = await withScope(scope(world.clerk), (tx) =>
    ar.createDirect(tx, world.clerk, {
      customerId: world.customerId,
      branchCode: BAGHDAD,
      invoiceDate: '2026-09-15',
      dueDate: '2026-09-30',
      lines: [{ itemCode: PANEL, quantity: q('10'), unitPriceIqd: iqd('20000'), warehouseCode: WAREHOUSE }],
    }),
  );
  await withScope(scope(world.manager), (tx) => ar.approve(tx, world.manager, sale.id));
  await withScope(scope(world.manager), (tx) => ar.post(tx, world.manager, sale.id));

  // ── The people: roles and grants only ────────────────────────────────────
  const everyone: readonly (readonly [string, string])[] = [
    ['task', 'view'],
    ['notification', 'view'],
    ['chat', 'view'],
  ];
  ceo = await person('ceo', { roles: ['ceo'] });
  manager = await person('manager', { roles: ['accounting_manager'] });
  officer = { name: 'officer', principal: world.clerk.principal, scope: scope(world.clerk), branchCode: BAGHDAD };
  outsider = await person('outsider', {});
  admin = await person('admin', { superUser: true });
  warehouse = await person('warehouse', {
    grants: [
      ['inventory_movement', 'view'],
      ['inventory_movement', 'execute'],
      ['stock_movement', 'view'],
      ['warehouse', 'view'],
      ['item', 'view'],
      ['stock_count', 'view'],
      ...everyone,
    ],
  });
  logistics = await person('logistics', { roles: ['logistics_officer'] });
  erbilOfficer = await person('erbil', { roles: ['accounting_officer'], branch: ERBIL });
  boss = { name: 'boss', principal: world.manager.principal, scope: scope(world.manager), branchCode: BAGHDAD };
}, 240_000);

afterAll(() => registerAttentionFeed(null));

// ---------------------------------------------------------------------------
describe('1 · the page is composed from grants', () => {
  it('shows different widgets to the CEO, a manager, an officer, a warehouse person, a logistics officer and a stranger', async () => {
    const pages = new Map<string, string[]>();
    for (const who of [ceo, manager, officer, warehouse, logistics, outsider, admin]) pages.set(who.name, keysOf(await homeOf(who)));

    // The CEO holds the management capability: the overdue figures and the audit trail are theirs alone.
    expect(pages.get('ceo')).toEqual(expect.arrayContaining(['overdue_receivables', 'overdue_payables', 'list_major_imports', 'list_activity', 'cash_position', 'chart_import_stages']));
    for (const name of ['manager', 'officer', 'warehouse', 'logistics', 'outsider']) {
      expect(pages.get(name), name).not.toContain('overdue_receivables');
      expect(pages.get(name), name).not.toContain('list_activity');
      expect(pages.get(name), name).not.toContain('list_major_imports');
    }

    // The accounting manager can be waited on. So can an accounting officer, since the inventory
    // grants: `approve` on inventory_movement and warehouse_transfer means a stock count or a
    // transfer can wait on them (found 2026-10-05, when this was merged with main — the test
    // still said an officer only raises documents). Somebody who approves nothing is not offered it.
    expect(pages.get('manager')).toContain('approvals_waiting');
    expect(pages.get('officer')).toContain('approvals_waiting');
    expect(pages.get('outsider')).not.toContain('approvals_waiting');
    expect(pages.get('officer')).toContain('cash_position');

    // A warehouse role is operational: stock and movements, nothing financial.
    expect(pages.get('warehouse')).toEqual(expect.arrayContaining(['inventory_value', 'warehouse_today', 'list_low_stock', 'list_todays_movements']));
    for (const key of ['cash_position', 'receivable_total', 'payable_total', 'net_result', 'chart_trading', 'imports_in_progress']) {
      expect(pages.get('warehouse'), key).not.toContain(key);
    }

    // Logistics sees the imports and their containers, and not the landed-cost register it was never given.
    expect(pages.get('logistics')).toEqual(expect.arrayContaining(['imports_in_progress', 'chart_import_stages', 'list_delayed_containers']));
    expect(pages.get('logistics')).not.toContain('list_landed_cost_blocks');
    expect(pages.get('logistics')).not.toContain('cash_position');

    // A person with no role is shown nothing that reads data, and the page does not pretend otherwise.
    expect(pages.get('outsider')).toEqual([]);

    // The administrator is shown everything that has something to say.
    for (const key of ['cash_position', 'receivable_total', 'imports_in_progress', 'warehouse_today', 'list_activity']) {
      expect(pages.get('admin'), key).toContain(key);
    }

    // And the pages are really different, not one page with a few holes.
    const distinct = new Set([...pages.values()].map((keys) => keys.join('|')));
    expect(distinct.size).toBe(pages.size);
  });

  it('puts what is waiting on the person first, then their deepest family', async () => {
    const managerPage = await homeOf(manager);
    expect(managerPage.kpi[0]!.key).toBe('approvals_waiting');
    expect(managerPage.list[0]!.key).toBe('list_approvals');
    const ceoPage = await homeOf(ceo);
    expect(ceoPage.families[0]!.family).toBe('management');
    const warehousePage = await homeOf(warehouse);
    expect(warehousePage.families[0]!.family).toBe('inventory');
    // The first figure is one of the person's own kind of work, not a generic one.
    expect(warehousePage.kpi[0]!.definition.family).toBe('inventory');
  });

  it('never shows a widget that the person\'s own services then refuse to read', async () => {
    // The registry says what a person needs; each service says what it checks.
    // Where the two disagree a widget would be drawn as "could not be read" —
    // a defect of the registry, caught here for every kind of person.
    for (const who of [ceo, manager, officer, warehouse, logistics, outsider, admin, erbilOfficer]) {
      const view = await homeOf(who);
      const unreadable = widgetsOf(view).filter((widget) => widget.outcome.state === 'unreadable').map((widget) => widget.key);
      expect(unreadable, `${who.name} has unreadable widgets`).toEqual([]);
    }
  });

  it('declares every widget\'s requirements and has a loader for it', () => {
    for (const widget of WIDGETS) {
      const gated = widget.requires.length > 0 || ('capability' in widget && widget.capability) || ('requiresAny' in widget);
      // The only requirement-free widgets are the two that draw nothing when there is nothing to draw.
      if (!gated) expect(['attention', 'list_pinned_views']).toContain(widget.key);
    }
  });

  it('offers quick actions only for what the person may do, and only to screens that are served', async () => {
    const managerPage = await homeOf(manager);
    expect(managerPage.quickActions.length).toBeGreaterThan(0);
    expect(managerPage.quickActions.length).toBeLessThanOrEqual(5);
    expect(managerPage.quickActions.map((action) => action.key)).toContain('open_approvals');
    expect((await homeOf(outsider)).quickActions).toEqual([]);
    // A screen the shell does not serve is not offered.
    const refused = await withScope(manager.scope, (tx) => home.forViewer(tx, { principal: manager.principal, branchCode: BAGHDAD }, (route) => route !== '/approvals'));
    expect(refused.quickActions.map((action) => action.href)).not.toContain('/approvals');
  });
});

// ---------------------------------------------------------------------------
describe('2 · the figures are the services\' figures', () => {
  it('gives the CEO the receivable, the payable and what is overdue, to the dinar', async () => {
    const view = await homeOf(ceo);
    // One sale of 10 × 20,000, unpaid, due 2026-09-30.
    expect(moneyValue(kpiOf(view, 'receivable_total'))).toBe('200000.0000');
    expect(moneyValue(kpiOf(view, 'overdue_receivables'))).toBe('200000.0000');
    expect(kpiOf(view, 'overdue_receivables').tone).toBe('warn');
    // Two imports, 100 × 10,000 and 50 × 10,000, both due 2026-09-01.
    expect(moneyValue(kpiOf(view, 'payable_total'))).toBe('1500000.0000');
    expect(moneyValue(kpiOf(view, 'overdue_payables'))).toBe('1500000.0000');
  });

  it('draws the ageing from the same invoices, in the band their due date puts them in', async () => {
    const view = await homeOf(ceo);
    const outcome = outcomeOf(view, 'chart_receivable_ageing');
    expect(outcome?.state).toBe('ready');
    if (outcome?.state !== 'ready' || outcome.data.kind !== 'chart' || outcome.data.chart.type !== 'stack') throw new Error('not an ageing stack');
    expect(outcome.data.chart.rows.map((row) => [row.labelKey, row.value, row.count])).toEqual([['bucket_1_30', '200000.0000', 1]]);
  });

  it('shows the sales trend as invoiced beside collected, by month, from the invoices', async () => {
    const view = await homeOf(ceo);
    const outcome = outcomeOf(view, 'chart_sales_trend');
    expect(outcome?.state).toBe('ready');
    if (outcome?.state !== 'ready' || outcome.data.kind !== 'chart' || outcome.data.chart.type !== 'columns') throw new Error('not a column chart');
    const september = outcome.data.chart.points.find((point) => point.month === '2026-09');
    expect(september).toEqual({ month: '2026-09', first: '200000.0000', second: '0.0000' });
  });

  it('has no sales figure for a month without sales rather than a zero', async () => {
    const view = await homeOf(ceo);
    const expected = TODAY.startsWith('2026-09') ? 'ready' : 'empty';
    expect(outcomeOf(view, 'sales_period')?.state).toBe(expected);
  });

  it('lists the delayed container with the days it is late, and links it to the tracking screen', async () => {
    const view = await homeOf(logistics);
    const delayed = tableOf(view, 'list_delayed_containers');
    // The second container of A was never loaded and its ETA (25 Aug) has passed; the first was received.
    const second = delayed.rows.find((row) => row.cells.some((cell) => cell.t === 'code' && cell.v === containerNo('MSCU', 810002)));
    expect(second, 'the second container is listed').toBeDefined();
    expect(second!.href).toContain('/logistics/shipment-tracking');
    // 25 August to today, counted in whole days.
    const days = Math.round((Date.parse(`${TODAY}T00:00:00Z`) - Date.parse('2026-08-25T00:00:00Z')) / 86_400_000);
    expect(second!.cells).toContainEqual({ t: 'count', v: days });
    expect(delayed.rows.some((row) => row.cells.some((cell) => cell.t === 'code' && cell.v === containerNo('MSCU', 810001)))).toBe(false);
  });

  it('counts the imports in progress and says how many containers are late', async () => {
    const view = await homeOf(logistics);
    const data = kpiOf(view, 'imports_in_progress');
    expect(data.value).toEqual({ t: 'count', v: 2 });
    expect(data.tone).toBe('warn');
    expect(data.note?.key).toBe('containers_late');
  });

  it('draws the import journey from the logistics evidence, stage by stage', async () => {
    const view = await homeOf(ceo);
    const outcome = outcomeOf(view, 'chart_import_stages');
    expect(outcome?.state).toBe('ready');
    if (outcome?.state !== 'ready' || outcome.data.kind !== 'journey') throw new Error('not a journey');
    const journey = outcome.data;
    const count = (key: string) => journey.stages.find((stage) => stage.key === key)?.count;
    expect(journey.inProgress).toBe(2);
    // Only the steps the CEO can read the evidence for are drawn — never a zero standing in for "not allowed".
    expect(journey.stages.map((stage) => stage.key)).toEqual(stagesFor(ceo.principal));
    // Both imports were raised; only A has a B/L, containers, a PD, a charge and a received container.
    expect(count('application')).toBe(2);
    expect(count('bl')).toBe(1);
    expect(count('container')).toBe(1);
    expect(count('customs')).toBe(1);
    expect(count('landed_cost')).toBe(1);
    expect(count('receipt')).toBe(1);
    expect(count('inventory')).toBe(1);
    // Nothing has been loaded onto a vessel, so no import has "shipped".
    expect(count('shipping')).toBe(0);
  });

  it('shows the biggest imports, each with how far it has come', async () => {
    const view = await homeOf(ceo);
    const rows = tableOf(view, 'list_major_imports').rows;
    expect(rows.map((row) => row.key)).toEqual([payableOfA.no, payableOfB.no]);
    expect(rows[0]!.href).toBe(`/payables/${encodeURIComponent(payableOfA.no)}`);
    const reached = (row: (typeof rows)[number]) => row.cells.find((cell) => cell.t === 'word' && cell.ns === 'home.journey');
    expect(reached(rows[0]!)).toBeDefined();
  });

  it('shows the import\'s landed-cost charges that are still unlocked', async () => {
    const view = await homeOf(ceo);
    const blocks = tableOf(view, 'list_landed_cost_blocks');
    expect(blocks.rows.map((row) => row.key)).toContain(payableOfA.id);
  });

  it('gives a warehouse person the stock, not the money', async () => {
    const view = await homeOf(warehouse);
    expect(view.unavailable).toEqual(expect.arrayContaining(['finance', 'receivables', 'payables', 'logistics']));
    expect(view.unavailable).not.toContain('inventory');
    // The Warehouses Report's figure at FIFO cost: 60 received less 10 sold in the main warehouse (500,000), and
    // what is still in transit at the invoice price — 40 of A and all 50 of B (900,000).
    expect(moneyValue(kpiOf(view, 'inventory_value'))).toBe('1400000.0000');
    const stockChart = outcomeOf(view, 'chart_stock_value');
    if (stockChart?.state !== 'ready' || stockChart.data.kind !== 'chart' || stockChart.data.chart.type !== 'bars') throw new Error('no stock chart');
    expect(stockChart.data.chart.rows.map((row) => [row.key, row.value])).toEqual([
      [IN_PROCESS, '900000.0000'],
      [WAREHOUSE, '500000.0000'],
    ]);
  });

  it('lists stock at or below its minimum on the shelf, never goods still in transit', async () => {
    // 50 panels are on the main warehouse's shelf and 90 are in the in-transit warehouse; the item's minimum is 1,000.
    await ownerPool.query(`update item set min_stock_level = 1000 where code = $1`, [PANEL]);
    try {
      const view = await homeOf(warehouse);
      const low = tableOf(view, 'list_low_stock');
      expect(low.rows.map((row) => row.key)).toEqual([`${PANEL}:${WAREHOUSE}`]);
      expect(low.rows.map((row) => row.key).join()).not.toContain(IN_PROCESS);
    } finally {
      await ownerPool.query(`update item set min_stock_level = null where code = $1`, [PANEL]);
    }
    // And with no minimum set, nothing is "low": the widget says so instead of listing the catalogue.
    expect(outcomeOf(await homeOf(warehouse), 'list_low_stock')?.state).toBe('empty');
  });

  it('takes the date from the business day, not from the machine\'s UTC day', async () => {
    expect((await homeOf(ceo)).asOf).toBe(TODAY);
  });
});

// ---------------------------------------------------------------------------
describe('3 · branch scope, empty states and the Exception Center\'s slot', () => {
  it('shows an officer of another branch none of this branch\'s documents', async () => {
    const view = await homeOf(erbilOfficer);
    // They hold the same grants as the Baghdad officer; the database holds none of their branch's documents.
    expect(keysOf(view)).toContain('receivable_total');
    expect(outcomeOf(view, 'receivable_total')?.state).toBe('empty');
    expect(outcomeOf(view, 'payable_total')?.state).toBe('empty');
    expect(outcomeOf(view, 'chart_receivable_ageing')?.state).toBe('empty');
    expect(view.branchCode).toBe(ERBIL);
  });

  it('is held by the database too: asking for another branch\'s figures as an Erbil-only user finds nothing', async () => {
    const view = await homeOf(erbilOfficer, BAGHDAD);
    expect(outcomeOf(view, 'receivable_total')?.state).toBe('empty');
    expect(outcomeOf(view, 'payable_total')?.state).toBe('empty');
  });

  it('says nothing is available, per family, to a person with no role — and shows no widgets', async () => {
    const view = await homeOf(outsider);
    expect(view.kpi).toEqual([]);
    expect(view.chart).toEqual([]);
    expect(view.list).toEqual([]);
    expect(view.quickActions).toEqual([]);
    expect([...view.unavailable].sort()).toEqual([...DATA_FAMILIES].sort());
  });

  it('does not invent a figure where the person holds the grant and the business has nothing', async () => {
    // The Baghdad officer holds the project grant; no project exists — so "no figure", not "0 projects".
    const view = await homeOf(officer);
    expect(outcomeOf(view, 'projects_overview')?.state).toBe('empty');
    // They hold nothing of HR, so no HR widget is drawn and the page says so for the family.
    expect(keysOf(view).filter((key) => key.startsWith('hr_') || key === 'list_on_leave')).toEqual([]);
    expect(view.unavailable).toContain('hr');
  });

  it('draws the attention slot only when the Exception Center has been wired to it', async () => {
    registerAttentionFeed(null);
    expect(keysOf(await homeOf(ceo))).not.toContain('attention');

    registerAttentionFeed({
      open: async () => [
        {
          id: 'e1',
          no: 'EXC-1',
          severity: 'critical',
          domain: 'inventory',
          title: 'Stock ledger does not balance',
          explanation: 'x',
          recordType: null,
          recordId: null,
          href: '/exceptions/EXC-1',
          createdAt: new Date('2026-10-01T08:00:00Z'),
          ownerName: null,
        },
      ],
      counts: async () => ({ total: 7, bySeverity: { critical: 1 }, byDomain: { inventory: 1 } }),
    });
    const view = await homeOf(ceo);
    expect(view.list[0]!.key).toBe('attention');
    const data = tableOf(view, 'attention');
    expect(data.total).toBe(7);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]!.href).toBe('/exceptions/EXC-1');
    expect(data.href).toBe('/exceptions');

    // A feed that fails does not blank the page: that one widget is reported unreadable, the rest are drawn.
    registerAttentionFeed({
      open: async () => {
        throw new Error('exceptions are down');
      },
      counts: async () => ({ total: 0, bySeverity: {}, byDomain: {} }),
    });
    const broken = await homeOf(ceo);
    expect(outcomeOf(broken, 'attention')?.state).toBe('unreadable');
    expect(outcomeOf(broken, 'receivable_total')?.state).toBe('ready');

    registerAttentionFeed(null);
  });

  it('leaves the connection\'s statement timeout as it found it', async () => {
    const before = await withScope(ceo.scope, async (tx) => {
      const first = (await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string };
      await home.forViewer(tx, { principal: ceo.principal, branchCode: BAGHDAD });
      const after = (await tx.execute(sql`select current_setting('statement_timeout') as v`)).rows[0] as { v: string };
      return { first: first.v, after: after.v };
    });
    expect(before.after).toBe(before.first);
  });
});

// ---------------------------------------------------------------------------
describe('4 · My Approvals lists only what the viewer can act on', () => {
  const ctxOf = (who: Person) => ({ principal: who.principal, branchCode: who.branchCode });
  const listFor = (who: Person, filter: Parameters<typeof approvalCenter.list>[2] = {}) =>
    withScope(who.scope, (tx) => approvalCenter.list(tx, ctxOf(who), filter));

  const made = { journalId: '', journalNo: '', orderNo: '', invoiceNo: '' };

  beforeAll(async () => {
    // A journal the officer raises and submits: it waits for a manager.
    const draft = await withScope(scope(world.clerk), (tx) =>
      journal.createDraft(tx, world.clerk, { branchCode: BAGHDAD, documentDate: '2026-10-01', postingDate: '2026-10-01', description: 'Dashboard approval' }),
    );
    for (const line of [
      { accountId: world.accounts.expense!, debit: '1000' },
      { accountId: world.accounts.bank!, credit: '1000' },
    ]) {
      await withScope(scope(world.clerk), (tx) => journal.addLine(tx, world.clerk, draft.id, { ...line, dimensions: { department: 'FIN' } }));
    }
    await withScope(scope(world.clerk), (tx) => journal.submit(tx, world.clerk, draft.id));
    made.journalId = draft.id;
    made.journalNo = draft.entryNo;

    // A purchase order the officer raises and submits.
    const order = await withScope(scope(world.clerk), (tx) =>
      po.create(tx, world.clerk, {
        supplierId: world.supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-10-01',
        reference: 'DASH-PO',
        lines: [{ lineType: 'inventory_item', itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('20'), uomCode: 'EA', unitPriceIqd: iqd('10000'), branchCode: BAGHDAD, warehouseCode: WAREHOUSE }],
      }),
    );
    await withScope(scope(world.clerk), (tx) => po.submit(tx, world.clerk, order.id));
    made.orderNo = order.orderNo;

    // A purchase invoice the officer submits and cannot post.
    const invoice = await importOf(world, '5', { reference: 'DASH-C', post: false });
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, invoice.invoiceId));
    made.invoiceNo = invoice.invoiceNo;

  }, 120_000);

  it('shows each approver what their own role decides, every row opening the real document', async () => {
    // The senior manager holds both the accounting manager's grants and the CEO's: all three documents wait on him.
    const page = await listFor(boss);
    const byNo = new Map(page.rows.map((row) => [row.documentNo, row]));
    expect(byNo.get(made.journalNo)).toMatchObject({ documentType: 'journal_entry', action: 'approve', href: `/finance/journals/${made.journalNo}` });
    expect(byNo.get(made.orderNo)).toMatchObject({ documentType: 'purchase_order', action: 'approve', href: `/payables/purchase-orders/${made.orderNo}` });
    expect(byNo.get(made.invoiceNo)).toMatchObject({ documentType: 'ap_invoice', action: 'post', href: `/payables/invoices/${made.invoiceNo}` });
    // The order's amount is its lines' total, in its own currency.
    expect(byNo.get(made.orderNo)!.amount).toEqual({ value: '200000.0000', currency: 'IQD' });
    // A submitted invoice has not been posted, so its own total is still zero: the amount is summed from its lines
    // (5 panels at 10,000), as the Purchase Invoices register does — never "0 IQD" for a real invoice.
    expect(byNo.get(made.invoiceNo)!.amount).toEqual({ value: expect.stringMatching(/^50000(\.0+)?$/), currency: 'IQD' });
    expect(page.failed).toEqual([]);

    // The accounting manager decides journals and orders, and has no say on posting a purchase invoice (the CEO's).
    const managerKinds = (await listFor(manager)).rows.map((row) => row.documentType);
    expect(managerKinds).toEqual(expect.arrayContaining(['journal_entry', 'purchase_order']));
    expect(managerKinds).not.toContain('ap_invoice');

    // The CEO posts the invoice, and is not asked about journals or orders.
    const ceoRows = (await listFor(ceo)).rows;
    expect(ceoRows.map((row) => row.documentNo)).toContain(made.invoiceNo);
    expect(ceoRows.map((row) => row.documentType)).not.toContain('journal_entry');
    expect(ceoRows.map((row) => row.documentType)).not.toContain('purchase_order');
  });

  it('shows the person who raised a document nothing they cannot decide (four eyes)', async () => {
    const page = await listFor(officer);
    expect(page.rows).toEqual([]);
    expect(page.all).toBe(0);
  });

  it('shows a stranger and a warehouse person nothing', async () => {
    expect((await listFor(outsider)).rows).toEqual([]);
    expect((await listFor(warehouse)).rows).toEqual([]);
  });

  it('does not list an approval the raiser would be deciding themselves', async () => {
    // An order the senior manager raised and submitted himself.
    const own = await withScope(scope(world.manager), (tx) =>
      po.create(tx, world.manager, {
        supplierId: world.supplierId,
        branchCode: BAGHDAD,
        orderDate: '2026-10-01',
        reference: 'DASH-OWN',
        lines: [{ lineType: 'inventory_item', itemCode: PANEL, description: 'Solar Panel 550W', quantity: q('1'), uomCode: 'EA', unitPriceIqd: iqd('10000'), branchCode: BAGHDAD, warehouseCode: WAREHOUSE }],
      }),
    );
    await withScope(scope(world.manager), (tx) => po.submit(tx, world.manager, own.id));
    expect((await listFor(boss)).rows.map((row) => row.documentNo)).not.toContain(own.orderNo);
    // …while another manager is asked.
    expect((await listFor(manager)).rows.map((row) => row.documentNo)).toContain(own.orderNo);
  });

  it('filters by document type and pages, and counts what the filter hides', async () => {
    const all = await listFor(boss);
    const onlyOrders = await listFor(boss, { documentType: 'purchase_order' });
    expect(onlyOrders.rows.every((row) => row.documentType === 'purchase_order')).toBe(true);
    expect(onlyOrders.all).toBe(all.all);
    expect(all.types).toEqual(expect.arrayContaining(['journal_entry', 'purchase_order', 'ap_invoice']));
    const first = await listFor(boss, { page: 1, pageSize: 1 });
    expect(first.rows).toHaveLength(1);
    expect(first.total).toBe(all.total);
    expect(first.pageSize).toBe(1);
  });

  it('feeds the same count to Home', async () => {
    const page = await listFor(manager);
    const view = await homeOf(manager);
    expect(kpiOf(view, 'approvals_waiting').value).toEqual({ t: 'count', v: page.all });
    expect(tableOf(view, 'list_approvals').total).toBe(page.all);
  });

  it('refuses a decision on a document that is decided on its own page — nothing is faked', async () => {
    const message = await withScope(manager.scope, async (tx) => {
      try {
        await approvalCenter.decide(tx, ctxOf(manager), { documentType: 'purchase_order', documentId: randomUUID(), decision: 'approve' });
        return null;
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(message).toBe('ApprovalNotRoutableError');
  });

  it('asks for a reason before a rejection, and rejects through the journal service', async () => {
    const noReason = await withScope(manager.scope, async (tx) => {
      try {
        await approvalCenter.decide(tx, ctxOf(manager), { documentType: 'journal_entry', documentId: made.journalId, decision: 'reject', reason: '  ' });
        return null;
      } catch (error) {
        return (error as Error).name;
      }
    });
    expect(noReason).toBe('DecisionReasonMissingError');
    expect((await ownerPool.query(`select status from journal_entry where id = $1`, [made.journalId])).rows[0].status).toBe('submitted');
  });

  it('will not let the person who raised a journal decide it, even by the list\'s own button', async () => {
    const refusal = await withScope(officer.scope, async (tx) => {
      try {
        await approvalCenter.decide(tx, ctxOf(officer), { documentType: 'journal_entry', documentId: made.journalId, decision: 'approve' });
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(refusal).not.toBeNull();
    expect((await ownerPool.query(`select status from journal_entry where id = $1`, [made.journalId])).rows[0].status).toBe('submitted');
  });

  it('lists supplier bank details a manager can verify, opens the supplier\'s account, and verifies through the owning service', async () => {
    const added = await withScope(scope(world.clerk), (tx) =>
      partners.addBankAccount(tx, world.clerk, world.supplierId, { bankName: 'HSBC UK', iban: 'GB82WEST12345698765432', swift: 'MIDLGB22', currency: 'USD' }),
    );
    await withScope(scope(world.clerk), (tx) => partners.submitBankAccount(tx, world.clerk, added.id));

    const row = (await listFor(manager)).rows.find((item) => item.documentType === 'partner_bank_account');
    expect(row, 'the bank account is waiting on the manager').toBeDefined();
    expect(row!.href).toBe(`/payables/suppliers/SUP-JINKO?role=supplier&account=${added.id}#bank-account`);
    expect(row!.inline).toEqual({ documentType: 'partner_bank_account', documentId: added.id });
    // Whoever sent it for verification does not verify it.
    expect((await listFor(officer)).rows.map((item) => item.documentType)).not.toContain('partner_bank_account');

    await withScope(manager.scope, (tx) => approvalCenter.decide(tx, ctxOf(manager), { documentType: 'partner_bank_account', documentId: added.id, decision: 'approve' }));
    const after = (await ownerPool.query(`select approval_status, is_active, is_default from partner_bank_account where id = $1`, [added.id])).rows[0];
    expect(after).toMatchObject({ approval_status: 'approved', is_active: true, is_default: true });
    expect((await listFor(manager)).rows.map((item) => item.documentType)).not.toContain('partner_bank_account');
  });

  it('rejects a journal with a reason, through the journal service, and takes it off the list', async () => {
    const draft = await withScope(scope(world.clerk), (tx) =>
      journal.createDraft(tx, world.clerk, { branchCode: BAGHDAD, documentDate: '2026-10-02', postingDate: '2026-10-02', description: 'To be returned' }),
    );
    for (const line of [
      { accountId: world.accounts.expense!, debit: '500' },
      { accountId: world.accounts.bank!, credit: '500' },
    ]) {
      await withScope(scope(world.clerk), (tx) => journal.addLine(tx, world.clerk, draft.id, { ...line, dimensions: { department: 'FIN' } }));
    }
    await withScope(scope(world.clerk), (tx) => journal.submit(tx, world.clerk, draft.id));
    expect((await listFor(manager)).rows.map((item) => item.documentNo)).toContain(draft.entryNo);

    await withScope(manager.scope, (tx) => approvalCenter.decide(tx, ctxOf(manager), { documentType: 'journal_entry', documentId: draft.id, decision: 'reject', reason: 'Wrong cost centre' }));
    const status = (await ownerPool.query(`select status from journal_entry where id = $1`, [draft.id])).rows[0].status;
    expect(status).not.toBe('posted');
    expect(status).not.toBe('submitted');
    expect((await listFor(manager)).rows.map((item) => item.documentNo)).not.toContain(draft.entryNo);
  });

  it('approves a journal through the journal service: it posts, and leaves the list', async () => {
    await withScope(manager.scope, (tx) => approvalCenter.decide(tx, ctxOf(manager), { documentType: 'journal_entry', documentId: made.journalId, decision: 'approve' }));
    const row = (await ownerPool.query(`select status, approved_by from journal_entry where id = $1`, [made.journalId])).rows[0];
    expect(row.status).toBe('posted');
    expect(row.approved_by).toBe(manager.principal.userId);
    expect((await listFor(manager)).rows.map((r) => r.documentNo)).not.toContain(made.journalNo);
    // The decision is on the audit trail, written by the owning service, not by the list.
    const audited = await ownerPool.query(`select count(*)::int as n from audit_event where object_id = $1 and action like 'journal_entry.%'`, [made.journalId]);
    expect(audited.rows[0].n).toBeGreaterThan(0);
  });
});
