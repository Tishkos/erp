import { formatBusinessDate } from '@/i18n/config';
import { businessToday } from '../domain/business-date';
import * as pe from '../services/project-execution';
import * as psch from '../services/project-schedule';
import * as ps from '../services/project-system';
import type { BuildContext, Built } from './documents';
import { EXPORT_ROW_CAP, type Column, type Fact, type PrintModel, type Row } from './model';

/**
 * REQ-PM-001 §13–§14, PM13 — the Project System's four reports, built from
 * the services the screens read and printed and exported through the ERP's
 * own renderers: the hierarchy cost report (the WBS with its five amounts
 * rolled up), the line items, the milestone trend analysis and the
 * earned-value report. The Reports screen draws the same models, so the
 * screen and the copy cannot state different figures.
 */
type Query = URLSearchParams;

/** The cost kinds with words of their own; anything else prints as written. */
const COST_KINDS = new Set(['invoice', 'invoice_reversal', 'material_issue', 'material_return', 'project_issue', 'project_return', 'labour']);

export const PROJECT_REPORTS = ['cost', 'lines', 'trend', 'ev'] as const;
export type ProjectReport = (typeof PROJECT_REPORTS)[number];

/** Which export key each report prints under. */
export const PROJECT_REPORT_KEY = {
  cost: 'project_cost_report',
  lines: 'project_line_items',
  trend: 'project_milestone_trend',
  ev: 'project_earned_value',
} as const satisfies Record<ProjectReport, string>;

const dateOf = (query: Query, name: string, fallback: string) => {
  const value = (query.get(name) ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
};

async function header(ctx: BuildContext, query: Query) {
  const code = (query.get('project') ?? '').trim();
  if (!code) return null;
  try {
    const project = await ps.record(ctx.tx, { principal: ctx.principal, branchCode: ctx.branchCode }, code);
    return { code, name: project.project.name, branchCode: project.project.branchCode ?? ctx.branchCode };
  } catch {
    return null;
  }
}

const model = (input: Pick<PrintModel, 'title' | 'filters' | 'tables'> & { fileName: string; orientation?: 'portrait' | 'landscape' }): PrintModel => ({
  kind: 'report',
  fields: [],
  summary: [],
  signatures: false,
  currency: 'IQD',
  orientation: input.orientation ?? 'landscape',
  sheetName: input.title.slice(0, 31),
  ...input,
});

const filters = (ctx: BuildContext, head: { code: string; name: string }, extra: Fact[] = []): Fact[] => [{ label: ctx.m.admin('projects.project'), value: `${head.code} · ${head.name}`, ltr: false }, ...extra];

/** The WBS with its budget, committed, actual and available rolled up the tree — as the WBS workspace shows them. */
export async function costReport(ctx: BuildContext, query: Query): Promise<Built | null> {
  const head = await header(ctx, query);
  if (!head) return null;
  const { m } = ctx;
  const tree = await ps.tree(ctx.tx, head.code);
  const root = tree.find((e) => e.level === 1);
  const columns: Column[] = [
    { key: 'element', label: m.admin('projects.element'), kind: 'code' },
    { key: 'name', label: m.column('name'), kind: 'text', weight: 1.8 },
    { key: 'budget', label: m.admin('projects.budget'), kind: 'money' },
    { key: 'committed', label: m.admin('projects.committed'), kind: 'money' },
    { key: 'actual', label: m.admin('projects.actual'), kind: 'money' },
    { key: 'available', label: m.admin('projects.available'), kind: 'money' },
  ];
  const rows: Row[] = tree.map((e) => ({
    depth: e.level - 1,
    tone: tree.some((c) => c.parentCode === e.code) ? 'header' : 'line',
    // Each row carries its subtree's sum; the total is the root's, not a sum of rows.
    counts: false,
    cells: { element: e.code, name: e.name, budget: e.budgetIqd, committed: e.committedIqd, actual: e.actualIqd, available: e.availableIqd },
  }));
  return {
    model: model({
      title: m.print('titles.project_cost_report'),
      filters: filters(ctx, head, [{ label: m.admin('projects.as_of_label'), value: formatBusinessDate(businessToday(), ctx.locale), ltr: true }]),
      tables: [
        {
          columns,
          rows,
          empty: m.admin('projects.no_projects'),
          ...(root ? { totals: { label: m.admin('reports.totals'), cells: { budget: root.budgetIqd, committed: root.committedIqd, actual: root.actualIqd, available: root.availableIqd }, sum: [] } } : {}),
        },
      ],
      fileName: `project-cost-report_${head.code}`,
    }),
    branchCode: head.branchCode,
    objectId: head.code,
  };
}

/** Every cost row with its element, cost code, document and journal — the Project Costs screen's, for one project. */
export async function lineItems(ctx: BuildContext, query: Query): Promise<Built | null> {
  const head = await header(ctx, query);
  if (!head) return null;
  const { m } = ctx;
  const from = dateOf(query, 'from', '');
  const to = dateOf(query, 'to', '');
  const items = await pe.lineItems(ctx.tx, { projectCode: head.code, from: from || null, to: to || null, pageSize: EXPORT_ROW_CAP + 1 });
  return {
    model: model({
      title: m.print('titles.project_line_items'),
      filters: filters(ctx, head, [
        { label: m.admin('projects.from_date'), value: from ? formatBusinessDate(from, ctx.locale) : '—', ltr: true },
        { label: m.admin('projects.to_date'), value: to ? formatBusinessDate(to, ctx.locale) : '—', ltr: true },
      ]),
      tables: [
        {
          columns: [
            { key: 'date', label: m.column('date'), kind: 'date' },
            { key: 'element', label: m.admin('projects.element'), kind: 'code' },
            { key: 'cost_code', label: m.admin('projects.cost_code'), kind: 'code' },
            { key: 'kind', label: m.admin('projects.kind'), kind: 'text' },
            { key: 'description', label: m.column('description'), kind: 'text', weight: 1.8 },
            { key: 'document', label: m.column('document_no'), kind: 'code' },
            { key: 'journal', label: m.admin('projects.journal'), kind: 'code' },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
          ],
          rows: items.rows.map((r) => ({
            cells: { date: r.incurredOn, element: r.wbsCode, cost_code: r.costCode, kind: COST_KINDS.has(r.kind) ? m.admin(`projects.cost_kind_${r.kind}`) : r.kind.replace(/_/g, ' '), description: r.description, document: r.invoiceNo ?? r.sourceId, journal: r.journalNo, amount: r.amountIqd },
          })),
          empty: m.admin('projects.no_costs'),
          totals: { label: m.admin('reports.totals'), cells: { amount: items.totalIqd } },
        },
      ],
      fileName: `project-line-items_${head.code}`,
    }),
    branchCode: head.branchCode,
    objectId: head.code,
  };
}

/** Each milestone's date as it stood at every scheduling run, and how far it slipped. */
export async function milestoneTrend(ctx: BuildContext, query: Query): Promise<Built | null> {
  const head = await header(ctx, query);
  if (!head) return null;
  const { m } = ctx;
  const trend = await psch.milestoneTrend(ctx.tx, head.code);
  const runColumns: Column[] = trend.runs.map((run) => ({ key: `run_${run}`, label: m.admin('projects.run_n', { run }), kind: 'date' }));
  return {
    model: model({
      title: m.print('titles.project_milestone_trend'),
      filters: filters(ctx, head),
      tables: [
        {
          columns: [
            { key: 'code', label: m.column('code'), kind: 'code' },
            { key: 'name', label: m.column('name'), kind: 'text', weight: 1.6 },
            { key: 'status', label: m.column('status'), kind: 'text' },
            ...runColumns,
            { key: 'reached', label: m.admin('projects.reached_on'), kind: 'date' },
            { key: 'slip', label: m.admin('projects.slip_days'), kind: 'quantity' },
          ],
          rows: trend.milestones.map((t) => ({
            cells: {
              code: t.code,
              name: t.name,
              status: m.admin(`projects.activity_status_${t.status}`),
              ...Object.fromEntries(trend.runs.map((run, i) => [`run_${run}`, t.dates[i] ?? null])),
              reached: t.reachedOn,
              slip: String(t.slipDays),
            },
          })),
          empty: m.admin('projects.no_milestones'),
        },
      ],
      fileName: `project-milestone-trend_${head.code}`,
    }),
    branchCode: head.branchCode,
    objectId: head.code,
  };
}

/** BCWS, BCWP, ACWP, CPI, SPI, EAC and VAC to a day, element by element — the Progress workspace's. */
export async function earnedValue(ctx: BuildContext, query: Query): Promise<Built | null> {
  const head = await header(ctx, query);
  if (!head) return null;
  const { m } = ctx;
  const asOf = dateOf(query, 'as_of', businessToday());
  const rows = await psch.earnedValueTree(ctx.tx, head.code, asOf);
  const root = rows.find((r) => r.level === 1);
  return {
    model: model({
      title: m.print('titles.project_earned_value'),
      filters: filters(ctx, head, [{ label: m.admin('projects.as_of_label'), value: formatBusinessDate(asOf, ctx.locale), ltr: true }]),
      tables: [
        {
          columns: [
            { key: 'element', label: m.admin('projects.element'), kind: 'code' },
            { key: 'name', label: m.column('name'), kind: 'text', weight: 1.6 },
            { key: 'budget', label: m.admin('projects.budget'), kind: 'money' },
            { key: 'bcws', label: m.admin('projects.bcws'), kind: 'money' },
            { key: 'bcwp', label: m.admin('projects.bcwp'), kind: 'money' },
            { key: 'acwp', label: m.admin('projects.acwp'), kind: 'money' },
            { key: 'percent', label: m.admin('projects.percent_complete'), kind: 'code' },
            { key: 'cpi', label: m.admin('projects.cpi'), kind: 'code' },
            { key: 'spi', label: m.admin('projects.spi'), kind: 'code' },
            { key: 'eac', label: m.admin('projects.eac'), kind: 'money' },
            { key: 'vac', label: m.admin('projects.vac'), kind: 'money' },
          ],
          rows: rows.map((r) => ({
            depth: r.level - 1,
            tone: rows.some((c) => c.parentCode === r.code) ? 'header' : 'line',
            counts: false,
            cells: {
              element: r.code,
              name: r.name,
              budget: r.budgetIqd,
              bcws: r.plannedIqd,
              bcwp: r.earnedIqd,
              acwp: r.actualIqd,
              percent: r.percentComplete === null ? null : `${r.percentComplete} %`,
              cpi: r.cpi,
              spi: r.spi,
              eac: r.eacIqd,
              vac: r.vacIqd,
            },
          })),
          empty: m.admin('projects.no_projects'),
          ...(root ? { totals: { label: m.admin('reports.totals'), cells: { budget: root.budgetIqd, bcws: root.plannedIqd, bcwp: root.earnedIqd, acwp: root.actualIqd, eac: root.eacIqd, vac: root.vacIqd }, sum: [] } } : {}),
        },
      ],
      fileName: `project-earned-value_${head.code}_${asOf}`,
    }),
    branchCode: head.branchCode,
    objectId: head.code,
  };
}

export const BUILD: Record<ProjectReport, (ctx: BuildContext, query: Query) => Promise<Built | null>> = {
  cost: costReport,
  lines: lineItems,
  trend: milestoneTrend,
  ev: earnedValue,
};
