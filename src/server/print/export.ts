import { can, canAccessBranch, type Principal } from '@domain/permissions';
import { isSelfService, verbFor } from './access';
import type { Locale } from '@/i18n/config';
import type { Tx } from '../db/client';
import * as audit from '../services/audit';
import { renderDocx } from './docx';
import { safeFileName } from './format';
import { messagesFor } from './i18n';
import { letterheadFor } from './letterhead';
import { CONTENT_TYPE, EXPORT_ROW_CAP, rowsIn, type ExportFormat, type Letterhead, type PrintModel } from './model';
import { renderPdf } from './pdf';
import { exportable, type ExportInput, type ExportKey } from './registry';
import { renderXlsx } from './xlsx';

/**
 * One export, from the permission check to the file.
 *
 *   1. The reader must be able to see the screen (`view` on its object) —
 *      otherwise the document does not exist for them: 404.
 *   2. They must hold `print` for a PDF, `export` for a workbook or a Word
 *      file — otherwise 403, and the refusal is audited (§25).
 *   3. The document is read through row-level security, so another branch's
 *      is not found; and its branch is checked against theirs again here,
 *      because a copy leaving the building is the one read that must not
 *      rely on a single guard.
 *   4. The copy is recorded in the audit trail — who, which document or
 *      report, which format, which language, with which filters, when —
 *      before the file is handed over, in the same transaction.
 */
export type ExportResult =
  | {
      readonly status: 200;
      readonly body: Buffer;
      readonly fileName: string;
      readonly contentType: string;
      readonly model: PrintModel;
      readonly head: Letterhead;
    }
  | { readonly status: 403 | 404 }
  | { readonly status: 413; readonly rows: number; readonly cap: number };

/** What is read and recorded inside the transaction; the file is made after it. */
export type PreparedExport =
  | {
      readonly status: 200;
      readonly fileName: string;
      readonly contentType: string;
      readonly format: ExportFormat;
      readonly model: PrintModel;
      readonly head: Letterhead;
    }
  | { readonly status: 403 | 404 }
  | { readonly status: 413; readonly rows: number; readonly cap: number };


export interface ExportRequest {
  readonly key: ExportKey;
  readonly format: ExportFormat;
  readonly locale: Locale;
  readonly input: ExportInput;
  /** When the copy is taken; defaults to now. */
  readonly at?: string;
}

/**
 * Steps 1–4 above, inside the caller's transaction. Rendering is *not* here:
 * a PDF of twenty thousand rows takes seconds, and a transaction held open
 * for them keeps its locks and its connection from everyone else (OP-9).
 * `exportResponse` renders after the transaction has committed.
 */
export async function prepareExport(
  tx: Tx,
  reader: { readonly principal: Principal; readonly branchCode: string },
  request: ExportRequest,
): Promise<PreparedExport> {
  const definition = exportable(request.key);
  const { principal } = reader;
  // REQ-HR-001 R5 — the person's own payslip: row security decides, not the grant.
  const self = isSelfService(request.key) && !can(principal, 'view', definition.object);
  if (!self && !can(principal, 'view', definition.object)) return { status: 404 };

  const at = request.at ?? new Date().toISOString();
  const verb = verbFor(request.format);
  if (!self && !can(principal, verb, definition.object)) {
    await audit.record(tx, {
      actorUserId: principal.userId,
      action: `${definition.object}.exported`,
      objectType: definition.object,
      objectId: request.input.id ?? definition.key,
      branchCode: reader.branchCode || null,
      outcome: 'denied',
      after: { format: request.format, language: request.locale, report: definition.key, requestedAt: at },
    });
    return { status: 403 };
  }

  const m = messagesFor(request.locale);
  const built = await definition.build(
    { tx, principal, branchCode: reader.branchCode, locale: request.locale, m },
    request.input,
  );
  if (!built) return { status: 404 };
  if (definition.kind === 'document' && !self && !canAccessBranch(principal, built.branchCode)) return { status: 404 };

  const head = await letterheadFor(tx, {
    locale: request.locale,
    userId: principal.userId,
    branchCode: built.branchCode,
    at,
  });
  const model = built.model;
  const rows = rowsIn(model);
  if (rows > EXPORT_ROW_CAP) return { status: 413, rows, cap: EXPORT_ROW_CAP };
  const fileName = `${safeFileName(model.fileName)}.${request.format}`;

  await audit.record(tx, {
    actorUserId: principal.userId,
    action: `${definition.object}.exported`,
    objectType: definition.object,
    objectId: built.objectId,
    branchCode: built.branchCode || null,
    outcome: 'success',
    after: {
      format: request.format,
      language: request.locale,
      ...(definition.kind === 'document' ? { document: model.number ?? null } : { report: definition.key }),
      title: model.title,
      filters: Object.fromEntries(request.input.query.entries()),
      fileName,
      // An ISO string, not a Date: a Date in an audit value is written as {}.
      exportedAt: at,
    },
  });

  return { status: 200, fileName, contentType: CONTENT_TYPE[request.format], format: request.format, model, head };
}

/** The file itself — called once the transaction that prepared it has committed. */
export async function renderExport(prepared: Extract<PreparedExport, { status: 200 }>): Promise<Buffer> {
  return prepared.format === 'pdf'
    ? renderPdf(prepared.model, prepared.head)
    : prepared.format === 'xlsx'
      ? renderXlsx(prepared.model, prepared.head)
      : renderDocx(prepared.model, prepared.head);
}

/** Prepare and render in one call — for tests and scripts that hold their own transaction. */
export async function runExport(
  tx: Tx,
  reader: { readonly principal: Principal; readonly branchCode: string },
  request: ExportRequest,
): Promise<ExportResult> {
  const prepared = await prepareExport(tx, reader, request);
  if (prepared.status !== 200) return prepared;
  const body = await renderExport(prepared);
  return { status: 200, body, fileName: prepared.fileName, contentType: prepared.contentType, model: prepared.model, head: prepared.head };
}
