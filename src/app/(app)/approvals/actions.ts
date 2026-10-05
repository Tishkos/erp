'use server';

import { runAdminAndReturn, text, withQuery } from '@/server/admin-action';
import * as approvalCenter from '@/server/services/approval-center';

/**
 * Deciding from My Approvals.
 *
 * Nothing is decided here. `approval-center.decide` calls the service that owns
 * the document — `journal.approve`, `business-partner.approveBankAccount`, the
 * chart of accounts' own maker-checker — exactly as that document's page does,
 * so the role, the department and the four-eyes rule are the service's, and a
 * refusal comes back in the service's own sentence. The list says "Saved" only
 * after the service returned.
 *
 * The page's filter travels as plain fields and the address is rebuilt here: a
 * return address is never taken from the form.
 */
const BACK = '/approvals';

function returnTo(formData: FormData): string {
  let target = BACK;
  for (const key of ['documentTypeFilter', 'q', 'page'] as const) {
    const value = text(formData, key).trim();
    if (value) target = withQuery(target, key === 'documentTypeFilter' ? 'documentType' : key, value);
  }
  return target;
}

export async function approveItem(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      approvalCenter.decide(tx, ctx, {
        documentType: text(formData, 'documentType'),
        documentId: text(formData, 'documentId'),
        decision: 'approve',
      }),
    returnTo(formData),
  );
}

export async function rejectItem(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      approvalCenter.decide(tx, ctx, {
        documentType: text(formData, 'documentType'),
        documentId: text(formData, 'documentId'),
        decision: 'reject',
        reason: text(formData, 'reason'),
      }),
    returnTo(formData),
  );
}
