/**
 * The goods' journey of one import, read for its page — by direction 2026-10-07
 * ("it should write somewhere that [the goods went] from On Process to In
 * Process, [and] others are pending").
 *
 * Read-only. Every fact is a row or a line of the import's own log, read
 * through the readers that already own it:
 *
 *   * the hold and the release — the log's `ADVANCE_HELD` (written by the
 *     posting) and `ADVANCE_RELEASED` (written by `advance-hold.release`, its
 *     source the payment application that was Paid), the application's own
 *     confirmation date, and `advance-hold.heldOf` for what still waits;
 *   * the advance agreed — the invoice's own `advance_basis` / `_percent` /
 *     `_amount` (0411) and the application its posting raised;
 *   * the B/Ls and containers — `logistics-views.shippingForImport`, the PD
 *     page's own read; the first `CONTAINER_ADDED` line for when they were put
 *     on the import;
 *   * the PDs and declarations — `logistics-views.customsForImport`;
 *   * the landed cost — `landed-cost.chargesFor` / `locksFor`.
 *
 * A lane the viewer may not read is not read, and its steps are not drawn
 * (`domain/import-journey.STAGE_SOURCES`, the Home journey's own rule), so the
 * picture never shows a fake "pending". The arithmetic of the steps is the
 * pure `domain/import-goods-journey.ts`.
 */
import { and, asc, eq, inArray, isNull, ne, notInArray, or } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { apInvoice, payableEvent, paymentApplication, warehouse } from '../db/schema';
import { businessDateOf } from '../domain/business-date';
import {
  advanceAmountOf,
  goodsJourney,
  goodsWhereNow,
  type GoodsJourneyFacts,
  type GoodsStepView,
  type GoodsWhereNow,
} from '../domain/import-goods-journey';
import { STAGE_SOURCES } from '../domain/import-journey';
import { can, type Principal } from '../domain/permissions';
import * as advanceHold from './advance-hold';
import * as landed from './landed-cost';
import * as logistics from './logistics-views';
import * as payables from './payables';

/** The log lines the journey reads its dates from. */
const JOURNEY_EVENTS = ['ADVANCE_HELD', 'ADVANCE_RELEASED', 'CONTAINER_ADDED', 'BL_ISSUED'] as const;

const POSTED = ['posted', 'partially_executed', 'settled'] as const;

const mayRead = (principal: Principal, objects: readonly string[]) => objects.every((object) => can(principal, 'view', object));

const dayOf = (value: Date | string | null | undefined): string | null => (value ? businessDateOf(new Date(value)) : null);

export interface GoodsJourney {
  readonly steps: readonly GoodsStepView[];
  /** The payable amount the invoice agreed in front — "20%" or an amount — for the first step's words. */
  readonly advance: ReturnType<typeof advanceAmountOf> | null;
  /** Where the goods are now, container by container (2026-10-07: "like tracking … based on updates"). */
  readonly now: GoodsWhereNow;
}

/** What the engines know about the import's goods, read as this viewer may. */
export async function factsFor(tx: Tx, principal: Principal, payableId: string): Promise<GoodsJourneyFacts> {
  const owner = await payables.load(tx, payableId);

  // The import's invoices, oldest first — what they agreed in front, and which posted.
  // Not an opening balance (0422): it is the sheet's debt on the books, not the goods' invoice.
  const invoices = await tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      status: apInvoice.status,
      postedAt: apInvoice.postedAt,
      invoiceDate: apInvoice.invoiceDate,
      advanceBasis: apInvoice.advanceBasis,
      advancePercent: apInvoice.advancePercent,
      advanceAmount: apInvoice.advanceAmount,
      agreedCurrency: apInvoice.agreedCurrency,
      advanceApplicationId: apInvoice.advanceApplicationId,
    })
    .from(apInvoice)
    .where(
      and(
        eq(apInvoice.payableId, payableId),
        ne(apInvoice.status, 'reversed'),
        isNull(apInvoice.reversedAt),
        eq(apInvoice.isImportOpening, false),
      ),
    )
    .orderBy(asc(apInvoice.invoiceDate), asc(apInvoice.invoiceNo));

  // An advance is agreed by percentage or by amount (0411); a row from before 0411 has a percentage and no basis.
  const agreed = invoices.find(
    (invoice) => invoice.advanceBasis === 'percent' || invoice.advanceBasis === 'amount' || (invoice.advanceBasis === null && invoice.advancePercent !== null),
  );
  const posted = invoices.find((invoice) => (POSTED as readonly string[]).includes(invoice.status));

  // The log's lines for the hold, the release and the containers, oldest first.
  const lines = await tx
    .select({ eventCode: payableEvent.eventCode, occurredAt: payableEvent.occurredAt, sourceType: payableEvent.sourceType, sourceNo: payableEvent.sourceNo })
    .from(payableEvent)
    .where(and(eq(payableEvent.payableId, payableId), inArray(payableEvent.eventCode, [...JOURNEY_EVENTS])))
    .orderBy(asc(payableEvent.occurredAt), asc(payableEvent.recordedAt));
  // The posting's line, not the one an application's cancellation writes ("the goods stay held").
  const heldLine = lines.find((line) => line.eventCode === 'ADVANCE_HELD' && line.sourceType === 'ap_invoice');
  const releasedLine = [...lines].reverse().find((line) => line.eventCode === 'ADVANCE_RELEASED');
  const addedLine = lines.find((line) => line.eventCode === 'CONTAINER_ADDED') ?? lines.find((line) => line.eventCode === 'BL_ISSUED');

  // The applications named: the one the posting raised, and the one whose payment released the goods.
  const applicationIds = agreed?.advanceApplicationId ? [agreed.advanceApplicationId] : [];
  const releasedNo = releasedLine?.sourceNo ?? null;
  const applications =
    applicationIds.length > 0 || releasedNo
      ? await tx
          .select({ id: paymentApplication.id, applicationNo: paymentApplication.applicationNo, confirmedOn: paymentApplication.confirmedOn })
          .from(paymentApplication)
          .where(
            and(
              eq(paymentApplication.payableId, payableId),
              or(
                applicationIds.length > 0 ? inArray(paymentApplication.id, applicationIds) : undefined,
                releasedNo ? eq(paymentApplication.applicationNo, releasedNo) : undefined,
              ),
            ),
          )
      : [];
  const raised = applications.find((one) => one.id === agreed?.advanceApplicationId) ?? null;
  const releasing = releasedNo ? applications.find((one) => one.applicationNo === releasedNo) : undefined;

  const heldNow = (await advanceHold.heldOf(tx, payableId)).length > 0;

  // A migrated import with no invoice here (the sheet's): its applications say where the goods stand —
  // the first the bank confirmed, else the one that waits. Read only for those; every other import has none.
  let legacy: GoodsJourneyFacts['legacy'] = null;
  if (owner.source === 'sheet_import' && invoices.length === 0) {
    const standing = await tx
      .select({ applicationNo: paymentApplication.applicationNo, status: paymentApplication.status, confirmedOn: paymentApplication.confirmedOn })
      .from(paymentApplication)
      .where(and(eq(paymentApplication.payableId, payableId), notInArray(paymentApplication.status, ['rejected', 'cancelled', 'reversed'])))
      .orderBy(asc(paymentApplication.confirmedOn), asc(paymentApplication.applicationNo));
    const paid = standing.find((one) => one.status === 'confirmed' || one.status === 'debited');
    legacy = {
      paid: paid ? { applicationNo: paid.applicationNo, on: paid.confirmedOn ? String(paid.confirmedOn) : null } : null,
      waiting: !paid && standing[0] ? { applicationNo: standing[0].applicationNo } : null,
    };
  }

  // The shipping lane — B/Ls and containers, as the PD page reads them; cancelled ones are not the journey.
  let shipping: GoodsJourneyFacts['shipping'] = null;
  if (mayRead(principal, STAGE_SOURCES.container)) {
    const rows = await logistics.shippingForImport(tx, payableId);
    const live = rows.filter((row) => !row.blCancelled);
    const bls = [...new Map(live.map((row) => [row.blId, { blNo: row.blNo, blDate: row.blDate }])).values()];
    const boxes = live.filter((row) => row.id !== null && !row.cancelled);
    // The warehouses the receipts took containers into, by name ("Received into Main Warehouse").
    const codes = [...new Set(boxes.map((row) => row.warehouseCode).filter((code): code is string => Boolean(code)))];
    const names = new Map(
      codes.length > 0
        ? (await tx.select({ code: warehouse.code, name: warehouse.name }).from(warehouse).where(inArray(warehouse.code, codes))).map(
            (one) => [one.code, one.name] as const,
          )
        : [],
    );
    const containers = boxes.map((row) => ({
      id: row.id!,
      containerNo: row.containerNo!,
      customsClearedOn: row.customsClearedOn,
      receivedOn: row.receivedOn,
      statusCode: row.statusCode,
      eta: row.eta,
      arrivedPortOn: row.arrivedPortOn,
      warehouseCode: row.warehouseCode,
      warehouseName: row.warehouseCode ? (names.get(row.warehouseCode) ?? null) : null,
    }));
    shipping = { bls, containers, containersAddedOn: dayOf(addedLine?.occurredAt) };
  }

  // The customs lane — the standing PDs and the cleared declarations.
  let customs: GoodsJourneyFacts['customs'] = null;
  if (mayRead(principal, STAGE_SOURCES.customs)) {
    const read = await logistics.customsForImport(tx, payableId);
    customs = {
      pds: read.pds
        .filter((pd) => !pd.superseded)
        .map((pd) => ({ pdNo: pd.pdNo, year: pd.year === null ? null : Number(pd.year), statusName: pd.statusName, statusDate: pd.statusDate })),
      clearedDeclarations: can(principal, 'view', 'customs_declaration')
        ? read.declarations
            .filter((declaration) => declaration.status === 'cleared')
            .map((declaration) => ({ declarationNo: declaration.declarationNo, statusDate: declaration.statusDate }))
        : null,
    };
  }

  // The landed cost — the page's own section reads it under `landed_cost`.
  let landedCost: GoodsJourneyFacts['landed'] = null;
  if (can(principal, 'view', landed.PERMISSION_OBJECT)) {
    const charges = await landed.chargesFor(tx, payableId);
    const locks = await landed.locksFor(tx, payableId);
    landedCost = {
      liveCharges: charges.filter((charge) => !charge.cancelledAt).length,
      locks: locks.map((lock) => ({ sequence: lock.sequence, lockDate: String(lock.lockDate) })),
    };
  }

  return {
    payableNo: owner.payableNo,
    advance: agreed
      ? {
          invoiceNo: agreed.invoiceNo,
          posted: (POSTED as readonly string[]).includes(agreed.status),
          basis: agreed.advanceBasis === 'amount' ? 'amount' : 'percent',
          percent: agreed.advancePercent,
          amount: agreed.advanceAmount,
          currency: agreed.agreedCurrency ?? 'IQD',
          applicationNo: raised?.applicationNo ?? null,
        }
      : null,
    heldOn: dayOf(heldLine?.occurredAt),
    heldNow,
    released: releasedNo ? { applicationNo: releasedNo, on: releasing?.confirmedOn ? String(releasing.confirmedOn) : dayOf(releasedLine?.occurredAt) } : null,
    posted: posted ? { invoiceNo: posted.invoiceNo, on: dayOf(posted.postedAt) ?? (posted.invoiceDate ? String(posted.invoiceDate) : null) } : null,
    legacy,
    // 0426 — paid after the goods arrive: nothing waits for a SWIFT.
    payAfterArrival: owner.payAfterArrival ? { on: dayOf(owner.payAfterArrivalSetAt) } : null,
    shipping,
    customs,
    landed: landedCost,
  };
}

/** The journey's steps for the import's page. */
export async function journeyFor(tx: Tx, principal: Principal, payableId: string): Promise<GoodsJourney> {
  const facts = await factsFor(tx, principal, payableId);
  return { steps: goodsJourney(facts), advance: facts.advance ? advanceAmountOf(facts.advance) : null, now: goodsWhereNow(facts) };
}
