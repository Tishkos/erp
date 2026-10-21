import { registerAllRecords } from '@/server/records';
import { sameSite } from '@/server/same-site';
import { currentClientIp, currentRequestId } from '@/server/request-id';
import { optionalContext, withCurrentUser } from '@/server/session';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as accounts from '@/server/services/cloud-accounts';
import { CloudAuthError, CloudHttpError, CloudUnreachableError } from '@/server/services/cloud-client';
import * as files from '@/server/services/cloud-files';
import { CloudLinkError, CloudPathError, MAX_UPLOAD_BYTES, openInCloudUrl, parseLinkTarget } from '@/server/domain/cloud-files';

/**
 * Putting one file into Qimah Al-Safinah Cloud Files, as the person.
 *
 * Raw bytes in the body (so a 200 MB file is never held in memory and the
 * browser can report progress), the rest in the query:
 *
 *   ?dir=/Folder         the Document Center folder (default: where it starts)
 *   &name=file.pdf       the file's name
 *   &record=type:id      instead: the record this file belongs to — it goes in
 *                        the record's own folder and is linked to the record
 *
 * "Uploaded" is answered only when the cloud has said 201/204 AND shows the
 * file at the size that was sent (`files.sendToCloud`). The browser must say
 * who it is: the session cookie, the header only this site's own script sets,
 * and an Origin that is this site's.
 */
export const dynamic = 'force-dynamic';

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export async function POST(request: Request) {
  registerAllRecords();
  if (!sameSite(request)) return json(403, { ok: false, code: 'forbidden', error: 'This request did not come from the Document Center.' });
  const context = await optionalContext();
  if (!context) return json(401, { ok: false, code: 'signed_out', error: 'Your session has ended. Sign in again.' });

  const url = new URL(request.url);
  const name = url.searchParams.get('name') ?? '';
  const length = Number(request.headers.get('content-length') ?? '');
  if (!Number.isInteger(length) || length <= 0) return json(411, { ok: false, code: 'refused', error: `${name || 'The file'} was not accepted: it is empty, or its size was not stated.` });
  if (length > MAX_UPLOAD_BYTES) return json(413, { ok: false, code: 'refused', error: `${name} was not accepted: it is larger than ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.` });
  if (!request.body) return json(400, { ok: false, code: 'refused', error: 'There was no file in the request.' });
  const record = url.searchParams.get('record') ? parseLinkTarget(url.searchParams.get('record')) : null;
  if (url.searchParams.get('record') && !record) return json(400, { ok: false, code: 'refused', error: 'That record is not one files can be added to.' });

  const ctx: ActorContext = {
    principal: context.principal,
    branchCode: context.scope.branchCode,
    requestId: await currentRequestId(),
    clientIp: await currentClientIp(),
  };

  try {
    // Look at the first bytes before anything leaves: a program renamed .pdf is refused here.
    const { head, whole } = await files.peek(request.body);
    files.assertUploadAllowed(name, length, head);

    const plan = await withCurrentUser(async (tx) => {
      const session = await accounts.sessionFor(tx, ctx.principal.userId);
      if (session.state === 'not_configured') return { state: session.state } as const;
      if (session.state !== 'ready') return { state: session.state } as const;
      const target = await files.prepareUpload(tx, ctx, session.client, session.settings, {
        directory: url.searchParams.get('dir'),
        record: record ? { type: record.objectType, id: record.objectId } : null,
      });
      return { state: 'ready', session, target } as const;
    });
    if (plan.state !== 'ready') {
      return json(409, {
        ok: false,
        code: plan.state,
        error: plan.state === 'not_configured' ? 'Qimah Al-Safinah Cloud Files is not configured.' : 'Link your Cloud Files account first.',
      });
    }
    const { session, target } = plan;

    const uploaded = await accounts.withCloud(ctx, session.account, () =>
      files.sendToCloud(session.client, session.settings, {
        directory: target.directory,
        fileName: name,
        length,
        mime: request.headers.get('content-type'),
        head,
        body: whole,
      }),
    );
    await withCurrentUser((tx) => files.recordUpload(tx, ctx, session.client, uploaded, target.record));
    return json(201, {
      ok: true,
      name: uploaded.entry.name,
      size: uploaded.entry.size,
      path: uploaded.entry.path,
      openUrl: uploaded.entry.fileId ? openInCloudUrl(session.client.baseUrl, uploaded.entry.fileId) : null,
    });
  } catch (error) {
    if (error instanceof files.UploadRefusedError) return json(422, { ok: false, code: 'refused', error: error.message });
    if (error instanceof CloudLinkError || error instanceof CloudPathError) return json(404, { ok: false, code: 'refused', error: error.message });
    if (error instanceof CloudAuthError) return json(409, { ok: false, code: 'relink', error: 'Cloud Files no longer accepts your account. Link it again.' });
    if (error instanceof CloudUnreachableError) return json(502, { ok: false, code: 'unreachable', error: error.message });
    if (error instanceof CloudHttpError) return json(error.status && error.status >= 400 && error.status < 500 ? 422 : 502, { ok: false, code: 'cloud', error: error.message });
    if (error instanceof Error && error.name === 'PermissionDeniedError') return json(403, { ok: false, code: 'forbidden', error: 'You do not have permission to add files.' });
    return json(500, { ok: false, code: 'failed', error: 'The file was not uploaded.' });
  }
}
