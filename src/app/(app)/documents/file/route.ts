import { registerAllRecords } from '@/server/records';
import { currentClientIp, currentRequestId } from '@/server/request-id';
import { requireContext, withCurrentUser } from '@/server/session';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import * as accounts from '@/server/services/cloud-accounts';
import { CloudAuthError, CloudHttpError, CloudNotFoundError, CloudUnreachableError } from '@/server/services/cloud-client';
import * as files from '@/server/services/cloud-files';
import { CloudPathError } from '@/server/domain/cloud-files';

/**
 * Reading one file of QS Cloud Files through the ERP.
 *
 * The browser never talks to the cloud and never sees the app password: it
 * asks here, and here three things are checked on every fetch — the session,
 * the ERP's own permission (`cloud_files`, and for a linked file the right to
 * open the record it is linked to), and the cloud's answer to the person's
 * own app password. A file the cloud does not show them is "not found", the
 * same answer as a file that does not exist.
 *
 *   ?path=/Folder/file.pdf      a file of the Document Center
 *   ?link=<link id>             the file behind a link on a record
 *   &preview=1                  the cloud's own preview image (only where it has one)
 *
 * Downloads are `attachment`, never rendered in the ERP's origin.
 */
export const dynamic = 'force-dynamic';

const GONE = () => new Response(null, { status: 404 });
const LINK_STEP = () => new Response(null, { status: 303, headers: { Location: '/documents' } });

export async function GET(request: Request) {
  registerAllRecords();
  const context = await requireContext();
  const url = new URL(request.url);
  const path = url.searchParams.get('path');
  const linkId = url.searchParams.get('link');
  const preview = url.searchParams.get('preview') === '1';
  if ((path === null) === (linkId === null)) return GONE();

  const ctx: ActorContext = {
    principal: context.principal,
    branchCode: context.scope.branchCode,
    requestId: await currentRequestId(),
    clientIp: await currentClientIp(),
  };

  try {
    const opened = await withCurrentUser(async (tx) => {
      const session = await accounts.sessionFor(tx, ctx.principal.userId);
      if (session.state !== 'ready') return null;
      const entry = linkId
        ? (await files.entryForLink(tx, ctx, session.client, linkId)).entry
        : await files.entryAt(ctx, session.client, session.settings, path!);
      if (entry.isFolder) throw new CloudNotFoundError('Not found in Cloud Files.', 404);
      if (preview && !(entry.hasPreview && entry.fileId)) throw new CloudNotFoundError('Not found in Cloud Files.', 404);
      await files.recordDownload(tx, ctx, entry, preview ? 'preview' : 'download');
      return { client: session.client, entry };
    });
    if (!opened) return LINK_STEP();

    const { client, entry } = opened;
    const upstream = preview ? await client.preview(entry.fileId!) : await client.get(entry.path);
    const headers = new Headers({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    const length = upstream.headers.get('content-length');
    if (length) headers.set('Content-Length', length);
    if (preview) {
      const type = (upstream.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      headers.set('Content-Type', /^image\/(png|jpeg|gif|webp)$/.test(type) ? type : 'image/png');
      headers.set('Content-Disposition', 'inline');
    } else {
      headers.set('Content-Type', entry.mime && /^[\w.+-]+\/[\w.+-]+$/.test(entry.mime) ? entry.mime : 'application/octet-stream');
      headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(entry.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    }
    return new Response(upstream.body, { headers });
  } catch (error) {
    if (error instanceof CloudAuthError) {
      // The cloud turned the app password away: say so, so the Document Center asks to link again.
      await accounts.noteOutcome(ctx.principal.userId, ctx.branchCode, 'unauthorised').catch(() => undefined);
      return LINK_STEP();
    }
    if (error instanceof CloudUnreachableError) return new Response('Cloud Files cannot be reached right now.', { status: 502 });
    // One answer for "no such file" and "not yours": the difference is itself information.
    if (error instanceof CloudHttpError || error instanceof CloudPathError || error instanceof Error) return GONE();
    throw error;
  }
}
