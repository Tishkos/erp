/**
 * Inventory's own documents as printable things — IMPROVEMENT-002.
 *
 *   * `stockCount` — one count: the plan, who counted and approved, and its
 *     lines with the book quantity, what was found, the recount and the
 *     variance. Read through `stock-count.viewByNo`, the page's own reader.
 *   * `transfer` and `itemReconciliation` — the two stock documents that were
 *     executed when saved: the header as their record pages show it, the FIFO
 *     layers they worked on at the cost each carried, what the warehouse(s)
 *     held before and after (the Stock Ledger's own running balance) and, for
 *     a reconciliation, the journal it posted. Read through
 *     `stock-operations.transferView` / `adjustmentView`, the pages' readers.
 *
 * Built once into the print model and drawn three ways, like every other
 * document here.
 */
import { formatBusinessDate, formatMoney, formatTimestamp } from '@/i18n/config';
import { can } from '@domain/permissions';
import { parseQuantity } from '../domain/uom';
import * as counts from '../services/stock-count';
import * as stock from '../services/stock-operations';
import { sumMoney, sumQuantity } from './decimal';
import type { BuildContext, Built } from './documents';
import type { Column, Fact, Row } from './model';

export async function stockCount(ctx: BuildContext, countNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await counts.viewByNo(tx, countNo);
  if (!found) return null;
  const { count, lines } = found;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`stock_count.${key}`, values);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const variances = lines.filter((line) => line.variance !== null && parseQuantity(line.variance) !== 0n).length;

  return {
    model: {
      kind: 'document',
      title: m.print('titles.stock_count'),
      number: count.countNo,
      status: t(`status.${count.status}`),
      posted: count.status === 'adjusted',
      orientation: 'portrait',
      fields: [
        { label: m.column('document_no'), value: count.countNo, ltr: true },
        { label: m.column('status'), value: t(`status.${count.status}`) },
        { label: m.column('warehouse'), value: `${count.warehouseCode} · ${count.warehouseName}` },
        { label: m.column('branch_code'), value: count.branchCode, ltr: true },
        { label: t('scope'), value: `${t(`scope_${count.scope}`)}${count.scopeFilter ? ` · ${count.scopeFilter}` : ''}` },
        { label: t('planned_on'), value: `${day(count.plannedOn)} · ${count.plannedByName ?? '—'}`, ltr: true },
        { label: t('counted_on'), value: count.countedOn ? `${day(count.countedOn)} · ${count.countedByName ?? '—'}` : '—', ltr: true },
        { label: t('approved_by'), value: count.approvedByName ? `${count.approvedByName} · ${count.approvalReason ?? ''}` : '—' },
        { label: t('adjusted_on'), value: day(count.adjustedOn), ltr: true },
      ],
      filters: [],
      tables: [
        {
          title: t('lines'),
          columns: [
            { key: 'line', label: '#', kind: 'code' },
            { key: 'item', label: m.column('item_code'), kind: 'code' },
            { key: 'name', label: m.column('item_name'), kind: 'text', weight: 2 },
            { key: 'batch', label: m.column('batch_number'), kind: 'code' },
            { key: 'book', label: t('book_quantity'), kind: 'quantity' },
            { key: 'counted', label: t('counted_quantity'), kind: 'quantity' },
            { key: 'recount', label: t('recount_quantity'), kind: 'quantity' },
            { key: 'variance', label: t('variance'), kind: 'quantity' },
            { key: 'note', label: t('note'), kind: 'text', weight: 2 },
          ],
          rows: lines.map((line) => ({
            cells: {
              line: String(line.lineNo),
              item: line.itemCode,
              name: line.itemName ?? '—',
              batch: line.batchNumber ?? line.serialNumber ?? '—',
              book: line.systemQuantity,
              counted: line.countedQuantity,
              recount: line.recountQuantity,
              variance: line.variance,
              note: line.note ?? '',
            },
          })),
          empty: t('no_lines'),
        },
      ],
      summary: [
        { label: t('lines'), value: String(lines.length), ltr: true },
        { label: t('variances'), value: String(variances), ltr: true },
      ],
      signatures: true,
      currency: 'IQD',
      fileName: count.countNo,
      sheetName: count.countNo,
    },
    branchCode: count.branchCode,
    objectId: count.id,
  };
}

// ---------------------------------------------------------------------------
// Transfer and Item Reconciliation — the record pages' own figures
// ---------------------------------------------------------------------------

const layerColumns = (m: BuildContext['m'], key: 'transfers' | 'reconciliation'): Column[] => [
  { key: 'line', label: '#', kind: 'code', weight: 0.5 },
  { key: 'batch', label: m.column('batch_number'), kind: 'code' },
  { key: 'layer_date', label: m.admin(`${key}.layer_date`), kind: 'date' },
  { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
  { key: 'unit_cost', label: m.admin(`${key}.unit_cost`), kind: 'money', decimals: 4 },
  { key: 'value', label: m.admin(`${key}.value`), kind: 'money' },
];

const layerRows = (layers: readonly stock.DocumentLayer[]): Row[] =>
  layers.map((layer, index) => ({
    cells: {
      line: String(index + 1),
      batch: layer.batchNumber ?? '—',
      layer_date: layer.layerDate,
      quantity: layer.quantity,
      unit_cost: layer.unitCostIqd,
      value: layer.valueIqd,
    },
  }));

const positionColumns = (m: BuildContext['m'], key: 'transfers' | 'reconciliation'): Column[] => [
  { key: 'warehouse', label: m.column('warehouse'), kind: 'text', weight: 2 },
  { key: 'before', label: m.admin(`${key}.before`), kind: 'quantity' },
  { key: 'moved', label: m.admin(`${key}.moved`), kind: 'quantity' },
  { key: 'after', label: m.admin(`${key}.after`), kind: 'quantity' },
];

const positionRows = (positions: readonly stock.DocumentPosition[]): Row[] =>
  positions.map((position) => ({
    cells: {
      warehouse: `${position.warehouseCode} · ${position.warehouseName}`,
      before: position.before,
      moved: position.moved,
      after: position.after,
    },
  }));

/** Transfer — executed when it is saved: its layers, and both warehouses before and after. */
export async function transfer(ctx: BuildContext, transferNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const view = await stock.transferView(tx, transferNo);
  if (!view) return null;
  const t = (key: string) => m.admin(`transfers.${key}`);
  const day = (value: string) => formatBusinessDate(value, locale);
  const fields: Fact[] = [
    { label: m.column('document_no'), value: view.transferNo, ltr: true },
    { label: m.column('status'), value: view.ledgerRecorded ? t('ledger_recorded') : t('ledger_missing') },
    { label: m.column('item_name'), value: `${view.itemCode} · ${view.itemName}` },
    { label: m.column('from_warehouse'), value: `${view.fromWarehouseCode} · ${view.fromWarehouseName}` },
    { label: m.column('to_warehouse'), value: `${view.toWarehouseCode} · ${view.toWarehouseName}` },
    { label: m.column('branch_code'), value: view.branchCode, ltr: true },
    { label: m.column('date'), value: day(view.transferDate), ltr: true },
    { label: m.column('quantity'), value: `${view.quantity} ${view.uomCode}`, ltr: true },
    { label: t('cost_carried'), value: formatMoney(view.costIqd, 'IQD', locale), ltr: true },
    { label: m.admin('created_at'), value: `${view.createdByName ?? '—'} · ${formatTimestamp(view.createdAt, locale)}` },
  ];
  return {
    model: {
      kind: 'document',
      title: m.print('titles.transfer'),
      number: view.transferNo,
      status: view.ledgerRecorded ? t('ledger_recorded') : t('ledger_missing'),
      // A transfer the ledger does not hold moved nothing the system can see.
      posted: view.ledgerRecorded,
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: t('lines'),
          columns: layerColumns(m, 'transfers'),
          rows: layerRows(view.layers),
          empty: t('no_layers'),
          totals: {
            label: m.admin('reports.totals'),
            cells: { quantity: sumQuantity(view.layers.map((layer) => layer.quantity)), value: sumMoney(view.layers.map((layer) => layer.valueIqd)) },
          },
        },
        {
          title: `${t('positions')} — ${t('positions_note')}`,
          columns: positionColumns(m, 'transfers'),
          rows: positionRows(view.positions),
          empty: t('ledger_missing_hint'),
        },
      ],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: view.transferNo,
      sheetName: view.transferNo,
    },
    branchCode: view.branchCode,
    objectId: view.id,
  };
}

/** Item Reconciliation — executed when it is saved: its layers, the warehouse before and after, and the journal it posted. */
export async function itemReconciliation(ctx: BuildContext, adjustmentNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const view = await stock.adjustmentView(tx, adjustmentNo);
  if (!view) return null;
  const t = (key: string) => m.admin(`reconciliation.${key}`);
  const day = (value: string) => formatBusinessDate(value, locale);
  const statusText = !view.ledgerRecorded
    ? t('no_ledger_entry')
    : view.journalEntryNo
      ? m.status(view.journalStatus === 'reversed' ? 'reversed' : 'posted')
      : t('recorded');
  const mayReadJournal = can(ctx.principal, 'view', 'journal_entry');
  const fields: Fact[] = [
    { label: m.column('document_no'), value: view.adjustmentNo, ltr: true },
    { label: m.column('status'), value: statusText },
    { label: m.column('item_name'), value: `${view.itemCode} · ${view.itemName}` },
    { label: m.column('warehouse'), value: `${view.warehouseCode} · ${view.warehouseName}` },
    { label: m.column('branch_code'), value: view.branchCode, ltr: true },
    { label: m.column('date'), value: day(view.adjustmentDate), ltr: true },
    { label: m.column('in_out'), value: view.direction === 'in' ? t('in') : t('out') },
    { label: m.column('adjustment_quantity'), value: `${view.quantity} ${view.uomCode}`, ltr: true },
    { label: t('value'), value: formatMoney(view.costIqd, 'IQD', locale), ltr: true },
    { label: t('journal'), value: view.journalEntryNo ?? '—', ltr: true },
    { label: m.admin('created_at'), value: `${view.createdByName ?? '—'} · ${formatTimestamp(view.createdAt, locale)}` },
  ];
  const posting =
    mayReadJournal && view.journalLines.length > 0
      ? [
          {
            title: `${t('posting')} — ${view.journalEntryNo}`,
            columns: [
              { key: 'line', label: '#', kind: 'code', weight: 0.5 },
              { key: 'account', label: m.column('account'), kind: 'text', weight: 3 },
              { key: 'debit', label: m.column('debit'), kind: 'money' },
              { key: 'credit', label: m.column('credit'), kind: 'money' },
            ] satisfies Column[],
            rows: view.journalLines.map((line) => ({
              cells: {
                line: String(line.lineNo),
                account: `${line.accountCode} · ${line.accountName}`,
                debit: line.debitIqd,
                credit: line.creditIqd,
              },
            })),
            empty: t('no_journal'),
            totals: {
              label: m.admin('reports.totals'),
              cells: {
                debit: sumMoney(view.journalLines.map((line) => line.debitIqd)),
                credit: sumMoney(view.journalLines.map((line) => line.creditIqd)),
              },
            },
          },
        ]
      : [];
  return {
    model: {
      kind: 'document',
      title: m.print('titles.item_reconciliation'),
      number: view.adjustmentNo,
      status: statusText,
      posted: view.ledgerRecorded,
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: view.direction === 'in' ? t('lines_in') : t('lines_out'),
          columns: layerColumns(m, 'reconciliation'),
          rows: layerRows(view.layers),
          empty: t('no_layers'),
          totals: {
            label: m.admin('reports.totals'),
            cells: { quantity: sumQuantity(view.layers.map((layer) => layer.quantity)), value: sumMoney(view.layers.map((layer) => layer.valueIqd)) },
          },
        },
        {
          title: `${t('positions')} — ${t('positions_note')}`,
          columns: positionColumns(m, 'reconciliation'),
          rows: positionRows(view.positions),
          empty: t('no_layers'),
        },
        ...posting,
      ],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: view.adjustmentNo,
      sheetName: view.adjustmentNo,
    },
    branchCode: view.branchCode,
    objectId: view.id,
  };
}
