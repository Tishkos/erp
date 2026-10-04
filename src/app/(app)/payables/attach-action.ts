'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text } from '@/server/admin-action';
import { registerAllRecords } from '@/server/records';
import * as attachments from '@/server/services/attachments';

/**
 * The one paperclip behind every purchase-side record — REQ-PAY-001 PAY3
 * (2026-10-04): "every invoice — notes, attachments, audit, print — after
 * the draft is created".
 *
 * The form names the record (`object_type`, `object_id`) and the page to go
 * back to (`return_to`, the door's own `ReturnToField`). Only the purchase
 * documents whose parent-access check is registered in
 * `attachments-runtime.ts` are taken; for each, the attachment service asks
 * the object's `view` grant and row security before it keeps the file, as
 * it does for every parent. The way back must be a path on this site (HD6).
 */
const PURCHASE_OBJECTS = new Set([
  'ap_invoice',
  'purchase_order',
  'goods_receipt',
  'goods_return',
  'supplier_payment',
  'supplier_advance',
  'recurring_contract',
  'supplier_credit_memo',
  'payment_application',
]);

export async function attachToPurchaseRecord(formData: FormData): Promise<void> {
  const back = returnPath(text(formData, 'return_to')) ?? '/payables';
  const objectType = text(formData, 'object_type');
  const objectId = text(formData, 'object_id');
  if (!PURCHASE_OBJECTS.has(objectType)) redirect(`${back}?error=not_found`);
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(`${back}?error=attachment_missing`);
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(
    (tx, ctx) => attachments.upload(tx, ctx, { objectType, objectId, fileName: upload.name, content }),
    back,
  );
}

/** A path on this site, without the outcome of an earlier action; null for anything else. */
function returnPath(requested: string | null): string | null {
  if (!requested || !/^\/(?!\/|\\)[^\s]*$/.test(requested)) return null;
  const [path, query = ''] = requested.split('?', 2) as [string, string?];
  const params = new URLSearchParams(query);
  params.delete('saved');
  params.delete('error');
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}
