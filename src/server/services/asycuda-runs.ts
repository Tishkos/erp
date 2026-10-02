/**
 * The ASYCUDA update, as a run — REQ-AP-001 §21.8.
 *
 * `customs-pd.asycudaDiff` and `.asycudaApply` already do the work: they read
 * the list, say what each line would change, and apply the changes as history
 * rows with source `asycuda_list`. What they did not do is remember. This
 * keeps the reading:
 *
 *   read   the file (or the pasted list) becomes lines, the difference is
 *          computed, and both are stored with who read them and when.
 *          Nothing in the books moves.
 *   apply  the stored lines are applied by the engine that always applied
 *          them, and the run is marked with who applied it.
 *
 * Why store the lines rather than recompute from the file: the file goes home
 * with the officer, and the difference six weeks from now is not the
 * difference that was seen on the day — the PDs have moved since. A run has to
 * answer "what did customs say, and what did we do about it", and only the
 * text as read can answer the first half.
 */
import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { asycudaRun } from '../db/schema';
import {
  AsycudaFileError,
  chooseSheet,
  countLines,
  extensionOf,
  isReadableAsycudaFile,
  sheetToLines,
  textToLines,
  type AsycudaFileRead,
} from '../domain/asycuda-file';
import { isCompoundFile, readXlsWorkbook } from '../xls-read';
import { readWorkbook } from '../xlsx-read';
import * as audit from './audit';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as customs from './customs-pd';

export interface UploadedFile {
  readonly fileName: string;
  readonly content: Buffer;
}

/**
 * One uploaded ASYCUDA export, as lines.
 *
 * Never guesses at a format it cannot read: a PDF export (which some offices
 * produce) is refused by name here rather than parsed into nonsense, with the
 * refusal saying what to send instead.
 */
export function readFile(file: UploadedFile): AsycudaFileRead {
  if (!isReadableAsycudaFile(file.fileName)) {
    throw new AsycudaFileError(
      `${file.fileName} is a ${extensionOf(file.fileName) || 'file'} and the document list is read from a workbook or a CSV. ` +
        'Export the list from ASYCUDA as Excel or CSV, or paste it below.',
    );
  }

  const extension = extensionOf(file.fileName);
  if (extension === '.csv' || extension === '.txt' || extension === '.tsv') {
    const text = textToLines(file.content.toString('utf8'));
    return { text, rowCount: countLines(text), sheetName: null, sheetNames: [], note: null };
  }

  let sheets;
  try {
    sheets = isCompoundFile(file.content) ? readXlsWorkbook(file.content) : readWorkbook(file.content);
  } catch (error) {
    throw new AsycudaFileError(
      `${file.fileName} could not be read as a workbook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sheetNames = [...sheets.keys()];
  const chosen = chooseSheet(sheets);
  if (!chosen) throw new AsycudaFileError(`${file.fileName} has no rows in it.`);
  const text = sheetToLines(chosen.rows);
  return {
    text,
    rowCount: countLines(text),
    sheetName: chosen.name,
    sheetNames,
    note:
      sheetNames.length > 1
        ? `The workbook has ${sheetNames.length} sheets; the list was read from "${chosen.name}" because it holds the most rows.`
        : null,
  };
}

/** Several files, in the order given, as one list. */
export function readFiles(files: readonly UploadedFile[]): AsycudaFileRead {
  if (files.length === 0) throw new AsycudaFileError('No file was chosen.');
  const reads = files.map(readFile);
  const text = reads
    .map((read) => read.text)
    .filter((part) => part.trim() !== '')
    .join('\n');
  const notes = reads.map((read) => read.note).filter((note): note is string => Boolean(note));
  return {
    text,
    rowCount: countLines(text),
    sheetName: reads.length === 1 ? reads[0]!.sheetName : null,
    sheetNames: reads.flatMap((read) => read.sheetNames),
    note: notes.length > 0 ? notes.join(' ') : null,
  };
}

export function listSha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Reads a list and keeps the reading. Changes nothing in the books.
 *
 * The permission is `import` on the PD object — the same one the apply needs,
 * because a reading that cannot be applied is of no use to anybody, and
 * because the difference itself names every declaration the company holds.
 */
export async function startRun(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly source: 'file' | 'paste'; readonly fileNames: readonly string[]; readonly text: string },
): Promise<{ readonly id: string; readonly changeCount: number }> {
  await authz.authorize(ctx.principal, 'import', customs.PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const text = input.text.trim();
  if (text === '') throw new AsycudaFileError('There is nothing in that list.');

  const diff = await customs.asycudaDiff(tx, text);
  const changeCount = diff.rows.filter((row) => row.outcome === 'change').length;

  const [row] = await tx
    .insert(asycudaRun)
    .values({
      source: input.source,
      fileNames: [...input.fileNames],
      textSha256: listSha(text),
      lineText: text,
      report: { rows: diff.rows, unreadable: diff.unreadable },
      lineCount: diff.rows.length,
      changeCount,
      unreadableCount: diff.unreadable.length,
      status: 'previewed',
      readBy: ctx.principal.userId,
    })
    .returning({ id: asycudaRun.id });

  const id = row!.id;
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'asycuda.list_read',
    objectType: 'asycuda_run',
    objectId: id,
    branchCode: ctx.branchCode,
    outcome: 'success',
    after: {
      source: input.source,
      fileNames: input.fileNames,
      lines: diff.rows.length,
      changes: changeCount,
      unreadable: diff.unreadable.length,
      sha256: listSha(text),
    },
  });
  return { id, changeCount };
}

/** The runs so far, newest first. */
export async function runs(tx: Tx, limit = 12) {
  return tx
    .select({
      id: asycudaRun.id,
      source: asycudaRun.source,
      fileNames: asycudaRun.fileNames,
      lineCount: asycudaRun.lineCount,
      changeCount: asycudaRun.changeCount,
      unreadableCount: asycudaRun.unreadableCount,
      status: asycudaRun.status,
      readAt: asycudaRun.readAt,
      appliedAt: asycudaRun.appliedAt,
    })
    .from(asycudaRun)
    .orderBy(desc(asycudaRun.readAt))
    .limit(limit);
}

export async function run(tx: Tx, id: string) {
  const [row] = await tx.select().from(asycudaRun).where(eq(asycudaRun.id, id)).limit(1);
  return row ?? null;
}

/**
 * Applies a run that was read earlier.
 *
 * The difference is recomputed from the stored lines rather than taken from
 * the stored report: between reading and applying, somebody may have changed
 * a declaration on its own screen, and the engine must act on what is true
 * now. The report stays as it was — it is the record of what was shown to the
 * person who said yes.
 */
export async function applyRun(tx: Tx, ctx: ActorContext, id: string) {
  const existing = await run(tx, id);
  if (!existing) throw new AsycudaFileError('That reading is not on the system.');
  if (existing.status === 'applied') {
    throw new AsycudaFileError('That reading has already been applied. Read the list again to see what is left.');
  }

  const result = await customs.asycudaApply(tx, ctx, existing.lineText);
  await tx
    .update(asycudaRun)
    .set({ status: 'applied', appliedBy: ctx.principal.userId, appliedAt: new Date() })
    .where(eq(asycudaRun.id, id));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'asycuda.list_applied',
    objectType: 'asycuda_run',
    objectId: id,
    branchCode: ctx.branchCode,
    outcome: 'success',
    after: { ...result, runId: id },
  });
  return result;
}
