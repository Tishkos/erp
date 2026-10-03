/**
 * The exchange difference of an import — REQ-FIX-001 FX8 (D-FX-4).
 *
 * An import agreed in a foreign currency is paid in that currency, each
 * payment turned into dinars at the rate of its day, while its purchase
 * invoices are kept in dinars. When the last payment makes the import *Fully
 * paid* in its own currency, the dinars rarely land exactly: the invoices
 * still owe a little (the rate rose — fewer dinars paid than invoiced) or a
 * payment is left over them (the rate fell). Before this the residual stayed
 * on the invoice as *part paid*, or as an unallocated payment, while the
 * import read *Fully paid* and could clear.
 *
 * `settle` closes it, once, in the import's transaction:
 *
 *   1. anything the import still holds is put against what it still owes —
 *      its paid deposits, then the unallocated part of its own payments;
 *   2. what the invoices still owe is a **gain**: Dr supplier payable,
 *      Cr exchange gain;
 *   3. what a payment or deposit is still over them is a **loss**: Dr
 *      exchange loss, Cr supplier payable (or the advance account, for a
 *      deposit never used);
 *
 * one journal, one `payable_exchange_difference` row per document it closes,
 * an `EXCHANGE_DIFFERENCE` event on the import. The gain and loss accounts are
 * Finance's to map (`payables.exchange_difference`); until they are, the
 * posting refuses with the role's name — `settleIfFullyPaid` catches that so
 * the payment that triggered it still confirms, and records that the
 * difference is waiting.
 *
 * An import agreed in dinars has no exchange difference: its agreed amount is
 * its invoices' (FX7), so *Fully paid* there means the invoices are paid.
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { apInvoice, businessPartner, paymentApplication, payableExchangeDifference, supplierAdvance, supplierPayment } from '../db/schema';
import { NoPostingRuleError } from '../domain/posting';
import { parseDecimal, toDecimalString } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as advances from './supplier-advance';
import * as events from './payable-events';
import * as payables from './payables';
import * as payments from './supplier-payment';
import * as posting from './posting';

export const EVENT_TYPE = 'payables.exchange_difference';
const DOCUMENT_TYPE = 'payable_exchange_difference';

export interface Residual {
  /** What the import's posted invoices still owe, in dinars. */
  readonly owedIqd: bigint;
  /** What its payments are still over them, unallocated, in dinars. */
  readonly overpaidIqd: bigint;
  /** What its paid deposits still hold, unapplied, in dinars. */
  readonly unusedDepositIqd: bigint;
}

async function invoicesOf(tx: Tx, payableId: string) {
  return tx
    .select()
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), inArray(apInvoice.status, ['posted', 'partially_executed']), isNull(apInvoice.reversedAt)))
    .orderBy(asc(apInvoice.invoiceDate), asc(apInvoice.invoiceNo));
}

async function paymentsOf(tx: Tx, payableId: string) {
  return tx
    .select({ payment: supplierPayment })
    .from(paymentApplication)
    .innerJoin(supplierPayment, eq(supplierPayment.id, paymentApplication.supplierPaymentId))
    .where(and(eq(paymentApplication.payableId, payableId), inArray(paymentApplication.status, ['confirmed', 'debited']), eq(supplierPayment.status, 'posted')))
    .orderBy(asc(supplierPayment.paymentDate), asc(supplierPayment.paymentNo))
    .then((rows) => rows.map((row) => row.payment));
}

async function depositsOf(tx: Tx, payableId: string) {
  return tx
    .select()
    .from(supplierAdvance)
    .where(and(eq(supplierAdvance.payableId, payableId), inArray(supplierAdvance.status, ['posted', 'partially_executed'])))
    .orderBy(asc(supplierAdvance.paidDate), asc(supplierAdvance.createdAt));
}

/** What would close, read without moving anything — for the import's page. */
export async function residualOf(tx: Tx, payableId: string): Promise<Residual> {
  const owedIqd = (await invoicesOf(tx, payableId)).reduce((sum, invoice) => sum + payments.outstandingOn(invoice), 0n);
  const overpaidIqd = (await paymentsOf(tx, payableId)).reduce((sum, payment) => sum + payments.unallocatedOn(payment), 0n);
  const unusedDepositIqd = (await depositsOf(tx, payableId)).reduce((sum, deposit) => sum + advances.availableBalance(deposit), 0n);
  return { owedIqd, overpaidIqd, unusedDepositIqd };
}

/** Whether an import is one this applies to and there is something to close. */
export function isOpen(currency: string, residual: Residual): boolean {
  return currency !== 'IQD' && (residual.owedIqd > 0n || residual.overpaidIqd > 0n || residual.unusedDepositIqd > 0n);
}

/**
 * Closes the import's exchange difference. The caller has established the
 * import is fully paid in its currency (`payment-applications.totalsFor`).
 */
export async function settle(tx: Tx, ctx: ActorContext, payableId: string, on: string): Promise<{ gainIqd: bigint; lossIqd: bigint; journalEntryId: string } | null> {
  const owner = await payables.load(tx, payableId);
  if (owner.currency === 'IQD') return null;

  // 1 — what the import still holds goes against what it still owes.
  for (const invoice of await invoicesOf(tx, payableId)) await advances.applyToPostedInvoice(tx, ctx, invoice.id);
  for (const payment of await paymentsOf(tx, payableId)) {
    let left = payments.unallocatedOn(payment);
    for (const invoice of await invoicesOf(tx, payableId)) {
      if (left <= 0n) break;
      const owed = payments.outstandingOn(invoice);
      if (owed <= 0n) continue;
      const share = owed < left ? owed : left;
      await payments.allocate(tx, ctx, { supplierPaymentId: payment.id, apInvoiceId: invoice.id, amountIqd: share });
      left -= share;
    }
  }

  // 2, 3 — what is left is the exchange difference.
  const owing = (await invoicesOf(tx, payableId)).filter((invoice) => payments.outstandingOn(invoice) > 0n);
  const over = (await paymentsOf(tx, payableId)).filter((payment) => payments.unallocatedOn(payment) > 0n);
  const unused = (await depositsOf(tx, payableId)).filter((deposit) => advances.availableBalance(deposit) > 0n);
  const gainIqd = owing.reduce((sum, invoice) => sum + payments.outstandingOn(invoice), 0n);
  const overIqd = over.reduce((sum, payment) => sum + payments.unallocatedOn(payment), 0n);
  const unusedIqd = unused.reduce((sum, deposit) => sum + advances.availableBalance(deposit), 0n);
  const lossIqd = overIqd + unusedIqd;
  if (gainIqd === 0n && lossIqd === 0n) return null;

  const [supplier] = await tx.select({ code: businessPartner.code }).from(businessPartner).where(eq(businessPartner.id, owner.supplierId)).limit(1);
  const criteria = { branchCode: owner.branchCode };
  const dimensions = { branch: owner.branchCode, business_partner: supplier?.code ?? null };
  const money = (value: bigint) => toDecimalString(value, 4n);
  // The gain or loss is a result line: it carries the import's department
  // when it names one, as the result accounts usually require.
  const resultDimensions = { branch: owner.branchCode, ...(owner.departmentCode ? { department: owner.departmentCode } : {}) };
  const lines = [
    ...(gainIqd > 0n
      ? [
          { role: 'supplier_payable', debit: money(gainIqd), criteria, dimensions, description: `${owner.payableNo} — invoices closed at the paid rate` },
          { role: 'exchange_gain', credit: money(gainIqd), criteria, dimensions: resultDimensions },
        ]
      : []),
    ...(overIqd > 0n ? [{ role: 'supplier_payable', credit: money(overIqd), criteria, dimensions, description: `${owner.payableNo} — paid over the invoices` }] : []),
    ...(unusedIqd > 0n ? [{ role: 'supplier_advance', credit: money(unusedIqd), criteria, dimensions, description: `${owner.payableNo} — deposit not used` }] : []),
    ...(lossIqd > 0n ? [{ role: 'exchange_loss', debit: money(lossIqd), criteria, dimensions: resultDimensions }] : []),
  ];

  const result = await posting.post(tx, ctx, {
    eventType: EVENT_TYPE,
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'payables', documentId: payableId, event: 'exchange_difference' },
    branchCode: owner.branchCode,
    documentDate: on,
    postingDate: on,
    description: `Exchange difference — ${owner.payableNo} (${owner.currency})`,
    lines,
  });

  const recorded: (typeof payableExchangeDifference.$inferInsert)[] = [];
  for (const invoice of owing) {
    const amount = payments.outstandingOn(invoice);
    await tx.update(apInvoice).set({ settledAmountIqd: invoice.totalIqd, status: 'settled', updatedAt: new Date() }).where(eq(apInvoice.id, invoice.id));
    recorded.push({
      payableId,
      kind: 'gain',
      sourceType: 'ap_invoice',
      sourceId: invoice.id,
      sourceNo: invoice.invoiceNo,
      amountIqd: money(amount),
      journalEntryId: result.journalEntryId,
      createdBy: ctx.principal.userId,
    });
  }
  for (const payment of over) {
    const amount = payments.unallocatedOn(payment);
    await tx.update(supplierPayment).set({ allocatedAmountIqd: payment.amountIqd, updatedAt: new Date() }).where(eq(supplierPayment.id, payment.id));
    recorded.push({
      payableId,
      kind: 'loss',
      sourceType: 'supplier_payment',
      sourceId: payment.id,
      sourceNo: payment.paymentNo,
      amountIqd: money(amount),
      journalEntryId: result.journalEntryId,
      createdBy: ctx.principal.userId,
    });
  }
  for (const deposit of unused) {
    const amount = advances.availableBalance(deposit);
    await tx
      .update(supplierAdvance)
      .set({ settledAmountIqd: toDecimalString(parseDecimal(deposit.settledAmountIqd, 4n) + amount, 4n), status: 'settled', updatedAt: new Date() })
      .where(eq(supplierAdvance.id, deposit.id));
    recorded.push({
      payableId,
      kind: 'loss',
      sourceType: 'supplier_advance',
      sourceId: deposit.id,
      sourceNo: deposit.advanceNo,
      amountIqd: money(amount),
      journalEntryId: result.journalEntryId,
      createdBy: ctx.principal.userId,
    });
  }
  await tx.insert(payableExchangeDifference).values(recorded);

  const parts = [gainIqd > 0n ? `gain ${money(gainIqd)} IQD` : null, lossIqd > 0n ? `loss ${money(lossIqd)} IQD` : null].filter(Boolean).join(', ');
  await events.record(tx, {
    payableId,
    eventCode: 'EXCHANGE_DIFFERENCE',
    summary: `Exchange difference booked — ${parts}; the invoices and payments of ${owner.payableNo} are closed in dinars`,
    sourceType: DOCUMENT_TYPE,
    sourceId: payableId,
    sourceNo: owner.payableNo,
    after: { gainIqd: money(gainIqd), lossIqd: money(lossIqd), journalEntryId: result.journalEntryId },
    actorUserId: ctx.principal.userId,
  });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.exchange_difference',
    objectType: payables.PERMISSION_OBJECT,
    objectId: payableId,
    branchCode: owner.branchCode,
    after: { gainIqd: money(gainIqd), lossIqd: money(lossIqd), journalEntryId: result.journalEntryId },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { gainIqd, lossIqd, journalEntryId: result.journalEntryId };
}

/**
 * Called by `payment-applications.confirm` once an import is fully paid. The
 * difference is booked in a savepoint: when Finance has not mapped the
 * exchange accounts yet the posting refuses, the savepoint rolls back, the
 * payment still confirms, and the import says the difference is waiting —
 * the Settle exchange difference action on its page books it once mapped.
 */
export async function settleIfFullyPaid(tx: Tx, ctx: ActorContext, payableId: string, on: string): Promise<'settled' | 'nothing' | 'waiting'> {
  try {
    const done = await tx.transaction((savepoint) => settle(savepoint as unknown as Tx, ctx, payableId, on));
    return done ? 'settled' : 'nothing';
  } catch (error) {
    if (!(error instanceof NoPostingRuleError)) throw error;
    const owner = await payables.load(tx, payableId);
    await events.record(tx, {
      payableId,
      eventCode: 'EXCHANGE_DIFFERENCE',
      summary: `Exchange difference waits — ${owner.payableNo} is fully paid in ${owner.currency}; map “${error.lineRole}” for “Import exchange difference” on Posting Mappings, then settle it on this page`,
      actorUserId: ctx.principal.userId,
    });
    return 'waiting';
  }
}
