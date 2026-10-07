/**
 * Manual Stock Addition — stock put onto the books without a purchase
 * (2026-10-06, by direction: "manually adding items in warehouse report
 * sometimes it's needed … to which warehouse, quantity, stock price and unit,
 * and note for audit … needs approval too; if superadmin no need — draft →
 * approval").
 *
 *   Draft      the sheet: a warehouse, a posting date, the reason, optionally
 *              the account the value is credited to, and lines of item /
 *              unit / quantity / stock price. Edited while it is a draft.
 *   Submitted  sent for approval; the approvers are told (`approval.required`).
 *   Approved   by somebody who holds `approve` and neither raised nor sent it.
 *              Approving is the posting: each line is received into the
 *              warehouse through `inventory.receive` — in the item's base unit,
 *              at the cost of one base unit, one FIFO layer a line, under the
 *              warehouse's branch — and one journal is posted:
 *                Dr each item's own inventory account   (the layers' value)
 *                Cr inventory adjustment                 (`inventory.stock_adjustment`,
 *                                                         the mapping Item
 *                                                         Reconciliation and a
 *                                                         Stock Count surplus use)
 *              or, when the sheet named one, Cr that account.
 *   Rejected   with a reason, back to its author, who reopens it as a draft or
 *              cancels it.
 *   Cancelled  a draft (or a rejected one) set aside, with a reason.
 *
 * A super user's own draft goes from Draft to Approved in one press: the
 * submission and the approval are both recorded, in one transaction, as
 * `ap-invoice.approveDraft` does (the owner's 2026-10-03 direction, 0278).
 *
 * Every transition locks the row (`for update`) before it reads the status, so
 * a double press moves it once; every transition is an audit row. The
 * database holds the road, the four eyes and the frozen lines itself (0415).
 */
import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  chartOfAccount,
  department,
  item as itemTable,
  manualStockAddition,
  manualStockAdditionLine,
  warehouse,
} from '../db/schema';
import { businessToday } from '../domain/business-date';
import { costOf } from '../domain/fifo';
import { MONEY_SCALE, divideHalfUp, parseDecimal, toDecimalString } from '../domain/money';
import { QUANTITY_FACTOR, formatQuantity, parseQuantity } from '../domain/uom';
import { can, type Principal } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as itemUnits from './item-units';
import * as notifications from './notifications';
import * as periods from './periods';
import * as posting from './posting';
import { allocateDocumentNumber } from './numbering';
import { registerPage, searchOf, type RegisterPage, type RegisterPaging } from './register-page';
import { datesOrder, withinDates } from './register-dates-sql';
import type { RegisterDates } from '../domain/register-dates';

export const PERMISSION_OBJECT = 'manual_stock_addition';
export const DOCUMENT_TYPE = 'manual_stock_addition';
const SEQUENCE_KEY = 'MANUAL_STOCK_ADDITION';
/** The event the journal posts under — the mapping Item Reconciliation and a Stock Count already ask Finance for. */
export const POSTING_EVENT = 'inventory.stock_adjustment';
export const OFFSET_ROLE = 'inventory_adjustment';
/** Where the screens live. */
export const ROUTE = '/inventory/manual-additions';
const MAX_LINES = 200;

export type AdditionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled';

export class ManualAdditionError extends Error {
  readonly code = 'MANUAL_STOCK_ADDITION';
  constructor(detail: string) {
    super(detail);
    this.name = 'ManualAdditionError';
  }
}

export class ManualAdditionNotFoundError extends Error {
  readonly code = 'MANUAL_STOCK_ADDITION_NOT_FOUND';
  constructor(id: string) {
    super(`No manual stock addition '${id}'.`);
    this.name = 'ManualAdditionNotFoundError';
  }
}

export class ManualAdditionStateError extends Error {
  readonly code = 'MANUAL_STOCK_ADDITION_STATE';
  constructor(additionNo: string, status: string, detail: string) {
    super(`Manual stock addition ${additionNo} is '${status}': ${detail}`);
    this.name = 'ManualAdditionStateError';
  }
}

export interface AdditionLineInput {
  readonly itemCode: string;
  /** The unit the line is written in; the item's base unit when empty. */
  readonly uomCode?: string | null;
  /** In the line's unit, scaled at 1e6. */
  readonly quantity: bigint;
  /** IQD for one of the line's unit, scaled at 1e4 — the stock price. */
  readonly unitCostIqd: bigint;
}

export interface AdditionInput {
  readonly warehouseCode: string;
  readonly postingDate: string;
  /** Why the stock is added — the note the audit keeps. */
  readonly reason: string;
  /** The account the value is credited to; empty = the inventory adjustment mapping. */
  readonly offsetAccountId?: string | null;
  /** The department the journal is analysed by (0416), when the accounts ask for one. */
  readonly departmentCode?: string | null;
  readonly lines: readonly AdditionLineInput[];
  /** The sheet's one-time key — see `claimDocumentId`. */
  readonly documentId?: string | null;
}

// ---------------------------------------------------------------------------
// The arithmetic — scaled integers, half up, never a float
// ---------------------------------------------------------------------------

/** A line's value: quantity × stock price, at money's four places, half up (the 0415 check's `round`). */
export function lineValueOf(quantity: bigint, unitCostIqd: bigint): bigint {
  return costOf(quantity, unitCostIqd);
}

/** The cost of one base unit: the line's value over its quantity in base units, half up. */
export function baseUnitCostOf(lineValueIqd: bigint, baseQuantity: bigint): bigint {
  if (baseQuantity <= 0n) throw new ManualAdditionError('A line brings in nothing in the item\'s base unit.');
  return divideHalfUp(lineValueIqd * QUANTITY_FACTOR, baseQuantity);
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The document's identity, chosen by the sheet before it is saved — its
 * one-time key, as the Transfer and Reconciliation forms carry. Two presses of
 * one sheet send one id; the second finds the first already saved. Locked for
 * the transaction, so two presses arriving together serialise.
 */
async function claimDocumentId(tx: Tx, supplied: string | null | undefined): Promise<string> {
  if (!supplied) return randomUUID();
  if (!UUID.test(supplied)) throw new ManualAdditionError('The sheet is stale. Open it again.');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${supplied}))`);
  return supplied.toLowerCase();
}

/** A warehouse stock may be added to by hand: active, a main store (not in transit, no shipment stage), of this branch. */
async function usableWarehouse(tx: Tx, ctx: ActorContext, code: string) {
  const [row] = await tx
    .select({
      code: warehouse.code,
      branchCode: warehouse.branchCode,
      active: warehouse.active,
      warehouseType: warehouse.warehouseType,
      isTransit: warehouse.isTransit,
      shipmentStage: warehouse.shipmentStage,
    })
    .from(warehouse)
    .where(eq(warehouse.code, code))
    .limit(1);
  if (!row) throw new ManualAdditionError('Choose the warehouse the stock is added to.');
  if (!row.active) throw new ManualAdditionError(`${code} is inactive, so no stock can be added to it.`);
  if (row.isTransit || row.shipmentStage !== null || row.warehouseType !== 'main') {
    throw new ManualAdditionError(
      `${code} is not a main store (goods in transit or at a shipment stage arrive with their import). Choose a main warehouse.`,
    );
  }
  if (row.branchCode !== ctx.branchCode) {
    throw new ManualAdditionError(`${code} belongs to branch ${row.branchCode}. Choose a warehouse of this branch, or switch branch first.`);
  }
  return row;
}

function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ManualAdditionError('Enter the posting date.');
  if (value > businessToday()) {
    throw new ManualAdditionError(`The posting date ${value} is after today. Stock is added on the day it is there.`);
  }
}

/** The account the value may be credited to: postable, in dinars, not a control account, not a bank or cash account. */
async function assertOffsetAccount(tx: Tx, accountId: string): Promise<void> {
  if (!UUID.test(accountId)) throw new ManualAdditionError('Choose the offset account from the list.');
  const [account] = await tx
    .select({
      code: chartOfAccount.code,
      isActive: chartOfAccount.isActive,
      approvalStatus: chartOfAccount.approvalStatus,
      isGroup: chartOfAccount.isGroup,
      controlAccount: chartOfAccount.controlAccount,
      currencyRestriction: chartOfAccount.currencyRestriction,
    })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, accountId))
    .limit(1);
  if (!account) throw new ManualAdditionError('Choose the offset account from the list.');
  if (!account.isActive || account.approvalStatus !== 'approved' || account.isGroup) {
    throw new ManualAdditionError(`${account.code} is not a postable account (active, approved, not a group). Choose another, or leave it empty for the inventory adjustment account.`);
  }
  if (account.controlAccount) {
    throw new ManualAdditionError(`${account.code} is the ${account.controlAccount} control account, which is posted by its own documents. Choose another, or leave it empty.`);
  }
  if (account.currencyRestriction && account.currencyRestriction !== 'IQD') {
    throw new ManualAdditionError(`${account.code} takes ${account.currencyRestriction} only, and stock is valued in IQD.`);
  }
  const bank = await tx.execute(sql`select 1 from bank_cash_account where gl_account_id = ${accountId}::uuid limit 1`);
  if (bank.rows.length > 0) {
    throw new ManualAdditionError(`${account.code} is a bank or cash account; money is moved by its own documents. Choose another, or leave it empty.`);
  }
}

interface CheckedLine {
  readonly itemCode: string;
  readonly uomCode: string;
  readonly quantity: bigint;
  readonly unitCostIqd: bigint;
  readonly lineValueIqd: bigint;
}

/** Every line refused while it can still be corrected: the item, its unit, the figures. */
async function checkLines(tx: Tx, lines: readonly AdditionLineInput[]): Promise<CheckedLine[]> {
  if (lines.length === 0) throw new ManualAdditionError('Add at least one line: the item, its unit, the quantity and the stock price.');
  if (lines.length > MAX_LINES) throw new ManualAdditionError(`A manual addition carries at most ${MAX_LINES} lines.`);
  const checked: CheckedLine[] = [];
  for (const [index, line] of lines.entries()) {
    const no = index + 1;
    const code = line.itemCode.trim();
    const [stocked] = await tx
      .select({
        code: itemTable.code,
        isStock: itemTable.isStock,
        active: itemTable.active,
        tracking: itemTable.tracking,
        inventoryAccountId: itemTable.inventoryAccountId,
      })
      .from(itemTable)
      .where(eq(itemTable.code, code))
      .limit(1);
    if (!stocked) throw new ManualAdditionError(`Line ${no}: no item '${code}'. Choose an item from the list.`);
    if (!stocked.isStock) throw new inventory.ItemNotStockedError(code);
    if (!stocked.active) throw new ManualAdditionError(`Line ${no}: ${code} is not in use.`);
    if (stocked.tracking === 'serial' || stocked.tracking === 'serial_and_batch') {
      throw new ManualAdditionError(
        `Line ${no}: ${code} is tracked by serial number, one per unit. Bring it in on Opening Stock or a Purchase Invoice, which take its serials.`,
      );
    }
    if (!stocked.inventoryAccountId) {
      throw new ManualAdditionError(`Line ${no}: ${code} names no inventory account, so its value has nowhere to post. Set one on the item.`);
    }
    if (line.quantity <= 0n) throw new ManualAdditionError(`Line ${no}: enter a quantity above zero.`);
    if (line.unitCostIqd <= 0n) throw new ManualAdditionError(`Line ${no}: enter the stock price — what one unit cost, above zero.`);
    const uomCode = await itemUnits.assertLineUnit(tx, code, line.uomCode);
    // Exact in the base unit, or refused now rather than at approval.
    await itemUnits.toBaseQuantity(tx, code, uomCode, line.quantity);
    checked.push({
      itemCode: code,
      uomCode,
      quantity: line.quantity,
      unitCostIqd: line.unitCostIqd,
      lineValueIqd: lineValueOf(line.quantity, line.unitCostIqd),
    });
  }
  return checked;
}

async function checkHeader(tx: Tx, ctx: ActorContext, input: AdditionInput) {
  await usableWarehouse(tx, ctx, input.warehouseCode.trim());
  assertDate(input.postingDate.trim());
  const reason = input.reason.trim();
  if (!reason) throw new ManualAdditionError('Say why the stock is being added — the note is kept with the record for the audit.');
  if (reason.length > 2000) throw new ManualAdditionError('Keep the note to 2,000 characters.');
  const offset = input.offsetAccountId?.trim() || null;
  if (offset) await assertOffsetAccount(tx, offset);
  const departmentCode = input.departmentCode?.trim() || null;
  if (departmentCode) {
    const [found] = await tx
      .select({ active: department.active })
      .from(department)
      .where(eq(department.code, departmentCode))
      .limit(1);
    if (!found?.active) throw new ManualAdditionError(`No department '${departmentCode}' in use. Choose one from the list, or leave it empty.`);
  }
  return {
    warehouseCode: input.warehouseCode.trim(),
    postingDate: input.postingDate.trim(),
    reason,
    offsetAccountId: offset,
    departmentCode,
  };
}

async function writeLines(tx: Tx, additionId: string, lines: readonly CheckedLine[]): Promise<void> {
  for (const [index, line] of lines.entries()) {
    await tx.insert(manualStockAdditionLine).values({
      additionId,
      lineNo: index + 1,
      itemCode: line.itemCode,
      uomCode: line.uomCode,
      quantity: formatQuantity(line.quantity),
      unitCostIqd: toDecimalString(line.unitCostIqd, MONEY_SCALE),
      lineValueIqd: toDecimalString(line.lineValueIqd, MONEY_SCALE),
    });
  }
}

const totalOf = (lines: readonly CheckedLine[]) => lines.reduce((sum, line) => sum + line.lineValueIqd, 0n);

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

async function load(tx: Tx, id: string, options: { lock?: boolean } = {}) {
  if (!UUID.test(id)) throw new ManualAdditionNotFoundError(id);
  const header = tx.select().from(manualStockAddition).where(eq(manualStockAddition.id, id)).limit(1);
  const [document] = await (options.lock ? header.for('update') : header);
  if (!document) throw new ManualAdditionNotFoundError(id);
  const lines = await tx
    .select()
    .from(manualStockAdditionLine)
    .where(eq(manualStockAdditionLine.additionId, id))
    .orderBy(asc(manualStockAdditionLine.lineNo));
  return { document, lines };
}

/**
 * Raises the sheet as a draft. Nothing moves and nothing posts. A sheet sent
 * twice with one `documentId` answers with the document the first made.
 */
export async function create(tx: Tx, ctx: ActorContext, input: AdditionInput): Promise<{ id: string; additionNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const id = await claimDocumentId(tx, input.documentId);
  const [already] = await tx
    .select({ id: manualStockAddition.id, additionNo: manualStockAddition.additionNo })
    .from(manualStockAddition)
    .where(eq(manualStockAddition.id, id))
    .limit(1);
  if (already) return already;

  const header = await checkHeader(tx, ctx, input);
  const lines = await checkLines(tx, input.lines);
  const { documentNo } = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: ctx.branchCode, year: Number(header.postingDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  await tx.insert(manualStockAddition).values({
    id,
    additionNo: documentNo,
    branchCode: ctx.branchCode,
    warehouseCode: header.warehouseCode,
    postingDate: header.postingDate,
    reason: header.reason,
    offsetAccountId: header.offsetAccountId,
    departmentCode: header.departmentCode,
    createdBy: ctx.principal.userId,
  });
  await writeLines(tx, id, lines);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.created',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: ctx.branchCode,
    after: {
      additionNo: documentNo,
      warehouse: header.warehouseCode,
      postingDate: header.postingDate,
      lines: lines.length,
      totalIqd: toDecimalString(totalOf(lines), MONEY_SCALE),
      offsetAccountId: header.offsetAccountId,
      department: header.departmentCode,
    },
    reason: header.reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id, additionNo: documentNo };
}

/** Rewrites a draft — its header and all its lines — from the sheet. */
export async function updateDraft(tx: Tx, ctx: ActorContext, id: string, input: AdditionInput): Promise<{ id: string; additionNo: string }> {
  const { document, lines: before } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: document.branchCode });
  if (document.status !== 'draft') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a draft is edited; reopen a rejected one first.');
  }
  const header = await checkHeader(tx, { ...ctx, branchCode: document.branchCode }, input);
  const lines = await checkLines(tx, input.lines);

  await tx
    .update(manualStockAddition)
    .set({ ...header, updatedAt: new Date() })
    .where(eq(manualStockAddition.id, id));
  await tx.delete(manualStockAdditionLine).where(eq(manualStockAdditionLine.additionId, id));
  await writeLines(tx, id, lines);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.updated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: {
      warehouse: document.warehouseCode,
      postingDate: document.postingDate,
      lines: before.length,
      totalIqd: toDecimalString(before.reduce((sum, line) => sum + parseDecimal(line.lineValueIqd, MONEY_SCALE), 0n), MONEY_SCALE),
      offsetAccountId: document.offsetAccountId,
      department: document.departmentCode,
      note: document.reason,
    },
    after: {
      warehouse: header.warehouseCode,
      postingDate: header.postingDate,
      lines: lines.length,
      totalIqd: toDecimalString(totalOf(lines), MONEY_SCALE),
      offsetAccountId: header.offsetAccountId,
      department: header.departmentCode,
      note: header.reason,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  return { id, additionNo: document.additionNo };
}

/** The active people who hold a verb on manual additions in a branch. */
async function holders(tx: Tx, verb: 'approve', branchCode: string): Promise<string[]> {
  const rows = (
    await tx.execute(sql`
      select distinct u.id
        from app_user u
        join user_role ur on ur.user_id = u.id
        join role_grant g on g.role_code = ur.role_code
       where u.is_active and g.object = ${PERMISSION_OBJECT} and g.verb = ${verb}::permission_verb
         and exists (select 1 from user_branch_scope s where s.user_id = u.id and s.branch_code = ${branchCode})`)
  ).rows as { id: string }[];
  return rows.map((row) => row.id);
}

const recordHref = (additionNo: string) => `${ROUTE}/${encodeURIComponent(additionNo)}`;

/** Sends a draft for approval. The approvers — not its author, not its sender — are told. */
export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { document, lines } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, { branchCode: document.branchCode });
  if (document.status !== 'draft') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a draft is sent for approval.');
  }
  if (lines.length === 0) throw new ManualAdditionError(`${document.additionNo} has no lines; add what is being brought in first.`);

  const submittedAt = new Date();
  await tx
    .update(manualStockAddition)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, submittedAt, updatedAt: submittedAt })
    .where(eq(manualStockAddition.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  const recipients = (await holders(tx, 'approve', document.branchCode)).filter(
    (userId) => userId !== ctx.principal.userId && userId !== document.createdBy,
  );
  if (recipients.length > 0) {
    await notifications.safely(tx, (sp) =>
      notifications.emit(sp, {
        kind: 'approval.required',
        objectType: DOCUMENT_TYPE,
        objectId: id,
        recipients,
        subject: `Approval required: ${document.additionNo}`,
        body: `Manual stock addition into ${document.warehouseCode}.`,
        context: { reference: document.additionNo, documentType: DOCUMENT_TYPE, href: recordHref(document.additionNo) },
        occurrence: `submitted:${submittedAt.toISOString()}`,
        branchCode: document.branchCode,
        actorUserId: ctx.principal.userId,
      }),
    );
  }
}

/**
 * Approves a submitted addition — and so posts it: the stock in, the layers,
 * the journal, in one transaction.
 */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  id: string,
): Promise<{ movementIds: readonly string[]; journalEntryId: string; totalIqd: string }> {
  const { document, lines } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: document.branchCode });
  if (document.status !== 'submitted') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a document sent for approval is approved.');
  }
  // Four eyes — the database holds it too (0415 `manual_stock_addition_four_eyes`).
  if (!ctx.principal.isSuperUser && (document.createdBy === ctx.principal.userId || document.submittedBy === ctx.principal.userId)) {
    throw new ManualAdditionStateError(
      document.additionNo,
      document.status,
      'whoever raised it or sent it for approval cannot approve it. Somebody else who holds approve does.',
    );
  }
  if (lines.length === 0) throw new ManualAdditionError(`${document.additionNo} has no lines.`);

  // A closed period refuses before anything is written (§14.6; the ledger's own trigger would too).
  await periods.authorisePosting(tx, ctx, {
    postingDate: document.postingDate,
    documentType: DOCUMENT_TYPE,
    documentId: id,
    allowOverride: false,
  });

  const branchCode = document.branchCode;
  const movementIds: string[] = [];
  const debits = new Map<string, bigint>();
  let totalIqd = 0n;

  for (const line of lines) {
    const [stocked] = await tx
      .select({ inventoryAccountId: itemTable.inventoryAccountId })
      .from(itemTable)
      .where(eq(itemTable.code, line.itemCode))
      .limit(1);
    if (!stocked?.inventoryAccountId) {
      throw new ManualAdditionError(`${line.itemCode} names no inventory account, so its value has nowhere to post. Set one on the item.`);
    }
    // REQ-FIX-001 FIX-4 — written in its own unit, received in the base unit at the base unit's cost.
    const baseQuantity = await itemUnits.toBaseQuantity(tx, line.itemCode, line.uomCode, parseQuantity(line.quantity));
    const lineValue = parseDecimal(line.lineValueIqd, MONEY_SCALE);
    const baseUnitCost = baseUnitCostOf(lineValue, baseQuantity);
    const movement = await inventory.receive(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: document.warehouseCode,
      // The warehouse's branch — the document's, checked by `usableWarehouse` when it was written.
      branchCode,
      quantity: baseQuantity,
      unitCostIqd: baseUnitCost,
      supplierId: null,
      movementDate: document.postingDate,
      // Stock found or brought in by hand is an inventory adjustment in, as Item Reconciliation's is.
      kind: 'count_adjustment',
      // The document is its own batch: it is the paper that put these units on the system (§9.3).
      batchNumber: document.additionNo,
      sourceDocumentType: DOCUMENT_TYPE,
      sourceDocumentId: id,
      sourceLineId: String(line.lineNo),
    });
    movementIds.push(movement.movementId);
    // The layer's own value, so the ledger and the warehouse agree to the last fils.
    const layerValue = costOf(baseQuantity, baseUnitCost);
    totalIqd += layerValue;
    debits.set(stocked.inventoryAccountId, (debits.get(stocked.inventoryAccountId) ?? 0n) + layerValue);

    await tx
      .update(manualStockAdditionLine)
      .set({
        baseQuantity: formatQuantity(baseQuantity),
        baseUnitCostIqd: toDecimalString(baseUnitCost, MONEY_SCALE),
        movementId: movement.movementId,
      })
      .where(eq(manualStockAdditionLine.id, line.id));
  }

  if (totalIqd <= 0n) throw new ManualAdditionError(`${document.additionNo} is worth nothing, so there is nothing to post.`);

  const criteria = { branchCode, warehouseCode: document.warehouseCode };
  // The department, when the sheet named one: an adjustment account that asks for it is answered (0416).
  const dimensions = {
    branch: branchCode,
    warehouse: document.warehouseCode,
    ...(document.departmentCode ? { department: document.departmentCode } : {}),
  };
  const result = await posting.post(tx, ctx, {
    eventType: POSTING_EVENT,
    documentTypeCode: DOCUMENT_TYPE,
    source: { module: 'inventory', documentId: id, event: 'manual_addition_approved' },
    branchCode,
    documentDate: document.postingDate,
    postingDate: document.postingDate,
    description: `Manual stock addition ${document.additionNo} into ${document.warehouseCode}`,
    lines: [
      ...[...debits].map(([accountId, value]) => ({
        role: 'inventory',
        accountId,
        debit: toDecimalString(value, MONEY_SCALE),
        criteria,
        dimensions,
      })),
      {
        role: OFFSET_ROLE,
        // Named on the sheet, or — left empty — the inventory adjustment mapping (refused with the role's name when there is none).
        ...(document.offsetAccountId ? { accountId: document.offsetAccountId } : {}),
        credit: toDecimalString(totalIqd, MONEY_SCALE),
        criteria,
        dimensions,
      },
    ],
  });

  const approvedAt = new Date();
  await tx
    .update(manualStockAddition)
    .set({ status: 'approved', approvedBy: ctx.principal.userId, approvedAt, journalEntryId: result.journalEntryId, updatedAt: approvedAt })
    .where(eq(manualStockAddition.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode,
    before: { status: 'submitted' },
    after: {
      status: 'approved',
      movements: movementIds.length,
      totalIqd: toDecimalString(totalIqd, MONEY_SCALE),
      journalEntryNo: result.entryNo,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  await notifications.safely(tx, async (sp) => {
    await notifications.markActed(sp, DOCUMENT_TYPE, id);
    await notifications.emit(sp, {
      kind: 'approval.completed',
      objectType: DOCUMENT_TYPE,
      objectId: id,
      recipients: [document.submittedBy, document.createdBy],
      except: [ctx.principal.userId],
      subject: `Approved: ${document.additionNo}`,
      context: { reference: document.additionNo, documentType: DOCUMENT_TYPE, href: recordHref(document.additionNo) },
      occurrence: 'approved',
      branchCode,
      actorUserId: ctx.principal.userId,
    });
  });

  return { movementIds, journalEntryId: result.journalEntryId, totalIqd: toDecimalString(totalIqd, MONEY_SCALE) };
}

/**
 * A super user's own draft, approved in one press: the submission and the
 * approval are both recorded (two audit rows), in this one transaction, the
 * row locked first. Nobody else, and no super user on somebody else's draft.
 */
export async function approveDraft(tx: Tx, ctx: ActorContext, id: string) {
  const { document } = await load(tx, id, { lock: true });
  if (!ctx.principal.isSuperUser) {
    throw new ManualAdditionStateError(
      document.additionNo,
      document.status,
      'only a super user approves their own draft in one step; send it for approval, and somebody else approves it.',
    );
  }
  if (document.status !== 'draft') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a draft is approved in one step.');
  }
  if (document.createdBy !== ctx.principal.userId) {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'it was raised by somebody else; it is sent for approval by whoever raised it.');
  }
  await submit(tx, ctx, id);
  return approve(tx, ctx, id);
}

/** Sent back with a reason. Its author reopens it as a draft or cancels it. */
export async function reject(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const { document } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, { branchCode: document.branchCode });
  if (document.status !== 'submitted') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a document sent for approval is rejected.');
  }
  const why = reason.trim();
  if (!why) throw new ManualAdditionError('Say why it is rejected, so its author knows what to correct.');
  const rejectedAt = new Date();
  await tx
    .update(manualStockAddition)
    .set({ status: 'rejected', rejectedBy: ctx.principal.userId, rejectedAt, rejectionReason: why, updatedAt: rejectedAt })
    .where(eq(manualStockAddition.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.rejected',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'submitted' },
    after: { status: 'rejected' },
    reason: why,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
  await notifications.safely(tx, async (sp) => {
    await notifications.markActed(sp, DOCUMENT_TYPE, id);
    await notifications.emit(sp, {
      kind: 'approval.rejected',
      objectType: DOCUMENT_TYPE,
      objectId: id,
      recipients: [document.submittedBy, document.createdBy],
      except: [ctx.principal.userId],
      subject: `Rejected: ${document.additionNo}`,
      body: why,
      context: { reference: document.additionNo, documentType: DOCUMENT_TYPE, reason: why, href: recordHref(document.additionNo) },
      occurrence: `rejected:${rejectedAt.toISOString()}`,
      branchCode: document.branchCode,
      actorUserId: ctx.principal.userId,
    });
  });
}

/** A rejected addition back to draft, to be corrected and sent again. */
export async function reopen(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { document } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: document.branchCode });
  if (document.status !== 'rejected') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a rejected document is reopened.');
  }
  await tx
    .update(manualStockAddition)
    .set({ status: 'draft', submittedBy: null, submittedAt: null, updatedAt: new Date() })
    .where(eq(manualStockAddition.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.reopened',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'rejected' },
    after: { status: 'draft' },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** A draft (or a rejected one) set aside, with a reason. Never deleted. */
export async function cancel(tx: Tx, ctx: ActorContext, id: string, reason: string): Promise<void> {
  const { document } = await load(tx, id, { lock: true });
  await authz.authorize(ctx.principal, 'edit_draft', PERMISSION_OBJECT, { branchCode: document.branchCode });
  if (document.status !== 'draft' && document.status !== 'rejected') {
    throw new ManualAdditionStateError(document.additionNo, document.status, 'only a draft or a rejected document is cancelled.');
  }
  const why = reason.trim();
  if (!why) throw new ManualAdditionError('Say why it is cancelled (§5.4).');
  const cancelledAt = new Date();
  await tx
    .update(manualStockAddition)
    .set({ status: 'cancelled', cancelledBy: ctx.principal.userId, cancelledAt, cancellationReason: why, updatedAt: cancelledAt })
    .where(eq(manualStockAddition.id, id));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'manual_stock_addition.cancelled',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: document.status },
    after: { status: 'cancelled' },
    reason: why,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

// ---------------------------------------------------------------------------
// What the screens read
// ---------------------------------------------------------------------------

export interface AdditionListRow {
  readonly id: string;
  readonly additionNo: string;
  readonly status: AdditionStatus;
  readonly branchCode: string;
  readonly warehouseCode: string;
  readonly warehouseName: string;
  readonly postingDate: string;
  readonly lines: number;
  readonly totalIqd: string;
  readonly createdByName: string | null;
}

export interface AdditionListFilter extends RegisterPaging {
  readonly search?: string | null;
  readonly status?: string | null;
  readonly warehouseCode?: string | null;
  /** The Filter: a window of posting dates and the order (newest first unless asked). */
  readonly dates?: RegisterDates | null;
}

export const ADDITION_STATUSES: readonly AdditionStatus[] = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'];

/** The register, fifty a page with the true count, under the reader's branches, newest first. */
export async function listForScreen(tx: Tx, principal: Principal, filter: AdditionListFilter = {}): Promise<RegisterPage<AdditionListRow>> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) throw new Error('Not permitted to view manual stock additions.');
  const status = filter.status && (ADDITION_STATUSES as readonly string[]).includes(filter.status) ? filter.status : null;
  const parts = [
    status ? sql`a.status::text = ${status}` : null,
    filter.warehouseCode ? sql`a.warehouse_code = ${filter.warehouseCode}` : null,
    withinDates(sql`a.posting_date`, filter.dates) ?? null,
    searchOf([sql`a.addition_no`, sql`a.warehouse_code`, sql`w.name`, sql`a.reason`, sql`coalesce(u.display_name, u.email)`], filter.search),
  ].filter((part): part is NonNullable<typeof part> => part !== null);
  const from = sql`from manual_stock_addition a
                   join warehouse w on w.code = a.warehouse_code
                   left join app_user u on u.id = a.created_by
                   ${parts.length ? sql`where ${sql.join(parts, sql` and `)}` : sql``}`;
  return registerPage<AdditionListRow>({
    paging: filter,
    count: async () => Number(((await tx.execute(sql`select count(*)::int as n ${from}`)).rows[0] as { n: number }).n),
    rows: async ({ limit, offset }) => {
      const result = await tx.execute(sql`
        select a.id, a.addition_no as "additionNo", a.status::text as status, a.branch_code as "branchCode",
               a.warehouse_code as "warehouseCode", w.name as "warehouseName", a.posting_date::text as "postingDate",
               (select count(*)::int from manual_stock_addition_line l where l.addition_id = a.id) as lines,
               (select coalesce(sum(l.line_value_iqd), 0)::text from manual_stock_addition_line l where l.addition_id = a.id) as "totalIqd",
               coalesce(u.display_name, u.email) as "createdByName"
          ${from}
         order by ${sql.join(datesOrder(sql`a.posting_date`, filter.dates, sql`a.addition_no`), sql`, `)}
         limit ${limit} offset ${offset}`);
      return result.rows as unknown as AdditionListRow[];
    },
  });
}

export interface AdditionLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly itemCode: string;
  readonly itemName: string;
  readonly baseUomCode: string;
  readonly uomCode: string;
  readonly quantity: string;
  readonly unitCostIqd: string;
  readonly lineValueIqd: string;
  readonly baseQuantity: string | null;
  readonly baseUnitCostIqd: string | null;
  readonly movementId: string | null;
}

export interface AdditionLayer {
  readonly movementId: string;
  readonly lineNo: number;
  readonly itemCode: string;
  readonly layerDate: string;
  readonly batchNumber: string | null;
  readonly quantity: string;
  readonly unitCostIqd: string;
  readonly valueIqd: string;
}

export interface AdditionJournalLine {
  readonly lineNo: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly description: string | null;
  readonly debitIqd: string;
  readonly creditIqd: string;
}

const rowsOf = <T>(result: { rows: unknown[] }) => result.rows as T[];

/** One addition as its record page and its printed copy show it, or null when the reader has none by that number. */
export async function viewByNo(tx: Tx, additionNo: string) {
  const [header] = rowsOf<{
    id: string;
    additionNo: string;
    status: AdditionStatus;
    branchCode: string;
    warehouseCode: string;
    warehouseName: string;
    postingDate: string;
    reason: string;
    offsetAccountId: string | null;
    offsetAccountCode: string | null;
    offsetAccountName: string | null;
    departmentCode: string | null;
    departmentName: string | null;
    createdBy: string;
    createdByName: string | null;
    createdAt: string;
    submittedBy: string | null;
    submittedByName: string | null;
    submittedAt: string | null;
    approvedByName: string | null;
    approvedAt: string | null;
    rejectedByName: string | null;
    rejectedAt: string | null;
    rejectionReason: string | null;
    cancelledByName: string | null;
    cancelledAt: string | null;
    cancellationReason: string | null;
    journalEntryId: string | null;
    journalEntryNo: string | null;
    journalStatus: string | null;
  }>(
    await tx.execute(sql`
      select a.id, a.addition_no as "additionNo", a.status::text as status, a.branch_code as "branchCode",
             a.warehouse_code as "warehouseCode", w.name as "warehouseName", a.posting_date::text as "postingDate",
             a.reason, a.offset_account_id as "offsetAccountId", oc.code as "offsetAccountCode", oc.name as "offsetAccountName",
             a.department_code as "departmentCode", dp.name as "departmentName",
             a.created_by as "createdBy", coalesce(cu.display_name, cu.email) as "createdByName",
             to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
             a.submitted_by as "submittedBy", coalesce(su.display_name, su.email) as "submittedByName",
             to_char(a.submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "submittedAt",
             coalesce(au.display_name, au.email) as "approvedByName",
             to_char(a.approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "approvedAt",
             coalesce(ru.display_name, ru.email) as "rejectedByName",
             to_char(a.rejected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "rejectedAt",
             a.rejection_reason as "rejectionReason",
             coalesce(xu.display_name, xu.email) as "cancelledByName",
             to_char(a.cancelled_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "cancelledAt",
             a.cancellation_reason as "cancellationReason",
             a.journal_entry_id as "journalEntryId", j.entry_no as "journalEntryNo", j.status::text as "journalStatus"
        from manual_stock_addition a
        join warehouse w on w.code = a.warehouse_code
        left join chart_of_account oc on oc.id = a.offset_account_id
        left join department dp on dp.code = a.department_code
        left join app_user cu on cu.id = a.created_by
        left join app_user su on su.id = a.submitted_by
        left join app_user au on au.id = a.approved_by
        left join app_user ru on ru.id = a.rejected_by
        left join app_user xu on xu.id = a.cancelled_by
        left join journal_entry j on j.id = a.journal_entry_id
       where a.addition_no = ${additionNo}
       limit 1`),
  );
  if (!header) return null;

  const lines = rowsOf<AdditionLineView>(
    await tx.execute(sql`
      select l.id, l.line_no as "lineNo", l.item_code as "itemCode", i.name as "itemName", i.base_uom_code as "baseUomCode",
             l.uom_code as "uomCode", l.quantity::text as quantity, l.unit_cost_iqd::text as "unitCostIqd",
             l.line_value_iqd::text as "lineValueIqd", l.base_quantity::text as "baseQuantity",
             l.base_unit_cost_iqd::text as "baseUnitCostIqd", l.movement_id as "movementId"
        from manual_stock_addition_line l
        join item i on i.code = l.item_code
       where l.addition_id = ${header.id}::uuid
       order by l.line_no`),
  ).map((line) => ({
    ...line,
    quantity: formatQuantity(parseQuantity(line.quantity)),
    baseQuantity: line.baseQuantity === null ? null : formatQuantity(parseQuantity(line.baseQuantity)),
  }));

  // The FIFO layers the approval created — one per line.
  const layers = rowsOf<AdditionLayer>(
    await tx.execute(sql`
      select m.id as "movementId", m.source_line_id::int as "lineNo", m.item_code as "itemCode",
             cl.layer_date::text as "layerDate", m.batch_number as "batchNumber",
             cl.original_quantity::text as quantity, cl.unit_cost_iqd::text as "unitCostIqd",
             round(cl.original_quantity * cl.unit_cost_iqd, 4)::text as "valueIqd"
        from inventory_movement m
        join cost_layer cl on cl.created_by_movement_id = m.id
       where m.source_document_type = ${DOCUMENT_TYPE} and m.source_document_id = ${header.id}
       order by m.source_line_id::int, m.created_at, m.id`),
  ).map((layer) => ({ ...layer, quantity: formatQuantity(parseQuantity(layer.quantity)) }));

  const journalLines = header.journalEntryId
    ? rowsOf<AdditionJournalLine>(
        await tx.execute(sql`
          select l.line_no as "lineNo", c.code as "accountCode", c.name as "accountName", l.line_description as description,
                 l.debit_iqd::text as "debitIqd", l.credit_iqd::text as "creditIqd"
            from journal_line l
            join chart_of_account c on c.id = l.account_id
           where l.journal_entry_id = ${header.journalEntryId}::uuid
           order by l.line_no`),
      )
    : [];

  const totalIqd = toDecimalString(
    lines.reduce((sum, line) => sum + parseDecimal(line.lineValueIqd, MONEY_SCALE), 0n),
    MONEY_SCALE,
  );
  const postedIqd = toDecimalString(
    layers.reduce((sum, layer) => sum + parseDecimal(layer.valueIqd, MONEY_SCALE), 0n),
    MONEY_SCALE,
  );
  return { document: header, lines, layers, journalLines, totalIqd, postedIqd };
}

export type AdditionView = NonNullable<Awaited<ReturnType<typeof viewByNo>>>;

/** The warehouses the sheet offers: active main stores of the branch, none in transit or at a shipment stage. */
export async function warehousesFor(tx: Tx, branchCode: string) {
  return rowsOf<{ code: string; name: string; branchCode: string }>(
    await tx.execute(sql`
      select w.code, w.name, w.branch_code as "branchCode"
        from warehouse w
       where w.active and w.warehouse_type = 'main' and not w.is_transit and w.shipment_stage is null
         and w.branch_code = ${branchCode}
       order by w.code`),
  );
}

/** The accounts the sheet offers as the offset: postable, in dinars, not a control, bank or cash account. */
export async function offsetAccounts(tx: Tx) {
  return rowsOf<{ id: string; code: string; name: string }>(
    await tx.execute(sql`
      select c.id, c.code, c.name
        from chart_of_account c
       where c.is_active and c.approval_status = 'approved' and not c.is_group
         and c.control_account is null
         and (c.currency_restriction is null or c.currency_restriction = 'IQD')
         and not exists (select 1 from bank_cash_account b where b.gl_account_id = c.id)
       order by c.code`),
  );
}

/** The account the offset posts to when the sheet names none — the mapping in force, or null. */
export async function mappedOffset(tx: Tx, branchCode: string): Promise<{ id: string; code: string; name: string } | null> {
  const accountId = await posting.mappedAccountFor(tx, POSTING_EVENT, OFFSET_ROLE, branchCode);
  if (!accountId) return null;
  const [row] = await tx
    .select({ id: chartOfAccount.id, code: chartOfAccount.code, name: chartOfAccount.name })
    .from(chartOfAccount)
    .where(eq(chartOfAccount.id, accountId))
    .limit(1);
  return row ?? null;
}

/** The departments the sheet offers (in use), for an adjustment account that asks for one. */
export async function departmentsFor(tx: Tx) {
  return tx
    .select({ code: department.code, name: department.name })
    .from(department)
    .where(eq(department.active, true))
    .orderBy(asc(department.code));
}

/** The stock items the sheet offers, each with its active units (the base first). */
export async function itemsFor(tx: Tx) {
  const items = rowsOf<{ id: string; code: string; name: string; baseUomCode: string }>(
    await tx.execute(sql`
      select i.id, i.code, i.name, i.base_uom_code as "baseUomCode"
        from item i
       where i.is_stock and i.active and coalesce(i.tracking::text, '') not in ('serial', 'serial_and_batch')
       order by i.code`),
  );
  const units = await itemUnits.pickerUnits(tx, items.map((row) => row.id));
  return items.map((row) => {
    const own = units.get(row.id) ?? [];
    const base = own.find((unit) => unit.code === row.baseUomCode) ?? { code: row.baseUomCode, numerator: '1', denominator: '1' };
    return {
      code: row.code,
      name: row.name,
      baseUomCode: row.baseUomCode,
      units: [
        { code: base.code, numerator: base.numerator, denominator: base.denominator },
        ...own.filter((unit) => unit.code !== row.baseUomCode).map((unit) => ({ code: unit.code, numerator: unit.numerator, denominator: unit.denominator })),
      ],
    };
  });
}

/** What the sheet needs to show a draft again for editing. */
export async function draftForSheet(tx: Tx, additionNo: string) {
  const found = await viewByNo(tx, additionNo);
  if (!found || found.document.status !== 'draft') return null;
  return found;
}
