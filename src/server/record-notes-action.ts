'use server';

import { headers } from 'next/headers';
import { runAdminAndReturn, text } from './admin-action';
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
 * The way back is the door's own hidden `return_to` (the page's path and
 * query, read in the browser), else the request's Referer; either way it must
 * be a path on this site (HD6 — never an open redirect), and an earlier
 * `saved`/`error` is dropped so they do not pile up.
 */
export async function addRecordNoteAction(formData: FormData): Promise<void> {
  const back = returnPath(text(formData, 'return_to')) ?? returnPath(await refererPath()) ?? '/';
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

async function refererPath(): Promise<string | null> {
  const list = await headers();
  const referer = list.get('referer');
  if (!referer) return null;
  try {
    const url = new URL(referer);
    const host = list.get('x-forwarded-host') ?? list.get('host');
    if (host && url.host !== host) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
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
