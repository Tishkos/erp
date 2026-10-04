'use server';

import { runAdminAndReturn, text } from './admin-action';
import { wayBack } from './return-path';
import * as recordNotes from './services/record-notes';

/**
 * The one action behind every record's Notes door (2026-10-04).
 *
 * It writes the note through `record-notes.addNote` under the caller's own
 * context and goes back to the page the door is on, with `?saved=1` or the
 * service's sentence in `?error=` — the same round trip every form on a
 * record makes. The page is revalidated by `runAdminAndReturn`, so the new
 * note is on the door when it opens again.
 *
 * The way back is `return-path.wayBack`: the door's own hidden `return_to`,
 * else the request's Referer, always a path on this site.
 */
export async function addRecordNoteAction(formData: FormData): Promise<void> {
  const back = await wayBack(text(formData, 'return_to'));
  await runAdminAndReturn(
    (tx, ctx) =>
      recordNotes.addNote(tx, ctx, {
        object: text(formData, 'object'),
        recordId: text(formData, 'record_id'),
        body: text(formData, 'note'),
      }),
    back,
  );
}
