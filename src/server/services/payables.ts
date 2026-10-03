/**
 * Payables — REQ-AP-001 Stage 1, the record everything else hangs off.
 *
 * One record per thing the company has to pay, of a configured type. The
 * type's controls are enforced at creation (R1, §5.3): no goods without a
 * purchase order — the PI *is* the order, created and **submitted** through
 * the existing PO service in the same transaction; no service without the
 * benefiting department; one payable per supplier reference and type.
 *
 * ── Why the PO is submitted here and approved elsewhere ────────────────────
 * §14 of the requirement says "created … and approved"; §5.2 of the blueprint
 * says the person who raised a purchase order cannot approve it, and the PO
 * service enforces that. The blueprint wins: the payable's transaction
 * creates and submits the order, and approval stays a second person's act in
 * the approvals flow. Stage 1 needs the order to exist, not to be approved.
 *
 * ── The stage ───────────────────────────────────────────────────────────────
 * Derived, never typed (§6, R2). `recomputeStage` gathers the lane facts the
 * current build can know — Stage 1: the linked invoices — derives, and logs
 * `STAGE_CHANGED` when the answer moved. Later build stages extend the fact
 * gathering; the rails and rules do not change shape.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  branch,
  businessPartner,
  expenseCategory,
  goodsReceipt,
  payable,
  payableHold,
  payableOrderLine,
  payableStage,
  payableType,
  savedView,
  serviceReceipt,
  supplierAdvance,
  warehouse,
} from '../db/schema';
import {
  NO_FACTS,
  PayableValidationError,
  STAGE_RULES,
  deriveStage,
  referenceKey,
  type StageFacts,
  type StageRow,
} from '../domain/payables';
import { MONEY_SCALE, parseDecimal, say, toDecimalString } from '../domain/money';
import { totals as paymentTotalsOf } from '../domain/payment-applications';
import { formatQuantity, parseQuantity } from '../domain/uom';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import { can } from '../domain/permissions';
import * as notifications from './notifications';
import * as events from './payable-events';
import * as purchaseOrders from './purchase-order';
import * as rateService from './exchange-rates';
import { allocateDocumentNumber } from './numbering';
import * as execution from './project-execution';
import * as units from './item-units';

export const PERMISSION_OBJECT = 'payable';
export const SETTINGS_OBJECT = 'payables_settings';

export class PayableNotFoundError extends Error {
  readonly code = 'PAYABLE_NOT_FOUND';
  constructor(ref: string) {
    super(`No payable '${ref}', or it is outside the branches you may see.`);
    this.name = 'PayableNotFoundError';
  }
}

export class DuplicateReferenceError extends Error {
  readonly code = 'PAYABLE_DUPLICATE_REFERENCE';
  constructor(reference: string, existingNo: string) {
    super(
      `${reference} is already open as ${existingNo} for this supplier. One import, one record (R1) — ` +
        'open that payable and update it, or use a different reference for a genuinely different purchase.',
    );
    this.name = 'DuplicateReferenceError';
  }
}

export class PayableStateError extends Error {
  readonly code = 'PAYABLE_STATE';
  constructor(payableNo: string, detail: string) {
    super(`${payableNo}: ${detail}`);
    this.name = 'PayableStateError';
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export async function typeOf(tx: Tx, code: string) {
  const [row] = await tx
    .select()
    .from(payableType)
    .where(eq(payableType.code, code))
    .limit(1);
  if (!row) {
    throw new PayableValidationError('type', `'${code}' is not a payable type.`);
  }
  return row;
}

/** A type's rail, for derivation and for the stage rail on screen. */
export async function railFor(tx: Tx, typeCode: string): Promise<StageRow[]> {
  const rows = await tx
    .select({
      code: payableStage.code,
      sequence: payableStage.sequence,
      ruleName: payableStage.ruleName,
      active: payableStage.active,
      name: payableStage.name,
      isTerminalMark: payableStage.isTerminalMark,
    })
    .from(payableStage)
    .where(eq(payableStage.payableTypeCode, typeCode))
    .orderBy(asc(payableStage.sequence));
  return rows;
}

export async function load(tx: Tx, id: string) {
  const [row] = await tx.select().from(payable).where(eq(payable.id, id)).limit(1);
  if (!row) throw new PayableNotFoundError(id);
  return row;
}

/**
 * HD9 — the payable locked for a write that depends on what it holds (the
 * landed-cost lock, a stage recompute, a transition of one of its children).
 * Two such writes then run one after the other.
 */
export async function lock(tx: Tx, id: string) {
  const [row] = await tx.select().from(payable).where(eq(payable.id, id)).for('update');
  if (!row) throw new PayableNotFoundError(id);
  return row;
}

export async function loadByNo(tx: Tx, payableNo: string) {
  const [row] = await tx
    .select()
    .from(payable)
    .where(eq(payable.payableNo, payableNo))
    .limit(1);
  if (!row) throw new PayableNotFoundError(payableNo);
  return row;
}

// ---------------------------------------------------------------------------
// §6 — the stage, recomputed in the transaction of every event
// ---------------------------------------------------------------------------

/**
 * Supplier payments made straight against the import's invoices — on the
 * Supplier Payments screen, not through a payment application. They pay the
 * import as surely as an application does, so they count towards *paid*,
 * *fully paid* and the cap on new applications (otherwise the import could
 * be paid twice). A payment an application confirmed is the application's,
 * counted there once. In the import's currency: dinars as allocated; another
 * currency in the share of the payment's own amount the allocation is.
 */
export async function directPayments(
  tx: Tx,
  payableId: string,
): Promise<{ status: 'confirmed'; amountTxn: bigint; amountIqd: bigint; paymentNo: string }[]> {
  const result = await tx.execute(sql`
    select p.payment_no as "paymentNo", a.amount_iqd::text as "allocIqd", p.amount_iqd::text as "paymentIqd",
           p.amount_txn::text as "paymentTxn", p.currency, pb.currency as "importCurrency"
      from supplier_payment_allocation a
      join supplier_payment p on p.id = a.supplier_payment_id
      join ap_invoice i on i.id = a.ap_invoice_id
      join payable pb on pb.id = i.payable_id
     where i.payable_id = ${payableId} and i.reversed_at is null
       and a.reversed_at is null and p.reversed_at is null and p.status = 'posted'
       and not exists (select 1 from payment_application pa where pa.supplier_payment_id = p.id)`);
  return (
    result.rows as { paymentNo: string; allocIqd: string; paymentIqd: string; paymentTxn: string | null; currency: string; importCurrency: string }[]
  ).map((row) => {
    const allocIqd = parseDecimal(row.allocIqd, MONEY_SCALE);
    const paymentIqd = parseDecimal(row.paymentIqd, MONEY_SCALE);
    let amountTxn = 0n;
    if (row.importCurrency === 'IQD') amountTxn = allocIqd;
    else if (row.currency === row.importCurrency && row.paymentTxn && paymentIqd > 0n) {
      // Half up, at the money scale: the allocation's share of the payment.
      const paymentTxn = parseDecimal(row.paymentTxn, MONEY_SCALE);
      amountTxn = (allocIqd * paymentTxn * 2n + paymentIqd) / (paymentIqd * 2n);
    }
    return { status: 'confirmed' as const, amountTxn, amountIqd: allocIqd, paymentNo: row.paymentNo };
  });
}

/**
 * Where the import's goods stand, item by item, in base units (§17–§18):
 * what the posted invoices bought, what the containers plan, what arrived in
 * good order, damaged or short, what went back to the supplier as a claim,
 * and what is still in transit. *In transit* is the invoices' own layers in a
 * transit warehouse — the goods are owned and not yet received or returned.
 * `transitEver` is false for an import whose invoice booked its goods
 * straight into a warehouse (before the transit rule), which then clears on
 * the received quantity alone.
 */
export interface QuantityLine {
  readonly itemCode: string;
  readonly itemName: string | null;
  readonly ordered: bigint;
  readonly planned: bigint;
  readonly received: bigint;
  readonly damaged: bigint;
  readonly short: bigint;
  readonly claimed: bigint;
  readonly inTransit: bigint;
  /** Ordered less what the live containers plan: still to be loaded (a balance shipment). */
  readonly notYetShipped: bigint;
}

/** One unit at the quantity scale (6). */
const ONE_UNIT = 1_000_000n;

export async function quantityPosition(tx: Tx, payableId: string): Promise<{ lines: QuantityLine[]; transitEver: boolean }> {
  const result = await tx.execute(sql`
    with inv_lines as (
      select l.id, l.item_code, l.quantity, l.uom_code
        from ap_invoice_line l join ap_invoice i on i.id = l.ap_invoice_id
       where i.payable_id = ${payableId} and i.reversed_at is null
         and i.status in ('posted', 'partially_executed', 'settled') and l.item_code is not null
    ), layers as (
      select cl.item_code, sum(cl.remaining_quantity) as remaining, sum(cl.original_quantity) as original
        from cost_layer cl
        join inventory_movement m on m.id = cl.created_by_movement_id
        join warehouse w on w.code = cl.warehouse_code
       where (w.is_transit or w.shipment_stage is not null)
         and m.source_line_id::text in (select id::text from inv_lines)
       group by cl.item_code
    ), plan as (
      select cl.item_code, cl.uom_code, coalesce(sum(cl.planned_qty), 0) as planned, coalesce(sum(cl.received_qty), 0) as received,
             coalesce(sum(cl.damaged_qty), 0) as damaged, coalesce(sum(cl.short_qty), 0) as short
        from shipment_container_line cl join shipment_container c on c.id = cl.container_id
       where c.payable_id = ${payableId} and c.cancelled_at is null and cl.superseded_at is null and cl.item_code is not null
       group by cl.item_code, cl.uom_code
    ), moved as (
      select rl.item_code, sum(rl.moved_qty) as moved
        from container_receipt_line rl join container_receipt r on r.id = rl.receipt_id
       where r.payable_id = ${payableId}
       group by rl.item_code
    ), claims as (
      select gl.item_code, gl.uom_code, sum(gl.quantity) as claimed
        from goods_return_line gl join goods_return g on g.id = gl.goods_return_id
       where g.status <> 'cancelled' and gl.ap_invoice_line_id in (select id from inv_lines)
       group by gl.item_code, gl.uom_code
    )
    select x.code as "itemCode", it.name as "itemName",
           (select coalesce(json_agg(json_build_object('q', il.quantity::text, 'u', il.uom_code)), '[]') from inv_lines il where il.item_code = x.code) as ordered,
           (select coalesce(json_agg(json_build_object('p', p.planned::text, 'r', p.received::text, 'd', p.damaged::text, 's', p.short::text, 'u', p.uom_code)), '[]') from plan p where p.item_code = x.code) as plan,
           (select coalesce(json_agg(json_build_object('q', c.claimed::text, 'u', c.uom_code)), '[]') from claims c where c.item_code = x.code) as claims,
           coalesce((select m.moved::text from moved m where m.item_code = x.code), '0') as moved,
           coalesce((select l.remaining::text from layers l where l.item_code = x.code), '0') as "inTransit",
           coalesce((select l.original::text from layers l where l.item_code = x.code), '0') as "transitOriginal"
      from (select item_code as code from inv_lines union select item_code from plan) x
      left join item it on it.code = x.code
     order by x.code`);
  const lines: QuantityLine[] = [];
  let transitEver = false;
  // One conversion per item and unit, however many lines name it.
  const conversions = new Map<string, Promise<bigint>>();
  const factor = (itemCode: string, uom: string) => {
    const key = `${itemCode}\u0000${uom}`;
    if (!conversions.has(key)) conversions.set(key, units.toBaseQuantity(tx, itemCode, uom, ONE_UNIT));
    return conversions.get(key)!;
  };
  for (const row of result.rows as {
    itemCode: string;
    itemName: string | null;
    ordered: { q: string; u: string | null }[];
    plan: { p: string; r: string; d: string; s: string; u: string | null }[];
    claims: { q: string; u: string | null }[];
    moved: string;
    inTransit: string;
    transitOriginal: string;
  }[]) {
    // Base units: a whole number of the line's unit times its factor (FIX-4).
    const base = async (quantity: string, uom: string | null) =>
      uom ? (parseQuantity(quantity) * (await factor(row.itemCode, uom))) / ONE_UNIT : parseQuantity(quantity);
    let ordered = 0n;
    for (const line of row.ordered) ordered += await base(line.q, line.u);
    let planned = 0n;
    let damaged = 0n;
    let short = 0n;
    for (const line of row.plan) {
      planned += await base(line.p, line.u);
      damaged += await base(line.d, line.u);
      short += await base(line.s, line.u);
    }
    let claimed = 0n;
    for (const line of row.claims) claimed += await base(line.q, line.u);
    if (parseQuantity(row.transitOriginal) > 0n) transitEver = true;
    lines.push({
      itemCode: row.itemCode,
      itemName: row.itemName,
      ordered,
      planned,
      received: parseQuantity(row.moved),
      damaged,
      short,
      claimed,
      inTransit: parseQuantity(row.inTransit),
      notYetShipped: ordered > planned ? ordered - planned : 0n,
    });
  }
  return { lines, transitEver };
}

/**
 * The lane facts this build can know. Stage 1 reads the order lane — the
 * linked invoices; every later lane's facts stay at their empty value until
 * its build stage lands, which is R2 applied to the build itself.
 */
export async function gatherFacts(tx: Tx, payableId: string): Promise<StageFacts> {
  const row = await load(tx, payableId);

  const [invoices] = await tx
    .select({
      posted: sql<number>`count(*) filter (where ${apInvoice.status} in ('posted','partially_executed','settled'))::int`,
      approved: sql<number>`count(*) filter (where ${apInvoice.status} in ('approved','posted','partially_executed','settled'))::int`,
    })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), isNull(apInvoice.reversedAt)));

  // Service lane (build Stage 2) — an approved confirmation of this payable.
  const [confirmation] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(serviceReceipt)
    .where(and(eq(serviceReceipt.payableId, payableId), eq(serviceReceipt.status, 'approved')));
  const serviceConfirmed = (confirmation?.n ?? 0) > 0;

  // D8 — a generated period under an auto-confirm contract confirmed itself;
  // the PERIOD_AUTO_CONFIRMED event in the log is the record of it.
  const [autoConfirmed] = row.recurringContractId
    ? await tx.execute(sql`
        select count(*)::int as n from payable_event
         where payable_id = ${payableId} and event_code = 'PERIOD_AUTO_CONFIRMED'`)
        .then((r) => r.rows as { n: number }[])
    : [{ n: 0 }];

  // Warehouse lane (§11) — a posted goods receipt against this payable's order.
  const [received] = row.purchaseOrderId
    ? await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(goodsReceipt)
        .where(
          and(
            eq(goodsReceipt.purchaseOrderId, row.purchaseOrderId),
            inArray(goodsReceipt.status, ['posted', 'executed', 'partially_executed']),
            isNull(goodsReceipt.reversedAt),
          ),
        )
    : [{ n: 0 }];

  // Advance type (§12) — the linked supplier advance's own lifecycle.
  const [advance] = await tx
    .select({ status: supplierAdvance.status })
    .from(supplierAdvance)
    .where(and(eq(supplierAdvance.payableId, payableId), isNull(supplierAdvance.reversedAt)))
    .orderBy(desc(supplierAdvance.createdAt))
    .limit(1);

  // Payment lane (build Stage 3, §15) — the instalment plan and the payment
  // applications. Read here rather than through the payment-applications
  // service, which itself records events through this module.
  const planned = await tx.execute(sql`
    select id from payable_instalment
     where payable_id = ${payableId} and superseded_at is null
     order by sequence`);
  const instalmentIds = (planned.rows as { id: string }[]).map((r) => r.id);
  const applied = await tx.execute(sql`
    select status, instalment_id as "instalmentId", amount_txn::text as "amountTxn",
           amount_iqd::text as "amountIqd"
      from payment_application where payable_id = ${payableId}`);
  const applications = (
    applied.rows as { status: string; instalmentId: string | null; amountTxn: string; amountIqd: string }[]
  ).filter((a) => a.status !== 'rejected' && a.status !== 'cancelled');
  const direct = await directPayments(tx, payableId);
  const paymentTotals = paymentTotalsOf(parseDecimal(row.amountTxn, MONEY_SCALE), [
    ...applications.map((a) => ({
      status: a.status,
      amountTxn: parseDecimal(a.amountTxn, MONEY_SCALE),
      amountIqd: parseDecimal(a.amountIqd, MONEY_SCALE),
    })),
    ...direct,
  ]);
  const paidApplications = applications.filter((a) => a.status === 'confirmed' || a.status === 'debited');

  // PD lane (build Stage 4, §16) — the standing registrations: not
  // superseded by a re-registration. Live = not rejected, not expired.
  const pdRows = await tx.execute(sql`
    select d.status_code as "statusCode", s.is_expired as "isExpired",
           exists (select 1 from customs_pd n where n.supersedes_pd_id = d.id) as superseded
      from customs_pd d join pd_status s on s.code = d.status_code
     where d.payable_id = ${payableId}`);
  const standingPds = (
    pdRows.rows as { statusCode: string; isExpired: boolean; superseded: boolean }[]
  ).filter((pd) => !pd.superseded);
  const livePdCount = standingPds.filter((pd) => !pd.isExpired && pd.statusCode !== 'rejected').length;
  const allPdsWrittenOff =
    standingPds.length > 0 && standingPds.every((pd) => pd.statusCode === 'totally_written_off');

  // Shipment and warehouse lanes (build Stage 5, §17-§18) — every container
  // on its own: Y is the live containers, X those that count as received;
  // the received quantity is Σ received over the container lines (§18).
  const shipped = await tx.execute(sql`
    select count(*)::int as total,
           (count(*) filter (where s.counts_as_received))::int as received,
           (select coalesce(sum(l.received_qty), 0)::text
              from shipment_container_line l join shipment_container c2 on c2.id = l.container_id
             where c2.payable_id = ${payableId} and c2.cancelled_at is null and l.superseded_at is null) as "receivedQty",
           (select count(*)::int from container_receipt r where r.payable_id = ${payableId}) as receipts
      from shipment_container c join container_status s on s.code = c.status_code
     where c.payable_id = ${payableId} and c.cancelled_at is null`);
  const shipment = shipped.rows[0] as { total: number; received: number; receivedQty: string; receipts: number };
  // Everything the invoices bought is accounted for: received in good order,
  // or settled with the supplier as a claim (a goods return from transit) —
  // nothing of it left in transit (IM2-1). An import whose invoice booked its
  // goods straight into a warehouse compares the received quantity, as before.
  const position = shipment.total > 0 ? await quantityPosition(tx, payableId) : { lines: [], transitEver: false };
  const nothingInTransit = position.lines.every((line) => line.inTransit === 0n);
  const receivedQuantityMatches = position.transitEver
    ? nothingInTransit && position.lines.some((line) => line.received > 0n)
    : row.quantity !== null && parseQuantity(shipment.receivedQty) === parseQuantity(row.quantity);
  // A PD that expired part written off is done once the shortage that left it
  // part-used is settled: nothing is left in transit to clear against it.
  const pdsDone =
    standingPds.length > 0 &&
    standingPds.every(
      (pd) => pd.statusCode === 'totally_written_off' || (pd.statusCode === 'expired_part_written_off' && position.transitEver && nothingInTransit),
    );

  return {
    ...NO_FACTS,
    containerCount: shipment.total,
    containersReceived: shipment.received,
    receivedQuantityMatches,
    livePdCount,
    allPdsWrittenOff: allPdsWrittenOff || pdsDone,
    instalmentPlanSet: instalmentIds.length > 0,
    liveApplicationCount: applications.filter((a) => a.status !== 'draft').length,
    firstInstalmentFunded:
      instalmentIds.length > 0 &&
      applications.some((a) => a.instalmentId === instalmentIds[0] && a.status !== 'draft'),
    paymentSentCount: applications.filter((a) => ['sent', 'confirmed', 'debited'].includes(a.status)).length,
    fullyPaid: paymentTotals.fullyPaid,
    allPaymentsConfirmed:
      (paidApplications.length > 0 || direct.length > 0) &&
      applications.every((a) => a.status === 'confirmed' || a.status === 'debited'),
    statementMatched: paidApplications.length > 0 && paidApplications.every((a) => a.status === 'debited'),
    postedInvoiceCount: invoices?.posted ?? 0,
    approvedInvoiceCount: invoices?.approved ?? 0,
    serviceConfirmed: serviceConfirmed || (autoConfirmed?.n ?? 0) > 0,
    recurringConfirmed: serviceConfirmed || (autoConfirmed?.n ?? 0) > 0,
    goodsReceiptPosted: (received?.n ?? 0) > 0 || shipment.receipts > 0,
    advanceApproved: Boolean(advance && advance.status !== 'draft'),
    advancePaid: Boolean(
      advance && ['posted', 'partially_executed', 'settled', 'closed'].includes(advance.status),
    ),
    advanceSettled: Boolean(advance && ['settled', 'closed'].includes(advance.status)),
  };
}

/** Recomputes the stage; logs `STAGE_CHANGED` when it moved. */
export async function recomputeStage(
  tx: Tx,
  payableId: string,
  actorUserId: string | null,
): Promise<{ stageCode: string; changed: boolean }> {
  // HD9 — recomputed under the row lock: two children finishing at once
  // derive the stage one after the other, from facts that include each other.
  const row = await lock(tx, payableId);
  const rail = await railFor(tx, row.payableTypeCode);
  const facts = await gatherFacts(tx, payableId);
  const next = deriveStage(rail, facts);

  if (next !== row.stageCode) {
    const from = rail.find((s) => s.code === row.stageCode);
    const to = rail.find((s) => s.code === next);

    await tx
      .update(payable)
      .set({ stageCode: next, stageSince: new Date(), updatedAt: new Date() })
      .where(eq(payable.id, payableId));

    const leftName = (from as { name?: string })?.name ?? row.stageCode;
    const reachedName = (to as { name?: string })?.name ?? next;

    await events.record(tx, {
      payableId,
      eventCode: 'STAGE_CHANGED',
      summary: `Stage: ${leftName} → ${reachedName}`,
      before: { stage: row.stageCode },
      after: { stage: next },
      actorUserId,
    });

    // The stage is the one fact that says where an import has got to, and an
    // import runs for weeks; until now the move was written to this log and
    // nobody was told (2026-10-03).
    //
    // The occurrence is the stage reached, so every stage the document arrives
    // at is announced once and a recompute that lands where it already was
    // says nothing.
    await notifications.raise(
      tx,
      {
        eventType: 'payable.stage.changed',
        objectType: 'payable',
        objectId: payableId,
        occurrence: next,
      },
      { payableNo: row.payableNo, stage: reachedName, previousStage: leftName },
      { branchCode: row.branchCode, actorUserId },
    );
  }

  await clearOrReopen(tx, row, rail, facts, next, actorUserId);
  return { stageCode: next, changed: next !== row.stageCode };
}

/**
 * §20.1 — the orange band. An import is cleared by nobody: in the same
 * transaction as the event that satisfies the last of the three conditions
 * (supplier fully paid and every application confirmed; every container
 * received in full; every PD totally written off) it is stamped `closed_at`
 * and `CLEARED` is written. When a condition later stops holding — an invoice
 * reversed, a quantity corrected — it is re-opened with `CORRECTION` naming
 * what no longer holds; the clearing stays in its story, never erased.
 */
async function clearOrReopen(
  tx: Tx,
  row: { id: string; payableNo: string; closedAt: Date | null; cancelledAt: Date | null },
  rail: readonly StageRow[],
  facts: StageFacts,
  stageCode: string,
  actorUserId: string | null,
): Promise<void> {
  const clearedStage = rail.find((stage) => stage.ruleName === 'import_cleared' && stage.active);
  if (!clearedStage || row.cancelledAt) return;
  const cleared = stageCode === clearedStage.code;

  if (cleared && !row.closedAt) {
    await tx.update(payable).set({ closedAt: new Date(), updatedAt: new Date() }).where(eq(payable.id, row.id));
    await events.record(tx, {
      payableId: row.id,
      eventCode: 'CLEARED',
      summary:
        `${row.payableNo} cleared: the supplier is fully paid and every payment confirmed, every container ` +
        'is received in full, every PD is totally written off',
      after: { closedAt: new Date().toISOString() },
      actorUserId,
    });
    return;
  }

  if (!cleared && row.closedAt) {
    const missing = [
      !(facts.fullyPaid && facts.allPaymentsConfirmed) ? 'the supplier is no longer fully paid' : null,
      !(facts.containerCount > 0 && facts.containersReceived === facts.containerCount && facts.receivedQuantityMatches)
        ? 'the received quantity no longer matches the invoice'
        : null,
      !facts.allPdsWrittenOff ? 'a PD is no longer totally written off' : null,
    ].filter(Boolean);
    await tx.update(payable).set({ closedAt: null, updatedAt: new Date() }).where(eq(payable.id, row.id));
    await events.record(tx, {
      payableId: row.id,
      eventCode: 'CORRECTION',
      summary: `${row.payableNo} re-opened: ${missing.join('; ') || 'a clearing condition no longer holds'}`,
      before: { closedAt: row.closedAt.toISOString() },
      after: { closedAt: null },
      actorUserId,
    });
  }
}

// ---------------------------------------------------------------------------
// §19.1 — the lane guard: a pending-reason hold blocks its lane
// ---------------------------------------------------------------------------

export class LaneHeldError extends Error {
  readonly code = 'PAYABLE_LANE_HELD';
  constructor(payableNo: string, laneCode: string) {
    super(
      `${payableNo} is over its time limit in the ${laneCode} lane and the stop has no reason yet. ` +
        'Complete the hold — reason, owner, next action — before changing anything in this lane. ' +
        'A manager may override with a reason.',
    );
    this.name = 'LaneHeldError';
  }
}

/**
 * §19.1 — while an automatic hold waits for its reason, the lane is
 * read-only. A manager (the reverse_cancel grant, the module's strongest)
 * may override with a reason, and the override is an event.
 */
export async function assertLaneEditable(
  tx: Tx,
  ctx: ActorContext,
  row: { id: string; payableNo: string },
  laneCode: string,
  override?: { reason: string } | null,
): Promise<void> {
  const [pending] = await tx
    .select({ id: payableHold.id })
    .from(payableHold)
    .where(
      and(
        eq(payableHold.payableId, row.id),
        eq(payableHold.status, 'open'),
        eq(payableHold.reasonCode, 'PENDING_REASON'),
        eq(payableHold.laneCode, laneCode),
      ),
    )
    .limit(1);

  if (!pending) return;

  const isManager = can(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT);
  if (override?.reason?.trim() && isManager) {
    await events.record(tx, {
      payableId: row.id,
      eventCode: 'HOLD_UPDATED',
      summary: `Lane ${laneCode} edited under override: ${override.reason.trim()}`,
      holdId: pending.id,
      actorUserId: ctx.principal.userId,
    });
    return;
  }

  throw new LaneHeldError(row.payableNo, laneCode);
}

// ---------------------------------------------------------------------------
// Creation (§5.1, §14)
// ---------------------------------------------------------------------------

export interface PayableLineInput {
  readonly itemCode?: string | null;
  readonly expenseCategoryCode?: string | null;
  readonly description: string;
  /** Decimal strings, as typed. */
  readonly quantity?: string | null;
  readonly uomCode?: string | null;
  readonly unitPrice?: string | null;
}

export interface CreatePayableInput {
  readonly payableTypeCode: string;
  readonly supplierReference: string;
  readonly supplierId: string;
  readonly branchCode: string;
  readonly departmentCode?: string | null;
  readonly currency: string;
  readonly documentDate: string;
  readonly description: string;
  readonly paymentTermsText?: string | null;
  readonly expenseCategoryCode?: string | null;
  /** Typed when there are no lines (a quote, a contract amount). */
  readonly amountTxn?: string | null;
  readonly dueDate?: string | null;
  readonly lines?: readonly PayableLineInput[];
  /** Link an existing approved order instead of creating one from the lines. */
  readonly purchaseOrderId?: string | null;
  /** REQ-PM-001 §8 — the project, the element and the cost code the payable is assigned to; the three together, or none. */
  readonly projectCode?: string | null;
  readonly wbsCode?: string | null;
  readonly costCode?: string | null;
  /** Where goods-type order lines are ordered to; defaults to the branch's first main warehouse. */
  readonly defaultWarehouseCode?: string | null;
}

async function defaultWarehouse(tx: Tx, branchCode: string): Promise<string> {
  const [row] = await tx
    .select({ code: warehouse.code })
    .from(warehouse)
    .where(
      and(
        eq(warehouse.branchCode, branchCode),
        eq(warehouse.active, true),
        eq(warehouse.warehouseType, 'main'),
      ),
    )
    .orderBy(asc(warehouse.code))
    .limit(1);
  if (!row) {
    throw new PayableValidationError(
      'warehouse',
      `branch ${branchCode} has no active main warehouse to order goods to. ` +
        'Create one under Master Data → Warehouses first.',
    );
  }
  return row.code;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreatePayableInput,
): Promise<{ id: string; payableNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  const type = await typeOf(tx, input.payableTypeCode);
  if (!type.active) {
    throw new PayableValidationError('type', `${type.name} is deactivated.`);
  }

  if (type.requiresDepartment && !input.departmentCode) {
    throw new PayableValidationError(
      'department',
      `a ${type.name} payable names the benefiting department — the people who confirm it was delivered (§5.3).`,
    );
  }

  const key = referenceKey(input.supplierReference);

  const [existing] = await tx
    .select({ payableNo: payable.payableNo })
    .from(payable)
    .where(
      and(
        eq(payable.supplierId, input.supplierId),
        eq(payable.payableTypeCode, type.code),
        eq(payable.supplierReferenceKey, key),
      ),
    )
    .limit(1);
  if (existing) throw new DuplicateReferenceError(input.supplierReference, existing.payableNo);

  const [supplier] = await tx
    .select({ id: businessPartner.id, name: businessPartner.legalName, isSupplier: businessPartner.isSupplier })
    .from(businessPartner)
    .where(eq(businessPartner.id, input.supplierId))
    .limit(1);
  if (!supplier) throw new PayableValidationError('supplier', 'no such business partner.');
  if (!supplier.isSupplier) {
    throw new PayableValidationError(
      'supplier',
      `${supplier.name} does not hold the Supplier role. Grant it on the partner record first.`,
    );
  }

  const lines = input.lines ?? [];

  // The amount: the lines when they carry prices, the typed figure otherwise.
  let amountTxn = 0n;
  let quantity = 0n;
  let hasQuantity = false;
  for (const line of lines) {
    if (line.quantity) {
      // REQ-FIX-001 FIX-4 — the quantity the Cleared rule compares the
      // received containers against is counted in the items' base units.
      quantity += line.itemCode && line.uomCode ? await units.toBaseQuantity(tx, line.itemCode, line.uomCode, parseQuantity(line.quantity)) : parseQuantity(line.quantity);
      hasQuantity = true;
      if (line.unitPrice) {
        // quantity × price at MONEY_SCALE — the same arithmetic the PI shows.
        const q = parseQuantity(line.quantity);
        const p = parseDecimal(line.unitPrice, MONEY_SCALE);
        amountTxn += (q * p) / 10n ** 6n;
      }
    }
  }
  if (amountTxn === 0n && input.amountTxn) {
    amountTxn = parseDecimal(input.amountTxn, MONEY_SCALE);
  }

  const converted = await rateService.convertOn(tx, amountTxn, input.currency, input.documentDate);

  // ── The order control (§5.3, §14) ─────────────────────────────────────────
  let purchaseOrderId = input.purchaseOrderId ?? null;
  let orderNo: string | null = null;
  if (type.requiresPo) {
    if (purchaseOrderId) {
      const order = await purchaseOrders.view(tx, purchaseOrderId);
      if (!order) throw new PayableValidationError('purchase_order', 'no such purchase order.');
      if (order.order.supplierId !== input.supplierId) {
        throw new PayableValidationError(
          'purchase_order',
          `${order.order.orderNo} belongs to a different supplier. The payable and its order name one supplier (R1).`,
        );
      }
      orderNo = order.order.orderNo;
    } else {
      if (lines.length === 0) {
        throw new PayableValidationError(
          'lines',
          `a ${type.name} payable needs the PI's model lines — they become the purchase order (§14).`,
        );
      }
      const warehouseCode = input.defaultWarehouseCode ?? (await defaultWarehouse(tx, input.branchCode));
      const orderLines = [];
      for (const line of lines) {
        const unitPriceIqd = line.unitPrice
          ? (
              await rateService.convertOn(
                tx,
                parseDecimal(line.unitPrice, MONEY_SCALE),
                input.currency,
                input.documentDate,
              )
            ).amountIqd
          : 0n;
        orderLines.push({
          lineType: line.itemCode ? ('inventory_item' as const) : ('service' as const),
          itemCode: line.itemCode ?? null,
          description: line.description,
          quantity: line.quantity ? parseQuantity(line.quantity) : 1_000_000n,
          // REQ-FIX-001 FIX-4 — one of the item's units (its purchase default
          // when none is named); a service line keeps what it was given.
          uomCode: line.itemCode ? await units.assertLineUnit(tx, line.itemCode, line.uomCode ?? (await units.purchaseDefaultOf(tx, line.itemCode))) : (line.uomCode ?? 'EA'),
          unitPriceIqd,
          branchCode: input.branchCode,
          warehouseCode: line.itemCode ? warehouseCode : null,
        });
      }
      const created = await purchaseOrders.create(tx, ctx, {
        supplierId: input.supplierId,
        branchCode: input.branchCode,
        orderDate: input.documentDate,
        currency: input.currency,
        reference: input.supplierReference,
        note: `Raised from payable (${type.name}) — the PI is the company's order (REQ-AP-001 §14).`,
        // REQ-PM-001 §8 — the order carries the assignment; its approval commits.
        projectCode: input.projectCode ?? null,
        wbsCode: input.wbsCode ?? null,
        costCode: input.costCode ?? null,
        lines: orderLines,
      });
      // §5.2 — submitted here; approved by a second person in the approvals
      // flow. Stage 1 needs the order to exist, not to be approved.
      await purchaseOrders.submit(tx, ctx, created.id);
      purchaseOrderId = created.id;
      orderNo = created.orderNo;
    }
  }

  // REQ-PM-001 §8 — checked before the number is spent.
  const assignment = await execution.checkAssignment(tx, input);

  const year = Number(input.documentDate.slice(0, 4));
  const allocated = await allocateDocumentNumber(
    tx,
    type.numberSeriesKey,
    { branchCode: input.branchCode, year },
    ctx.principal.userId,
  );

  const rail = await railFor(tx, type.code);
  const stageCode = deriveStage(rail, NO_FACTS);

  const [created] = await tx
    .insert(payable)
    .values({
      payableNo: allocated.documentNo,
      payableTypeCode: type.code,
      supplierReference: input.supplierReference.trim(),
      supplierReferenceKey: key,
      supplierId: input.supplierId,
      branchCode: input.branchCode,
      departmentCode: input.departmentCode ?? null,
      currency: input.currency,
      amountTxn: toDecimalString(amountTxn),
      amountIqd: toDecimalString(converted.amountIqd),
      quantity: hasQuantity ? formatQuantity(quantity) : null,
      documentDate: input.documentDate,
      description: input.description.trim(),
      paymentTermsText: input.paymentTermsText?.trim() || null,
      purchaseOrderId,
      expenseCategoryCode: input.expenseCategoryCode ?? null,
      dueDate: input.dueDate ?? null,
      projectCode: assignment?.projectCode ?? null,
      wbsCode: assignment?.wbsCode ?? null,
      costCode: assignment?.costCode ?? null,
      stageCode,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: payable.id });

  const payableId = created!.id;

  for (const [index, line] of lines.entries()) {
    await tx.insert(payableOrderLine).values({
      payableId,
      lineNo: index + 1,
      itemCode: line.itemCode ?? null,
      expenseCategoryCode: line.expenseCategoryCode ?? null,
      description: line.description,
      quantity: line.quantity ? formatQuantity(parseQuantity(line.quantity)) : null,
      uomCode: line.itemCode && line.uomCode ? await units.assertLineUnit(tx, line.itemCode, line.uomCode) : (line.uomCode ?? null),
      unitPrice: line.unitPrice ? toDecimalString(parseDecimal(line.unitPrice, MONEY_SCALE)) : null,
      amountTxn:
        line.quantity && line.unitPrice
          ? toDecimalString(
              (parseQuantity(line.quantity) * parseDecimal(line.unitPrice, MONEY_SCALE)) /
                10n ** 6n,
            )
          : null,
    });
  }

  await events.record(tx, {
    payableId,
    eventCode: 'PAYABLE_OPENED',
    summary: `${type.name} opened — ${input.supplierReference.trim()}, ${supplier.name}, ${say(toDecimalString(amountTxn), input.currency)}`,
    after: { payableNo: allocated.documentNo, reference: input.supplierReference.trim() },
    actorUserId: ctx.principal.userId,
  });

  if (lines.length > 0) {
    await events.record(tx, {
      payableId,
      eventCode: 'PI_RECORDED',
      summary: `${lines.length} line(s) recorded${hasQuantity ? `, quantity ${formatQuantity(quantity)}` : ''}`,
      actorUserId: ctx.principal.userId,
    });
  }

  if (purchaseOrderId) {
    await events.record(tx, {
      payableId,
      eventCode: 'PO_LINKED',
      summary: input.purchaseOrderId
        ? `Purchase order ${orderNo} linked`
        : `Purchase order ${orderNo} created from the PI lines and submitted for approval`,
      sourceType: 'purchase_order',
      sourceId: purchaseOrderId,
      sourceNo: orderNo,
      actorUserId: ctx.principal.userId,
    });
  }

  if (input.paymentTermsText?.trim()) {
    await events.record(tx, {
      payableId,
      eventCode: 'TERMS_SET',
      summary: `Terms: ${input.paymentTermsText.trim()}`,
      actorUserId: ctx.principal.userId,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.created',
    objectType: PERMISSION_OBJECT,
    objectId: payableId,
    branchCode: input.branchCode,
    after: { payableNo: allocated.documentNo, type: type.code, reference: key },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  // REQ-PM-001 §8 — a payable without an order is the promise itself.
  if (!purchaseOrderId && assignment) await execution.commitForPayable(tx, ctx, payableId);

  return { id: payableId, payableNo: allocated.documentNo };
}

// ---------------------------------------------------------------------------
// The order lane after creation
// ---------------------------------------------------------------------------

/** Links an existing invoice of the same supplier (§14 "Purchase invoice"). */
/**
 * The open imports a new purchase invoice ticked *Import* may belong to
 * instead of opening one of its own — chiefly the imports migrated from the
 * sheet (§24.3), whose supplier invoice is entered after the cut-over. Those
 * with no live invoice yet come first.
 */
export async function openImportsForInvoice(tx: Tx) {
  const result = await tx.execute(sql`
    select p.id, p.payable_no as "payableNo", p.supplier_reference as "reference",
           bp.legal_name as "supplierName", p.supplier_id as "supplierId",
           exists (select 1 from ap_invoice i where i.payable_id = p.id and i.reversed_at is null) as "invoiced"
      from payable p
      join business_partner bp on bp.id = p.supplier_id
     where p.payable_type_code = 'import' and p.cancelled_at is null and p.closed_at is null
     order by "invoiced", p.payable_no desc`);
  return result.rows as unknown as {
    id: string;
    payableNo: string;
    reference: string;
    supplierName: string;
    supplierId: string;
    invoiced: boolean;
  }[];
}

export async function linkInvoice(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; apInvoiceId: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  await assertLaneEditable(tx, ctx, row, 'order');
  assertOpen(row);

  const [invoice] = await tx
    .select()
    .from(apInvoice)
    .where(eq(apInvoice.id, input.apInvoiceId))
    .limit(1);
  if (!invoice) throw new PayableValidationError('invoice', 'no such purchase invoice.');
  if (invoice.supplierId !== row.supplierId) {
    throw new PayableValidationError(
      'invoice',
      `${invoice.invoiceNo} belongs to a different supplier than ${row.payableNo}.`,
    );
  }
  if (invoice.payableId && invoice.payableId !== row.id) {
    throw new PayableValidationError(
      'invoice',
      `${invoice.invoiceNo} already belongs to another payable — one invoice, one payable (§5.1).`,
    );
  }

  await tx
    .update(apInvoice)
    .set({ payableId: row.id, updatedAt: new Date() })
    .where(eq(apInvoice.id, invoice.id));

  const posted = ['posted', 'partially_executed', 'settled'].includes(invoice.status);
  await events.record(tx, {
    payableId: row.id,
    eventCode: posted ? 'INVOICE_POSTED' : 'FIELD_CHANGED',
    summary: posted
      ? `Purchase invoice ${invoice.invoiceNo} linked — ${invoice.currency} ${invoice.totalIqd} IQD posted`
      : `Purchase invoice ${invoice.invoiceNo} (${invoice.status}) linked`,
    sourceType: 'ap_invoice',
    sourceId: invoice.id,
    sourceNo: invoice.invoiceNo,
    actorUserId: ctx.principal.userId,
  });

  await refreshFromInvoices(tx, row.id);
  await recomputeStage(tx, row.id, ctx.principal.userId);
}

/**
 * Called by the invoice service when a linked invoice posts, approves or
 * reverses — the order lane's share of "records everything" (§7.2).
 */
export async function onInvoiceEvent(
  tx: Tx,
  input: {
    payableId: string;
    eventCode: 'INVOICE_POSTED' | 'INVOICE_APPROVED' | 'INVOICE_REVERSED';
    invoiceId: string;
    invoiceNo: string;
    summary: string;
    actorUserId: string | null;
  },
): Promise<void> {
  await events.record(tx, {
    payableId: input.payableId,
    eventCode: input.eventCode,
    summary: input.summary,
    sourceType: 'ap_invoice',
    sourceId: input.invoiceId,
    sourceNo: input.invoiceNo,
    actorUserId: input.actorUserId,
  });
  await refreshFromInvoices(tx, input.payableId);
  await recomputeStage(tx, input.payableId, input.actorUserId);
}

/**
 * A9 — "did we actually get it?" before "pay it".
 *
 * The invoice posting calls this for a payable-linked invoice. A service or
 * recurring payable must show its confirmation — an approved service receipt,
 * or the period's own auto-confirmation (D8) — unless the expense category
 * says none is expected (`requires_receipt = false`), in which case the
 * approver is shown the note instead of a demand. Goods payables answer to
 * the goods receipt, not to a service confirmation.
 */
export async function assertReceiptEvidence(
  tx: Tx,
  payableId: string,
): Promise<{ required: boolean; note?: string }> {
  const [row] = await tx
    .select({
      payableNo: payable.payableNo,
      typeCode: payable.payableTypeCode,
      categoryCode: payable.expenseCategoryCode,
      categoryName: expenseCategory.name,
      requiresReceipt: expenseCategory.requiresReceipt,
    })
    .from(payable)
    .leftJoin(expenseCategory, eq(expenseCategory.code, payable.expenseCategoryCode))
    .where(eq(payable.id, payableId))
    .limit(1);
  if (!row) throw new PayableValidationError('payable', 'no such payable.');

  if (row.typeCode !== 'service' && row.typeCode !== 'recurring') {
    return {
      required: false,
      note: 'A goods payable answers to the goods receipt, not a service confirmation.',
    };
  }
  if (row.requiresReceipt === false) {
    return {
      required: false,
      note: `No receipt required — ${row.categoryName ?? row.categoryCode ?? 'this category'} is invoiced without a confirmation.`,
    };
  }

  const [confirmed] = await tx
    .select({ id: serviceReceipt.id })
    .from(serviceReceipt)
    .where(and(eq(serviceReceipt.payableId, payableId), eq(serviceReceipt.status, 'approved')))
    .limit(1);
  if (confirmed) return { required: true };

  const auto = await tx.execute(sql`
    select 1 from payable_event
     where payable_id = ${payableId} and event_code = 'PERIOD_AUTO_CONFIRMED'
     limit 1`);
  if (auto.rows.length > 0) return { required: true };

  throw new PayableStateError(
    row.payableNo,
    'the benefiting department has not confirmed the service — an approved service receipt is the evidence (A9).',
  );
}

/** §12 — an advance that belongs to a payable writes the bank lane's story. */
export async function onAdvanceEvent(
  tx: Tx,
  input: {
    payableId: string;
    eventCode: 'DEPOSIT_RECORDED' | 'FIELD_CHANGED';
    advanceId: string;
    advanceNo: string;
    summary: string;
    actorUserId: string | null;
  },
): Promise<void> {
  await events.record(tx, {
    payableId: input.payableId,
    eventCode: input.eventCode,
    summary: input.summary,
    sourceType: 'supplier_advance',
    sourceId: input.advanceId,
    sourceNo: input.advanceNo,
    actorUserId: input.actorUserId,
  });
  await recomputeStage(tx, input.payableId, input.actorUserId);
}

/** A10 — the charged line's mark on the import file's story (§9.2). */
export async function onChargedToImport(
  tx: Tx,
  input: {
    payableId: string;
    invoiceId: string;
    invoiceNo: string;
    summary: string;
    actorUserId: string | null;
  },
): Promise<void> {
  await events.record(tx, {
    payableId: input.payableId,
    eventCode: 'CHARGED_TO_IMPORT',
    summary: input.summary,
    sourceType: 'ap_invoice',
    sourceId: input.invoiceId,
    sourceNo: input.invoiceNo,
    actorUserId: input.actorUserId,
  });
}

/**
 * §5.1 — once invoices post, the payable's amount is their sum.
 *
 * REQ-FIX-001 FX7: the agreed amount in the payable's own currency too, when
 * that currency is the dinar the invoices are kept in. *Paid*, *Remaining*,
 * *Fully paid* and the cap on new payment applications all read
 * `amount_txn`; it used to stay at the first invoice's lines as they stood
 * when the import was born — no discount, no later correction, no second
 * invoice — so a second invoice could not be paid through the import and
 * the import read *Fully paid* while it was open. A payable agreed in
 * another currency keeps its agreed amount: its invoices are in dinars and
 * the difference between the two is the exchange difference (FX8).
 */
async function refreshFromInvoices(tx: Tx, payableId: string): Promise<void> {
  const [sums] = await tx
    .select({
      posted: sql<number>`count(*) filter (where ${apInvoice.status} in ('posted','partially_executed','settled'))::int`,
      totalIqd: sql<string>`coalesce(sum(${apInvoice.totalIqd}) filter (where ${apInvoice.status} in ('posted','partially_executed','settled')), 0)::text`,
    })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), isNull(apInvoice.reversedAt)));

  if ((sums?.posted ?? 0) > 0) {
    // The quantity follows the posted invoices too, in base units (FIX-4): a
    // second or corrected invoice moves what the containers are measured by.
    const stockLines = await tx
      .select({ itemCode: apInvoiceLine.itemCode, quantity: apInvoiceLine.quantity, uomCode: apInvoiceLine.uomCode })
      .from(apInvoiceLine)
      .innerJoin(apInvoice, eq(apInvoice.id, apInvoiceLine.apInvoiceId))
      .where(
        and(
          eq(apInvoice.payableId, payableId),
          isNull(apInvoice.reversedAt),
          inArray(apInvoice.status, ['posted', 'partially_executed', 'settled']),
          isNotNull(apInvoiceLine.itemCode),
          isNotNull(apInvoiceLine.warehouseCode),
        ),
      );
    let quantity = 0n;
    for (const line of stockLines) {
      quantity += line.uomCode
        ? await units.toBaseQuantity(tx, line.itemCode!, line.uomCode, parseQuantity(line.quantity))
        : parseQuantity(line.quantity);
    }
    await tx
      .update(payable)
      .set({
        amountIqd: sums!.totalIqd,
        amountTxn: sql`case when ${payable.currency} = 'IQD' then ${sums!.totalIqd}::numeric else ${payable.amountTxn} end`,
        ...(stockLines.length > 0 ? { quantity: formatQuantity(quantity) } : {}),
        updatedAt: new Date(),
      })
      .where(eq(payable.id, payableId));
  }
}

function assertOpen(row: { payableNo: string; closedAt: Date | null; cancelledAt: Date | null }) {
  if (row.cancelledAt) {
    throw new PayableStateError(row.payableNo, 'a cancelled payable is read-only.');
  }
  if (row.closedAt) {
    throw new PayableStateError(
      row.payableNo,
      'a closed payable is read-only except for attachments and notes (§20.1).',
    );
  }
}

/** Terms after creation — §14: `TERMS_SET` first, `TERMS_CHANGED` after, with before/after. */
export async function setTerms(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; paymentTermsText: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  await assertLaneEditable(tx, ctx, row, 'order');
  assertOpen(row);

  const next = input.paymentTermsText.trim();
  if (next === (row.paymentTermsText ?? '')) return;

  await tx
    .update(payable)
    .set({ paymentTermsText: next, updatedAt: new Date() })
    .where(eq(payable.id, row.id));

  await events.record(tx, {
    payableId: row.id,
    eventCode: row.paymentTermsText ? 'TERMS_CHANGED' : 'TERMS_SET',
    summary: row.paymentTermsText ? `Terms: ${row.paymentTermsText} → ${next}` : `Terms: ${next}`,
    before: row.paymentTermsText ? { terms: row.paymentTermsText } : null,
    after: { terms: next },
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.terms_set',
    objectType: PERMISSION_OBJECT,
    objectId: row.id,
    branchCode: row.branchCode,
    before: { terms: row.paymentTermsText },
    after: { terms: next },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Edits the PI — D11: a changed line supersedes the old one, never deletes
 * it, and the story says what changed. Refused once an invoice is posted:
 * from then on the invoice is the figure and the PI is history.
 */
export async function updateOrderLines(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; lines: readonly PayableLineInput[] },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  await assertLaneEditable(tx, ctx, row, 'order');
  assertOpen(row);

  const [posted] = await tx
    .select({ invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.payableId, row.id),
        inArray(apInvoice.status, ['posted', 'partially_executed', 'settled']),
        isNull(apInvoice.reversedAt),
      ),
    )
    .limit(1);
  if (posted) {
    throw new PayableStateError(
      row.payableNo,
      `invoice ${posted.invoiceNo} is posted — the invoice is the figure now. Correct it there.`,
    );
  }

  const current = await tx
    .select()
    .from(payableOrderLine)
    .where(and(eq(payableOrderLine.payableId, row.id), isNull(payableOrderLine.supersededAt)))
    .orderBy(asc(payableOrderLine.lineNo));

  // The old lines step aside, all of them, in one stamped act…
  await tx
    .update(payableOrderLine)
    .set({ supersededAt: new Date(), supersededBy: ctx.principal.userId })
    .where(and(eq(payableOrderLine.payableId, row.id), isNull(payableOrderLine.supersededAt)));

  // …and the new ones take their numbers.
  let amountTxn = 0n;
  let quantity = 0n;
  let hasQuantity = false;
  for (const [index, line] of input.lines.entries()) {
    const qty = line.quantity ? parseQuantity(line.quantity) : null;
    const price = line.unitPrice ? parseDecimal(line.unitPrice, MONEY_SCALE) : null;
    if (qty) {
      quantity += line.itemCode && line.uomCode ? await units.toBaseQuantity(tx, line.itemCode, line.uomCode, qty) : qty;
      hasQuantity = true;
      if (price) amountTxn += (qty * price) / 10n ** 6n;
    }
    await tx.insert(payableOrderLine).values({
      payableId: row.id,
      lineNo: index + 1,
      itemCode: line.itemCode ?? null,
      expenseCategoryCode: line.expenseCategoryCode ?? null,
      description: line.description,
      quantity: qty ? formatQuantity(qty) : null,
      uomCode: line.itemCode && line.uomCode ? await units.assertLineUnit(tx, line.itemCode, line.uomCode) : (line.uomCode ?? null),
      unitPrice: price ? toDecimalString(price) : null,
      amountTxn: qty && price ? toDecimalString((qty * price) / 10n ** 6n) : null,
    });
  }

  const converted = await rateService.convertOn(tx, amountTxn, row.currency, row.documentDate);
  await tx
    .update(payable)
    .set({
      amountTxn: toDecimalString(amountTxn),
      amountIqd: toDecimalString(converted.amountIqd),
      quantity: hasQuantity ? formatQuantity(quantity) : null,
      updatedAt: new Date(),
    })
    .where(eq(payable.id, row.id));

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'FIELD_CHANGED',
    summary: `PI lines changed: ${current.length} line(s) superseded by ${input.lines.length}`,
    before: {
      lines: current.map((line) => ({
        lineNo: line.lineNo,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
    },
    after: {
      lines: input.lines.map((line, index) => ({
        lineNo: index + 1,
        description: line.description,
        quantity: line.quantity ?? null,
        unitPrice: line.unitPrice ?? null,
      })),
    },
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.lines_changed',
    objectType: PERMISSION_OBJECT,
    objectId: row.id,
    branchCode: row.branchCode,
    after: { lines: input.lines.length },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** A note is the lightest event — §7.2 `NOTE_ADDED`. Allowed even when closed. */
export async function addNote(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; note: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  const note = input.note.trim();
  if (!note) throw new PayableValidationError('note', 'an empty note says nothing.');

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'NOTE_ADDED',
    summary: note,
    actorUserId: ctx.principal.userId,
  });
}

/** §5.1 — the only end state besides closed, and it states its reason (R3). */
export async function cancel(
  tx: Tx,
  ctx: ActorContext,
  input: { payableId: string; reason: string },
): Promise<void> {
  const row = await load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'reverse_cancel', PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });
  assertOpen(row);

  const reason = input.reason.trim();
  if (!reason) {
    throw new PayableValidationError('reason', 'a cancellation without a reason is not a record of a decision.');
  }

  const [posted] = await tx
    .select({ invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.payableId, row.id),
        inArray(apInvoice.status, ['posted', 'partially_executed', 'settled']),
        isNull(apInvoice.reversedAt),
      ),
    )
    .limit(1);
  if (posted) {
    throw new PayableStateError(
      row.payableNo,
      `invoice ${posted.invoiceNo} is posted against it. Reverse the invoice first — cancelling the record would not cancel the debt.`,
    );
  }

  await tx
    .update(payable)
    .set({
      cancelledAt: new Date(),
      cancelledBy: ctx.principal.userId,
      cancelReason: reason,
      updatedAt: new Date(),
    })
    .where(eq(payable.id, row.id));

  await events.record(tx, {
    payableId: row.id,
    eventCode: 'CANCELLED',
    summary: `Cancelled: ${reason}`,
    after: { reason },
    actorUserId: ctx.principal.userId,
  });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: row.id,
    branchCode: row.branchCode,
    after: { cancelled: true },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  // REQ-PM-001 §8 — what the payable still promised is given back.
  await execution.releaseFor(tx, ctx, { payableId: row.id }, `Payable ${row.payableNo} cancelled: ${reason}`);
}

// ---------------------------------------------------------------------------
// The workbench (§21.2) and the page (§21.3)
// ---------------------------------------------------------------------------

export interface WorkbenchFilter {
  readonly typeCode?: string | null;
  readonly stageCode?: string | null;
  readonly stopped?: 'yes' | 'no' | 'needs_reason' | null;
  readonly supplierId?: string | null;
  readonly search?: string | null;
  readonly includeCancelled?: boolean;
  readonly page?: number;
  readonly pageSize?: number;
}

/**
 * The one list for everything owed. Stopped-without-reason first, then days
 * stopped, then due date (§21.2) — the sort is the triage order.
 */
export async function workbench(tx: Tx, filter: WorkbenchFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, filter.pageSize ?? 25));

  const needsReason = sql<boolean>`exists (
    select 1 from payable_hold h
     where h.payable_id = ${payable.id}
       and h.status = 'open' and h.reason_code = 'PENDING_REASON')`;

  const where = and(
    filter.typeCode ? eq(payable.payableTypeCode, filter.typeCode) : undefined,
    filter.stageCode ? eq(payable.stageCode, filter.stageCode) : undefined,
    filter.supplierId ? eq(payable.supplierId, filter.supplierId) : undefined,
    filter.stopped === 'yes' ? eq(payable.onHold, true) : undefined,
    filter.stopped === 'no' ? eq(payable.onHold, false) : undefined,
    filter.stopped === 'needs_reason' ? needsReason : undefined,
    filter.includeCancelled ? undefined : isNull(payable.cancelledAt),
    filter.search
      ? or(
          ilike(payable.supplierReference, `%${filter.search}%`),
          ilike(payable.payableNo, `%${filter.search}%`),
          ilike(payable.description, `%${filter.search}%`),
          sql`${payable.supplierReferenceKey} like ${'%' + filter.search.toUpperCase().replace(/[^A-Z0-9]/g, '') + '%'}`,
        )
      : undefined,
  );

  const rows = await tx
    .select({
      id: payable.id,
      payableNo: payable.payableNo,
      typeCode: payable.payableTypeCode,
      typeName: payableType.name,
      reference: payable.supplierReference,
      supplierName: businessPartner.legalName,
      departmentCode: payable.departmentCode,
      description: payable.description,
      currency: payable.currency,
      amountTxn: payable.amountTxn,
      amountIqd: payable.amountIqd,
      // §15.5 — Paid, from the applications (confirmed or debited); never stored.
      paidTxn: sql<string>`coalesce((
        select sum(pa.amount_txn) from payment_application pa
         where pa.payable_id = ${payable.id} and pa.status in ('confirmed', 'debited')), 0)::text`,
      // §17.5 — X of Y, the containers counted from their rows.
      containersTotal: sql<number>`(select count(*)::int from shipment_container c
         where c.payable_id = ${payable.id} and c.cancelled_at is null)`,
      containersReceived: sql<number>`(select count(*)::int from shipment_container c
         join container_status s on s.code = c.status_code
         where c.payable_id = ${payable.id} and c.cancelled_at is null and s.counts_as_received)`,
      stageCode: payable.stageCode,
      stageName: payableStage.name,
      stageSequence: payableStage.sequence,
      stageSince: payable.stageSince,
      onHold: payable.onHold,
      needsReason,
      dueDate: payable.dueDate,
      documentDate: payable.documentDate,
      branchCode: payable.branchCode,
      cancelledAt: payable.cancelledAt,
      closedAt: payable.closedAt,
      hold: {
        reasonCode: payableHold.reasonCode,
        ownerUserId: payableHold.ownerUserId,
        startedAt: payableHold.startedAt,
        nextAction: payableHold.nextAction,
        nextActionDue: payableHold.nextActionDue,
      },
    })
    .from(payable)
    .innerJoin(payableType, eq(payableType.code, payable.payableTypeCode))
    .innerJoin(
      payableStage,
      and(
        eq(payableStage.payableTypeCode, payable.payableTypeCode),
        eq(payableStage.code, payable.stageCode),
      ),
    )
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .leftJoin(
      payableHold,
      and(
        eq(payableHold.payableId, payable.id),
        eq(payableHold.status, 'open'),
        sql`${payableHold.startedAt} = (
          select min(h2.started_at) from payable_hold h2
           where h2.payable_id = ${payable.id} and h2.status = 'open')`,
      ),
    )
    .where(where)
    .orderBy(
      desc(needsReason),
      sql`case when ${payable.onHold} then 0 else 1 end`,
      asc(payableHold.startedAt),
      asc(payable.dueDate),
      desc(payable.createdAt),
    )
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ total }] = (await tx
    .select({ total: sql<number>`count(*)::int` })
    .from(payable)
    .where(where)) as [{ total: number }];

  return { rows, total, page, pageSize };
}

export interface WorkbenchView {
  readonly id: string;
  readonly name: string;
  /** The workbench's own filter shape: { type?, stopped? }. */
  readonly query: Readonly<Record<string, string>>;
}

/**
 * §21.2 — the seed views are saved-view rows (shared, listKey 'payables'),
 * so the accountant's own views sit beside them and the list is theirs to
 * grow. Ordered by name under a numbered prefix, so the seeds keep the
 * diagram's order without a column for it.
 */
export async function workbenchViews(tx: Tx): Promise<WorkbenchView[]> {
  const rows = await tx
    .select({ id: savedView.id, name: savedView.name, query: savedView.query })
    .from(savedView)
    .where(and(eq(savedView.listKey, 'payables'), eq(savedView.isShared, true)))
    .orderBy(asc(savedView.name));
  return rows.map((row) => ({
    id: row.id,
    name: row.name.replace(/^\d+\s*·\s*/, ''),
    query: (row.query ?? {}) as Readonly<Record<string, string>>,
  }));
}

/** The page's header: the record, its type, rail, lanes, lines, open holds. */
export async function view(tx: Tx, payableNo: string) {
  const row = await loadByNo(tx, payableNo);
  const type = await typeOf(tx, row.payableTypeCode);
  const rail = await railFor(tx, row.payableTypeCode);

  const lanes = await tx.execute(sql`
    select l.code, l.name, l.sort_order
      from payable_type_lane tl
      join payable_lane l on l.code = tl.lane_code
     where tl.payable_type_code = ${row.payableTypeCode}
     order by l.sort_order
  `);

  const lines = await tx
    .select()
    .from(payableOrderLine)
    .where(and(eq(payableOrderLine.payableId, row.id), isNull(payableOrderLine.supersededAt)))
    .orderBy(asc(payableOrderLine.lineNo));

  const invoices = await tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      supplierInvoiceNo: apInvoice.supplierInvoiceNo,
      status: apInvoice.status,
      invoiceDate: apInvoice.invoiceDate,
      totalIqd: apInvoice.totalIqd,
      settledAmountIqd: apInvoice.settledAmountIqd,
    })
    .from(apInvoice)
    .where(eq(apInvoice.payableId, row.id))
    .orderBy(asc(apInvoice.invoiceDate));

  const holds = await tx
    .select()
    .from(payableHold)
    .where(and(eq(payableHold.payableId, row.id), eq(payableHold.status, 'open')))
    .orderBy(asc(payableHold.startedAt));

  const [supplier] = await tx
    .select({ id: businessPartner.id, code: businessPartner.code, name: businessPartner.legalName })
    .from(businessPartner)
    .where(eq(businessPartner.id, row.supplierId))
    .limit(1);

  const [branchRow] = await tx
    .select({ name: branch.name })
    .from(branch)
    .where(eq(branch.code, row.branchCode))
    .limit(1);

  // Which stages' own rules hold — so the rail ticks only what is true. The
  // stage is the highest that holds (§6); a payment sent before the PD is
  // registered puts the import at "Payment in progress" without pretending
  // the PD stage was passed.
  const facts = await gatherFacts(tx, row.id);
  const reached = rail
    .filter((stage) => STAGE_RULES[stage.ruleName]?.(facts) ?? false)
    .map((stage) => stage.code);

  return {
    payable: row,
    type,
    rail,
    reached,
    /** The stage facts the rail was read from — for a reader that needs them again (HARDEN G3). */
    facts,
    lanes: lanes.rows as { code: string; name: string; sort_order: number }[],
    lines,
    invoices,
    holds,
    supplier: supplier ?? null,
    branchName: branchRow?.name ?? row.branchCode,
  };
}
