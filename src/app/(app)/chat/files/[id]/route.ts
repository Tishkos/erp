import { registerAllRecords } from '@/server/records';
import { runChatApi } from '@/server/chat-api';
import * as chatRead from '@/server/services/chat-read';

/**
 * A file sent in a conversation — opened or downloaded.
 *
 * The same checks as any attachment (`attachments.download`: the grant, the
 * scan, the parent's access check — here, membership of the conversation and
 * a message that was not withdrawn), run again on every fetch; knowing an id
 * is not permission. Pictures and PDFs open in the page (`?inline=1`) with
 * the type the service recorded and `nosniff`; anything else is a download.
 * Every failure is one 404, because the difference between "no such file" and
 * "not yours" is itself information about a conversation this person is not in.
 */
export const dynamic = 'force-dynamic';

/** Types the browser may draw in our origin; everything else is handed over as a download. */
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  registerAllRecords();
  const { id } = await params;
  const wantsInline = new URL(request.url).searchParams.get('inline') === '1';
  try {
    const outcome = await runChatApi((tx, ctx) => chatRead.fileOf(tx, ctx, id));
    if (outcome.status !== 'ok') return new Response(null, { status: 404 });
    const file = outcome.value;
    const inline = wantsInline && INLINE_TYPES.has(file.contentType);
    return new Response(new Uint8Array(file.content), {
      headers: {
        'Content-Type': inline ? file.contentType : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'Content-Length': String(file.content.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // A picture needs nothing from the page; a PDF is drawn by the browser's own viewer, which a sandbox would stop.
        ...(file.contentType === 'application/pdf' ? {} : { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
