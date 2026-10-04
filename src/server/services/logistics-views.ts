/**
 * Logistics views — REQ-LOG-001. Every register the Logistics headings show
 * that is **read** over records other modules own, in one file, so the
 * engines (`landed-cost.ts`, `payables.ts`, `inventory.ts`, `shipments.ts`,
 * `customs-pd.ts`) are not edited to feed a screen. Nothing here writes.
 *
 *   Customs — ASYCUDA
 *     dutiesRegister       the import's `customs_asycuda` charges (item 10)
 *     documentsRegister    the files on PDs, readings and declarations (11)
 *   Shipping
 *     shipmentsRegister    one row per import with B/Ls (12)
 *     freightRegister      the `freight` / `port_forwarding` / `other` charges (16)
 *     documentsRegister    the files on B/Ls, containers and imports (17)
 *   In Transit
 *     inTransitInventory   what is owned and not yet on hand, from the ledger (18)
 *     shipmentTracking     every live container: stage, ETA, delay, next action (20)
 *   Landed Costs
 *     landedCostsRegister  every import's charges, lock state and final value (21)
 *     costAllocation       lock → layer adjustment → inventory / COGS → journal (22)
 *
 * The one rule of the In-Transit read (§1): stock in a transit warehouse
 * (`warehouse.is_transit` or `shipment_stage`) is **in transit** — it is not
 * on hand and never available, whatever a warehouse total says. The figures
 * are the ledger's own: `cost_layer` remaining quantities (what each import's
 * invoice put into transit and the container receipts have not yet taken
 * out) and `stock_position` for the ledger sum per warehouse. Nothing is
 * recomputed; the two are shown side by side and must agree.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { businessToday } from '../domain/business-date';
import {
  DUTY_TYPES,
  FREIGHT_TYPES,
  chargeState,
  delayDays,
  lockReason,
  nextAction,
  type ChargeState,
  type NextAction,
} from '../domain/import-logistics';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import * as landed from './landed-cost';
import { registerPage, searchOf, type RegisterPaging } from './register-page';

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);
const qty = (value: string | null | undefined) => formatQuantity(parseQuantity(value ?? '0'));

type Rows<T> = { rows: T[] };

// ---------------------------------------------------------------------------
// Charges — Customs Duties & Taxes (10), Freight & Shipping Costs (16)
// ---------------------------------------------------------------------------

export interface ChargeFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly state?: ChargeState | 'all' | null;
}

export interface ChargeRow {
  readonly id: string;
  readonly chargeTypeCode: string;
  readonly chargeTypeName: string;
  readonly amountTxn: string;
  readonly currency: string;
  readonly amountIqd: string;
  readonly sourceType: string;
  readonly sourceNo: string | null;
  readonly note: string | null;
  readonly reason: string | null;
  readonly lockId: string | null;
  readonly lockSequence: number | null;
  readonly lockDate: string | null;
  readonly entryNo: string | null;
  readonly cancelledAt: Date | null;
  readonly cancelReason: string | null;
  readonly createdAt: Date;
  readonly payableNo: string;
  readonly reference: string | null;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly branchCode: string;
  /** The import's standing PDs, as "9330 · Validated" — the customs status beside the duty. */
  readonly pdSummary: string | null;
  readonly state: ChargeState;
}

async function chargesOf(tx: Tx, types: readonly string[], filter: ChargeFilter) {
  const state = filter.state ?? 'all';
  const stateSql =
    state === 'withdrawn'
      ? sql`c.cancelled_at is not null`
      : state === 'locked'
        ? sql`c.cancelled_at is null and c.lock_id is not null`
        : state === 'unlocked'
          ? sql`c.cancelled_at is null and c.lock_id is null`
          : null;
  const search = searchOf(
    [sql`c.source_no`, sql`c.note`, sql`c.reason`, sql`t.name`, sql`c.charge_type_code`, sql`p.payable_no`, sql`p.supplier_reference`, sql`bp.legal_name`, sql`bp.code`, sql`c.currency`],
    filter.search,
  );
  const parts = [sql`c.charge_type_code in (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`, stateSql, search].filter(
    (part): part is NonNullable<typeof part> => part !== null && part !== undefined,
  );
  const from = sql`
      from landed_cost_charge c
      join landed_cost_type t on t.code = c.charge_type_code
      join payable p on p.id = c.payable_id
      join business_partner bp on bp.id = p.supplier_id
      left join landed_cost_lock k on k.id = c.lock_id
      left join journal_entry j on j.id = k.journal_entry_id
     where ${sql.join(parts, sql` and `)}`;
  return registerPage<ChargeRow>({
    paging: filter,
    count: async () => {
      const result = await tx.execute(sql`select count(*)::int as n ${from}`);
      return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
    },
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select c.id, c.charge_type_code as "chargeTypeCode", t.name as "chargeTypeName",
               c.amount_txn::text as "amountTxn", c.currency, c.amount_iqd::text as "amountIqd",
               c.source_type as "sourceType", c.source_no as "sourceNo", c.note, c.reason,
               c.lock_id as "lockId", k.sequence as "lockSequence", k.lock_date::text as "lockDate", j.entry_no as "entryNo",
               c.cancelled_at as "cancelledAt", c.cancel_reason as "cancelReason", c.created_at as "createdAt",
               p.payable_no as "payableNo", p.supplier_reference as reference, bp.code as "supplierCode", bp.legal_name as "supplierName",
               p.branch_code as "branchCode",
               (select string_agg(d.pd_no || ' · ' || s.name, ', ' order by d.registration_date)
                  from customs_pd d join pd_status s on s.code = d.status_code
                 where d.payable_id = p.id and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "pdSummary"
        ${from}
        order by c.created_at desc, c.id
        limit ${limit} offset ${offset}`);
      return (result.rows as Omit<ChargeRow, 'state'>[]).map((row) => ({ ...row, state: chargeState(row) }));
    },
  });
}

/** Item 10 — every customs / ASYCUDA charge, newest first, with its lock. */
export const dutiesRegister = (tx: Tx, filter: ChargeFilter = {}) => chargesOf(tx, DUTY_TYPES, filter);

/** Item 16 — every freight, port & forwarding and other charge. */
export const freightRegister = (tx: Tx, filter: ChargeFilter = {}) => chargesOf(tx, FREIGHT_TYPES, filter);

/** The totals the register's foot shows: live charges by state, in IQD. */
export async function chargeTotals(tx: Tx, types: readonly string[]) {
  const result = await tx.execute(sql`
    select coalesce(sum(amount_iqd) filter (where cancelled_at is null and lock_id is not null), 0)::text as locked,
           coalesce(sum(amount_iqd) filter (where cancelled_at is null and lock_id is null), 0)::text as unlocked,
           count(*) filter (where cancelled_at is null)::int as live
      from landed_cost_charge
     where charge_type_code in (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`);
  const row = result.rows[0] as { locked: string; unlocked: string; live: number };
  return { lockedIqd: money(amountOf(row.locked)), unlockedIqd: money(amountOf(row.unlocked)), live: row.live };
}

// ---------------------------------------------------------------------------
// Documents — Customs Documents (11), Shipment Documents (17)
// ---------------------------------------------------------------------------

/** Which records' files each register lists. */
export const DOCUMENT_SCOPES = {
  customs: ['customs_pd', 'asycuda_run', 'customs_declaration'],
  shipment: ['bill_of_lading', 'shipment_container', 'payable'],
} as const;
export type DocumentScope = keyof typeof DOCUMENT_SCOPES;

export interface DocumentFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly objectType?: string | null;
}

export interface DocumentRow {
  readonly id: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly version: number;
  readonly createdAt: Date;
  readonly uploadedBy: string | null;
  /** The record's own number: the PD, the reading, the declaration, the B/L, the container, the import. */
  readonly recordNo: string | null;
  /** What narrows the record's page: a PD's year, a container's id. */
  readonly recordYear: number | null;
  readonly payableNo: string | null;
  readonly supplierName: string | null;
}

/**
 * The files filed on the scope's records, newest first. Q6: the attachment
 * has no category — a paper is told by the record it hangs on and its name.
 * Only current, clean, undisposed versions, as the record's own door lists
 * them; an import's files are listed only for imports (payable type).
 */
export async function documentsRegister(tx: Tx, scope: DocumentScope, filter: DocumentFilter = {}) {
  const types = filter.objectType && (DOCUMENT_SCOPES[scope] as readonly string[]).includes(filter.objectType) ? [filter.objectType] : DOCUMENT_SCOPES[scope];
  const record = sql`
      left join customs_pd pd on a.object_type = 'customs_pd' and pd.id::text = a.object_id
      left join asycuda_run ar on a.object_type = 'asycuda_run' and ar.id::text = a.object_id
      left join customs_declaration cd on a.object_type = 'customs_declaration' and cd.id::text = a.object_id
      left join bill_of_lading bl on a.object_type = 'bill_of_lading' and bl.id::text = a.object_id
      left join shipment_container sc on a.object_type = 'shipment_container' and sc.id::text = a.object_id
      left join payable p on p.id = coalesce(pd.payable_id, cd.payable_id, bl.payable_id, sc.payable_id,
                                             case when a.object_type = 'payable' then a.object_id::uuid end)
      left join business_partner bp on bp.id = p.supplier_id
      left join app_user u on u.id = a.uploaded_by`;
  const parts = [
    sql`a.object_type in (${sql.join(types.map((type) => sql`${type}`), sql`, `)})`,
    sql`a.scan_status = 'clean' and a.superseded_by_id is null and a.disposed_at is null`,
    // An import's own files, not every payable's.
    sql`(a.object_type <> 'payable' or p.payable_type_code = 'import')`,
    searchOf(
      [sql`a.file_name`, sql`a.object_type`, sql`pd.pd_no`, sql`ar.run_no`, sql`cd.declaration_no`, sql`bl.bl_no`, sql`sc.container_no`, sql`p.payable_no`, sql`bp.legal_name`, sql`u.display_name`],
      filter.search,
    ),
  ].filter((part): part is NonNullable<typeof part> => part !== null && part !== undefined);
  const from = sql`from attachment a ${record} where ${sql.join(parts, sql` and `)}`;
  return registerPage<DocumentRow>({
    paging: filter,
    count: async () => {
      const result = await tx.execute(sql`select count(*)::int as n ${from}`);
      return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
    },
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select a.id, a.object_type as "objectType", a.object_id as "objectId", a.file_name as "fileName", a.content_type as "contentType",
               a.size_bytes as "sizeBytes", a.version, a.created_at as "createdAt", u.display_name as "uploadedBy",
               coalesce(pd.pd_no, ar.run_no, cd.declaration_no, bl.bl_no, sc.container_no, case when a.object_type = 'payable' then p.payable_no end) as "recordNo",
               pd.registration_year as "recordYear",
               p.payable_no as "payableNo", bp.legal_name as "supplierName"
        ${from}
        order by a.created_at desc, a.id
        limit ${limit} offset ${offset}`);
      return result.rows as unknown as DocumentRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// Shipments (12) — one row per import with B/Ls
// ---------------------------------------------------------------------------

export interface ShipmentFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly view?: 'open' | 'arrived' | 'all' | null;
}

export interface ShipmentRow {
  readonly payableId: string;
  readonly payableNo: string;
  readonly reference: string | null;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly branchCode: string;
  readonly stageCode: string;
  readonly stageName: string | null;
  readonly currency: string;
  readonly blCount: number;
  readonly blNos: string | null;
  readonly containerCount: number;
  readonly received: number;
  readonly open: number;
  readonly late: number;
  readonly firstEta: string | null;
  readonly lastEta: string | null;
  readonly firstDeparted: string | null;
  readonly lastReceived: string | null;
  /** The furthest-back stage any live container is at (the one that holds the shipment up). */
  readonly leastStatusCode: string | null;
  readonly leastStatusName: string | null;
  readonly ports: string | null;
  readonly pdSummary: string | null;
  readonly declarationCount: number;
  readonly clearedDeclarations: number;
}

/** One row per import that has a live B/L: its B/Ls, its containers counted, where it stands. */
export async function shipmentsRegister(tx: Tx, filter: ShipmentFilter = {}) {
  const view = filter.view ?? 'all';
  const viewSql =
    view === 'open'
      ? sql`exists (select 1 from shipment_container c where c.payable_id = p.id and c.cancelled_at is null and c.received_on is null)`
      : view === 'arrived'
        ? sql`not exists (select 1 from shipment_container c where c.payable_id = p.id and c.cancelled_at is null and c.received_on is null)`
        : null;
  const parts = [
    sql`p.payable_type_code = 'import' and p.cancelled_at is null`,
    sql`exists (select 1 from bill_of_lading b where b.payable_id = p.id and b.cancelled_at is null)`,
    viewSql,
    searchOf(
      [
        sql`p.payable_no`,
        sql`p.supplier_reference`,
        sql`bp.legal_name`,
        sql`bp.code`,
        sql`p.stage_code`,
        sql`(select string_agg(b.bl_no, ' ') from bill_of_lading b where b.payable_id = p.id and b.cancelled_at is null)`,
        sql`(select string_agg(c.container_no, ' ') from shipment_container c where c.payable_id = p.id and c.cancelled_at is null)`,
      ],
      filter.search,
    ),
  ].filter((part): part is NonNullable<typeof part> => part !== null && part !== undefined);
  const from = sql`from payable p join business_partner bp on bp.id = p.supplier_id where ${sql.join(parts, sql` and `)}`;
  const live = sql`from shipment_container c where c.payable_id = p.id and c.cancelled_at is null`;
  return registerPage<ShipmentRow>({
    paging: filter,
    count: async () => {
      const result = await tx.execute(sql`select count(*)::int as n ${from}`);
      return Number((result.rows[0] as { n: number } | undefined)?.n ?? 0);
    },
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select p.id as "payableId", p.payable_no as "payableNo", p.supplier_reference as reference,
               bp.code as "supplierCode", bp.legal_name as "supplierName", p.branch_code as "branchCode", p.stage_code as "stageCode",
               (select st.name from payable_stage st where st.payable_type_code = p.payable_type_code and st.code = p.stage_code limit 1) as "stageName",
               p.currency,
               (select count(*)::int from bill_of_lading b where b.payable_id = p.id and b.cancelled_at is null) as "blCount",
               (select string_agg(b.bl_no, ', ' order by b.bl_date) from bill_of_lading b where b.payable_id = p.id and b.cancelled_at is null) as "blNos",
               (select count(*)::int ${live}) as "containerCount",
               (select count(*)::int ${live} and c.received_on is not null) as received,
               (select count(*)::int ${live} and c.received_on is null) as open,
               (select count(*)::int ${live} and c.status_code = 'late') as late,
               (select min(c.eta)::text ${live} and c.received_on is null) as "firstEta",
               (select max(c.eta)::text ${live}) as "lastEta",
               (select min(c.departed_on)::text ${live}) as "firstDeparted",
               (select max(c.received_on)::text ${live}) as "lastReceived",
               (select s.code from shipment_container c join container_status s on s.code = c.status_code
                 where c.payable_id = p.id and c.cancelled_at is null
                 order by case when s.is_exception and not s.counts_as_received then 0 else s.sequence end limit 1) as "leastStatusCode",
               (select s.name from shipment_container c join container_status s on s.code = c.status_code
                 where c.payable_id = p.id and c.cancelled_at is null
                 order by case when s.is_exception and not s.counts_as_received then 0 else s.sequence end limit 1) as "leastStatusName",
               (select string_agg(distinct coalesce(nullif(btrim(b.port_of_loading), ''), '?') || ' → ' || coalesce(pt.name, '?'), ', ')
                  from bill_of_lading b left join port pt on pt.code = b.port_of_discharge_code
                 where b.payable_id = p.id and b.cancelled_at is null) as ports,
               (select string_agg(d.pd_no || ' · ' || s.name, ', ' order by d.registration_date)
                  from customs_pd d join pd_status s on s.code = d.status_code
                 where d.payable_id = p.id and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "pdSummary",
               (select count(*)::int from customs_declaration d where d.payable_id = p.id and d.status not in ('cancelled', 'rejected')) as "declarationCount",
               (select count(*)::int from customs_declaration d where d.payable_id = p.id and d.status = 'cleared') as "clearedDeclarations"
        ${from}
        order by (select min(c.eta) ${live} and c.received_on is null) asc nulls last, p.created_at desc
        limit ${limit} offset ${offset}`);
      return result.rows as unknown as ShipmentRow[];
    },
  });
}

// ---------------------------------------------------------------------------
// In-Transit Inventory (18)
// ---------------------------------------------------------------------------

export interface InTransitFilter {
  readonly search?: string | null;
  readonly payableId?: string | null;
}

export interface InTransitLine {
  readonly payableId: string;
  readonly payableNo: string;
  readonly reference: string | null;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly branchCode: string;
  readonly stageCode: string;
  readonly itemCode: string;
  readonly itemName: string | null;
  readonly baseUomCode: string | null;
  /** The posted invoice lines' quantity in base units — what was bought. */
  readonly ordered: string;
  /** The container plans' quantity, in base units — what is in containers (shipped). */
  readonly shipped: string;
  /** Σ remaining of the invoice's layers still in transit warehouses — owned, not on hand. */
  readonly inTransit: string;
  readonly inTransitValueIqd: string;
  /** The transit warehouses holding it, as "WH-INPROC 200". */
  readonly transitWarehouses: string | null;
  /** Σ moved by the container receipts — what reached a real warehouse. */
  readonly received: string;
  /** What of the received is still in those warehouses (the receipts' layers, remaining). */
  readonly onHandFromImport: string;
  readonly receivedWarehouses: string | null;
  readonly containers: number;
  readonly containersOpen: number;
  readonly invoiceNos: string | null;
  readonly pdSummary: string | null;
  readonly declarationStatus: string | null;
}

/**
 * What is owned and not yet on hand, import by import and item by item,
 * from the ledger: the posted invoice put the goods into a transit warehouse
 * (its cost layers); a container receipt moves them out (`inventory.relocate`,
 * which closes those layers and opens new ones in the real warehouse). So:
 *
 *   in transit  = Σ remaining of the invoice lines' layers in transit warehouses
 *   received    = Σ moved_qty of the import's container receipt lines
 *   on hand     = Σ remaining of the layers the receipts created (what is still there)
 *
 * 500 shipped, 300 received: in transit 200, received 300, on hand 300. The
 * figures never come from a stored total, and `stock_position` is not asked
 * for the import's share — only, in `transitWarehouses()`, for the ledger's
 * own sum per warehouse, which the import rows must add up to.
 */
export async function inTransitInventory(tx: Tx, filter: InTransitFilter = {}): Promise<Rows<InTransitLine>> {
  const search = searchOf(
    [sql`p.payable_no`, sql`p.supplier_reference`, sql`bp.legal_name`, sql`bp.code`, sql`x.item_code`, sql`it.name`, sql`p.branch_code`, sql`p.stage_code`],
    filter.search,
  );
  const result = await tx.execute(sql`
    with inv_lines as (
      select l.id, l.item_code, i.payable_id, i.invoice_no
        from ap_invoice_line l join ap_invoice i on i.id = l.ap_invoice_id
       where i.is_import and i.reversed_at is null
         and i.status in ('posted', 'partially_executed', 'settled') and l.item_code is not null
         ${filter.payableId ? sql`and i.payable_id = ${filter.payableId}` : sql``}
    ), transit as (
      select il.payable_id, cl.item_code, cl.warehouse_code,
             sum(cl.remaining_quantity) as remaining, sum(cl.remaining_quantity * cl.unit_cost_iqd) as value
        from cost_layer cl
        join inventory_movement m on m.id = cl.created_by_movement_id
        join inv_lines il on il.id::text = m.source_line_id
        join warehouse w on w.code = cl.warehouse_code
       where (w.is_transit or w.shipment_stage is not null)
       group by il.payable_id, cl.item_code, cl.warehouse_code
    ), received_layers as (
      select r.payable_id, cl.item_code, cl.warehouse_code, sum(cl.remaining_quantity) as remaining
        from cost_layer cl
        join inventory_movement m on m.id = cl.created_by_movement_id
        join container_receipt r on r.id::text = m.source_document_id
       where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt'
       group by r.payable_id, cl.item_code, cl.warehouse_code
    ), keys as (
      select payable_id, item_code from transit
      union select payable_id, item_code from received_layers
      union select payable_id, item_code from inv_lines
    )
    select p.id as "payableId", p.payable_no as "payableNo", p.supplier_reference as reference,
           bp.code as "supplierCode", bp.legal_name as "supplierName", p.branch_code as "branchCode", p.stage_code as "stageCode",
           x.item_code as "itemCode", it.name as "itemName", it.base_uom_code as "baseUomCode",
           coalesce((select sum(ap.quantity * coalesce(u.conversion_numerator, 1) / coalesce(u.conversion_denominator, 1))
                       from inv_lines il join ap_invoice_line ap on ap.id = il.id
                       left join item_uom u on u.item_id = it.id and u.uom_code = ap.uom_code and ap.uom_code is distinct from it.base_uom_code
                      where il.payable_id = x.payable_id and il.item_code = x.item_code), 0)::text as ordered,
           coalesce((select sum(cl.planned_qty * coalesce(u.conversion_numerator, 1) / coalesce(u.conversion_denominator, 1))
                       from shipment_container_line cl join shipment_container c on c.id = cl.container_id
                       left join item_uom u on u.item_id = it.id and u.uom_code = cl.uom_code and cl.uom_code is distinct from it.base_uom_code
                      where c.payable_id = x.payable_id and c.cancelled_at is null and cl.superseded_at is null and cl.item_code = x.item_code), 0)::text as shipped,
           coalesce((select sum(t.remaining) from transit t where t.payable_id = x.payable_id and t.item_code = x.item_code), 0)::text as "inTransit",
           coalesce((select sum(t.value) from transit t where t.payable_id = x.payable_id and t.item_code = x.item_code), 0)::text as "inTransitValueIqd",
           (select string_agg(t.warehouse_code || ' ' || trim(to_char(t.remaining, 'FM999999999990.######')), ', ' order by t.warehouse_code)
              from transit t where t.payable_id = x.payable_id and t.item_code = x.item_code and t.remaining > 0) as "transitWarehouses",
           coalesce((select sum(rl.moved_qty) from container_receipt_line rl join container_receipt r on r.id = rl.receipt_id
                      where r.payable_id = x.payable_id and rl.item_code = x.item_code), 0)::text as received,
           coalesce((select sum(l.remaining) from received_layers l where l.payable_id = x.payable_id and l.item_code = x.item_code), 0)::text as "onHandFromImport",
           (select string_agg(l.warehouse_code || ' ' || trim(to_char(l.remaining, 'FM999999999990.######')), ', ' order by l.warehouse_code)
              from received_layers l where l.payable_id = x.payable_id and l.item_code = x.item_code and l.remaining > 0) as "receivedWarehouses",
           (select count(distinct c.id)::int from shipment_container c join shipment_container_line cl on cl.container_id = c.id
             where c.payable_id = x.payable_id and c.cancelled_at is null and cl.superseded_at is null and cl.item_code = x.item_code) as containers,
           (select count(distinct c.id)::int from shipment_container c join shipment_container_line cl on cl.container_id = c.id
             where c.payable_id = x.payable_id and c.cancelled_at is null and c.received_on is null and cl.superseded_at is null and cl.item_code = x.item_code) as "containersOpen",
           (select string_agg(distinct il.invoice_no, ', ') from inv_lines il where il.payable_id = x.payable_id and il.item_code = x.item_code) as "invoiceNos",
           (select string_agg(d.pd_no || ' · ' || s.name, ', ' order by d.registration_date)
              from customs_pd d join pd_status s on s.code = d.status_code
             where d.payable_id = p.id and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "pdSummary",
           (select d.status from customs_declaration d where d.payable_id = p.id and d.status not in ('cancelled', 'rejected')
             order by case d.status when 'cleared' then 0 when 'assessed' then 1 when 'accepted' then 2 when 'submitted' then 3 else 4 end, d.declaration_date desc limit 1) as "declarationStatus"
      from keys x
      join payable p on p.id = x.payable_id
      join business_partner bp on bp.id = p.supplier_id
      left join item it on it.code = x.item_code
     where p.cancelled_at is null
       ${search ? sql`and ${search}` : sql``}
     order by (coalesce((select sum(t.remaining) from transit t where t.payable_id = x.payable_id and t.item_code = x.item_code), 0) > 0) desc,
              p.created_at desc, x.item_code`);
  const rows = (result.rows as unknown as InTransitLine[]).map((row) => ({
    ...row,
    ordered: qty(row.ordered),
    shipped: qty(row.shipped),
    inTransit: qty(row.inTransit),
    inTransitValueIqd: money(amountOf(row.inTransitValueIqd)),
    received: qty(row.received),
    onHandFromImport: qty(row.onHandFromImport),
  }));
  return { rows };
}

export interface TransitWarehouseRow {
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly shipmentStage: string | null;
  readonly branchCode: string;
  readonly itemCode: string;
  readonly itemName: string | null;
  /** The ledger's sum for this warehouse and item — `stock_position.on_hand`, which here means *in transit*. */
  readonly ledgerQuantity: string;
  /** Always zero: the view gives a transit warehouse no availability. Shown so the reader sees it. */
  readonly available: string;
  readonly valueIqd: string;
}

/**
 * The authoritative ledger sum per transit warehouse and item, from
 * `stock_position` (Inventory's view). Its `on_hand` column is the
 * warehouse's balance; for a transit warehouse that balance **is** the
 * in-transit quantity and is reported as such — never as on hand. The
 * import rows above must add up to these; `inTransitReconciliation` says
 * whether they do.
 */
export async function transitWarehouses(tx: Tx): Promise<Rows<TransitWarehouseRow>> {
  const result = await tx.execute(sql`
    select p.warehouse_code as "warehouseCode", w.name as "warehouseName", w.shipment_stage as "shipmentStage", p.branch_code as "branchCode",
           p.item_code as "itemCode", it.name as "itemName",
           p.on_hand::text as "ledgerQuantity", p.available::text as available,
           coalesce((select sum(cl.remaining_quantity * cl.unit_cost_iqd) from cost_layer cl
                      where cl.warehouse_code = p.warehouse_code and cl.item_code = p.item_code), 0)::text as "valueIqd"
      from stock_position p
      join warehouse w on w.code = p.warehouse_code
      left join item it on it.code = p.item_code
     where (w.is_transit or w.shipment_stage is not null)
       and app_branch_allowed(p.branch_code)
       and p.on_hand <> 0
     order by w.shipment_stage nulls last, p.warehouse_code, p.item_code`);
  return {
    rows: (result.rows as unknown as TransitWarehouseRow[]).map((row) => ({
      ...row,
      ledgerQuantity: qty(row.ledgerQuantity),
      available: qty(row.available),
      valueIqd: money(amountOf(row.valueIqd)),
    })),
  };
}

/**
 * Do the import rows account for every unit the ledger holds in transit?
 * Per item: the ledger's transit balance against Σ `inTransit` of the import
 * rows. A difference is stock in a transit warehouse that no import's posted
 * invoice put there (a legacy balance, a manual transfer) — reported, never
 * repaired.
 */
export async function inTransitReconciliation(tx: Tx) {
  const [ledger, imports] = await Promise.all([transitWarehouses(tx), inTransitInventory(tx)]);
  const byItem = new Map<string, { ledger: bigint; imports: bigint }>();
  for (const row of ledger.rows) {
    const entry = byItem.get(row.itemCode) ?? { ledger: 0n, imports: 0n };
    entry.ledger += parseQuantity(row.ledgerQuantity);
    byItem.set(row.itemCode, entry);
  }
  for (const row of imports.rows) {
    const entry = byItem.get(row.itemCode) ?? { ledger: 0n, imports: 0n };
    entry.imports += parseQuantity(row.inTransit);
    byItem.set(row.itemCode, entry);
  }
  return [...byItem.entries()]
    .map(([itemCode, entry]) => ({
      itemCode,
      ledger: formatQuantity(entry.ledger),
      imports: formatQuantity(entry.imports),
      difference: formatQuantity(entry.ledger - entry.imports),
      agrees: entry.ledger === entry.imports,
    }))
    .filter((row) => !row.agrees)
    .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
}

// ---------------------------------------------------------------------------
// Shipment Tracking (20)
// ---------------------------------------------------------------------------

export interface TrackingFilter {
  readonly search?: string | null;
  readonly view?: 'open' | 'late' | 'at_port' | 'cleared' | 'all' | null;
  readonly asOf?: string | null;
}

export interface TrackingRow {
  readonly id: string;
  readonly containerNo: string;
  readonly sizeType: string | null;
  readonly statusCode: string;
  readonly statusName: string;
  readonly statusDate: string | null;
  readonly cancelled: boolean;
  readonly eta: string | null;
  readonly departedOn: string | null;
  readonly arrivedPortOn: string | null;
  readonly customsClearedOn: string | null;
  readonly portFileSentOn: string | null;
  readonly receivedOn: string | null;
  readonly warehouseCode: string | null;
  readonly blNo: string;
  readonly vessel: string | null;
  readonly portName: string | null;
  readonly payableNo: string;
  readonly supplierName: string;
  readonly supplierCode: string;
  readonly lastUpdateAt: Date | null;
  readonly lastNote: string | null;
  readonly pdSummary: string | null;
  readonly declarationStatus: string | null;
  readonly planned: string;
  readonly delayDays: number | null;
  readonly nextAction: NextAction | null;
}

/** Every container not yet received (or every one), with how late it is and what it waits for. */
export async function shipmentTracking(tx: Tx, filter: TrackingFilter = {}): Promise<Rows<TrackingRow>> {
  const asOf = filter.asOf ?? businessToday();
  const view = filter.view ?? 'open';
  const viewSql =
    view === 'open'
      ? sql`c.received_on is null and c.cancelled_at is null`
      : view === 'late'
        ? sql`c.status_code = 'late' and c.cancelled_at is null`
        : view === 'at_port'
          ? sql`c.status_code = 'at_port' and c.cancelled_at is null`
          : view === 'cleared'
            ? sql`c.status_code = 'customs_cleared' and c.cancelled_at is null`
            : sql`true`;
  const search = searchOf(
    [sql`c.container_no`, sql`b.bl_no`, sql`b.vessel`, sql`p.payable_no`, sql`bp.legal_name`, sql`s.name`, sql`c.status_code`, sql`pt.name`, sql`c.warehouse_code`],
    filter.search,
  );
  const result = await tx.execute(sql`
    select c.id, c.container_no as "containerNo", c.size_type as "sizeType", c.status_code as "statusCode", s.name as "statusName",
           c.status_date::text as "statusDate", (c.cancelled_at is not null) as cancelled,
           c.eta::text as eta, c.departed_on::text as "departedOn", c.arrived_port_on::text as "arrivedPortOn",
           c.customs_cleared_on::text as "customsClearedOn", c.port_file_sent_on::text as "portFileSentOn", c.received_on::text as "receivedOn",
           c.warehouse_code as "warehouseCode", b.bl_no as "blNo", b.vessel, pt.name as "portName",
           p.payable_no as "payableNo", bp.legal_name as "supplierName", bp.code as "supplierCode",
           (select max(h.recorded_at) from shipment_container_status_history h where h.container_id = c.id) as "lastUpdateAt",
           (select h.note from shipment_container_status_history h where h.container_id = c.id order by h.recorded_at desc limit 1) as "lastNote",
           (select string_agg(d.pd_no || ' · ' || ps.name, ', ' order by d.registration_date)
              from customs_pd d join pd_status ps on ps.code = d.status_code
             where d.payable_id = p.id and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "pdSummary",
           (select d.status from customs_declaration d where d.payable_id = p.id and d.status not in ('cancelled', 'rejected')
             order by case d.status when 'cleared' then 0 when 'assessed' then 1 when 'accepted' then 2 when 'submitted' then 3 else 4 end, d.declaration_date desc limit 1) as "declarationStatus",
           coalesce((select sum(l.planned_qty) from shipment_container_line l where l.container_id = c.id and l.superseded_at is null), 0)::text as planned
      from shipment_container c
      join container_status s on s.code = c.status_code
      join bill_of_lading b on b.id = c.bl_id
      join payable p on p.id = c.payable_id
      join business_partner bp on bp.id = p.supplier_id
      left join port pt on pt.code = b.port_of_discharge_code
     where ${viewSql} ${search ? sql`and ${search}` : sql``}
     order by c.eta asc nulls last, c.container_no`);
  const rows = (result.rows as unknown as Omit<TrackingRow, 'delayDays' | 'nextAction'>[]).map((row) => ({
    ...row,
    planned: qty(row.planned),
    delayDays: delayDays(row.eta, row.receivedOn, asOf),
    nextAction: nextAction({ statusCode: row.statusCode, cancelled: row.cancelled, customsClearedOn: row.customsClearedOn, portFileSentOn: row.portFileSentOn }),
  }));
  return { rows };
}

// ---------------------------------------------------------------------------
// Landed Costs (21)
// ---------------------------------------------------------------------------

export interface LandedCostFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly view?: 'ready' | 'waiting' | 'locked' | 'all' | null;
}

export interface LandedCostRow {
  readonly payableId: string;
  readonly payableNo: string;
  readonly reference: string | null;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly branchCode: string;
  readonly stageCode: string;
  readonly currency: string;
  readonly liveCharges: number;
  readonly unlockedCharges: number;
  readonly unlockedIqd: string;
  readonly lockedIqd: string;
  readonly chargesIqd: string;
  readonly lockCount: number;
  readonly lastLockDate: string | null;
  readonly lastEntryNo: string | null;
  readonly inventoryIqd: string;
  readonly cogsIqd: string;
  readonly containerCount: number;
  readonly containersReceived: number;
  readonly livePds: number;
  readonly pdsWrittenOff: boolean;
  readonly pdSummary: string | null;
  /** The goods' value as the layers hold it now (invoice price plus locked charges), and what is still on hand. */
  readonly finalValueIqd: string;
  readonly receivedQty: string;
  readonly onHandQty: string;
  readonly state: ReturnType<typeof lockReason>;
  readonly allocation: 'none' | 'partial' | 'complete';
}

/**
 * Every import that carries a charge or has received a container: its
 * charges by state, its locks, and why the lock is where it is — the same
 * `lockableState` rule the import page uses, given the same facts.
 */
export async function landedCostsRegister(tx: Tx, filter: LandedCostFilter = {}) {
  const search = searchOf([sql`p.payable_no`, sql`p.supplier_reference`, sql`bp.legal_name`, sql`bp.code`, sql`p.stage_code`, sql`p.branch_code`], filter.search);
  const parts = [
    sql`p.payable_type_code = 'import' and p.cancelled_at is null`,
    sql`(exists (select 1 from landed_cost_charge c where c.payable_id = p.id) or exists (select 1 from container_receipt r where r.payable_id = p.id))`,
    search,
  ].filter((part): part is NonNullable<typeof part> => part !== null && part !== undefined);
  const from = sql`from payable p join business_partner bp on bp.id = p.supplier_id where ${sql.join(parts, sql` and `)}`;
  const charges = sql`from landed_cost_charge c where c.payable_id = p.id and c.cancelled_at is null and c.charge_type_code not in ('purchase')`;
  const result = await tx.execute(sql`
    select p.id as "payableId", p.payable_no as "payableNo", p.supplier_reference as reference, bp.code as "supplierCode", bp.legal_name as "supplierName",
           p.branch_code as "branchCode", p.stage_code as "stageCode", p.currency,
           (select count(*)::int ${charges}) as "liveCharges",
           (select count(*)::int ${charges} and c.lock_id is null) as "unlockedCharges",
           coalesce((select sum(c.amount_iqd) ${charges} and c.lock_id is null), 0)::text as "unlockedIqd",
           coalesce((select sum(c.amount_iqd) ${charges} and c.lock_id is not null), 0)::text as "lockedIqd",
           coalesce((select sum(c.amount_iqd) ${charges}), 0)::text as "chargesIqd",
           (select count(*)::int from landed_cost_lock k where k.payable_id = p.id) as "lockCount",
           (select max(k.lock_date)::text from landed_cost_lock k where k.payable_id = p.id) as "lastLockDate",
           (select j.entry_no from landed_cost_lock k join journal_entry j on j.id = k.journal_entry_id where k.payable_id = p.id order by k.sequence desc limit 1) as "lastEntryNo",
           coalesce((select sum(k.inventory_iqd) from landed_cost_lock k where k.payable_id = p.id), 0)::text as "inventoryIqd",
           coalesce((select sum(k.cogs_iqd) from landed_cost_lock k where k.payable_id = p.id), 0)::text as "cogsIqd",
           (select count(*)::int from shipment_container c where c.payable_id = p.id and c.cancelled_at is null) as "containerCount",
           (select count(*)::int from shipment_container c join container_status s on s.code = c.status_code
             where c.payable_id = p.id and c.cancelled_at is null and s.counts_as_received) as "containersReceived",
           (select count(*)::int from customs_pd d join pd_status s on s.code = d.status_code
             where d.payable_id = p.id and not s.is_terminal and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "livePds",
           (select string_agg(d.pd_no || ' · ' || s.name, ', ' order by d.registration_date)
              from customs_pd d join pd_status s on s.code = d.status_code
             where d.payable_id = p.id and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "pdSummary",
           (select count(*)::int from customs_pd d where d.payable_id = p.id and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "standingPds",
           (select count(*)::int from customs_pd d where d.payable_id = p.id and d.status_code = 'totally_written_off'
               and not exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id)) as "writtenOffPds",
           coalesce((select sum(cl.original_quantity * cl.unit_cost_iqd) from cost_layer cl
                       join inventory_movement m on m.id = cl.created_by_movement_id
                       join container_receipt r on r.id::text = m.source_document_id
                      where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt' and r.payable_id = p.id), 0)::text as "finalValueIqd",
           coalesce((select sum(cl.original_quantity) from cost_layer cl
                       join inventory_movement m on m.id = cl.created_by_movement_id
                       join container_receipt r on r.id::text = m.source_document_id
                      where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt' and r.payable_id = p.id), 0)::text as "receivedQty",
           coalesce((select sum(cl.remaining_quantity) from cost_layer cl
                       join inventory_movement m on m.id = cl.created_by_movement_id
                       join container_receipt r on r.id::text = m.source_document_id
                      where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt' and r.payable_id = p.id), 0)::text as "onHandQty"
    ${from}
    order by (select count(*) ${charges} and c.lock_id is null) desc, p.created_at desc`);
  type Raw = Omit<LandedCostRow, 'pdsWrittenOff' | 'state' | 'allocation'> & { standingPds: number; writtenOffPds: number };
  const all = (result.rows as unknown as Raw[]).map((row): LandedCostRow => {
    const pdsWrittenOff = row.standingPds > 0 && row.writtenOffPds === row.standingPds;
    const containersIn = row.containerCount > 0 && row.containersReceived === row.containerCount;
    const facts = landed.lockableState({
      allPdsWrittenOff: pdsWrittenOff,
      containersIn,
      unlocked: row.unlockedCharges,
      lastSequence: row.lockCount > 0 ? row.lockCount : null,
    });
    const { standingPds: _s, writtenOffPds: _w, ...rest } = row;
    return {
      ...rest,
      unlockedIqd: money(amountOf(row.unlockedIqd)),
      lockedIqd: money(amountOf(row.lockedIqd)),
      chargesIqd: money(amountOf(row.chargesIqd)),
      inventoryIqd: money(amountOf(row.inventoryIqd)),
      cogsIqd: money(amountOf(row.cogsIqd)),
      finalValueIqd: money(amountOf(row.finalValueIqd)),
      receivedQty: qty(row.receivedQty),
      onHandQty: qty(row.onHandQty),
      pdsWrittenOff,
      state: lockReason({ pdsWrittenOff: facts.pdsWrittenOff, containersIn: facts.containersIn, unlocked: facts.unlocked, locked: facts.locked }),
      allocation: row.lockCount === 0 ? 'none' : row.unlockedCharges > 0 ? 'partial' : 'complete',
    };
  });
  const view = filter.view ?? 'all';
  const rows =
    view === 'ready'
      ? all.filter((row) => row.state === 'ready')
      : view === 'waiting'
        ? all.filter((row) => row.state === 'waiting_pds' || row.state === 'waiting_containers' || row.state === 'late_charges')
        : view === 'locked'
          ? all.filter((row) => row.lockCount > 0)
          : all;
  return { rows, total: rows.length };
}

// ---------------------------------------------------------------------------
// Cost Allocation (22)
// ---------------------------------------------------------------------------

export interface AllocationFilter {
  readonly search?: string | null;
  readonly payableId?: string | null;
  readonly lockId?: string | null;
}

export interface AllocationRow {
  readonly id: string;
  readonly lockId: string;
  readonly lockSequence: number;
  readonly lockDate: string;
  readonly basisName: string;
  readonly entryNo: string | null;
  readonly journalStatus: string | null;
  readonly lockTotalIqd: string;
  readonly lockNote: string | null;
  readonly lockedBy: string | null;
  readonly payableNo: string;
  readonly supplierName: string;
  readonly costLayerId: string;
  readonly layerDate: string | null;
  readonly layerSequence: number | null;
  readonly layerOriginalQty: string;
  readonly layerRemainingQty: string;
  readonly layerUnitCostNow: string;
  readonly itemCode: string;
  readonly itemName: string | null;
  readonly warehouseCode: string;
  readonly onHandQty: string;
  readonly unitCostBefore: string;
  readonly unitCostAfter: string;
  readonly allocatedIqd: string;
  readonly inventoryIqd: string;
  readonly cogsIqd: string;
  readonly viaLayerId: string | null;
  readonly viaWarehouseCode: string | null;
  /** The charges this lock consumed, as "freight JV-1 120,000; customs INV-9 80,000". */
  readonly charges: string | null;
}

/**
 * Lock → layer adjustment → inventory / COGS → journal, one row per layer
 * each lock touched. Every figure is the engine's own row; the layer's cost
 * now (`cost_layer.unit_cost_iqd`) is shown beside the adjustment's after,
 * so a later lock's restatement is visible as the gap between them.
 * `landed_cost_departure` (feat/inventory-module) is not on this branch yet;
 * what left a layer is read here from `via_layer_id` and the COGS share
 * only (REQ-LOG-001 Q7 — follow-up).
 */
export async function costAllocation(tx: Tx, filter: AllocationFilter = {}): Promise<Rows<AllocationRow>> {
  const search = searchOf(
    [sql`p.payable_no`, sql`bp.legal_name`, sql`a.item_code`, sql`it.name`, sql`a.warehouse_code`, sql`j.entry_no`, sql`b.name`, sql`k.lock_date`],
    filter.search,
  );
  const result = await tx.execute(sql`
    select a.id, a.lock_id as "lockId", k.sequence as "lockSequence", k.lock_date::text as "lockDate", b.name as "basisName",
           j.entry_no as "entryNo", j.status::text as "journalStatus", k.total_iqd::text as "lockTotalIqd", k.note as "lockNote", u.display_name as "lockedBy",
           p.payable_no as "payableNo", bp.legal_name as "supplierName",
           a.cost_layer_id as "costLayerId", cl.layer_date::text as "layerDate", cl.sequence as "layerSequence",
           cl.original_quantity::text as "layerOriginalQty", cl.remaining_quantity::text as "layerRemainingQty", cl.unit_cost_iqd::text as "layerUnitCostNow",
           a.item_code as "itemCode", it.name as "itemName", a.warehouse_code as "warehouseCode",
           a.on_hand_qty::text as "onHandQty", a.unit_cost_before::text as "unitCostBefore", a.unit_cost_after::text as "unitCostAfter",
           a.allocated_iqd::text as "allocatedIqd", a.inventory_iqd::text as "inventoryIqd", a.cogs_iqd::text as "cogsIqd",
           a.via_layer_id as "viaLayerId", via.warehouse_code as "viaWarehouseCode",
           (select string_agg(c.charge_type_code || coalesce(' ' || c.source_no, '') || ' ' || trim(to_char(c.amount_iqd, 'FM999999999990')), '; ' order by c.created_at)
              from landed_cost_charge c where c.lock_id = k.id) as charges
      from landed_cost_layer_adjustment a
      join landed_cost_lock k on k.id = a.lock_id
      join landed_cost_basis b on b.code = k.basis_code
      join journal_entry j on j.id = k.journal_entry_id
      left join app_user u on u.id = k.locked_by
      join payable p on p.id = a.payable_id
      join business_partner bp on bp.id = p.supplier_id
      join cost_layer cl on cl.id = a.cost_layer_id
      left join cost_layer via on via.id = a.via_layer_id
      left join item it on it.code = a.item_code
     where true
       ${filter.payableId ? sql`and a.payable_id = ${filter.payableId}` : sql``}
       ${filter.lockId ? sql`and a.lock_id = ${filter.lockId}` : sql``}
       ${search ? sql`and ${search}` : sql``}
     order by k.lock_date desc, k.sequence desc, a.item_code, a.warehouse_code, cl.layer_date, cl.sequence`);
  return {
    rows: (result.rows as unknown as AllocationRow[]).map((row) => ({
      ...row,
      lockTotalIqd: money(amountOf(row.lockTotalIqd)),
      layerOriginalQty: qty(row.layerOriginalQty),
      layerRemainingQty: qty(row.layerRemainingQty),
      layerUnitCostNow: money(amountOf(row.layerUnitCostNow)),
      onHandQty: qty(row.onHandQty),
      unitCostBefore: money(amountOf(row.unitCostBefore)),
      unitCostAfter: money(amountOf(row.unitCostAfter)),
      allocatedIqd: money(amountOf(row.allocatedIqd)),
      inventoryIqd: money(amountOf(row.inventoryIqd)),
      cogsIqd: money(amountOf(row.cogsIqd)),
    })),
  };
}

/** The locks themselves, newest first — the allocation screen's header rows. */
export async function locks(tx: Tx, filter: { payableId?: string | null } = {}) {
  const result = await tx.execute(sql`
    select k.id, k.sequence, k.lock_date::text as "lockDate", k.basis_code as "basisCode", b.name as "basisName", k.total_iqd::text as "totalIqd",
           k.inventory_iqd::text as "inventoryIqd", k.cogs_iqd::text as "cogsIqd", j.entry_no as "entryNo", j.status::text as "journalStatus",
           k.note, u.display_name as "lockedBy", k.locked_at as "lockedAt",
           p.payable_no as "payableNo", bp.legal_name as "supplierName",
           (select count(*)::int from landed_cost_layer_adjustment a where a.lock_id = k.id) as layers,
           (select count(*)::int from landed_cost_charge c where c.lock_id = k.id) as charges
      from landed_cost_lock k
      join landed_cost_basis b on b.code = k.basis_code
      join journal_entry j on j.id = k.journal_entry_id
      left join app_user u on u.id = k.locked_by
      join payable p on p.id = k.payable_id
      join business_partner bp on bp.id = p.supplier_id
     where true ${filter.payableId ? sql`and k.payable_id = ${filter.payableId}` : sql``}
     order by k.lock_date desc, k.locked_at desc`);
  return (
    result.rows as {
      id: string;
      sequence: number;
      lockDate: string;
      basisCode: string;
      basisName: string;
      totalIqd: string;
      inventoryIqd: string;
      cogsIqd: string;
      entryNo: string | null;
      journalStatus: string | null;
      note: string | null;
      lockedBy: string | null;
      lockedAt: Date;
      payableNo: string;
      supplierName: string;
      layers: number;
      charges: number;
    }[]
  ).map((row) => ({
    ...row,
    totalIqd: money(amountOf(row.totalIqd)),
    inventoryIqd: money(amountOf(row.inventoryIqd)),
    cogsIqd: money(amountOf(row.cogsIqd)),
  }));
}

// ---------------------------------------------------------------------------
// The PD page (7) and the container (14): what each shows of the other
// ---------------------------------------------------------------------------

/** The import's B/Ls and containers for the PD record — customs and clearance per container. */
export async function shippingForImport(tx: Tx, payableId: string) {
  const result = await tx.execute(sql`
    select c.id, c.container_no as "containerNo", c.size_type as "sizeType", c.status_code as "statusCode", s.name as "statusName",
           c.eta::text as eta, c.arrived_port_on::text as "arrivedPortOn", c.customs_cleared_on::text as "customsClearedOn",
           c.port_file_sent_on::text as "portFileSentOn", c.received_on::text as "receivedOn", c.warehouse_code as "warehouseCode",
           (c.cancelled_at is not null) as cancelled,
           b.id as "blId", b.bl_no as "blNo", b.bl_date::text as "blDate", b.vessel, b.eta::text as "blEta", pt.name as "portName",
           (b.cancelled_at is not null) as "blCancelled"
      from bill_of_lading b
      left join shipment_container c on c.bl_id = b.id
      left join container_status s on s.code = c.status_code
      left join port pt on pt.code = b.port_of_discharge_code
     where b.payable_id = ${payableId}
     order by b.bl_date, b.created_at, c.eta nulls last, c.container_no`);
  return result.rows as unknown as {
    id: string | null;
    containerNo: string | null;
    sizeType: string | null;
    statusCode: string | null;
    statusName: string | null;
    eta: string | null;
    arrivedPortOn: string | null;
    customsClearedOn: string | null;
    portFileSentOn: string | null;
    receivedOn: string | null;
    warehouseCode: string | null;
    cancelled: boolean | null;
    blId: string;
    blNo: string;
    blDate: string;
    vessel: string | null;
    blEta: string | null;
    portName: string | null;
    blCancelled: boolean;
  }[];
}

/** The import's customs standing for a container page: its PDs and its declarations. */
export async function customsForImport(tx: Tx, payableId: string) {
  const pds = await tx.execute(sql`
    select d.id, d.pd_no as "pdNo", d.registration_year as year, d.status_code as "statusCode", s.name as "statusName",
           d.status_date::text as "statusDate", d.expiry_date::text as "expiryDate", s.is_terminal as "isTerminal",
           s.allows_payment as "allowsPayment", s.is_expired as "isExpired",
           exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id) as superseded
      from customs_pd d join pd_status s on s.code = d.status_code
     where d.payable_id = ${payableId}
     order by d.registration_date, d.created_at`);
  const declarations = await tx.execute(sql`
    select d.id, d.declaration_no as "declarationNo", d.customs_ref as "customsRef", d.status, d.status_date::text as "statusDate",
           d.currency, d.declared_value::text as "declaredValue", pd.pd_no as "pdNo"
      from customs_declaration d left join customs_pd pd on pd.id = d.pd_id
     where d.payable_id = ${payableId}
     order by d.declaration_date desc, d.created_at desc`);
  return {
    pds: pds.rows as unknown as {
      id: string;
      pdNo: string;
      year: number | null;
      statusCode: string;
      statusName: string;
      statusDate: string;
      expiryDate: string;
      isTerminal: boolean;
      allowsPayment: boolean;
      isExpired: boolean;
      superseded: boolean;
    }[],
    declarations: declarations.rows as unknown as {
      id: string;
      declarationNo: string;
      customsRef: string | null;
      status: string;
      statusDate: string;
      currency: string;
      declaredValue: string;
      pdNo: string | null;
    }[],
  };
}

// ---------------------------------------------------------------------------
// The container receipt (23) — read by number for its print model
// ---------------------------------------------------------------------------

/** One container receipt with its lines, the container and the import it belongs to. */
export async function receiptByNo(tx: Tx, receiptNo: string) {
  const head = await tx.execute(sql`
    select r.id, r.receipt_no as "receiptNo", r.receipt_date::text as "receiptDate", r.warehouse_code as "warehouseCode", r.branch_code as "branchCode",
           r.variance_reason as "varianceReason", r.note, r.created_at as "createdAt", u.display_name as "createdByName", w.name as "warehouseName",
           c.id as "containerId", c.container_no as "containerNo", b.bl_no as "blNo",
           p.id as "payableId", p.payable_no as "payableNo", p.supplier_reference as "supplierReference", bp.legal_name as "supplierName", bp.code as "supplierCode"
      from container_receipt r
      join shipment_container c on c.id = r.container_id
      join bill_of_lading b on b.id = c.bl_id
      join payable p on p.id = r.payable_id
      join business_partner bp on bp.id = p.supplier_id
      left join warehouse w on w.code = r.warehouse_code
      left join app_user u on u.id = r.created_by
     where r.receipt_no = ${receiptNo.toUpperCase()}
     limit 1`);
  const row = head.rows[0] as
    | {
        id: string;
        receiptNo: string;
        receiptDate: string;
        warehouseCode: string;
        branchCode: string;
        varianceReason: string | null;
        note: string | null;
        createdAt: Date;
        createdByName: string | null;
        warehouseName: string | null;
        containerId: string;
        containerNo: string;
        blNo: string;
        payableId: string;
        payableNo: string;
        supplierReference: string | null;
        supplierName: string;
        supplierCode: string;
      }
    | undefined;
  if (!row) return null;
  const lines = await tx.execute(sql`
    select rl.line_no as "lineNo", rl.item_code as "itemCode", cl.description,
           rl.planned_qty::text as "plannedQty", rl.received_qty::text as "receivedQty", rl.damaged_qty::text as "damagedQty",
           rl.short_qty::text as "shortQty", rl.moved_qty::text as "movedQty", rl.cost_iqd::text as "costIqd"
      from container_receipt_line rl
      left join shipment_container_line cl on cl.id = rl.container_line_id
     where rl.receipt_id = ${row.id}
     order by rl.line_no`);
  const lineRows = lines.rows as {
    lineNo: number;
    itemCode: string | null;
    description: string | null;
    plannedQty: string;
    receivedQty: string;
    damagedQty: string;
    shortQty: string;
    movedQty: string;
    costIqd: string;
  }[];
  const sum = (key: 'plannedQty' | 'receivedQty' | 'damagedQty' | 'shortQty' | 'movedQty') =>
    formatQuantity(lineRows.reduce((total, line) => total + parseQuantity(line[key]), 0n));
  return {
    receipt: { receiptNo: row.receiptNo, receiptDate: row.receiptDate, warehouseCode: row.warehouseCode, branchCode: row.branchCode, varianceReason: row.varianceReason, note: row.note },
    container: { id: row.containerId, containerNo: row.containerNo },
    owner: { id: row.payableId, payableNo: row.payableNo, supplierReference: row.supplierReference },
    blNo: row.blNo,
    supplierName: row.supplierName,
    supplierCode: row.supplierCode,
    warehouseName: row.warehouseName,
    createdByName: row.createdByName,
    lines: lineRows,
    totals: {
      planned: sum('plannedQty'),
      received: sum('receivedQty'),
      damaged: sum('damagedQty'),
      short: sum('shortQty'),
      moved: sum('movedQty'),
      costIqd: money(lineRows.reduce((total, line) => total + amountOf(line.costIqd), 0n)),
    },
  };
}
