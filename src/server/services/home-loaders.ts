/**
 * What each Home widget reads — platform phase, Agent 2.
 *
 * One loader per widget key, run by `services/home.ts` **as the viewer**: the
 * transaction carries the signed-in person's scope, so row-level security and
 * the branch rule apply to every read, and each loader is given a savepoint of
 * its own so one failing read costs one widget.
 *
 * `LOADERS` is a `Record<WidgetKey, Loader>`: a widget added to the registry
 * without a loader is a type error, not a blank hole on somebody's page.
 *
 * ── What a loader is allowed to do ────────────────────────────────────────
 * * Call the service that already computes the figure (`dashboard.ts` for the
 *   bands the old Home drew, `logistics-views` for the import registers,
 *   `tasks`, `notifications`, `saved-views`, `chat-read`, `hr-reports`,
 *   `project-system`, `stock-operations`, `inventory-reports`). A figure the
 *   report behind it would compute differently is a defect, so there are few
 *   queries here, and each of them is a count or a short list over a table the
 *   widget's own grant covers.
 * * Answer with `domain/dashboard-data` shapes: typed cells, never formatted
 *   strings. Money is a decimal string at the ledger's scale and is summed and
 *   ordered as a scaled bigint.
 * * Say nothing it does not know. A read with no rows is `EMPTY`; a read that
 *   threw is `UNREADABLE` (the runner does that); a zero comes only from a
 *   successful count.
 *
 * ── The attention slot ────────────────────────────────────────────────────
 * `attention` is the Exception Center's place on Home. It is deliberately not
 * built in this wave: the loader below asks a registered `AttentionFeed` and
 * answers `UNWIRED` (the page does not draw it) until one is registered. The
 * contract is the one in RULES-PLATFORM §10; wiring it is one registration —
 * see `registerAttentionFeed`.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { documentHref } from '../../components/admin/document-link';
import { ageingBands, balanceRows, moneyOf, moneyString, monthStart, monthWindows, pairSeries, rankedRows, sumMoney } from '../domain/dashboard-charts';
import {
  EMPTY,
  READY,
  UNWIRED,
  chip,
  code,
  count,
  day,
  instant,
  money,
  qty,
  say,
  text,
  word,
  type Cell,
  type Column,
  type JourneyData,
  type TableRow,
  type WidgetOutcome,
} from '../domain/dashboard-data';
import type { WidgetKey } from '../domain/dashboard-widgets';
import { TASK_STATUS_TONE } from '../domain/tasks';
import { can, type Principal } from '../domain/permissions';
import { furthest, stagesFor, countByStage, type ImportFacts, type JourneyStage } from '../domain/import-journey';
import { parseQuantity } from '../domain/uom';
import * as approvalCenter from './approval-center';
import * as chatRead from './chat-read';
import * as dashboard from './dashboard';
import * as exceptions from './exceptions';
import * as hrReports from './hr-reports';
import * as inventoryReports from './inventory-reports';
import * as logistics from './logistics-views';
import * as notifications from './notifications';
import * as payables from './payables';
import * as projectSystem from './project-system';
import * as savedViews from './saved-views';
import * as stock from './stock-operations';
import * as tasks from './tasks';
import { rows as listRows } from './list';

export interface LoaderContext {
  readonly tx: Tx;
  readonly principal: Principal;
  /** The branch the person is working in. */
  readonly branchCode: string;
  /** The business day. */
  readonly today: string;
  readonly requestId?: string | null;
  /** One request's shared reads: widgets that draw the same figure pay for it once. */
  readonly memo: Map<string, unknown>;
}

export type Loader = (ctx: LoaderContext) => Promise<WidgetOutcome>;

/** A read shared by several widgets of one page. */
async function once<T>(ctx: LoaderContext, key: string, read: () => Promise<T>): Promise<T> {
  if (ctx.memo.has(key)) return ctx.memo.get(key) as T;
  const value = await read();
  ctx.memo.set(key, value);
  return value;
}

const actor = (ctx: LoaderContext) => ({ principal: ctx.principal, branchCode: ctx.branchCode });

// How many rows a list on Home shows: it is a window onto the register, which the link opens.
const ROWS = 8;

const kpi = (value: Cell, href: string | null, options: { note?: { key: string; values?: Record<string, string | number> }; tone?: 'warn' | null } = {}): WidgetOutcome =>
  READY({ kind: 'kpi', value, note: options.note ?? null, href, tone: options.tone ?? null });

const table = (
  columns: readonly Column[],
  rows: readonly TableRow[],
  total: number,
  href: string | null,
  note: { key: string; values?: Record<string, string | number> } | null = null,
): WidgetOutcome => (rows.length === 0 ? EMPTY : READY({ kind: 'table', columns, rows, total, href, note }));

/** An item as people say it: its code and its name, or the code alone when it has no name. */
const itemCell = (itemCode: string, itemName: string | null | undefined): Cell =>
  itemName ? say('item_line', { code: itemCode, name: itemName }) : code(itemCode);

const col = (key: string, numeric = false): Column => (numeric ? { key, numeric: true } : { key });
const link = (path: string, no: string) => `${path}/${encodeURIComponent(no)}`;

// ---------------------------------------------------------------------------
// Shared reads
// ---------------------------------------------------------------------------

const receivable = (ctx: LoaderContext) =>
  once(ctx, 'receivable', () => dashboard.receivableAgeing(ctx.tx, ctx.branchCode, ctx.today));
const payable = (ctx: LoaderContext) => once(ctx, 'payable', () => dashboard.payableAgeing(ctx.tx, ctx.branchCode, ctx.today));
const balances = (ctx: LoaderContext) => once(ctx, 'balances', () => dashboard.balances(ctx.tx, ctx.today));
const stockByHouse = (ctx: LoaderContext) => once(ctx, 'stock', () => dashboard.stockByWarehouse(ctx.tx, ctx.principal));
const approvalsOf = (ctx: LoaderContext) => once(ctx, 'approvals', () => approvalCenter.items(ctx.tx, ctx));
const hr = (ctx: LoaderContext) => once(ctx, 'hr', () => hrReports.dashboard(ctx.tx, { principal: ctx.principal }));
const taskSummary = (ctx: LoaderContext) => once(ctx, 'tasks', () => tasks.dashboardSummary(ctx.tx, { principal: ctx.principal }, ctx.today));
const tracking = (ctx: LoaderContext) =>
  once(ctx, 'tracking', async () => (await logistics.shipmentTracking(ctx.tx, { view: 'open', asOf: ctx.today })).rows);
const landedRows = (ctx: LoaderContext) => once(ctx, 'landed', async () => (await logistics.landedCostsRegister(ctx.tx, { view: 'all' })).rows);

// ── The imports in progress, read once ─────────────────────────────────────

interface ImportRow {
  readonly facts: ImportFacts;
  readonly supplierName: string;
  readonly stageName: string;
  readonly amountIqd: string;
  readonly containersTotal: number;
  readonly containersReceived: number;
  readonly onHold: boolean;
}

interface ImportsRead {
  readonly stages: readonly JourneyStage[];
  readonly rows: readonly ImportRow[];
  /** Imports the viewer has, of every stage; `rows` are the ones still in progress among those read. */
  readonly total: number;
  readonly read: number;
}

/** The rail's terminal stage: an import that has reached it is finished work, not work in progress. */
const FINISHED_STAGE = 'cleared';
const IMPORT_PAGE = 100;
const IMPORT_PAGES = 5;

/**
 * The imports in progress and what the logistics services know about each —
 * `payables.workbench` for the list and the rail's own stage, the Shipments
 * register for B/Ls, containers and declarations, the Landed Costs register for
 * charges and received stock. Each register is read only if the viewer may read
 * its evidence; a step they cannot read is dropped from `stages`.
 */
async function importsRead(ctx: LoaderContext): Promise<ImportsRead> {
  return once(ctx, 'imports', async () => {
    const stages = stagesFor(ctx.principal);
    const read: Awaited<ReturnType<typeof payables.workbench>>['rows'] = [];
    let total = 0;
    for (let page = 1; page <= IMPORT_PAGES; page += 1) {
      const result = await payables.workbench(ctx.tx, { typeCode: 'import', page, pageSize: IMPORT_PAGE });
      total = result.total;
      read.push(...result.rows);
      if (read.length >= total || result.rows.length === 0) break;
    }
    const open = read.filter((row) => row.stageCode !== FINISHED_STAGE);

    const shipments = new Map<string, logistics.ShipmentRow>();
    if (can(ctx.principal, 'view', 'bill_of_lading') && can(ctx.principal, 'view', 'shipment_container') && open.length > 0) {
      const page = await logistics.shipmentsRegister(ctx.tx, { view: 'all', page: 1, pageSize: IMPORT_PAGE * IMPORT_PAGES });
      for (const row of page.rows) shipments.set(row.payableId, row);
    }
    const landed = new Map<string, logistics.LandedCostRow>();
    if (can(ctx.principal, 'view', 'landed_cost_register') && open.length > 0) {
      for (const row of await landedRows(ctx)) landed.set(row.payableId, row);
    }
    // PDs may stand before any B/L exists, so they are read by the payable, not through the B/L-based register.
    const standing = new Map<string, number>();
    if (can(ctx.principal, 'view', 'customs_pd') && open.length > 0) {
      const pds = await ctx.tx.execute(sql`
        select d.payable_id::text as id, count(*)::int as n
          from customs_pd d
         where not exists (select 1 from customs_pd s where s.supersedes_pd_id = d.id)
         group by d.payable_id`);
      for (const row of pds.rows as { id: string; n: number }[]) standing.set(row.id, row.n);
    }

    const rows = open.map((row): ImportRow => {
      const shipment = shipments.get(row.id);
      const cost = landed.get(row.id);
      const facts: ImportFacts = {
        payableNo: row.payableNo,
        stageCode: row.stageCode,
        blCount: shipment?.blCount ?? 0,
        containerCount: shipment?.containerCount ?? row.containersTotal,
        containersReceived: shipment?.received ?? row.containersReceived,
        departed: Boolean(shipment?.firstDeparted),
        standingPds: standing.get(row.id) ?? 0,
        clearedDeclarations: shipment?.clearedDeclarations ?? 0,
        liveCharges: cost ? cost.liveCharges : null,
        receivedQty: cost ? cost.receivedQty : null,
      };
      return {
        facts,
        supplierName: row.supplierName,
        stageName: row.stageName,
        amountIqd: row.amountIqd,
        containersTotal: row.containersTotal,
        containersReceived: row.containersReceived,
        onHold: row.onHold,
      };
    });
    return { stages, rows, total, read: read.length };
  });
}

// ---------------------------------------------------------------------------
// The attention slot
// ---------------------------------------------------------------------------

/** One row the Exception Center hands Home (RULES-PLATFORM §10), already filtered to what the principal may see. */
export interface AttentionRow {
  readonly id: string;
  readonly no: string;
  readonly severity: string;
  readonly domain: string;
  readonly title: string;
  readonly explanation: string;
  readonly recordType: string | null;
  readonly recordId: string | null;
  readonly href: string | null;
  readonly createdAt: Date | string;
  readonly ownerName: string | null;
}

export interface AttentionCounts {
  readonly total: number;
  readonly bySeverity: Readonly<Record<string, number>>;
  readonly byDomain: Readonly<Record<string, number>>;
}

export interface AttentionFeed {
  open(tx: Tx, principal: Principal, options: { limit?: number }): Promise<readonly AttentionRow[]>;
  counts(tx: Tx, principal: Principal): Promise<AttentionCounts>;
}

let attentionFeed: AttentionFeed | null = null;

/**
 * Where the Exception Center plugs in. After the merge, one registration:
 *
 *   import * as exceptions from './exceptions';
 *   registerAttentionFeed({
 *     open: (tx, principal, options) => exceptions.openFor(tx, principal, options),
 *     counts: (tx, principal) => exceptions.countsFor(tx, principal),
 *   });
 *
 * placed at the bottom of this file. Until then `attention` answers `UNWIRED`
 * and the page draws nothing for it. Pass `null` to unregister (tests).
 */
export function registerAttentionFeed(feed: AttentionFeed | null): void {
  attentionFeed = feed;
}

async function loadAttention(ctx: LoaderContext): Promise<WidgetOutcome> {
  if (!attentionFeed) return UNWIRED;
  const rows = await attentionFeed.open(ctx.tx, ctx.principal, { limit: ROWS });
  const counts = await attentionFeed.counts(ctx.tx, ctx.principal);
  return table(
    [col('severity'), col('exception'), col('domain'), col('since')],
    rows.map((row) => ({
      key: row.id,
      href: row.href,
      cells: [word(row.severity, 'home.severity'), text(row.title), word(row.domain, 'home.domain'), instant(new Date(row.createdAt).toISOString())],
    })),
    counts.total,
    '/exceptions',
  );
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const LOADERS_BY_KEY: Record<WidgetKey, Loader> = {
  // ── Primary figures ──────────────────────────────────────────────────────
  async approvals_waiting(ctx) {
    const found = await approvalsOf(ctx);
    return kpi(count(found.items.length), '/approvals', found.failed.length > 0 ? { note: { key: 'partial' } } : {});
  },

  async cash_position(ctx) {
    const accounts = await balances(ctx);
    if (accounts.length === 0) return EMPTY;
    return kpi(money(moneyString(sumMoney(accounts.map((a) => a.balanceIqd)))), '/master-data/bank-accounts', {
      note: { key: 'accounts', values: { count: accounts.length } },
    });
  },

  async receivable_total(ctx) {
    const ageing = await receivable(ctx);
    if (ageing.invoices === 0) return EMPTY;
    return kpi(money(ageing.totalIqd), '/sales/ar-invoices', { note: { key: 'open_invoices', values: { count: ageing.invoices } } });
  },

  async payable_total(ctx) {
    const ageing = await payable(ctx);
    if (ageing.invoices === 0) return EMPTY;
    return kpi(money(ageing.totalIqd), '/payables/invoices', { note: { key: 'open_invoices', values: { count: ageing.invoices } } });
  },

  async overdue_receivables(ctx) {
    const ageing = await receivable(ctx);
    if (ageing.invoices === 0) return EMPTY;
    return kpi(money(ageing.overdueIqd), '/sales/ar-invoices', { tone: moneyOf(ageing.overdueIqd) > 0n ? 'warn' : null });
  },

  async overdue_payables(ctx) {
    const ageing = await payable(ctx);
    if (ageing.invoices === 0) return EMPTY;
    return kpi(money(ageing.overdueIqd), '/payables/invoices', { tone: moneyOf(ageing.overdueIqd) > 0n ? 'warn' : null });
  },

  async inventory_value(ctx) {
    const houses = await stockByHouse(ctx);
    if (houses.length === 0) return EMPTY;
    return kpi(money(moneyString(sumMoney(houses.map((h) => h.amountIqd)))), '/inventory/valuation', {
      note: { key: 'warehouses', values: { count: houses.length } },
    });
  },

  async net_result(ctx) {
    const result = await once(ctx, 'result', async () => {
      const { profitOrLoss } = await import('./financial-statements');
      return profitOrLoss(ctx.tx, { from: `${ctx.today.slice(0, 4)}-01-01`, to: ctx.today, branchCode: ctx.branchCode, currency: 'IQD' });
    });
    if (moneyOf(result.totalIncome) === 0n && moneyOf(result.totalExpenses) === 0n) return EMPTY;
    return kpi(money(result.result), '/finance/income-statement', { tone: moneyOf(result.result) < 0n ? 'warn' : null });
  },

  async pending_payments(ctx) {
    const result = await ctx.tx.execute(sql`
      select count(*) filter (where status in ('draft', 'submitted'))::int as draft, count(*) filter (where status = 'approved')::int as approved
        from payment_application`);
    const row = result.rows[0] as { draft: number; approved: number };
    return kpi(count(row.draft + row.approved), '/payables/payment-applications', { note: { key: 'pending_split', values: { draft: row.draft, approved: row.approved } } });
  },

  async imports_in_progress(ctx) {
    const imports = await importsRead(ctx);
    const late = (await tracking(ctx)).filter((row) => row.statusCode === 'late').length;
    return kpi(count(imports.rows.length), '/payables?type=import', {
      note: late > 0 ? { key: 'containers_late', values: { count: late } } : { key: 'of_imports', values: { total: imports.total } },
      tone: late > 0 ? 'warn' : null,
    });
  },

  async warehouse_today(ctx) {
    const moved = await stock.countMovements(ctx.tx, actor(ctx), { from: ctx.today, to: ctx.today });
    return kpi(count(moved), '/inventory/stock-movements');
  },

  async purchasing_open(ctx) {
    const result = await ctx.tx.execute(sql`
      select count(*) filter (where status in ('approved', 'partially_executed'))::int as open,
             count(*) filter (where status = 'submitted')::int as submitted
        from purchase_order`);
    const row = result.rows[0] as { open: number; submitted: number };
    return kpi(count(row.open), '/payables/purchase-orders', { note: { key: 'orders_submitted', values: { count: row.submitted } } });
  },

  async sales_period(ctx) {
    const result = await ctx.tx.execute(sql`
      select coalesce(sum(net_iqd), 0)::text as total, count(*)::int as n
        from ar_invoice
       where branch_code = ${ctx.branchCode} and status in ('posted', 'partially_executed', 'settled')
         and invoice_date >= ${monthStart(ctx.today)}::date and invoice_date <= ${ctx.today}::date`);
    const row = result.rows[0] as { total: string; n: number };
    if (row.n === 0) return EMPTY;
    return kpi(money(moneyString(moneyOf(row.total))), '/sales/ar-invoices', { note: { key: 'invoices_this_month', values: { count: row.n } } });
  },

  async hr_overview(ctx) {
    const figures = await hr(ctx);
    return kpi(count(figures.headcount), '/hr/dashboard', {
      note: { key: 'hr_note', values: { onLeave: figures.onLeaveToday.length, waiting: figures.leaveWaiting } },
    });
  },

  async projects_overview(ctx) {
    const active = await projectSystem.list(ctx.tx, { status: 'active', pageSize: 1 });
    const all = await projectSystem.list(ctx.tx, { pageSize: 1 });
    if (all.total === 0) return EMPTY;
    return kpi(count(active.total), '/projects', { note: { key: 'of_projects', values: { total: all.total } } });
  },

  async tasks_mine(ctx) {
    const summary = await taskSummary(ctx);
    return kpi(count(summary.mine.open), '/tasks', {
      note: { key: 'tasks_note', values: { overdue: summary.mine.overdue, today: summary.mine.dueToday } },
      tone: summary.mine.overdue > 0 ? 'warn' : null,
    });
  },

  async notifications_unread(ctx) {
    return kpi(count(await notifications.unreadCountFor(ctx.tx, ctx.principal.userId)), '/notifications');
  },

  async chat_unread(ctx) {
    return kpi(count(await chatRead.unreadBadge(ctx.tx, actor(ctx))), '/chat');
  },

  // ── Trends ───────────────────────────────────────────────────────────────
  async chart_trading(ctx) {
    const months = await once(ctx, 'monthly', () => dashboard.monthlyResult(ctx.tx, ctx.branchCode, ctx.today, 12));
    const points = pairSeries(months.map((m) => ({ month: m.month, first: m.incomeIqd, second: m.expensesIqd })));
    if (!points) return EMPTY;
    return READY({
      kind: 'chart',
      chart: { type: 'columns', firstKey: 'income', secondKey: 'expenses', points },
      note: { key: 'last_months', values: { count: months.length } },
      href: '/finance/income-statement',
      wide: true,
    });
  },

  async chart_receivable_ageing(ctx) {
    const ageing = await receivable(ctx);
    const rows = ageingBands(ageing);
    if (rows.length === 0) return EMPTY;
    return READY({ kind: 'chart', chart: { type: 'stack', rows }, note: null, href: '/sales/ar-invoices', wide: false });
  },

  async chart_payable_ageing(ctx) {
    const ageing = await payable(ctx);
    const rows = ageingBands(ageing);
    if (rows.length === 0) return EMPTY;
    return READY({ kind: 'chart', chart: { type: 'stack', rows }, note: null, href: '/payables/invoices', wide: false });
  },

  async chart_cash_accounts(ctx) {
    const accounts = await balances(ctx);
    const rows = balanceRows(accounts.map((a) => ({ key: a.code, label: a.name, amount: a.balanceIqd })), 8);
    if (rows.length === 0) return EMPTY;
    return READY({
      kind: 'chart',
      chart: { type: 'bars', unit: 'money', rows: rows.map((r) => ({ key: r.key, label: r.label, labelKey: false, value: r.amount })) },
      note: null,
      href: '/master-data/bank-accounts',
      wide: false,
    });
  },

  async chart_sales_trend(ctx) {
    const windows = monthWindows(ctx.today, 6);
    const result = await ctx.tx.execute(sql`
      select to_char(invoice_date, 'YYYY-MM') as month, coalesce(sum(net_iqd), 0)::text as invoiced, coalesce(sum(allocated_iqd), 0)::text as collected
        from ar_invoice
       where branch_code = ${ctx.branchCode} and status in ('posted', 'partially_executed', 'settled')
         and invoice_date >= ${windows[0]!.from}::date and invoice_date <= ${ctx.today}::date
       group by 1`);
    const byMonth = new Map((result.rows as { month: string; invoiced: string; collected: string }[]).map((r) => [r.month, r]));
    const points = pairSeries(
      windows.map((w) => ({ month: w.month, first: byMonth.get(w.month)?.invoiced ?? '0', second: byMonth.get(w.month)?.collected ?? '0' })),
    );
    if (!points) return EMPTY;
    return READY({
      kind: 'chart',
      chart: { type: 'columns', firstKey: 'invoiced', secondKey: 'collected', points },
      note: { key: 'last_months', values: { count: windows.length } },
      href: '/sales/ar-invoices',
      wide: false,
    });
  },

  async chart_top_customers(ctx) {
    const rows = rankedRows(
      (await dashboard.topCustomers(ctx.tx, ctx.branchCode, `${ctx.today.slice(0, 4)}-01-01`, ctx.today)).map((r) => ({ key: r.key, label: r.label, amount: r.amountIqd })),
      8,
    );
    if (rows.length === 0) return EMPTY;
    return READY({
      kind: 'chart',
      chart: { type: 'bars', unit: 'money', rows: rows.map((r) => ({ key: r.key, label: r.label, labelKey: false, value: r.amount })) },
      note: { key: 'year_to_date' },
      href: '/sales/ar-invoices',
      wide: false,
    });
  },

  async chart_stock_value(ctx) {
    const rows = rankedRows((await stockByHouse(ctx)).map((r) => ({ key: r.key, label: r.label, amount: r.amountIqd })), 8);
    if (rows.length === 0) return EMPTY;
    return READY({
      kind: 'chart',
      chart: { type: 'bars', unit: 'money', rows: rows.map((r) => ({ key: r.key, label: r.label, labelKey: false, value: r.amount })) },
      note: { key: 'at_cost' },
      href: '/inventory/valuation',
      wide: false,
    });
  },

  async chart_import_stages(ctx) {
    const imports = await importsRead(ctx);
    if (imports.rows.length === 0 || imports.stages.length === 0) return EMPTY;
    const data: JourneyData = {
      kind: 'journey',
      stages: countByStage(imports.rows.map((r) => r.facts), imports.stages),
      inProgress: imports.rows.length,
      read: imports.read,
      total: imports.total,
      href: '/payables?type=import',
    };
    return READY(data);
  },

  // ── What can be acted on ─────────────────────────────────────────────────
  attention: loadAttention,

  async list_approvals(ctx) {
    const found = await approvalsOf(ctx);
    return table(
      [col('document'), col('type'), col('requested_by'), col('since'), col('amount', true), col('action')],
      found.items.slice(0, ROWS).map((item) => ({
        key: item.id,
        href: item.href,
        cells: [
          code(item.documentNo),
          word(`type_${item.documentType}`, 'admin.approvals'),
          text(item.requester),
          instant(item.since),
          item.amount ? money(item.amount.value, item.amount.currency) : ({ t: 'none' } as Cell),
          word(`action_${item.action}`, 'admin.approvals'),
        ],
      })),
      found.items.length,
      '/approvals',
    );
  },

  async list_tasks(ctx) {
    const summary = await taskSummary(ctx);
    return table(
      [col('task'), col('due'), col('priority'), col('status')],
      summary.next.map((task) => ({
        key: task.taskNo,
        href: task.href,
        cells: [
          say('task_line', { no: task.taskNo, title: task.title }),
          day(task.dueDate),
          word(`priority_${task.priority}`, 'admin.tasks'),
          chip(`status_${task.status}`, 'admin.tasks', TASK_STATUS_TONE[task.status] ?? 'draft'),
        ],
      })),
      summary.mine.open,
      '/tasks',
    );
  },

  async list_pinned_views(ctx) {
    const pinned = await savedViews.pinnedFor(ctx.tx, ctx.principal, { branchCode: ctx.branchCode, today: ctx.today });
    return table(
      [col('view'), col('rows', true)],
      pinned.map((view) => ({
        key: view.id,
        href: view.available ? view.href : null,
        cells: [text(view.title), view.available ? (view.count === null ? ({ t: 'none' } as Cell) : count(view.count)) : word('unavailable')],
      })),
      pinned.length,
      null,
    );
  },

  async list_major_imports(ctx) {
    const imports = await importsRead(ctx);
    const biggest = [...imports.rows].sort((a, b) => (moneyOf(a.amountIqd) === moneyOf(b.amountIqd) ? 0 : moneyOf(a.amountIqd) > moneyOf(b.amountIqd) ? -1 : 1)).slice(0, ROWS);
    return table(
      [col('import'), col('supplier'), col('stage'), col('reached'), col('containers'), col('amount', true)],
      biggest.map((row) => {
        const where = furthest(row.facts, imports.stages);
        return {
          key: row.facts.payableNo,
          href: link('/payables', row.facts.payableNo),
          cells: [
            code(row.facts.payableNo),
            text(row.supplierName),
            text(row.stageName),
            where ? word(where, 'home.journey') : ({ t: 'none' } as Cell),
            say('containers_of', { received: row.containersReceived, total: row.containersTotal }),
            money(row.amountIqd),
          ],
        };
      }),
      imports.rows.length,
      '/payables?type=import',
    );
  },

  async list_payments_due(ctx) {
    const result = await ctx.tx.execute(sql`
      select p.payable_no as "no", bp.legal_name as "supplier", p.due_date::text as "due", p.amount_txn::text as "amount", p.currency,
             (count(*) over())::int as "total"
        from payable p join business_partner bp on bp.id = p.supplier_id
       where p.due_date between ${ctx.today}::date and ${ctx.today}::date + 7
         and p.cancelled_at is null and p.closed_at is null and p.stage_code not in ('paid', 'closed')
       order by p.due_date, p.payable_no
       limit ${ROWS}`);
    const rows = result.rows as { no: string; supplier: string; due: string; amount: string; currency: string; total: number }[];
    return table(
      [col('payable'), col('supplier'), col('due'), col('amount', true)],
      rows.map((r) => ({ key: r.no, href: link('/payables', r.no), cells: [code(r.no), text(r.supplier), day(r.due), money(r.amount, r.currency)] })),
      rows[0]?.total ?? 0,
      '/payables',
    );
  },

  async list_delayed_containers(ctx) {
    const late = (await tracking(ctx)).filter((row) => row.statusCode === 'late');
    return table(
      [col('container'), col('import'), col('supplier'), col('eta'), col('days_late', true)],
      late.slice(0, ROWS).map((row) => ({
        key: row.id,
        href: `/logistics/shipment-tracking?q=${encodeURIComponent(row.containerNo)}`,
        cells: [code(row.containerNo), code(row.payableNo), text(row.supplierName), day(row.eta), count(row.delayDays ?? 0)],
      })),
      late.length,
      '/logistics/shipment-tracking',
    );
  },

  async list_customs_actions(ctx) {
    const todo = (await tracking(ctx)).filter((row) => row.nextAction === 'clear_customs' || row.nextAction === 'send_port_file');
    return table(
      [col('container'), col('import'), col('status'), col('next_step')],
      todo.slice(0, ROWS).map((row) => ({
        key: row.id,
        href: `/logistics/shipment-tracking?q=${encodeURIComponent(row.containerNo)}`,
        cells: [code(row.containerNo), code(row.payableNo), text(row.statusName), word(row.nextAction, 'admin.logistics.na')],
      })),
      todo.length,
      '/logistics/shipment-tracking',
    );
  },

  async list_landed_cost_blocks(ctx) {
    const rows = (await landedRows(ctx)).filter((row) => row.unlockedCharges > 0);
    return table(
      [col('import'), col('supplier'), col('state'), col('unlocked', true)],
      rows.slice(0, ROWS).map((row) => ({
        key: row.payableId,
        href: link('/payables', row.payableNo),
        cells: [code(row.payableNo), text(row.supplierName), word(row.state, 'admin.logistics.lr'), money(row.unlockedIqd)],
      })),
      rows.length,
      '/logistics/landed-costs',
    );
  },

  async list_in_transit(ctx) {
    const rows = (await logistics.inTransitInventory(ctx.tx, { view: 'open' })).rows.filter((row) => parseQuantity(row.inTransit) > 0n);
    return table(
      [col('import'), col('item'), col('in_transit', true), col('containers')],
      rows.slice(0, ROWS).map((row) => ({
        key: `${row.payableId}:${row.itemCode}`,
        href: link('/payables', row.payableNo),
        cells: [code(row.payableNo), itemCell(row.itemCode, row.itemName), qty(row.inTransit), say('containers_of', { received: row.containers - row.containersOpen, total: row.containers })],
      })),
      rows.length,
      '/logistics/in-transit',
    );
  },

  async list_pending_receipts(ctx) {
    const ready = (await tracking(ctx)).filter((row) => row.nextAction === 'receive');
    return table(
      [col('container'), col('import'), col('warehouse'), col('cleared_on')],
      ready.slice(0, ROWS).map((row) => ({
        key: row.id,
        href: `/logistics/shipment-tracking?q=${encodeURIComponent(row.containerNo)}`,
        cells: [code(row.containerNo), code(row.payableNo), code(row.warehouseCode), day(row.customsClearedOn)],
      })),
      ready.length,
      '/logistics/shipment-tracking',
    );
  },

  async list_low_stock(ctx) {
    const result = await ctx.tx.execute(sql`
      with ledger as (
        select m.warehouse_code, m.item_code, sum(m.quantity) as quantity from inventory_movement m group by 1, 2
      )
      select g.item_code as "itemCode", i.name as "itemName", g.warehouse_code as "warehouseCode",
             g.quantity::text as "onHand", i.min_stock_level::text as "minimum", (count(*) over())::int as "total"
        from ledger g
        join item i on i.code = g.item_code
        join warehouse w on w.code = g.warehouse_code
       where w.active and not w.is_transit ${ctx.principal.isSuperUser ? sql`` : sql`and app_branch_allowed(w.branch_code)`}
         and i.min_stock_level is not null and g.quantity <= i.min_stock_level
       order by (g.quantity - i.min_stock_level), g.item_code, g.warehouse_code
       limit ${ROWS}`);
    const rows = result.rows as { itemCode: string; itemName: string; warehouseCode: string; onHand: string; minimum: string; total: number }[];
    return table(
      [col('item'), col('warehouse'), col('on_hand', true), col('minimum', true)],
      rows.map((r) => ({
        key: `${r.itemCode}:${r.warehouseCode}`,
        href: `/inventory/availability?q=${encodeURIComponent(r.itemCode)}`,
        cells: [itemCell(r.itemCode, r.itemName), code(r.warehouseCode), qty(r.onHand), qty(r.minimum)],
      })),
      rows[0]?.total ?? 0,
      '/inventory/availability',
    );
  },

  async list_todays_movements(ctx) {
    const filter = { from: ctx.today, to: ctx.today };
    const total = await stock.countMovements(ctx.tx, actor(ctx), filter);
    const rows = total === 0 ? [] : await stock.movements(ctx.tx, actor(ctx), { ...filter, limit: ROWS });
    return table(
      [col('item'), col('warehouse'), col('movement'), col('quantity', true), col('document')],
      rows.map((row) => ({
        key: row.id,
        href: documentHref(row.documentType, row.documentNo),
        cells: [
          itemCell(row.itemCode, row.itemName),
          code(row.warehouseCode),
          word(row.type, 'admin.stock_movements.type'),
          qty(row.signedQuantity),
          code(row.documentNo),
        ],
      })),
      total,
      '/inventory/stock-movements',
    );
  },

  async list_open_orders(ctx) {
    const result = await ctx.tx.execute(sql`
      select o.order_no as "no", bp.legal_name as "supplier", o.expected_date::text as "expected", o.currency,
             (select round(sum(greatest(l.quantity - l.received_quantity - l.closed_quantity, 0) * l.unit_price), 4)::text
                from purchase_order_line l where l.purchase_order_id = o.id) as "open",
             (count(*) over())::int as "total"
        from purchase_order o join business_partner bp on bp.id = o.supplier_id
       where o.status in ('approved', 'partially_executed')
       order by o.expected_date nulls last, o.order_no
       limit ${ROWS}`);
    const rows = result.rows as { no: string; supplier: string; expected: string | null; currency: string; open: string | null; total: number }[];
    return table(
      [col('order'), col('supplier'), col('expected'), col('open_value', true)],
      rows.map((r) => ({ key: r.no, href: link('/payables/purchase-orders', r.no), cells: [code(r.no), text(r.supplier), day(r.expected), money(r.open, r.currency)] })),
      rows[0]?.total ?? 0,
      '/payables/purchase-orders',
    );
  },

  async list_on_leave(ctx) {
    const figures = await hr(ctx);
    return table(
      [col('request'), col('employee'), col('leave_type'), col('until')],
      figures.onLeaveToday.slice(0, ROWS).map((r) => ({
        key: r.requestNo,
        href: link('/hr/leave', r.requestNo),
        cells: [code(r.requestNo), text(r.fullNameEn), text(r.typeNameEn), day(r.toDate)],
      })),
      figures.onLeaveToday.length,
      '/hr/leave',
    );
  },

  async list_projects(ctx) {
    const result = await projectSystem.list(ctx.tx, { status: 'active', pageSize: ROWS });
    return table(
      [col('project'), col('manager'), col('ends'), col('available', true)],
      result.rows.map((r) => ({
        key: r.code,
        href: link('/projects', r.code),
        cells: [itemCell(r.code, r.name), text(r.managerName), day(r.baselineEndsOn), money(r.availableIqd)],
      })),
      result.total,
      '/projects',
    );
  },

  async list_unread_notifications(ctx) {
    const page = await notifications.listFor(ctx.tx, ctx.principal.userId, { state: 'unread', page: 1, pageSize: ROWS });
    return table(
      [col('notification'), col('since')],
      page.rows.map((n) => ({ key: n.id, href: `/notifications/open/${n.id}`, cells: [text(n.subject), instant(n.createdAt.toISOString())] })),
      page.total,
      '/notifications',
    );
  },

  async list_findings(ctx) {
    const found = await dashboard.attentionFor(ctx.tx, ctx.principal, ctx.branchCode);
    const rows: TableRow[] = [
      ...found.integrityFindings.map((finding, index) => ({ key: `i${index}`, href: '/inventory/stock-ledger', cells: [text(finding), word('stock_ledger')] })),
      ...(found.unidentifiedReceipts > 0
        ? [{ key: 'receipts', href: '/sales/customer-receipts', cells: [say('unidentified_receipts', { count: found.unidentifiedReceipts }), word('receipts')] }]
        : []),
      ...found.accountsWithoutLedger.map((accountCode) => ({ key: `a${accountCode}`, href: '/master-data/bank-accounts', cells: [say('account_without_ledger', { code: accountCode }), word('bank_accounts')] })),
    ];
    return table([col('finding'), col('where_fixed')], rows, rows.length, null);
  },

  async list_activity(ctx) {
    const page = await listRows(ctx.tx, ctx.principal, 'audit_event', { page: 1, pageSize: ROWS }, { withTotal: false });
    return table(
      [col('when'), col('type'), col('event'), col('actor'), col('outcome')],
      page.rows.map((row, index) => ({
        key: `${String(row.occurred_at ?? '')}-${index}`,
        href: null,
        // "Approved" alone does not say what was approved: the record's kind (the audit screen's own words) comes first.
        cells: [instant(String(row.occurred_at ?? '')), word(String(row.action ?? '').split('.')[0], 'admin.audit.kinds'), word(String(row.action ?? ''), 'audit_action'), text(String(row.actor ?? '—')), word(String(row.outcome ?? ''), 'admin.audit.outcome')],
      })),
      page.rows.length,
      '/administration/audit',
    );
  },
};

export const LOADERS: Readonly<Record<WidgetKey, Loader>> = LOADERS_BY_KEY;

// The Exception Center's feed (RULES-PLATFORM §10), registered here when the two branches met: the `attention` widget
// draws exactly what `exceptions.openFor/countsFor` hand the principal.
registerAttentionFeed({
  open: (tx, principal, options) => exceptions.openFor(tx, principal, options),
  counts: (tx, principal) => exceptions.countsFor(tx, principal),
});
