import { can, canAccessBranch, type Principal } from '@domain/permissions';
import { verbFor } from './access';
import type { Locale } from '@/i18n/config';
import type { Tx } from '../db/client';
import * as audit from '../services/audit';
import { renderDocx } from './docx';
import { safeFileName } from './format';
import { messagesFor } from './i18n';
import { letterheadFor } from './letterhead';
import { CONTENT_TYPE, type ExportFormat, type Letterhead, type PrintModel } from './model';
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
  | { readonly status: 403 | 404 };

export interface ExportRequest {
  readonly key: ExportKey;
  readonly format: ExportFormat;
  readonly locale: Locale;
  readonly input: ExportInput;
  /** When the copy is taken; defaults to now. */
  readonly at?: string;
}

export async function runExport(
  tx: Tx,
  reader: { readonly principal: Principal; readonly branchCode: string },
  request: ExportRequest,
): Promise<ExportResult> {
  const definition = exportable(request.key);
  const { principal } = reader;
  if (!can(principal, 'view', definition.object)) return { status: 404 };

  const at = request.at ?? new Date().toISOString();
  const verb = verbFor(request.format);
  if (!can(principal, verb, definition.object)) {
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
  if (definition.kind === 'document' && !canAccessBranch(principal, built.branchCode)) return { status: 404 };

  const head = await letterheadFor(tx, {
    locale: request.locale,
    userId: principal.userId,
    branchCode: built.branchCode,
    at,
  });
  const model = built.model;
  const body =
    request.format === 'pdf'
      ? await renderPdf(model, head)
      : request.format === 'xlsx'
        ? await renderXlsx(model, head)
        : await renderDocx(model, head);
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

  return { status: 200, body, fileName, contentType: CONTENT_TYPE[request.format], model, head };
}
