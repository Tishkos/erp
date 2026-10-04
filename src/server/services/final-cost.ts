/**
 * What an import's goods finally cost, and where every dinar of its landed
 * cost went — IMPROVEMENT-002, replacing `landed-cost.finalCost` after the
 * audit of 2026-10-04:
 *
 *   A1  A layer already sold out when a lock came keeps its unit cost (there is
 *       nothing left to restate), so "unit cost after − before" read 0 for
 *       charges that were in fact allocated to it. Charges are now the sum of
 *       what every lock *allocated* (`landed_cost_layer_adjustment.allocated_iqd`),
 *       never a difference of unit costs.
 *   A2  On hand was the received layers' remaining only; stock a transfer or a
 *       return carried to another layer was missing. It is now the remaining of
 *       the whole lineage (below).
 *   A3  The final value was the original quantity at today's unit cost, under a
 *       comment saying it was what the Warehouses Report sums. It is now what
 *       that report sums: remaining × unit cost, over the lineage.
 *   A11 Per-unit figures were floored; they are half up.
 *
 * ── Lineage ────────────────────────────────────────────────────────────────
 * The *received* layers are the FIFO layers the import's container receipts
 * created (`landed-cost.receivedLayers`, copied here because that file is not
 * this one's to change). Each one's lineage is itself plus every layer its
 * stock reached, followed by fact, never by matching quantities:
 *
 *   * `cost_layer.origin_layer_id` (0280) — a layer a relocation created names
 *     the layer it came from;
 *   * `landed_cost_layer_adjustment.via_layer_id` — a lock that followed a
 *     transfer to the destination layer said so;
 *   * `landed_cost_departure.to_layer_id` — a return names the layer the units
 *     came back into (a sales return's new layer).
 *
 * A layer belongs to one received layer (its root); the first parent found is
 * kept, and a loop cannot form.
 *
 * ── The figures, per received layer R with lineage L(R) ──────────────────────
 *   received      Q = R.original_quantity
 *   purchase unit P = the unit cost R carried before any lock touched it: the
 *                 `unit_cost_before` of its earliest adjustment row by lock
 *                 sequence, or its unit cost when no lock touched it (layer
 *                 costs move only through a lock's adjustment row)
 *   purchase      valueOf(Q, P), half up
 *   charges       Σ allocated_iqd of every lock's rows on any layer of L(R) —
 *                 what the lock gave R itself plus what followed its stock
 *   stock         Σ remaining × unit cost over L(R), exact, rounded once (the
 *                 Warehouses Report's own sum) — this is `finalValueIqd`
 *   on hand       Σ remaining over L(R)
 *   departed      Σ `landed_cost_departure.amount_iqd` on layers of L(R):
 *                 departures and rounding, less returns (signed rows, so a
 *                 plain sum). A lock written before 0280 has no departure rows;
 *                 for such a lock the `cogs_iqd` of its adjustment rows is the
 *                 departed part (it all went to cost of sales then).
 *   consumed      Σ `cost_layer_consumption.cost_iqd` on layers of L(R) (what
 *                 the movements themselves took out at the unit cost the layer
 *                 carried when they went — before a later lock reached them;
 *                 reversals negative), less the value every non-received layer
 *                 of L(R) was created with (valueOf(original, its own purchase
 *                 unit as above)), because stock moving *within* the lineage is
 *                 neither consumed nor new.
 *
 * The identity, per model (Σ over its received layers):
 *
 *     purchase + charges = stock + departed + consumed + unexplained
 *
 * Every lock's total is its inventory part plus its departed part (0280 holds
 * it at commit). The inventory part raises stock by exactly that amount
 * (`domain/landed-cost.restate` chooses the unit cost so that it does); stock
 * leaves at the cost the movement booked; a transfer creates the destination at
 * the cost the source carried. So `unexplained` is zero up to the half-up
 * rounding of valuing each movement on its own — and anything larger means
 * stock left the lineage by a path it does not follow (before 0280's
 * `origin_layer_id` is written by every relocation: a transfer after the last
 * lock; a return whose layer is raised without an adjustment row).
 *
 * Final unit cost = (purchase + charges) ÷ Q, half up. Invoiced unit and
 * charges unit are each their own value ÷ Q, half up, so the two may differ
 * from the final unit by 0.0001 — the final figure is never their sum.
 *
 * Reads only. No project service is imported: a project material issue's
 * number is read through the movement it wrote, and nothing about the project
 * (its code, its WBS) is ever read or shown — the import sees inventory
 * transactions, not projects.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { LandedCostError, valueOf } from '../domain/landed-cost';
import { MONEY_SCALE, RATE_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import {
  exactValue,
  extendLineage,
  formatUnitChain,
  groupDepartures,
  landedUnitChain,
  reconcileLock,
  roundExactValue,
  splitLargestRemainder,
  unitOf,
  unexplainedOf,
  type DepartureGroup,
  type DepartureLine,
  type LineageEdge,
  type LineageEntry,
  type LineageLink,
} from '../domain/final-cost';

const MAX_DEPTH = 32;
const MAX_ORIGIN_HOPS = 12;

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);
const quantityOf = (value: string | null | undefined) => parseQuantity(value ?? '0');
const idList = (ids: readonly string[]): SQL => sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
const rowsOf = <T>(result: { rows: unknown[] }) => result.rows as T[];

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One model of the import — the fields `landed-cost.finalCost` returned (same
 * names, corrected meanings) and the four that explain them. Money as decimal
 * strings at four places, quantities as `formatQuantity` strings.
 */
export interface FinalCostRow {
  readonly itemCode: string;
  /** Σ original quantity of the model's received layers. */
  readonly receivedQty: string;
  /** Σ remaining over the received layers' lineage — wherever the stock now stands. */
  readonly onHandQty: string;
  /** purchaseValueIqd ÷ receivedQty, half up: what the invoice priced a unit at. */
  readonly invoicedUnitIqd: string;
  /** chargesIqd ÷ receivedQty, half up: what freight, duty and clearance added to a unit. */
  readonly chargesUnitIqd: string;
  /** (purchaseValueIqd + chargesIqd) ÷ receivedQty, half up: what one received unit finally cost. */
  readonly finalUnitIqd: string;
  /** Σ allocated by every lock to the lineage — sold-out layers included (A1). */
  readonly chargesIqd: string;
  /** Σ remaining × current unit cost over the lineage — what the Warehouses Report sums (A3). Same as stockValueIqd. */
  readonly finalValueIqd: string;
  /** Σ received quantity × purchase unit cost, each layer half up. */
  readonly purchaseValueIqd: string;
  /** The identity's name for finalValueIqd. */
  readonly stockValueIqd: string;
  /** What the locks sent after stock that had already left, less what came back (landed_cost_departure, net). */
  readonly departedIqd: string;
  /** What the movements took out of the lineage at the cost they booked, net of what came into it from outside. */
  readonly consumedIqd: string;
  /** purchase + charges − stock − departed − consumed: rounding, or a path the lineage does not follow. */
  readonly unexplainedIqd: string;
}

export interface ChargeSource {
  readonly sourceType: string;
  readonly sourceNo: string | null;
  readonly amountIqd: string;
}

export interface LockChargeType {
  readonly chargeTypeCode: string;
  readonly chargeTypeName: string | null;
  /** What the lock allocated of this type, all layers together. */
  readonly amountIqd: string;
  /** The documents that carried it (`landed_cost_charge.source_type` / `source_no`). */
  readonly sources: ChargeSource[];
}

export interface LockReconciliation {
  readonly totalIqd: string;
  /** Σ the charges the lock consumed — equal to the total when the lock is whole. */
  readonly chargesIqd: string;
  readonly chargesMatch: boolean;
  /** Σ inventory parts of its adjustment rows. */
  readonly inventoryIqd: string;
  /** Σ its departure rows. */
  readonly departureIqd: string;
  /** Σ its rounding rows. */
  readonly roundingIqd: string;
  readonly accountedIqd: string;
  readonly differenceIqd: string;
  /** inventory + departures + rounding (+ the unattributed part of a pre-0280 lock) = total, exactly. */
  readonly balanced: boolean;
  /** What the lock row itself says went to stock and left. */
  readonly recordedInventoryIqd: string;
  readonly recordedDepartedIqd: string;
  /**
   * A lock written before 0280 sent its departed part to cost of sales with no
   * departure rows: that part, unattributed to any movement — counted in
   * `accountedIqd` (the lock's own record places it) and shown here so the
   * reader sees which dinars no row explains. Zero otherwise.
   */
  readonly unattributedIqd: string;
}

export interface LockTrace {
  readonly lockId: string;
  /** `IMP-…/2` — the import's number and the lock's sequence, as the event log names it. */
  readonly lockNo: string;
  readonly sequence: number;
  readonly lockDate: string;
  readonly entryNo: string | null;
  readonly basisCode: string;
  readonly basisName: string | null;
  readonly note: string | null;
  readonly totalIqd: string;
  readonly chargeTypes: LockChargeType[];
  readonly reconciliation: LockReconciliation;
}

export interface LayerChargeShare extends LockChargeType {
  /** This received layer's allocation of the lock, split over the charge types by largest remainder. */
  readonly layerShareIqd: string;
}

export interface FollowedLayer {
  readonly layerId: string;
  readonly warehouseCode: string;
  readonly viaLayerId: string | null;
  readonly allocatedIqd: string;
  readonly inventoryIqd: string;
  readonly departedIqd: string;
  readonly onHandQty: string;
  readonly unitCostBeforeIqd: string;
  readonly unitCostAfterIqd: string;
}

export interface LayerLockTrace {
  readonly lockId: string;
  readonly lockNo: string;
  readonly sequence: number;
  readonly lockDate: string;
  readonly entryNo: string | null;
  readonly basisCode: string;
  readonly basisName: string | null;
  /** The received layer's whole share of the lock: its own row and every row its stock was followed to. */
  readonly allocatedIqd: string;
  readonly ownAllocatedIqd: string;
  readonly followedIqd: string;
  readonly inventoryIqd: string;
  readonly departedIqd: string;
  /** On the received layer itself; null when the lock wrote it no row (all of its share followed its stock). */
  readonly unitCostBeforeIqd: string | null;
  readonly unitCostAfterIqd: string | null;
  readonly unitChangeIqd: string | null;
  /** allocatedIqd ÷ received quantity, half up. */
  readonly addedPerReceivedUnitIqd: string;
  /** What a received unit had cost once this lock was in (the chain's link). */
  readonly landedUnitAfterIqd: string;
  readonly chargeTypes: LayerChargeShare[];
  /** The rows of this lock on other layers of the lineage (stock a transfer had carried on). */
  readonly followed: FollowedLayer[];
}

export interface LineageLayer {
  readonly layerId: string;
  readonly parentLayerId: string | null;
  readonly link: LineageLink;
  readonly warehouseCode: string;
  readonly layerDate: string;
  /** How the layer was created (`transfer_receipt`, `sales_return` …). */
  readonly createdByKind: string;
  readonly originalQty: string;
  readonly remainingQty: string;
  readonly unitCostIqd: string;
  /** remaining × unit cost, half up. */
  readonly valueIqd: string;
}

export interface PurchaseOrigin {
  readonly unitIqd: string;
  readonly valueIqd: string;
  /** `lock`: the earliest lock's unit_cost_before; `layer`: no lock touched it, so its own unit cost. */
  readonly unitFrom: 'lock' | 'layer';
  /** The purchase invoice behind the goods, when it can be found. */
  readonly invoice: {
    readonly invoiceNo: string;
    /**
     * `origin_layer`: followed by `cost_layer.origin_layer_id` to the layer the
     * invoice's goods receipt created. `paired_transfer`: at least one hop was
     * the transfer issue of the same document line and quantity (relocations
     * before 0280). `only_invoice`: the import has one posted invoice and the
     * trail could not be followed — the invoice is inferred, not traced.
     */
    readonly foundBy: 'origin_layer' | 'paired_transfer' | 'only_invoice';
  } | null;
  /** What the goods were agreed in (ap_invoice.agreed_currency / agreed_rate, 0272); null when agreed in dinars. */
  readonly agreed: {
    readonly currency: string;
    /** IQD for one unit of the currency on the invoice's date. */
    readonly rate: string;
    /** DERIVED: unitIqd ÷ rate, half up — the invoice line holds dinars, not this. */
    readonly derivedUnitTxn: string;
    /** DERIVED: valueIqd ÷ rate, half up. */
    readonly derivedValueTxn: string;
  } | null;
}

export interface DepartureView extends DepartureLine {
  readonly lockId: string;
  readonly lockNo: string;
  readonly lockSequence: number;
  readonly layerId: string;
  readonly warehouseCode: string | null;
  /** The document that moved the stock — its type and number, nothing else. */
  readonly documentType: string | null;
  readonly documentNo: string | null;
  readonly accountCode: string | null;
  readonly accountName: string | null;
  readonly departedOn: string;
  readonly postSettlement: boolean;
}

/** A departure row for the reader: money and quantity as strings. */
export type DepartureRowOut = Omit<DepartureView, 'quantity' | 'amountIqd'> & {
  readonly quantity: string;
  readonly amountIqd: string;
};

export interface DepartureGroupOut {
  readonly movementKind: string | null;
  readonly destinationRole: string;
  readonly quantity: string;
  readonly departedIqd: string;
  readonly returnedIqd: string;
  readonly netIqd: string;
  readonly entries: { readonly departure: DepartureRowOut | null; readonly returns: DepartureRowOut[] }[];
}

export interface ReceivedLayerTrace {
  readonly layerId: string;
  readonly warehouseCode: string;
  readonly layerDate: string;
  readonly receivedQty: string;
  readonly onHandQty: string;
  readonly purchase: PurchaseOrigin;
  readonly chargesIqd: string;
  readonly finalUnitIqd: string;
  readonly stockValueIqd: string;
  readonly departedIqd: string;
  readonly consumedIqd: string;
  /** Every layer the received stock stands in or passed through, the received layer first. */
  readonly lineage: LineageLayer[];
  readonly locks: LayerLockTrace[];
  /** What one received unit cost: the purchase, then after each lock (per received unit, A1-proof). */
  readonly unitCostChain: string[];
  readonly unitCostChainText: string;
  /** The received layer's own unit cost: before the first lock, then after each (flat once it had sold out). */
  readonly layerUnitCostChain: string[];
  readonly layerUnitCostChainText: string;
  /** Where the departed part went, by transaction and destination; returns beside their departures. */
  readonly departures: DepartureGroupOut[];
}

export interface ModelTrace {
  readonly itemCode: string;
  readonly totals: FinalCostRow;
  readonly layers: ReceivedLayerTrace[];
}

export interface FinalCostTrace {
  readonly payableId: string;
  readonly payableNo: string;
  readonly models: ModelTrace[];
  readonly locks: LockTrace[];
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

interface LayerFact {
  readonly id: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly layerDate: string;
  readonly original: bigint;
  readonly remaining: bigint;
  readonly unitCost: bigint;
  readonly originLayerId: string | null;
  readonly createdByMovementId: string;
  readonly createdKind: string;
  readonly createdSourceType: string | null;
  readonly createdSourceId: string | null;
}

interface LockFact {
  readonly id: string;
  readonly sequence: number;
  readonly lockDate: string;
  readonly basisCode: string;
  readonly basisName: string | null;
  readonly total: bigint;
  readonly inventory: bigint;
  readonly cogs: bigint;
  readonly entryNo: string | null;
  readonly note: string | null;
}

interface AdjustmentFact {
  readonly lockId: string;
  readonly sequence: number;
  readonly layerId: string;
  readonly warehouseCode: string;
  readonly viaLayerId: string | null;
  readonly allocated: bigint;
  readonly onHand: bigint;
  readonly before: bigint;
  readonly after: bigint;
  readonly inventory: bigint;
  readonly cogs: bigint;
}

interface ChargeFact {
  readonly lockId: string;
  readonly chargeTypeCode: string;
  readonly chargeTypeName: string | null;
  readonly amount: bigint;
  readonly sourceType: string;
  readonly sourceNo: string | null;
}

interface Facts {
  readonly payableNo: string;
  readonly roots: LayerFact[];
  readonly lineage: Map<string, LineageEntry>;
  readonly layers: Map<string, LayerFact>;
  readonly locks: LockFact[];
  readonly adjustments: AdjustmentFact[];
  readonly charges: ChargeFact[];
  readonly departures: DepartureView[];
  /** Σ cost_layer_consumption.cost_iqd per lineage layer. */
  readonly consumed: Map<string, bigint>;
}

const LAYER_COLUMNS = sql`
  cl.id, cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode", cl.layer_date::text as "layerDate",
  cl.original_quantity::text as "original", cl.remaining_quantity::text as "remaining",
  cl.unit_cost_iqd::text as "unitCost", cl.origin_layer_id as "originLayerId",
  cl.created_by_movement_id as "createdByMovementId", m.kind::text as "createdKind",
  m.source_document_type as "createdSourceType", m.source_document_id as "createdSourceId"`;

type LayerRow = {
  id: string;
  itemCode: string;
  warehouseCode: string;
  layerDate: string;
  original: string;
  remaining: string;
  unitCost: string;
  originLayerId: string | null;
  createdByMovementId: string;
  createdKind: string;
  createdSourceType: string | null;
  createdSourceId: string | null;
};

const layerFact = (row: LayerRow): LayerFact => ({
  id: row.id,
  itemCode: row.itemCode,
  warehouseCode: row.warehouseCode,
  layerDate: row.layerDate,
  original: quantityOf(row.original),
  remaining: quantityOf(row.remaining),
  unitCost: amountOf(row.unitCost),
  originLayerId: row.originLayerId,
  createdByMovementId: row.createdByMovementId,
  createdKind: row.createdKind,
  createdSourceType: row.createdSourceType,
  createdSourceId: row.createdSourceId,
});

/** The FIFO layers the import's container receipts created — as `landed-cost.receivedLayers` reads them. */
async function receivedLayers(tx: Tx, payableId: string): Promise<LayerFact[]> {
  const result = await tx.execute(sql`
    select ${LAYER_COLUMNS}
      from cost_layer cl
      join inventory_movement m on m.id = cl.created_by_movement_id
      join container_receipt r on r.id::text = m.source_document_id
     where m.source_document_type = 'container_receipt'
       and m.kind = 'transfer_receipt'
       and r.payable_id = ${payableId}
     order by cl.item_code, cl.layer_date, cl.sequence`);
  return rowsOf<LayerRow>(result).map(layerFact);
}

async function layersById(tx: Tx, ids: readonly string[]): Promise<LayerFact[]> {
  if (ids.length === 0) return [];
  const result = await tx.execute(sql`
    select ${LAYER_COLUMNS}
      from cost_layer cl
      join inventory_movement m on m.id = cl.created_by_movement_id
     where cl.id in (${idList(ids)})`);
  return rowsOf<LayerRow>(result).map(layerFact);
}

/** Every layer the received layers' stock reached, by the three recorded links. */
async function lineageOf(tx: Tx, roots: readonly LayerFact[]): Promise<Map<string, LineageEntry>> {
  const lineage = new Map<string, LineageEntry>();
  for (const root of roots) lineage.set(root.id, { rootId: root.id, parentId: null, link: 'received', depth: 0 });
  let frontier = roots.map((root) => root.id);
  for (let depth = 0; frontier.length > 0 && depth < MAX_DEPTH; depth += 1) {
    const result = await tx.execute(sql`
      select child_id as "childId", parent_id as "parentId", link
        from (
          select c.id as child_id, c.origin_layer_id as parent_id, 'origin_layer' as link, 1 as rank
            from cost_layer c
           where c.origin_layer_id in (${idList(frontier)})
          union
          select a.cost_layer_id, a.via_layer_id, 'lock_followed', 2
            from landed_cost_layer_adjustment a
           where a.via_layer_id in (${idList(frontier)})
          union
          select d.to_layer_id, d.cost_layer_id, case when d.kind = 'return' then 'returned' else 'moved' end, 3
            from landed_cost_departure d
           where d.cost_layer_id in (${idList(frontier)})
             and d.to_layer_id is not null
             and d.to_layer_id <> d.cost_layer_id
        ) edges
       order by rank, parent_id, child_id`);
    frontier = extendLineage(lineage, rowsOf<LineageEdge>(result));
  }
  return lineage;
}

async function gather(tx: Tx, payableId: string): Promise<Facts | null> {
  const [payable] = rowsOf<{ payableNo: string }>(
    await tx.execute(sql`select payable_no as "payableNo" from payable where id = ${payableId}`),
  );
  if (!payable) throw new LandedCostError('No such import.');

  const roots = await receivedLayers(tx, payableId);
  if (roots.length === 0) return null;
  const lineage = await lineageOf(tx, roots);
  const layers = new Map(roots.map((root) => [root.id, root]));
  for (const layer of await layersById(tx, [...lineage.keys()].filter((id) => !layers.has(id)))) {
    layers.set(layer.id, layer);
  }
  const ids = [...lineage.keys()];

  const locks = rowsOf<{
    id: string;
    sequence: number;
    lockDate: string;
    basisCode: string;
    basisName: string | null;
    total: string;
    inventory: string;
    cogs: string;
    entryNo: string | null;
    note: string | null;
  }>(
    await tx.execute(sql`
      select k.id, k.sequence, k.lock_date::text as "lockDate", k.basis_code as "basisCode", b.name as "basisName",
             k.total_iqd::text as total, k.inventory_iqd::text as inventory, k.cogs_iqd::text as cogs,
             j.entry_no as "entryNo", k.note
        from landed_cost_lock k
        left join landed_cost_basis b on b.code = k.basis_code
        left join journal_entry j on j.id = k.journal_entry_id
       where k.payable_id = ${payableId}
       order by k.sequence`),
  ).map((row) => ({
    id: row.id,
    sequence: Number(row.sequence),
    lockDate: row.lockDate,
    basisCode: row.basisCode,
    basisName: row.basisName,
    total: amountOf(row.total),
    inventory: amountOf(row.inventory),
    cogs: amountOf(row.cogs),
    entryNo: row.entryNo,
    note: row.note,
  }));

  const adjustments = rowsOf<{
    lockId: string;
    sequence: number;
    layerId: string;
    warehouseCode: string;
    viaLayerId: string | null;
    allocated: string;
    onHand: string;
    before: string;
    after: string;
    inventory: string;
    cogs: string;
  }>(
    await tx.execute(sql`
      select a.lock_id as "lockId", k.sequence, a.cost_layer_id as "layerId", a.warehouse_code as "warehouseCode",
             a.via_layer_id as "viaLayerId", a.allocated_iqd::text as allocated, a.on_hand_qty::text as "onHand",
             a.unit_cost_before::text as before, a.unit_cost_after::text as after,
             a.inventory_iqd::text as inventory, a.cogs_iqd::text as cogs
        from landed_cost_layer_adjustment a
        join landed_cost_lock k on k.id = a.lock_id
       where a.payable_id = ${payableId}
       order by k.sequence, a.created_at, a.id`),
  ).map((row) => ({
    lockId: row.lockId,
    sequence: Number(row.sequence),
    layerId: row.layerId,
    warehouseCode: row.warehouseCode,
    viaLayerId: row.viaLayerId,
    allocated: amountOf(row.allocated),
    onHand: quantityOf(row.onHand),
    before: amountOf(row.before),
    after: amountOf(row.after),
    inventory: amountOf(row.inventory),
    cogs: amountOf(row.cogs),
  }));

  const charges = rowsOf<{
    lockId: string;
    chargeTypeCode: string;
    chargeTypeName: string | null;
    amount: string;
    sourceType: string;
    sourceNo: string | null;
  }>(
    await tx.execute(sql`
      select c.lock_id as "lockId", c.charge_type_code as "chargeTypeCode", t.name as "chargeTypeName",
             c.amount_iqd::text as amount, c.source_type as "sourceType", c.source_no as "sourceNo"
        from landed_cost_charge c
        left join landed_cost_type t on t.code = c.charge_type_code
       where c.payable_id = ${payableId}
         and c.lock_id is not null
         and c.cancelled_at is null
       order by c.created_at, c.id`),
  ).map((row) => ({ ...row, amount: amountOf(row.amount) }));

  /*
   * The document behind each departed movement, by type and number only. A
   * project issue's movement names the project as its source; the number shown
   * is the Material Issue's, found through the line that wrote the movement,
   * and the project's own code is never selected.
   */
  const departures = rowsOf<{
    id: string;
    lockId: string;
    kind: 'departure' | 'return' | 'rounding';
    layerId: string;
    movementKind: string | null;
    quantity: string;
    amount: string;
    destinationRole: string;
    accountCode: string | null;
    accountName: string | null;
    returnsDepartureId: string | null;
    movementId: string | null;
    postSettlement: boolean;
    departedOn: string;
    documentType: string | null;
    documentNo: string | null;
  }>(
    await tx.execute(sql`
      select d.id, d.lock_id as "lockId", d.kind, d.cost_layer_id as "layerId", d.movement_id as "movementId",
             coalesce(d.movement_kind, m.kind::text) as "movementKind",
             d.quantity::text as quantity, d.amount_iqd::text as amount, d.destination_role as "destinationRole",
             a.code as "accountCode", a.name as "accountName", d.returns_departure_id as "returnsDepartureId",
             d.post_settlement as "postSettlement", d.departed_on::text as "departedOn",
             case when issue.document_no is not null or src.type = 'project' then 'project_material_issue'
                  else src.type end as "documentType",
             coalesce(issue.document_no,
               case src.type
                 when 'ar_invoice'            then (select x.invoice_no from ar_invoice x where x.id::text = src.id)
                 when 'sales_return'          then (select x.return_no from sales_return x where x.id::text = src.id)
                 when 'goods_return'          then (select x.return_no from goods_return x where x.id::text = src.id)
                 when 'stock_adjustment'      then (select x.adjustment_no from stock_adjustment x where x.id::text = src.id)
                 when 'stock_count'           then (select x.count_no from stock_count x where x.id::text = src.id)
                 when 'stock_transfer'        then (select x.transfer_no from stock_transfer x where x.id::text = src.id)
                 when 'warehouse_transfer'    then (select x.transfer_no from warehouse_transfer x where x.id::text = src.id)
                 when 'delivery_note'         then (select x.delivery_note_no from delivery_note x where x.id::text = src.id)
                 when 'client_goods_delivery' then (select x.delivery_no from client_goods_delivery x where x.id::text = src.id)
                 when 'container_receipt'     then (select x.receipt_no from container_receipt x where x.id::text = src.id)
                 when 'ap_invoice'            then (select x.invoice_no from ap_invoice x where x.id::text = src.id)
               end) as "documentNo"
        from landed_cost_departure d
        left join inventory_movement m on m.id = d.movement_id
        left join chart_of_account a on a.id = d.account_id
        cross join lateral (
          select coalesce(d.source_document_type, m.source_document_type) as type,
                 coalesce(d.source_document_id, m.source_document_id) as id
        ) src
        left join lateral (
          select i.document_no
            from project_material_issue_line l
            join project_material_issue i on i.id = l.issue_id
           where l.movement_id = d.movement_id
           limit 1
        ) issue on d.movement_id is not null
       where d.payable_id = ${payableId}
       order by d.departed_on, d.created_at, d.id`),
  ).map((row) => {
    const lock = locks.find((candidate) => candidate.id === row.lockId);
    return {
      id: row.id,
      kind: row.kind,
      movementKind: row.movementKind,
      destinationRole: row.destinationRole,
      quantity: quantityOf(row.quantity),
      amountIqd: amountOf(row.amount),
      returnsDepartureId: row.returnsDepartureId,
      movementId: row.movementId,
      lockId: row.lockId,
      lockNo: `${payable.payableNo}/${lock?.sequence ?? '?'}`,
      lockSequence: lock?.sequence ?? 0,
      layerId: row.layerId,
      warehouseCode: layers.get(row.layerId)?.warehouseCode ?? null,
      documentType: row.documentType,
      documentNo: row.documentNo,
      accountCode: row.accountCode,
      accountName: row.accountName,
      departedOn: row.departedOn,
      postSettlement: row.postSettlement,
    };
  });

  const consumed = new Map(
    rowsOf<{ layerId: string; cost: string }>(
      await tx.execute(sql`
        select c.layer_id as "layerId", sum(c.cost_iqd)::text as cost
          from cost_layer_consumption c
         where c.layer_id in (${idList(ids)})
         group by c.layer_id`),
    ).map((row) => [row.layerId, amountOf(row.cost)]),
  );

  return { payableNo: payable.payableNo, roots, lineage, layers, locks, adjustments, charges, departures, consumed };
}

// ---------------------------------------------------------------------------
// The arithmetic over the facts
// ---------------------------------------------------------------------------

interface RootFigures {
  readonly root: LayerFact;
  readonly members: LayerFact[];
  readonly purchaseUnit: bigint;
  readonly purchaseUnitFrom: 'lock' | 'layer';
  readonly purchaseValue: bigint;
  readonly charges: bigint;
  readonly onHand: bigint;
  /** Σ remaining × unit cost, exact (scale 1e10). */
  readonly stockExact: bigint;
  readonly departed: bigint;
  readonly consumed: bigint;
  /** Per lock, in sequence: the rows on this lineage. */
  readonly byLock: { lock: LockFact; rows: AdjustmentFact[]; allocated: bigint }[];
}

/** The unit cost a layer was created with: before the earliest lock that touched it, else what it carries. */
function creationUnit(facts: Facts, layer: LayerFact): { unit: bigint; from: 'lock' | 'layer' } {
  const first = facts.adjustments.find((row) => row.layerId === layer.id);
  return first ? { unit: first.before, from: 'lock' } : { unit: layer.unitCost, from: 'layer' };
}

function figuresOf(facts: Facts): RootFigures[] {
  // A lock written before 0280 has no departure rows: its departed part is the
  // cogs of its rows.
  const legacy = new Set(
    facts.locks
      .filter((lock) => lock.cogs !== 0n && !facts.departures.some((row) => row.lockId === lock.id))
      .map((lock) => lock.id),
  );
  return facts.roots.map((root) => {
    const members = [...facts.lineage.entries()]
      .filter(([, entry]) => entry.rootId === root.id)
      .sort((a, b) => a[1].depth - b[1].depth)
      .map(([id]) => facts.layers.get(id))
      .filter((layer): layer is LayerFact => Boolean(layer));
    const memberIds = new Set(members.map((layer) => layer.id));
    const rows = facts.adjustments.filter((row) => memberIds.has(row.layerId));
    const purchase = creationUnit(facts, root);

    let consumed = 0n;
    for (const layer of members) {
      consumed += facts.consumed.get(layer.id) ?? 0n;
      if (layer.id !== root.id) consumed -= valueOf(layer.original, creationUnit(facts, layer).unit);
    }
    const departed =
      facts.departures.filter((row) => memberIds.has(row.layerId)).reduce((sum, row) => sum + row.amountIqd, 0n) +
      rows.filter((row) => legacy.has(row.lockId)).reduce((sum, row) => sum + row.cogs, 0n);

    return {
      root,
      members,
      purchaseUnit: purchase.unit,
      purchaseUnitFrom: purchase.from,
      purchaseValue: valueOf(root.original, purchase.unit),
      charges: rows.reduce((sum, row) => sum + row.allocated, 0n),
      onHand: members.reduce((sum, layer) => sum + layer.remaining, 0n),
      stockExact: members.reduce((sum, layer) => sum + exactValue(layer.remaining, layer.unitCost), 0n),
      departed,
      consumed,
      byLock: facts.locks.map((lock) => {
        const mine = rows.filter((row) => row.lockId === lock.id);
        return { lock, rows: mine, allocated: mine.reduce((sum, row) => sum + row.allocated, 0n) };
      }),
    };
  });
}

function modelRows(figures: readonly RootFigures[]): FinalCostRow[] {
  const byModel = new Map<string, RootFigures[]>();
  for (const entry of figures) byModel.set(entry.root.itemCode, [...(byModel.get(entry.root.itemCode) ?? []), entry]);
  return [...byModel.entries()]
    .map(([itemCode, entries]) => {
      const sum = (pick: (entry: RootFigures) => bigint) => entries.reduce((acc, entry) => acc + pick(entry), 0n);
      const received = sum((entry) => entry.root.original);
      const purchase = sum((entry) => entry.purchaseValue);
      const charges = sum((entry) => entry.charges);
      const stock = roundExactValue(sum((entry) => entry.stockExact));
      const departed = sum((entry) => entry.departed);
      const consumed = sum((entry) => entry.consumed);
      return {
        itemCode,
        receivedQty: formatQuantity(received),
        onHandQty: formatQuantity(sum((entry) => entry.onHand)),
        invoicedUnitIqd: money(unitOf(purchase, received)),
        chargesUnitIqd: money(unitOf(charges, received)),
        finalUnitIqd: money(unitOf(purchase + charges, received)),
        chargesIqd: money(charges),
        finalValueIqd: money(stock),
        purchaseValueIqd: money(purchase),
        stockValueIqd: money(stock),
        departedIqd: money(departed),
        consumedIqd: money(consumed),
        unexplainedIqd: money(
          unexplainedOf({
            purchaseValueIqd: purchase,
            chargesIqd: charges,
            stockValueIqd: stock,
            departedIqd: departed,
            consumedIqd: consumed,
          }),
        ),
      };
    })
    .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
}

// ---------------------------------------------------------------------------
// finalCost
// ---------------------------------------------------------------------------

/**
 * What each model of the import finally cost — the import page's table, with
 * the audit's corrections (see the head of this file).
 *
 * Empty until something is locked, as before: until then the figure is a
 * forecast, and `landed-cost.preview` is where a forecast belongs.
 */
export async function finalCost(tx: Tx, payableId: string): Promise<FinalCostRow[]> {
  const facts = await gather(tx, payableId);
  if (!facts || facts.locks.length === 0) return [];
  return modelRows(figuresOf(facts));
}

// ---------------------------------------------------------------------------
// finalCostTrace
// ---------------------------------------------------------------------------

/** The purchase invoice behind a received layer, followed back through the layers it was relocated from. */
async function purchaseInvoiceOf(
  tx: Tx,
  payableId: string,
  root: LayerFact,
): Promise<{ invoiceId: string; foundBy: 'origin_layer' | 'paired_transfer' | 'only_invoice' } | null> {
  let current: LayerFact | undefined = root;
  let paired = false;
  for (let hop = 0; current && hop < MAX_ORIGIN_HOPS; hop += 1) {
    if (current.createdKind === 'goods_receipt' && current.createdSourceType === 'ap_invoice' && current.createdSourceId) {
      return { invoiceId: current.createdSourceId, foundBy: paired ? 'paired_transfer' : 'origin_layer' };
    }
    let parentId = current.originLayerId;
    if (!parentId && current.createdKind === 'transfer_receipt') {
      // Before 0280 a relocation did not name its origin: the transfer issue of
      // the same document line, item and quantity is the other half of it.
      const [candidate] = rowsOf<{ layerId: string }>(
        await tx.execute(sql`
          select c.layer_id as "layerId"
            from inventory_movement r
            join inventory_movement i
              on i.kind = 'transfer_issue'
             and i.item_code = r.item_code
             and i.source_document_type is not distinct from r.source_document_type
             and i.source_document_id = r.source_document_id
             and coalesce(i.source_line_id, '') = coalesce(r.source_line_id, '')
             and i.quantity = -r.quantity
            join cost_layer_consumption c on c.movement_id = i.id and c.quantity > 0
           where r.id = ${current.createdByMovementId}
           order by i.created_at, i.id, c.layer_id
           limit 1`),
      );
      parentId = candidate?.layerId ?? null;
      paired = parentId !== null;
    }
    if (!parentId) break;
    [current] = await layersById(tx, [parentId]);
  }
  const invoices = rowsOf<{ id: string }>(
    await tx.execute(sql`
      select id from ap_invoice
       where payable_id = ${payableId} and posted_at is not null and reversed_at is null`),
  );
  return invoices.length === 1 ? { invoiceId: invoices[0]!.id, foundBy: 'only_invoice' } : null;
}

async function purchaseOrigin(tx: Tx, payableId: string, entry: RootFigures): Promise<PurchaseOrigin> {
  const found = await purchaseInvoiceOf(tx, payableId, entry.root);
  const [invoice] = found
    ? rowsOf<{ invoiceNo: string; agreedCurrency: string | null; agreedRate: string | null }>(
        await tx.execute(sql`
          select invoice_no as "invoiceNo", agreed_currency as "agreedCurrency", agreed_rate::text as "agreedRate"
            from ap_invoice where id::text = ${found.invoiceId}`),
      )
    : [];
  const rate = invoice?.agreedCurrency && invoice.agreedRate ? parseDecimal(invoice.agreedRate, RATE_SCALE) : null;
  const rateFactor = 10n ** RATE_SCALE;
  return {
    unitIqd: money(entry.purchaseUnit),
    valueIqd: money(entry.purchaseValue),
    unitFrom: entry.purchaseUnitFrom,
    invoice: invoice && found ? { invoiceNo: invoice.invoiceNo, foundBy: found.foundBy } : null,
    agreed:
      invoice?.agreedCurrency && rate && rate > 0n
        ? {
            currency: invoice.agreedCurrency,
            rate: toDecimalString(rate, RATE_SCALE),
            derivedUnitTxn: money(divideHalfUp(entry.purchaseUnit * rateFactor, rate)),
            derivedValueTxn: money(divideHalfUp(entry.purchaseValue * rateFactor, rate)),
          }
        : null,
  };
}

function lockChargeTypes(facts: Facts, lockId: string): (LockChargeType & { amount: bigint })[] {
  const byType = new Map<string, LockChargeType & { amount: bigint; sources: ChargeSource[] }>();
  for (const charge of facts.charges.filter((row) => row.lockId === lockId)) {
    const entry = byType.get(charge.chargeTypeCode) ?? {
      chargeTypeCode: charge.chargeTypeCode,
      chargeTypeName: charge.chargeTypeName,
      amountIqd: '0',
      amount: 0n,
      sources: [],
    };
    entry.amount += charge.amount;
    entry.sources.push({ sourceType: charge.sourceType, sourceNo: charge.sourceNo, amountIqd: money(charge.amount) });
    byType.set(charge.chargeTypeCode, entry);
  }
  return [...byType.values()]
    .map((entry) => ({ ...entry, amountIqd: money(entry.amount) }))
    .sort((a, b) => a.chargeTypeCode.localeCompare(b.chargeTypeCode));
}

const stripAmount = <T extends { amount: bigint }>({ amount: _amount, ...rest }: T) => rest;

function departureOut(row: DepartureView): DepartureRowOut {
  return { ...row, quantity: formatQuantity(row.quantity), amountIqd: money(row.amountIqd) };
}

function groupOut(group: DepartureGroup<DepartureView>): DepartureGroupOut {
  return {
    movementKind: group.movementKind,
    destinationRole: group.destinationRole,
    quantity: formatQuantity(group.quantity),
    departedIqd: money(group.departedIqd),
    returnedIqd: money(group.returnedIqd),
    netIqd: money(group.netIqd),
    entries: group.entries.map((entry) => ({
      departure: entry.departure ? departureOut(entry.departure) : null,
      returns: entry.returns.map(departureOut),
    })),
  };
}

/**
 * The final cost, explained: per model, per received layer — the purchase
 * (and what it was agreed in, where that is known), each lock in sequence with
 * its charges by type and their documents and this layer's share of them, the
 * chain of unit costs, and where the share of stock that had already left went
 * — and per lock, whether every dinar of it is accounted for.
 *
 * Reads only; returns an empty trace (no models, no locks) for an import with
 * nothing received.
 */
export async function finalCostTrace(tx: Tx, payableId: string): Promise<FinalCostTrace> {
  const facts = await gather(tx, payableId);
  if (!facts) {
    const [payable] = rowsOf<{ payableNo: string }>(
      await tx.execute(sql`select payable_no as "payableNo" from payable where id = ${payableId}`),
    );
    return { payableId, payableNo: payable?.payableNo ?? '', models: [], locks: [] };
  }
  const lockNo = (lock: LockFact) => `${facts.payableNo}/${lock.sequence}`;
  const figures = figuresOf(facts);
  const totals = new Map(modelRows(figures).map((row) => [row.itemCode, row]));
  const chargeTypesByLock = new Map(facts.locks.map((lock) => [lock.id, lockChargeTypes(facts, lock.id)]));

  const locks: LockTrace[] = facts.locks.map((lock) => {
    const types = chargeTypesByLock.get(lock.id)!;
    const charges = types.reduce((sum, type) => sum + type.amount, 0n);
    const inventory = facts.adjustments.filter((row) => row.lockId === lock.id).reduce((sum, row) => sum + row.inventory, 0n);
    const own = facts.departures.filter((row) => row.lockId === lock.id);
    const departure = own.filter((row) => row.kind === 'departure').reduce((sum, row) => sum + row.amountIqd, 0n);
    const rounding = own.filter((row) => row.kind === 'rounding').reduce((sum, row) => sum + row.amountIqd, 0n);
    // A lock written before 0280: cost of sales on the lock, no rows (see `figuresOf`'s `legacy`).
    const unattributed = own.length === 0 ? lock.cogs : 0n;
    const check = reconcileLock({
      totalIqd: lock.total,
      inventoryIqd: inventory,
      departureIqd: departure,
      roundingIqd: rounding,
      unattributedIqd: unattributed,
    });
    return {
      lockId: lock.id,
      lockNo: lockNo(lock),
      sequence: lock.sequence,
      lockDate: lock.lockDate,
      entryNo: lock.entryNo,
      basisCode: lock.basisCode,
      basisName: lock.basisName,
      note: lock.note,
      totalIqd: money(lock.total),
      chargeTypes: types.map(stripAmount),
      reconciliation: {
        totalIqd: money(lock.total),
        chargesIqd: money(charges),
        chargesMatch: charges === lock.total,
        inventoryIqd: money(inventory),
        departureIqd: money(departure),
        roundingIqd: money(rounding),
        accountedIqd: money(check.accountedIqd),
        differenceIqd: money(check.differenceIqd),
        balanced: check.balanced,
        recordedInventoryIqd: money(lock.inventory),
        recordedDepartedIqd: money(lock.cogs),
        unattributedIqd: money(unattributed),
      },
    };
  });

  const models = new Map<string, ReceivedLayerTrace[]>();
  for (const entry of figures) {
    const { root } = entry;
    const memberIds = new Set(entry.members.map((layer) => layer.id));
    const chain = landedUnitChain(
      entry.purchaseValue,
      root.original,
      entry.byLock.map((step) => step.allocated),
    );
    const layerChain = [entry.purchaseUnit];
    let ownCost = entry.purchaseUnit;

    const lockTraces: LayerLockTrace[] = entry.byLock.map((step, index) => {
      const ownRow = step.rows.find((row) => row.layerId === root.id);
      if (ownRow) ownCost = ownRow.after;
      layerChain.push(ownCost);
      const ownAllocated = ownRow?.allocated ?? 0n;
      const types = chargeTypesByLock.get(step.lock.id)!;
      const shares = types.length > 0 ? splitLargestRemainder(step.allocated, types.map((type) => type.amount)) : [];
      return {
        lockId: step.lock.id,
        lockNo: lockNo(step.lock),
        sequence: step.lock.sequence,
        lockDate: step.lock.lockDate,
        entryNo: step.lock.entryNo,
        basisCode: step.lock.basisCode,
        basisName: step.lock.basisName,
        allocatedIqd: money(step.allocated),
        ownAllocatedIqd: money(ownAllocated),
        followedIqd: money(step.allocated - ownAllocated),
        inventoryIqd: money(step.rows.reduce((sum, row) => sum + row.inventory, 0n)),
        departedIqd: money(step.rows.reduce((sum, row) => sum + row.cogs, 0n)),
        unitCostBeforeIqd: ownRow ? money(ownRow.before) : null,
        unitCostAfterIqd: ownRow ? money(ownRow.after) : null,
        unitChangeIqd: ownRow ? money(ownRow.after - ownRow.before) : null,
        addedPerReceivedUnitIqd: money(unitOf(step.allocated, root.original)),
        landedUnitAfterIqd: money(chain[index + 1]!),
        chargeTypes: types.map((type, n) => ({ ...stripAmount(type), layerShareIqd: money(shares[n] ?? 0n) })),
        followed: step.rows
          .filter((row) => row.layerId !== root.id)
          .map((row) => ({
            layerId: row.layerId,
            warehouseCode: row.warehouseCode,
            viaLayerId: row.viaLayerId,
            allocatedIqd: money(row.allocated),
            inventoryIqd: money(row.inventory),
            departedIqd: money(row.cogs),
            onHandQty: formatQuantity(row.onHand),
            unitCostBeforeIqd: money(row.before),
            unitCostAfterIqd: money(row.after),
          })),
      };
    });

    const trace: ReceivedLayerTrace = {
      layerId: root.id,
      warehouseCode: root.warehouseCode,
      layerDate: root.layerDate,
      receivedQty: formatQuantity(root.original),
      onHandQty: formatQuantity(entry.onHand),
      purchase: await purchaseOrigin(tx, payableId, entry),
      chargesIqd: money(entry.charges),
      finalUnitIqd: money(unitOf(entry.purchaseValue + entry.charges, root.original)),
      stockValueIqd: money(roundExactValue(entry.stockExact)),
      departedIqd: money(entry.departed),
      consumedIqd: money(entry.consumed),
      lineage: entry.members.map((layer) => {
        const place = facts.lineage.get(layer.id)!;
        return {
          layerId: layer.id,
          parentLayerId: place.parentId,
          link: place.link,
          warehouseCode: layer.warehouseCode,
          layerDate: layer.layerDate,
          createdByKind: layer.createdKind,
          originalQty: formatQuantity(layer.original),
          remainingQty: formatQuantity(layer.remaining),
          unitCostIqd: money(layer.unitCost),
          valueIqd: money(valueOf(layer.remaining, layer.unitCost)),
        };
      }),
      locks: lockTraces,
      unitCostChain: chain.map(money),
      unitCostChainText: formatUnitChain(chain),
      layerUnitCostChain: layerChain.map(money),
      layerUnitCostChainText: formatUnitChain(layerChain),
      departures: groupDepartures(facts.departures.filter((row) => memberIds.has(row.layerId))).map(groupOut),
    };
    models.set(root.itemCode, [...(models.get(root.itemCode) ?? []), trace]);
  }

  return {
    payableId,
    payableNo: facts.payableNo,
    models: [...models.entries()]
      .map(([itemCode, layers]) => ({ itemCode, totals: totals.get(itemCode)!, layers }))
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode)),
    locks,
  };
}
