/**
 * Opening stock — Phase 04.5, §9.7.
 *
 * *"Approval creates the inventory ledger entries **and** the opening
 * accounting entry."* Both, in one transaction: stock on the shelves that the
 * ledger does not know about is exactly the discrepancy §9.9's reconciliation
 * exists to make impossible.
 *
 * The document is raised and approved by different people (§14.4), because its
 * lines become the FIFO layers every subsequent margin is computed against. A
 * wrong opening cost does not announce itself — it makes cost of goods sold
 * quietly wrong for as long as the stock lasts.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { item as itemTable, openingStock, openingStockLine, warehouse } from '../db/schema';
import { formatQuantity, parseQuantity } from '../domain/uom';
import { toDecimalString } from '../domain/money';
import { costOf } from '../domain/fifo';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';
import * as audit from './audit';
import * as inventory from './inventory';
import * as posting from './posting';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'opening_stock';
const DOCUMENT_TYPE = 'opening_stock';
const SEQUENCE_KEY = 'OPENING_STOCK';

export class OpeningStockNotFoundError extends Error {
  readonly code = 'OPENING_STOCK_NOT_FOUND';
  constructor(id: string) {
    super(`No opening stock document '${id}'.`);
    this.name = 'OpeningStockNotFoundError';
  }
}

export class OpeningStockStateError extends Error {
  readonly code = 'OPENING_STOCK_STATE_INVALID';
  constructor(documentNo: string, status: string, detail: string) {
    super(`Opening stock ${documentNo} is '${status}': ${detail}`);
    this.name = 'OpeningStockStateError';
  }
}

export interface OpeningStockLineInput {
  readonly itemCode: string;
  readonly quantity: bigint;
  readonly uomCode: string;
  readonly unitCostIqd: bigint;
  /** §9.7 — when the stock was really acquired, which decides FIFO order. */
  readonly costLayerDate: string;
  readonly serialNumber?: string | null;
  readonly batchNumber?: string | null;
  readonly manufacturedOn?: string | null;
  readonly expiryDate?: string | null;
  readonly warrantyMonths?: number | null;
}

export interface CreateOpeningStockInput {
  readonly branchCode: string;
  readonly warehouseCode: string;
  readonly documentDate: string;
  readonly description?: string | null;
  readonly lines: readonly OpeningStockLineInput[];
}

/**
 * Raises the document as a draft. Nothing moves and nothing posts.
 *
 * The tracking check runs here rather than only at approval, so an item that
 * needs a serial is caught while the document can still be corrected — §25's
 * "identify the field, reason and corrective action", applied at the point the
 * correction is cheap.
 */
export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CreateOpeningStockInput,
): Promise<{ id: string; documentNo: string }> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: input.branchCode,
  });

  if (input.lines.length === 0) {
    throw new Error(
      'An opening stock document with no lines brings nothing onto the system. Add the stock being opened, or do not raise it.',
    );
  }

  const allocated = await allocateDocumentNumber(
    tx,
    SEQUENCE_KEY,
    { branchCode: input.branchCode, year: Number(input.documentDate.slice(0, 4)) },
    ctx.principal.userId,
  );

  // A batch-tracked item opened without a batch takes the document's number as
  // its batch — the way a Purchase Invoice's number is the batch of what it
  // brings in. The build's Opening Stock asks for no batch, and §9.3 still
  // wants every unit traceable to the paper that put it on the system.
  const lines: OpeningStockLineInput[] = [];
  for (const line of input.lines) {
    const [row] = await tx
      .select({ tracking: itemTable.tracking })
      .from(itemTable)
      .where(eq(itemTable.code, line.itemCode))
      .limit(1);
    const batched = row?.tracking === 'batch' || row?.tracking === 'serial_and_batch';
    const filled =
      batched && !line.batchNumber?.trim() ? { ...line, batchNumber: allocated.documentNo } : line;
    await assertLineUsable(tx, filled);
    lines.push(filled);
  }

  const [document] = await tx
    .insert(openingStock)
    .values({
      documentNo: allocated.documentNo,
      branchCode: input.branchCode,
      warehouseCode: input.warehouseCode,
      documentDate: input.documentDate,
      description: input.description ?? null,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: openingStock.id });

  for (const [index, line] of lines.entries()) {
    await tx.insert(openingStockLine).values({
      openingStockId: document!.id,
      lineNo: index + 1,
      itemCode: line.itemCode,
      quantity: formatQuantity(line.quantity),
      uomCode: line.uomCode,
      unitCostIqd: toDecimalString(line.unitCostIqd, 4n),
      costLayerDate: line.costLayerDate,
      serialNumber: line.serialNumber ?? null,
      batchNumber: line.batchNumber ?? null,
      manufacturedOn: line.manufacturedOn ?? null,
      expiryDate: line.expiryDate ?? null,
      warrantyMonths: line.warrantyMonths ?? null,
    });
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opening_stock.created',
    objectType: PERMISSION_OBJECT,
    objectId: document!.id,
    branchCode: input.branchCode,
    after: {
      documentNo: allocated.documentNo,
      warehouse: input.warehouseCode,
      lines: input.lines.length,
    },
    outcome: 'success',
  });

  return { id: document!.id, documentNo: allocated.documentNo };
}

/**
 * §9.3 — an item that is tracked needs its identity supplied.
 *
 * Checked against the item master, so "opening stock cannot be entered for an
 * item without its required tracking data" (04.5's gate) holds for the reason
 * it should: the item says it is tracked.
 */
async function assertLineUsable(tx: Tx, line: OpeningStockLineInput): Promise<void> {
  const [row] = await tx
    .select({ tracking: itemTable.tracking, isStock: itemTable.isStock })
    .from(itemTable)
    .where(eq(itemTable.code, line.itemCode))
    .limit(1);

  if (!row) {
    throw new Error(
      `No item '${line.itemCode}'. Opening stock can only be entered for an item that exists — create the item first (§4.4).`,
    );
  }

  if (!row.isStock) {
    throw new inventory.ItemNotStockedError(line.itemCode);
  }

  // The same rule the inventory service applies to every movement, called here
  // so the document is refused while it can still be corrected cheaply.
  inventory.assertTrackingSupplied(line.itemCode, row.tracking, {
    serialNumber: line.serialNumber ?? null,
    batchNumber: line.batchNumber ?? null,
  });
}

async function load(tx: Tx, id: string) {
  const [document] = await tx
    .select()
    .from(openingStock)
    .where(eq(openingStock.id, id))
    .limit(1);

  if (!document) throw new OpeningStockNotFoundError(id);

  const lines = await tx
    .select()
    .from(openingStockLine)
    .where(eq(openingStockLine.openingStockId, id))
    .orderBy(openingStockLine.lineNo);

  return { document, lines };
}

/** Sends the document for approval. §24 — submission starts the workflow. */
export async function submit(tx: Tx, ctx: ActorContext, id: string): Promise<void> {
  const { document } = await load(tx, id);

  await authz.authorize(ctx.principal, 'submit', PERMISSION_OBJECT, {
    branchCode: document.branchCode,
  });

  if (document.status !== 'draft') {
    throw new OpeningStockStateError(
      document.documentNo,
      document.status,
      'only a draft can be submitted.',
    );
  }

  await tx
    .update(openingStock)
    .set({ status: 'submitted', submittedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(openingStock.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opening_stock.submitted',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'draft' },
    after: { status: 'submitted' },
    outcome: 'success',
  });
}

export interface ApproveInput {
  /** Post the opening journal through the Phase 02 engine (§9.7). */
  readonly post?: boolean;
  readonly dimensions?: Readonly<Record<string, string | null | undefined>> | undefined;
}

/**
 * §9.7 — approval creates the ledger entries **and** the opening journal.
 *
 * One transaction, so the stock and the accounting for it commit together or
 * not at all (§24). The layers are dated to each line's cost-layer date rather
 * than to today, which is 04.5's first gate item and the whole reason the field
 * exists: stock bought last year must consume before stock bought this year.
 */
export async function approve(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: ApproveInput = {},
): Promise<{ movementIds: readonly string[]; journalEntryId: string | null }> {
  const { document, lines } = await load(tx, id);

  await authz.authorize(ctx.principal, 'approve', PERMISSION_OBJECT, {
    branchCode: document.branchCode,
  });

  if (document.status !== 'submitted') {
    throw new OpeningStockStateError(
      document.documentNo,
      document.status,
      'only a submitted document can be approved.',
    );
  }

  // §14.4 asked that the person who typed the opening figures not be the person
  // who confirms them — their costs become the FIFO layers every margin rests
  // on. The owner removed that requirement on 2026-09-27: the company runs this
  // with one person who holds both roles, and a control nobody can satisfy
  // stops the books being opened at all. `approve` on `opening_stock` is still
  // required, so it remains a permission rather than a free action.

  const movementIds: string[] = [];
  let totalCostIqd = 0n;
  /** Each line's debit, to the inventory account its item names (block 1). */
  const debits: { accountId: string | null; costIqd: bigint }[] = [];

  for (const line of lines) {
    const quantity = parseQuantity(line.quantity);
    const unitCostIqd = BigInt(line.unitCostIqd.replace('.', ''));

    const movement = await inventory.receive(tx, ctx, {
      itemCode: line.itemCode,
      warehouseCode: document.warehouseCode,
      branchCode: document.branchCode,
      quantity,
      unitCostIqd,
      movementDate: document.documentDate,
      // §9.7 — the layer is dated to when the stock was acquired, not to today.
      layerDate: line.costLayerDate,
      kind: 'opening_stock',
      sourceDocumentType: DOCUMENT_TYPE,
      sourceDocumentId: document.id,
      sourceLineId: String(line.lineNo),
      serialNumber: line.serialNumber,
      batchNumber: line.batchNumber,
      expiryDate: line.expiryDate,
      manufacturedOn: line.manufacturedOn,
    });

    movementIds.push(movement.movementId);
    totalCostIqd += costOf(quantity, unitCostIqd);
    const [stocked] = await tx
      .select({ accountId: itemTable.inventoryAccountId })
      .from(itemTable)
      .where(eq(itemTable.code, line.itemCode))
      .limit(1);
    debits.push({ accountId: stocked?.accountId ?? null, costIqd: costOf(quantity, unitCostIqd) });

    await tx
      .update(openingStockLine)
      .set({ movementId: movement.movementId })
      .where(eq(openingStockLine.id, line.id));
  }

  // The opening journal: one entry for the document, not one per line. It is
  // the balance sheet's opening position, and Appendix C maps the roles.
  let journalEntryId: string | null = null;

  if (input.post && totalCostIqd > 0n) {
    const amount = toDecimalString(totalCostIqd, 4n);
    const result = await posting.post(tx, ctx, {
      eventType: 'inventory.opening_stock',
      source: { module: 'inventory', documentId: document.id, event: 'approved' },
      branchCode: document.branchCode,
      documentDate: document.documentDate,
      postingDate: document.documentDate,
      description: `Opening stock ${document.documentNo}`,
      lines: [
        ...debits
          .filter((debit) => debit.costIqd > 0n)
          .map((debit) => ({
            role: 'inventory',
            ...(debit.accountId ? { accountId: debit.accountId } : {}),
            debit: toDecimalString(debit.costIqd, 4n),
            criteria: { warehouseCode: document.warehouseCode, branchCode: document.branchCode },
            dimensions: {
              warehouse: document.warehouseCode,
              branch: document.branchCode,
              ...(input.dimensions ?? {}),
            },
          })),
        {
          role: 'opening_balance',
          credit: amount,
          criteria: { branchCode: document.branchCode },
          dimensions: { branch: document.branchCode, ...(input.dimensions ?? {}) },
        },
      ],
    });
    journalEntryId = result.journalEntryId;
  }

  await tx
    .update(openingStock)
    .set({
      status: 'approved',
      approvedBy: ctx.principal.userId,
      approvedAt: new Date(),
      journalEntryId,
      updatedAt: new Date(),
    })
    .where(eq(openingStock.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'opening_stock.approved',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    branchCode: document.branchCode,
    before: { status: 'submitted' },
    after: {
      status: 'approved',
      movements: movementIds.length,
      totalCostIqd: toDecimalString(totalCostIqd, 4n),
      journalEntryId,
    },
    outcome: 'success',
  });

  return { movementIds, journalEntryId };
}

/** The document as a record page would show it. */
export async function view(tx: Tx, id: string) {
  return load(tx, id);
}

/**
 * Raises opening stock and sends it for approval in one step — the screen's
 * Save (Operations build, block 7).
 *
 * The two were separate verbs because the blueprint's workflow had a draft
 * nobody else could see. The build's Opening Stock is one form; what it keeps
 * is the approval, because these figures become the FIFO layers every margin
 * after them is measured against, and the person who typed them is not the one
 * who confirms them.
 */
export async function raise(
  tx: Tx,
  ctx: ActorContext,
  input: CreateOpeningStockInput,
): Promise<{ id: string; documentNo: string }> {
  // Each line in its item's own unit: the quantity typed is the quantity held.
  const lines = [];
  for (const line of input.lines) {
    const [stocked] = await tx
      .select({ baseUomCode: itemTable.baseUomCode })
      .from(itemTable)
      .where(eq(itemTable.code, line.itemCode))
      .limit(1);
    lines.push({ ...line, uomCode: stocked?.baseUomCode ?? line.uomCode });
  }
  const created = await create(tx, ctx, { ...input, lines });
  await submit(tx, ctx, created.id);
  return created;
}

/** The register, newest first, with what each document brings in. */
export async function list(tx: Tx) {
  return tx
    .select({
      id: openingStock.id,
      documentNo: openingStock.documentNo,
      documentDate: openingStock.documentDate,
      status: openingStock.status,
      warehouseCode: openingStock.warehouseCode,
      warehouseName: warehouse.name,
      lines: sql<number>`(select count(*)::int from opening_stock_line l where l.opening_stock_id = ${openingStock.id})`,
      totalIqd: sql<string>`(select coalesce(sum(round(l.quantity * l.unit_cost_iqd, 4)), 0)::text
                               from opening_stock_line l where l.opening_stock_id = ${openingStock.id})`,
    })
    .from(openingStock)
    .innerJoin(warehouse, eq(warehouse.code, openingStock.warehouseCode))
    .orderBy(desc(openingStock.documentDate), desc(openingStock.documentNo));
}

/** One document by its number, with each line's item name and its value. */
export async function viewByNo(tx: Tx, documentNo: string) {
  const [header] = await tx
    .select({ id: openingStock.id, warehouseName: warehouse.name })
    .from(openingStock)
    .innerJoin(warehouse, eq(warehouse.code, openingStock.warehouseCode))
    .where(eq(openingStock.documentNo, documentNo))
    .limit(1);
  if (!header) return null;

  const { document, lines } = await load(tx, header.id);
  const names = new Map(
    (
      await tx
        .select({ code: itemTable.code, name: itemTable.name })
        .from(itemTable)
    ).map((row) => [row.code, row.name]),
  );
  return {
    document: { ...document, warehouseName: header.warehouseName },
    lines: lines.map((line) => ({
      ...line,
      itemName: names.get(line.itemCode) ?? line.itemCode,
      totalIqd: toDecimalString(
        costOf(parseQuantity(line.quantity), BigInt(line.unitCostIqd.replace('.', ''))),
        4n,
      ),
    })),
  };
}
