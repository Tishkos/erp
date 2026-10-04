/**
 * The landed cost — REQ-AP-001 Stage 7 (§20.2, the box under the orange band).
 *
 *   * **charges** — every cost that belongs to an import is a row of
 *     `landed_cost_charge`, created by the document that carries it: a
 *     forwarder's invoice line charged to the import (Stage 2), a loan's
 *     commission share (Stage 6), or a posted journal that parked a cost on
 *     the clearing account (here — `other` says why in words).
 *   * **lock** — offered once every PD of the import is totally written off
 *     (§20.1 condition 3). The unlocked charges are allocated, by the basis
 *     chosen, over the FIFO layers the import's container receipts created.
 *     For each layer the share still on hand restates its unit cost (Dr the
 *     item's inventory account); the share that left with a sale is cost of
 *     sales (Dr the item's COGS account); the share a transfer carried on
 *     follows the stock to the layer it went to. Cr the clearing account with
 *     the total. One transaction: the journal, the layers, their adjustments,
 *     the charges' lock, the events.
 *   * **adjustment** — a charge that arrives after the lock is allocated by a
 *     later, dated lock of the same import (sequence 2, 3 …), never by an edit.
 *
 * The value-only restatement is recorded in `landed_cost_layer_adjustment`,
 * not as a movement: the ledger holds quantities, and refuses a movement of
 * nothing.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  costLayer,
  item,
  journalEntry,
  landedCostBasis,
  landedCostCharge,
  landedCostDeparture,
  landedCostLayerAdjustment,
  landedCostLock,
  landedCostType,
} from '../db/schema';
import {
  BASES,
  LandedCostError,
  NOT_ALLOCATED,
  allocate,
  formatIqd,
  restate,
  spreadByWeights,
  valueOf,
  type Basis,
} from '../domain/landed-cost';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as departures from './inventory-departures';
import * as events from './payable-events';
import * as payables from './payables';
import * as posting from './posting';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'landed_cost';
const DOCUMENT_TYPE = 'landed_cost_lock';
const JOURNAL_SOURCE = 'journal_entry';

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);

export { LandedCostError };

async function importOf(tx: Tx, payableId: string, options: { lock?: boolean } = {}) {
  // HD9 — a lock (and a late adjustment) locks the import first, so two
  // simultaneous locks cannot allocate the same charges twice.
  const row = options.lock ? await payables.lock(tx, payableId) : await payables.load(tx, payableId);
  if (row.payableTypeCode !== 'import') {
    throw new LandedCostError(`${row.payableNo} is not an import; only an import carries a landed cost.`);
  }
  if (row.cancelledAt) throw new LandedCostError(`${row.payableNo} is cancelled.`);
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function bases(tx: Tx) {
  return tx.select().from(landedCostBasis).orderBy(asc(landedCostBasis.sortOrder));
}

export async function chargeTypes(tx: Tx) {
  return tx
    .select({ code: landedCostType.code, name: landedCostType.name })
    .from(landedCostType)
    .where(eq(landedCostType.active, true));
}

/** The import's charges, the lock that consumed each, newest first. */
export async function chargesFor(tx: Tx, payableId: string) {
  return tx
    .select({
      id: landedCostCharge.id,
      chargeTypeCode: landedCostCharge.chargeTypeCode,
      chargeTypeName: landedCostType.name,
      amountTxn: landedCostCharge.amountTxn,
      currency: landedCostCharge.currency,
      amountIqd: landedCostCharge.amountIqd,
      sourceType: landedCostCharge.sourceType,
      sourceNo: landedCostCharge.sourceNo,
      note: landedCostCharge.note,
      reason: landedCostCharge.reason,
      lockId: landedCostCharge.lockId,
      lockSequence: landedCostLock.sequence,
      cancelledAt: landedCostCharge.cancelledAt,
      cancelReason: landedCostCharge.cancelReason,
      createdAt: landedCostCharge.createdAt,
    })
    .from(landedCostCharge)
    .innerJoin(landedCostType, eq(landedCostType.code, landedCostCharge.chargeTypeCode))
    .leftJoin(landedCostLock, eq(landedCostLock.id, landedCostCharge.lockId))
    .where(eq(landedCostCharge.payableId, payableId))
    .orderBy(desc(landedCostCharge.createdAt));
}

export async function locksFor(tx: Tx, payableId: string) {
  return tx
    .select({
      id: landedCostLock.id,
      sequence: landedCostLock.sequence,
      lockDate: landedCostLock.lockDate,
      basisCode: landedCostLock.basisCode,
      basisName: landedCostBasis.name,
      totalIqd: landedCostLock.totalIqd,
      inventoryIqd: landedCostLock.inventoryIqd,
      cogsIqd: landedCostLock.cogsIqd,
      entryNo: journalEntry.entryNo,
      note: landedCostLock.note,
      lockedBy: appUser.displayName,
      lockedAt: landedCostLock.lockedAt,
    })
    .from(landedCostLock)
    .innerJoin(landedCostBasis, eq(landedCostBasis.code, landedCostLock.basisCode))
    .innerJoin(journalEntry, eq(journalEntry.id, landedCostLock.journalEntryId))
    .leftJoin(appUser, eq(appUser.id, landedCostLock.lockedBy))
    .where(eq(landedCostLock.payableId, payableId))
    .orderBy(asc(landedCostLock.sequence));
}

/** Live charges no lock has allocated yet (never the goods themselves). */
async function unlockedCharges(tx: Tx, payableId: string) {
  const rows = await tx
    .select()
    .from(landedCostCharge)
    .where(
      and(
        eq(landedCostCharge.payableId, payableId),
        isNull(landedCostCharge.lockId),
        isNull(landedCostCharge.cancelledAt),
      ),
    );
  return rows.filter((row) => !NOT_ALLOCATED.has(row.chargeTypeCode));
}

/** A FIFO layer as the lock reads it. */
interface LayerRow {
  readonly id: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly branchCode: string;
  readonly layerDate: string;
  readonly supplierId: string | null;
  readonly originalQuantity: bigint;
  readonly remainingQuantity: bigint;
  readonly unitCost: bigint;
}
type ReceivedLayer = LayerRow;

interface LayerSqlRow {
  id: string;
  itemCode: string;
  warehouseCode: string;
  branchCode: string;
  layerDate: string;
  supplierId: string | null;
  originalQuantity: string;
  remainingQuantity: string;
  unitCost: string;
}

const LAYER_COLUMNS = sql`cl.id, cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode",
       cl.branch_code as "branchCode", cl.layer_date::text as "layerDate", cl.supplier_id as "supplierId",
       cl.original_quantity::text as "originalQuantity", cl.remaining_quantity::text as "remainingQuantity",
       cl.unit_cost_iqd::text as "unitCost"`;

const toLayer = (row: LayerSqlRow): LayerRow => ({
  id: row.id,
  itemCode: row.itemCode,
  warehouseCode: row.warehouseCode,
  branchCode: row.branchCode,
  layerDate: row.layerDate,
  supplierId: row.supplierId,
  originalQuantity: parseQuantity(row.originalQuantity),
  remainingQuantity: parseQuantity(row.remainingQuantity),
  unitCost: amountOf(row.unitCost),
});

/** The FIFO layers the import's container receipts created (§18). */
async function receivedLayers(tx: Tx, payableId: string): Promise<ReceivedLayer[]> {
  const result = await tx.execute(sql`
    select ${LAYER_COLUMNS}
      from cost_layer cl
      join inventory_movement m on m.id = cl.created_by_movement_id
      join container_receipt r on r.id::text = m.source_document_id
     where m.source_document_type = 'container_receipt'
       and m.kind = 'transfer_receipt'
       and r.payable_id = ${payableId}
     order by cl.item_code, cl.layer_date, cl.sequence`);
  return (result.rows as unknown as LayerSqlRow[]).map(toLayer);
}

async function layersByIds(tx: Tx, ids: readonly string[]): Promise<Map<string, LayerRow>> {
  if (ids.length === 0) return new Map();
  const result = await tx.execute(sql`
    select ${LAYER_COLUMNS} from cost_layer cl
     where cl.id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  return new Map((result.rows as unknown as LayerSqlRow[]).map((row) => [row.id, toLayer(row)]));
}

/**
 * HD9 for the layers — locked before they are read, by item and warehouse
 * the way `inventory.issue` locks them, all the rows of each pair in
 * (item, warehouse, date, sequence) order. A sale or a transfer of the same
 * stock waits for the lock, and the lock reads remaining quantities nobody
 * else is changing. Returns whether a pair not locked before was locked.
 */
async function lockLayers(tx: Tx, layers: Iterable<LayerRow>, locked: Set<string>): Promise<boolean> {
  const pairs = new Map<string, readonly [string, string]>();
  for (const layer of layers) {
    const key = `${layer.itemCode}\u0000${layer.warehouseCode}`;
    if (!locked.has(key)) pairs.set(key, [layer.itemCode, layer.warehouseCode]);
  }
  if (pairs.size === 0) return false;
  await tx.execute(sql`
    select id from cost_layer
     where (item_code, warehouse_code) in (${sql.join([...pairs.values()].map(([itemCode, warehouseCode]) => sql`(${itemCode}, ${warehouseCode})`), sql`, `)})
     order by item_code, warehouse_code, layer_date, sequence, id
       for update`);
  for (const key of pairs.keys()) locked.add(key);
  return true;
}

/**
 * What became of the units that left one layer, each with its quantity:
 *
 *   follow  — the units are stock again elsewhere, in a layer of their own: a
 *             relocation's receipt, or a sales return. The cost goes with them
 *             and is restated there (or follows them further).
 *   depart  — the units left stock for good, by this movement. The cost goes
 *             where that movement's business event sends it.
 */
type Entry =
  | { readonly kind: 'follow'; readonly layerId: string; readonly quantity: bigint }
  | { readonly kind: 'depart'; readonly movement: departures.DepartedMovement; readonly quantity: bigint };

interface GraphNode {
  readonly layer: LayerRow;
  readonly entries: readonly Entry[];
}

/** Longer than any path stock takes: a container, a store, a transfer, a return… sixty-four times over is a loop. */
const MAX_DEPTH = 64;

async function entriesOf(tx: Tx, layer: LayerRow, used: Set<string>): Promise<Entry[]> {
  const departed = await departures.netDepartures(tx, layer.id);
  const left = layer.originalQuantity - layer.remainingQuantity;
  const accounted = departed.reduce((sum, row) => sum + row.quantity, 0n);
  if (accounted !== left) {
    throw new LandedCostError(
      `${formatQuantity(left)} of ${layer.itemCode} has left its layer in ${layer.warehouseCode}, and the movements that ` +
        `took it account for ${formatQuantity(accounted)}. Run the inventory integrity check before locking the landed cost.`,
    );
  }
  const entries: Entry[] = [];
  for (const { movement, quantity } of departed) {
    if (departures.isRelocation(movement.kind)) {
      for (const target of await departures.relocatedTo(tx, movement, layer, quantity, used)) {
        entries.push({ kind: 'follow', layerId: target.layerId, quantity: target.quantity });
      }
      continue;
    }
    let rest = quantity;
    for (const back of await departures.cameBackFor(tx, movement, quantity)) {
      entries.push({ kind: 'follow', layerId: back.layerId, quantity: back.quantity });
      rest -= back.quantity;
    }
    if (rest > 0n) entries.push({ kind: 'depart', movement, quantity: rest });
  }
  return entries;
}

/** Every layer the received stock reached, with what became of each layer's departed units. */
async function stockGraph(tx: Tx, received: readonly LayerRow[]): Promise<Map<string, GraphNode>> {
  const nodes = new Map<string, GraphNode>();
  const used = new Set<string>();
  let frontier: readonly LayerRow[] = received;
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth > MAX_DEPTH) {
      throw new LandedCostError(
        `The import's stock moved through more than ${MAX_DEPTH} layers in a chain, which no real movement does. ` +
          'The lock is refused; the stock ledger needs checking.',
      );
    }
    const next = new Set<string>();
    for (const layer of frontier) {
      if (nodes.has(layer.id)) continue;
      const entries = await entriesOf(tx, layer, used);
      nodes.set(layer.id, { layer, entries });
      for (const entry of entries) if (entry.kind === 'follow' && !nodes.has(entry.layerId)) next.add(entry.layerId);
    }
    const loaded = await layersByIds(tx, [...next]);
    frontier = [...next].map((id) => {
      const layer = loaded.get(id);
      if (!layer) throw new LandedCostError(`No cost layer '${id}'.`);
      return layer;
    });
  }
  return nodes;
}

interface LayerResult {
  readonly layer: LayerRow;
  readonly allocatedIqd: bigint;
  readonly inventoryIqd: bigint;
  /** What left from this layer for its departures' destinations (and rounding). */
  readonly cogsIqd: bigint;
  readonly unitCostAfter: bigint;
  readonly viaLayerId: string | null;
}

interface DepartureShare {
  readonly layer: LayerRow;
  readonly movement: departures.DepartedMovement;
  readonly quantity: bigint;
  readonly amountIqd: bigint;
}

interface RoundingShare {
  readonly layer: LayerRow;
  readonly amountIqd: bigint;
}

/**
 * The amounts through the graph, sources before the layers they feed (a
 * layer is restated once, with everything that reached it). For each layer:
 * what is still on hand restates its unit cost (`restate`); the rest is split
 * over its departed units by quantity, the remainder to the last — a share
 * that followed units goes on to their layer, a share of units gone is that
 * movement's; a residue with no units behind it is rounding.
 */
function flow(nodes: ReadonlyMap<string, GraphNode>, received: readonly LayerRow[], amounts: readonly bigint[]) {
  const amountIn = new Map<string, bigint>();
  received.forEach((layer, index) => amountIn.set(layer.id, (amountIn.get(layer.id) ?? 0n) + amounts[index]!));
  const incoming = new Map<string, number>();
  for (const node of nodes.values()) {
    for (const entry of node.entries) {
      if (entry.kind === 'follow') incoming.set(entry.layerId, (incoming.get(entry.layerId) ?? 0) + 1);
    }
  }
  const via = new Map<string, string>();
  const queue = [...nodes.keys()].filter((id) => !incoming.get(id));
  const results: LayerResult[] = [];
  const departed: DepartureShare[] = [];
  const rounding: RoundingShare[] = [];
  let processed = 0;

  while (queue.length > 0) {
    const id = queue.shift()!;
    const node = nodes.get(id)!;
    processed += 1;
    const amount = amountIn.get(id) ?? 0n;
    let inventory = 0n;
    let gone = 0n;
    let unitCostAfter = node.layer.unitCost;
    if (amount > 0n) {
      const own = restate(
        {
          originalQuantity: node.layer.originalQuantity,
          remainingQuantity: node.layer.remainingQuantity,
          unitCost: node.layer.unitCost,
        },
        amount,
      );
      inventory = own.inventoryIqd;
      unitCostAfter = own.unitCostAfter;
      if (own.goneIqd > 0n && node.entries.length === 0) {
        // Nothing left this layer: what restating could not put on the units
        // still in it is rounding.
        rounding.push({ layer: node.layer, amountIqd: own.goneIqd });
        gone += own.goneIqd;
      } else if (own.goneIqd > 0n) {
        const parts = spreadByWeights(own.goneIqd, node.entries.map((entry) => entry.quantity));
        node.entries.forEach((entry, index) => {
          const part = parts[index]!;
          if (entry.kind === 'follow') {
            amountIn.set(entry.layerId, (amountIn.get(entry.layerId) ?? 0n) + part);
            if (part > 0n && !via.has(entry.layerId)) via.set(entry.layerId, id);
          } else if (part > 0n) {
            departed.push({ layer: node.layer, movement: entry.movement, quantity: entry.quantity, amountIqd: part });
            gone += part;
          }
        });
      }
    }
    if (amount > 0n || received.some((layer) => layer.id === id)) {
      results.push({
        layer: node.layer,
        allocatedIqd: inventory + gone,
        inventoryIqd: inventory,
        cogsIqd: gone,
        unitCostAfter,
        viaLayerId: via.get(id) ?? null,
      });
    }
    for (const entry of node.entries) {
      if (entry.kind !== 'follow') continue;
      const left = (incoming.get(entry.layerId) ?? 0) - 1;
      incoming.set(entry.layerId, left);
      if (left === 0) queue.push(entry.layerId);
    }
  }
  if (processed !== nodes.size) {
    throw new LandedCostError("The import's stock moves in a circle through its layers; the lock is refused and the ledger needs checking.");
  }
  return { results, departed, rounding };
}

/** The dimensions of a destination line, keyed so equal destinations share one journal line. */
function normalised(dimensions: departures.DepartureDimensions, branchCode: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(dimensions).sort()) {
    const value = dimensions[key];
    if (value !== null && value !== undefined && value !== '') out[key] = value;
  }
  // One branch per journal (§14.3): the lock's.
  out.branch = branchCode;
  return out;
}

const dimensionKey = (dimensions: Readonly<Record<string, string>>) =>
  Object.keys(dimensions)
    .sort()
    .map((key) => `${key}=${dimensions[key]}`)
    .join('|');

export interface LockInput {
  readonly payableId: string;
  readonly basisCode?: string | null;
  readonly lockDate?: string | null;
  /** `manual` only: the amount each model carries, in IQD. */
  readonly manual?: ReadonlyMap<string, bigint>;
  readonly note?: string | null;
}

/** What a lock would do, without doing it — the allocation preview per model (§21.3). */
export async function preview(tx: Tx, input: LockInput) {
  const row = await importOf(tx, input.payableId);
  const charges = await unlockedCharges(tx, row.id);
  const total = charges.reduce((sum, charge) => sum + amountOf(charge.amountIqd), 0n);
  const layers = await receivedLayers(tx, row.id);
  const basis = await basisOf(tx, input.basisCode);
  const models = summarise(layers, total > 0n && layers.length > 0 ? safeAllocate(basis, total, layers, input.manual) : null);
  return { total: money(total), basis: basis, charges: charges.length, models };
}

function safeAllocate(basis: Basis, total: bigint, layers: readonly ReceivedLayer[], manual?: ReadonlyMap<string, bigint>) {
  try {
    return allocate(basis, total, layers, manual);
  } catch {
    return null;
  }
}

/**
 * What each model finally cost, once the charges are in it — by direction,
 * 2026-10-03: "where i can find final item cost please it should show final
 * item cost per quantity".
 *
 * Read, not recomputed. The layers carry what the import's goods cost now —
 * `lock` restates `unit_cost_iqd` in place — and
 * `landed_cost_layer_adjustment` carries what each lock added, which is the
 * difference between the invoice price and the cost the warehouse now holds.
 * Working it out a second time here would be a second arithmetic to keep in
 * step with the first.
 *
 * Empty until something is locked: before that the figure is a forecast, and
 * the preview above is where a forecast belongs.
 */
export async function finalCost(tx: Tx, payableId: string) {
  const layers = await receivedLayers(tx, payableId);
  if (layers.length === 0) return [];

  /*
   * What the goods cost before any charge was locked onto them — the
   * `unit_cost_before` of the *first* lock that touched each layer, ordered by
   * the lock's own sequence. Everything between that and what the layer costs
   * now is what the charges added, which is the figure being asked for.
   */
  const first = await tx.execute(sql`
    select a.cost_layer_id as "layerId",
           (array_agg(a.unit_cost_before order by k.sequence))[1] as "unitCostBefore"
      from landed_cost_layer_adjustment a
      join landed_cost_lock k on k.id = a.lock_id
     where a.cost_layer_id in (${sql.join(layers.map((layer) => sql`${layer.id}`), sql`, `)})
     group by a.cost_layer_id
  `);
  const byLayer = new Map(
    (first.rows as { layerId: string; unitCostBefore: string }[]).map((row) => [row.layerId, row]),
  );
  if (byLayer.size === 0) return [];

  const byModel = new Map<
    string,
    { quantity: bigint; onHand: bigint; invoiced: bigint; added: bigint; value: bigint }
  >();
  for (const layer of layers) {
    const row = byLayer.get(layer.id);
    const entry = byModel.get(layer.itemCode) ?? {
      quantity: 0n,
      onHand: 0n,
      invoiced: 0n,
      added: 0n,
      value: 0n,
    };
    const before = row ? amountOf(row.unitCostBefore) : layer.unitCost;
    entry.quantity += layer.originalQuantity;
    entry.onHand += layer.remainingQuantity;
    entry.invoiced += valueOf(layer.originalQuantity, before);
    entry.added += valueOf(layer.originalQuantity, layer.unitCost - before);
    // What the layer is worth now, which is what the Warehouses Report sums.
    entry.value += valueOf(layer.originalQuantity, layer.unitCost);
    byModel.set(layer.itemCode, entry);
  }

  return [...byModel.entries()]
    .map(([itemCode, entry]) => ({
      itemCode,
      receivedQty: formatQuantity(entry.quantity),
      onHandQty: formatQuantity(entry.onHand),
      /** What the supplier's invoice priced these units at, per unit. */
      invoicedUnitIqd: entry.quantity > 0n ? money((entry.invoiced * 1_000_000n) / entry.quantity) : '0',
      /** What freight, duty and clearance added, per unit. */
      chargesUnitIqd: entry.quantity > 0n ? money((entry.added * 1_000_000n) / entry.quantity) : '0',
      /** What one unit finally cost — the figure the warehouse holds. */
      finalUnitIqd: entry.quantity > 0n ? money((entry.value * 1_000_000n) / entry.quantity) : '0',
      chargesIqd: money(entry.added),
      finalValueIqd: money(entry.value),
    }))
    .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
}

function summarise(layers: readonly ReceivedLayer[], amounts: bigint[] | null) {
  const byModel = new Map<string, { quantity: bigint; value: bigint; onHand: bigint; allocated: bigint }>();
  layers.forEach((layer, index) => {
    const entry = byModel.get(layer.itemCode) ?? { quantity: 0n, value: 0n, onHand: 0n, allocated: 0n };
    entry.quantity += layer.originalQuantity;
    entry.value += valueOf(layer.originalQuantity, layer.unitCost);
    entry.onHand += layer.remainingQuantity;
    entry.allocated += amounts?.[index] ?? 0n;
    byModel.set(layer.itemCode, entry);
  });
  return [...byModel.entries()].map(([itemCode, entry]) => ({
    itemCode,
    receivedQty: formatQuantity(entry.quantity),
    onHandQty: formatQuantity(entry.onHand),
    valueIqd: money(entry.value),
    allocatedIqd: amounts ? money(entry.allocated) : null,
    // The unit cost the received units would carry with their share added.
    unitCostIqd: entry.quantity > 0n ? money((entry.value * 1_000_000n) / entry.quantity) : '0',
    unitCostAfterIqd:
      amounts && entry.quantity > 0n ? money(((entry.value + entry.allocated) * 1_000_000n) / entry.quantity) : null,
  }));
}

async function basisOf(tx: Tx, code: string | null | undefined): Promise<Basis> {
  const rows = await bases(tx);
  const chosen = code ? rows.find((row) => row.code === code) : rows.find((row) => row.isDefault);
  if (!chosen) throw new LandedCostError(`'${code}' is not an allocation basis.`);
  if (!chosen.active) throw new LandedCostError(`${chosen.name} is not offered yet.`);
  if (!(BASES as readonly string[]).includes(chosen.code)) {
    throw new LandedCostError(`${chosen.name} has no allocation this build can run.`);
  }
  return chosen.code as Basis;
}

/** Is the lock offered? §20.1 condition 3 — every standing PD totally written off. */
export async function lockable(tx: Tx, payableId: string) {
  const facts = await payables.gatherFacts(tx, payableId);
  const charges = await unlockedCharges(tx, payableId);
  const [last] = await tx
    .select({ sequence: landedCostLock.sequence })
    .from(landedCostLock)
    .where(eq(landedCostLock.payableId, payableId))
    .orderBy(desc(landedCostLock.sequence))
    .limit(1);
  return lockableState({
    allPdsWrittenOff: facts.allPdsWrittenOff,
    containersIn: facts.containerCount > 0 && facts.containersReceived === facts.containerCount,
    unlocked: charges.length,
    lastSequence: last?.sequence ?? null,
  });
}

/**
 * The lock's state from what a reader already holds — REQ-HARDEN-001 G3:
 * the payable record has the stage facts, the charges and the locks in hand,
 * and `lockable` would read all three again. One rule for both.
 */
export function lockableState(input: { allPdsWrittenOff: boolean; containersIn: boolean; unlocked: number; lastSequence: number | null }) {
  return {
    pdsWrittenOff: input.allPdsWrittenOff,
    /**
     * IM2-1 — every container received: the cost is spread over the layers the
     * receipts created, so a container still at sea would get no share of it.
     */
    containersIn: input.containersIn,
    ready: input.allPdsWrittenOff && input.containersIn,
    unlocked: input.unlocked,
    locked: input.lastSequence !== null,
    nextSequence: (input.lastSequence ?? 0) + 1,
  };
}

// ---------------------------------------------------------------------------
// §20.2 — lock (and every dated adjustment after it)
// ---------------------------------------------------------------------------

export async function lock(tx: Tx, ctx: ActorContext, input: LockInput) {
  const row = await importOf(tx, input.payableId, { lock: true });
  await authz.authorize(ctx.principal, 'post', PERMISSION_OBJECT, { branchCode: row.branchCode });
  const state = await lockable(tx, row.id);
  if (!state.pdsWrittenOff) {
    throw new LandedCostError(
      `${row.payableNo}'s landed cost is locked once every PD is totally written off (§20.1, condition 3).`,
    );
  }
  if (!state.containersIn) {
    throw new LandedCostError(
      `${row.payableNo}'s landed cost is locked once every container is received: it is spread over what the receipts brought in, ` +
        'and a container still to come would get no share of it.',
    );
  }
  const charges = await unlockedCharges(tx, row.id);
  if (charges.length === 0) {
    throw new LandedCostError(
      state.locked
        ? `Every charge of ${row.payableNo} is already in its landed cost; a later charge is allocated when it arrives.`
        : `${row.payableNo} has no charge to allocate yet.`,
    );
  }
  const lockDate = await lockDateFor(tx, row, input.lockDate);
  const total = charges.reduce((sum, charge) => sum + amountOf(charge.amountIqd), 0n);
  const basis = await basisOf(tx, input.basisCode);

  // The layers, locked before they are read: the received ones, then every
  // layer their stock reached — again until nothing new is reached.
  const locked = new Set<string>();
  await lockLayers(tx, await receivedLayers(tx, row.id), locked);
  let layers = await receivedLayers(tx, row.id);
  let graph = await stockGraph(tx, layers);
  for (let attempt = 0; await lockLayers(tx, [...graph.values()].map((node) => node.layer), locked); attempt += 1) {
    if (attempt >= 3) {
      throw new LandedCostError(`${row.payableNo}'s stock kept moving while the lock read it. Try the lock again.`);
    }
    layers = await receivedLayers(tx, row.id);
    graph = await stockGraph(tx, layers);
  }

  const amounts = allocate(basis, total, layers, input.manual);
  const { results, departed, rounding } = flow(graph, layers, amounts);
  const inventoryIqd = results.reduce((sum, r) => sum + r.inventoryIqd, 0n);
  const departedIqd = results.reduce((sum, r) => sum + r.cogsIqd, 0n);
  if (inventoryIqd + departedIqd !== total) {
    throw new LandedCostError(`The allocation does not add up: ${formatIqd(inventoryIqd + departedIqd)} of ${formatIqd(total)}.`);
  }

  // The accounts are the item's own (§3.3: a property of the record).
  const codes = [...new Set(results.map((r) => r.layer.itemCode))];
  const accounts = codes.length
    ? await tx
        .select({ code: item.code, inventory: item.inventoryAccountId, cogs: item.cogsAccountId })
        .from(item)
        .where(inArray(item.code, codes))
    : [];
  const accountOf = (code: string, which: 'inventory' | 'cogs') => {
    const found = accounts.find((a) => a.code === code)?.[which];
    if (!found) {
      throw new LandedCostError(
        `Item ${code} names no ${which === 'inventory' ? 'inventory' : 'cost of sales'} account; set it on the item first.`,
      );
    }
    return found;
  };

  // Where each departure's share goes — asked of the module whose event took
  // the units; a kind nobody answers for refuses the lock here, before
  // anything is written.
  const destinations = new Map<string, departures.DepartureDestination>();
  for (const share of departed) {
    if (share.movement.branchCode !== row.branchCode) {
      throw new LandedCostError(
        `${share.movement.itemCode} left ${share.movement.warehouseCode} in branch ${share.movement.branchCode}, and ` +
          `${row.payableNo} is ${row.branchCode}'s: a lock posts in one branch. The ledger needs checking.`,
      );
    }
    if (!destinations.has(share.movement.id)) {
      destinations.set(share.movement.id, await departures.destinationFor(tx, share.movement));
    }
  }
  // A rounding residue with no units behind it: the item's cost of sales, by
  // the branch and the import's own department.
  const roundingDimensions = { branch: row.branchCode, ...(row.departmentCode ? { department: row.departmentCode } : {}) };

  const criteria = { branchCode: row.branchCode };
  const stockLines = new Map<string, { accountId: string; warehouseCode: string; amount: bigint }>();
  for (const r of results) {
    if (r.inventoryIqd <= 0n) continue;
    const accountId = accountOf(r.layer.itemCode, 'inventory');
    const key = `${accountId}|${r.layer.warehouseCode}`;
    const entry = stockLines.get(key) ?? { accountId, warehouseCode: r.layer.warehouseCode, amount: 0n };
    entry.amount += r.inventoryIqd;
    stockLines.set(key, entry);
  }
  const destinationLines = new Map<string, { role: string; accountId: string; dimensions: Record<string, string>; amount: bigint }>();
  const addDestination = (role: string, accountId: string, dimensions: Record<string, string>, amount: bigint) => {
    const key = `${role}|${accountId}|${dimensionKey(dimensions)}`;
    const entry = destinationLines.get(key) ?? { role, accountId, dimensions, amount: 0n };
    entry.amount += amount;
    destinationLines.set(key, entry);
  };
  const departureRows = departed.map((share) => {
    const destination = destinations.get(share.movement.id)!;
    const dimensions = normalised(destination.dimensions, row.branchCode);
    addDestination(destination.role, destination.accountId, dimensions, share.amountIqd);
    return { share, destination, dimensions };
  });
  const roundingRows = rounding.map((share) => {
    const dimensions = normalised(roundingDimensions, row.branchCode);
    const accountId = accountOf(share.layer.itemCode, 'cogs');
    addDestination('cogs', accountId, dimensions, share.amountIqd);
    return { share, accountId, dimensions };
  });

  const lockId = randomUUID();
  const sequence = state.nextSequence;
  const reference = `${row.payableNo}/${sequence}`;
  const result = await posting.post(tx, ctx, {
    eventType: 'payables.landed_cost',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'payables', documentId: lockId, event: 'locked' },
    branchCode: row.branchCode,
    documentDate: lockDate,
    postingDate: lockDate,
    description: `${sequence === 1 ? 'Landed cost locked' : `Landed cost adjustment ${sequence}`} — ${row.payableNo}`,
    lines: [
      ...[...stockLines.values()].map((entry) => ({
        role: 'inventory',
        accountId: entry.accountId,
        debit: money(entry.amount),
        criteria: { ...criteria, warehouseCode: entry.warehouseCode },
        dimensions: { branch: row.branchCode, warehouse: entry.warehouseCode },
      })),
      // One debit per destination — the role, the account and the dimensions
      // the original posting used — carrying exactly what departed to it.
      ...[...destinationLines.values()].map((entry) => ({
        role: entry.role,
        accountId: entry.accountId,
        debit: money(entry.amount),
        criteria: {
          ...criteria,
          ...(entry.dimensions.warehouse ? { warehouseCode: entry.dimensions.warehouse } : {}),
          ...(entry.dimensions.project ? { projectCode: entry.dimensions.project } : {}),
        },
        dimensions: entry.dimensions,
      })),
      { role: 'landed_cost_clearing', credit: money(total), criteria, dimensions: { branch: row.branchCode } },
    ],
  });

  await tx.insert(landedCostLock).values({
    id: lockId,
    payableId: row.id,
    branchCode: row.branchCode,
    sequence,
    lockDate,
    basisCode: basis,
    totalIqd: money(total),
    inventoryIqd: money(inventoryIqd),
    // The column keeps its name (an applied column is not renamed): the part
    // that had already left stock, to every destination (0280).
    cogsIqd: money(departedIqd),
    journalEntryId: result.journalEntryId,
    note: input.note?.trim() || null,
    lockedBy: ctx.principal.userId,
  });

  for (const r of results) {
    if (r.allocatedIqd === 0n) continue;
    if (r.unitCostAfter !== r.layer.unitCost) {
      await tx.update(costLayer).set({ unitCostIqd: money(r.unitCostAfter) }).where(eq(costLayer.id, r.layer.id));
    }
    await tx.insert(landedCostLayerAdjustment).values({
      lockId,
      payableId: row.id,
      costLayerId: r.layer.id,
      itemCode: r.layer.itemCode,
      warehouseCode: r.layer.warehouseCode,
      allocatedIqd: money(r.allocatedIqd),
      onHandQty: formatQuantity(r.layer.remainingQuantity),
      unitCostBefore: money(r.layer.unitCost),
      unitCostAfter: money(r.unitCostAfter),
      inventoryIqd: money(r.inventoryIqd),
      // The departed part of this layer's share (every destination).
      cogsIqd: money(r.cogsIqd),
      viaLayerId: r.viaLayerId,
    });
  }

  // One row per lock × layer × departed movement, and one per rounding.
  const posted: { id: string; share: DepartureShare; destination: departures.DepartureDestination }[] = [];
  for (const { share, destination, dimensions } of departureRows) {
    const id = randomUUID();
    await tx.insert(landedCostDeparture).values({
      id,
      lockId,
      payableId: row.id,
      kind: 'departure',
      costLayerId: share.layer.id,
      movementId: share.movement.id,
      movementKind: share.movement.kind,
      sourceDocumentType: share.movement.sourceDocumentType,
      sourceDocumentId: share.movement.sourceDocumentId,
      sourceLineId: share.movement.sourceLineId,
      quantity: formatQuantity(share.quantity),
      amountIqd: money(share.amountIqd),
      destinationRole: destination.role,
      accountId: destination.accountId,
      dimensions,
      journalEntryId: result.journalEntryId,
      departedOn: share.movement.movementDate,
      createdBy: ctx.principal.userId,
    });
    posted.push({ id, share, destination });
  }
  for (const { share, accountId, dimensions } of roundingRows) {
    await tx.insert(landedCostDeparture).values({
      lockId,
      payableId: row.id,
      kind: 'rounding',
      costLayerId: share.layer.id,
      quantity: '0',
      amountIqd: money(share.amountIqd),
      destinationRole: 'cogs',
      accountId,
      dimensions,
      journalEntryId: result.journalEntryId,
      departedOn: lockDate,
      createdBy: ctx.principal.userId,
    });
  }

  await tx
    .update(landedCostCharge)
    .set({ lockId })
    .where(inArray(landedCostCharge.id, charges.map((charge) => charge.id)));

  // What went where, by role, for the story and the audit.
  const byRole = new Map<string, bigint>();
  for (const entry of destinationLines.values()) byRole.set(entry.role, (byRole.get(entry.role) ?? 0n) + entry.amount);
  const destinationsText = [...byRole.entries()].map(([role, amount]) => `${role.replace(/_/g, ' ')} ${formatIqd(amount)}`).join(', ');

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'LANDED_COST_LOCKED',
    summary:
      `${sequence === 1 ? 'Landed cost locked' : `Landed cost adjustment ${sequence}`}: ${formatIqd(total)} ` +
      `over ${charges.length} charge${charges.length === 1 ? '' : 's'}, ${basis.replace('_', ' ')} — ` +
      `${formatIqd(inventoryIqd)} into stock, ${formatIqd(departedIqd)} to the departed stock's destinations` +
      (destinationsText ? ` (${destinationsText})` : ''),
    sourceType: DOCUMENT_TYPE,
    sourceId: lockId,
    sourceNo: reference,
    after: {
      totalIqd: money(total),
      basis,
      inventoryIqd: money(inventoryIqd),
      cogsIqd: money(departedIqd),
      destinations: Object.fromEntries([...byRole.entries()].map(([role, amount]) => [role, money(amount)])),
    },
    actorUserId: ctx.principal.userId,
  });

  // ITEM_COST_ALLOCATED — per model, the unit cost its received stock now carries.
  for (const code of codes) {
    const mine = results.filter((r) => r.layer.itemCode === code && !r.viaLayerId);
    const received = mine.reduce((sum, r) => sum + r.layer.originalQuantity, 0n);
    const allocated = results.filter((r) => r.layer.itemCode === code).reduce((sum, r) => sum + r.allocatedIqd, 0n);
    const onHand = mine.filter((r) => r.layer.remainingQuantity > 0n);
    const unit = onHand[0]?.unitCostAfter ?? mine[0]?.unitCostAfter ?? 0n;
    await events.record(tx, {
      payableId: row.id,
      eventCode: 'ITEM_COST_ALLOCATED',
      summary:
        `${code}: ${formatIqd(allocated)} allocated over ${formatQuantity(received)} received; ` +
        `unit cost now ${formatIqd(unit)}`,
      sourceType: DOCUMENT_TYPE,
      sourceId: lockId,
      sourceNo: reference,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'landed_cost.locked',
    objectType: PERMISSION_OBJECT,
    objectId: lockId,
    branchCode: row.branchCode,
    after: {
      payableNo: row.payableNo,
      sequence,
      basis,
      lockDate,
      totalIqd: money(total),
      inventoryIqd: money(inventoryIqd),
      cogsIqd: money(departedIqd),
      departures: departureRows.length,
      rounding: roundingRows.length,
      destinations: Object.fromEntries([...byRole.entries()].map(([role, amount]) => [role, money(amount)])),
      journalEntryId: result.journalEntryId,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  // The modules that keep an analysis beside the ledger (a project's cost
  // rows) write it now, in this transaction, against the posted journal.
  for (const entry of posted) {
    await entry.destination.afterPosting?.(tx, ctx, {
      departureId: entry.id,
      lockId,
      reference,
      payableId: row.id,
      journalEntryId: result.journalEntryId,
      postedOn: lockDate,
      movement: entry.share.movement,
      quantity: entry.share.quantity,
      amountIqd: entry.share.amountIqd,
    });
  }

  return {
    id: lockId,
    sequence,
    totalIqd: money(total),
    inventoryIqd: money(inventoryIqd),
    cogsIqd: money(departedIqd),
    journalEntryId: result.journalEntryId,
  };
}

/**
 * The day a lock is dated, checked: not in the future (a cost is locked on a
 * day that has come), not before the import's previous lock (a dated
 * adjustment follows the lock it adjusts), and not before the last container
 * was received (the cost lands on goods that have arrived).
 */
async function lockDateFor(tx: Tx, row: { id: string; payableNo: string }, requested: string | null | undefined): Promise<string> {
  const today = businessToday();
  const lockDate = requested?.trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lockDate)) throw new LandedCostError(`'${lockDate}' is not a date.`);
  if (lockDate > today) {
    throw new LandedCostError(`A landed cost is locked on a day that has come: ${lockDate} is after today, ${today}.`);
  }
  const [previous] = await tx
    .select({ sequence: landedCostLock.sequence, lockDate: landedCostLock.lockDate })
    .from(landedCostLock)
    .where(eq(landedCostLock.payableId, row.id))
    .orderBy(desc(landedCostLock.lockDate), desc(landedCostLock.sequence))
    .limit(1);
  if (previous && lockDate < previous.lockDate) {
    throw new LandedCostError(
      `${row.payableNo}/${previous.sequence} is dated ${previous.lockDate}; a later lock of the same import cannot be dated ` +
        `before it (${lockDate}).`,
    );
  }
  const received = await tx.execute(sql`
    select max(m.movement_date)::text as "receivedOn"
      from inventory_movement m
      join container_receipt r on r.id::text = m.source_document_id
     where m.source_document_type = 'container_receipt'
       and r.payable_id = ${row.id}`);
  const receivedOn = (received.rows as { receivedOn: string | null }[])[0]?.receivedOn ?? null;
  if (receivedOn && lockDate < receivedOn) {
    throw new LandedCostError(
      `${row.payableNo}'s last container was received on ${receivedOn}; its landed cost is locked on or after the day ` +
        `the goods arrived, not ${lockDate}.`,
    );
  }
  return lockDate;
}

/**
 * Where every dinar that did not stay in stock went, lock by lock — the
 * departure and rounding rows with the movement and document behind each,
 * for the Final Cost section.
 */
export async function departuresFor(tx: Tx, payableId: string) {
  const result = await tx.execute(sql`
    select d.id, d.lock_id as "lockId", k.sequence, k.lock_date::text as "lockDate", d.kind,
           d.cost_layer_id as "costLayerId", cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode",
           d.movement_id as "movementId", d.movement_kind as "movementKind",
           m.movement_date::text as "movementDate", m.warehouse_code as "movementWarehouseCode",
           d.source_document_type as "sourceDocumentType", d.source_document_id as "sourceDocumentId",
           d.source_line_id as "sourceLineId", d.quantity::text as quantity, d.amount_iqd::text as "amountIqd",
           d.destination_role as "destinationRole", d.account_id as "accountId", a.code as "accountCode",
           a.name as "accountName", d.dimensions, j.entry_no as "entryNo", d.departed_on::text as "departedOn",
           d.returns_departure_id as "returnsDepartureId", d.to_layer_id as "toLayerId"
      from landed_cost_departure d
      join landed_cost_lock k on k.id = d.lock_id
      join cost_layer cl on cl.id = d.cost_layer_id
      join chart_of_account a on a.id = d.account_id
      join journal_entry j on j.id = d.journal_entry_id
      left join inventory_movement m on m.id = d.movement_id
     where d.payable_id = ${payableId}
     order by k.sequence, cl.item_code, d.created_at, d.id`);
  const rows = result.rows as unknown as {
    id: string;
    lockId: string;
    sequence: number;
    lockDate: string;
    kind: 'departure' | 'return' | 'rounding';
    costLayerId: string;
    itemCode: string;
    warehouseCode: string;
    movementId: string | null;
    movementKind: string | null;
    movementDate: string | null;
    movementWarehouseCode: string | null;
    sourceDocumentType: string | null;
    sourceDocumentId: string | null;
    sourceLineId: string | null;
    quantity: string;
    amountIqd: string;
    destinationRole: string;
    accountId: string;
    accountCode: string;
    accountName: string;
    dimensions: Record<string, string | null>;
    entryNo: string;
    departedOn: string;
    returnsDepartureId: string | null;
    toLayerId: string | null;
  }[];
  // The document's own name, as its module gives it (the registry), where one is registered.
  const out = [];
  for (const row of rows) {
    const movement = row.movementId ? await departures.departedMovement(tx, row.movementId) : null;
    out.push({ ...row, documentLabel: movement ? await departures.labelFor(tx, movement) : null });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §20.2 — a charge from a posted journal (and `other`, with its reason)
// ---------------------------------------------------------------------------

export interface AddChargeInput {
  readonly payableId: string;
  readonly chargeTypeCode: string;
  readonly journalEntryNo: string;
  readonly amountIqd: bigint;
  readonly reason?: string | null;
  readonly note?: string | null;
}

export async function addCharge(tx: Tx, ctx: ActorContext, input: AddChargeInput) {
  const row = await importOf(tx, input.payableId);
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: row.branchCode });
  const [type] = await tx.select().from(landedCostType).where(eq(landedCostType.code, input.chargeTypeCode)).limit(1);
  if (!type || !type.active) throw new LandedCostError(`'${input.chargeTypeCode}' is not a charge type.`);
  if (NOT_ALLOCATED.has(type.code)) {
    throw new LandedCostError(`${type.name} is the goods themselves, recorded by the payment — not a charge.`);
  }
  const reason = input.reason?.trim() ?? '';
  if (type.code === 'other' && !reason) throw new LandedCostError('Say what an "other" charge is.');
  if (input.amountIqd <= 0n) throw new LandedCostError('State the amount of the charge.');
  const entryNo = input.journalEntryNo.trim();
  if (!entryNo) throw new LandedCostError('Name the posted journal that carries the cost (§20.2: charges come from documents).');
  const [journal] = await tx
    .select({ id: journalEntry.id, entryNo: journalEntry.entryNo, status: journalEntry.status })
    .from(journalEntry)
    .where(eq(journalEntry.entryNo, entryNo))
    .limit(1);
  if (!journal) throw new LandedCostError(`No journal ${entryNo}.`);
  if (journal.status !== 'posted') throw new LandedCostError(`${entryNo} is ${journal.status}; only a posted journal carries a cost.`);

  const [created] = await tx
    .insert(landedCostCharge)
    .values({
      payableId: row.id,
      chargeTypeCode: type.code,
      amountTxn: money(input.amountIqd),
      currency: 'IQD',
      amountIqd: money(input.amountIqd),
      sourceType: JOURNAL_SOURCE,
      // One journal may carry costs of several imports: one charge per import.
      sourceId: `${journal.id}/${row.id}`,
      sourceNo: journal.entryNo,
      reason: reason || null,
      note: input.note?.trim() || null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: landedCostCharge.id });

  const locked = await lockable(tx, row.id);
  await events.record(tx, {
    payableId: row.id,
    eventCode: 'CHARGE_RECORDED',
    summary:
      `${type.name} ${formatIqd(input.amountIqd)} charged to this import from its journal${reason ? ` — ${reason}` : ''}` +
      (locked.locked ? '; the cost is locked, so this goes into a dated adjustment' : ''),
    sourceType: 'landed_cost_charge',
    sourceId: created!.id,
    sourceNo: journal.entryNo,
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'landed_cost.charge_added',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: row.branchCode,
    after: { payableNo: row.payableNo, type: type.code, amountIqd: money(input.amountIqd), journal: journal.entryNo },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { id: created!.id };
}

/** A journal charge not yet locked may be withdrawn, with a reason. */
export async function cancelCharge(tx: Tx, ctx: ActorContext, chargeId: string, reason: string) {
  const [charge] = await tx.select().from(landedCostCharge).where(eq(landedCostCharge.id, chargeId)).limit(1);
  if (!charge) throw new LandedCostError('No such charge.');
  const row = await importOf(tx, charge.payableId);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, { branchCode: row.branchCode });
  if (charge.lockId) throw new LandedCostError('A locked charge is part of the cost; a correction is a new, dated charge.');
  if (charge.cancelledAt) throw new LandedCostError('That charge is already withdrawn.');
  if (charge.sourceType !== JOURNAL_SOURCE) {
    throw new LandedCostError('This charge belongs to its document; reverse the document to withdraw it.');
  }
  const text = reason?.trim() ?? '';
  if (!text) throw new LandedCostError('Say why the charge is withdrawn.');
  await tx
    .update(landedCostCharge)
    .set({ cancelledAt: new Date(), cancelledBy: ctx.principal.userId, cancelReason: text })
    .where(eq(landedCostCharge.id, charge.id));
  await events.record(tx, {
    payableId: row.id,
    eventCode: 'CORRECTION',
    summary: `Charge from journal ${charge.sourceNo} (${formatIqd(amountOf(charge.amountIqd))}) withdrawn: ${text}`,
    sourceType: 'landed_cost_charge',
    sourceId: charge.id,
    sourceNo: charge.sourceNo,
    actorUserId: ctx.principal.userId,
  });
}

/** The models received on the import, for the manual basis's rows. */
export async function receivedModels(tx: Tx, payableId: string) {
  const layers = await receivedLayers(tx, payableId);
  return [...new Set(layers.map((layer) => layer.itemCode))];
}
