'use server';

import { redirect } from 'next/navigation';
import { runAdminAndReturn, text, withQuery } from './admin-action';
import { registerAllRecords } from './records';
import { wayBack } from './return-path';
import * as attachments from './services/attachments';

/**
 * The one action behind every record's paperclip (2026-10-04) — the
 * Notes door's twin.
 *
 * It files the chosen document against the record (`object`, `record_id`:
 * the audit object type and the id the record's attachments are kept under)
 * through `attachments.upload` under the caller's own context, which asks
 * `create` on `attachment` and the record's own parent-access check
 * (`attachments-runtime.ts`) — so somebody who cannot see the record cannot
 * staple a file to it. Then back to the page the door is on, with `?saved=1`
 * or the refusal in `?error=`, the way back being `return-path.wayBack`.
 */
export async function attachToRecordAction(formData: FormData): Promise<void> {
  const back = await wayBack(text(formData, 'return_to'));
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) redirect(withQuery(back, 'error', 'attachment_missing'));
  const upload = file as File;
  const content = Buffer.from(await upload.arrayBuffer());
  // Where files go and who may read them back — registered before the first upload of a cold process.
  registerAllRecords();
  await runAdminAndReturn(
    (tx, ctx) =>
      attachments.upload(tx, ctx, {
        objectType: text(formData, 'object'),
        objectId: text(formData, 'record_id'),
        fileName: upload.name,
        content,
      }),
    back,
  );
}
