'use server';

import { redirect } from 'next/navigation';
import { flag, runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import * as attachments from '@/server/services/attachments';
import * as leave from '@/server/services/leave';

/**
 * Leave Management — REQ-HR-001 Stage HR-2. The service holds every rule:
 * the days counted on the calendar, the balance, who may decide.
 */
const LIST = '/hr/leave';
const record = (requestNo: string) => `${LIST}/${encodeURIComponent(requestNo)}`;

export async function createLeaveRequest(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) =>
    leave.create(tx, ctx, {
      employeeId: text(form, 'employee_id'),
      leaveTypeCode: text(form, 'leave_type_code'),
      fromDate: text(form, 'from_date'),
      toDate: text(form, 'to_date') || text(form, 'from_date'),
      halfDayStart: flag(form, 'half_day_start'),
      halfDayEnd: flag(form, 'half_day_end'),
      reason: text(form, 'reason') || null,
    }),
  );
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.requestNo)}?saved=1`);
}

export async function updateLeaveDraft(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn(
    (tx, ctx) =>
      leave.updateDraft(tx, ctx, text(form, 'id'), {
        leaveTypeCode: text(form, 'leave_type_code'),
        fromDate: text(form, 'from_date'),
        toDate: text(form, 'to_date') || text(form, 'from_date'),
        halfDayStart: flag(form, 'half_day_start'),
        halfDayEnd: flag(form, 'half_day_end'),
        reason: text(form, 'reason') || null,
      }),
    record(requestNo),
  );
}

export async function submitLeave(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => leave.submit(tx, ctx, text(form, 'id')), record(requestNo));
}

export async function approveLeave(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => leave.approve(tx, ctx, text(form, 'id'), text(form, 'note') || null), record(requestNo));
}

export async function refuseLeave(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => leave.refuse(tx, ctx, text(form, 'id'), text(form, 'note')), record(requestNo));
}

export async function cancelLeave(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => leave.cancel(tx, ctx, text(form, 'id'), text(form, 'reason')), record(requestNo));
}

/** A sick note or any paper the request needs, filed on the request (§8). */
export async function attachToLeave(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${record(requestNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  await runAdminAndReturn(async (tx, ctx) => {
    await attachments.upload(tx, ctx, { objectType: leave.PERMISSION_OBJECT, objectId: text(form, 'id'), fileName: upload.name, content });
  }, record(requestNo));
}
