/**
 * The Project System — REQ-PM-001 Stage PM-3: execution. A purchase order,
 * a payable or an invoice assigned to an element; the order's approval (or
 * the payable's opening, when it has no order) as the commitment; the
 * invoice's posting converting it to an actual and its reversal undoing
 * that; the Material Issues document moving stock to an element at layer
 * cost; the line items and the procurement register the screens read.
 *
 * Over `services/projects.ts` (Phase 11) as PM-1 and PM-2 are: that module
 * keeps `commit`, `recordCost`, `reverseCost`, `issueToProject` and
 * `returnFromProject`; this one is called from the purchasing services at
 * the moments §8 names, and owns the document that §9 describes.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  apInvoice,
  item,
  payable,
  project,
  projectCommitment,
  projectCost,
  projectCostCode,
  projectMaterialIssue,
  projectMaterialIssueLine,
  projectWbs,
  purchaseOrder,
  warehouse,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { parseDecimal, toDecimalString } from '../domain/money';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { ProjectSystemError } from '../domain/project-system';
import { AdminNotFoundError, optionalText, permit, recordChange, requireText } from './administration';
import type { ActorContext } from './chart-of-accounts';
import { allocateDocumentNumber } from './numbering';
import * as posting from './posting';
import * as projects from './projects';

/** A literal, as in `project-budget.ts`: this module and the purchasing services import each other. */
export const PERMISSION_OBJECT = 'project';
export const ISSUE_DOCUMENT_TYPE = 'project_material_issue';
export const ISSUE_SEQUENCE_KEY = 'PROJECT_ISSUE';

const MONEY = 4n;
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// The assignment (§8): a project, an element and a cost code — or nothing
// ---------------------------------------------------------------------------

export interface Assignment {
  readonly projectCode: string;
  readonly wbsCode: string;
  readonly costCode: string;
}

/**
 * The three fields together or none; the project not closed, the element an
 * active account-assignment one, the cost code active. Returned normalised
 * for the purchasing document to store.
 */
export async function checkAssignment(
  tx: Tx,
  input: { projectCode?: string | null; wbsCode?: string | null; costCode?: string | null },
): Promise<Assignment | null> {
  const projectCode = (input.projectCode ?? '').trim();
  const wbsCode = (input.wbsCode ?? '').trim();
  const costCode = (input.costCode ?? '').trim().toUpperCase();
  if (!projectCode && !wbsCode && !costCode) return null;
  if (!projectCode || !wbsCode || !costCode) throw new ProjectSystemError('project', 'a project assignment names the project, the element and the cost code together');
  const [row] = await tx.select({ status: project.status }).from(project).where(eq(project.code, projectCode)).limit(1);
  if (!row) throw new ProjectSystemError('project', `there is no project '${projectCode}'`);
  if (row.status === 'closed') throw new ProjectSystemError('project', `${projectCode} is closed; nothing is assigned to it`);
  await projects.assertAccountAssignmentElement(tx, projectCode, wbsCode);
  const [code] = await tx.select({ active: projectCostCode.active }).from(projectCostCode).where(eq(projectCostCode.code, costCode)).limit(1);
  if (!code) throw new ProjectSystemError('cost_code', `there is no cost code '${costCode}'`);
  if (!code.active) throw new ProjectSystemError('cost_code', `cost code ${costCode} is deactivated`);
  return { projectCode, wbsCode, costCode };
}

// ---------------------------------------------------------------------------
// Commitments from purchasing (§8)
// ---------------------------------------------------------------------------

async function openCommitment(tx: Tx, where: { purchaseOrderId?: string | null; payableId?: string | null }) {
  const [row] = await tx
    .select()
    .from(projectCommitment)
    .where(
      and(
        where.purchaseOrderId ? eq(projectCommitment.purchaseOrderId, where.purchaseOrderId) : eq(projectCommitment.payableId, where.payableId ?? ''),
        isNull(projectCommitment.releasedOn),
      ),
    )
    .orderBy(desc(projectCommitment.createdAt))
    .limit(1);
  return row ?? null;
}

/** The order's approval is the promise: its IQD total, on its element (§8). Idempotent per order. */
export async function commitForOrder(tx: Tx, ctx: ActorContext, orderId: string): Promise<{ id: string } | null> {
  const [order] = await tx.select().from(purchaseOrder).where(eq(purchaseOrder.id, orderId)).limit(1);
  if (!order || !order.projectCode || !order.wbsCode || !order.costCode) return null;
  if (await openCommitment(tx, { purchaseOrderId: orderId })) return null;
  const [total] = (await tx.execute(sql`select round(coalesce(sum(quantity * unit_price), 0), 4)::text as total from purchase_order_line where purchase_order_id = ${orderId}`)).rows as { total: string }[];
  const amount = parseDecimal(total?.total ?? '0', MONEY);
  if (amount <= 0n) return null;
  const { id } = await projects.commit(tx, ctx, order.projectCode, {
    costCode: order.costCode,
    wbsCode: order.wbsCode,
    amountIqd: amount,
    committedOn: order.orderDate,
    purchaseOrderId: orderId,
  });
  return { id };
}

/** A payable without an order (service, recurring) is the promise itself (§8). */
export async function commitForPayable(tx: Tx, ctx: ActorContext, payableId: string): Promise<{ id: string } | null> {
  const [row] = await tx.select().from(payable).where(eq(payable.id, payableId)).limit(1);
  if (!row || !row.projectCode || !row.wbsCode || !row.costCode) return null;
  if (row.purchaseOrderId) return null; // the order carries the commitment
  if (await openCommitment(tx, { payableId })) return null;
  const amount = parseDecimal(row.amountIqd, MONEY);
  if (amount <= 0n) return null;
  const { id } = await projects.commit(tx, ctx, row.projectCode, {
    costCode: row.costCode,
    wbsCode: row.wbsCode,
    amountIqd: amount,
    committedOn: row.documentDate,
    payableId,
  });
  return { id };
}

/** Cancellation releases what is still open on the promise, with the reason (§8). */
export async function releaseFor(tx: Tx, ctx: ActorContext, where: { purchaseOrderId?: string | null; payableId?: string | null }, reason: string): Promise<boolean> {
  const open = await openCommitment(tx, where);
  if (!open) return false;
  await projects.releaseCommitment(tx, ctx, open.id, { releasedOn: businessToday(), reason });
  return true;
}

/**
 * The invoice's posting converts the promise to an actual (§8): the cost row
 * names the journal and the invoice, consumes the order's (or the payable's)
 * open commitment, and only what exceeds it is new spending.
 */
export async function recordInvoiceCost(
  tx: Tx,
  ctx: ActorContext,
  input: {
    invoiceId: string;
    invoiceNo: string;
    supplierCode: string | null;
    journalEntryId: string;
    /** The services and their variance: the project's cost. */
    costIqd: bigint;
    /** The goods: stock until issued (§9); they settle the promise, not the cost. */
    stockIqd: bigint;
    incurredOn: string;
  },
): Promise<{ id: string | null; settledIqd: bigint }> {
  const [invoice] = await tx.select().from(apInvoice).where(eq(apInvoice.id, input.invoiceId)).limit(1);
  if (!invoice || !invoice.projectCode || !invoice.wbsCode || !invoice.costCode) return { id: null, settledIqd: 0n };
  const promise = (invoice.purchaseOrderId ? await openCommitment(tx, { purchaseOrderId: invoice.purchaseOrderId }) : null) ?? (invoice.payableId ? await openCommitment(tx, { payableId: invoice.payableId }) : null);
  let id: string | null = null;
  if (input.costIqd > 0n) {
    id = (
      await projects.recordCost(tx, ctx, invoice.projectCode, {
        costCode: invoice.costCode,
        wbsCode: invoice.wbsCode,
        kind: 'invoice',
        description: `A/P invoice ${input.invoiceNo}${input.supplierCode ? ` — ${input.supplierCode}` : ''}`,
        incurredOn: input.incurredOn,
        amountIqd: input.costIqd,
        journalEntryId: input.journalEntryId,
        consumesCommitmentId: promise?.id ?? null,
        sourceType: 'ap_invoice',
        sourceId: input.invoiceId,
      })
    ).id;
  }
  let settledIqd = 0n;
  if (input.stockIqd > 0n && promise) {
    const open = parseDecimal(promise.amountIqd, MONEY) - parseDecimal(promise.consumedIqd, MONEY);
    settledIqd = input.stockIqd < open ? input.stockIqd : open;
    if (settledIqd > 0n) {
      await tx
        .update(projectCommitment)
        .set({ consumedIqd: sql`${projectCommitment.consumedIqd} + ${toDecimalString(settledIqd, MONEY)}` })
        .where(eq(projectCommitment.id, promise.id));
      await recordChange(tx, ctx, {
        action: 'project.commitment_settled',
        objectType: projects.DOCUMENT_TYPE,
        objectId: invoice.projectCode,
        branchCode: invoice.branchCode,
        after: { commitmentId: promise.id, invoiceNo: input.invoiceNo, stockIqd: toDecimalString(input.stockIqd, MONEY), settledIqd: toDecimalString(settledIqd, MONEY), note: 'goods received into stock; the cost reaches the element at issue (§9)' },
      });
    }
  }
  return { id, settledIqd };
}

/** The invoice's reversal undoes its cost rows and gives the promise back (§8). */
export async function reverseInvoiceCost(
  tx: Tx,
  ctx: ActorContext,
  input: { invoiceId: string; reason: string; journalEntryId?: string | null; stockIqd?: bigint },
): Promise<number> {
  const rows = await tx
    .select({ id: projectCost.id })
    .from(projectCost)
    .where(and(eq(projectCost.sourceType, 'ap_invoice'), eq(projectCost.sourceId, input.invoiceId), isNull(projectCost.reversesCostId), sql`${projectCost.amountIqd} > 0`));
  let reversed = 0;
  for (const row of rows) {
    const [already] = await tx.select({ id: projectCost.id }).from(projectCost).where(eq(projectCost.reversesCostId, row.id)).limit(1);
    if (already) continue;
    await projects.reverseCost(tx, ctx, row.id, { reason: input.reason, journalEntryId: input.journalEntryId ?? null });
    reversed += 1;
  }
  // The goods' settlement of the promise is given back too: the order is open again for them.
  if (input.stockIqd && input.stockIqd > 0n) {
    const [invoice] = await tx.select({ projectCode: apInvoice.projectCode, purchaseOrderId: apInvoice.purchaseOrderId, payableId: apInvoice.payableId, branchCode: apInvoice.branchCode }).from(apInvoice).where(eq(apInvoice.id, input.invoiceId)).limit(1);
    const promise = invoice?.purchaseOrderId ? await openCommitment(tx, { purchaseOrderId: invoice.purchaseOrderId }) : invoice?.payableId ? await openCommitment(tx, { payableId: invoice.payableId }) : null;
    if (promise && invoice?.projectCode) {
      const consumed = parseDecimal(promise.consumedIqd, MONEY);
      const back = input.stockIqd < consumed ? input.stockIqd : consumed;
      if (back > 0n) {
        await tx.update(projectCommitment).set({ consumedIqd: sql`${projectCommitment.consumedIqd} - ${toDecimalString(back, MONEY)}` }).where(eq(projectCommitment.id, promise.id));
        await recordChange(tx, ctx, {
          action: 'project.commitment_reopened',
          objectType: projects.DOCUMENT_TYPE,
          objectId: invoice.projectCode,
          branchCode: invoice.branchCode,
          after: { commitmentId: promise.id, invoiceId: input.invoiceId, reopenedIqd: toDecimalString(back, MONEY) },
          reason: input.reason,
        });
      }
    }
  }
  return reversed;
}

// ---------------------------------------------------------------------------
// The Material Issues document (§9)
// ---------------------------------------------------------------------------

export interface IssueInput {
  readonly projectCode: string;
  readonly wbsCode: string;
  readonly costCode: string;
  readonly warehouseCode: string;
  readonly kind?: string | null;
  readonly movementDate?: string | null;
  readonly description?: string | null;
  readonly lines: readonly { readonly itemCode: string; readonly quantity: string; readonly unitCostIqd?: string | null; readonly serialNumber?: string | null; readonly batchNumber?: string | null }[];
  /** The one-time id the form minted; a repeat answers with the existing document. */
  readonly documentId?: string | null;
}

async function loadIssue(tx: Tx, documentNo: string) {
  const [row] = await tx.select().from(projectMaterialIssue).where(eq(projectMaterialIssue.documentNo, documentNo)).limit(1);
  if (!row) throw new AdminNotFoundError('project_material_issue', documentNo);
  return row;
}

export async function createIssue(tx: Tx, ctx: ActorContext, input: IssueInput): Promise<{ id: string; documentNo: string; existing: boolean }> {
  if (input.documentId) {
    const [existing] = await tx.select({ id: projectMaterialIssue.id, documentNo: projectMaterialIssue.documentNo }).from(projectMaterialIssue).where(eq(projectMaterialIssue.id, input.documentId)).limit(1);
    if (existing) return { ...existing, existing: true };
  }
  const assignment = await checkAssignment(tx, input);
  if (!assignment) throw new ProjectSystemError('project', 'a material issue names its project, element and cost code');
  const [row] = await tx.select({ status: project.status, branchCode: project.branchCode }).from(project).where(eq(project.code, assignment.projectCode)).limit(1);
  await permit(ctx, 'create', PERMISSION_OBJECT, assignment.projectCode);
  if (row!.status !== 'active') throw new ProjectSystemError('status', `${assignment.projectCode} is ${row!.status}; stock is issued to an active project`);
  const [store] = await tx.select({ code: warehouse.code, branchCode: warehouse.branchCode, active: warehouse.active }).from(warehouse).where(eq(warehouse.code, input.warehouseCode.trim().toUpperCase())).limit(1);
  if (!store || !store.active) throw new ProjectSystemError('warehouse', `there is no active warehouse '${input.warehouseCode}'`);
  const kind = (input.kind ?? 'issue').trim();
  if (kind !== 'issue' && kind !== 'return') throw new ProjectSystemError('kind', `'${kind}' is neither an issue nor a return`);
  const movementDate = (input.movementDate ?? '').trim() || businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(movementDate)) throw new ProjectSystemError('movement_date', `'${movementDate}' is not a date`);
  if (input.lines.length === 0) throw new ProjectSystemError('lines', 'a material issue carries at least one line');
  const codes = [...new Set(input.lines.map((l) => l.itemCode.trim().toUpperCase()))];
  const known = await tx.select({ code: item.code, active: item.active }).from(item).where(inArray(item.code, codes));
  const lines = input.lines.map((line, i) => {
    const itemCode = line.itemCode.trim().toUpperCase();
    const found = known.find((k) => k.code === itemCode);
    if (!found) throw new ProjectSystemError(`line ${i + 1}`, `there is no item '${itemCode}'`);
    if (!found.active) throw new ProjectSystemError(`line ${i + 1}`, `item ${itemCode} is deactivated`);
    let quantity: bigint;
    try {
      quantity = parseQuantity(line.quantity);
    } catch {
      throw new ProjectSystemError(`line ${i + 1}`, `'${line.quantity}' is not a quantity`);
    }
    if (quantity <= 0n) throw new ProjectSystemError(`line ${i + 1}`, 'the quantity is positive');
    let unitCostIqd: bigint | null = null;
    if (kind === 'return') {
      const typed = (line.unitCostIqd ?? '').trim();
      if (!typed) throw new ProjectSystemError(`line ${i + 1}`, 'a return names the unit cost the stock went out at (§9)');
      try {
        unitCostIqd = parseDecimal(typed, MONEY);
      } catch {
        throw new ProjectSystemError(`line ${i + 1}`, `'${typed}' is not an amount`);
      }
      if (unitCostIqd < 0n) throw new ProjectSystemError(`line ${i + 1}`, 'a unit cost is not negative');
    }
    return { itemCode, quantity, unitCostIqd, serialNumber: optionalText(line.serialNumber, 100), batchNumber: optionalText(line.batchNumber, 100) };
  });
  const branchCode = store.branchCode;
  const { documentNo } = await allocateDocumentNumber(tx, ISSUE_SEQUENCE_KEY, { branchCode, year: Number(movementDate.slice(0, 4)) }, ctx.principal.userId);
  const [created] = await tx
    .insert(projectMaterialIssue)
    .values({
      ...(input.documentId ? { id: input.documentId } : {}),
      documentNo,
      projectCode: assignment.projectCode,
      wbsCode: assignment.wbsCode,
      costCode: assignment.costCode,
      warehouseCode: store.code,
      branchCode,
      kind,
      movementDate,
      description: optionalText(input.description, 500),
      createdBy: ctx.principal.userId,
    })
    .returning({ id: projectMaterialIssue.id });
  await tx.insert(projectMaterialIssueLine).values(
    lines.map((line, i) => ({
      issueId: created!.id,
      lineNo: i + 1,
      itemCode: line.itemCode,
      quantity: formatQuantity(line.quantity),
      unitCostIqd: line.unitCostIqd === null ? null : toDecimalString(line.unitCostIqd, MONEY),
      serialNumber: line.serialNumber,
      batchNumber: line.batchNumber,
    })),
  );
  await recordChange(tx, ctx, {
    action: 'project_material_issue.created',
    objectType: ISSUE_DOCUMENT_TYPE,
    objectId: documentNo,
    branchCode,
    after: { projectCode: assignment.projectCode, wbsCode: assignment.wbsCode, costCode: assignment.costCode, warehouseCode: store.code, kind, lines: lines.length },
  });
  return { id: created!.id, documentNo, existing: false };
}

/**
 * Posting moves the stock line by line through Phase 11 — an issue at FIFO
 * cost, a return at the cost it went out at — and the cost rows follow in
 * the same transaction. Locked on the row, so a double post posts once.
 */
export async function postIssue(tx: Tx, ctx: ActorContext, documentNo: string): Promise<{ totalCostIqd: bigint }> {
  const [doc] = await tx.select().from(projectMaterialIssue).where(eq(projectMaterialIssue.documentNo, documentNo)).for('update');
  if (!doc) throw new AdminNotFoundError('project_material_issue', documentNo);
  await permit(ctx, 'post', PERMISSION_OBJECT, doc.projectCode);
  if (doc.status !== 'draft') throw new ProjectSystemError('status', `${documentNo} is ${doc.status}; a draft is posted`);
  const lines = await tx.select().from(projectMaterialIssueLine).where(eq(projectMaterialIssueLine.issueId, doc.id)).orderBy(asc(projectMaterialIssueLine.lineNo));
  let total = 0n;
  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    const common = { itemCode: line.itemCode, warehouseCode: doc.warehouseCode, quantity, movementDate: doc.movementDate, costCode: doc.costCode, wbsCode: doc.wbsCode, serialNumber: line.serialNumber, batchNumber: line.batchNumber };
    let movementId: string;
    let costIqd: bigint;
    if (doc.kind === 'issue') {
      const moved = await projects.issueToProject(tx, ctx, doc.projectCode, common);
      movementId = moved.movementId;
      costIqd = moved.costIqd;
    } else {
      const moved = await projects.returnFromProject(tx, ctx, doc.projectCode, { ...common, unitCostIqd: parseDecimal(line.unitCostIqd ?? '0', MONEY) });
      movementId = moved.movementId;
      costIqd = moved.creditedIqd;
    }
    total += doc.kind === 'issue' ? costIqd : -costIqd;
    // The cost row Phase 11 wrote for this movement: the latest on the element at this amount.
    const [cost] = await tx
      .select({ id: projectCost.id })
      .from(projectCost)
      .where(and(eq(projectCost.projectCode, doc.projectCode), eq(projectCost.wbsCode, doc.wbsCode), eq(projectCost.kind, doc.kind === 'issue' ? 'material_issue' : 'material_return')))
      .orderBy(desc(projectCost.createdAt))
      .limit(1);
    if (cost) await tx.update(projectCost).set({ sourceType: ISSUE_DOCUMENT_TYPE, sourceId: documentNo }).where(eq(projectCost.id, cost.id));
    await tx
      .update(projectMaterialIssueLine)
      .set({ movementId, costId: cost?.id ?? null, costIqd: toDecimalString(costIqd, MONEY) })
      .where(eq(projectMaterialIssueLine.id, line.id));
  }
  // D-PM-13 — the document posts: the stock's FIFO cost leaves the items'
  // inventory accounts for the element's cost (the cost code's account when
  // it names one, the project_material_cost mapping otherwise); a return the
  // other way. One journal per document, its cost rows pointed at it.
  const journalEntryId = await postIssueJournal(tx, ctx, doc, documentNo);
  if (journalEntryId) {
    const costIds = (await tx.select({ costId: projectMaterialIssueLine.costId }).from(projectMaterialIssueLine).where(eq(projectMaterialIssueLine.issueId, doc.id)))
      .map((l) => l.costId)
      .filter((id): id is string => Boolean(id));
    if (costIds.length) await tx.update(projectCost).set({ journalEntryId }).where(inArray(projectCost.id, costIds));
  }
  await tx
    .update(projectMaterialIssue)
    .set({ status: 'posted', postedBy: ctx.principal.userId, postedAt: new Date(), totalCostIqd: toDecimalString(total, MONEY), journalEntryId, updatedAt: new Date() })
    .where(eq(projectMaterialIssue.id, doc.id));
  await recordChange(tx, ctx, {
    action: 'project_material_issue.posted',
    objectType: ISSUE_DOCUMENT_TYPE,
    objectId: documentNo,
    branchCode: doc.branchCode,
    before: { status: 'draft' },
    after: { status: 'posted', totalCostIqd: toDecimalString(total, MONEY), lines: lines.length },
  });
  return { totalCostIqd: total };
}

async function postIssueJournal(tx: Tx, ctx: ActorContext, doc: typeof projectMaterialIssue.$inferSelect, documentNo: string): Promise<string | null> {
  const lines = (
    await tx.execute(sql`
      select i.inventory_account_id as account, coalesce(sum(l.cost_iqd), 0)::text as cost
        from project_material_issue_line l
        join item i on i.code = l.item_code
       where l.issue_id = ${doc.id}::uuid
       group by i.inventory_account_id`)
  ).rows as { account: string | null; cost: string }[];
  const total = lines.reduce((sum, l) => sum + parseDecimal(l.cost, MONEY), 0n);
  if (total === 0n) return null;
  const [owner] = await tx.select({ departmentCode: project.departmentCode, businessLineCode: project.businessLineCode }).from(project).where(eq(project.code, doc.projectCode)).limit(1);
  const [code] = await tx.select({ accountId: projectCostCode.accountId }).from(projectCostCode).where(eq(projectCostCode.code, doc.costCode)).limit(1);
  const criteria = { branchCode: doc.branchCode, projectCode: doc.projectCode, warehouseCode: doc.warehouseCode };
  const dimensions = { branch: doc.branchCode, project: doc.projectCode, warehouse: doc.warehouseCode, department: owner?.departmentCode ?? null, business_line: owner?.businessLineCode ?? null };
  const issue = doc.kind === 'issue';
  const amount = (v: bigint) => toDecimalString(v < 0n ? -v : v, MONEY);
  const costLine = { role: 'project_material_cost', ...(code?.accountId ? { accountId: code.accountId } : {}), criteria, dimensions };
  const result = await posting.post(tx, ctx, {
    eventType: 'projects.material_issue',
    documentTypeCode: ISSUE_DOCUMENT_TYPE,
    source: { module: 'projects', documentId: doc.id, event: 'posted' },
    branchCode: doc.branchCode,
    documentDate: doc.movementDate,
    postingDate: doc.movementDate,
    description: `${issue ? 'Material issue' : 'Material return'} ${documentNo} — ${doc.projectCode} / ${doc.wbsCode}`,
    lines: [
      issue ? { ...costLine, debit: amount(total) } : { ...costLine, credit: amount(total) },
      ...lines
        .filter((l) => parseDecimal(l.cost, MONEY) !== 0n)
        .map((l) => {
          const stock = { role: 'inventory', ...(l.account ? { itemAccountId: l.account } : {}), criteria, dimensions };
          return issue ? { ...stock, credit: amount(parseDecimal(l.cost, MONEY)) } : { ...stock, debit: amount(parseDecimal(l.cost, MONEY)) };
        }),
    ],
  });
  return result.journalEntryId;
}

export async function cancelIssue(tx: Tx, ctx: ActorContext, documentNo: string, reason: string): Promise<void> {
  const doc = await loadIssue(tx, documentNo);
  await permit(ctx, 'edit_draft', PERMISSION_OBJECT, doc.projectCode);
  if (doc.status !== 'draft') throw new ProjectSystemError('status', `${documentNo} is ${doc.status}; only a draft is cancelled — a posted issue is returned`);
  const why = requireText(reason, 'reason');
  await tx.update(projectMaterialIssue).set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt: new Date(), cancelReason: why, updatedAt: new Date() }).where(eq(projectMaterialIssue.id, doc.id));
  await recordChange(tx, ctx, { action: 'project_material_issue.cancelled', objectType: ISSUE_DOCUMENT_TYPE, objectId: documentNo, branchCode: doc.branchCode, before: { status: 'draft' }, after: { status: 'cancelled' }, reason: why });
}

export interface IssueFilter {
  readonly projectCode?: string | null;
  readonly status?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

export async function issues(tx: Tx, filter: IssueFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, filter.pageSize ?? PAGE_SIZE));
  const where = [
    filter.projectCode ? sql`d.project_code = ${filter.projectCode}` : null,
    filter.status ? sql`d.status = ${filter.status}` : null,
    filter.search ? sql`(d.document_no ilike ${'%' + filter.search + '%'} or p.name ilike ${'%' + filter.search + '%'} or d.wbs_code ilike ${'%' + filter.search + '%'})` : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const [count] = (await tx.execute(sql`select count(*)::int as n from project_material_issue d join project p on p.code = d.project_code ${whereSql}`)).rows as { n: number }[];
  const rows = (
    await tx.execute(sql`
      select d.document_no, d.project_code, p.name as project_name, d.wbs_code, d.cost_code, d.warehouse_code, d.kind, d.status, d.movement_date::text,
             d.total_cost_iqd::text, u.display_name as created_by, (select count(*) from project_material_issue_line l where l.issue_id = d.id)::int as lines
        from project_material_issue d
        join project p on p.code = d.project_code
        join app_user u on u.id = d.created_by
        ${whereSql}
       order by d.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}`)
  ).rows as {
    document_no: string;
    project_code: string;
    project_name: string;
    wbs_code: string;
    cost_code: string;
    warehouse_code: string;
    kind: string;
    status: string;
    movement_date: string;
    total_cost_iqd: string;
    created_by: string;
    lines: number;
  }[];
  return {
    total: count?.n ?? 0,
    page,
    pageSize,
    rows: rows.map((r) => ({
      documentNo: r.document_no,
      projectCode: r.project_code,
      projectName: r.project_name,
      wbsCode: r.wbs_code,
      costCode: r.cost_code,
      warehouseCode: r.warehouse_code,
      kind: r.kind,
      status: r.status,
      movementDate: r.movement_date,
      totalCostIqd: r.total_cost_iqd,
      createdBy: r.created_by,
      lines: r.lines,
    })),
  };
}

export async function issue(tx: Tx, ctx: ActorContext, documentNo: string) {
  const doc = await loadIssue(tx, documentNo);
  await permit(ctx, 'view', PERMISSION_OBJECT, doc.projectCode);
  const [row] = await tx.select().from(project).where(eq(project.code, doc.projectCode)).limit(1);
  const [element] = await tx.select({ name: projectWbs.name }).from(projectWbs).where(and(eq(projectWbs.projectCode, doc.projectCode), eq(projectWbs.code, doc.wbsCode))).limit(1);
  const lines = await tx
    .select({ line: projectMaterialIssueLine, itemName: item.name })
    .from(projectMaterialIssueLine)
    .leftJoin(item, eq(item.code, projectMaterialIssueLine.itemCode))
    .where(eq(projectMaterialIssueLine.issueId, doc.id))
    .orderBy(asc(projectMaterialIssueLine.lineNo));
  const ids = [doc.createdBy, doc.postedBy, doc.cancelledBy].filter((id): id is string => Boolean(id));
  const people = ids.length ? await tx.select({ id: appUser.id, name: appUser.displayName }).from(appUser).where(inArray(appUser.id, ids)) : [];
  const nameOf = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
  return {
    document: doc,
    project: row!,
    elementName: element?.name ?? null,
    lines: lines.map((l) => ({ ...l.line, itemName: l.itemName })),
    people: { createdBy: nameOf(doc.createdBy), postedBy: nameOf(doc.postedBy), cancelledBy: nameOf(doc.cancelledBy) },
  };
}

// ---------------------------------------------------------------------------
// The registers (§13): line items, procurement
// ---------------------------------------------------------------------------

export interface LineItemFilter {
  readonly projectCode?: string | null;
  readonly wbsCode?: string | null;
  readonly costCode?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

/** PM7 — the line items: every cost row with its document and journal, filtered by project, element and period. */
export async function lineItems(tx: Tx, filter: LineItemFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, Math.min(20_001, filter.pageSize ?? PAGE_SIZE));
  const where = [
    filter.projectCode ? sql`k.project_code = ${filter.projectCode}` : null,
    filter.wbsCode ? sql`(k.wbs_code = ${filter.wbsCode} or k.wbs_code like ${filter.wbsCode + '.%'})` : null,
    filter.costCode ? sql`k.cost_code = ${filter.costCode}` : null,
    filter.from ? sql`k.incurred_on >= ${filter.from}::date` : null,
    filter.to ? sql`k.incurred_on <= ${filter.to}::date` : null,
    filter.search ? sql`(k.description ilike ${'%' + filter.search + '%'} or k.source_id ilike ${'%' + filter.search + '%'} or coalesce(j.entry_no, '') ilike ${'%' + filter.search + '%'})` : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const base = sql`from project_cost k join project p on p.code = k.project_code left join journal_entry j on j.id = k.journal_entry_id ${whereSql}`;
  const [count] = (await tx.execute(sql`select count(*)::int as n, coalesce(sum(k.amount_iqd), 0)::text as total ${base}`)).rows as { n: number; total: string }[];
  const rows = (
    await tx.execute(sql`
      select k.id, k.project_code, p.name as project_name, k.wbs_code, k.cost_code, k.kind, k.description, k.incurred_on::text, k.amount_iqd::text,
             k.source_type, k.source_id, j.entry_no as journal_no, k.reverses_cost_id is not null as is_reversal,
             (select i.invoice_no from ap_invoice i where k.source_type = 'ap_invoice' and i.id::text = k.source_id) as invoice_no
      ${base}
      order by k.incurred_on desc, k.created_at desc
      limit ${pageSize} offset ${(page - 1) * pageSize}`)
  ).rows as {
    id: string;
    project_code: string;
    project_name: string;
    wbs_code: string | null;
    cost_code: string;
    kind: string;
    description: string;
    incurred_on: string;
    amount_iqd: string;
    source_type: string | null;
    source_id: string | null;
    journal_no: string | null;
    is_reversal: boolean;
    invoice_no: string | null;
  }[];
  return {
    total: count?.n ?? 0,
    totalIqd: count?.total ?? '0',
    page,
    pageSize,
    rows: rows.map((r) => ({
      id: r.id,
      projectCode: r.project_code,
      projectName: r.project_name,
      wbsCode: r.wbs_code,
      costCode: r.cost_code,
      kind: r.kind,
      description: r.description,
      incurredOn: r.incurred_on,
      amountIqd: r.amount_iqd,
      sourceType: r.source_type,
      sourceId: r.source_id,
      journalNo: r.journal_no,
      isReversal: r.is_reversal,
      invoiceNo: r.invoice_no,
    })),
  };
}

/**
 * PM7's other half: the expense lines of the journal carrying the project
 * dimension. Stock bought for a project is an asset until a material issue
 * takes it to an element, so it is not here and not in the line items until
 * then; the issues are in the line items and not here — the screen says so.
 */
export async function journalTotal(tx: Tx, projectCode: string, period: { from?: string | null; to?: string | null } = {}): Promise<bigint> {
  const [row] = (
    await tx.execute(sql`
      select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as total
        from journal_line l
        join journal_entry j on j.id = l.journal_entry_id
        join chart_of_account a on a.id = l.account_id
       where l.project_code = ${projectCode} and j.status = 'posted'
         and a.account_type = 'expense'
         ${period.from ? sql`and j.posting_date >= ${period.from}::date` : sql``}
         ${period.to ? sql`and j.posting_date <= ${period.to}::date` : sql``}`)
  ).rows as { total: string }[];
  return parseDecimal(row?.total ?? '0', MONEY);
}

export interface ProcurementFilter {
  readonly projectCode?: string | null;
  readonly search?: string | null;
  readonly page?: number;
  readonly pageSize?: number;
}

/** The orders and payables assigned to elements, with the promise, what it became and what was given back. */
export async function procurement(tx: Tx, filter: ProcurementFilter = {}) {
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.max(1, Math.min(200, filter.pageSize ?? PAGE_SIZE));
  const where = [
    filter.projectCode ? sql`x.project_code = ${filter.projectCode}` : null,
    filter.search ? sql`(x.document_no ilike ${'%' + filter.search + '%'} or x.supplier_name ilike ${'%' + filter.search + '%'} or x.reference ilike ${'%' + filter.search + '%'})` : null,
  ].filter((c): c is NonNullable<typeof c> => c !== null);
  const whereSql = where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``;
  const union = sql`
    (select 'purchase_order' as document_type, o.id::text as document_id, o.order_no as document_no, o.reference, o.status::text as status, o.order_date as document_date,
            o.project_code, o.wbs_code, o.cost_code,
            (select round(coalesce(sum(l.quantity * l.unit_price), 0), 4) from purchase_order_line l where l.purchase_order_id = o.id) as amount_iqd,
            s.legal_name as supplier_name, s.code as supplier_code,
            (select coalesce(sum(c.amount_iqd), 0) from project_commitment c where c.purchase_order_id = o.id) as committed_iqd,
            (select coalesce(sum(c.consumed_iqd), 0) from project_commitment c where c.purchase_order_id = o.id) as consumed_iqd,
            (select coalesce(sum(c.amount_iqd - c.consumed_iqd), 0) from project_commitment c where c.purchase_order_id = o.id and c.released_on is not null) as released_iqd,
            o.created_at
       from purchase_order o join business_partner s on s.id = o.supplier_id
      where o.project_code is not null)
    union all
    (select 'payable', y.id::text, y.payable_no, y.supplier_reference, y.stage_code, y.document_date,
            y.project_code, y.wbs_code, y.cost_code, y.amount_iqd, s.legal_name, s.code,
            (select coalesce(sum(c.amount_iqd), 0) from project_commitment c where c.payable_id = y.id),
            (select coalesce(sum(c.consumed_iqd), 0) from project_commitment c where c.payable_id = y.id),
            (select coalesce(sum(c.amount_iqd - c.consumed_iqd), 0) from project_commitment c where c.payable_id = y.id and c.released_on is not null),
            y.created_at
       from payable y join business_partner s on s.id = y.supplier_id
      where y.project_code is not null and y.purchase_order_id is null)`;
  const [count] = (await tx.execute(sql`select count(*)::int as n from (${union}) x ${whereSql}`)).rows as { n: number }[];
  const rows = (
    await tx.execute(sql`
      select x.document_type, x.document_id, x.document_no, x.reference, x.status, x.document_date::text, x.project_code, x.wbs_code, x.cost_code,
             x.amount_iqd::text, x.supplier_name, x.supplier_code, x.committed_iqd::text, x.consumed_iqd::text, x.released_iqd::text
        from (${union}) x ${whereSql}
       order by x.created_at desc
       limit ${pageSize} offset ${(page - 1) * pageSize}`)
  ).rows as {
    document_type: string;
    document_id: string;
    document_no: string;
    reference: string | null;
    status: string;
    document_date: string;
    project_code: string;
    wbs_code: string;
    cost_code: string;
    amount_iqd: string;
    supplier_name: string;
    supplier_code: string;
    committed_iqd: string;
    consumed_iqd: string;
    released_iqd: string;
  }[];
  return {
    total: count?.n ?? 0,
    page,
    pageSize,
    rows: rows.map((r) => ({
      documentType: r.document_type as 'purchase_order' | 'payable',
      documentId: r.document_id,
      documentNo: r.document_no,
      reference: r.reference,
      status: r.status,
      documentDate: r.document_date,
      projectCode: r.project_code,
      wbsCode: r.wbs_code,
      costCode: r.cost_code,
      amountIqd: r.amount_iqd,
      supplierName: r.supplier_name,
      supplierCode: r.supplier_code,
      committedIqd: r.committed_iqd,
      consumedIqd: r.consumed_iqd,
      releasedIqd: r.released_iqd,
      openIqd: toDecimalString(parseDecimal(r.committed_iqd, MONEY) - parseDecimal(r.consumed_iqd, MONEY) - parseDecimal(r.released_iqd, MONEY), MONEY),
    })),
  };
}

/** The assignment pickers a purchasing form shows: active projects' account-assignment elements, and the cost codes. */
export async function assignmentPickers(tx: Tx) {
  const elements = await tx
    .select({ projectCode: projectWbs.projectCode, projectName: project.name, wbsCode: projectWbs.code, name: projectWbs.name })
    .from(projectWbs)
    .innerJoin(project, eq(project.code, projectWbs.projectCode))
    .where(and(eq(projectWbs.active, true), eq(projectWbs.isAccountAssignment, true), inArray(project.status, ['draft', 'active'])))
    .orderBy(asc(projectWbs.projectCode), asc(projectWbs.code));
  const codes = await tx.select().from(projectCostCode).where(eq(projectCostCode.active, true)).orderBy(asc(projectCostCode.code));
  return { elements, codes };
}

