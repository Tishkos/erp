import { eq, inArray } from 'drizzle-orm';
import { formatBusinessDate, formatStatementAmount, formatTimestamp, type Locale } from '@/i18n/config';
import { levelFrom, maxLevel, rollUp } from '@domain/report-levels';
import { matches } from '@/lib/search';
import { appUser, item as itemTable, warehouse } from '../db/schema';
import {
  BALANCE_SHEET_LEVELS,
  balanceSheetRows,
  cashFlowRows,
  changesInEquityRows,
  incomeStatementRows,
  type LayoutRow,
} from '../reports/finance-rows';
import * as audit from '../services/audit';
import * as bankAccounts from '../services/bank-cash-accounts';
import * as coa from '../services/chart-of-accounts';
import * as statements from '../services/financial-statements';
import * as inventoryReports from '../services/inventory-reports';
import * as partners from '../services/partners';
import * as statement from '../services/partner-statement';
import * as stock from '../services/stock-operations';
import * as shipments from '../services/supplier-shipment';
import * as trialBalanceService from '../services/trial-balance';
import { decimalString, isZero, scaled, sumMoney, sumQuantity } from './decimal';
import type { BuildContext, Built } from './documents';
import type { Messages } from './i18n';
import type { Column, Fact, PrintModel, Row, Table } from './model';

/**
 * The reports, printed with exactly the filters their screens were run with.
 *
 * Each builder takes the screen's own query string and reads it the way the
 * screen does — the same defaults (this calendar year, IQD, the deepest
 * level), the same service call with the same arguments — so the copy is the
 * screen's figures and nothing else. The filters are printed at the top: a
 * report whose period is not on it is a report that cannot be checked.
 */
type Query = URLSearchParams;

const MONEY = 4n;

/** A query value the way a screen reads `typeof x === 'string' ? x : fallback`. */
const param = (query: Query, name: string, fallback: string) => (query.has(name) ? (query.get(name) ?? '') : fallback);

const currencyOf = (query: Query): 'IQD' | 'USD' => (query.get('currency') === 'USD' ? 'USD' : 'IQD');

const day = (value: string, locale: Locale) => (value ? formatBusinessDate(value, locale) : '—');

const thisYear = () => new Date().getFullYear();

const today = () => new Date().toISOString().slice(0, 10);

const report = (
  input: Pick<PrintModel, 'title' | 'filters' | 'tables' | 'currency'> &
    Partial<Pick<PrintModel, 'summary' | 'orientation'>> & { readonly fileName: string },
): PrintModel => ({
  kind: 'report',
  fields: [],
  summary: input.summary ?? [],
  signatures: false,
  orientation: input.orientation ?? 'portrait',
  sheetName: input.title,
  ...input,
});

const built = (ctx: BuildContext, model: PrintModel, objectId: string): Built => ({
  model,
  branchCode: ctx.branchCode,
  objectId,
});

// ------------------------------------------------------- blocks 2, 3 and 6

function statementTable(m: Messages, account: statement.PartnerStatement): Table {
  const columns: Column[] = [
    { key: 'date', label: m.admin('partners.statement_date'), kind: 'date' },
    { key: 'document', label: m.admin('partners.statement_document'), kind: 'code' },
    { key: 'description', label: m.admin('journals.description'), kind: 'text' },
    { key: 'debit', label: m.admin('partners.statement_debit'), kind: 'money' },
    { key: 'credit', label: m.admin('partners.statement_credit'), kind: 'money' },
    { key: 'balance', label: m.admin('partners.statement_balance'), kind: 'money' },
  ];
  const rows: Row[] = [
    // What was outstanding before the first line: everything earlier is
    // folded into it, so the window closes where the whole account does.
    {
      tone: 'opening',
      cells: { description: m.admin('partners.statement_opening'), balance: account.opening },
    },
    ...account.lines.map(
      (line): Row => ({
        cells: {
          date: line.postingDate,
          document: line.document ? line.document.number : line.entryNo,
          description: line.description ?? '—',
          debit: isZero(line.debit) ? null : line.debit,
          credit: isZero(line.credit) ? null : line.credit,
          balance: line.balance,
        },
      }),
    ),
  ];
  return {
    columns,
    rows,
    empty: m.admin('partners.statement_empty'),
    totals: {
      label: m.admin('partners.statement_closing'),
      cells: { debit: account.totalDebit, credit: account.totalCredit, balance: account.closing },
      // The closing balance is the running balance's last figure, not a sum.
      sum: ['debit', 'credit'],
    },
  };
}

/** Customer or Supplier Account Statement — blocks 2 and 3. */
export async function partnerStatement(
  ctx: BuildContext,
  side: 'customer' | 'supplier',
  query: Query,
): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const asked = query.get('code') ?? '';

  const roll = await partners.listByRole(tx, side);
  const chosen = roll.find((row) => row.code === asked) ?? null;
  // No partner chosen is a screen that asks for one, not a statement.
  if (!chosen) return null;
  const account = await statement.statementFor(tx, side, chosen.code, { from, to, currency });

  const title = m.print(`titles.${side}_statement`);
  return built(
    ctx,
    report({
      title,
      currency,
      filters: [
        { label: m.admin(`partners.role_${side}`), value: `${chosen.code} · ${chosen.legalName}` },
        { label: m.admin('reports.from'), value: day(from, locale), ltr: true },
        { label: m.admin('reports.to'), value: day(to, locale), ltr: true },
        { label: m.admin('reports.currency'), value: currency, ltr: true },
      ],
      tables: [statementTable(m, account)],
      summary: [
        {
          label: m.admin('partners.statement_closing'),
          value: formatStatementAmount(account.closing, currency, locale),
          ltr: true,
        },
      ],
      fileName: `${side}-statement_${chosen.code}_${from}_${to}`,
    }),
    `${side}:${chosen.code}`,
  );
}

/** Bank or Cash Account Statement — block 6: money in is Debit, money out Credit. */
export async function bankStatement(
  ctx: BuildContext,
  code: string,
  query: Query,
  kind: 'bank' | 'cash',
): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const row = await bankAccounts.detail(tx, code).catch(() => null);
  // A cash account reached through the bank route is the wrong page for it,
  // and so the wrong copy — as the record screen answers.
  if (!row || row.accountType !== kind) return null;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const account = await statement.ledgerStatementFor(tx, row, { from, to, currency });
  const title = m.print(row.accountType === 'cash' ? 'titles.cash_statement' : 'titles.bank_statement');
  return built(
    ctx,
    report({
      title,
      currency,
      filters: [
        { label: m.print('account'), value: `${row.code} · ${row.name}` },
        { label: m.admin('reports.from'), value: day(from, locale), ltr: true },
        { label: m.admin('reports.to'), value: day(to, locale), ltr: true },
        { label: m.admin('reports.currency'), value: currency, ltr: true },
      ],
      tables: [statementTable(m, account)],
      summary: [
        {
          label: m.admin('partners.statement_closing'),
          value: formatStatementAmount(account.closing, currency, locale),
          ltr: true,
        },
      ],
      fileName: `${row.accountType}-statement_${row.code}_${from}_${to}`,
    }),
    `bank:${row.code}`,
  );
}

// ------------------------------------------------------------------ block 7

async function itemLabel(ctx: BuildContext, code: string, all: string) {
  if (!code) return all;
  const [row] = await ctx.tx.select({ name: itemTable.name }).from(itemTable).where(eq(itemTable.code, code)).limit(1);
  return row ? `${code} · ${row.name}` : code;
}

async function warehouseLabel(ctx: BuildContext, code: string, all: string) {
  if (!code) return all;
  const [row] = await ctx.tx.select({ name: warehouse.name }).from(warehouse).where(eq(warehouse.code, code)).limit(1);
  return row ? `${code} · ${row.name}` : code;
}

/** Warehouses Report — block 7: what is in stock, where, at what cost. */
export async function warehousesReport(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m } = ctx;
  const itemCode = (query.get('item') ?? '').trim();
  const warehouseCode = (query.get('warehouse') ?? '').trim();
  const rows = await inventoryReports.valuation(tx, ctx.principal, {
    allPermittedBranches: true,
    ...(itemCode ? { itemCode } : {}),
    ...(warehouseCode ? { warehouseCode } : {}),
  });
  const title = m.print('titles.warehouses_report');
  return built(
    ctx,
    report({
      title,
      currency: 'IQD',
      filters: [
        { label: m.column('item_code'), value: await itemLabel(ctx, itemCode, m.admin('reports.all_items')) },
        {
          label: m.column('warehouse_code'),
          value: await warehouseLabel(ctx, warehouseCode, m.admin('reports.all_warehouses')),
        },
      ],
      tables: [
        {
          columns: [
            { key: 'item_name', label: m.column('item_name'), kind: 'text' },
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'warehouse_name', label: m.column('warehouse_name'), kind: 'text' },
            { key: 'warehouse_code', label: m.column('warehouse_code'), kind: 'code' },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
            // The unit and the unit cost travel with the export: a spreadsheet
            // has no currency symbol beside 250,350 (2026-09-27).
            { key: 'unit', label: m.column('unit'), kind: 'code' },
            { key: 'average_unit_cost', label: m.column('average_unit_cost'), kind: 'money', decimals: 4 },
            { key: 'total_price', label: m.column('total_price'), kind: 'money' },
          ],
          rows: rows.map((row) => ({
            cells: {
              item_name: row.itemName,
              item_code: row.itemCode,
              warehouse_name: row.warehouseName,
              warehouse_code: row.warehouseCode,
              quantity: row.quantity,
              unit: row.uomCode,
              average_unit_cost: row.averageUnitCostIqd,
              total_price: row.valueIqd,
            },
          })),
          empty: m.admin('reports.nothing_in_stock'),
          totals: {
            label: m.admin('reports.totals'),
            cells: { total_price: sumMoney(rows.map((row) => row.valueIqd)) },
          },
        },
      ],
      fileName: `warehouses-report_${itemCode || 'all'}_${warehouseCode || 'all'}`,
    }),
    'warehouses_report',
  );
}

/** Stock Movement — block 7: every In and Out with the document behind it. */
export async function stockMovement(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const one = (key: string) => query.get(key) ?? '';
  const filter = {
    from: one('from') || null,
    to: one('to') || null,
    itemCode: one('item') || null,
    warehouseCode: one('warehouse') || null,
  };
  const rows = await stock.movements(tx, { principal: ctx.principal, branchCode: ctx.branchCode }, filter);
  const all = m.print('all');
  const title = m.print('titles.stock_movement');
  return built(
    ctx,
    report({
      title,
      currency: 'IQD',
      orientation: 'landscape',
      filters: [
        { label: m.admin('stock_movements.from'), value: filter.from ? day(filter.from, locale) : all, ltr: Boolean(filter.from) },
        { label: m.admin('stock_movements.to'), value: filter.to ? day(filter.to, locale) : all, ltr: Boolean(filter.to) },
        { label: m.column('item_code'), value: await itemLabel(ctx, filter.itemCode ?? '', m.admin('stock_movements.all_items')) },
        {
          label: m.column('warehouse'),
          value: await warehouseLabel(ctx, filter.warehouseCode ?? '', m.admin('stock_movements.all_warehouses')),
        },
      ],
      tables: [
        {
          columns: [
            { key: 'date', label: m.column('date'), kind: 'date' },
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'item_name', label: m.column('item_name'), kind: 'text' },
            { key: 'warehouse_code', label: m.column('warehouse_code'), kind: 'code' },
            { key: 'warehouse_name', label: m.column('warehouse_name'), kind: 'text' },
            { key: 'movement', label: m.column('movement'), kind: 'text', weight: 1.4 },
            { key: 'stock_in', label: m.column('stock_in'), kind: 'quantity' },
            { key: 'stock_out', label: m.column('stock_out'), kind: 'quantity' },
            { key: 'document', label: m.column('document'), kind: 'code', weight: 1.6 },
          ],
          rows: rows.map((row) => ({
            cells: {
              date: row.movementDate,
              item_code: row.itemCode,
              item_name: row.itemName,
              warehouse_code: row.warehouseCode,
              warehouse_name: row.warehouseName,
              movement: m.admin(`stock_movements.type.${row.type}`),
              stock_in: row.direction === 'in' ? row.quantity : null,
              stock_out: row.direction === 'out' ? row.quantity : null,
              document: row.documentNo ?? '',
            },
          })),
          empty: m.admin('stock_movements.none'),
          totals: {
            label: m.admin('reports.totals'),
            cells: {
              stock_in: sumQuantity(rows.filter((row) => row.direction === 'in').map((row) => row.quantity)),
              stock_out: sumQuantity(rows.filter((row) => row.direction === 'out').map((row) => row.quantity)),
            },
          },
        },
      ],
      fileName: `stock-movement_${filter.from ?? 'all'}_${filter.to ?? 'all'}`,
    }),
    'stock_movement',
  );
}

/**
 * The Stock Ledger — block 7: one item, warehouse by warehouse, with the
 * balance carried down each movement.
 *
 * One table per warehouse, because that is what the screen shows and what
 * the figure being checked belongs to: an opening balance, the movements in
 * the period, and the closing balance the Warehouses Report also states. The
 * closing figure is written as the service's own — it is where the running
 * balance ends, not a sum of the column above it.
 *
 * A ledger is of one thing, so no item means no copy: the screen asks for one
 * before it shows anything, and a copy of that screen would be a copy of the
 * question.
 */
export async function stockLedger(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const one = (key: string) => (query.get(key) ?? '').trim();
  const itemCode = one('item');
  if (!itemCode) return null;
  const filter = {
    itemCode,
    warehouseCode: one('warehouse') || null,
    from: one('from') || null,
    to: one('to') || null,
  };

  const accounts = await stock.ledger(tx, { principal: ctx.principal, branchCode: ctx.branchCode }, filter);
  const all = m.print('all');
  const item = await itemLabel(ctx, itemCode, all);
  const columns: Column[] = [
    { key: 'date', label: m.column('date'), kind: 'date' },
    { key: 'movement', label: m.column('movement'), kind: 'text', weight: 1.4 },
    { key: 'document', label: m.column('document'), kind: 'code', weight: 1.6 },
    { key: 'from_warehouse', label: m.column('from_warehouse_name'), kind: 'text' },
    { key: 'to_warehouse', label: m.column('to_warehouse_name'), kind: 'text' },
    { key: 'stock_in', label: m.column('stock_in'), kind: 'quantity' },
    { key: 'stock_out', label: m.column('stock_out'), kind: 'quantity' },
    { key: 'balance', label: m.column('running_balance'), kind: 'quantity' },
    { key: 'raised_by', label: m.column('raised_by'), kind: 'text' },
  ];

  const tables: Table[] = accounts.map((account) => ({
    title: `${account.warehouseName} · ${account.warehouseCode}`,
    columns,
    rows: [
      // What the warehouse held before the first row shown. Zero when the
      // ledger is read from the beginning, which is a real figure and prints.
      {
        tone: 'opening' as const,
        cells: { date: filter.from, movement: m.column('opening_balance'), balance: account.opening },
      },
      ...account.rows.map((row) => ({
        cells: {
          date: row.movementDate,
          movement: m.admin(`stock_movements.type.${row.type}`),
          document: row.documentNo ?? '',
          from_warehouse: row.fromWarehouseName ?? row.fromWarehouseCode ?? '',
          to_warehouse: row.toWarehouseName ?? row.toWarehouseCode ?? '',
          stock_in: row.direction === 'in' ? row.quantity : null,
          stock_out: row.direction === 'out' ? row.quantity : null,
          balance: row.balance,
          raised_by: row.raisedBy ?? '',
        },
      })),
    ],
    empty: m.admin('stock_ledger.none', { item }),
    totals: {
      label: m.column('closing_balance'),
      cells: {
        stock_in: sumQuantity(account.rows.filter((row) => row.direction === 'in').map((row) => row.quantity)),
        stock_out: sumQuantity(account.rows.filter((row) => row.direction === 'out').map((row) => row.quantity)),
        balance: account.closing,
      },
      // The closing balance is where the running balance ends, not a sum.
      sum: ['stock_in', 'stock_out'],
    },
  }));

  const title = m.print('titles.stock_ledger');
  return built(
    ctx,
    report({
      title,
      currency: 'IQD',
      orientation: 'landscape',
      filters: [
        { label: m.print('item'), value: item },
        {
          label: m.column('warehouse'),
          value: await warehouseLabel(ctx, filter.warehouseCode ?? '', m.admin('stock_movements.all_warehouses')),
        },
        { label: m.admin('stock_movements.from'), value: filter.from ? day(filter.from, locale) : all, ltr: Boolean(filter.from) },
        { label: m.admin('stock_movements.to'), value: filter.to ? day(filter.to, locale) : all, ltr: Boolean(filter.to) },
      ],
      // Nothing has moved anywhere is still a sheet of paper that says so,
      // rather than a 404: the item exists, its ledger is empty.
      tables: tables.length > 0 ? tables : [{ columns, rows: [], empty: m.admin('stock_ledger.none', { item }) }],
      fileName: `stock-ledger_${itemCode}_${filter.from ?? 'all'}_${filter.to ?? 'all'}`,
    }),
    `stock_ledger:${itemCode}`,
  );
}

// ------------------------------------------------------------------ block 8

/** Invoice Status Tracking — block 8: the stage, where the goods are, and how they got there. */
export async function invoiceStatusTracking(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const asked = query.get('status') ?? '';
  const status = (shipments.SHIPMENT_STATUSES as readonly string[]).includes(asked)
    ? (asked as shipments.ShipmentStatus)
    : undefined;
  const q = query.get('q') ?? '';
  const rows = (await shipments.list(tx, status ? { status } : {})).filter((row) => matches(row, q));
  const label = (value: string | null | undefined) => (value ? m.admin(`in_transit.status_${value}`) : '—');

  // Each shipment's own trail, oldest first: opened, then every stage it
  // was moved through, by whom and when.
  const trails = await Promise.all(
    rows.map(async (row) => ({ row, events: await audit.timelineFor(tx, shipments.PERMISSION_OBJECT, row.id) })),
  );
  const actorIds = [
    ...new Set(trails.flatMap(({ events }) => events.map((event) => event.actor_user_id as string | null)).filter(Boolean)),
  ] as string[];
  const people = actorIds.length
    ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, actorIds))
    : [];
  const history: Row[] = trails.flatMap(({ row, events }) =>
    [...events]
      .filter((event) => event.action === 'supplier_shipment.opened' || event.action === 'supplier_shipment.advanced')
      .reverse()
      .map((event): Row => {
        const before = (event.before_value ?? null) as { status?: string } | null;
        const after = (event.after_value ?? null) as { status?: string; warehouseCode?: string } | null;
        const at = event.occurred_at instanceof Date ? event.occurred_at.toISOString() : String(event.occurred_at);
        return {
          cells: {
            reference: row.invoiceNo,
            changed_at: formatTimestamp(at, locale),
            stage_from: label(before?.status),
            stage_to: label(after?.status),
            warehouse: after?.warehouseCode ?? '—',
            changed_by: people.find((person) => person.id === event.actor_user_id)?.name ?? '—',
          },
        };
      }),
  );

  const title = m.print('titles.invoice_status_tracking');
  const filters: Fact[] = [{ label: m.column('status'), value: status ? label(status) : m.admin('in_transit.all') }];
  if (q.trim()) filters.push({ label: m.print('search'), value: q.trim() });
  return built(
    ctx,
    report({
      title,
      currency: 'IQD',
      orientation: 'landscape',
      filters,
      tables: [
        {
          columns: [
            { key: 'reference', label: m.column('reference'), kind: 'code' },
            { key: 'posting_date', label: m.column('posting_date'), kind: 'date' },
            { key: 'supplier_code', label: m.column('supplier_code'), kind: 'code' },
            { key: 'supplier_name', label: m.column('supplier_name'), kind: 'text' },
            { key: 'amount', label: m.column('amount'), kind: 'money' },
            { key: 'where', label: m.admin('in_transit.where'), kind: 'text' },
            { key: 'status', label: m.column('status'), kind: 'text' },
          ],
          rows: rows.map((row) => ({
            cells: {
              reference: row.invoiceNo,
              posting_date: row.invoiceDate,
              supplier_code: row.supplierCode,
              supplier_name: row.supplierName,
              amount: row.totalIqd,
              where: row.warehouseName,
              status: label(row.status),
            },
          })),
          empty: m.admin('in_transit.none'),
          totals: { label: m.admin('reports.totals'), cells: { amount: sumMoney(rows.map((row) => row.totalIqd)) } },
        },
        {
          title: m.print('history'),
          columns: [
            { key: 'reference', label: m.column('reference'), kind: 'code' },
            { key: 'changed_at', label: m.print('changed_at'), kind: 'text' },
            { key: 'stage_from', label: m.print('stage_from'), kind: 'text' },
            { key: 'stage_to', label: m.print('stage_to'), kind: 'text' },
            { key: 'warehouse', label: m.column('warehouse'), kind: 'code' },
            { key: 'changed_by', label: m.print('changed_by'), kind: 'text' },
          ],
          rows: history,
          empty: m.print('no_history'),
        },
      ],
      fileName: `invoice-status-tracking_${status ?? 'all'}`,
    }),
    'invoice_status_tracking',
  );
}

// ------------------------------------------------------------ finance

const periodFilters = (m: Messages, locale: Locale, from: string, to: string, currency: string): Fact[] => [
  { label: m.admin('reports.from'), value: day(from, locale), ltr: true },
  { label: m.admin('reports.to'), value: day(to, locale), ltr: true },
  { label: m.admin('reports.currency'), value: currency, ltr: true },
];

const levelFilter = (m: Messages, level: number): Fact => ({
  label: m.admin('reports.level'),
  value: m.admin('reports.level_n', { level }),
});

/** Trial Balance, rolled up to the level the screen was showing. */
export async function trialBalance(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const [rows, chart] = await Promise.all([
    trialBalanceService.trialBalance(tx, { from, to, currency, allPermittedBranches: true }),
    trialBalanceService.chartRows(tx),
  ]);
  const deepest = maxLevel(chart);
  const level = levelFrom(query.get('level') ?? undefined, deepest);
  const shown = rollUp(chart, rows, level);
  const totals = trialBalanceService.totalsOf(rows);
  const money = (amount: string) => formatStatementAmount(amount, currency, locale);

  return built(
    ctx,
    report({
      title: m.print('titles.trial_balance'),
      currency,
      filters: [...periodFilters(m, locale, from, to, currency), levelFilter(m, level)],
      tables: [
        {
          columns: [
            { key: 'account', label: m.column('account'), kind: 'code' },
            { key: 'account_name', label: m.admin('reports.account_name'), kind: 'text' },
            { key: 'account_type', label: m.admin('reports.account_type'), kind: 'text', weight: 1.2 },
            { key: 'debit', label: m.admin('journals.debit'), kind: 'money' },
            { key: 'credit', label: m.admin('journals.credit'), kind: 'money' },
          ],
          rows: shown.map((row) => ({
            depth: row.depth - 1,
            tone: row.isGroup ? 'header' : 'line',
            // Every figure rolls up into exactly one top-level row, so the
            // top-level rows are the ones that add up to the totals.
            counts: row.depth === 1,
            cells: {
              account: row.code,
              account_name: row.name,
              account_type: m.admin(`reports.type_${row.accountType}`),
              debit: isZero(row.debit) ? null : row.debit,
              credit: isZero(row.credit) ? null : row.credit,
            },
          })),
          empty: m.admin('reports.nothing_posted'),
          totals: { label: m.admin('reports.totals'), cells: { debit: totals.debit, credit: totals.credit } },
        },
      ],
      summary: [
        {
          label: totals.balances ? m.admin('reports.balanced') : m.admin('reports.out_by', { amount: money(totals.difference) }),
          value: '',
        },
        { label: m.admin('journals.total_debit'), value: money(totals.debit), ltr: true },
        { label: m.admin('journals.total_credit'), value: money(totals.credit), ltr: true },
      ],
      fileName: `trial-balance_${from}_${to}`,
    }),
    'trial_balance',
  );
}

function statementLayoutTable(m: Messages, currency: string, rows: readonly LayoutRow[]): Table {
  return {
    columns: [
      { key: 'label', label: m.admin('reports.statement_line'), kind: 'text', weight: 4 },
      { key: 'amount', label: m.admin('reports.amount'), kind: 'money', weight: 1.4 },
    ],
    rows: rows.map((row) => ({
      depth: row.depth,
      tone: row.tone === 'line' ? 'line' : row.tone,
      // The layout's own subtotals are its totals; nothing is added up here.
      counts: false,
      cells: { label: row.label, amount: row.amount },
    })),
    empty: m.admin('reports.nothing_posted'),
  };
}

/** Statement of Profit or Loss. */
export async function incomeStatement(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const pl = await statements.incomeStatement(tx, { from, to, currency, allPermittedBranches: true });
  const level = levelFrom(query.get('level') ?? undefined, pl.depth + 1);
  const loss = Number(pl.result) < 0;
  return built(
    ctx,
    report({
      title: m.print('titles.income_statement'),
      currency,
      filters: [...periodFilters(m, locale, from, to, currency), levelFilter(m, level)],
      tables: [statementLayoutTable(m, currency, incomeStatementRows(pl, level))],
      summary: [
        {
          label: loss ? m.admin('reports.net_loss') : m.admin('reports.net_profit'),
          value: formatStatementAmount(pl.result, currency, locale),
          ltr: true,
        },
      ],
      fileName: `income-statement_${from}_${to}`,
    }),
    'income_statement',
  );
}

/** Statement of Financial Position, as at a date. */
export async function balanceSheet(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const asAt = param(query, 'to', today());
  const currency = currencyOf(query);
  const level = levelFrom(query.get('level') ?? undefined, BALANCE_SHEET_LEVELS);
  const sfp = await statements.financialPosition(tx, asAt, { currency, allPermittedBranches: true });
  const money = (amount: string) => formatStatementAmount(amount, currency, locale);
  const rows = balanceSheetRows(sfp, level, {
    assets: m.admin('reports.assets'),
    equity: m.admin('reports.equity'),
    liabilities: m.admin('reports.liabilities'),
    resultForThePeriod: m.admin('reports.result_for_the_period'),
  });
  return built(
    ctx,
    report({
      title: m.print('titles.balance_sheet'),
      currency,
      filters: [
        { label: m.admin('reports.as_at_label'), value: day(asAt, locale), ltr: true },
        { label: m.admin('reports.currency'), value: currency, ltr: true },
        levelFilter(m, level),
      ],
      tables: [statementLayoutTable(m, currency, rows)],
      summary: [
        { label: sfp.balances ? m.admin('reports.sides_agree') : m.admin('reports.does_not_balance'), value: '' },
        { label: m.admin('reports.total_assets'), value: money(sfp.totalAssets), ltr: true },
        { label: m.admin('reports.total_equity_and_liabilities'), value: money(sfp.totalEquityAndLiabilities), ltr: true },
      ],
      fileName: `balance-sheet_${asAt}`,
    }),
    'balance_sheet',
  );
}

/** Statement of Changes in Equity. */
export async function changesInEquity(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const equity = await statements.changesInEquity(tx, { from, to, currency, allPermittedBranches: true });
  return built(
    ctx,
    report({
      title: m.print('titles.changes_in_equity'),
      currency,
      filters: periodFilters(m, locale, from, to, currency),
      tables: [statementLayoutTable(m, currency, changesInEquityRows(equity))],
      summary: [
        {
          label: m.admin('reports.total_equity'),
          value: formatStatementAmount(equity.closing, currency, locale),
          ltr: true,
        },
      ],
      fileName: `changes-in-equity_${from}_${to}`,
    }),
    'changes_in_equity',
  );
}

/** Statement of Cash Flows. */
export async function cashFlow(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const flow = await statements.cashFlow(tx, { from, to, currency, allPermittedBranches: true });
  return built(
    ctx,
    report({
      title: m.print('titles.cash_flow'),
      currency,
      filters: periodFilters(m, locale, from, to, currency),
      tables: [statementLayoutTable(m, currency, cashFlowRows(flow))],
      summary: [
        {
          label: !flow.configured
            ? m.admin('reports.cash_not_configured')
            : flow.reconciles
              ? m.admin('reports.cash_reconciles')
              : m.admin('reports.cash_does_not_reconcile'),
          value: '',
        },
      ],
      fileName: `cash-flow_${from}_${to}`,
    }),
    'cash_flow',
  );
}

/** General Ledger — every account's balance as at a date. */
export async function glInquiry(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const asAt = param(query, 'to', today());
  const currency = currencyOf(query);
  const [balances, chart] = await Promise.all([
    trialBalanceService.ledgerBalances(tx, { asAt, currency, allPermittedBranches: true }),
    trialBalanceService.chartRows(tx),
  ]);
  const deepest = maxLevel(chart);
  const level = levelFrom(query.get('level') ?? undefined, deepest);
  const rows =
    level >= deepest
      ? balances.map((row) => ({ ...row, depth: deepest, isGroup: false }))
      : rollUp(chart, balances, level).map((row) => ({
          accountCode: row.code,
          accountName: row.name,
          accountType: row.accountType,
          balance: decimalString(scaled(row.debit, MONEY) - scaled(row.credit, MONEY), MONEY),
          depth: row.depth,
          isGroup: row.isGroup,
        }));
  return built(
    ctx,
    report({
      title: m.print('titles.gl_inquiry'),
      currency,
      filters: [
        { label: m.admin('reports.as_at_label'), value: day(asAt, locale), ltr: true },
        { label: m.admin('reports.currency'), value: currency, ltr: true },
        levelFilter(m, level),
      ],
      tables: [
        {
          columns: [
            { key: 'account', label: m.column('account'), kind: 'code' },
            { key: 'account_name', label: m.admin('reports.account_name'), kind: 'text' },
            { key: 'account_type', label: m.admin('reports.account_type'), kind: 'text', weight: 1.2 },
            {
              key: 'balance',
              label: m.admin('reports.balance'),
              kind: 'money',
              sides: { debit: m.admin('reports.dr'), credit: m.admin('reports.cr') },
            },
          ],
          rows: rows.map((row) => ({
            depth: level >= deepest ? 0 : row.depth - 1,
            tone: row.isGroup ? 'header' : 'line',
            cells: {
              account: row.accountCode,
              account_name: row.accountName,
              account_type: m.admin(`reports.type_${row.accountType}`),
              balance: row.balance,
            },
          })),
          empty: m.admin('reports.no_accounts'),
        },
      ],
      fileName: `general-ledger_${asAt}`,
    }),
    'gl_inquiry',
  );
}

/** One account's postings in a period, with the balance each left. */
export async function glAccount(ctx: BuildContext, code: string, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const account = await coa.loadAccountByCode(tx, code).catch(() => null);
  if (!account) return null;
  const year = thisYear();
  const from = param(query, 'from', `${year}-01-01`);
  const to = param(query, 'to', `${year}-12-31`);
  const currency = currencyOf(query);
  const activity = await trialBalanceService.accountActivity(tx, code, { from, to, allPermittedBranches: true });
  const usd = currency === 'USD';
  let running = 0n;
  let debitTotal = 0n;
  let creditTotal = 0n;
  const rows: Row[] = activity.map((line) => {
    const debit = usd ? line.debitUsd : line.debitIqd;
    const credit = usd ? line.creditUsd : line.creditIqd;
    debitTotal += scaled(debit, MONEY);
    creditTotal += scaled(credit, MONEY);
    running += scaled(debit, MONEY) - scaled(credit, MONEY);
    return {
      cells: {
        posting_date: String(line.postingDate),
        entry: line.entryNo,
        description: line.description ?? '—',
        debit: isZero(debit) ? null : debit,
        credit: isZero(credit) ? null : credit,
        running: decimalString(running, MONEY),
      },
    };
  });
  const closing = decimalString(running, MONEY);
  return built(
    ctx,
    report({
      title: `${m.print('titles.gl_account')} — ${account.code} · ${account.name}`,
      currency,
      filters: [{ label: m.print('account'), value: `${account.code} · ${account.name}` }, ...periodFilters(m, locale, from, to, currency)],
      tables: [
        {
          columns: [
            { key: 'posting_date', label: m.admin('journals.posting_date'), kind: 'date' },
            { key: 'entry', label: m.admin('reports.entry'), kind: 'code' },
            { key: 'description', label: m.admin('journals.description'), kind: 'text' },
            { key: 'debit', label: m.admin('journals.debit'), kind: 'money' },
            { key: 'credit', label: m.admin('journals.credit'), kind: 'money' },
            { key: 'running', label: m.admin('reports.running_balance'), kind: 'money' },
          ],
          rows,
          empty: m.admin('reports.nothing_posted'),
          totals: {
            label: m.admin('reports.totals'),
            cells: {
              debit: decimalString(debitTotal, MONEY),
              credit: decimalString(creditTotal, MONEY),
              running: closing,
            },
            sum: ['debit', 'credit'],
          },
        },
      ],
      summary: [
        { label: m.admin('reports.running_balance'), value: formatStatementAmount(closing, currency, locale), ltr: true },
      ],
      fileName: `account-ledger_${account.code}_${from}_${to}`,
    }),
    `gl_account:${account.code}`,
  );
}
