/**
 * Related records — platform phase, Agent 9. Reads the chain of real records around one import, supplier,
 * customer or item, as the person looking. The rules (the chains, who may see a step, when "not yet" is
 * honest) are `domain/relationships.ts`; this file only reads.
 *
 * ── What it reads ───────────────────────────────────────────────────────────
 * Rows the system already holds, joined by the foreign keys it already has — and, wherever a service already
 * answers the question, through that service: the import's B/Ls, containers, PDs, declarations and landed-cost
 * locks come from `logistics-views` (the same reads the import page and the container page make), a party's
 * statement and ageing from `open-items`, an item's movements from `stock-operations`. The few reads written
 * here are one select each over one table (the import's invoices and receipts, a supplier's orders and
 * payments, a customer's receipts and returns, the FIFO layers). Nothing is stored, nothing is guessed.
 *
 * ── Who may see what ────────────────────────────────────────────────────────
 * Three layers, none of them this file's invention:
 *   1. the root: `cloud-link-targets.findRecord` — the same "may this person open that record" answer the
 *      Document Center and Search give, grant plus the record's own access rule plus row-level security; an
 *      item by its `view` grant. A record the viewer may not open is `null`, the same answer as one that
 *      does not exist.
 *   2. each step: the grants of the screens that show its records (`domain/relationships.STEPS`). A step
 *      the viewer lacks is not read and not drawn — not empty, absent.
 *   3. each record: row-level security (every read here runs in the viewer's scoped transaction, and the
 *      stock reads add the branch rule by hand because the `stock_position` view has none) and, where the
 *      record's module registered one, `attachments.mayAccessParent` — the very check Search and Chat ask.
 *
 * A step that fails to read is drawn "could not be read just now"; it never takes the page with it
 * (`safeRead`, a savepoint each). Read-only: nothing here writes, so it can be asked on any page.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { documentHref } from '../../components/admin/document-link';
import { businessToday } from '../domain/business-date';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { can, type Principal } from '../domain/permissions';
import { profileHref } from '../domain/profiles';
import {
  FETCH_LIMIT,
  ROOT_OBJECT,
  SOURCE_DOCUMENT_OBJECT,
  countsOf,
  shape,
  stateOf,
  visibleSteps,
  type NodeFigure,
  type NodeNote,
  type RelGraph,
  type RelNode,
  type RelRoot,
  type RelStep,
  type RootKind,
  type StepDefinition,
} from '../domain/relationships';
import * as attachments from './attachments';
import * as cloudLinks from './cloud-link-targets';
import * as logisticsViews from './logistics-views';
import * as openItems from './open-items';
import { safeRead } from './safe-read';
import * as stockOperations from './stock-operations';

export interface RelationshipContext {
  readonly principal: Principal;
  /** The branch the request works in — the stock movement reads are scoped to it, like the Stock Movement page. */
  readonly branchCode: string;
}

/** The root of a chain, with what the readers need of it. */
interface Root extends RelRoot {
  readonly id: string;
  /** For a supplier or customer: the partner's code (its statement and ageing are addressed by it). */
  readonly partnerCode: string | null;
}

/** A record found, with the id its module's access rule is asked about. */
interface Candidate extends RelNode {
  readonly check?: { readonly type: string; readonly id: string } | undefined;
}

interface Read {
  readonly rows: readonly Candidate[];
  /** The read stopped at the limit. */
  readonly truncated: boolean;
}

interface ReadContext extends RelationshipContext {
  readonly root: Root;
  readonly today: string;
  /** Reads shared by two steps of a chain (the B/Ls and the containers are one query). */
  readonly memo: <T>(key: string, load: () => Promise<T>) => Promise<T>;
}

type Reader = (tx: Tx, context: ReadContext) => Promise<Read>;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const rowsOf = <T>(result: { rows: unknown[] }): T[] => result.rows as T[];

/** `limit + 1` rows asked for, so "there is more" is known; the extra one is dropped. */
function cut<T>(rows: readonly T[]): { readonly rows: readonly T[]; readonly truncated: boolean } {
  return { rows: rows.slice(0, FETCH_LIMIT), truncated: rows.length > FETCH_LIMIT };
}

const node = (input: Partial<Candidate> & Pick<Candidate, 'kind' | 'key'>): Candidate => ({
  label: null,
  href: null,
  from: null,
  date: null,
  status: null,
  statusName: null,
  figure: null,
  note: null,
  ...input,
});

const money = (value: string | null | undefined): NodeFigure | null => (value == null ? null : { kind: 'amountIqd', value });
const quantity = (value: string | null | undefined): NodeFigure | null => (value == null ? null : { kind: 'quantity', value });
const note = (key: string, params: Record<string, string | number | null | undefined>): NodeNote => ({
  key,
  params: Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined)) as Record<string, string | number>,
});

/** A link only where the viewer holds the grant of the screen it opens (the step's own grants are already held). */
const link = (principal: Principal, object: string, href: string | null): string | null =>
  href !== null && can(principal, 'view', object) ? href : null;

/** The branch rule for the `stock_position` view, which has no row-level security of its own. */
const branchRule = (principal: Principal, column: string) =>
  principal.isSuperUser ? sql`` : sql` and app_branch_allowed(${sql.raw(column)})`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// The roots
// ---------------------------------------------------------------------------

async function rootOf(tx: Tx, context: RelationshipContext, kind: RootKind, key: string): Promise<Root | null> {
  const { principal } = context;
  const wanted = key.trim();
  if (wanted === '' || !can(principal, 'view', ROOT_OBJECT[kind])) return null;

  if (kind === 'item') {
    const result = await tx.execute(sql`select code, name from item where code = ${wanted} limit 1`);
    const row = rowsOf<{ code: string; name: string | null }>(result)[0];
    if (!row) return null;
    return {
      kind,
      key: row.code,
      label: row.code,
      name: row.name,
      href: profileHref('item', row.code) ?? '/inventory/items',
      open: false,
      id: row.code,
      partnerCode: null,
    };
  }

  if (kind === 'import') {
    const ref = await cloudLinks.findRecord(tx, principal, 'payable', wanted);
    if (!ref) return null;
    const result = await tx.execute(sql`
      select p.payable_type_code as "typeCode", (p.cancelled_at is not null) as cancelled, (p.closed_at is not null) as closed,
             s.legal_name as "supplierName"
        from payable p left join business_partner s on s.id = p.supplier_id
       where p.id = ${ref.id}::uuid`);
    const row = rowsOf<{ typeCode: string; cancelled: boolean; closed: boolean; supplierName: string | null }>(result)[0];
    if (!row) return null;
    return {
      kind,
      key: ref.label,
      label: ref.label,
      name: row.supplierName,
      href: ref.href,
      // Only an import has the shipping and costing lane to be "not yet" at; a cancelled or closed one will not go on.
      open: row.typeCode === 'import' && !row.cancelled && !row.closed,
      id: ref.id,
      partnerCode: null,
    };
  }

  // A supplier or a customer: one master, found by the side it is asked as.
  const ref = await cloudLinks.findRecord(tx, principal, kind, wanted);
  if (!ref) return null;
  const result = await tx.execute(sql`select id::text as id, legal_name as name from business_partner where code = ${ref.label} limit 1`);
  const row = rowsOf<{ id: string; name: string | null }>(result)[0];
  if (!row) return null;
  return { kind, key: ref.label, label: ref.label, name: row.name, href: ref.href, open: true, id: row.id, partnerCode: ref.label };
}

// ---------------------------------------------------------------------------
// The readers — one per step
// ---------------------------------------------------------------------------

const importInvoices: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select i.id::text as id, i.invoice_no as "invoiceNo", i.invoice_date::text as date, i.status::text as status, i.total_iqd::text as total
      from ap_invoice i where i.payable_id = ${root.id}::uuid
     order by i.invoice_date, i.invoice_no limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; invoiceNo: string; date: string; status: string; total: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'ap_invoice',
        key: row.id,
        label: row.invoiceNo,
        href: link(principal, 'ap_invoice', documentHref('ap_invoice', row.invoiceNo)),
        from: root.label,
        date: row.date,
        status: row.status,
        figure: money(row.total),
        check: { type: 'ap_invoice', id: row.id },
      }),
    ),
  };
};

/** The B/Ls and containers of the import, read once: `logistics-views.shippingForImport`, the import page's own read. */
const shipping = (tx: Tx, context: ReadContext) =>
  context.memo('shipping', () => logisticsViews.shippingForImport(tx, context.root.id));

const importBls: Reader = async (tx, context) => {
  const lines = await shipping(tx, context);
  const seen = new Set<string>();
  const bls = lines.filter((line) => !line.blCancelled && !seen.has(line.blId) && seen.add(line.blId));
  const { rows, truncated } = cut(bls);
  return {
    truncated,
    rows: rows.map((bl) =>
      node({
        kind: 'bill_of_lading',
        key: bl.blId,
        label: bl.blNo,
        href: profileHref('bl', bl.blNo),
        from: context.root.label,
        date: bl.blDate,
        note: bl.vessel && bl.blEta ? note('bl', { vessel: bl.vessel, etaDate: bl.blEta }) : bl.vessel ? note('bl_vessel', { vessel: bl.vessel }) : bl.blEta ? note('bl_eta', { etaDate: bl.blEta }) : null,
        check: { type: 'bill_of_lading', id: bl.blId },
      }),
    ),
  };
};

const importContainers: Reader = async (tx, context) => {
  const lines = await shipping(tx, context);
  const containers = lines.filter((line) => line.id !== null && !line.cancelled && !line.blCancelled);
  const { rows, truncated } = cut(containers);
  return {
    truncated,
    rows: rows.map((line) =>
      node({
        kind: 'shipment_container',
        key: line.id!,
        label: line.containerNo,
        href: profileHref('container', line.containerNo, { id: line.id }),
        from: line.blNo,
        date: line.receivedOn ?? line.customsClearedOn ?? line.arrivedPortOn ?? line.eta,
        statusName: line.statusName,
        check: { type: 'shipment_container', id: line.id! },
      }),
    ),
  };
};

/** The import's PDs and declarations, read once: `logistics-views.customsForImport`, the container page's own read. */
const customs = (tx: Tx, context: ReadContext) =>
  context.memo('customs', () => logisticsViews.customsForImport(tx, context.root.id));

const importPds: Reader = async (tx, context) => {
  const { pds } = await customs(tx, context);
  // A PD another PD replaced is history; the chain draws the standing ones, as the Home journey counts them.
  const standing = pds.filter((pd) => !pd.superseded);
  const { rows, truncated } = cut(standing);
  return {
    truncated,
    rows: rows.map((pd) =>
      node({
        kind: 'customs_pd',
        key: pd.id,
        label: pd.pdNo,
        href: profileHref('pd', pd.pdNo, { year: pd.year }),
        from: context.root.label,
        date: pd.statusDate,
        statusName: pd.statusName,
        note: note('pd', { expiryDate: pd.expiryDate }),
        check: { type: 'customs_pd', id: pd.id },
      }),
    ),
  };
};

const importDeclarations: Reader = async (tx, context) => {
  const { declarations } = await customs(tx, context);
  const { rows, truncated } = cut(declarations);
  return {
    truncated,
    rows: rows.map((declaration) =>
      node({
        kind: 'customs_declaration',
        key: declaration.id,
        label: declaration.declarationNo,
        href: `/logistics/customs-declarations/${encodeURIComponent(declaration.declarationNo)}`,
        from: declaration.pdNo ?? context.root.label,
        date: declaration.statusDate,
        status: declaration.status,
        note: declaration.customsRef ? note('declaration', { reference: declaration.customsRef }) : null,
        check: { type: 'customs_declaration', id: declaration.id },
      }),
    ),
  };
};

/** The landed-cost locks, through `logistics-views.locks` — the allocation screen's own rows. */
const importLocks: Reader = async (tx, { root }) => {
  const locks = await logisticsViews.locks(tx, { payableId: root.id });
  const { rows, truncated } = cut(locks);
  return {
    truncated,
    rows: rows.map((lock) =>
      node({
        kind: 'landed_cost_lock',
        key: lock.id,
        href: `/payables/${encodeURIComponent(root.label)}#landed-cost`,
        from: root.label,
        date: lock.lockDate,
        figure: money(lock.totalIqd),
        note: note('lock', { sequence: lock.sequence, basis: lock.basisName }),
      }),
    ),
  };
};

const importReceipts: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select r.id::text as id, r.receipt_no as "receiptNo", r.receipt_date::text as date, c.id::text as "containerId",
           c.container_no as "containerNo", r.warehouse_code as "warehouseCode"
      from container_receipt r join shipment_container c on c.id = r.container_id
     where r.payable_id = ${root.id}::uuid
     order by r.receipt_date, r.receipt_no limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; receiptNo: string; date: string; containerId: string; containerNo: string; warehouseCode: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'container_receipt',
        key: row.id,
        label: row.receiptNo,
        href: link(principal, 'shipment_container', profileHref('container', row.containerNo, { id: row.containerId })),
        from: row.containerNo,
        date: row.date,
        note: note('receipt', { warehouse: row.warehouseCode }),
        check: { type: 'shipment_container', id: row.containerId },
      }),
    ),
  };
};

/** Where the goods the import's receipts brought now stand: the receipts' item and warehouse pairs against `stock_position`. */
const importPositions: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    with received as (
      select distinct m.item_code, m.warehouse_code
        from inventory_movement m join container_receipt r on r.id::text = m.source_document_id
       where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt' and r.payable_id = ${root.id}::uuid
    )
    select p.item_code as "itemCode", i.name as "itemName", p.warehouse_code as "warehouseCode", p.held::text as held
      from received
      join stock_position p on p.item_code = received.item_code and p.warehouse_code = received.warehouse_code
      join item i on i.code = p.item_code
     where true${branchRule(principal, 'p.branch_code')}
     order by p.item_code, p.warehouse_code limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ itemCode: string; itemName: string | null; warehouseCode: string; held: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'stock_position',
        key: `${row.itemCode}|${row.warehouseCode}`,
        label: row.itemCode,
        href: link(principal, 'item', profileHref('item', row.itemCode)),
        from: row.warehouseCode,
        figure: quantity(row.held),
        note: row.itemName ? note('item_name', { name: row.itemName }) : null,
      }),
    ),
  };
};

/** The FIFO layers the import's container receipts created — the rows `landed-cost` locks and `final-cost` follows. */
const importLayers: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select cl.id::text as id, cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode", cl.layer_date::text as "layerDate",
           cl.original_quantity::text as original, cl.remaining_quantity::text as remaining, cl.unit_cost_iqd::text as "unitCost",
           r.receipt_no as "receiptNo"
      from cost_layer cl
      join inventory_movement m on m.id = cl.created_by_movement_id
      join container_receipt r on r.id::text = m.source_document_id
     where m.source_document_type = 'container_receipt' and m.kind = 'transfer_receipt' and r.payable_id = ${root.id}::uuid
       ${branchRule(principal, 'cl.branch_code')}
     order by cl.item_code, cl.layer_date, cl.sequence limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(
    rowsOf<{ id: string; itemCode: string; warehouseCode: string; layerDate: string; original: string; remaining: string; unitCost: string; receiptNo: string }>(result),
  );
  const ledger = can(principal, 'view', 'stock_movement');
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'cost_layer',
        key: row.id,
        href: ledger ? `/inventory/stock-ledger?item=${encodeURIComponent(row.itemCode)}&warehouse=${encodeURIComponent(row.warehouseCode)}` : null,
        from: row.receiptNo,
        date: row.layerDate,
        figure: quantity(row.remaining),
        note: note('layer_item', { item: row.itemCode, warehouse: row.warehouseCode, originalQty: row.original, unitCostIqd: row.unitCost }),
      }),
    ),
  };
};

// -- A supplier ---------------------------------------------------------------

const supplierOrders: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select o.id::text as id, o.order_no as "orderNo", o.order_date::text as date, o.status::text as status
      from purchase_order o where o.supplier_id = ${root.id}::uuid
     order by o.order_date desc, o.order_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; orderNo: string; date: string; status: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'purchase_order',
        key: row.id,
        label: row.orderNo,
        href: link(principal, 'purchase_order', profileHref('purchase_order', row.orderNo)),
        from: root.label,
        date: row.date,
        status: row.status,
        check: { type: 'purchase_order', id: row.id },
      }),
    ),
  };
};

const supplierReceipts: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select g.id::text as id, g.receipt_no as "receiptNo", g.receipt_date::text as date, g.status::text as status, o.order_no as "orderNo"
      from goods_receipt g join purchase_order o on o.id = g.purchase_order_id
     where o.supplier_id = ${root.id}::uuid
     order by g.receipt_date desc, g.receipt_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; receiptNo: string; date: string; status: string; orderNo: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'goods_receipt',
        key: row.id,
        label: row.receiptNo,
        href: link(principal, 'goods_receipt', profileHref('goods_receipt', row.receiptNo)),
        from: row.orderNo,
        date: row.date,
        status: row.status,
        check: { type: 'goods_receipt', id: row.id },
      }),
    ),
  };
};

const supplierInvoices: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select i.id::text as id, i.invoice_no as "invoiceNo", i.invoice_date::text as date, i.status::text as status,
           i.total_iqd::text as total, o.order_no as "orderNo"
      from ap_invoice i left join purchase_order o on o.id = i.purchase_order_id
     where i.supplier_id = ${root.id}::uuid
     order by i.invoice_date desc, i.invoice_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; invoiceNo: string; date: string; status: string; total: string; orderNo: string | null }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'ap_invoice',
        key: row.id,
        label: row.invoiceNo,
        href: link(principal, 'ap_invoice', documentHref('ap_invoice', row.invoiceNo)),
        from: row.orderNo ?? root.label,
        date: row.date,
        status: row.status,
        figure: money(row.total),
        check: { type: 'ap_invoice', id: row.id },
      }),
    ),
  };
};

const supplierPayments: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select p.id::text as id, p.payment_no as "paymentNo", p.payment_date::text as date, p.status::text as status, p.amount_iqd::text as amount,
           (select string_agg(distinct i.invoice_no, ', ')
              from supplier_payment_allocation a join ap_invoice i on i.id = a.ap_invoice_id
             where a.supplier_payment_id = p.id and a.reversed_at is null) as "invoices"
      from supplier_payment p where p.supplier_id = ${root.id}::uuid
     order by p.payment_date desc, p.payment_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; paymentNo: string; date: string; status: string; amount: string; invoices: string | null }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'supplier_payment',
        key: row.id,
        label: row.paymentNo,
        href: link(principal, 'supplier_payment', profileHref('supplier_payment', row.paymentNo)),
        from: row.invoices ?? root.label,
        date: row.date,
        status: row.status,
        figure: money(row.amount),
        check: { type: 'supplier_payment', id: row.id },
      }),
    ),
  };
};

// -- A customer ---------------------------------------------------------------

const customerInvoices: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select i.id::text as id, i.invoice_no as "invoiceNo", i.invoice_date::text as date, i.status::text as status, i.net_iqd::text as total
      from ar_invoice i where i.customer_id = ${root.id}::uuid
     order by i.invoice_date desc, i.invoice_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; invoiceNo: string; date: string; status: string; total: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'ar_invoice',
        key: row.id,
        label: row.invoiceNo,
        href: link(principal, 'ar_invoice', documentHref('ar_invoice', row.invoiceNo)),
        from: root.label,
        date: row.date,
        status: row.status,
        figure: money(row.total),
        check: { type: 'ar_invoice', id: row.id },
      }),
    ),
  };
};

const customerReceipts: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select r.id::text as id, r.receipt_no as "receiptNo", r.receipt_date::text as date, r.status::text as status, r.amount_iqd::text as amount,
           (select string_agg(distinct i.invoice_no, ', ')
              from customer_receipt_allocation a join ar_invoice i on i.id = a.ar_invoice_id
             where a.customer_receipt_id = r.id) as "invoices"
      from customer_receipt r where r.customer_id = ${root.id}::uuid
     order by r.receipt_date desc, r.receipt_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; receiptNo: string; date: string; status: string; amount: string; invoices: string | null }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'customer_receipt',
        key: row.id,
        label: row.receiptNo,
        href: link(principal, 'customer_receipt', profileHref('customer_receipt', row.receiptNo)),
        from: row.invoices ?? root.label,
        date: row.date,
        status: row.status,
        figure: money(row.amount),
        check: { type: 'customer_receipt', id: row.id },
      }),
    ),
  };
};

const customerCredits: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select m.id::text as id, m.memo_no as "memoNo", m.memo_date::text as date, m.status::text as status, m.amount_iqd::text as amount,
           coalesce(r.return_no, i.invoice_no) as "source"
      from customer_credit_memo m
      left join sales_return r on r.id = m.sales_return_id
      left join ar_invoice i on i.id = m.ar_invoice_id
     where m.customer_id = ${root.id}::uuid
     order by m.memo_date desc, m.memo_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; memoNo: string; date: string; status: string; amount: string; source: string | null }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'customer_credit_memo',
        key: row.id,
        label: row.memoNo,
        href: link(principal, 'customer_credit_memo', `/sales/credit-notes/${encodeURIComponent(row.memoNo)}`),
        from: row.source ?? root.label,
        date: row.date,
        status: row.status,
        figure: money(row.amount),
        check: { type: 'customer_credit_memo', id: row.id },
      }),
    ),
  };
};

const customerReturns: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select r.id::text as id, r.return_no as "returnNo", r.requested_on::text as date, r.status::text as status, i.invoice_no as "invoiceNo"
      from sales_return r left join ar_invoice i on i.id = r.ar_invoice_id
     where r.customer_id = ${root.id}::uuid
     order by r.requested_on desc, r.return_no desc limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; returnNo: string; date: string; status: string; invoiceNo: string | null }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'sales_return',
        key: row.id,
        label: row.returnNo,
        href: link(principal, 'sales_return', profileHref('sales_return', row.returnNo)),
        from: row.invoiceNo ?? root.label,
        date: row.date,
        status: row.status,
        check: { type: 'sales_return', id: row.id },
      }),
    ),
  };
};

// -- Both sides: the statement and the ageing, through `open-items` ---------------

const partySide = (root: Root): openItems.Side => (root.kind === 'supplier' ? 'supplier' : 'customer');

const statementRoute = (root: Root): string =>
  `${root.kind === 'supplier' ? '/payables/supplier-statements' : '/sales/customer-statements'}?code=${encodeURIComponent(root.label)}`;

const ageingRoute = (root: Root): string =>
  `${root.kind === 'supplier' ? '/payables/open-items' : '/sales/receivables'}?code=${encodeURIComponent(root.label)}`;

/** The party's position in the sub-ledger, as `open-items.ledgerBalances` reads it for the statement. Present only if the account has entries. */
const partyStatement: Reader = async (tx, { root, principal, today }) => {
  const balances = await openItems.ledgerBalances(tx, principal, partySide(root), today, { partyCode: root.partnerCode });
  const row = balances[0];
  if (!row) return { rows: [], truncated: false };
  return {
    truncated: false,
    rows: [
      node({
        kind: 'statement',
        key: `${root.kind}|statement`,
        href: statementRoute(root),
        from: root.label,
        date: row.oldestDate,
        figure: money(row.balanceIqd),
        note: row.oldestDate ? note('statement', { oldestDate: row.oldestDate }) : null,
      }),
    ],
  };
};

/** The open invoices and how late they are, as the ageing screen reads them. Present only if something is still owed. */
const partyAgeing: Reader = async (tx, { root, principal, today }) => {
  const items = await openItems.openItems(tx, principal, partySide(root), today, { partyCode: root.partnerCode, outstandingOnly: true });
  if (items.length === 0) return { rows: [], truncated: false };
  const owed = toDecimalString(
    items.reduce((total, item) => total + parseDecimal(item.outstandingIqd, MONEY_SCALE), 0n),
    MONEY_SCALE,
  );
  const overdue = items.filter((item) => item.daysOverdue > 0);
  const oldest = items.reduce<string | null>((first, item) => (first === null || item.dueDate < first ? item.dueDate : first), null);
  return {
    truncated: false,
    rows: [
      node({
        kind: 'ageing',
        key: `${root.kind}|ageing`,
        href: ageingRoute(root),
        from: root.label,
        date: oldest,
        figure: money(owed),
        note: note('ageing', { open: items.length, overdue: overdue.length }),
      }),
    ],
  };
};

// -- An item --------------------------------------------------------------------

const itemWarehouses: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select p.warehouse_code as "warehouseCode", w.name as "warehouseName", p.held::text as held, p.reserved::text as reserved
      from stock_position p left join warehouse w on w.code = p.warehouse_code
     where p.item_code = ${root.id} and (p.held <> 0 or p.reserved <> 0)${branchRule(principal, 'p.branch_code')}
     order by p.warehouse_code limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ warehouseCode: string; warehouseName: string | null; held: string; reserved: string }>(result));
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'stock_position',
        key: row.warehouseCode,
        label: row.warehouseCode,
        href: link(principal, 'warehouse', profileHref('warehouse', row.warehouseCode)),
        from: root.label,
        figure: quantity(row.held),
        note: row.warehouseName ? note('warehouse_name', { name: row.warehouseName }) : null,
      }),
    ),
  };
};

const itemLayers: Reader = async (tx, { root, principal }) => {
  const result = await tx.execute(sql`
    select cl.id::text as id, cl.warehouse_code as "warehouseCode", cl.layer_date::text as "layerDate", cl.original_quantity::text as original,
           cl.remaining_quantity::text as remaining, cl.unit_cost_iqd::text as "unitCost"
      from cost_layer cl
     where cl.item_code = ${root.id} and cl.remaining_quantity > 0${branchRule(principal, 'cl.branch_code')}
     order by cl.warehouse_code, cl.layer_date, cl.sequence limit ${FETCH_LIMIT + 1}`);
  const { rows, truncated } = cut(rowsOf<{ id: string; warehouseCode: string; layerDate: string; original: string; remaining: string; unitCost: string }>(result));
  const ledger = can(principal, 'view', 'stock_movement');
  return {
    truncated,
    rows: rows.map((row) =>
      node({
        kind: 'cost_layer',
        key: row.id,
        href: ledger ? `/inventory/stock-ledger?item=${encodeURIComponent(root.id)}&warehouse=${encodeURIComponent(row.warehouseCode)}` : null,
        from: row.warehouseCode,
        date: row.layerDate,
        figure: quantity(row.remaining),
        note: note('layer', { originalQty: row.original, unitCostIqd: row.unitCost }),
      }),
    ),
  };
};

/** The latest movements of the item, through `stock-operations.movements` — the Stock Movement page's own read. */
const itemMovements = (tx: Tx, context: ReadContext) =>
  context.memo('movements', () =>
    stockOperations.movements(tx, { principal: context.principal, branchCode: context.branchCode }, { itemCode: context.root.id, limit: FETCH_LIMIT + 1 }),
  );

const itemMovementNodes: Reader = async (tx, context) => {
  const movements = await itemMovements(tx, context);
  const { rows, truncated } = cut(movements);
  return {
    truncated,
    rows: rows.map((movement) =>
      node({
        kind: 'inventory_movement',
        key: movement.id,
        label: movement.documentNo,
        href: link(context.principal, 'stock_movement', `/inventory/stock-movements?item=${encodeURIComponent(context.root.id)}&warehouse=${encodeURIComponent(movement.warehouseCode)}`),
        from: movement.warehouseCode,
        date: movement.movementDate,
        figure: quantity(movement.signedQuantity),
        note: note('movement', { movementType: movement.type }),
      }),
    ),
  };
};

/**
 * The documents behind those movements: one node per distinct document the Stock Movement page can name (its
 * number resolved under the viewer's row-level security — a document they cannot read has no number here and is
 * left out), openable only where they hold the document's own grant.
 */
const itemDocuments: Reader = async (tx, context) => {
  const movements = await itemMovements(tx, context);
  const seen = new Set<string>();
  const documents = movements.filter((movement) => {
    if (!movement.documentType || !movement.documentNo) return false;
    const key = `${movement.documentType}|${movement.documentNo}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const object = SOURCE_DOCUMENT_OBJECT[movement.documentType];
    return object !== undefined && can(context.principal, 'view', object);
  });
  const { rows, truncated } = cut(documents);
  return {
    truncated,
    rows: rows.map((movement) =>
      node({
        kind: movement.documentType!,
        key: `${movement.documentType}|${movement.documentNo}`,
        label: movement.documentNo,
        href: documentHref(movement.documentType, movement.documentNo),
        from: movement.warehouseCode,
        date: movement.movementDate,
        note: note('document', { movementType: movement.type }),
      }),
    ),
  };
};

const READERS: Readonly<Record<string, Reader>> = {
  'import.invoice': importInvoices,
  'import.bl': importBls,
  'import.container': importContainers,
  'import.customs': importPds,
  'import.declaration': importDeclarations,
  'import.landed_cost': importLocks,
  'import.receipt': importReceipts,
  'import.inventory': importPositions,
  'import.layer': importLayers,
  'supplier.purchase_order': supplierOrders,
  'supplier.goods_receipt': supplierReceipts,
  'supplier.invoice': supplierInvoices,
  'supplier.payment': supplierPayments,
  'supplier.statement': partyStatement,
  'supplier.ageing': partyAgeing,
  'customer.invoice': customerInvoices,
  'customer.receipt': customerReceipts,
  'customer.credit': customerCredits,
  'customer.return': customerReturns,
  'customer.statement': partyStatement,
  'customer.ageing': partyAgeing,
  'item.warehouse': itemWarehouses,
  'item.layer': itemLayers,
  'item.movement': itemMovementNodes,
  'item.document': itemDocuments,
};

/** Every step code a reader exists for — held equal to `domain/relationships.STEPS` by the unit test. */
export const READER_CODES: readonly string[] = Object.keys(READERS);

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

/** Keeps the candidates whose module lets this person open them; strips the access handle. */
async function admit(tx: Tx, principal: Principal, rows: readonly Candidate[]): Promise<RelNode[]> {
  const allowed: RelNode[] = [];
  for (const row of rows) {
    const { check, ...shown } = row;
    if (check && UUID.test(check.id)) {
      // `null` means the module registered no rule, and the step's grants (already held) are the answer.
      const verdict = await attachments.mayAccessParent(tx, principal, check.type, check.id);
      if (verdict === false) continue;
    }
    allowed.push(shown);
  }
  return allowed;
}

/**
 * The chain around one record, as the person in `context.principal` may see it — or null when they may not
 * open the record itself (the same answer as a record that does not exist). Never throws for a step: one that
 * cannot be read is returned `unavailable`.
 *
 * Call it inside the viewer's scoped transaction (`withCurrentUser`); it writes nothing.
 */
export async function graphFor(tx: Tx, context: RelationshipContext, kind: RootKind, key: string): Promise<RelGraph | null> {
  // The record registrations (cloud-link targets, attachment access rules) are lazy; a cold process needs them.
  const { registerAllRecords } = await import('../records');
  registerAllRecords();

  const root = await rootOf(tx, context, kind, key);
  if (!root) return null;

  const memoStore = new Map<string, unknown>();
  const read: ReadContext = {
    ...context,
    root,
    today: businessToday(),
    memo: async <T>(memoKey: string, load: () => Promise<T>): Promise<T> => {
      if (memoStore.has(memoKey)) return memoStore.get(memoKey) as T;
      const value = await load();
      memoStore.set(memoKey, value);
      return value;
    },
  };

  const definitions: readonly StepDefinition[] = visibleSteps(kind, context.principal);
  const found = new Map<string, { readonly allowed: readonly RelNode[]; readonly truncated: boolean }>();
  const failed = new Set<string>();
  // One after the other: a transaction is one connection and answers one question at a time.
  for (const definition of definitions) {
    const reader = READERS[definition.code];
    if (!reader) {
      failed.add(definition.code);
      continue;
    }
    const outcome = await safeRead(tx, `relationships.${definition.code}`, async (savepoint) => {
      const result = await reader(savepoint, read);
      return { allowed: await admit(savepoint, context.principal, result.rows), truncated: result.truncated };
    });
    if (outcome.ok) found.set(definition.code, outcome.value);
    else failed.add(definition.code);
  }

  const counts = countsOf(new Map([...found].map(([code, one]) => [code, one.allowed.length])));
  const steps: RelStep[] = [];
  for (const definition of definitions) {
    if (failed.has(definition.code)) {
      steps.push({ code: definition.code, state: 'unavailable', nodes: [], more: 0, truncated: false });
      continue;
    }
    const one = found.get(definition.code)!;
    const state = stateOf(definition, one.allowed.length, counts, root.open);
    if (!state) continue;
    const shaped = shape(one.allowed, one.truncated);
    steps.push({ code: definition.code, state, nodes: shaped.nodes, more: shaped.more, truncated: shaped.truncated });
  }

  const visible: RelRoot = { kind: root.kind, key: root.key, label: root.label, name: root.name, href: root.href, open: root.open };
  return { root: visible, steps };
}
