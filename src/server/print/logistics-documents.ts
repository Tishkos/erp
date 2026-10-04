/**
 * The Logistics records as documents — REQ-LOG-001 item 23. Four doors on
 * every record (2026-10-04): the PD, the container, the container receipt
 * and the customs declaration had no print model, so each gets one here —
 * its boxes as the screen shows them and its lines as the screen lists
 * them. One model for the PDF, the workbook and the Word file, read through
 * the reader's own row security.
 */
import { formatBusinessDate } from '@/i18n/config';
import en from '../../../messages/en.json';
import { formatQuantity, parseQuantity } from '../domain/uom';
import * as customs from '../services/customs-pd';
import * as declarations from '../services/customs-declarations';
import * as ports from '../services/ports';
import * as views from '../services/logistics-views';
import * as shipments from '../services/shipments';
import type { BuildContext, Built } from './documents';
import type { Row } from './model';

const PD_TRANSLATED = new Set(Object.keys(en.admin.customs_pd.ps));
const CS_TRANSLATED = new Set(Object.keys(en.admin.shipments.cs));
const qty = (value: string | null | undefined) => (value === null || value === undefined ? '0' : formatQuantity(parseQuantity(value)));

/** The PD — `/payables/pd/[pdNo]`, addressed by number (its latest registration year). */
export async function customsPd(ctx: BuildContext, pdNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let found: Awaited<ReturnType<typeof customs.viewByNo>>;
  try {
    found = await customs.viewByNo(tx, pdNo);
  } catch {
    return null;
  }
  const { pd, status } = found;
  const t = (key: string) => m.admin(`customs_pd.${key}`);
  const ps = (code: string, name: string) => (locale !== 'en' && PD_TRANSLATED.has(code) ? t(`ps.${code}`) : name);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const shipping = pd.payableId ? await views.shippingForImport(tx, pd.payableId) : [];
  return {
    model: {
      kind: 'document',
      title: m.print('titles.customs_pd'),
      number: pd.pdNo,
      status: ps(pd.statusCode, status.name),
      posted: true,
      orientation: 'portrait',
      fields: [
        { label: t('pd_no'), value: pd.pdNo, ltr: true },
        { label: t('status'), value: `${ps(pd.statusCode, status.name)} · ${day(pd.statusDate)}` },
        { label: t('import'), value: found.owner ? `${found.owner.payableNo} · ${found.owner.reference ?? ''}`.trim() : t('unlinked'), ltr: true },
        { label: t('supplier'), value: found.owner ? `${found.owner.supplierName} (${found.owner.supplierCode})` : '—' },
        { label: t('bank'), value: found.bank ? `${found.bank.name}${pd.bankSwift ? ` · ${pd.bankSwift}` : ''}` : '—' },
        { label: t('registered'), value: day(pd.registrationDate), ltr: true },
        { label: t('expires'), value: day(pd.expiryDate), ltr: true },
        { label: t('days_left'), value: status.isTerminal ? '—' : String(found.daysLeft), ltr: true },
        { label: t('supersedes'), value: found.supersedes?.pdNo ?? '—', ltr: true },
        { label: t('superseded_by'), value: found.supersededBy?.pdNo ?? '—', ltr: true },
        ...(pd.lastNote ? [{ label: t('note'), value: pd.lastNote }] : []),
      ],
      filters: [],
      tables: [
        {
          title: t('history'),
          columns: [
            { key: 'status', label: t('status'), kind: 'text' },
            { key: 'date', label: t('effective_date'), kind: 'date' },
            { key: 'source', label: t('source'), kind: 'text' },
            { key: 'note', label: t('note'), kind: 'text', weight: 2 },
            { key: 'by', label: t('recorded_by'), kind: 'text' },
          ],
          rows: found.history.map((row) => ({
            cells: {
              status: ps(row.statusCode, found.statusName(row.statusCode)),
              date: row.effectiveDate,
              source: t(`source_${row.source}`),
              note: row.note ?? '',
              by: row.recordedBy ?? t('source_sweep'),
            },
          })),
          empty: t('none'),
        },
        {
          title: m.admin('logistics.pd_shipping_title'),
          columns: [
            { key: 'bl', label: m.admin('shipments.bl_no'), kind: 'code' },
            { key: 'container', label: m.admin('shipments.container_no'), kind: 'code' },
            { key: 'status', label: m.admin('shipments.status'), kind: 'text' },
            { key: 'eta', label: m.admin('shipments.eta'), kind: 'date' },
            { key: 'cleared', label: m.admin('shipments.customs_cleared_on'), kind: 'date' },
            { key: 'received', label: m.admin('shipments.received_on'), kind: 'date' },
            { key: 'warehouse', label: m.admin('shipments.warehouse'), kind: 'code' },
          ],
          rows: shipping.map((row) => ({
            cells: {
              bl: row.blNo,
              container: row.containerNo ?? '',
              status: row.cancelled ? m.admin('shipments.cancelled') : row.statusCode ? (locale !== 'en' && CS_TRANSLATED.has(row.statusCode) ? m.admin(`shipments.cs.${row.statusCode}`) : row.statusName ?? '') : '',
              eta: row.eta ?? row.blEta,
              cleared: row.customsClearedOn,
              received: row.receivedOn,
              warehouse: row.warehouseCode ?? '',
            },
          })),
          empty: m.admin('logistics.pd_no_shipping'),
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: `PD-${pd.pdNo}`,
      sheetName: `PD ${pd.pdNo}`,
    },
    branchCode: pd.branchCode,
    objectId: pd.id,
  };
}

/** The container — `/payables/containers/[containerNo]`, the live trip of that number. */
export async function shipmentContainer(ctx: BuildContext, containerNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let found: Awaited<ReturnType<typeof shipments.viewContainer>>;
  try {
    found = await shipments.viewContainer(tx, containerNo);
  } catch {
    return null;
  }
  const { container, bl, owner, status, lines } = found;
  const t = (key: string) => m.admin(`shipments.${key}`);
  const cs = (code: string, name: string) => (locale !== 'en' && CS_TRANSLATED.has(code) ? t(`cs.${code}`) : name);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const customsStanding = await views.customsForImport(tx, owner.id);
  const pdLine = customsStanding.pds
    .filter((pd) => !pd.superseded)
    .map((pd) => `${pd.pdNo} · ${locale !== 'en' && PD_TRANSLATED.has(pd.statusCode) ? m.admin(`customs_pd.ps.${pd.statusCode}`) : pd.statusName}`)
    .join(', ');
  return {
    model: {
      kind: 'document',
      title: m.print('titles.shipment_container'),
      number: container.containerNo,
      status: container.cancelledAt ? t('cancelled') : cs(container.statusCode, status.name),
      posted: true,
      orientation: 'portrait',
      fields: [
        { label: t('container_no'), value: container.containerNo, ltr: true },
        { label: t('status'), value: `${cs(container.statusCode, status.name)}${container.statusDate ? ` · ${day(container.statusDate)}` : ''}` },
        { label: t('bl_no'), value: bl.blNo, ltr: true },
        { label: t('import'), value: `${owner.payableNo} · ${owner.supplierReference ?? ''}`.trim(), ltr: true },
        { label: t('supplier'), value: found.supplier ? `${found.supplier.name} (${found.supplier.code})` : '—' },
        { label: t('size_type'), value: container.sizeType ?? '—', ltr: true },
        { label: t('seal_no'), value: container.sealNo ?? '—', ltr: true },
        { label: t('eta'), value: day(container.eta), ltr: true },
        { label: t('departed_on'), value: day(container.departedOn), ltr: true },
        { label: t('arrived_port_on'), value: day(container.arrivedPortOn), ltr: true },
        { label: t('customs_cleared_on'), value: day(container.customsClearedOn), ltr: true },
        { label: t('port_file_sent_on'), value: day(container.portFileSentOn), ltr: true },
        { label: t('received_on'), value: day(container.receivedOn), ltr: true },
        { label: t('warehouse'), value: container.warehouseCode ?? '—', ltr: true },
        { label: t('receipt_no'), value: found.receipt?.receiptNo ?? '—', ltr: true },
        { label: m.admin('logistics.customs_status'), value: pdLine || '—' },
        ...(container.cancelReason ? [{ label: t('cancel_reason'), value: container.cancelReason }] : []),
      ],
      filters: [],
      tables: [
        {
          title: t('carries'),
          columns: [
            { key: 'line', label: '#', kind: 'code' },
            { key: 'model', label: t('model'), kind: 'code' },
            { key: 'description', label: t('description'), kind: 'text', weight: 2 },
            { key: 'unit', label: t('unit'), kind: 'code' },
            { key: 'planned', label: t('planned'), kind: 'quantity' },
            { key: 'received', label: t('received'), kind: 'quantity' },
            { key: 'damaged', label: t('damaged'), kind: 'quantity' },
            { key: 'short', label: t('short'), kind: 'quantity' },
          ],
          rows: lines.map(
            (line): Row => ({
              cells: {
                line: String(line.lineNo),
                model: line.itemCode ?? '',
                description: line.description,
                unit: line.uomCode ?? '',
                planned: qty(line.plannedQty),
                received: line.receivedQty === null ? null : qty(line.receivedQty),
                damaged: line.damagedQty === null ? null : qty(line.damagedQty),
                short: line.shortQty === null ? null : qty(line.shortQty),
              },
            }),
          ),
          empty: t('no_plan'),
        },
        {
          title: t('stage_history'),
          columns: [
            { key: 'status', label: t('status'), kind: 'text' },
            { key: 'date', label: t('stage_date'), kind: 'date' },
            { key: 'note', label: t('note'), kind: 'text', weight: 2 },
            { key: 'by', label: t('recorded_by'), kind: 'text' },
          ],
          rows: found.history.map((row) => ({
            cells: { status: cs(row.statusCode, row.statusName), date: row.effectiveDate, note: row.note ?? '', by: row.recordedBy ?? t(`source_${row.source}`) },
          })),
          empty: t('no_containers'),
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: container.containerNo,
      sheetName: container.containerNo,
    },
    branchCode: container.branchCode,
    objectId: container.id,
  };
}

/** The container receipt — addressed by its number; the goods-receipt paper of a container. */
export async function containerReceipt(ctx: BuildContext, receiptNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await views.receiptByNo(tx, receiptNo);
  if (!found) return null;
  const { receipt, container, owner, lines } = found;
  const t = (key: string) => m.admin(`shipments.${key}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  return {
    model: {
      kind: 'document',
      title: m.print('titles.container_receipt'),
      number: receipt.receiptNo,
      status: m.status('posted'),
      posted: true,
      orientation: 'portrait',
      fields: [
        { label: t('receipt_no'), value: receipt.receiptNo, ltr: true },
        { label: t('received_on'), value: day(receipt.receiptDate), ltr: true },
        { label: t('container_no'), value: container.containerNo, ltr: true },
        { label: t('bl_no'), value: found.blNo, ltr: true },
        { label: t('import'), value: `${owner.payableNo} · ${owner.supplierReference ?? ''}`.trim(), ltr: true },
        { label: t('supplier'), value: found.supplierName ?? '—' },
        { label: t('warehouse'), value: `${receipt.warehouseCode}${found.warehouseName ? ` · ${found.warehouseName}` : ''}`, ltr: true },
        { label: t('recorded_by'), value: found.createdByName ?? '—' },
        ...(receipt.varianceReason ? [{ label: t('variance_reason'), value: receipt.varianceReason }] : []),
        ...(receipt.note ? [{ label: t('note'), value: receipt.note }] : []),
      ],
      filters: [],
      tables: [
        {
          title: t('carries'),
          columns: [
            { key: 'line', label: '#', kind: 'code' },
            { key: 'model', label: t('model'), kind: 'code' },
            { key: 'description', label: t('description'), kind: 'text', weight: 2 },
            { key: 'planned', label: t('planned'), kind: 'quantity' },
            { key: 'received', label: t('received'), kind: 'quantity' },
            { key: 'damaged', label: t('damaged'), kind: 'quantity' },
            { key: 'short', label: t('short'), kind: 'quantity' },
            { key: 'moved', label: m.column('quantity'), kind: 'quantity' },
            { key: 'cost', label: m.admin('landed_cost.col_value'), kind: 'money' },
          ],
          rows: lines.map(
            (line): Row => ({
              cells: {
                line: String(line.lineNo),
                model: line.itemCode ?? '',
                description: line.description ?? '',
                planned: qty(line.plannedQty),
                received: qty(line.receivedQty),
                damaged: qty(line.damagedQty),
                short: qty(line.shortQty),
                moved: qty(line.movedQty),
                cost: line.costIqd,
              },
            }),
          ),
          empty: t('no_plan'),
          totals: {
            label: m.column('total'),
            cells: {
              planned: qty(found.totals.planned),
              received: qty(found.totals.received),
              damaged: qty(found.totals.damaged),
              short: qty(found.totals.short),
              moved: qty(found.totals.moved),
              cost: found.totals.costIqd,
            },
          },
        },
      ],
      summary: [],
      signatures: true,
      currency: 'IQD',
      fileName: receipt.receiptNo,
      sheetName: receipt.receiptNo,
    },
    branchCode: receipt.branchCode,
    objectId: container.id,
  };
}

/** The customs declaration — `/logistics/customs-declarations/[declarationNo]`. */
export async function customsDeclaration(ctx: BuildContext, declarationNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let found: Awaited<ReturnType<typeof declarations.viewByNo>>;
  try {
    found = await declarations.viewByNo(tx, declarationNo);
  } catch {
    return null;
  }
  const { declaration, owner, pd, charged } = found;
  const t = (key: string, values?: Record<string, string | number>) => m.admin(`logistics.${key}`, values);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const ps = (code: string, name: string) => (locale !== 'en' && PD_TRANSLATED.has(code) ? m.admin(`customs_pd.ps.${code}`) : name);
  return {
    model: {
      kind: 'document',
      title: m.print('titles.customs_declaration'),
      number: declaration.declarationNo,
      status: t(`ds.${declaration.status}`),
      posted: declaration.status !== 'draft',
      orientation: 'portrait',
      fields: [
        { label: t('declaration_no'), value: declaration.declarationNo, ltr: true },
        { label: t('status'), value: `${t(`ds.${declaration.status}`)} · ${day(declaration.statusDate)}` },
        { label: t('customs_ref'), value: declaration.customsRef ?? '—', ltr: true },
        { label: t('declaration_date'), value: day(declaration.declarationDate), ltr: true },
        { label: t('import'), value: `${owner.payableNo} · ${owner.reference ?? ''}`.trim(), ltr: true },
        { label: t('supplier'), value: `${owner.supplierName} (${owner.supplierCode})` },
        { label: t('pd'), value: pd ? `${pd.pdNo} · ${ps(pd.statusCode, pd.statusName)}` : '—', ltr: true },
        { label: t('hs_code'), value: declaration.hsCode ?? '—', ltr: true },
        { label: t('currency'), value: declaration.currency, ltr: true },
        { label: t('declared_value'), value: declaration.declaredValue, ltr: true },
        { label: t('declared_duty'), value: declaration.declaredDuty, ltr: true },
        { label: t('declared_taxes'), value: declaration.declaredTaxes, ltr: true },
        { label: t('declared_fees'), value: declaration.declaredFees, ltr: true },
        { label: t('declared_total'), value: found.declaredChargesTotal, ltr: true },
        { label: t('raised_by'), value: found.createdByName ?? '—' },
        ...(declaration.reason ? [{ label: t('reason'), value: declaration.reason }] : []),
        ...(declaration.note ? [{ label: t('note'), value: declaration.note }] : []),
      ],
      filters: [],
      tables: [
        {
          title: t('charged_title'),
          columns: [
            { key: 'source', label: t('col_source'), kind: 'code' },
            { key: 'date', label: t('col_charged_on'), kind: 'date' },
            { key: 'amount', label: t('col_amount_iqd'), kind: 'money' },
            { key: 'state', label: t('col_state'), kind: 'text' },
            { key: 'note', label: t('note'), kind: 'text', weight: 2 },
          ],
          rows: charged.rows.map((row) => ({
            cells: {
              source: `${row.sourceType} ${row.sourceNo ?? ''}`.trim(),
              date: row.createdAt.toISOString().slice(0, 10),
              amount: row.amountIqd,
              state: row.lockId ? t('state_locked') : t('state_unlocked'),
              note: row.note ?? '',
            },
          })),
          empty: t('no_charges'),
          totals: { label: t('charged_total'), cells: { amount: charged.totalIqd } },
        },
      ],
      summary: [
        { label: t('declared_total'), value: `${declaration.currency} ${found.declaredChargesTotal}`, ltr: true },
        { label: t('charged_total'), value: charged.totalIqd, ltr: true },
        { label: t('charged_locked'), value: charged.lockedIqd, ltr: true },
      ],
      signatures: false,
      currency: 'IQD',
      fileName: declaration.declarationNo,
      sheetName: declaration.declarationNo,
    },
    branchCode: declaration.branchCode,
    objectId: declaration.id,
  };
}

/** The port — `/logistics/ports/[code]`: its boxes and the B/Ls that discharge there. */
export async function port(ctx: BuildContext, code: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  let found: Awaited<ReturnType<typeof ports.viewByCode>>;
  try {
    found = await ports.viewByCode(tx, code);
  } catch {
    return null;
  }
  const t = (key: string) => m.admin(`logistics.${key}`);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  return {
    model: {
      kind: 'document',
      title: m.print('titles.port'),
      number: found.port.code,
      status: found.port.active ? t('active') : t('retired'),
      posted: true,
      orientation: 'portrait',
      fields: [
        { label: t('port_code'), value: found.port.code, ltr: true },
        { label: t('port_name'), value: found.port.name },
        { label: t('locode'), value: found.port.locode ?? '—', ltr: true },
        { label: t('country'), value: found.port.country ?? '—', ltr: true },
        { label: t('col_bls'), value: String(found.port.blCount), ltr: true },
        { label: t('col_inbound'), value: String(found.port.openContainers), ltr: true },
        { label: t('col_last_used'), value: day(found.port.lastBlDate), ltr: true },
      ],
      filters: [],
      tables: [
        {
          title: t('port_bls_title'),
          columns: [
            { key: 'bl', label: m.admin('shipments.bl_no'), kind: 'code' },
            { key: 'date', label: m.admin('shipments.bl_date'), kind: 'date' },
            { key: 'eta', label: m.admin('shipments.eta'), kind: 'date' },
            { key: 'import', label: t('import'), kind: 'code' },
            { key: 'supplier', label: t('supplier'), kind: 'text', weight: 2 },
            { key: 'from', label: t('col_from'), kind: 'text' },
            { key: 'containers', label: m.admin('shipments.containers'), kind: 'quantity' },
            { key: 'open', label: t('col_open'), kind: 'quantity' },
          ],
          rows: found.bls.map((row) => ({
            cells: {
              bl: row.blNo,
              date: row.blDate,
              eta: row.eta,
              import: row.payableNo,
              supplier: row.supplierName,
              from: row.portOfLoading ?? '',
              containers: String(row.containers),
              open: String(row.open),
            },
          })),
          empty: m.admin('shipments.no_bls'),
        },
      ],
      summary: [],
      signatures: false,
      currency: 'IQD',
      fileName: found.port.code,
      sheetName: found.port.code,
    },
    branchCode: ctx.branchCode,
    objectId: found.port.code,
  };
}
