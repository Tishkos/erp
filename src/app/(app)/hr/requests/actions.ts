'use server';

import { redirect } from 'next/navigation';
import { rowCount, runAdmin, runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';
import * as requests from '@/server/services/employee-requests';

/**
 * Employee Requests — REQ-HR-001 Stage HR-6. The service holds every rule:
 * who decides, the receipts a claim wants, the trip's advance, the letter.
 */
const LIST = '/hr/requests';
const record = (requestNo: string) => `${LIST}/${encodeURIComponent(requestNo)}`;

const headerOf = (form: FormData) => ({
  subject: text(form, 'subject'),
  details: text(form, 'details') || null,
  destination: text(form, 'destination') || null,
  travelFrom: text(form, 'travel_from') || null,
  travelTo: text(form, 'travel_to') || null,
  estimated: text(form, 'estimated') || null,
  letterType: text(form, 'letter_type') || null,
  addressedTo: text(form, 'addressed_to') || null,
  travelRequestNo: text(form, 'travel_request_no') || null,
});

export async function createRequest(form: FormData): Promise<void> {
  const outcome = await runAdmin((tx, ctx) => requests.create(tx, ctx, { employeeId: text(form, 'employee_id'), kind: text(form, 'request_kind'), ...headerOf(form) }));
  if (!outcome.ok) redirect(`${LIST}?error=${encodeURIComponent(outcome.error ?? '')}&new=1`);
  redirect(`${record(outcome.value!.requestNo)}?saved=1`);
}

/** The draft's header and — for a claim — its lines, as the form sends them. */
export async function updateRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  const lines: requests.ClaimLineInput[] = [];
  for (let i = 0; i < rowCount(form, 0, 60); i += 1) {
    lines.push({ spentOn: text(form, `spent_on_${i}`), categoryCode: text(form, `category_${i}`), description: text(form, `description_${i}`), amount: text(form, `amount_${i}`) });
  }
  await runAdminAndReturn((tx, ctx) => requests.updateDraft(tx, ctx, requestNo, { ...headerOf(form), lines }), record(requestNo));
}

export async function submitRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => requests.submit(tx, ctx, requestNo), record(requestNo));
}

export async function approveRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => requests.approve(tx, ctx, requestNo, text(form, 'note') || null), record(requestNo));
}

export async function refuseRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => requests.refuse(tx, ctx, requestNo, text(form, 'note')), record(requestNo));
}

export async function cancelRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => requests.cancel(tx, ctx, requestNo, text(form, 'reason')), record(requestNo));
}

export async function payRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn(
    (tx, ctx) => requests.pay(tx, ctx, requestNo, { bankCashAccountId: text(form, 'account_id') || null, on: text(form, 'paid_on'), reference: text(form, 'reference') || null }),
    record(requestNo),
  );
}

export async function issueLetter(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  await runAdminAndReturn((tx, ctx) => requests.issue(tx, ctx, requestNo, text(form, 'issued_text')), record(requestNo));
}

/** An approved trip's advance — it opens on its own page, to go through its own approvals. */
export async function openTravelAdvance(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  const outcome = await runAdmin((tx, ctx) => requests.openTravelAdvance(tx, ctx, requestNo));
  if (!outcome.ok) redirect(`${record(requestNo)}?error=${encodeURIComponent(outcome.error ?? '')}`);
  redirect(`/hr/advances/${encodeURIComponent(outcome.value!.advanceNo)}?saved=1`);
}

/** A receipt or a paper, filed on the request. */
export async function attachToRequest(form: FormData): Promise<void> {
  const requestNo = text(form, 'request_no');
  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${record(requestNo)}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  registerAllRecords();
  await runAdminAndReturn(async (tx, ctx) => {
    await attachments.upload(tx, ctx, { objectType: requests.PERMISSION_OBJECT, objectId: text(form, 'id'), fileName: upload.name, content });
  }, record(requestNo));
}
