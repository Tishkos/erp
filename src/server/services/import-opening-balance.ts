/**
 * The imports brought in from the sheet, on the supplier's account (0422,
 * 2026-10-15, by direction: "import application not connected suppliers
 * balances … I cannot see the supplier balances" → "post them to the ledger").
 *
 * The sheet import (13 Oct) wrote tracking only, so every supplier screen that
 * reads the ledger showed the 23 import suppliers owing nothing, and confirming
 * a payment on one of their imports had nothing to post against (no invoice,
 * no purchase order). Here, what each import still owed at the cut-over —
 * agreed less paid, `payment-applications.totalsFor`'s own figure, the one the
 * import page shows — becomes a posted purchase invoice of the supplier,
 * marked `is_import_opening`:
 *
 *   Dr goods_in_transit      left × the rate in force on the cut-over day
 *   Cr supplier_payable      the same, with the supplier
 *
 * dated the day the import was brought in, so the dinars are the ones the
 * import was stored at and the journal's dollars are exactly what is owed.
 * From then on it is owed, aged, stated and paid as any bill: a payment
 * confirmed on the import posts a supplier payment against it, and the exchange
 * difference closes it once the import is paid in full. It is not the goods'
 * invoice, so the import's own reads (stage, goods journey, stored figures)
 * leave it out.
 *
 * Money that left before the cut-over on an application the sheet left "sent"
 * (`confirmBeforeCutOver`) was counted as owed; `settleBeforeCutOver` takes it
 * off through the same two lines, at the opening's own rate.
 *
 * The supplier's own invoice for such an import, entered after the cut-over
 * (how its goods come into stock), is absorbed when it posts
 * (`absorbInvoice`): the opening already holds that debt — what was still owed
 * — and the rest was paid before the books opened, so the invoice is settled
 * against it (Dr the supplier, Cr the goods) up to what the import agreed, and
 * the supplier is never owed it twice. Reversing that invoice undoes it
 * (`undoAbsorption`).
 *
 * Nothing here edits a posted document: an opening that is wrong is reversed
 * (`ap.reverse`, while nothing rests on it) and planned again.
 */
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  apInvoice,
  apInvoiceLine,
  businessPartner,
  importOpeningSettlement,
  journalEntry,
  payable,
  postingRule,
} from '../db/schema';
import { businessDateOf } from '../domain/business-date';
import { divideHalfUp, MONEY_SCALE, parseDecimal, RATE_SCALE, toDecimalString, toIqd } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as journal from './journal';
import * as posting from './posting';
import * as rates from './exchange-rates';
import * as applications from './payment-applications';
import { allocateDocumentNumber } from './numbering';

export const EVENT_TYPE = 'payables.import_opening_balance';
/** The goods' side of the opening — mapped by Finance on Posting Mappings. */
export const OFFSET_ROLE = 'goods_in_transit';
/** The purchase invoice's own series: an opening is a purchase invoice (PUR-…). */
const SEQUENCE_KEY = 'AP_INVOICE';
const DOCUMENT_TYPE = 'ap_invoice';
const SOURCE_MODULE = 'purchasing';
const OPENING_EVENT = 'import_opening';

export class ImportOpeningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportOpeningError';
  }
}

/** One import the plan would open, with the figures the opening would carry. */
export interface OpeningLine {
  readonly payableId: string;
  readonly payableNo: string;
  readonly reference: string | null;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly supplierName: string;
  readonly branchCode: string;
  readonly currency: string;
  /** The day the import was brought in — the opening's date. */
  readonly openedOn: string;
  readonly agreedTxn: string;
  readonly paidTxn: string;
  readonly leftTxn: string;
  /** IQD per unit, as the rate in force on `openedOn` (8 places). */
  readonly rate: string;
  readonly leftIqd: string;
  /** The import's own due date when it has one; the opening then carries it as set. */
  readonly dueDate: string | null;
}

export interface SkippedImport {
  readonly payableNo: string;
  readonly supplierCode: string;
  readonly reason: 'opened' | 'invoiced' | 'paid' | 'closed' | 'not_import';
  /** The opening or invoice already there, when that is the reason. */
  readonly documentNo?: string;
  readonly leftTxn?: string;
}

export interface OpeningPlan {
  readonly openings: readonly OpeningLine[];
  readonly skipped: readonly SkippedImport[];
  /** Per currency: how many, what is left in that currency, and in dinars. */
  readonly totals: readonly { currency: string; count: number; leftTxn: string; leftIqd: string }[];
  /** Why nothing can be written yet. Empty when the plan can be applied. */
  readonly stops: readonly string[];
}

export interface AppliedOpening extends OpeningLine {
  readonly invoiceNo: string;
  readonly invoiceId: string;
  readonly entryNo: string;
}

/** The import's live opening, if it has one. */
export async function openingOf(tx: Tx, payableId: string) {
  const [row] = await tx
    .select()
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), eq(apInvoice.isImportOpening, true), isNull(apInvoice.reversedAt)))
    .limit(1);
  return row ?? null;
}

/** The supplier invoices settled against an opening, by number — while any is, the opening is not reversed. */
export async function absorbedBy(tx: Tx, openingId: string): Promise<string[]> {
  const rows = await tx
    .select({ invoiceNo: apInvoice.invoiceNo })
    .from(importOpeningSettlement)
    .innerJoin(apInvoice, eq(apInvoice.id, importOpeningSettlement.absorbedInvoiceId))
    .where(
      and(
        eq(importOpeningSettlement.apInvoiceId, openingId),
        eq(importOpeningSettlement.kind, 'absorbed_by_invoice'),
        isNull(importOpeningSettlement.reversedAt),
      ),
    )
    .orderBy(asc(apInvoice.invoiceNo));
  return rows.map((row) => row.invoiceNo);
}

/** True when the import's balance is on the books as its opening. */
export async function hasOpening(tx: Tx, payableId: string): Promise<boolean> {
  return (await openingOf(tx, payableId)) !== null;
}

/**
 * What would be opened, and what is left out with the reason — read only.
 * Every import brought in from the sheet that is not cancelled is looked at.
 */
export async function plan(tx: Tx, ctx: ActorContext): Promise<OpeningPlan> {
  await authz.authorize(ctx.principal, 'post', DOCUMENT_TYPE, { branchCode: ctx.branchCode });

  const imports = await tx
    .select({
      id: payable.id,
      payableNo: payable.payableNo,
      reference: payable.supplierReference,
      typeCode: payable.payableTypeCode,
      supplierId: payable.supplierId,
      supplierCode: businessPartner.code,
      supplierName: businessPartner.legalName,
      branchCode: payable.branchCode,
      currency: payable.currency,
      agreedTxn: payable.amountTxn,
      dueDate: sql<string | null>`${payable.dueDate}::text`,
      closedAt: payable.closedAt,
      createdAt: payable.createdAt,
    })
    .from(payable)
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .where(and(eq(payable.source, 'sheet_import'), isNull(payable.cancelledAt)))
    .orderBy(asc(payable.payableNo));

  const invoices =
    imports.length === 0
      ? []
      : await tx
          .select({ payableId: apInvoice.payableId, invoiceNo: apInvoice.invoiceNo, opening: apInvoice.isImportOpening })
          .from(apInvoice)
          .where(
            and(
              inArray(
                apInvoice.payableId,
                imports.map((row) => row.id),
              ),
              ne(apInvoice.status, 'reversed'),
              isNull(apInvoice.reversedAt),
            ),
          );

  const openings: OpeningLine[] = [];
  const skipped: SkippedImport[] = [];
  const stops: string[] = [];
  for (const row of imports) {
    const own = invoices.filter((invoice) => invoice.payableId === row.id);
    const opened = own.find((invoice) => invoice.opening);
    if (row.typeCode !== 'import') {
      skipped.push({ payableNo: row.payableNo, supplierCode: row.supplierCode, reason: 'not_import' });
      continue;
    }
    if (opened) {
      skipped.push({ payableNo: row.payableNo, supplierCode: row.supplierCode, reason: 'opened', documentNo: opened.invoiceNo });
      continue;
    }
    // An import with an invoice of its own is on the books through it.
    if (own.length > 0) {
      skipped.push({ payableNo: row.payableNo, supplierCode: row.supplierCode, reason: 'invoiced', documentNo: own[0]!.invoiceNo });
      continue;
    }
    const sums = await applications.totalsFor(tx, row.id);
    if (sums.remainingTxn <= 0n) {
      skipped.push({ payableNo: row.payableNo, supplierCode: row.supplierCode, reason: 'paid' });
      continue;
    }
    if (row.closedAt) {
      skipped.push({ payableNo: row.payableNo, supplierCode: row.supplierCode, reason: 'closed', leftTxn: toDecimalString(sums.remainingTxn) });
      continue;
    }
    const openedOn = businessDateOf(row.createdAt);
    let rate: bigint;
    try {
      rate = (await rates.rateOn(tx, row.currency, openedOn)).iqdPerUnit;
    } catch (error) {
      stops.push(`${row.payableNo}: no ${row.currency} rate for ${openedOn} — ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    openings.push({
      payableId: row.id,
      payableNo: row.payableNo,
      reference: row.reference,
      supplierId: row.supplierId,
      supplierCode: row.supplierCode,
      supplierName: row.supplierName,
      branchCode: row.branchCode,
      currency: row.currency,
      openedOn,
      agreedTxn: toDecimalString(parseDecimal(row.agreedTxn, MONEY_SCALE)),
      paidTxn: toDecimalString(sums.paidTxn),
      leftTxn: toDecimalString(sums.remainingTxn),
      rate: toDecimalString(rate, RATE_SCALE),
      leftIqd: toDecimalString(toIqd(sums.remainingTxn, rate)),
      dueDate: row.dueDate && row.dueDate >= openedOn ? row.dueDate : null,
    });
  }

  // The two lines the journal asks for must be mapped before anything posts.
  const mapped = await tx
    .select({ role: postingRule.lineRole })
    .from(postingRule)
    .where(and(eq(postingRule.eventType, EVENT_TYPE), eq(postingRule.isActive, true)));
  for (const role of ['supplier_payable', OFFSET_ROLE]) {
    if (!mapped.some((rule) => rule.role === role)) {
      stops.push(`Posting Mappings has no account for "${role}" on "${EVENT_TYPE}" (Finance → Posting Mappings).`);
    }
  }
  // The engine's own plan for the first opening — mapping, accounts, period and dimensions, without writing.
  const probe = openings[0];
  if (probe && stops.length === 0) {
    try {
      await posting.plan(tx, ctx, journalRequest(probe, randomUUID(), OPENING_EVENT));
    } catch (error) {
      stops.push(`The opening journal would not post: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const byCurrency = new Map<string, { count: number; leftTxn: bigint; leftIqd: bigint }>();
  for (const line of openings) {
    const sum = byCurrency.get(line.currency) ?? { count: 0, leftTxn: 0n, leftIqd: 0n };
    sum.count += 1;
    sum.leftTxn += parseDecimal(line.leftTxn, MONEY_SCALE);
    sum.leftIqd += parseDecimal(line.leftIqd, MONEY_SCALE);
    byCurrency.set(line.currency, sum);
  }
  const totals = [...byCurrency].map(([currency, sum]) => ({
    currency,
    count: sum.count,
    leftTxn: toDecimalString(sum.leftTxn),
    leftIqd: toDecimalString(sum.leftIqd),
  }));
  return { openings, skipped, totals, stops };
}

/**
 * The event's two lines: opening, the supplier credited and the goods debited;
 * settling, the other way round. Posted under the document it belongs to, so
 * the supplier's statement names it.
 */
function twoLines(input: {
  readonly branchCode: string;
  readonly supplierCode: string;
  readonly on: string;
  readonly documentId: string;
  readonly sourceEvent: string;
  readonly amountIqd: string;
  readonly settling: boolean;
  readonly description: string;
}) {
  const { amountIqd: amount, description } = input;
  return {
    eventType: EVENT_TYPE,
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: SOURCE_MODULE, documentId: input.documentId, event: input.sourceEvent },
    branchCode: input.branchCode,
    documentDate: input.on,
    postingDate: input.on,
    description,
    lines: [
      {
        role: 'supplier_payable',
        ...(input.settling ? { debit: amount } : { credit: amount }),
        dimensions: { branch: input.branchCode, business_partner: input.supplierCode },
        description,
      },
      {
        role: OFFSET_ROLE,
        ...(input.settling ? { credit: amount } : { debit: amount }),
        dimensions: { branch: input.branchCode },
        description,
      },
    ],
  };
}

/** The opening's journal, or (settling) money paid before the cut-over taken off it. */
function journalRequest(line: OpeningLine, documentId: string, sourceEvent: string, amountIqd?: string, settling = false) {
  return twoLines({
    branchCode: line.branchCode,
    supplierCode: line.supplierCode,
    on: line.openedOn,
    documentId,
    sourceEvent,
    amountIqd: amountIqd ?? line.leftIqd,
    settling,
    description: settling
      ? `Import ${line.payableNo} — paid before the cut-over, off its opening balance`
      : `Import ${line.payableNo} — opening balance from the sheet, ${line.currency} ${line.leftTxn} at ${line.rate}`,
  });
}

/**
 * Opens every import the plan lists, in one transaction: a posted purchase
 * invoice and its journal each, a line on the import's log, an audit row.
 * Refuses the whole while the plan has a stop. Run again, it opens nothing
 * twice — an import already opened is skipped.
 */
export async function apply(tx: Tx, ctx: ActorContext): Promise<{ plan: OpeningPlan; applied: AppliedOpening[] }> {
  const planned = await plan(tx, ctx);
  if (planned.stops.length > 0) {
    throw new ImportOpeningError(`Nothing was opened:\n- ${planned.stops.join('\n- ')}`);
  }

  const applied: AppliedOpening[] = [];
  for (const line of planned.openings) {
    // Locked, then asked again: two runs at once open each import once.
    await tx.execute(sql`select id from payable where id = ${line.payableId} for update`);
    if (await hasOpening(tx, line.payableId)) continue;

    const invoiceId = randomUUID();
    const number = await allocateDocumentNumber(
      tx,
      SEQUENCE_KEY,
      { branchCode: line.branchCode, year: Number(line.openedOn.slice(0, 4)) },
      ctx.principal.userId,
    );
    const journalPosted = await posting.post(tx, ctx, journalRequest(line, invoiceId, OPENING_EVENT));

    const now = new Date();
    const justification =
      `Opening balance of import ${line.payableNo}${line.reference ? ` (${line.reference})` : ''} from the sheet: ` +
      `${line.currency} ${line.leftTxn} of ${line.agreedTxn} still owed when it was brought in on ${line.openedOn}.`;
    await tx.insert(apInvoice).values({
      id: invoiceId,
      invoiceNo: number.documentNo,
      // Ours: the supplier's own number stays free for the supplier's real invoice.
      supplierInvoiceNo: number.documentNo,
      status: 'posted',
      supplierId: line.supplierId,
      payableId: line.payableId,
      isImport: true,
      isImportOpening: true,
      branchCode: line.branchCode,
      invoiceDate: line.openedOn,
      dueDate: line.dueDate ?? line.openedOn,
      // The import's own due date is known; with none, the balance waits for one (the import page asks).
      dueDateSetAt: line.dueDate ? now : null,
      currency: 'IQD',
      agreedCurrency: line.currency === 'IQD' ? null : line.currency,
      agreedRate: line.currency === 'IQD' ? null : line.rate,
      totalIqd: line.leftIqd,
      nonPoJustification: justification,
      nonPoApprovedBy: ctx.principal.userId,
      nonPoApprovedAt: now,
      journalEntryId: journalPosted.journalEntryId,
      createdBy: ctx.principal.userId,
      submittedBy: ctx.principal.userId,
      postedBy: ctx.principal.userId,
      postedAt: now,
    });
    await tx.insert(apInvoiceLine).values({
      apInvoiceId: invoiceId,
      lineNo: 1,
      description: justification,
      quantity: '1',
      uomCode: 'EA',
      unitPrice: line.leftIqd,
      isInventory: false,
    });

    await events.record(tx, {
      payableId: line.payableId,
      eventCode: 'OPENING_BALANCE',
      summary: `Opening balance ${number.documentNo} posted — ${line.currency} ${line.leftTxn} owed to ${line.supplierCode}, IQD ${line.leftIqd} at ${line.rate} (${journalPosted.entryNo})`,
      sourceType: DOCUMENT_TYPE,
      sourceId: invoiceId,
      sourceNo: number.documentNo,
      after: { leftTxn: line.leftTxn, leftIqd: line.leftIqd, rate: line.rate, entryNo: journalPosted.entryNo },
      actorUserId: ctx.principal.userId,
    });
    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'ap_invoice.import_opening_posted',
      objectType: DOCUMENT_TYPE,
      objectId: invoiceId,
      branchCode: line.branchCode,
      after: {
        invoiceNo: number.documentNo,
        payableNo: line.payableNo,
        supplierCode: line.supplierCode,
        currency: line.currency,
        agreedTxn: line.agreedTxn,
        paidTxn: line.paidTxn,
        leftTxn: line.leftTxn,
        rate: line.rate,
        leftIqd: line.leftIqd,
        openedOn: line.openedOn,
        entryNo: journalPosted.entryNo,
      },
      outcome: 'success',
      requestId: ctx.requestId ?? null,
    });
    applied.push({ ...line, invoiceNo: number.documentNo, invoiceId, entryNo: journalPosted.entryNo });
  }
  return { plan: planned, applied };
}

/**
 * Money that left before the cut-over, confirmed now from the bank's copy
 * (`payment-applications.confirmBeforeCutOver`): the opening counted it as
 * owed, so it comes off — Dr the supplier, Cr the goods — at the opening's own
 * rate and on its own date, so the dollars cancel exactly. Capped at what the
 * opening still owes. Nothing when the import has no opening.
 */
export async function settleBeforeCutOver(
  tx: Tx,
  ctx: ActorContext,
  application: { readonly id: string; readonly applicationNo: string; readonly payableId: string; readonly amountTxn: string },
): Promise<{ invoiceNo: string; amountIqd: string; entryNo: string } | null> {
  const opening = await openingOf(tx, application.payableId);
  if (!opening || !['posted', 'partially_executed'].includes(opening.status)) return null;
  await tx.execute(sql`select id from ap_invoice where id = ${opening.id} for update`);

  const [owner] = await tx
    .select({ payableNo: payable.payableNo, currency: payable.currency, supplierCode: businessPartner.code })
    .from(payable)
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .where(eq(payable.id, application.payableId))
    .limit(1);
  if (!owner) return null;

  const outstanding = parseDecimal(opening.totalIqd, MONEY_SCALE) - parseDecimal(opening.settledAmountIqd, MONEY_SCALE);
  if (outstanding <= 0n) return null;
  const amountTxn = parseDecimal(application.amountTxn, MONEY_SCALE);
  const rate = opening.agreedRate ? parseDecimal(opening.agreedRate, RATE_SCALE) : 10n ** RATE_SCALE;
  const converted = toIqd(amountTxn, rate);
  const amountIqd = converted < outstanding ? converted : outstanding;
  if (amountIqd <= 0n) return null;
  const amount = toDecimalString(amountIqd);

  const line: OpeningLine = {
    payableId: application.payableId,
    payableNo: owner.payableNo,
    reference: null,
    supplierId: opening.supplierId,
    supplierCode: owner.supplierCode,
    supplierName: '',
    branchCode: opening.branchCode,
    currency: owner.currency,
    openedOn: opening.invoiceDate,
    agreedTxn: '0',
    paidTxn: '0',
    leftTxn: application.amountTxn,
    rate: opening.agreedRate ?? '1',
    leftIqd: amount,
    dueDate: null,
  };
  const journalPosted = await posting.post(
    tx,
    ctx,
    journalRequest(line, opening.id, `settled_before_cut_over:${application.applicationNo}`, amount, true),
  );

  await tx.insert(importOpeningSettlement).values({
    apInvoiceId: opening.id,
    kind: 'paid_before_cut_over',
    paymentApplicationId: application.id,
    amountTxn: toDecimalString(amountTxn),
    amountIqd: amount,
    journalEntryId: journalPosted.journalEntryId,
    createdBy: ctx.principal.userId,
  });
  const settled = parseDecimal(opening.settledAmountIqd, MONEY_SCALE) + amountIqd;
  await tx
    .update(apInvoice)
    .set({
      settledAmountIqd: toDecimalString(settled),
      status: settled >= parseDecimal(opening.totalIqd, MONEY_SCALE) ? 'settled' : 'partially_executed',
      updatedAt: new Date(),
    })
    .where(eq(apInvoice.id, opening.id));

  await events.record(tx, {
    payableId: application.payableId,
    eventCode: 'OPENING_SETTLED',
    summary: `${application.applicationNo} was paid before the cut-over — IQD ${amount} off opening balance ${opening.invoiceNo} (${journalPosted.entryNo})`,
    sourceType: DOCUMENT_TYPE,
    sourceId: opening.id,
    sourceNo: opening.invoiceNo,
    after: { applicationNo: application.applicationNo, amountIqd: amount, entryNo: journalPosted.entryNo },
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.import_opening_settled',
    objectType: DOCUMENT_TYPE,
    objectId: opening.id,
    branchCode: opening.branchCode,
    before: { settledAmountIqd: opening.settledAmountIqd, status: opening.status },
    after: { settledAmountIqd: toDecimalString(settled), applicationNo: application.applicationNo, entryNo: journalPosted.entryNo },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { invoiceNo: opening.invoiceNo, amountIqd: amount, entryNo: journalPosted.entryNo };
}

/**
 * The supplier's own invoice for an import whose balance is on the books as
 * its opening, just posted (`ap-invoice.post`). The opening holds what was
 * still owed and the rest was paid before the books opened, so the invoice —
 * up to what the import agreed, less what earlier invoices were already
 * absorbed for — is settled against it: Dr the supplier, Cr the goods, on the
 * invoice's own date. What the import still owes stays the opening's to pay;
 * an invoice for more than the import agreed leaves the excess owing on itself.
 * Nothing for any other invoice (no opening, the opening itself, a debit note).
 */
export async function absorbInvoice(
  tx: Tx,
  ctx: ActorContext,
  invoiceId: string,
): Promise<{ openingNo: string; amountTxn: string; amountIqd: string; entryNo: string } | null> {
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, invoiceId)).limit(1);
  if (!invoice || !invoice.payableId || invoice.isImportOpening || invoice.adjustsInvoiceId) return null;
  if (!['posted', 'partially_executed'].includes(invoice.status)) return null;
  const opening = await openingOf(tx, invoice.payableId);
  if (!opening) return null;

  const [owner] = await tx
    .select({ payableNo: payable.payableNo, currency: payable.currency, agreedTxn: payable.amountTxn, supplierCode: businessPartner.code })
    .from(payable)
    .innerJoin(businessPartner, eq(businessPartner.id, payable.supplierId))
    .where(eq(payable.id, invoice.payableId))
    .limit(1);
  if (!owner) return null;

  const [prior] = await tx
    .select({ txn: sql<string>`coalesce(sum(${importOpeningSettlement.amountTxn}), 0)::text` })
    .from(importOpeningSettlement)
    .where(
      and(
        eq(importOpeningSettlement.apInvoiceId, opening.id),
        eq(importOpeningSettlement.kind, 'absorbed_by_invoice'),
        isNull(importOpeningSettlement.reversedAt),
      ),
    );
  const room = parseDecimal(owner.agreedTxn, MONEY_SCALE) - parseDecimal(prior?.txn ?? '0', MONEY_SCALE);
  const totalIqd = parseDecimal(invoice.totalIqd, MONEY_SCALE);
  const outstanding = totalIqd - parseDecimal(invoice.settledAmountIqd, MONEY_SCALE);
  if (room <= 0n || outstanding <= 0n) return null;

  // The invoice in the import's own currency: at the rate it agreed, else the day's.
  let invoiceTxn = totalIqd;
  if (owner.currency !== 'IQD') {
    const rate =
      invoice.agreedCurrency === owner.currency && invoice.agreedRate
        ? parseDecimal(invoice.agreedRate, RATE_SCALE)
        : (await rates.rateOn(tx, owner.currency, invoice.invoiceDate)).iqdPerUnit;
    invoiceTxn = divideHalfUp(totalIqd * 10n ** RATE_SCALE, rate);
  }
  if (invoiceTxn <= 0n) return null;
  const takenTxn = invoiceTxn < room ? invoiceTxn : room;
  let takenIqd = takenTxn === invoiceTxn ? totalIqd : divideHalfUp(totalIqd * takenTxn, invoiceTxn);
  if (takenIqd > outstanding) takenIqd = outstanding;
  if (takenIqd <= 0n) return null;
  const amount = toDecimalString(takenIqd);

  const journalPosted = await posting.post(
    tx,
    ctx,
    twoLines({
      branchCode: invoice.branchCode,
      supplierCode: owner.supplierCode,
      on: invoice.invoiceDate,
      documentId: invoice.id,
      sourceEvent: 'absorbed_by_opening',
      amountIqd: amount,
      settling: true,
      description: `Purchase invoice ${invoice.invoiceNo} — import ${owner.payableNo}'s debt is already on opening balance ${opening.invoiceNo}`,
    }),
  );
  const settled = parseDecimal(invoice.settledAmountIqd, MONEY_SCALE) + takenIqd;
  await tx
    .update(apInvoice)
    .set({ settledAmountIqd: toDecimalString(settled), status: settled >= totalIqd ? 'settled' : 'partially_executed', updatedAt: new Date() })
    .where(eq(apInvoice.id, invoice.id));
  await tx.insert(importOpeningSettlement).values({
    apInvoiceId: opening.id,
    kind: 'absorbed_by_invoice',
    absorbedInvoiceId: invoice.id,
    amountTxn: toDecimalString(takenTxn),
    amountIqd: amount,
    journalEntryId: journalPosted.journalEntryId,
    createdBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: invoice.payableId,
    eventCode: 'OPENING_ABSORBED',
    summary:
      `Purchase invoice ${invoice.invoiceNo} settled by opening balance ${opening.invoiceNo} — ` +
      `${owner.currency} ${toDecimalString(takenTxn)}, IQD ${amount} (${journalPosted.entryNo}); what is still owed stays on the opening`,
    sourceType: DOCUMENT_TYPE,
    sourceId: invoice.id,
    sourceNo: invoice.invoiceNo,
    after: { openingNo: opening.invoiceNo, amountTxn: toDecimalString(takenTxn), amountIqd: amount, entryNo: journalPosted.entryNo },
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.absorbed_by_import_opening',
    objectType: DOCUMENT_TYPE,
    objectId: invoice.id,
    branchCode: invoice.branchCode,
    before: { settledAmountIqd: invoice.settledAmountIqd, status: invoice.status },
    after: { settledAmountIqd: toDecimalString(settled), openingNo: opening.invoiceNo, amountIqd: amount, entryNo: journalPosted.entryNo },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { openingNo: opening.invoiceNo, amountTxn: toDecimalString(takenTxn), amountIqd: amount, entryNo: journalPosted.entryNo };
}

/**
 * The invoice `absorbInvoice` settled is being reversed (`ap-invoice.reverse`):
 * its settlement by the opening is undone first — the journal reversed, the
 * invoice back to owing — so the reversal can go on. False when the invoice
 * was not absorbed, or when something else rests on it as well (a payment),
 * which the reversal then refuses as it always has.
 */
export async function undoAbsorption(tx: Tx, ctx: ActorContext, invoiceId: string, reason: string): Promise<boolean> {
  const [row] = await tx
    .select()
    .from(importOpeningSettlement)
    .where(and(eq(importOpeningSettlement.absorbedInvoiceId, invoiceId), isNull(importOpeningSettlement.reversedAt)))
    .limit(1);
  if (!row) return false;
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, invoiceId)).limit(1);
  if (!invoice || parseDecimal(invoice.settledAmountIqd, MONEY_SCALE) !== parseDecimal(row.amountIqd, MONEY_SCALE)) return false;

  const [posted] = await tx
    .select({ postingDate: journalEntry.postingDate })
    .from(journalEntry)
    .where(eq(journalEntry.id, row.journalEntryId))
    .limit(1);
  const reversal = await journal.reverse(tx, ctx, row.journalEntryId, {
    reason: `Purchase invoice ${invoice.invoiceNo} reversed: ${reason}`,
    postingDate: journal.reversalPostingDate(posted!.postingDate),
  });
  await tx
    .update(apInvoice)
    .set({ settledAmountIqd: '0', status: 'posted', updatedAt: new Date() })
    .where(eq(apInvoice.id, invoiceId));
  await tx
    .update(importOpeningSettlement)
    .set({ reversedAt: new Date(), reversedBy: ctx.principal.userId, reversalJournalEntryId: reversal.id })
    .where(eq(importOpeningSettlement.id, row.id));

  const [opening] = await tx.select({ invoiceNo: apInvoice.invoiceNo }).from(apInvoice).where(eq(apInvoice.id, row.apInvoiceId)).limit(1);
  if (invoice.payableId) {
    await events.record(tx, {
      payableId: invoice.payableId,
      eventCode: 'OPENING_ABSORPTION_UNDONE',
      summary: `Purchase invoice ${invoice.invoiceNo} is being reversed — its settlement by opening balance ${opening?.invoiceNo ?? ''} undone (${reversal.entryNo})`,
      sourceType: DOCUMENT_TYPE,
      sourceId: invoice.id,
      sourceNo: invoice.invoiceNo,
      after: { reversalEntryNo: reversal.entryNo },
      actorUserId: ctx.principal.userId,
    });
  }
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.import_opening_absorption_undone',
    objectType: DOCUMENT_TYPE,
    objectId: invoiceId,
    branchCode: invoice.branchCode,
    before: { settledAmountIqd: invoice.settledAmountIqd, status: invoice.status },
    after: { settledAmountIqd: '0', status: 'posted', reversalEntryNo: reversal.entryNo },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return true;
}
