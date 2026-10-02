/**
 * Expenses — REQ-AP-001 §21.2 and decision D12 (2026-10-01).
 *
 * The rent, the electricity, the forwarder, the customs broker, the
 * consultant, the bank charge: each is a **purchase invoice**, not a record of
 * its own. This module is the convenience around that invoice and nothing
 * more —
 *
 *   * `addExpense` — the "Add expense" quick form: one non-stock line, the
 *     type of fee, the due date, optionally the import it belongs to. It goes
 *     through `ap.create` like every invoice, so every control of the invoice
 *     still holds (numbering, duplicate check, §15 evidence, posting by the
 *     CEO, the journal).
 *   * `paymentState` — Unpaid / Paid / Overdue, read from what the invoice
 *     already knows (status, due date, settled amount). Nothing is stored.
 *   * `markPaid` — the supplier payment for what is still owed, created,
 *     allocated and posted through the existing service in one transaction.
 *   * `addNote` — "Overdue — add a note": the whole of "where is it stopped
 *     and why" for an expense. Append-only (migration 0231).
 *
 * The stage rail, reason codes and hold owners belong to imports; an expense
 * never shows them (D12).
 */
import { asc, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { apInvoice, apInvoiceNote, appUser, expenseCategory } from '../db/schema';
import { parseDecimal } from '../domain/money';
import type { ActorContext } from './chart-of-accounts';
import * as ap from './ap-invoice';
import * as audit from './audit';
import * as authz from './authorization';
import * as payments from './supplier-payment';

export type PaymentState = 'draft' | 'unpaid' | 'part_paid' | 'paid' | 'overdue' | 'reversed';

/**
 * Unpaid / Part paid / Paid / Overdue from what the invoice already holds.
 * REQ-FIX-001 FIX-3: *Part paid* is its own state — a deposit applied or an
 * instalment paid read as *Unpaid* before. Overdue still wins: part paid
 * past its date is overdue.
 */
export function paymentState(
  invoice: { status: string; dueDate: string | null; totalIqd: string; settledAmountIqd: string },
  today: string,
): PaymentState {
  if (invoice.status === 'reversed' || invoice.status === 'cancelled') return 'reversed';
  if (invoice.status === 'draft' || invoice.status === 'submitted') {
    return invoice.dueDate && invoice.dueDate < today ? 'overdue' : 'draft';
  }
  const total = parseDecimal(invoice.totalIqd, 4n);
  const settled = parseDecimal(invoice.settledAmountIqd, 4n);
  if (total > 0n && settled >= total) return 'paid';
  if (invoice.status === 'settled') return 'paid';
  if (invoice.dueDate && invoice.dueDate < today) return 'overdue';
  return settled > 0n ? 'part_paid' : 'unpaid';
}

/** Whole days between two ISO dates (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export interface AddExpenseInput {
  readonly expenseCategoryCode: string;
  /** "Erbil office rent — October", "Forwarding, B/L MEDUWI804404". */
  readonly name: string;
  readonly supplierId: string;
  readonly branchCode: string;
  /** Amount in IQD at the money scale (the invoice is IQD; §1.1). */
  readonly amountIqd: bigint;
  readonly invoiceDate: string;
  readonly dueDate: string;
  /** The supplier's own bill number, when there is one. */
  readonly supplierInvoiceNo?: string | null;
  /** §9.2 — a cost of an import: the line is charged to that application. */
  readonly chargedToPayableId?: string | null;
  readonly costCentreCode?: string | null;
}

/** The "Add expense" quick form (§21.2). One line, one invoice, every control kept. */
export async function addExpense(tx: Tx, ctx: ActorContext, input: AddExpenseInput) {
  if (input.amountIqd <= 0n) {
    throw new Error('An expense of nothing charges nothing. Enter the amount on the bill.');
  }
  const name = input.name.trim();
  if (!name) throw new Error('Give the expense a name — what it is for, as it should read in the list.');

  return ap.create(tx, ctx, {
    supplierId: input.supplierId,
    supplierInvoiceNo: input.supplierInvoiceNo?.trim() ?? '',
    branchCode: input.branchCode,
    invoiceDate: input.invoiceDate,
    dueDate: input.dueDate,
    expenseCategoryCode: input.expenseCategoryCode,
    note: name,
    lines: [
      {
        description: name,
        quantity: 1_000_000n,
        unitPriceIqd: input.amountIqd,
        isInventory: false,
        costCentreCode: input.costCentreCode ?? null,
        chargedToPayableId: input.chargedToPayableId ?? null,
      },
    ],
  });
}

export interface MarkPaidInput {
  readonly apInvoiceId: string;
  readonly bankCashAccountId: string;
  readonly paymentDate: string;
  /** Transfer reference, cheque number, cash voucher number. */
  readonly reference?: string | null;
}

/**
 * "Mark paid" — what is still owed on a posted invoice becomes a supplier
 * payment, allocated and posted, in one transaction. Needs the `post` verb on
 * supplier payments (the accounting manager today); the officer sees no
 * button rather than a refusal.
 */
export async function markPaid(tx: Tx, ctx: ActorContext, input: MarkPaidInput) {
  const view = await ap.view(tx, input.apInvoiceId);
  const invoice = view.invoice;
  if (invoice.status !== 'posted' && invoice.status !== 'partially_executed') {
    throw new Error(
      `Invoice ${invoice.invoiceNo} is '${invoice.status}'. It is paid once it is posted — post it first.`,
    );
  }
  const outstanding = payments.outstandingOn(invoice);
  if (outstanding <= 0n) throw new Error(`Invoice ${invoice.invoiceNo} is already paid.`);

  const created = await payments.create(tx, ctx, {
    supplierId: invoice.supplierId,
    bankCashAccountId: input.bankCashAccountId,
    branchCode: invoice.branchCode,
    paymentDate: input.paymentDate,
    amountIqd: outstanding,
    currency: invoice.currency,
    reference: input.reference?.trim() || null,
    note: `Paid from ${invoice.invoiceNo}`,
  });
  await payments.allocate(tx, ctx, {
    supplierPaymentId: created.id,
    apInvoiceId: invoice.id,
    amountIqd: outstanding,
  });
  await payments.post(tx, ctx, created.id);
  return created;
}

/** "Add note" — dated, signed, never edited. */
export async function addNote(tx: Tx, ctx: ActorContext, apInvoiceId: string, note: string) {
  const text = note.trim();
  if (!text) throw new Error('A note says something. Write what is happening with this bill.');
  const [invoice] = await tx
    .select({ id: apInvoice.id, branchCode: apInvoice.branchCode, invoiceNo: apInvoice.invoiceNo })
    .from(apInvoice)
    .where(eq(apInvoice.id, apInvoiceId))
    .limit(1);
  if (!invoice) throw new Error('No such invoice.');
  await authz.authorize(ctx.principal, 'view', ap.PERMISSION_OBJECT, { branchCode: invoice.branchCode });

  await tx.insert(apInvoiceNote).values({ apInvoiceId, note: text, createdBy: ctx.principal.userId });
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'ap_invoice.note_added',
    objectType: ap.PERMISSION_OBJECT,
    objectId: apInvoiceId,
    branchCode: invoice.branchCode,
    after: { invoiceNo: invoice.invoiceNo, note: text },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** The notes of an invoice, oldest first, with who wrote them. */
export async function notesOf(tx: Tx, apInvoiceId: string) {
  return tx
    .select({
      id: apInvoiceNote.id,
      note: apInvoiceNote.note,
      createdAt: sql<string>`${apInvoiceNote.createdAt}::text`,
      author: appUser.displayName,
    })
    .from(apInvoiceNote)
    .leftJoin(appUser, eq(appUser.id, apInvoiceNote.createdBy))
    .where(eq(apInvoiceNote.apInvoiceId, apInvoiceId))
    .orderBy(asc(apInvoiceNote.createdAt));
}

/** The latest note per invoice, for the list's Overdue rows. */
export async function latestNotes(tx: Tx): Promise<Map<string, string>> {
  const rows = await tx
    .selectDistinctOn([apInvoiceNote.apInvoiceId], {
      apInvoiceId: apInvoiceNote.apInvoiceId,
      note: apInvoiceNote.note,
    })
    .from(apInvoiceNote)
    .orderBy(apInvoiceNote.apInvoiceId, desc(apInvoiceNote.createdAt));
  return new Map(rows.map((row) => [row.apInvoiceId, row.note]));
}

/** Types of fee offered by the Add expense form. */
export async function categories(tx: Tx) {
  return tx
    .select({ code: expenseCategory.code, name: expenseCategory.name })
    .from(expenseCategory)
    .where(eq(expenseCategory.active, true))
    .orderBy(asc(expenseCategory.name));
}

/** Imports still open, for the "belongs to import" picker. */
export async function openImports(tx: Tx) {
  const result = await tx.execute(sql`
    select p.id, p.payable_no as "payableNo", p.supplier_reference as "reference",
           bp.legal_name as "supplierName"
      from payable p
      join business_partner bp on bp.id = p.supplier_id
     where p.payable_type_code = 'import'
       and p.cancelled_at is null and p.closed_at is null
     order by p.payable_no desc`);
  return result.rows as unknown as {
    id: string;
    payableNo: string;
    reference: string;
    supplierName: string;
  }[];
}


