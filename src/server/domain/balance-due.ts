/**
 * The balance's due date, once there is one — by direction 2026-10-07:
 *
 *   "Don't show the due date until we get the SWIFT … for an advance payment,
 *    the rest of the payment should be completed and the SWIFT received, and
 *    then we can decide the due date. Once the payment application is done,
 *    clicking the import application, a dialog comes up: enter the due date,
 *    and it marks it."
 *
 * `ap_invoice.due_date` cannot be empty (it carries the entry day by default);
 * `due_date_set_at` (0272) says somebody set it on purpose — on the import's
 * dialog, on the invoice, or by writing it on the document as it was raised.
 * Until then the invoice has no due date: nothing shows one, nothing ages it as
 * late, nothing tells anybody it is due or overdue. Ageing puts it in "Not yet
 * due", which is what it is.
 *
 * Pure: the screens, the ageing, the sweeps and the tests ask the same rules.
 */
import { MONEY_SCALE, parseDecimal } from './money';

/** The due date a purchase invoice really has: its date once set, otherwise none. */
export function knownDueDate(dueDate: string | null | undefined, setAt: Date | string | null | undefined): string | null {
  return setAt && dueDate ? dueDate : null;
}

/** Statuses of an invoice that is a real debt: posted and not yet settled or reversed. */
const OWING_STATUSES: ReadonlySet<string> = new Set(['posted', 'partially_executed']);
/** Statuses of an invoice that still counts on its import (a reversed one is owed to nobody). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['draft', 'submitted', 'approved', 'posted', 'partially_executed', 'settled']);

export interface ImportInvoiceFacts {
  readonly id: string;
  readonly invoiceNo: string;
  readonly invoiceDate: string;
  readonly status: string;
  readonly dueDate: string;
  readonly dueDateSetAt: Date | string | null;
  readonly totalIqd: string;
  readonly settledAmountIqd: string;
}

/** What is still owed on an invoice, at the money scale; never below nothing. */
export function owedOn(invoice: Pick<ImportInvoiceFacts, 'totalIqd' | 'settledAmountIqd'>): bigint {
  const owed = parseDecimal(invoice.totalIqd, MONEY_SCALE) - parseDecimal(invoice.settledAmountIqd, MONEY_SCALE);
  return owed > 0n ? owed : 0n;
}

/** A posted invoice with something still owed and no due date set: the balance waiting for its date. */
export function waitsForDueDate(invoice: ImportInvoiceFacts): boolean {
  return OWING_STATUSES.has(invoice.status) && owedOn(invoice) > 0n && !invoice.dueDateSetAt;
}

/**
 * The import application's due date, read from its invoices.
 *
 * The import keeps its own `due_date`, which `ap-invoice.setDueDate` moves with
 * the invoice's; but an import opened by its invoice was given the invoice's
 * default too. So an import with live invoices has a due date when one of them
 * was set on purpose, and otherwise waits for it; an import raised on its own
 * (no invoice behind it yet) has whatever date was typed on it, or none.
 */
export function importDueDate(
  payableDueDate: string | null | undefined,
  invoices: readonly Pick<ImportInvoiceFacts, 'status' | 'dueDate' | 'dueDateSetAt'>[],
): { readonly date: string | null; readonly waiting: boolean } {
  const live = invoices.filter((invoice) => LIVE_STATUSES.has(invoice.status));
  if (live.length === 0) return { date: payableDueDate ?? null, waiting: false };
  const set = live.filter((invoice) => invoice.dueDateSetAt);
  if (set.length === 0) return { date: null, waiting: true };
  // The import's own column is what `setDueDate` wrote last; failing that, the earliest set.
  const dates = set.map((invoice) => invoice.dueDate).sort();
  return { date: payableDueDate && dates.includes(payableDueDate) ? payableDueDate : dates[0]!, waiting: false };
}

export interface PaidApplication {
  readonly applicationNo: string;
  readonly status: string;
  readonly confirmedOn: string | null;
  readonly amountTxn: string;
  readonly currency: string;
}

/** A payment application whose money has left: the paid paper (the SWIFT) was attached. */
export function isPaidApplication(application: Pick<PaidApplication, 'status'>): boolean {
  return application.status === 'confirmed' || application.status === 'debited';
}

export interface PromptFacts {
  readonly applications: readonly PaidApplication[];
  readonly invoices: readonly ImportInvoiceFacts[];
  /** `edit_draft` on `ap_invoice` — the grant `ap-invoice.setDueDate` asks. */
  readonly maySet: boolean;
  /** A cancelled or closed import asks nobody for anything. */
  readonly open: boolean;
}

export interface PromptState {
  /** The SWIFT is in and a balance waits for its date: the import page asks. */
  readonly due: boolean;
  /** …and this reader may answer: the dialog opens by itself and the banner has its button. */
  readonly ask: boolean;
  /** The application whose paid paper made the question (the latest paid). */
  readonly paid: PaidApplication | null;
  /** The invoices the date will be set on: posted, still owing, no due date. */
  readonly waiting: readonly ImportInvoiceFacts[];
  /** What those invoices still owe, at the money scale. */
  readonly owedIqd: bigint;
  /** The earliest date allowed: none of the invoices may fall due before its own date. */
  readonly earliest: string | null;
}

/**
 * The prompt's condition, all three at once: at least one payment application
 * of the import is paid (the SWIFT received), an invoice of the import still
 * owes something and has no due date, and the reader holds the grant that sets
 * one. `due` without `ask` is the "Waiting for the due date" line.
 */
export function promptState(facts: PromptFacts): PromptState {
  const paid = facts.applications
    .filter(isPaidApplication)
    .reduce<PaidApplication | null>((latest, one) => (latest === null || (one.confirmedOn ?? '') >= (latest.confirmedOn ?? '') ? one : latest), null);
  const waiting = facts.invoices.filter(waitsForDueDate);
  const due = facts.open && paid !== null && waiting.length > 0;
  return {
    due,
    ask: due && facts.maySet,
    paid,
    waiting,
    owedIqd: waiting.reduce((sum, invoice) => sum + owedOn(invoice), 0n),
    earliest: waiting.reduce<string | null>((latest, invoice) => (latest === null || invoice.invoiceDate > latest ? invoice.invoiceDate : latest), null),
  };
}

/**
 * The refusal the dialog shows before anything is written: a due date before
 * an invoice's own date (the service refuses it too; this says which invoice).
 */
export function refusalFor(dueDate: string, waiting: readonly Pick<ImportInvoiceFacts, 'invoiceNo' | 'invoiceDate'>[]): { readonly code: 'not_a_date' } | { readonly code: 'before_invoice'; readonly invoiceNo: string; readonly invoiceDate: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) return { code: 'not_a_date' };
  const before = waiting.find((invoice) => dueDate < invoice.invoiceDate);
  return before ? { code: 'before_invoice', invoiceNo: before.invoiceNo, invoiceDate: before.invoiceDate } : null;
}
