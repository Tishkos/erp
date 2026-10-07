/**
 * Stock Receipts and Stock Issues — IMPROVEMENT-002: two read-only registers
 * over the movement ledger. Nothing is written here; business documents
 * create movements, these screens read and explain them.
 *
 *   receipts   what came into stock: goods receipts, opening stock, container
 *              receipts (an import's arrival from its transit warehouse),
 *              sales and project returns, stock found by a count, an issue
 *              reversed. Valued at what the layer was made at.
 *   issues     what left: sales, project material issues, supplier returns,
 *              write-offs and damage, stock counted short, a receipt reversed.
 *              Valued at what the layers gave up (the consumption rows).
 *
 * Warehouse transfers between stores are neither: they are the Transfers
 * screen's, and both their sides would otherwise appear here as a receipt and
 * an issue of the same goods.
 *
 * Every row names its source document and, where the document has a page,
 * the way to it. Paged at fifty with the true count, under the reader's
 * branches.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '../domain/money';
import type { Principal } from '../domain/permissions';
import { PermissionDeniedError, can } from '../domain/permissions';
import { QUANTITY_FACTOR, parseQuantity } from '../domain/uom';
import { registerPage, searchOf, type RegisterPage, type RegisterPaging } from './register-page';

export const PERMISSION_OBJECT = 'stock_movement';

export type FlowDirection = 'receipt' | 'issue';

export interface FlowRow {
  readonly id: string;
  readonly movementDate: string;
  readonly kind: string;
  readonly itemCode: string;
  readonly itemName: string;
  readonly uomCode: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly branchCode: string;
  /** Positive, in the base unit. */
  readonly quantity: string;
  /** valueIqd ÷ quantity, half up; null when the value is unknown. */
  readonly unitCostIqd: string | null;
  readonly valueIqd: string | null;
  readonly documentType: string | null;
  readonly documentNo: string | null;
  /** The document's own page, where it has one. */
  readonly documentHref: string | null;
  readonly journalEntryNo: string | null;
  readonly raisedBy: string | null;
}

export interface FlowFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly warehouseCode?: string | null;
  readonly kind?: string | null;
  /** The register's order: newest first (the default) or oldest first (2026-10-07). */
  readonly sort?: 'newest' | 'oldest' | null;
}

/** The movement kinds each register shows, in the order the filter offers them. */
export const RECEIPT_KINDS = ['goods_receipt', 'opening_stock', 'transfer_receipt', 'sales_return', 'project_return', 'count_adjustment', 'reversal'] as const;
export const ISSUE_KINDS = ['delivery', 'project_issue', 'goods_return', 'write_off', 'damage', 'count_adjustment', 'reversal'] as const;

interface Raw {
  id: string;
  movementDate: string;
  kind: string;
  itemCode: string;
  itemName: string;
  uomCode: string;
  warehouseCode: string;
  warehouseName: string;
  branchCode: string;
  quantity: string;
  value: string | null;
  sourceType: string | null;
  sourceId: string | null;
  documentNo: string | null;
  issueDocumentNo: string | null;
  payableNo: string | null;
  journalEntryNo: string | null;
  raisedBy: string | null;
}

function hrefOf(row: Raw): string | null {
  const no = row.documentNo;
  switch (row.sourceType) {
    case 'ap_invoice':
    case 'supplier_shipment':
      return no ? `/payables/invoices/${encodeURIComponent(no)}` : null;
    case 'ar_invoice':
      return no ? `/sales/ar-invoices/${encodeURIComponent(no)}` : null;
    case 'sales_return':
      return no ? `/sales/sales-returns/${encodeURIComponent(no)}` : null;
    case 'goods_return':
      return no ? `/payables/goods-returns/${encodeURIComponent(no)}` : null;
    case 'opening_stock':
      return no ? `/inventory/opening-stock/${encodeURIComponent(no)}` : null;
    case 'manual_stock_addition':
      return no ? `/inventory/manual-additions/${encodeURIComponent(no)}` : null;
    case 'stock_adjustment':
      return no ? `/inventory/stock-reconciliation/${encodeURIComponent(no)}` : '/inventory/stock-reconciliation';
    case 'stock_count':
      return no ? `/inventory/stock-count/${encodeURIComponent(no)}` : null;
    case 'container_receipt':
      return row.payableNo ? `/payables/${encodeURIComponent(row.payableNo)}` : null;
    case 'project':
      return row.issueDocumentNo ? `/projects/material-issues/${encodeURIComponent(row.issueDocumentNo)}` : null;
    case 'delivery_note':
      return no ? `/sales/delivery-notes/${encodeURIComponent(no)}` : null;
    default:
      return null;
  }
}

/** The register, one direction. */
export async function forScreen(tx: Tx, principal: Principal, direction: FlowDirection, filter: FlowFilter = {}): Promise<RegisterPage<FlowRow>> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) throw new PermissionDeniedError(principal.userId, 'view', PERMISSION_OBJECT);
  const kinds = direction === 'receipt' ? RECEIPT_KINDS : ISSUE_KINDS;
  const chosen = filter.kind && (kinds as readonly string[]).includes(filter.kind) ? filter.kind : null;
  const parts = [
    direction === 'receipt' ? sql`m.quantity > 0` : sql`m.quantity < 0`,
    sql`m.kind::text in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})`,
    // A transfer between stores is the Transfers screen's; an import's arrival from its transit warehouse is a receipt.
    direction === 'receipt' ? sql`(m.kind <> 'transfer_receipt' or m.source_document_type = 'container_receipt')` : sql`m.kind <> 'transfer_issue'`,
    principal.isSuperUser ? null : sql`app_branch_allowed(m.branch_code)`,
    filter.from ? sql`m.movement_date >= ${filter.from}::date` : null,
    filter.to ? sql`m.movement_date <= ${filter.to}::date` : null,
    filter.warehouseCode ? sql`m.warehouse_code = ${filter.warehouseCode}` : null,
    chosen ? sql`m.kind::text = ${chosen}` : null,
    searchOf([sql`m.item_code`, sql`i.name`, sql`m.warehouse_code`, sql`d.document_no`], filter.search),
  ].filter((part): part is NonNullable<typeof part> => part !== null);

  const from = sql`
    from inventory_movement m
    join item i on i.code = m.item_code
    join warehouse w on w.code = m.warehouse_code
    left join app_user u on u.id = m.created_by
    left join journal_entry j on j.id = m.journal_entry_id
    left join lateral (
      select coalesce(
        (select invoice_no from ap_invoice where id::text = m.source_document_id and m.source_document_type in ('ap_invoice', 'supplier_shipment')),
        (select invoice_no from ar_invoice where id::text = m.source_document_id and m.source_document_type = 'ar_invoice'),
        (select return_no from sales_return where id::text = m.source_document_id and m.source_document_type = 'sales_return'),
        (select return_no from goods_return where id::text = m.source_document_id and m.source_document_type = 'goods_return'),
        (select adjustment_no from stock_adjustment where id::text = m.source_document_id and m.source_document_type = 'stock_adjustment'),
        (select document_no from opening_stock where id::text = m.source_document_id and m.source_document_type = 'opening_stock'),
        (select addition_no from manual_stock_addition where id::text = m.source_document_id and m.source_document_type = 'manual_stock_addition'),
        (select count_no from stock_count where id::text = m.source_document_id and m.source_document_type = 'stock_count'),
        (select receipt_no from container_receipt where id::text = m.source_document_id and m.source_document_type = 'container_receipt'),
        (select delivery_note_no from delivery_note where id::text = m.source_document_id and m.source_document_type = 'delivery_note'),
        (select d2.document_no from project_material_issue_line l2 join project_material_issue d2 on d2.id = l2.issue_id where l2.movement_id = m.id limit 1)
      ) as document_no,
      (select d2.document_no from project_material_issue_line l2 join project_material_issue d2 on d2.id = l2.issue_id where l2.movement_id = m.id limit 1) as issue_document_no,
      (select p.payable_no from container_receipt r join payable p on p.id = r.payable_id where r.id::text = m.source_document_id and m.source_document_type = 'container_receipt') as payable_no
    ) d on true
    where ${sql.join(parts, sql` and `)}`;

  const value =
    direction === 'receipt'
      ? sql`(select round(cl.original_quantity * coalesce(
                 (select a.unit_cost_before from landed_cost_layer_adjustment a join landed_cost_lock k on k.id = a.lock_id
                   where a.cost_layer_id = cl.id order by k.sequence limit 1), cl.unit_cost_iqd), 4)
               from cost_layer cl where cl.created_by_movement_id = m.id limit 1)`
      : sql`(select round(sum(c.cost_iqd), 4) from cost_layer_consumption c where c.movement_id = m.id)`;

  return registerPage<FlowRow>({
    paging: filter,
    count: async () => Number(((await tx.execute(sql`select count(*)::int as n ${from}`)).rows[0] as { n: number }).n),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select m.id, m.movement_date::text as "movementDate", m.kind::text as kind, m.item_code as "itemCode", i.name as "itemName",
               i.base_uom_code as "uomCode", m.warehouse_code as "warehouseCode", w.name as "warehouseName", m.branch_code as "branchCode",
               abs(m.quantity)::text as quantity, ${value}::text as value,
               m.source_document_type as "sourceType", m.source_document_id as "sourceId", d.document_no as "documentNo",
               d.issue_document_no as "issueDocumentNo", d.payable_no as "payableNo", j.entry_no as "journalEntryNo",
               coalesce(u.display_name, u.email) as "raisedBy"
          ${from}
         ${filter.sort === 'oldest' ? sql`order by m.movement_date asc, m.created_at asc, m.id asc` : sql`order by m.movement_date desc, m.created_at desc, m.id desc`}
         limit ${limit} offset ${offset}`);
      return (result.rows as unknown as Raw[]).map((row) => {
        const quantity = row.quantity;
        const valueIqd = row.value;
        const units = parseQuantity(quantity);
        const unit = valueIqd !== null && units !== 0n ? toDecimalString(divideHalfUp(parseDecimal(valueIqd, MONEY_SCALE) * QUANTITY_FACTOR, units), MONEY_SCALE) : null;
        return {
          id: row.id,
          movementDate: row.movementDate,
          kind: row.kind,
          itemCode: row.itemCode,
          itemName: row.itemName,
          uomCode: row.uomCode,
          warehouseCode: row.warehouseCode,
          warehouseName: row.warehouseName,
          branchCode: row.branchCode,
          quantity,
          unitCostIqd: unit,
          valueIqd,
          documentType: row.sourceType === 'project' && row.issueDocumentNo ? 'project_material_issue' : row.sourceType,
          documentNo: row.documentNo,
          documentHref: hrefOf(row),
          journalEntryNo: row.journalEntryNo,
          raisedBy: row.raisedBy,
        };
      });
    },
  });
}

/** The warehouses the filter offers. */
export async function warehouses(tx: Tx, principal: Principal) {
  const result = await tx.execute(sql`
    select w.code, w.name from warehouse w
     where w.active ${principal.isSuperUser ? sql`` : sql`and app_branch_allowed(w.branch_code)`}
     order by w.code`);
  return result.rows as unknown as { code: string; name: string }[];
}
