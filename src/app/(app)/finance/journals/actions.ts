'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { runAdmin, runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as journal from '@/server/services/journal';
import { businessToday } from '@/server/domain/business-date';

const LIST = '/finance/journals';
const record = (entryNo: string) => `${LIST}/${encodeURIComponent(entryNo)}`;

/** The registrations an approval needs before it can do anything. */
function ready(): void {
  registerAllRecords();
}

/** What the grid hears back: it happened, or why it did not. */
export interface LineOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly lineNo?: number;
}

/**
 * "New journal" — one press, and the entry is open with its number allocated,
 * dated today (by direction, 2026-08-29: the document appears instantly; the
 * dates and the description are corrected on it, not asked for first).
 *
 * §14.2 says the number is "generated automatically and never reused", and it
 * is allocated now rather than at posting so the accountant can refer to the
 * entry they are working on. An abandoned draft therefore leaves a gap in the
 * series, which is the honest cost of that choice and is reported as such.
 */
export async function startJournal(): Promise<void> {
  ready();
  const today = businessToday();
  const outcome = await runAdmin((tx, ctx) =>
    journal.createDraft(tx, ctx, {
      branchCode: ctx.branchCode,
      documentDate: today,
      postingDate: today,
      description: null,
    }),
  );
  if (!outcome.ok) redirect(withQuery(LIST, 'error', outcome.error!));
  redirect(record(outcome.value!.entryNo));
}

/** The header of a draft — the dates and the description — changed in place. */
export async function updateJournalHeader(formData: FormData): Promise<LineOutcome> {
  ready();
  const outcome = await runAdmin((tx, ctx) =>
    journal.updateHeader(tx, ctx, text(formData, 'id'), {
      documentDate: text(formData, 'documentDate') || null,
      postingDate: text(formData, 'postingDate') || null,
      description: text(formData, 'description'),
    }),
  );
  if (outcome.ok) revalidatePath(record(text(formData, 'entryNo')));
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error! };
}

/**
 * One line of the grid, saved as it is left.
 *
 * A debit cell and a credit cell, as on the sheet. Blank means nothing on
 * that side; the domain refuses a line that fills both or neither, and says
 * which, so there is nothing to re-check here. With a `lineId` the line is
 * changed in place; without one it is added.
 *
 * Returns rather than redirects: the grid stays where the person is typing
 * and refreshes its figures itself.
 */
export async function saveJournalLine(formData: FormData): Promise<LineOutcome> {
  ready();
  const id = text(formData, 'id');
  const lineId = text(formData, 'lineId');
  const debit = text(formData, 'debit');
  const credit = text(formData, 'credit');
  const input = {
    accountId: text(formData, 'accountId'),
    ...(debit ? { debit } : {}),
    ...(credit ? { credit } : {}),
    // No per-line note: the journal's own description says what the entry is
    // for (by direction, 2026-08-31), and the grid no longer collects one.
    dimensions: { department: text(formData, 'departmentCode') || null },
  };
  const outcome = await runAdmin((tx, ctx) =>
    lineId ? journal.updateLine(tx, ctx, id, lineId, input) : journal.addLine(tx, ctx, id, input),
  );
  if (outcome.ok) revalidatePath(record(text(formData, 'entryNo')));
  return outcome.ok
    ? { ok: true, lineNo: outcome.value!.lineNo }
    : { ok: false, error: outcome.error! };
}

/** Taking one line off a draft. The rest renumber; the totals follow. */
export async function removeJournalLine(formData: FormData): Promise<LineOutcome> {
  ready();
  const outcome = await runAdmin((tx, ctx) =>
    journal.removeLine(tx, ctx, text(formData, 'id'), text(formData, 'lineId')),
  );
  if (outcome.ok) revalidatePath(record(text(formData, 'entryNo')));
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error! };
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
