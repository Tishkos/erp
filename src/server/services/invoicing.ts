/**
 * Invoicing — the document Phase 0's rules are demonstrated on.
 *
 * Every rule the foundation defines is exercised here and nowhere restated:
 * the number comes from `numbering`, the status moves through `statuses`, the
 * approval routes through `department-routing` (§5.2 — an employee submits to
 * the manager of the document's department; that manager finalises directly),
 * and each step is written to the audit trail. Nothing posts to a ledger:
 * that is the accounting phases' work.
 */
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, department, invoice, invoiceLine } from '../db/schema';
import { assertTransition } from '../domain/statuses';
import type { Principal } from '../domain/permissions';
import { assertCan } from '../domain/permissions';
import {
  AdminNotFoundError,
  AdminValidationError,
  optionalText,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import * as audit from './audit';
import * as routing from './department-routing';
import { allocateDocumentNumber } from './numbering';
import * as statuses from './statuses';
import * as workflow from './workflow';
import * as attachmentService from './attachments';

export const PERMISSION_OBJECT = 'invoice';
export const DOCUMENT_TYPE = 'invoice';
const SEQUENCE_KEY = 'INVOICE';

export interface InvoiceInput {
  readonly customerName: string;
  readonly description?: string | null;
  readonly currency: string;
  readonly departmentCode: string;
  readonly documentDate?: string | null;
}

/** One thing being charged for. The total is worked out, never typed. */
export interface LineInput {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
}

export async function listAll(tx: Tx, principal: Principal) {
  assertCan(principal, 'view', PERMISSION_OBJECT);
  return tx
    .select({
      id: invoice.id,
      documentNo: invoice.documentNo,
      customerName: invoice.customerName,
      amount: invoice.amount,
      currency: invoice.currency,
      documentDate: invoice.documentDate,
      departmentCode: invoice.departmentCode,
      branchCode: invoice.branchCode,
      status: invoice.status,
      createdBy: invoice.createdBy,
      raisedBy: appUser.displayName,
      createdAt: invoice.createdAt,
    })
    .from(invoice)
    .leftJoin(appUser, eq(appUser.id, invoice.createdBy))
    .orderBy(desc(invoice.createdAt));
}

export async function byNumber(tx: Tx, documentNo: string) {
  const [row] = await tx.select().from(invoice).where(eq(invoice.documentNo, documentNo)).limit(1);
  if (!row) throw new AdminNotFoundError('invoice', documentNo);
  return row;
}

export async function byId(tx: Tx, id: string) {
  const [row] = await tx.select().from(invoice).where(eq(invoice.id, id)).limit(1);
  if (!row) throw new AdminNotFoundError('invoice', id);
  return row;
}

/** The record page's view: the invoice, who raised it, and its approval history. */
export async function detail(tx: Tx, documentNo: string) {
  const row = await byNumber(tx, documentNo);
  const [raiser] = await tx
    .select({ id: appUser.id, displayName: appUser.displayName, email: appUser.email })
    .from(appUser)
    .where(eq(appUser.id, row.createdBy));
  const [dept] = await tx
    .select({ code: department.code, name: department.name, managerUserId: department.managerUserId })
    .from(department)
    .where(eq(department.code, row.departmentCode));
  const manager = dept?.managerUserId
    ? (
        await tx
          .select({ displayName: appUser.displayName })
          .from(appUser)
          .where(eq(appUser.id, dept.managerUserId))
      )[0]
    : undefined;
  // Requirement 10 — the approval history, with the people named rather than
  // keyed. Names are resolved on read, so a person who is renamed is still
  // recognisable in a decision they made a year ago.
  const decisions = await workflow.historyFor(tx, DOCUMENT_TYPE, row.id).catch(() => []);
  const actorIds = [...new Set(decisions.map((d) => d.actorUserId).filter(Boolean))];
  const names = new Map<string, string>();
  if (actorIds.length > 0) {
    const people = await tx
      .select({ id: appUser.id, displayName: appUser.displayName })
      .from(appUser)
      .where(inArray(appUser.id, actorIds));
    for (const person of people) names.set(person.id, person.displayName);
  }
  const history = decisions.map((decision) => ({
    ...decision,
    actorName: names.get(decision.actorUserId) ?? null,
  }));

  const lines = await linesFor(tx, row.id);

  return { row, raiser, department: dept, managerName: manager?.displayName ?? null, history, lines };
}

/**
 * Open a new invoice.
 *
 * The number is allocated here, at the moment the document comes into
 * existence, which is what makes it *the* document rather than a form someone
 * is filling in — and it is why §9's "never reused" is worth stating: an
 * abandoned draft keeps its number, and the next invoice gets the next one.
 *
 * The header starts as far along as the system can honestly take it: the
 * person's own department if they have one, the company's currency, today.
 * Everything else is theirs to fill in on the document.
 */
export async function start(tx: Tx, ctx: ActorContext, departmentCode?: string) {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  if (!ctx.branchCode) throw new AdminValidationError('branch', 'no branch is in force for this session');

  const chosen = departmentCode?.trim() || (await defaultDepartmentFor(tx, ctx));
  if (!chosen) {
    throw new AdminValidationError(
      'departmentCode',
      'needed before an invoice can be raised — create a department and give it a manager',
    );
  }

  const documentDate = new Date().toISOString().slice(0, 10);
  const { documentNo } = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: ctx.branchCode, year: Number(documentDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  const [created] = await tx
    .insert(invoice)
    .values({
      documentNo,
      customerName: '',
      amount: '0',
      currency: await baseCurrency(tx),
      documentDate,
      departmentCode: chosen,
      branchCode: ctx.branchCode,
      status: 'draft',
      createdBy: ctx.principal.userId,
    })
    .returning();

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'invoice.created',
    objectType: PERMISSION_OBJECT,
    objectId: created!.id,
    branchCode: ctx.branchCode,
    after: { documentNo, departmentCode: chosen },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return created!;
}

/** Their own department if they are in one, otherwise the first open one. */
async function defaultDepartmentFor(tx: Tx, ctx: ActorContext): Promise<string | null> {
  const mine = ctx.principal.departments?.[0]?.code;
  if (mine) return mine;
  const [first] = await tx
    .select({ code: department.code })
    .from(department)
    .where(eq(department.active, true))
    .orderBy(asc(department.code))
    .limit(1);
  return first?.code ?? null;
}

/** The company's own currency, which is the sensible default for a new one. */
async function baseCurrency(tx: Tx): Promise<string> {
  const rows = await tx.execute(sql`select base_currency from company limit 1`);
  const code = (rows.rows[0] as { base_currency?: string } | undefined)?.base_currency;
  return code ?? 'IQD';
}

export async function update(tx: Tx, ctx: ActorContext, id: string, input: InvoiceInput) {
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);
  // §7 — only a draft is editable; an approved document is corrected by
  // cancelling and raising another, never by quietly changing it.
  if (before.status !== 'draft') {
    throw new AdminValidationError('status', 'only a draft may be edited');
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new AdminValidationError('currency', 'is a three-letter ISO code');
  }
  // Which department approves it is part of the header, and changing it before
  // submission is an ordinary thing to want — §5.2 reads it at submission.
  const departmentCode = requireText(input.departmentCode, 'departmentCode');
  const [dept] = await tx
    .select({ active: department.active })
    .from(department)
    .where(eq(department.code, departmentCode));
  if (!dept?.active) throw new AdminValidationError('departmentCode', 'is not an active department');

  const values = {
    customerName: requireText(input.customerName, 'customerName', 160),
    description: optionalText(input.description),
    currency,
    departmentCode,
    documentDate: input.documentDate?.trim() || before.documentDate,
    updatedAt: new Date(),
  };
  await tx.update(invoice).set(values).where(eq(invoice.id, id));
  await recordChange(tx, ctx, {
    action: 'invoice.updated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: before.branchCode,
    before: {
      customerName: before.customerName,
      currency: before.currency,
      departmentCode: before.departmentCode,
    },
    after: values,
  });
}


// ---------------------------------------------------------------------------
// The lines — what is actually being charged for
// ---------------------------------------------------------------------------

/** The lines of one invoice, in the order they were entered. */
export async function linesFor(tx: Tx, invoiceId: string) {
  return tx
    .select()
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, invoiceId))
    .orderBy(asc(invoiceLine.lineNo));
}

/**
 * Add one line.
 *
 * The line total is computed here and checked again by the database, which is
 * not belt and braces — it is the difference between a total that is true and
 * a total that was true when somebody last looked. The invoice's own amount is
 * re-summed by a trigger, so nothing in this function can leave the two
 * disagreeing.
 */
export async function addLine(tx: Tx, ctx: ActorContext, invoiceId: string, input: LineInput) {
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, invoiceId);
  const parent = await byId(tx, invoiceId);
  if (parent.status !== 'draft') {
    throw new AdminValidationError('status', 'lines can only be changed while it is a draft');
  }

  const description = requireText(input.description, 'description', 240);
  const quantity = positive(input.quantity, 'quantity');
  const unitPrice = notNegative(input.unitPrice, 'unitPrice');
  const lineTotal = round4(quantity * unitPrice);

  const [nextRow] = await tx
    .select({ next: sql<number>`coalesce(max(${invoiceLine.lineNo}), 0) + 1` })
    .from(invoiceLine)
    .where(eq(invoiceLine.invoiceId, invoiceId));

  const [created] = await tx
    .insert(invoiceLine)
    .values({
      invoiceId,
      lineNo: Number(nextRow?.next ?? 1),
      description,
      quantity: quantity.toFixed(6),
      unitPrice: unitPrice.toFixed(4),
      lineTotal: lineTotal.toFixed(4),
    })
    .returning();

  await recordChange(tx, ctx, {
    action: 'invoice.line_added',
    objectType: PERMISSION_OBJECT,
    objectId: invoiceId,
    branchCode: parent.branchCode,
    after: { line: created!.lineNo, description, quantity: created!.quantity, unitPrice: created!.unitPrice },
  });
  return created!;
}

/**
 * Take a line off a draft.
 *
 * §1.1 forbids deleting a *record*; a line of an invoice nobody has seen is
 * not one yet. The database refuses the same operation the moment the invoice
 * leaves draft, so this is the only window it exists in — and the removal is
 * written to the trail either way.
 */
export async function removeLine(tx: Tx, ctx: ActorContext, invoiceId: string, lineId: string) {
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, invoiceId);
  const parent = await byId(tx, invoiceId);
  if (parent.status !== 'draft') {
    throw new AdminValidationError('status', 'lines can only be changed while it is a draft');
  }
  const [line] = await tx.select().from(invoiceLine).where(eq(invoiceLine.id, lineId)).limit(1);
  if (!line || line.invoiceId !== invoiceId) throw new AdminNotFoundError('invoice_line', lineId);

  await tx.delete(invoiceLine).where(eq(invoiceLine.id, lineId));
  await recordChange(tx, ctx, {
    action: 'invoice.line_removed',
    objectType: PERMISSION_OBJECT,
    objectId: invoiceId,
    branchCode: parent.branchCode,
    before: { line: line.lineNo, description: line.description, lineTotal: line.lineTotal },
  });
}

/** A quantity: a number above zero, or a refusal that says which field. */
function positive(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new AdminValidationError(field, 'is a number greater than zero');
  return n;
}

function notNegative(value: string, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new AdminValidationError(field, 'is a number, and not a negative one');
  return n;
}

/** Four places, the scale the money columns keep. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * §5.2 — submit. An ordinary employee sends it to the manager of the
 * document's department; that manager, raising it in their own department,
 * finalises it in the same act.
 */
export async function submit(tx: Tx, ctx: ActorContext, id: string) {
  await permit(ctx, 'submit', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);

  // The checks a draft was allowed to postpone, made now — once, here, so the
  // screen and any other caller get the same answer.
  if (!before.customerName.trim()) {
    throw new AdminValidationError('customerName', 'is needed before it can be sent for approval');
  }
  const lines = await linesFor(tx, id);
  if (lines.length === 0) {
    throw new AdminValidationError('lines', 'are needed — an invoice charges for something');
  }
  if (Number(before.amount) <= 0) {
    throw new AdminValidationError('amount', 'comes to zero; check the quantities and prices');
  }
  assertTransition(DOCUMENT_TYPE, await statuses.transitionRulesFor(tx, DOCUMENT_TYPE), before.status, 'submitted');

  const result = await routing.submitOrFinalise(tx, ctx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: id,
    departmentCode: before.departmentCode,
  });

  if (result.outcome === 'submit_to_department_manager') {
    await tx
      .update(invoice)
      .set({ status: 'submitted', returnedReason: null, updatedAt: new Date() })
      .where(eq(invoice.id, id));
    await recordChange(tx, ctx, {
      action: 'invoice.submitted',
      objectType: PERMISSION_OBJECT,
      objectId: id,
      branchCode: before.branchCode,
      before: { status: before.status },
      after: { status: 'submitted', assignedToUserId: result.assignedToUserId },
    });
  }
  return result;
}

/** §5.2 — the department's manager approves; the effect below finalises it. */
export async function approve(tx: Tx, ctx: ActorContext, id: string) {
  await permit(ctx, 'approve', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);
  assertTransition(DOCUMENT_TYPE, await statuses.transitionRulesFor(tx, DOCUMENT_TYPE), before.status, 'approved');
  await routing.approveAsDepartmentManager(tx, ctx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: id,
  });
}

/**
 * The approver refuses it — and it goes back to Draft.
 *
 * §7 gives a document five states and Rejected is not one of them, so a
 * refusal is not a place the invoice sits: it is something that happened to
 * it. The reason, the approver and the moment are written to the approval
 * history and the audit trail, and the invoice returns to the person who
 * raised it, editable, to be corrected and sent again.
 */
export async function reject(tx: Tx, ctx: ActorContext, id: string, reason: string) {
  await permit(ctx, 'approve', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);
  if (!reason.trim()) throw new AdminValidationError('reason', 'is required to reject a document');
  assertTransition(DOCUMENT_TYPE, await statuses.transitionRulesFor(tx, DOCUMENT_TYPE), before.status, 'draft', reason);

  const actor = await routing.routingActorFor(tx, ctx.principal.userId);
  await workflow.decide(tx, {
    documentTypeCode: DOCUMENT_TYPE,
    documentId: id,
    actor: {
      userId: ctx.principal.userId,
      roles: ctx.principal.roleCodes,
      isDepartmentManager: actor.departments.some(
        (d) => d.code === before.departmentCode && d.isManager,
      ),
    },
    decision: 'rejected',
    reason,
  });
  await tx
    .update(invoice)
    .set({ status: 'draft', returnedReason: reason, updatedAt: new Date() })
    .where(eq(invoice.id, id));
  await recordChange(tx, ctx, {
    action: 'invoice.rejected',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: before.branchCode,
    before: { status: before.status },
    after: { status: 'draft' },
    reason,
  });
}
/** Withdrawn before it was decided on — a draft, or one still waiting. */
export async function cancel(tx: Tx, ctx: ActorContext, id: string, reason: string) {
  await permit(ctx, 'reverse_cancel', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);
  if (!reason.trim()) throw new AdminValidationError('reason', 'is required to cancel a document');
  assertTransition(DOCUMENT_TYPE, await statuses.transitionRulesFor(tx, DOCUMENT_TYPE), before.status, 'cancelled', reason);
  await tx.update(invoice).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(invoice.id, id));
  await recordChange(tx, ctx, {
    action: 'invoice.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: before.branchCode,
    before: { status: before.status },
    after: { status: 'cancelled' },
    reason,
  });
}

/**
 * §7 — the other end of the standard structure.
 *
 * An approved document is never edited and never deleted. It is reversed,
 * which leaves both facts in place: that it was approved, and that it was
 * later undone, by whom and why.
 */
export async function reverse(tx: Tx, ctx: ActorContext, id: string, reason: string) {
  await permit(ctx, 'reverse_cancel', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);
  if (!reason.trim()) throw new AdminValidationError('reason', 'is required to reverse a document');
  assertTransition(DOCUMENT_TYPE, await statuses.transitionRulesFor(tx, DOCUMENT_TYPE), before.status, 'reversed', reason);
  await tx.update(invoice).set({ status: 'reversed', updatedAt: new Date() }).where(eq(invoice.id, id));
  await recordChange(tx, ctx, {
    action: 'invoice.reversed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: before.branchCode,
    before: { status: before.status },
    after: { status: 'reversed' },
    reason,
  });
}

/**
 * What approval *does* — registered with the routing engine so that both
 * paths (a manager finalising directly, and a manager approving from the
 * inbox) end in exactly the same state.
 */
export function registerInvoiceEffect(): void {
  routing.registerExecutionEffect(DOCUMENT_TYPE, async (tx, ctx, documentId) => {
    await tx
      .update(invoice)
      .set({ status: 'approved', updatedAt: new Date() })
      .where(eq(invoice.id, documentId));
    await audit.record(tx, {
      actorUserId: ctx.principal.userId,
      action: 'invoice.approved',
      objectType: PERMISSION_OBJECT,
      objectId: documentId,
      branchCode: ctx.branchCode,
      after: { status: 'approved' },
      outcome: 'success',
      requestId: ctx.requestId ?? null,
    });
  });
}

/**
 * Throwing away a draft invoice.
 *
 * §7 keeps a *document* for ever — something that entered the flow and that
 * somebody may be asked to account for. A draft entered nothing: no manager
 * saw it, no ledger moved, and what it holds is unfinished typing. Keeping
 * every abandoned attempt buries the real invoices in the list.
 *
 * §7 is still honoured where it counts. The audit event goes in **before** the
 * rows come out, so the trail keeps the fact that this invoice existed, what
 * number it held and who discarded it; and the number is not returned to the
 * series, because §4.3 says a number is never reused. The gap is the honest
 * record of an abandoned draft.
 */
export async function discardDraft(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ documentNo: string }> {
  // Discarding is the furthest edit of a draft there is, so it takes the same
  // grant. A separate verb would need seeding on every role before anyone could
  // use it, and would say nothing extra.
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, id);
  const before = await byId(tx, id);

  if (before.status !== 'draft') {
    throw new AdminValidationError(
      'status',
      `is ${before.status}, not a draft. Only a draft can be deleted; ` +
        'a document that has been approved is cancelled or reversed, which leaves it on the record.',
    );
  }

  await recordChange(tx, ctx, {
    action: 'invoice.discarded',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: before.branchCode,
    before: {
      documentNo: before.documentNo,
      status: before.status,
      customerName: before.customerName,
      amount: before.amount,
      currency: before.currency,
    },
    after: null,
  });

  // Attachments point at their record by type and id, with no foreign key to
  // take them with it — so they are removed here or they linger unreachable.
  await attachmentService.discardFor(tx, PERMISSION_OBJECT, id);

  await tx.delete(invoiceLine).where(eq(invoiceLine.invoiceId, id));
  await tx.delete(invoice).where(eq(invoice.id, id));

  return { documentNo: before.documentNo };
}
