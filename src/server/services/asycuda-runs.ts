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
import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, asycudaRun, customsPd } from '../db/schema';
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
import { businessToday } from '../domain/business-date';
import { can } from '../domain/permissions';
import * as attachments from './attachments';
import * as audit from './audit';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import * as customs from './customs-pd';
import { allocateDocumentNumber } from './numbering';

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
  input: {
    readonly source: 'file' | 'paste';
    readonly fileNames: readonly string[];
    readonly text: string;
    /** IMPROVEMENT-002 — the files read, filed on the reading as its attachments. */
    readonly files?: readonly UploadedFile[];
  },
): Promise<{ readonly id: string; readonly runNo: string; readonly changeCount: number }> {
  await authz.authorize(ctx.principal, 'import', customs.PERMISSION_OBJECT, { branchCode: ctx.branchCode });

  const text = input.text.trim();
  if (text === '') throw new AsycudaFileError('There is nothing in that list.');

  const diff = await customs.asycudaDiff(tx, text);
  const changeCount = diff.rows.filter((row) => row.outcome === 'change').length;

  // IMPROVEMENT-002 — a reading is a document with its own number.
  const allocated = await allocateDocumentNumber(tx, 'ASYCUDA_RUN', { year: Number(businessToday().slice(0, 4)) }, ctx.principal.userId);
  const [row] = await tx
    .insert(asycudaRun)
    .values({
      runNo: allocated.documentNo,
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
  // The export it was read from stays with it: "which file did we act on?"
  // is answered by opening the document. Filed by whoever may file paperwork.
  if (input.files && input.files.length > 0 && can(ctx.principal, 'create', attachments.PERMISSION_OBJECT)) {
    for (const file of input.files) {
      await attachments.upload(tx, ctx, { objectType: RUN_OBJECT, objectId: id, fileName: file.fileName, content: file.content });
    }
  }
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
      runNo: allocated.documentNo,
    },
  });
  return { id, runNo: allocated.documentNo, changeCount };
}

/** The object a reading's attachments and history are filed under. */
export const RUN_OBJECT = 'asycuda_run';

/**
 * IMPROVEMENT-002 — the readings as a register, newest first, searched by
 * number or file name and filtered by status.
 */
export async function listRuns(tx: Tx, filter: { readonly search?: string | null; readonly status?: 'previewed' | 'applied' | null; readonly page?: number }) {
  const search = filter.search?.trim() ? `%${filter.search.trim()}%` : null;
  const where = and(
    filter.status ? eq(asycudaRun.status, filter.status) : undefined,
    search ? or(ilike(asycudaRun.runNo, search), sql`${asycudaRun.fileNames}::text ilike ${search}`) : undefined,
  );
  const pageSize = 50;
  const page = Math.max(1, filter.page ?? 1);
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(asycudaRun).where(where);
  const rows = await tx
    .select({
      id: asycudaRun.id,
      runNo: asycudaRun.runNo,
      source: asycudaRun.source,
      fileNames: asycudaRun.fileNames,
      lineCount: asycudaRun.lineCount,
      changeCount: asycudaRun.changeCount,
      unreadableCount: asycudaRun.unreadableCount,
      status: asycudaRun.status,
      readAt: asycudaRun.readAt,
      readBy: appUser.displayName,
      appliedAt: asycudaRun.appliedAt,
      files: sql<number>`(select count(*)::int from attachment a where a.object_type = ${RUN_OBJECT} and a.object_id = ${asycudaRun.id}::text and a.superseded_by_id is null)`,
    })
    .from(asycudaRun)
    .leftJoin(appUser, eq(appUser.id, asycudaRun.readBy))
    .where(where)
    .orderBy(desc(asycudaRun.readAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const total = count?.n ?? 0;
  return { rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}

/** One line of a reading as the document shows it. */
export interface RunLine {
  readonly line: number;
  /** The line exactly as ASYCUDA gave it, its fields in order. */
  readonly fields: readonly string[];
  readonly pdNo: string | null;
  readonly effectiveDate: string | null;
  /** What ASYCUDA says, as one of our status codes (null when the line was not read). */
  readonly asycudaStatus: string | null;
  /** What the PD was when the list was read. */
  readonly wasStatus: string | null;
  readonly outcome: 'change' | 'same' | 'not_found' | 'ambiguous' | 'final' | 'unreadable';
  readonly why: string | null;
  readonly payableNo: string | null;
  /** The PD as it stands now, for the link and the "now" column. */
  readonly pd: { readonly pdNo: string; readonly year: number; readonly statusCode: string } | null;
}

/**
 * IMPROVEMENT-002 — the reading's lines in the order ASYCUDA listed them:
 * each line's own fields as they were in the export, what was read from it,
 * what the PD was then, and what it is now. Read lines and unread ones are one
 * list, so a line nobody could read sits where it was in the file.
 */
export async function runLines(tx: Tx, run: { readonly lineText: string; readonly report: unknown }): Promise<RunLine[]> {
  const report = (run.report ?? {}) as {
    rows?: { line: number; pdNo: string; pdId: string | null; payableNo: string | null; currentStatus: string | null; newStatus: string; effectiveDate: string | null; outcome: RunLine['outcome'] }[];
    unreadable?: { line: number; text: string; why: string }[];
  };
  const raw = run.lineText.split(/\r?\n/);
  const fieldsOf = (line: number, fallback: string) =>
    (raw[line - 1] ?? fallback)
      .split(/\t|,|;|\s{2,}/)
      .map((field) => field.trim())
      .filter((field) => field !== '');
  const ids = [...new Set((report.rows ?? []).map((row) => row.pdId).filter((id): id is string => Boolean(id)))];
  const live = ids.length
    ? await tx
        .select({ id: customsPd.id, pdNo: customsPd.pdNo, year: customsPd.registrationYear, statusCode: customsPd.statusCode })
        .from(customsPd)
        .where(inArray(customsPd.id, ids))
    : [];
  const byId = new Map(live.map((pd) => [pd.id, pd]));
  const read: RunLine[] = (report.rows ?? []).map((row) => {
    const pd = row.pdId ? byId.get(row.pdId) : undefined;
    return {
      line: row.line,
      fields: fieldsOf(row.line, row.pdNo),
      pdNo: row.pdNo,
      effectiveDate: row.effectiveDate,
      asycudaStatus: row.newStatus,
      wasStatus: row.currentStatus,
      outcome: row.outcome,
      why: null,
      payableNo: row.payableNo,
      pd: pd ? { pdNo: pd.pdNo, year: Number(pd.year), statusCode: pd.statusCode } : null,
    };
  });
  const unread: RunLine[] = (report.unreadable ?? []).map((row) => ({
    line: row.line,
    fields: fieldsOf(row.line, row.text),
    pdNo: null,
    effectiveDate: null,
    asycudaStatus: null,
    wasStatus: null,
    outcome: 'unreadable',
    why: row.why,
    payableNo: null,
    pd: null,
  }));
  return [...read, ...unread].sort((a, b) => a.line - b.line);
}

/** One reading by its number, with who read and applied it. */
export async function runByNo(tx: Tx, runNo: string) {
  const [row] = await tx.select().from(asycudaRun).where(eq(asycudaRun.runNo, runNo.trim().toUpperCase())).limit(1);
  if (!row) return null;
  const people = await tx
    .select({ id: appUser.id, name: appUser.displayName })
    .from(appUser)
    .where(inArray(appUser.id, [row.readBy, ...(row.appliedBy ? [row.appliedBy] : [])]));
  const nameOf = (id: string | null) => (id ? (people.find((p) => p.id === id)?.name ?? null) : null);
  return { run: row, readByName: nameOf(row.readBy), appliedByName: nameOf(row.appliedBy) };
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
  // HD9 — locked before its status is read: two clicks apply it once.
  const [existing] = await tx.select().from(asycudaRun).where(eq(asycudaRun.id, id)).limit(1).for('update');
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
