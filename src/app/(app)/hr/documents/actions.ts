'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as documents from '@/server/services/employee-documents';

/**
 * Documents — REQ-HR-001 Stage HR-6. A document is filed, corrected while
 * valid, renewed by a new row or withdrawn with a reason; its scan is an
 * attachment on it.
 */
const LIST = '/hr/documents';
const record = (documentNo: string) => `${LIST}/${encodeURIComponent(documentNo)}`;

const detailsOf = (form: FormData) => ({
  title: text(form, 'title') || null,
  referenceNo: text(form, 'reference_no') || null,
  issuedOn: text(form, 'issued_on') || null,
  expiresOn: text(form, 'expires_on') || null,
  note: text(form, 'note') || null,
});

export async function createDocument(form: FormData): Promise<void> {
  /*
   * The scan, if one was chosen, filed in the same transaction as the record
   * it belongs to (2026-10-03). Read before the transaction opens because
   * reading a file is slow and a transaction holding a row lock should not
   * wait on a disk.
   */
  const file = form.get('file');
  const upload = file instanceof File && file.size > 0 ? file : null;
  const content = upload ? Buffer.from(await upload.arrayBuffer()) : null;
  if (upload) registerAllRecords();

  const outcome = await runAdmin(async (tx, ctx) => {
    const made = await documents.create(tx, ctx, {
      employeeId: text(form, 'employee_id'),
      docType: text(form, 'doc_type'),
      ...detailsOf(form),
    });
    if (upload && content) {
      await attachments.upload(tx, ctx, {
        objectType: documents.PERMISSION_OBJECT,
        objectId: made.id,
        fileName: upload.name,
        content,
      });
    }
    return made;
  });
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.documentNo)}?saved=1`);
}

export async function updateDocument(form: FormData): Promise<void> {
  const documentNo = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => documents.update(tx, ctx, documentNo, detailsOf(form)), record(documentNo));
}

/** Renewed: the new paper is its own record, which opens next for its scan. */
export async function renewDocument(form: FormData): Promise<void> {
  const documentNo = text(form, 'document_no');
  const outcome = await runAdmin((tx, ctx) => documents.renew(tx, ctx, documentNo, detailsOf(form)));
  if (!outcome.ok) redirect(`${record(documentNo)}?error=${encodeURIComponent(outcome.error ?? '')}`);
  redirect(`${record(outcome.value!.documentNo)}?saved=1`);
}

export async function withdrawDocument(form: FormData): Promise<void> {
  const documentNo = text(form, 'document_no');
  await runAdminAndReturn((tx, ctx) => documents.withdraw(tx, ctx, documentNo, text(form, 'reason')), record(documentNo));
}

/** The scan, filed on the document. */
export async function attachToDocument(form: FormData): Promise<void> {
  const documentNo = text(form, 'document_no');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${record(documentNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    await attachments.upload(tx, ctx, { objectType: documents.PERMISSION_OBJECT, objectId: text(form, 'id'), fileName: upload.name, content });
  }, record(documentNo));
}
