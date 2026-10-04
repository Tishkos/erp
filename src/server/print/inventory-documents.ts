/**
 * Inventory's own documents as printable things — IMPROVEMENT-002.
 *
 *   * `stockCount` — one count: the plan, who counted and approved, and its
 *     lines with the book quantity, what was found, the recount and the
 *     variance. Read through `stock-count.viewByNo`, the page's own reader.
 *
 * Built once into the print model and drawn three ways, like every other
 * document here.
 */
import { formatBusinessDate } from '@/i18n/config';
import * as counts from '../services/stock-count';
import type { BuildContext, Built } from './documents';

export async function stockCount(ctx: BuildContext, countNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await counts.viewByNo(tx, countNo);
  if (!found) return null;
  const { count, lines } = found;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`stock_count.${key}`, values);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const variances = lines.filter((line) => line.variance !== null && Number(line.variance) !== 0).length;

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
