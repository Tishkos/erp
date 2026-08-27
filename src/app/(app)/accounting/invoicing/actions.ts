'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as invoicing from '@/server/services/invoicing';

const LIST = '/accounting/invoicing';
const record = (documentNo: string) => `${LIST}/${encodeURIComponent(documentNo)}`;

/**
 * What an approval *does* is registered, not implied.
 *
 * The routing engine refuses to approve a document type whose execution
 * effect nobody has declared — deliberately, because the alternative is an
 * approval that appears to work and changes nothing. It also brings up the
 * attachment storage, scanner and parent-access rule. Every action here
 * needs one or both, so every action makes sure of them first; the call is
 * idempotent and only the first one in the process does any work.
 */
function ready(): void {
  registerAllRecords();
}

/**
 * "New invoice" — the document opens, numbered, and the rest is filled in on
 * it. §9's number is allocated at this moment and belongs to this document
 * from here on, whatever becomes of it.
 */
export async function startInvoice(): Promise<void> {
  ready();
  const outcome = await runAdmin((tx, ctx) => invoicing.start(tx, ctx));
  if (!outcome.ok) redirect(withQuery(LIST, 'error', outcome.error!));
  redirect(record(outcome.value!.documentNo));
}

export async function updateInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) =>
      invoicing.update(tx, ctx, text(formData, 'id'), {
        customerName: text(formData, 'customerName'),
        description: text(formData, 'description'),
        currency: text(formData, 'currency'),
        departmentCode: text(formData, 'departmentCode'),
        documentDate: text(formData, 'documentDate'),
      }),
    record(documentNo),
  );
}

export async function addInvoiceLine(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) =>
      invoicing.addLine(tx, ctx, text(formData, 'id'), {
        description: text(formData, 'description'),
        quantity: text(formData, 'quantity'),
        unitPrice: text(formData, 'unitPrice'),
      }),
    record(documentNo),
  );
}

export async function removeInvoiceLine(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) => invoicing.removeLine(tx, ctx, text(formData, 'id'), text(formData, 'lineId')),
    record(documentNo),
  );
}

/** §5.2 — to the manager of the document's department, or finalised by that manager. */
export async function submitInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) => invoicing.submit(tx, ctx, text(formData, 'id')),
    record(documentNo),
  );
}

export async function approveInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) => invoicing.approve(tx, ctx, text(formData, 'id')),
    record(documentNo),
  );
}

export async function rejectInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) => invoicing.reject(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(documentNo),
  );
}

export async function cancelInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) => invoicing.cancel(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(documentNo),
  );
}

/**
 * Throwing a draft away. Back to the list, since the record it was on is gone.
 */
export async function discardInvoice(formData: FormData): Promise<void> {
  ready();
  const outcome = await runAdmin((tx, ctx) =>
    invoicing.discardDraft(tx, ctx, text(formData, 'id')),
  );
  if (!outcome.ok) {
    redirect(withQuery(record(text(formData, 'documentNo')), 'error', outcome.error!));
  }
  redirect(withQuery(LIST, 'saved', '1'));
}

/** §7 — an approved invoice is undone by reversal, never by deletion. */
export async function reverseInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  await runAdminAndReturn(
    (tx, ctx) => invoicing.reverse(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(documentNo),
  );
}

/**
 * §21 — staple a document to the invoice.
 *
 * The bytes are read here and handed to the service, which inspects them,
 * scans them and stores them. A file that fails any of that never reaches the
 * record: the upload is refused and the reason is shown.
 */
export async function attachToInvoice(formData: FormData): Promise<void> {
  ready();
  const documentNo = text(formData, 'documentNo');
  const id = text(formData, 'id');
  const file = formData.get('file');

  if (!(file instanceof File) || file.size === 0) {
    redirect(withQuery(record(documentNo), 'error', 'attachment_missing'));
  }

  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  await runAdminAndReturn(
    (tx, ctx) =>
      attachments.upload(tx, ctx, {
        objectType: invoicing.PERMISSION_OBJECT,
        objectId: id,
        fileName: upload.name,
        content,
      }),
    record(documentNo),
  );
}
