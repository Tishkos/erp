/**
 * Import service — Phase 01.11.
 *
 * §4.4: "Bulk import requires validation preview, error file, import batch ID
 * and rollback before final posting."
 *
 * The 01.11 gate that shapes this module is "Import respects the same
 * permissions and validations as manual entry". So a definition supplies a
 * mapper and a **commit function that is the ordinary service call** — the same
 * one a screen makes. There is no bulk insert anywhere in this file. A second
 * write path would be a second set of rules, and the duplicate check or the
 * approval requirement would be the one that got missed.
 */
import { and, asc, eq } from 'drizzle-orm';
import {
  ImportParseError,
  ImportRowError,
  assertBatchTransition,
  assertColumnsPresent,
  assertCommittable,
  errorFile as renderErrorFile,
  parseDelimited,
  summarise,
  type ImportBatchStatus,
  type ImportDefinitionShape,
  type ImportPreview,
  type RawImportRow,
  type RowValidation,
} from '../domain/import';
import { importBatch, importRow } from '../db/schema';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';

/**
 * A registered import.
 *
 * `commitRow` receives the transaction and the mapped input, and calls the same
 * service function a screen would. It returns the identifier of what it made,
 * which the row keeps so the migration can be traced both ways (§26).
 */
export interface ImportDefinition<TInput> extends ImportDefinitionShape<TInput> {
  commitRow(tx: Tx, ctx: ActorContext, input: TInput): Promise<{ id: string }>;
}

const definitions = new Map<string, ImportDefinition<unknown>>();

export function registerDefinition<TInput>(definition: ImportDefinition<TInput>): void {
  definitions.set(definition.key, definition as ImportDefinition<unknown>);
}

export function definitionFor(key: string): ImportDefinition<unknown> {
  const definition = definitions.get(key);
  if (!definition) {
    throw new ImportParseError(`there is no import definition called '${key}'.`);
  }
  return definition;
}

export function registeredDefinitions(): Array<{ key: string; label: string }> {
  return [...definitions.values()].map((d) => ({ key: d.key, label: d.label }));
}

export class ImportBatchNotFoundError extends Error {
  readonly code = 'IMPORT_BATCH_NOT_FOUND';
  constructor(id: string) {
    super(`No import batch with id '${id}'.`);
    this.name = 'ImportBatchNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Upload and validate
// ---------------------------------------------------------------------------

export interface UploadResult {
  readonly batchId: string;
  readonly preview: ImportPreview;
  /** CSV of the failures. Empty when everything passed. */
  readonly errorFile: string;
}

/**
 * Reads a file, validates every row, and writes nothing to the target tables.
 *
 * §5.3 — the `import` verb, not `create`. Granting someone the right to create
 * a record one at a time is not the same as granting them the right to create
 * ten thousand at once.
 */
export async function upload(
  tx: Tx,
  ctx: ActorContext,
  definitionKey: string,
  content: string,
  fileName?: string,
): Promise<UploadResult> {
  const definition = definitionFor(definitionKey);

  await authz.authorize(ctx.principal, 'import', definition.permissionObject, {
    branchCode: ctx.branchCode,
    requestId: ctx.requestId ?? null,
  });

  const parsed = parseDelimited(content, {
    ...(definition.sourceIdColumn ? { sourceIdColumn: definition.sourceIdColumn } : {}),
  });
  assertColumnsPresent(definition, parsed.columns);

  const [batch] = await tx
    .insert(importBatch)
    .values({
      definitionKey,
      fileName: fileName ?? null,
      status: 'draft',
      totalRows: parsed.rows.length,
      createdBy: ctx.principal.userId,
      branchCode: ctx.branchCode,
    })
    .returning({ id: importBatch.id });

  const validations: RowValidation[] = [];

  for (const row of parsed.rows) {
    const validation = validateRow(definition, row);
    validations.push(validation);

    await tx.insert(importRow).values({
      batchId: batch!.id,
      rowNo: row.rowNo,
      sourceId: row.sourceId,
      rawValues: row.values,
      status: validation.status,
      errorCode: validation.errorCode,
      errorMessage: validation.errorMessage,
    });
  }

  const preview = summarise(validations);

  await tx
    .update(importBatch)
    .set({
      status: 'validated',
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
      validatedAt: new Date(),
    })
    .where(eq(importBatch.id, batch!.id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'import.validated',
    objectType: 'import_batch',
    objectId: batch!.id,
    branchCode: ctx.branchCode,
    after: {
      definitionKey,
      fileName: fileName ?? null,
      totalRows: preview.totalRows,
      validRows: preview.validRows,
      invalidRows: preview.invalidRows,
    },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return {
    batchId: batch!.id,
    preview,
    errorFile: preview.invalidRows > 0
      ? renderErrorFile(parsed.rows, validations, parsed.columns)
      : '',
  };
}

/** Maps one row, turning any rejection into a recorded reason. */
function validateRow(
  definition: ImportDefinition<unknown>,
  row: RawImportRow,
): RowValidation {
  try {
    definition.mapRow(row);
    return { rowNo: row.rowNo, status: 'valid', errorCode: null, errorMessage: null };
  } catch (error) {
    return {
      rowNo: row.rowNo,
      status: 'invalid',
      errorCode: errorCodeOf(error),
      errorMessage: error instanceof Error ? stripRowPrefix(error.message, row.rowNo) : String(error),
    };
  }
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return 'INVALID_ROW';
}

/** The row number is already a column in the error file; not twice in the text. */
function stripRowPrefix(message: string, rowNo: number): string {
  return message.startsWith(`Row ${rowNo}: `) ? message.slice(`Row ${rowNo}: `.length) : message;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitResult {
  readonly batchId: string;
  readonly committedRows: number;
}

/**
 * Commits a validated batch, all of it or none of it.
 *
 * Every row goes through the definition's own `commitRow`, which is the same
 * service call a screen makes — so the duplicate search, the approval routing
 * and the permission check all happen exactly as they would for one record
 * typed by hand.
 *
 * One transaction, so §4.4's "rollback before final posting" is free: a row
 * that fails takes the whole batch with it, and a half-imported master file —
 * which is worse than none, because nobody can tell which half — cannot exist.
 */
export async function commit(
  tx: Tx,
  ctx: ActorContext,
  batchId: string,
): Promise<CommitResult> {
  const batch = await loadBatch(tx, batchId);
  const definition = definitionFor(batch.definitionKey);

  await authz.authorize(ctx.principal, 'import', definition.permissionObject, {
    branchCode: ctx.branchCode,
    objectId: batchId,
    requestId: ctx.requestId ?? null,
  });

  assertBatchTransition(batch.status, 'committed');

  const rows = await tx
    .select()
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .orderBy(asc(importRow.rowNo));

  assertCommittable(
    summarise(
      rows.map((row) => ({
        rowNo: row.rowNo,
        status: row.status === 'invalid' ? ('invalid' as const) : ('valid' as const),
        errorCode: row.errorCode,
        errorMessage: row.errorMessage,
      })),
    ),
  );

  let committedRows = 0;

  for (const row of rows) {
    const raw: RawImportRow = {
      rowNo: row.rowNo,
      sourceId: row.sourceId,
      values: row.rawValues as Record<string, string | null>,
    };

    let created: { id: string };
    try {
      created = await definition.commitRow(tx, ctx, definition.mapRow(raw));
    } catch (error) {
      // The transaction is about to roll back, so nothing is recorded here —
      // the caller reports which row stopped it and the batch stays validated.
      throw new ImportRowError(
        row.rowNo,
        error instanceof Error ? error.message : String(error),
      );
    }

    await tx
      .update(importRow)
      .set({ status: 'committed', targetId: created.id })
      .where(eq(importRow.id, row.id));

    committedRows += 1;
  }

  await tx
    .update(importBatch)
    .set({ status: 'committed', committedAt: new Date() })
    .where(eq(importBatch.id, batchId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'import.committed',
    objectType: 'import_batch',
    objectId: batchId,
    branchCode: ctx.branchCode,
    before: { status: batch.status },
    after: { status: 'committed', committedRows },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { batchId, committedRows };
}

/**
 * Marks a committed batch as rolled back.
 *
 * The records it created are **not** removed: §1.1 forbids deleting saved
 * records, and by the time a batch is rolled back those records may already be
 * referenced. What this gives is the record that the import was wrong and who
 * said so — the undoing of the data itself is the ordinary deactivation or
 * reversal route for whatever was imported.
 */
export async function rollback(
  tx: Tx,
  ctx: ActorContext,
  batchId: string,
  reason: string,
): Promise<void> {
  const batch = await loadBatch(tx, batchId);
  const definition = definitionFor(batch.definitionKey);

  await authz.authorize(ctx.principal, 'import', definition.permissionObject, {
    branchCode: ctx.branchCode,
    objectId: batchId,
    requestId: ctx.requestId ?? null,
  });

  assertBatchTransition(batch.status, 'rolled_back');

  if (!reason.trim()) {
    throw new ImportRowError(0, 'a rollback requires a reason, which is recorded (§5.4).');
  }

  await tx
    .update(importBatch)
    .set({ status: 'rolled_back', rolledBackAt: new Date(), rollbackReason: reason })
    .where(eq(importBatch.id, batchId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'import.rolled_back',
    objectType: 'import_batch',
    objectId: batchId,
    branchCode: ctx.branchCode,
    before: { status: batch.status },
    after: { status: 'rolled_back' },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Discards a batch that was never committed. */
export async function discard(tx: Tx, ctx: ActorContext, batchId: string): Promise<void> {
  const batch = await loadBatch(tx, batchId);

  if (batch.status === 'committed' || batch.status === 'rolled_back') {
    throw new ImportRowError(0, 'a committed batch is the record of where those rows came from and is kept (§26).');
  }

  await tx.delete(importBatch).where(eq(importBatch.id, batchId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadBatch(tx: Tx, batchId: string) {
  const [row] = await tx.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!row) throw new ImportBatchNotFoundError(batchId);
  return row;
}

/** The failures, for re-rendering the error file after the fact. */
export async function failedRows(tx: Tx, batchId: string) {
  return tx
    .select()
    .from(importRow)
    .where(and(eq(importRow.batchId, batchId), eq(importRow.status, 'invalid')))
    .orderBy(asc(importRow.rowNo));
}

/** §26 — where did this record come from? */
export async function provenanceOf(tx: Tx, targetId: string) {
  const rows = await tx
    .select({
      batchId: importRow.batchId,
      rowNo: importRow.rowNo,
      sourceId: importRow.sourceId,
      definitionKey: importBatch.definitionKey,
      fileName: importBatch.fileName,
      committedAt: importBatch.committedAt,
      importedBy: importBatch.createdBy,
    })
    .from(importRow)
    .innerJoin(importBatch, eq(importBatch.id, importRow.batchId))
    .where(eq(importRow.targetId, targetId))
    .limit(1);

  return rows[0] ?? null;
}

export function statusOf(batch: { status: ImportBatchStatus }): ImportBatchStatus {
  return batch.status;
}
