/**
 * Inventory's reports as printable things — IMPROVEMENT-002.
 *
 *   * `inventoryValuation` — the FIFO position at a date (Final / Provisional,
 *     flagged lines named) and the General Ledger beside it, per account.
 *   * `inventoryChecks` — the health checks as they stand, with what each
 *     found.
 *
 * Read through the services the screens read, so a copy is the screen.
 */
import { formatBusinessDate } from '@/i18n/config';
import { businessToday } from '../domain/business-date';
import * as checks from '../services/inventory-checks';
import * as valuation from '../services/inventory-valuation';
import type { PrintModel } from './model';
import type { BuildContext, Built } from './documents';

type Query = URLSearchParams;

const report = (
  input: Pick<PrintModel, 'title' | 'filters' | 'tables' | 'currency'> & Partial<Pick<PrintModel, 'summary' | 'orientation'>> & { readonly fileName: string },
): PrintModel => ({
  kind: 'report',
  fields: [],
  summary: input.summary ?? [],
  signatures: false,
  orientation: input.orientation ?? 'landscape',
  sheetName: input.title,
  ...input,
});

export async function inventoryValuation(ctx: BuildContext, query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`inventory_valuation.${key}`, values);
  const asOf = (query.get('as_of') ?? '').trim() || businessToday();
  const warehouseCode = (query.get('warehouse') ?? '').trim() || null;
  const category = (query.get('category') ?? '').trim() || null;
  const branchCode = (query.get('branch') ?? '').trim() || null;
  let found: valuation.HistoricalValuation;
  try {
    found = await valuation.valuationAt(tx, ctx.principal, { asOf, warehouseCode, category, branchCode, allPermittedBranches: !branchCode });
  } catch (error) {
    if (error instanceof valuation.ValuationDateError) return null;
    throw error;
  }
  const title = m.print('titles.inventory_valuation');
  return {
    model: report({
      title,
      currency: 'IQD',
      filters: [
        { label: t('as_of'), value: formatBusinessDate(asOf, locale), ltr: true },
        { label: m.column('status'), value: t(`status_${found.status}`) },
        { label: t('costing'), value: t('costing_fifo') },
        { label: m.column('warehouse'), value: warehouseCode ?? t('all_warehouses'), ltr: Boolean(warehouseCode) },
        { label: t('category'), value: category ?? t('all_categories') },
        { label: m.column('branch_code'), value: branchCode ?? t('all_branches'), ltr: true },
        ...(found.finalThrough ? [{ label: t('final_through_label'), value: formatBusinessDate(found.finalThrough, locale), ltr: true }] : []),
      ],
      tables: [
        {
          title: t('position_at', { date: formatBusinessDate(asOf, locale) }),
          columns: [
            { key: 'item_code', label: m.column('item_code'), kind: 'code' },
            { key: 'item_name', label: m.column('item_name'), kind: 'text', weight: 2 },
            { key: 'category', label: t('category'), kind: 'text' },
            { key: 'warehouse', label: m.column('warehouse'), kind: 'code' },
            { key: 'branch', label: m.column('branch_code'), kind: 'code' },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
            { key: 'unit', label: m.column('unit'), kind: 'code' },
            { key: 'unit_cost', label: t('unit_cost'), kind: 'money', decimals: 4 },
            { key: 'value', label: t('value'), kind: 'money' },
            { key: 'note', label: t('note'), kind: 'text' },
          ],
          rows: found.lines.map((line) => ({
            cells: {
              item_code: line.itemCode,
              item_name: line.itemName,
              category: line.category ?? '—',
              warehouse: line.warehouseCode,
              branch: line.branchCode,
              quantity: line.quantity,
              unit: line.uomCode,
              unit_cost: line.unitCostIqd,
              value: line.valueIqd,
              note: line.flagged ? t('flagged') : line.isTransit ? t('in_transit') : '',
            },
          })),
          empty: t('none'),
          totals: { label: t('total'), cells: { quantity: found.totalQuantity, value: found.totalIqd } },
        },
        {
          title: t('against_gl'),
          columns: [
            { key: 'account', label: t('account'), kind: 'code' },
            { key: 'name', label: m.column('name'), kind: 'text', weight: 2 },
            { key: 'layers', label: t('layers'), kind: 'money' },
            { key: 'gl', label: t('gl_balance'), kind: 'money' },
            { key: 'difference', label: t('difference'), kind: 'money' },
          ],
          rows: found.accounts.map((account) => ({
            cells: { account: account.accountCode, name: account.accountName, layers: account.layersIqd, gl: account.glIqd, difference: account.differenceIqd },
          })),
          empty: t('no_accounts'),
          totals: { label: t('total'), cells: { layers: found.layersOnAccountsIqd, gl: found.glTotalIqd, difference: found.differenceIqd } },
        },
        ...(found.flags.length
          ? [
              {
                title: t('flagged_title'),
                columns: [
                  { key: 'item', label: m.column('item_code'), kind: 'code' as const },
                  { key: 'warehouse', label: m.column('warehouse'), kind: 'code' as const },
                  { key: 'from', label: m.column('from'), kind: 'date' as const },
                  { key: 'to', label: m.column('to'), kind: 'date' as const },
                  { key: 'quantity', label: m.column('quantity'), kind: 'quantity' as const },
                  { key: 'detail', label: t('note'), kind: 'text' as const, weight: 3 },
                ],
                rows: found.flags.map((flag) => ({
                  cells: { item: flag.itemCode, warehouse: flag.warehouseCode, from: flag.from, to: flag.to, quantity: flag.quantity, detail: flag.detail },
                })),
                empty: '',
              },
            ]
          : []),
      ],
      summary: [
        { label: t('total'), value: `${found.totalIqd} IQD`, ltr: true },
        { label: t('gl_balance'), value: `${found.glTotalIqd} IQD`, ltr: true },
        { label: t('difference'), value: `${found.differenceIqd} IQD`, ltr: true },
      ],
      fileName: `inventory-valuation_${asOf}_${warehouseCode ?? 'all'}`,
    }),
    branchCode: ctx.branchCode,
    objectId: 'inventory_valuation',
  };
}

export async function inventoryChecks(ctx: BuildContext, _query: Query): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`inventory_checks.${key}`, values);
  const found = await checks.run(tx, ctx.principal);
  const title = m.print('titles.inventory_checks');
  return {
    model: report({
      title,
      currency: 'IQD',
      filters: [{ label: t('as_of'), value: formatBusinessDate(found.asOf, locale), ltr: true }],
      tables: [
        {
          columns: [
            { key: 'check', label: t('check'), kind: 'text', weight: 2 },
            { key: 'state', label: t('state'), kind: 'text' },
            { key: 'figure', label: t('figure'), kind: 'text' },
            { key: 'source', label: t('source'), kind: 'text' },
            { key: 'detail', label: t('detail'), kind: 'text', weight: 3 },
          ],
          rows: found.checks.map((check) => ({
            cells: {
              check: t(`check_${check.code}`),
              state: t(`state_${check.state}`),
              figure: check.figure,
              source: check.source,
              detail: check.detail.slice(0, 20).join('; ') + (check.detail.length > 20 ? ' …' : ''),
            },
          })),
          empty: t('none'),
        },
      ],
      summary: [
        { label: t('state_healthy'), value: String(found.checks.filter((c) => c.state === 'healthy').length), ltr: true },
        { label: t('state_warning'), value: String(found.checks.filter((c) => c.state === 'warning').length), ltr: true },
        { label: t('state_error'), value: String(found.checks.filter((c) => c.state === 'error').length), ltr: true },
      ],
      fileName: `inventory-checks_${found.asOf}`,
    }),
    branchCode: ctx.branchCode,
    objectId: 'inventory_checks',
  };
}
