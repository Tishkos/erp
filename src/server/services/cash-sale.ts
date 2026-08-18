/**
 * Cash Sale — Phase 06.8, §7.4.
 *
 * > *"Cash Sales use the same inventory and invoice controls and record
 * > immediate cash or bank settlement."*
 *
 * The whole sub-phase is that one sentence, and the design follows from taking
 * *"the same … controls"* literally: a cash sale is **not a different document**.
 * It is the ordinary sale — Sales Order, reservation, Pick List, Delivery Note,
 * A/R Invoice — with the settlement recorded in the same transaction as the
 * invoice's posting.
 *
 * So this file is deliberately thin, and that thinness is the feature. There is
 * no cash-sale pricing, no cash-sale stock check and no cash-sale invoice
 * numbering, because the moment any of those existed they would be a second
 * implementation of a control that §7.7 requires to be unbypassable. §24 says it
 * plainly: *"duplicating these mechanisms inside each module will create
 * inconsistent controls and expensive maintenance."*
 *
 * What is left is the settlement, which is a Customer Receipt — Appendix B gives
 * one type for both, *"Customer Receipt / Cash Sale Receipt"*.
 *
 * **Atomic by construction.** `postAndSettle` posts the invoice and the receipt
 * in the caller's transaction, so the 06.8 gate *"settlement posts in the same
 * transaction as the invoice"* is not a promise the caller has to keep. A cash
 * sale where the goods left and the money was never recorded cannot exist,
 * because there is no path that does one without the other.
 */
import { eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { arInvoice, customerReceipt } from '../db/schema';
import { parseDecimal, toDecimalString } from '../domain/money';
import { openBalance } from '../domain/ar-invoicing';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as arInvoiceService from './ar-invoice';
import * as receipts from './customer-receipt';

export interface CashSaleSettlement {
  /** Which bank or cash account took the money. */
  readonly bankCashAccountId: string;
  /** The slip, cheque or transfer reference (§16). */
  readonly bankReference?: string | null;
  readonly note?: string | null;
}

export class NotFullySettledError extends Error {
  readonly code = 'CASH_SALE_NOT_SETTLED';

  constructor(
    readonly invoiceNo: string,
    readonly openIqd: bigint,
  ) {
    super(
      `Cash sale ${invoiceNo} would leave ${toDecimalString(openIqd, 4n)} outstanding. ` +
        '§7.4 records *immediate* settlement, so a cash sale leaves no A/R balance — ' +
        'a sale that is only part paid is a credit sale with a receipt against it.',
    );
    this.name = 'NotFullySettledError';
  }
}

/**
 * Posts an approved A/R Invoice and settles it in full, in one transaction.
 *
 * The invoice is posted first because the receipt allocates *to* it: the
 * allocation needs an invoice with a balance, and the balance is what posting
 * creates. Both happen in the caller's transaction, so there is no state in
 * which one has happened and the other has not.
 */
export async function postAndSettle(
  tx: Tx,
  ctx: ActorContext,
  arInvoiceId: string,
  settlement: CashSaleSettlement,
): Promise<{
  journalEntryId: string;
  receiptId: string;
  receiptNo: string;
  receiptJournalEntryId: string;
}> {
  // 1. The invoice, through exactly the same path a credit sale takes.
  const posted = await arInvoiceService.post(tx, ctx, arInvoiceId);

  const [invoice] = await tx
    .select()
    .from(arInvoice)
    .where(eq(arInvoice.id, arInvoiceId))
    .limit(1);

  const amount = parseDecimal(invoice!.netIqd, 4n);

  // 2. The settlement, through exactly the same path a later receipt takes.
  const receipt = await receipts.create(tx, ctx, {
    customerId: invoice!.customerId,
    branchCode: invoice!.branchCode,
    // §7.4 — *immediate*. The money arrives on the day of the sale, which is
    // the day of the delivery, which is the invoice date.
    receiptDate: invoice!.invoiceDate,
    bankCashAccountId: settlement.bankCashAccountId,
    amountIqd: amount,
    bankReference: settlement.bankReference ?? null,
    currency: invoice!.currency,
    cashSaleInvoiceId: arInvoiceId,
    note: settlement.note ?? `Cash sale settlement for ${invoice!.invoiceNo}`,
  });

  await receipts.approve(tx, ctx, receipt.id);
  const receiptPosting = await receipts.post(tx, ctx, receipt.id);

  // 3. Applied in full, so the invoice closes. The allocation goes through the
  //    ordinary path too, which is what keeps the two ceilings in §16 honest.
  await receipts.allocate(tx, ctx, receipt.id, [
    { arInvoiceId, amountIqd: amount, note: 'Cash sale — settled on issue (§7.4)' },
  ]);

  const [settled] = await tx
    .select()
    .from(arInvoice)
    .where(eq(arInvoice.id, arInvoiceId))
    .limit(1);

  const open = openBalance({
    totalIqd: parseDecimal(settled!.netIqd, 4n),
    allocatedIqd: parseDecimal(settled!.allocatedIqd, 4n),
  });

  // The 06.8 gate, asserted rather than assumed: a cash sale leaves no open A/R
  // balance. If arithmetic somewhere left a dinar behind, the whole transaction
  // rolls back rather than shipping goods against an invisible debt.
  if (open > 0n) {
    throw new NotFullySettledError(settled!.invoiceNo, open);
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ar_invoice.cash_settled',
    objectType: arInvoiceService.PERMISSION_OBJECT,
    objectId: arInvoiceId,
    branchCode: invoice!.branchCode,
    outcome: 'success',
    after: {
      invoiceNo: invoice!.invoiceNo,
      receiptNo: receipt.receiptNo,
      amountIqd: toDecimalString(amount, 4n),
      invoiceJournalEntryId: posted.journalEntryId,
      receiptJournalEntryId: receiptPosting.journalEntryId,
    },
  });

  return {
    journalEntryId: posted.journalEntryId,
    receiptId: receipt.id,
    receiptNo: receipt.receiptNo,
    receiptJournalEntryId: receiptPosting.journalEntryId,
  };
}

/**
 * Whether an invoice was settled as a cash sale, and by which receipt.
 *
 * A question the Sales Dashboard asks and the A/R ageing needs the answer to:
 * a cash sale never appears in collections, and a report that had to infer it
 * from a zero balance would also catch every credit invoice that happened to be
 * paid on time.
 */
export async function settlementFor(tx: Tx, arInvoiceId: string) {
  const [receipt] = await tx
    .select()
    .from(customerReceipt)
    .where(eq(customerReceipt.cashSaleInvoiceId, arInvoiceId))
    .limit(1);

  return receipt ?? null;
}
