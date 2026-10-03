/**
 * The B/L as a document — IMPROVEMENT-002 (sponsor, 2026-10-03: "attachment
 * and print and audit icon as other pages"). The B/L's boxes, its containers
 * (number, size/type, seal, ETA, status) and what each carries, model by
 * model: planned, received, damaged, short. One model for the PDF, the
 * workbook and the Word file, read through the reader's own row security.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { formatBusinessDate } from '@/i18n/config';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { shipmentContainerLine } from '../db/schema';
import * as shipments from '../services/shipments';
import type { BuildContext, Built } from './documents';
import type { Row } from './model';

const qty = (value: string | null | undefined) => (value === null || value === undefined ? '0' : formatQuantity(parseQuantity(value)));

export async function billOfLading(ctx: BuildContext, blNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let found: Awaited<ReturnType<typeof shipments.viewBl>>;
  try {
    found = await shipments.viewBl(tx, blNo);
  } catch {
    return null;
  }
  const { bl, owner, containers, progress } = found;
  const t = (key: string) => m.admin(`shipments.${key}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const ids = containers.map((c) => c.id);
  const lines = ids.length
    ? await tx
        .select()
        .from(shipmentContainerLine)
        .where(and(inArray(shipmentContainerLine.containerId, ids), isNull(shipmentContainerLine.supersededAt)))
        .orderBy(asc(shipmentContainerLine.lineNo))
    : [];
  const numberOf = new Map(containers.map((c) => [c.id, c.containerNo]));
  const lineRows: Row[] = lines
    .slice()
    .sort((a, b) => (numberOf.get(a.containerId) ?? '').localeCompare(numberOf.get(b.containerId) ?? '') || a.lineNo - b.lineNo)
    .map((line) => ({
      cells: {
        container: numberOf.get(line.containerId) ?? '',
        model: `${line.itemCode ?? ''} ${line.description}`.trim(),
        unit: line.uomCode ?? '',
        planned: qty(line.plannedQty),
        received: qty(line.receivedQty),
        damaged: qty(line.damagedQty),
        short: qty(line.shortQty),
      },
    }));
  return {
    model: {
      kind: 'document',
      title: m.print('titles.bill_of_lading'),
      number: bl.blNo,
      status: bl.cancelledAt ? t('cancelled') : m.admin('shipments.x_of_y', { received: progress.received, total: progress.total }),
      posted: true,
      orientation: 'landscape',
      fields: [
        { label: t('bl_no'), value: bl.blNo, ltr: true },
        { label: t('bl_date'), value: day(bl.blDate), ltr: true },
        { label: t('eta'), value: day(bl.eta), ltr: true },
        { label: t('import'), value: `${owner.payableNo} · ${owner.supplierReference}`, ltr: true },
        { label: t('supplier'), value: found.supplier ? `${found.supplier.name} (${found.supplier.code})` : '—' },
        { label: t('vessel'), value: [bl.vessel, bl.voyage].filter(Boolean).join(' / ') || '—' },
        { label: t('shipping_line'), value: bl.shippingLine ?? '—' },
        { label: t('port_of_loading'), value: bl.portOfLoading ?? '—' },
        { label: t('port_of_discharge'), value: found.port?.name ?? '—' },
      ],
      filters: [],
      tables: [
        {
          title: t('containers'),
          columns: [
            { key: 'container', label: t('container_no'), kind: 'code' },
            { key: 'size', label: t('size_type'), kind: 'code' },
            { key: 'seal', label: t('seal_no'), kind: 'code' },
            { key: 'eta', label: t('eta'), kind: 'date' },
            { key: 'status', label: t('status'), kind: 'text' },
            { key: 'warehouse', label: t('warehouse'), kind: 'code' },
          ],
          rows: containers.map((c) => ({
            cells: {
              container: c.containerNo,
              size: c.sizeType ?? '',
              seal: c.sealNo ?? '',
              eta: c.eta ?? '',
              status: c.cancelledAt ? t('cancelled') : locale === 'en' ? c.statusName : m.admin(`shipments.cs.${c.statusCode}`),
              warehouse: c.warehouseCode ?? '',
            },
          })),
          empty: t('no_containers'),
        },
        {
          title: t('quantities'),
          columns: [
            { key: 'container', label: t('container_no'), kind: 'code' },
            { key: 'model', label: t('model'), kind: 'text', weight: 2 },
            { key: 'unit', label: t('unit'), kind: 'code' },
            { key: 'planned', label: t('planned'), kind: 'quantity' },
            { key: 'received', label: t('received'), kind: 'quantity' },
            { key: 'damaged', label: t('damaged'), kind: 'quantity' },
            { key: 'short', label: t('short'), kind: 'quantity' },
          ],
          rows: lineRows,
          empty: t('no_containers'),
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: bl.blNo,
      sheetName: bl.blNo,
    },
    branchCode: bl.branchCode,
    objectId: bl.id,
  };
}
