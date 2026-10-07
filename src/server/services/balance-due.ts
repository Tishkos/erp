/**
 * The balance's due date, asked for once the SWIFT is in — by direction
 * 2026-10-07 ("once the payment application is done, clicking the import
 * application, a dialog comes up: enter the due date, and it marks it").
 *
 * The rules are `domain/balance-due.ts`; this reads the facts they need for one
 * import (its payment applications, its invoices, who set a date and when) and
 * writes the date through `ap-invoice.setDueDate` — the one writer of a due
 * date, audited and evented on the import as it always was. Nothing here posts
 * or moves an amount.
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { apInvoice, appUser, auditEvent, payable, paymentApplication } from '../db/schema';
import { can, type Principal } from '../domain/permissions';
import { promptState, refusalFor, type ImportInvoiceFacts, type PromptState } from '../domain/balance-due';
import type { ActorContext } from './chart-of-accounts';
import * as ap from './ap-invoice';

/** The grant that sets a due date — what `ap-invoice.setDueDate` authorises. */
export const SET_VERB = 'edit_draft' as const;

/** Who set a due date, and when — from the audit row `ap_invoice.due_date_set`. */
export interface DueDateMark {
  readonly invoiceId: string;
  readonly dueDate: string;
  readonly byName: string | null;
  readonly at: string;
}

/**
 * The latest `ap_invoice.due_date_set` of each invoice, with the actor's name.
 * Falls back to `due_date_set_at` (no name) for a date written on the document
 * as it was raised, which no setting audited.
 */
export async function marksFor(
  tx: Tx,
  invoices: readonly { readonly id: string; readonly dueDate: string; readonly dueDateSetAt: Date | string | null }[],
): Promise<Map<string, DueDateMark>> {
  const set = invoices.filter((invoice) => invoice.dueDateSetAt);
  const marks = new Map<string, DueDateMark>();
  if (set.length === 0) return marks;
  const rows = await tx
    .select({ objectId: auditEvent.objectId, at: auditEvent.occurredAt, byName: appUser.displayName })
    .from(auditEvent)
    .leftJoin(appUser, eq(appUser.id, auditEvent.actorUserId))
    .where(
      and(
        eq(auditEvent.action, 'ap_invoice.due_date_set'),
        eq(auditEvent.objectType, ap.PERMISSION_OBJECT),
        inArray(
          auditEvent.objectId,
          set.map((invoice) => invoice.id),
        ),
      ),
    )
    .orderBy(desc(auditEvent.occurredAt));
  for (const invoice of set) {
    const row = rows.find((one) => one.objectId === invoice.id);
    marks.set(invoice.id, {
      invoiceId: invoice.id,
      dueDate: invoice.dueDate,
      byName: row?.byName ?? null,
      at: new Date(row?.at ?? invoice.dueDateSetAt!).toISOString(),
    });
  }
  return marks;
}

export interface ImportDuePrompt extends PromptState {
  readonly payableId: string;
  readonly payableNo: string;
  readonly currency: string;
  /** Every live invoice of the import, with its due date known or not. */
  readonly invoices: readonly ImportInvoiceFacts[];
  /** The latest date set on the import's invoices, and by whom. */
  readonly mark: DueDateMark | null;
}

/** The import's invoices, as the prompt reads them. */
async function invoicesOf(tx: Tx, payableId: string): Promise<ImportInvoiceFacts[]> {
  const rows = await tx
    .select({
      id: apInvoice.id,
      invoiceNo: apInvoice.invoiceNo,
      invoiceDate: apInvoice.invoiceDate,
      status: apInvoice.status,
      dueDate: apInvoice.dueDate,
      dueDateSetAt: apInvoice.dueDateSetAt,
      totalIqd: apInvoice.totalIqd,
      settledAmountIqd: apInvoice.settledAmountIqd,
    })
    .from(apInvoice)
    .where(and(eq(apInvoice.payableId, payableId), ne(apInvoice.status, 'reversed')))
    .orderBy(asc(apInvoice.invoiceDate), asc(apInvoice.invoiceNo));
  return rows.map((row) => ({ ...row, status: String(row.status) }));
}

/**
 * Everything the import page needs to ask for the balance's due date — or to
 * say it is waiting for one, or who set it. Three statements, read in the
 * page's own session for this block (not in the record's, which HD14 counts).
 */
export async function promptFor(tx: Tx, principal: Principal, payableId: string): Promise<ImportDuePrompt> {
  const [owner] = await tx
    .select({ id: payable.id, payableNo: payable.payableNo, currency: payable.currency, cancelledAt: payable.cancelledAt, closedAt: payable.closedAt })
    .from(payable)
    .where(eq(payable.id, payableId))
    .limit(1);
  if (!owner) throw new Error(`No import application with id '${payableId}'.`);
  const applications = await tx
    .select({
      applicationNo: paymentApplication.applicationNo,
      status: paymentApplication.status,
      confirmedOn: paymentApplication.confirmedOn,
      amountTxn: paymentApplication.amountTxn,
      currency: paymentApplication.currency,
    })
    .from(paymentApplication)
    .where(and(eq(paymentApplication.payableId, payableId), inArray(paymentApplication.status, ['confirmed', 'debited'])))
    .orderBy(asc(paymentApplication.applicationNo));
  const invoices = await invoicesOf(tx, payableId);
  const state = promptState({
    applications: applications.map((row) => ({ ...row, status: String(row.status), currency: String(row.currency) })),
    invoices,
    maySet: can(principal, SET_VERB, ap.PERMISSION_OBJECT),
    open: !owner.cancelledAt && !owner.closedAt,
  });
  const marks = await marksFor(tx, invoices);
  const mark = [...marks.values()].sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
  return { ...state, payableId: owner.id, payableNo: owner.payableNo, currency: String(owner.currency), invoices, mark };
}

/** A refusal the dialog says in the reader's own words. */
export class BalanceDueRefusal extends Error {
  constructor(
    readonly code: 'not_a_date' | 'before_invoice' | 'nothing_waiting' | 'not_paid',
    readonly params: Readonly<Record<string, string>> = {},
  ) {
    super(
      code === 'before_invoice'
        ? `${params.dueDate} is before invoice ${params.invoiceNo}'s own date (${params.invoiceDate}).`
        : code === 'not_a_date'
          ? 'A due date is a date (YYYY-MM-DD).'
          : code === 'not_paid'
            ? 'No payment application of this import has been paid yet; the due date is set once the SWIFT is received.'
            : 'Every invoice of this import already has its due date.',
    );
    this.name = 'BalanceDueRefusal';
  }
}

/**
 * The dialog's Save: the date on every invoice of the import that still owes
 * something and has none, each through `ap-invoice.setDueDate` (which locks
 * the invoice, asks `edit_draft`, moves the import's own date, logs it on the
 * import and audits `ap_invoice.due_date_set`). Refused before anything is
 * written when the date is before an invoice's own date, when the SWIFT is not
 * in yet, or when there is nothing left to set.
 */
export async function setForImport(tx: Tx, ctx: ActorContext, payableId: string, dueDate: string): Promise<{ readonly invoiceNos: readonly string[] }> {
  const prompt = await promptFor(tx, ctx.principal, payableId);
  if (prompt.paid === null) throw new BalanceDueRefusal('not_paid');
  if (prompt.waiting.length === 0) throw new BalanceDueRefusal('nothing_waiting');
  const refused = refusalFor(dueDate, prompt.waiting);
  if (refused?.code === 'not_a_date') throw new BalanceDueRefusal('not_a_date');
  if (refused?.code === 'before_invoice') {
    throw new BalanceDueRefusal('before_invoice', { dueDate, invoiceNo: refused.invoiceNo, invoiceDate: refused.invoiceDate });
  }
  for (const invoice of prompt.waiting) await ap.setDueDate(tx, ctx, invoice.id, dueDate);
  return { invoiceNos: prompt.waiting.map((invoice) => invoice.invoiceNo) };
}
