'use server';

import { runAdminAndReturn, text } from '@/server/admin-action';
import * as approvals from '@/server/services/approvals';

const BACK = '/approvals';

export async function approveFromInbox(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      approvals.decide(tx, ctx.principal, {
        documentTypeCode: text(formData, 'documentTypeCode'),
        documentId: text(formData, 'recordId'),
        decision: 'approve',
        branchCode: ctx.branchCode,
      }),
    BACK,
  );
}

export async function rejectFromInbox(formData: FormData): Promise<void> {
  await runAdminAndReturn(
    (tx, ctx) =>
      approvals.decide(tx, ctx.principal, {
        documentTypeCode: text(formData, 'documentTypeCode'),
        documentId: text(formData, 'recordId'),
        decision: 'reject',
        reason: text(formData, 'reason'),
        branchCode: ctx.branchCode,
      }),
    BACK,
  );
}
