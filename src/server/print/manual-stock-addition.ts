/**
 * The Manual Stock Addition as a printable thing (2026-10-06): the header as
 * its record page shows it, the lines in the units they were written in, the
 * FIFO layers the approval created and — for a reader who may read journals —
 * the journal it posted. Read through `manual-stock-addition.viewByNo`, the
 * page's own reader, so a copy is the screen. Built once into the print
 * model and drawn three ways, like every other document.
 */
import { formatBusinessDate, formatMoney, formatTimestamp } from '@/i18n/config';
import { can } from '@domain/permissions';
import * as additions from '../services/manual-stock-addition';
import { sumMoney } from './decimal';
import type { BuildContext, Built } from './documents';
import type { Column, Fact } from './model';

export async function manualStockAddition(ctx: BuildContext, additionNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const view = await additions.viewByNo(tx, additionNo);
  if (!view) return null;
  const { document: doc, lines, layers, journalLines } = view;
  const t = (key: string) => m.admin(`manual_additions.${key}`);
  const statusText = m.status(doc.status);
  const when = (value: string | null) => (value ? formatTimestamp(value, locale) : '—');

  const fields: Fact[] = [
    { label: m.column('document_no'), value: doc.additionNo, ltr: true },
    { label: m.column('status'), value: statusText },
    { label: t('warehouse'), value: `${doc.warehouseCode} · ${doc.warehouseName}` },
    { label: m.column('branch_code'), value: doc.branchCode, ltr: true },
    { label: t('posting_date'), value: formatBusinessDate(doc.postingDate, locale), ltr: true },
    { label: t('offset_account'), value: doc.offsetAccountCode ? `${doc.offsetAccountCode} · ${doc.offsetAccountName ?? ''}` : t('offset_default') },
    ...(doc.departmentCode ? [{ label: t('department'), value: `${doc.departmentCode} · ${doc.departmentName ?? ''}` }] : []),
    { label: t('reason'), value: doc.reason },
    { label: t('created'), value: `${doc.createdByName ?? '—'} · ${when(doc.createdAt)}` },
    { label: t('submitted'), value: doc.submittedAt ? `${doc.submittedByName ?? '—'} · ${when(doc.submittedAt)}` : '—' },
    { label: t('approved'), value: doc.approvedAt ? `${doc.approvedByName ?? '—'} · ${when(doc.approvedAt)}` : '—' },
    ...(doc.rejectedAt ? [{ label: t('rejected'), value: `${doc.rejectedByName ?? '—'} · ${when(doc.rejectedAt)} · ${doc.rejectionReason ?? ''}` }] : []),
    ...(doc.cancelledAt ? [{ label: t('cancelled'), value: `${doc.cancelledByName ?? '—'} · ${when(doc.cancelledAt)} · ${doc.cancellationReason ?? ''}` }] : []),
    { label: t('journal'), value: doc.journalEntryNo ?? '—', ltr: true },
    { label: t('total'), value: formatMoney(view.totalIqd, 'IQD', locale), ltr: true },
  ];

  const posting =
    can(ctx.principal, 'view', 'journal_entry') && journalLines.length > 0
      ? [
          {
            title: `${t('entries')} — ${doc.journalEntryNo ?? ''}`,
            columns: [
              { key: 'line', label: '#', kind: 'code', weight: 0.5 },
              { key: 'account', label: m.column('account'), kind: 'text', weight: 3 },
              { key: 'debit', label: m.column('debit'), kind: 'money' },
              { key: 'credit', label: m.column('credit'), kind: 'money' },
            ] satisfies Column[],
            rows: journalLines.map((line) => ({
              cells: { line: String(line.lineNo), account: `${line.accountCode} · ${line.accountName}`, debit: line.debitIqd, credit: line.creditIqd },
            })),
            empty: t('no_entries'),
            totals: {
              label: m.admin('reports.totals'),
              cells: {
                debit: sumMoney(journalLines.map((line) => line.debitIqd)),
                credit: sumMoney(journalLines.map((line) => line.creditIqd)),
              },
            },
          },
        ]
      : [];

  return {
    model: {
      kind: 'document',
      title: m.print('titles.manual_stock_addition'),
      number: doc.additionNo,
      status: statusText,
      posted: doc.status === 'approved',
      orientation: 'portrait',
      fields,
      filters: [],
      tables: [
        {
          title: t('lines'),
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.5 },
            { key: 'item', label: m.column('item_code'), kind: 'code' },
            { key: 'name', label: m.column('item_name'), kind: 'text', weight: 2 },
            { key: 'unit', label: t('unit'), kind: 'code' },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
            { key: 'price', label: t('unit_price'), kind: 'money', decimals: 4 },
            { key: 'value', label: t('line_value'), kind: 'money' },
          ] satisfies Column[],
          rows: lines.map((line) => ({
            cells: {
              line: String(line.lineNo),
              item: line.itemCode,
              name: line.itemName,
              unit: line.uomCode,
              quantity: line.quantity,
              price: line.unitCostIqd,
              value: line.lineValueIqd,
            },
          })),
          empty: t('no_lines'),
          totals: { label: m.admin('reports.totals'), cells: { value: sumMoney(lines.map((line) => line.lineValueIqd)) } },
        },
        {
          title: `${t('layers')} — ${t('layers_note')}`,
          columns: [
            { key: 'line', label: '#', kind: 'code', weight: 0.5 },
            { key: 'item', label: m.column('item_code'), kind: 'code' },
            { key: 'batch', label: m.column('batch_number'), kind: 'code' },
            { key: 'layer_date', label: t('layer_date'), kind: 'date' },
            { key: 'quantity', label: m.column('quantity'), kind: 'quantity' },
            { key: 'unit_cost', label: t('unit_cost'), kind: 'money', decimals: 4 },
            { key: 'value', label: t('value'), kind: 'money' },
          ] satisfies Column[],
          rows: layers.map((layer) => ({
            cells: {
              line: String(layer.lineNo),
              item: layer.itemCode,
              batch: layer.batchNumber ?? '—',
              layer_date: layer.layerDate,
              quantity: layer.quantity,
              unit_cost: layer.unitCostIqd,
              value: layer.valueIqd,
            },
          })),
          empty: t('no_layers'),
          ...(layers.length > 0 ? { totals: { label: m.admin('reports.totals'), cells: { value: sumMoney(layers.map((layer) => layer.valueIqd)) } } } : {}),
        },
        ...posting,
      ],
      summary: [{ label: t('lines_count'), value: String(lines.length), ltr: true }],
      signatures: true,
      currency: 'IQD',
      fileName: doc.additionNo,
      sheetName: doc.additionNo,
    },
    branchCode: doc.branchCode,
    objectId: doc.id,
  };
}
