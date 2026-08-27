'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { registerAllRecords } from './records';
import { withCurrentUser } from './session';
import { perform } from './services/document-actions';

/**
 * The action behind the buttons on a record page.
 *
 * The record framework has always *shown* the right buttons — enabled exactly
 * when the status machine and the reader's permissions allow — but they were
 * rendered as inert `type="button"` and did nothing when pressed. Everything
 * they need already existed: `document-actions.perform` decides whether the
 * action is available, calls the effect the owning module registered, and
 * writes the trail. This connects the two.
 *
 * It takes the return path from the form rather than deriving it: a record
 * lives at whatever address its module gives it, and a shared action has no
 * business knowing that a chart account is addressed by code and a journal by
 * its entry number.
 */
export async function performRecordAction(formData: FormData): Promise<void> {
  registerAllRecords();

  const documentType = String(formData.get('documentType') ?? '');
  const documentId = String(formData.get('documentId') ?? '');
  const action = String(formData.get('action') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const returnTo = String(formData.get('returnTo') ?? '/');

  const outcome = await withCurrentUser(async (tx, context) => {
    try {
      await perform(tx, context.principal, {
        documentType,
        documentId,
        action,
        reason: reason || null,
        branchCode: context.scope.branchCode,
      });
      return null;
    } catch (error) {
      // The refusal is shown, not thrown: a person who cannot take an action
      // needs to read why, and `perform` says so in a sentence.
      return error instanceof Error ? error.message : String(error);
    }
  });

  revalidatePath(returnTo);
  redirect(outcome ? `${returnTo}?error=${encodeURIComponent(outcome)}` : `${returnTo}?saved=1`);
}
