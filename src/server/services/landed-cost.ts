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
  valueOf,
  type Basis,
} from '../domain/landed-cost';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as payables from './payables';
import * as posting from './posting';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'landed_cost';
const DOCUMENT_TYPE = 'landed_cost_lock';
const JOURNAL_SOURCE = 'journal_entry';
const MAX_HOPS = 6;

const money = (value: bigint) => toDecimalString(value, MONEY_SCALE);
const amountOf = (value: string | null | undefined) => parseDecimal(value ?? '0', MONEY_SCALE);
const today = () => businessToday();

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

interface ReceivedLayer {
  readonly id: string;
  readonly itemCode: string;
  readonly warehouseCode: string;
  readonly originalQuantity: bigint;
  readonly remainingQuantity: bigint;
  readonly unitCost: bigint;
}

/** The FIFO layers the import's container receipts created (§18). */
async function receivedLayers(tx: Tx, payableId: string): Promise<ReceivedLayer[]> {
  const result = await tx.execute(sql`
    select cl.id, cl.item_code as "itemCode", cl.warehouse_code as "warehouseCode",
           cl.original_quantity::text as "originalQuantity", cl.remaining_quantity::text as "remainingQuantity",
           cl.unit_cost_iqd::text as "unitCost"
      from cost_layer cl
      join inventory_movement m on m.id = cl.created_by_movement_id
      join container_receipt r on r.id::text = m.source_document_id
     where m.source_document_type = 'container_receipt'
       and m.kind = 'transfer_receipt'
       and r.payable_id = ${payableId}
     order by cl.item_code, cl.layer_date, cl.sequence`);
  return (
    result.rows as {
      id: string;
      itemCode: string;
      warehouseCode: string;
      originalQuantity: string;
      remainingQuantity: string;
      unitCost: string;
    }[]
  ).map((row) => ({
    id: row.id,
    itemCode: row.itemCode,
    warehouseCode: row.warehouseCode,
    originalQuantity: parseQuantity(row.originalQuantity),
    remainingQuantity: parseQuantity(row.remainingQuantity),
    unitCost: amountOf(row.unitCost),
  }));
}

async function layerOf(tx: Tx, id: string): Promise<ReceivedLayer> {
  const [row] = await tx.select().from(costLayer).where(eq(costLayer.id, id)).limit(1);
  if (!row) throw new LandedCostError(`No cost layer '${id}'.`);
  return {
    id: row.id,
    itemCode: row.itemCode,
    warehouseCode: row.warehouseCode,
    originalQuantity: parseQuantity(row.originalQuantity),
    remainingQuantity: parseQuantity(row.remainingQuantity),
    unitCost: amountOf(row.unitCostIqd),
  };
}

/**
 * Where the stock that left a layer went: each issue that took from it, and
 * for a transfer the layer the same quantity arrived in (the receipt of the
 * same document line, same item, same quantity — how `inventory.relocate`
 * and the stock transfer write the pair).
 */
async function departures(tx: Tx, layerId: string, used: Set<string>) {
  const result = await tx.execute(sql`
    select m.id, m.kind::text as kind, m.item_code as "itemCode",
           m.source_document_type as "sourceType", m.source_document_id as "sourceId",
           coalesce(m.source_line_id, '') as "sourceLine", m.created_at as "createdAt",
           sum(c.quantity)::text as quantity
      from cost_layer_consumption c
      join inventory_movement m on m.id = c.movement_id
     where c.layer_id = ${layerId}
     group by m.id
    having sum(c.quantity) > 0
     order by m.created_at, m.id`);
  const rows = result.rows as {
    id: string;
    kind: string;
    itemCode: string;
    sourceType: string | null;
    sourceId: string | null;
    sourceLine: string;
    createdAt: Date;
    quantity: string;
  }[];
  const out: { quantity: bigint; toLayerId: string | null }[] = [];
  for (const row of rows) {
    const quantity = parseQuantity(row.quantity);
    let toLayerId: string | null = null;
    if (row.kind === 'transfer_issue' && row.sourceId) {
      const candidates = await tx.execute(sql`
        select cl.id
          from inventory_movement r
          join cost_layer cl on cl.created_by_movement_id = r.id
         where r.kind = 'transfer_receipt'
           and r.item_code = ${row.itemCode}
           and r.source_document_type is not distinct from ${row.sourceType}
           and r.source_document_id = ${row.sourceId}
           and coalesce(r.source_line_id, '') = ${row.sourceLine}
           and r.quantity = ${formatQuantity(quantity)}::numeric
           and r.created_at >= ${row.createdAt}
         order by r.created_at, r.id`);
      const match = (candidates.rows as { id: string }[]).find((candidate) => !used.has(candidate.id));
      if (match) {
        used.add(match.id);
        toLayerId = match.id;
      }
    }
    out.push({ quantity, toLayerId });
  }
  return out;
}

interface LayerResult {
  readonly layer: ReceivedLayer;
  readonly allocatedIqd: bigint;
  readonly inventoryIqd: bigint;
  readonly cogsIqd: bigint;
  readonly unitCostAfter: bigint;
  readonly viaLayerId: string | null;
}

/**
 * Gives `amount` to a layer: what is on hand stays (restated); what left with
 * a transfer follows it; what left any other way is cost of sales.
 */
async function distribute(
  tx: Tx,
  layer: ReceivedLayer,
  amount: bigint,
  via: string | null,
  used: Set<string>,
  hops: number,
  out: LayerResult[],
): Promise<void> {
  const own = restate(
    { originalQuantity: layer.originalQuantity, remainingQuantity: layer.remainingQuantity, unitCost: layer.unitCost },
    amount,
  );
  let gone = own.goneIqd;
  let cogs = 0n;
  const left = layer.originalQuantity - layer.remainingQuantity;
  if (gone > 0n && left > 0n && hops < MAX_HOPS) {
    const moved = await departures(tx, layer.id, used);
    const total = moved.reduce((sum, row) => sum + row.quantity, 0n);
    let given = 0n;
    for (const [index, departure] of moved.entries()) {
      const share = index === moved.length - 1 ? gone - given : (gone * departure.quantity) / (total > 0n ? total : 1n);
      given += share;
      if (departure.toLayerId) {
        await distribute(tx, await layerOf(tx, departure.toLayerId), share, layer.id, used, hops + 1, out);
      } else {
        cogs += share;
      }
    }
    gone = 0n;
  }
  cogs += gone;
  out.push({
    layer,
    allocatedIqd: own.inventoryIqd + cogs,
    inventoryIqd: own.inventoryIqd,
    cogsIqd: cogs,
    unitCostAfter: own.unitCostAfter,
    viaLayerId: via,
  });
}

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
  return {
    pdsWrittenOff: facts.allPdsWrittenOff,
    unlocked: charges.length,
    locked: Boolean(last),
    nextSequence: (last?.sequence ?? 0) + 1,
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
  const charges = await unlockedCharges(tx, row.id);
  if (charges.length === 0) {
    throw new LandedCostError(
      state.locked
        ? `Every charge of ${row.payableNo} is already in its landed cost; a later charge is allocated when it arrives.`
        : `${row.payableNo} has no charge to allocate yet.`,
    );
  }
  const total = charges.reduce((sum, charge) => sum + amountOf(charge.amountIqd), 0n);
  const basis = await basisOf(tx, input.basisCode);
  const layers = await receivedLayers(tx, row.id);
  const amounts = allocate(basis, total, layers, input.manual);
  const lockDate = input.lockDate || today();

  const results: LayerResult[] = [];
  const used = new Set<string>();
  for (const [index, layer] of layers.entries()) {
    await distribute(tx, layer, amounts[index]!, null, used, 0, results);
  }
  const inventoryIqd = results.reduce((sum, r) => sum + r.inventoryIqd, 0n);
  const cogsIqd = results.reduce((sum, r) => sum + r.cogsIqd, 0n);
  if (inventoryIqd + cogsIqd !== total) {
    throw new LandedCostError(`The allocation does not add up: ${formatIqd(inventoryIqd + cogsIqd)} of ${formatIqd(total)}.`);
  }

  // The accounts are the item's own (§3.3: a property of the record).
  const codes = [...new Set(results.map((r) => r.layer.itemCode))];
  const accounts = await tx
    .select({ code: item.code, inventory: item.inventoryAccountId, cogs: item.cogsAccountId })
    .from(item)
    .where(inArray(item.code, codes));
  const accountOf = (code: string, which: 'inventory' | 'cogs') => {
    const found = accounts.find((a) => a.code === code)?.[which];
    if (!found) {
      throw new LandedCostError(
        `Item ${code} names no ${which === 'inventory' ? 'inventory' : 'cost of sales'} account; set it on the item first.`,
      );
    }
    return found;
  };

  const criteria = { branchCode: row.branchCode };
  const debit = new Map<string, { role: 'inventory' | 'cogs'; accountId: string; warehouseCode: string | null; amount: bigint }>();
  for (const r of results) {
    if (r.inventoryIqd > 0n) {
      const key = `inventory|${accountOf(r.layer.itemCode, 'inventory')}|${r.layer.warehouseCode}`;
      const entry = debit.get(key) ?? {
        role: 'inventory' as const,
        accountId: accountOf(r.layer.itemCode, 'inventory'),
        warehouseCode: r.layer.warehouseCode,
        amount: 0n,
      };
      entry.amount += r.inventoryIqd;
      debit.set(key, entry);
    }
    if (r.cogsIqd > 0n) {
      const key = `cogs|${accountOf(r.layer.itemCode, 'cogs')}`;
      const entry = debit.get(key) ?? { role: 'cogs' as const, accountId: accountOf(r.layer.itemCode, 'cogs'), warehouseCode: null, amount: 0n };
      entry.amount += r.cogsIqd;
      debit.set(key, entry);
    }
  }

  const lockId = randomUUID();
  const sequence = state.nextSequence;
  const result = await posting.post(tx, ctx, {
    eventType: 'payables.landed_cost',
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'payables', documentId: lockId, event: 'locked' },
    branchCode: row.branchCode,
    documentDate: lockDate,
    postingDate: lockDate,
    description: `${sequence === 1 ? 'Landed cost locked' : `Landed cost adjustment ${sequence}`} — ${row.payableNo}`,
    lines: [
      ...[...debit.values()].map((entry) => ({
        role: entry.role,
        accountId: entry.accountId,
        debit: money(entry.amount),
        criteria: entry.warehouseCode ? { ...criteria, warehouseCode: entry.warehouseCode } : criteria,
        dimensions: entry.warehouseCode
          ? { branch: row.branchCode, warehouse: entry.warehouseCode }
          : { branch: row.branchCode },
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
    cogsIqd: money(cogsIqd),
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
      cogsIqd: money(r.cogsIqd),
      viaLayerId: r.viaLayerId,
    });
  }

  await tx
    .update(landedCostCharge)
    .set({ lockId })
    .where(inArray(landedCostCharge.id, charges.map((charge) => charge.id)));

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'LANDED_COST_LOCKED',
    summary:
      `${sequence === 1 ? 'Landed cost locked' : `Landed cost adjustment ${sequence}`}: ${formatIqd(total)} ` +
      `over ${charges.length} charge${charges.length === 1 ? '' : 's'}, ${basis.replace('_', ' ')} — ` +
      `${formatIqd(inventoryIqd)} into stock, ${formatIqd(cogsIqd)} to cost of sales`,
    sourceType: DOCUMENT_TYPE,
    sourceId: lockId,
    sourceNo: `${row.payableNo}/${sequence}`,
    after: { totalIqd: money(total), basis, inventoryIqd: money(inventoryIqd), cogsIqd: money(cogsIqd) },
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
      sourceNo: `${row.payableNo}/${sequence}`,
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
      cogsIqd: money(cogsIqd),
      journalEntryId: result.journalEntryId,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: lockId, sequence, totalIqd: money(total), inventoryIqd: money(inventoryIqd), cogsIqd: money(cogsIqd), journalEntryId: result.journalEntryId };
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
