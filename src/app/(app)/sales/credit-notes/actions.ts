'use server';

import { redirect } from 'next/navigation';
import { registerAllRecords } from '@/server/records';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { parseDecimal } from '@domain/money';
import * as notes from '@/server/services/customer-notes';
import * as attachments from '@/server/services/attachments';

const LIST = '/sales/credit-notes';
const record = (noteNo: string) => `${LIST}/${encodeURIComponent(noteNo)}`;

/** Raises a credit or debit note as a draft, and opens it. */
export async function createNote(formData: FormData): Promise<void> {
  const kind = text(formData, 'kind') === 'debit' ? 'debit' : 'credit';
  const outcome = await runAdmin((tx, ctx) =>
    notes.create(tx, ctx, {
      kind,
      customerId: text(formData, 'customer_id'),
      branchCode: ctx.branchCode,
      noteDate: text(formData, 'note_date'),
      dueDate: text(formData, 'due_date').trim() || null,
      arInvoiceId: text(formData, 'ar_invoice_id') || null,
      amountIqd: parseDecimal(text(formData, 'amount_iqd').trim() || '0', 4n),
      reason: text(formData, 'reason'),
      description: text(formData, 'description') || null,
      accountId: text(formData, 'account_id') || null,
    }),
  );
  if (!outcome.ok) {
    const back = `${LIST}/new?kind=${kind}&customer=${encodeURIComponent(text(formData, 'customer_code'))}`;
    redirect(withQuery(back, 'error', outcome.error!));
  }
  redirect(record(outcome.value!.noteNo));
}

export async function approveNote(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => notes.approve(tx, ctx, text(formData, 'id')), record(text(formData, 'note_no')));
}

/** Posts it — and a credit note against an invoice settles that invoice as far as it owes. */
export async function postNote(formData: FormData): Promise<void> {
  await runAdminAndReturn((tx, ctx) => notes.post(tx, ctx, text(formData, 'id')), record(text(formData, 'note_no')));
}

export async function cancelNote(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => notes.cancel(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(text(formData, 'note_no')),
  );
}

export async function reverseNote(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) => notes.reverse(tx, ctx, text(formData, 'id'), { reason: text(formData, 'reason') }),
    record(text(formData, 'note_no')),
  );
}

/** A file stapled to the note — the customer's letter, the agreed allowance. */
export async function attachToNote(formData: FormData): Promise<void> {
  const noteNo = text(formData, 'note_no');
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    redirect(withQuery(record(noteNo), 'error', 'attachment_missing'));
  }
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    const found = await notes.viewByNo(tx, noteNo);
    if (!found) redirect(withQuery(record(noteNo), 'error', 'not_found'));
    await attachments.upload(tx, ctx, {
      objectType: notes.ATTACHMENT_OBJECT,
      objectId: found.id,
      fileName: upload.name,
      content,
    });
  }, record(noteNo));
}
