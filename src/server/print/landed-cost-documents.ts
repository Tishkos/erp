/**
 * The Final Cost of an import as a document — IMPROVEMENT-002 (sponsor,
 * 2026-10-04): "where i can find final item cost please it should show final
 * item cost per quantity", and it must print.
 *
 * One model, read from `services/final-cost.finalCostTrace` — the same figures
 * the import page shows — drawn three ways. Per model: what the invoice priced
 * a unit at, what the charges added, what one unit finally cost and what the
 * stock is worth now. Per received layer: the chain of unit costs, purchase →
 * each lock → final. Per lock: its charges by type and whether it is whole.
 * Where the departed part went, by transaction type and document number —
 * never a project code or a WBS element: the import sees inventory
 * transactions, not projects.
 */
import { formatBusinessDate } from '@/i18n/config';
import * as finalCost from '../services/final-cost';
import * as payables from '../services/payables';
import type { BuildContext, Built } from './documents';

/** The destination roles and movement kinds the catalogue names (`admin.landed_cost.role_name` / `kind_name`). */
const ROLES: ReadonlySet<string> = new Set(['cogs', 'project_material_cost', 'inventory_loss', 'inventory_adjustment', 'purchase_variance', 'return_clearing']);
const KINDS: ReadonlySet<string> = new Set([
  'delivery', 'project_issue', 'project_return', 'write_off', 'damage', 'count_adjustment', 'goods_return', 'sales_return', 'reversal',
]);

export async function finalCostOfImport(ctx: BuildContext, payableNo: string): Promise<Built | null> {
  const { tx, m, locale } = ctx;
  const found = await payables.view(tx, payableNo).catch(() => null);
  if (!found) return null;
  const { payable: row, type, supplier } = found;
  const trace = await finalCost.finalCostTrace(tx, row.id);
  if (trace.models.length === 0) return null;

  const t = (key: string, values?: Record<string, string | number>) => m.admin(`landed_cost.${key}`, values);
  const p = (key: string, values?: Record<string, string | number>) => m.admin(`payables.${key}`, values);
  const day = (value: string | null) => (value ? formatBusinessDate(value, locale) : '—');
  const yesNo = (value: boolean) => (value ? m.admin('yes') : m.admin('no'));
  const roleName = (role: string) => (ROLES.has(role) ? t(`role_name.${role}`) : role.replace(/_/g, ' '));
  const kindName = (kind: string | null) =>
    kind === null ? t('kind_rounding') : KINDS.has(kind) ? t(`kind_name.${kind}`) : kind.replace(/_/g, ' ');
  const unit = { kind: 'money' as const, decimals: 4 };

  return {
    model: {
      kind: 'document',
      title: m.print('titles.landed_cost_final'),
      number: row.payableNo,
      status: trace.locks.length > 0 ? t('state_locked') : t('state_open'),
      posted: trace.locks.length > 0,
      orientation: 'landscape',
      fields: [
        { label: p('col_no'), value: row.payableNo, ltr: true },
        { label: p('supplier'), value: supplier?.name ?? '—' },
        { label: p('col_type'), value: type.name },
        { label: t('locks_title'), value: String(trace.locks.length), ltr: true },
        { label: p('col_branch'), value: row.branchCode, ltr: true },
      ],
      filters: [],
      tables: [
        {
          title: t('final_title'),
          columns: [
            { key: 'model', label: t('col_model'), kind: 'code' },
            { key: 'received', label: t('col_received'), kind: 'quantity' },
            { key: 'onHand', label: t('col_on_hand'), kind: 'quantity' },
            { key: 'invoicedUnit', label: t('col_invoiced_unit'), ...unit },
            { key: 'chargesUnit', label: t('col_charges_unit'), ...unit },
            { key: 'finalUnit', label: t('col_final_unit'), ...unit },
            { key: 'purchase', label: t('col_purchase_value'), kind: 'money' },
            { key: 'charges', label: t('col_charges_total'), kind: 'money' },
            { key: 'stock', label: t('col_final_value'), kind: 'money' },
            { key: 'departed', label: t('col_departed'), kind: 'money' },
            { key: 'consumed', label: t('col_consumed'), kind: 'money' },
            { key: 'unexplained', label: t('col_unexplained'), kind: 'money' },
          ],
          rows: trace.models.map((model) => ({
            cells: {
              model: model.itemCode,
              received: model.totals.receivedQty,
              onHand: model.totals.onHandQty,
              invoicedUnit: model.totals.invoicedUnitIqd,
              chargesUnit: model.totals.chargesUnitIqd,
              finalUnit: model.totals.finalUnitIqd,
              purchase: model.totals.purchaseValueIqd,
              charges: model.totals.chargesIqd,
              stock: model.totals.stockValueIqd,
              departed: model.totals.departedIqd,
              consumed: model.totals.consumedIqd,
              unexplained: model.totals.unexplainedIqd,
            },
          })),
          empty: t('none'),
        },
        {
          title: t('chain_title'),
          columns: [
            { key: 'model', label: t('col_model'), kind: 'code' },
            { key: 'warehouse', label: m.print('warehouse'), kind: 'code' },
            { key: 'date', label: t('col_date'), kind: 'date' },
            { key: 'received', label: t('col_received'), kind: 'quantity' },
            { key: 'onHand', label: t('col_on_hand'), kind: 'quantity' },
            { key: 'purchaseUnit', label: t('col_invoiced_unit'), ...unit },
            { key: 'agreed', label: t('col_agreed'), kind: 'text' },
            { key: 'chain', label: t('col_chain'), kind: 'text', weight: 3 },
            { key: 'finalUnit', label: t('col_final_unit'), ...unit },
            { key: 'invoice', label: p('col_invoice_no'), kind: 'code' },
          ],
          rows: trace.models.flatMap((model) =>
            model.layers.map((layer) => ({
              cells: {
                model: model.itemCode,
                warehouse: layer.warehouseCode,
                date: layer.layerDate,
                received: layer.receivedQty,
                onHand: layer.onHandQty,
                purchaseUnit: layer.purchase.unitIqd,
                agreed: layer.purchase.agreed
                  ? t('agreed_derived', {
                      amount: layer.purchase.agreed.derivedUnitTxn,
                      currency: layer.purchase.agreed.currency,
                      rate: layer.purchase.agreed.rate,
                    })
                  : '—',
                chain: layer.unitCostChainText,
                finalUnit: layer.finalUnitIqd,
                invoice: layer.purchase.invoice?.invoiceNo ?? '—',
              },
            })),
          ),
          empty: t('none'),
        },
        {
          title: t('locks_title'),
          columns: [
            { key: 'lock', label: t('col_lock'), kind: 'code' },
            { key: 'date', label: t('col_date'), kind: 'date' },
            { key: 'journal', label: t('col_journal'), kind: 'code' },
            { key: 'basis', label: t('col_basis'), kind: 'text' },
            { key: 'types', label: t('col_charge_types'), kind: 'text', weight: 3 },
            { key: 'total', label: t('col_total'), kind: 'money' },
            { key: 'stock', label: t('col_stock'), kind: 'money' },
            { key: 'departures', label: t('col_departed'), kind: 'money' },
            { key: 'rounding', label: t('col_rounding'), kind: 'money' },
            { key: 'balanced', label: t('col_balanced'), kind: 'text' },
          ],
          rows: trace.locks.map((lock) => ({
            cells: {
              lock: lock.lockNo,
              date: lock.lockDate,
              journal: lock.entryNo ?? '—',
              basis: lock.basisName ?? lock.basisCode,
              types: lock.chargeTypes
                .map(
                  (charge) =>
                    `${charge.chargeTypeName ?? charge.chargeTypeCode} ${charge.amountIqd}` +
                    (charge.sources.length ? ` (${charge.sources.map((source) => source.sourceNo ?? source.sourceType).join(', ')})` : ''),
                )
                .join('; '),
              total: lock.reconciliation.totalIqd,
              stock: lock.reconciliation.inventoryIqd,
              departures: lock.reconciliation.departureIqd,
              rounding: lock.reconciliation.roundingIqd,
              balanced: yesNo(lock.reconciliation.balanced),
            },
          })),
          empty: t('none'),
        },
        {
          title: t('departures_title'),
          columns: [
            { key: 'model', label: t('col_model'), kind: 'code' },
            { key: 'lock', label: t('col_lock'), kind: 'code' },
            { key: 'kind', label: t('col_transaction'), kind: 'text' },
            { key: 'document', label: p('col_no'), kind: 'code' },
            { key: 'on', label: t('col_date'), kind: 'date' },
            { key: 'role', label: t('col_destination'), kind: 'text' },
            { key: 'account', label: m.admin('journals.account'), kind: 'code' },
            { key: 'quantity', label: t('col_quantity'), kind: 'quantity' },
            { key: 'amount', label: t('col_amount'), kind: 'money' },
          ],
          rows: trace.models.flatMap((model) =>
            model.layers.flatMap((layer) =>
              layer.departures.flatMap((group) =>
                group.entries.flatMap((entry) =>
                  [entry.departure, ...entry.returns]
                    .filter((line): line is NonNullable<typeof line> => line !== null)
                    .map((line) => ({
                      cells: {
                        model: model.itemCode,
                        lock: line.lockNo,
                        kind: line.kind === 'return' ? t('kind_return', { kind: kindName(line.movementKind) }) : kindName(line.movementKind),
                        document: line.documentNo ?? '—',
                        on: line.departedOn,
                        role: roleName(line.destinationRole) + (line.postSettlement ? ` · ${t('post_settlement')}` : ''),
                        account: line.accountCode ?? '—',
                        quantity: line.quantity,
                        amount: line.amountIqd,
                      },
                    })),
                ),
              ),
            ),
          ),
          empty: t('no_departures'),
        },
      ],
      summary: trace.models.map((model) => ({
        label: `${model.itemCode} — ${t('col_final_unit')}`,
        value: `${model.totals.finalUnitIqd} IQD`,
        ltr: true,
      })),
      signatures: false,
      currency: 'IQD',
      fileName: `${row.payableNo}-final-cost`,
      sheetName: t('final_title'),
    },
    branchCode: row.branchCode,
    objectId: row.id,
  };
}
