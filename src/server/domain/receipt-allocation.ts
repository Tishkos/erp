/**
 * §16 receipt allocation — Phase 06.10, and the mechanism 06.8's cash sale
 * settles through.
 *
 * > §16: *"Receipt allocation cannot exceed invoice or available receipt
 * > balance."*
 * > §16: *"Unidentified receipts remain in a clearing account until resolved."*
 * > §16 acceptance 2: *"Receipt allocation supports one-to-many and many-to-one
 * > matching."*
 *
 * The last of those needs no code at all, which is worth saying out loud: an
 * allocation is a row joining one receipt to one invoice with an amount, so one
 * receipt across five invoices is five rows and five receipts against one
 * invoice is five rows. Modelling "one-to-many" as a special case would be
 * inventing a distinction the accounting does not have.
 *
 * What *does* need care is the two-sided ceiling. Money can be over-applied from
 * either end — an invoice can be over-paid, and a receipt can be over-allocated
 * — and the two are different mistakes with different corrections, so they get
 * different messages.
 *
 * Pure. Money is scaled at 10^4.
 */
import { toDecimalString } from './money';

export interface ReceiptPosition {
  readonly amountIqd: bigint;
  readonly allocatedIqd: bigint;
}

export class ReceiptOverAllocatedError extends Error {
  readonly code = 'RECEIPT_OVER_ALLOCATED';

  constructor(
    readonly receiptNo: string,
    readonly unapplied: bigint,
    readonly allocating: bigint,
  ) {
    super(
      `Receipt ${receiptNo} has ${toDecimalString(unapplied, 4n)} left to apply, and this allocation is ` +
        `${toDecimalString(allocating, 4n)}. A receipt cannot pay out more than the customer paid in — ` +
        'apply less, or record the rest as a second receipt (§16).',
    );
    this.name = 'ReceiptOverAllocatedError';
  }
}

export class UnidentifiedReceiptError extends Error {
  readonly code = 'RECEIPT_UNIDENTIFIED';

  constructor(readonly receiptNo: string) {
    super(
      `Receipt ${receiptNo} has no customer, so it cannot be allocated to an invoice. ` +
        'Money that arrives without a payer sits in the clearing account until somebody works out ' +
        'whose it is (§16); identify the customer first, and the clearing balance moves with it.',
    );
    this.name = 'UnidentifiedReceiptError';
  }
}

/** What a receipt still has to give. Never negative. */
export function unapplied(position: ReceiptPosition): bigint {
  const remaining = position.amountIqd - position.allocatedIqd;
  return remaining > 0n ? remaining : 0n;
}

/**
 * §16 — *"Receipt allocation cannot exceed … available receipt balance."*
 *
 * The invoice side of the same rule lives in `domain/ar-invoicing.ts`, next to
 * the invoice's own balance. Both are checked on every allocation: an allocation
 * that satisfied one and not the other would leave either an over-paid invoice
 * or a receipt that had paid out money nobody sent.
 */
export function assertWithinReceipt(
  receiptNo: string,
  position: ReceiptPosition,
  allocating: bigint,
): void {
  if (allocating <= 0n) {
    throw new RangeError(
      `An allocation from ${receiptNo} must be positive. Applying nothing is not applying.`,
    );
  }

  const available = unapplied(position);
  if (allocating > available) {
    throw new ReceiptOverAllocatedError(receiptNo, available, allocating);
  }
}

/**
 * Appendix B — a receipt is *Posted* until every dinar of it is applied, and
 * *Allocated* after.
 *
 * Derived from the money, like the invoice's Paid. Appendix B gives the receipt
 * no partial state, so a half-applied receipt is still Posted and the unapplied
 * balance is a figure rather than a status — the same reading Appendix B's Pick
 * List gets for a short pick.
 */
export function receiptStatusFor(position: ReceiptPosition): 'posted' | 'settled' {
  return position.allocatedIqd >= position.amountIqd ? 'settled' : 'posted';
}

/**
 * Whether this receipt's credit goes to the customer or to the clearing account.
 *
 * §16: *"Unidentified receipts remain in a clearing account until resolved."*
 * Money in the bank is a fact whatever else is unknown, so the debit is always
 * the bank. What is unknown is who it belongs to — so the credit is the thing
 * that moves, and it moves to a clearing account that somebody has to empty.
 */
export function creditRoleFor(customerId: string | null | undefined):
  | 'customer_receivable'
  | 'customer_clearing' {
  return customerId ? 'customer_receivable' : 'customer_clearing';
}

/** What the plan needs to know about an invoice. Both sides supply the same. */
export interface AllocatableInvoice {
  readonly id: string;
  readonly dueDate: string;
  /** The invoice's own date, which breaks a tie between two due on one day. */
  readonly invoiceDate?: string | undefined;
  /** Its number, which breaks the tie after that. Two never share one. */
  readonly invoiceNo?: string | undefined;
  readonly openIqd: bigint;
}

/**
 * Oldest first, and the same order every time.
 *
 * Due date, then the invoice's own date, then its number. The first is the
 * rule; the other two exist because two invoices raised on one day fall due on
 * one day, and a plan that put a different one first depending on the order
 * the database happened to return them is a plan nobody can check twice.
 */
export function oldestFirst(
  invoices: readonly AllocatableInvoice[],
): AllocatableInvoice[] {
  const rank = (a: string | undefined, b: string | undefined) =>
    a === b ? 0 : (a ?? '') < (b ?? '') ? -1 : 1;
  return [...invoices]
    .filter((invoice) => invoice.openIqd > 0n)
    .sort(
      (a, b) =>
        rank(a.dueDate, b.dueDate) ||
        rank(a.invoiceDate, b.invoiceDate) ||
        rank(a.invoiceNo, b.invoiceNo),
    );
}

/**
 * A plan for spreading one receipt across several invoices, oldest first.
 *
 * ── Why oldest first ──────────────────────────────────────────────────────
 * It is what the money means. A customer with a 50,000 invoice from Monday and
 * a 100,000 from Tuesday who pays 50,000 has paid Monday's; pay 100,000 and
 * Monday is settled and Tuesday is half done. Applying it any other way leaves
 * the oldest debt ageing on a report while a newer one is marked paid, and the
 * ageing is then a description of the allocation rather than of the account.
 *
 * ── Why it is still a proposal ────────────────────────────────────────────
 * §16 supports many-to-one and one-to-many matching, and a customer who says
 * *"this pays March's invoice"* must be able to say so. So this is what the
 * screen offers and what one button applies — not something the posting does
 * behind the clerk's back, because an allocation cannot be taken back a row at
 * a time.
 */
export function proposeAllocation(
  receipt: ReceiptPosition,
  invoices: readonly AllocatableInvoice[],
): { readonly arInvoiceId: string; readonly amountIqd: bigint }[] {
  let remaining = unapplied(receipt);
  const plan: { arInvoiceId: string; amountIqd: bigint }[] = [];

  for (const invoice of oldestFirst(invoices)) {
    if (remaining <= 0n) break;
    const amount = invoice.openIqd < remaining ? invoice.openIqd : remaining;
    plan.push({ arInvoiceId: invoice.id, amountIqd: amount });
    remaining -= amount;
  }

  return plan;
}
