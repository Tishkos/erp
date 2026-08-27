'use server';

import { redirect } from 'next/navigation';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as journal from '@/server/services/journal';

const LIST = '/finance/journals';
const record = (entryNo: string) => `${LIST}/${encodeURIComponent(entryNo)}`;

/** The registrations an approval needs before it can do anything. */
function ready(): void {
  registerAllRecords();
}

/**
 * "New journal" — the entry opens with its number already allocated.
 *
 * §14.2 says the number is "generated automatically and never reused", and it
 * is allocated now rather than at posting so the accountant can refer to the
 * entry they are working on. An abandoned draft therefore leaves a gap in the
 * series, which is the honest cost of that choice and is reported as such.
 */
export async function startJournal(formData: FormData): Promise<void> {
  ready();
  const postingDate = text(formData, 'postingDate');
  const outcome = await runAdmin((tx, ctx) =>
    journal.createDraft(tx, ctx, {
      branchCode: ctx.branchCode,
      documentDate: text(formData, 'documentDate') || postingDate,
      postingDate,
      description: text(formData, 'description'),
    }),
  );
  if (!outcome.ok) redirect(withQuery(LIST, 'error', outcome.error!));
  redirect(record(outcome.value!.entryNo));
}

export async function addJournalLine(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  // A debit cell and a credit cell, as on the sheet. Blank means nothing on
  // that side; the domain refuses a line that fills both or neither, and says
  // which, so there is nothing to re-check here.
  const debit = text(formData, 'debit');
  const credit = text(formData, 'credit');
  await runAdminAndReturn(
    (tx, ctx) =>
      journal.addLine(tx, ctx, text(formData, 'id'), {
        accountId: text(formData, 'accountId'),
        ...(debit ? { debit } : {}),
        ...(credit ? { credit } : {}),
        // The line is entered in a currency, and the amount typed is in that
        // currency. Omitting it made every line IQD regardless of what was
        // chosen, which a dollar-only account then refused.
        currency: text(formData, 'currency') || 'IQD',
        description: text(formData, 'description'),
        dimensions: { department: text(formData, 'departmentCode') || null },
      }),
    record(entryNo),
  );
}

/** Taking one line off a draft. The rest renumber; the totals follow. */
export async function removeJournalLine(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  await runAdminAndReturn(
    (tx, ctx) => journal.removeLine(tx, ctx, text(formData, 'id'), text(formData, 'lineId')),
    record(entryNo),
  );
}

/**
 * Throwing a draft away. Back to the list, because the entry it was on is gone.
 */
export async function discardJournal(formData: FormData): Promise<void> {
  ready();
  const outcome = await runAdmin((tx, ctx) =>
    journal.discardDraft(tx, ctx, text(formData, 'id')),
  );
  if (!outcome.ok) redirect(withQuery(record(text(formData, 'entryNo')), 'error', outcome.error!));
  redirect(withQuery(LIST, 'saved', '1'));
}

/**
 * §14.4 — an accountant submits to the Finance Manager; a Finance Manager
 * "creates and posts directly", so for them this one act does both. The
 * service decides which, from the permissions the person holds.
 */
export async function submitJournal(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  await runAdminAndReturn(
    (tx, ctx) => journal.submit(tx, ctx, text(formData, 'id')),
    record(entryNo),
  );
}

export async function approveJournal(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  await runAdminAndReturn(
    (tx, ctx) => journal.approve(tx, ctx, text(formData, 'id')),
    record(entryNo),
  );
}

export async function rejectJournal(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  await runAdminAndReturn(
    (tx, ctx) => journal.reject(tx, ctx, text(formData, 'id'), text(formData, 'reason')),
    record(entryNo),
  );
}

/** Phase 1 §3 — a posted entry is corrected by a linked full reversal. */
export async function reverseJournal(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  const outcome = await runAdmin((tx, ctx) =>
    journal.reverse(tx, ctx, text(formData, 'id'), {
      reason: text(formData, 'reason'),
      postingDate: text(formData, 'postingDate') || null,
    }),
  );
  if (!outcome.ok) redirect(withQuery(record(entryNo), 'error', outcome.error!));
  // Straight to the reversal: it is the document that now matters.
  redirect(withQuery(record(outcome.value!.entryNo), 'saved', '1'));
}

/** §21 — the optional attachment requirement 2 asks for. */
export async function attachToJournal(formData: FormData): Promise<void> {
  ready();
  const entryNo = text(formData, 'entryNo');
  const id = text(formData, 'id');
  const file = formData.get('file');

  if (!(file instanceof File) || file.size === 0) {
    redirect(withQuery(record(entryNo), 'error', 'attachment_missing'));
  }

  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  await runAdminAndReturn(
    (tx, ctx) =>
      attachments.upload(tx, ctx, {
        objectType: journal.PERMISSION_OBJECT,
        objectId: id,
        fileName: upload.name,
        content,
      }),
    record(entryNo),
  );
}
