/**
 * Customer credits and the notes that make them — the pure rules
 * (Receivables, 2026-10-04).
 *
 * A customer's account holds two kinds of thing that must never be netted on
 * the document level: what they **owe** (an invoice, a debit note — each with
 * a due date, each aged) and what they are **owed** (money received and not
 * yet put against anything, a credit memo's or credit note's remainder). The
 * ledger nets them, because a balance is one number; the documents do not,
 * because "the customer has a -4.9M invoice" is not a sentence anybody can act
 * on. The two meet only when somebody applies one to the other, and that act
 * is what these rules govern.
 */

/** Where a customer's credit comes from. */
export const CREDIT_SOURCE_KINDS = ['receipt', 'credit_memo', 'credit_note'] as const;
export type CreditSourceKind = (typeof CREDIT_SOURCE_KINDS)[number];

/** What a credit can settle. */
export const DEBT_TARGET_KINDS = ['invoice', 'debit_note'] as const;
export type DebtTargetKind = (typeof DEBT_TARGET_KINDS)[number];

export type NoteKind = 'credit' | 'debit';

/** The number series each note is drawn from (migration 0280). */
export function noteSequenceKey(kind: NoteKind): string {
  return kind === 'credit' ? 'CUSTOMER_CREDIT_NOTE' : 'CUSTOMER_DEBIT_NOTE';
}

/** The posting event each note posts under (posting-map.ts). */
export function noteEvent(kind: NoteKind): string {
  return kind === 'credit' ? 'sales.customer_credit_note' : 'sales.customer_debit_note';
}

export function isCreditSourceKind(value: unknown): value is CreditSourceKind {
  return (CREDIT_SOURCE_KINDS as readonly unknown[]).includes(value);
}

export function isDebtTargetKind(value: unknown): value is DebtTargetKind {
  return (DEBT_TARGET_KINDS as readonly unknown[]).includes(value);
}

export class CreditApplicationError extends Error {
  readonly code = 'CREDIT_APPLICATION_REFUSED';

  constructor(message: string) {
    super(message);
    this.name = 'CreditApplicationError';
  }
}

export interface ApplicationCheck {
  readonly sourceNo: string;
  /** What is left on the credit, scaled. */
  readonly remainingIqd: bigint;
  readonly targetNo: string;
  /** What is still owed on the target, scaled. */
  readonly outstandingIqd: bigint;
  /** What this application puts across, scaled. */
  readonly amountIqd: bigint;
  readonly sameCustomer: boolean;
}

/**
 * Both ceilings, and the customer, before anything is written.
 *
 * The same three refusals the receipt's allocation makes — it is the same act
 * from a different source — so the sentences are kept in step with it: a
 * credit cannot give back more than it is for, a debt cannot be settled past
 * zero, and one customer's credit does not pay another's debt.
 */
export function assertApplicable(check: ApplicationCheck): void {
  if (check.amountIqd <= 0n) {
    throw new CreditApplicationError(
      `An application of ${check.sourceNo} to ${check.targetNo} must be for a positive amount.`,
    );
  }
  if (!check.sameCustomer) {
    throw new CreditApplicationError(
      `${check.sourceNo} and ${check.targetNo} belong to different customers. One customer's credit does not settle another's debt (§16).`,
    );
  }
  if (check.amountIqd > check.remainingIqd) {
    throw new CreditApplicationError(
      `${check.sourceNo} has ${formatScaled(check.remainingIqd)} left to apply and this is ${formatScaled(check.amountIqd)}. ` +
        'A credit cannot give back more than it is for.',
    );
  }
  if (check.amountIqd > check.outstandingIqd) {
    throw new CreditApplicationError(
      `${check.targetNo} has ${formatScaled(check.outstandingIqd)} still owed and this is ${formatScaled(check.amountIqd)}. ` +
        'Credit beyond what is owed stays on the account as a credit; it does not make the debt negative.',
    );
  }
}

/**
 * How much of a credit note goes onto the invoice it corrects when it posts.
 *
 * All of it while the invoice still owes that much; otherwise what the
 * invoice still owes, and the rest stays on the account as the customer's
 * credit — the same rule the Sales Return's credit memo follows.
 */
export function creditOnPosting(noteAmountIqd: bigint, invoiceOutstandingIqd: bigint): bigint {
  if (invoiceOutstandingIqd <= 0n) return 0n;
  return noteAmountIqd < invoiceOutstandingIqd ? noteAmountIqd : invoiceOutstandingIqd;
}

/** Days late, from the due date to the day the money arrived; never negative. */
export function daysLate(dueDate: string, paidOn: string): number {
  const due = Date.UTC(+dueDate.slice(0, 4), +dueDate.slice(5, 7) - 1, +dueDate.slice(8, 10));
  const paid = Date.UTC(+paidOn.slice(0, 4), +paidOn.slice(5, 7) - 1, +paidOn.slice(8, 10));
  return Math.max(0, Math.round((paid - due) / 86_400_000));
}

/** 4-decimal scaled money, for a message — never for a figure that is stored. */
function formatScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10_000n;
  const fraction = abs % 10_000n;
  const text = fraction === 0n ? whole.toString() : `${whole}.${fraction.toString().padStart(4, '0').replace(/0+$/, '')}`;
  return `${negative ? '-' : ''}${text}`;
}
