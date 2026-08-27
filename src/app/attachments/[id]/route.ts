import { NextResponse } from 'next/server';
import { registerAllRecords } from '@/server/records';
import { requireContext, withCurrentUser } from '@/server/session';
import * as attachments from '@/server/services/attachments';

/**
 * Downloading one attachment — §21.
 *
 * Deliberately outside the application shell: this returns a file, not a
 * page. Every check that matters is the service's, and it runs on each fetch
 * rather than once when the record was opened — knowing an id is not
 * permission to read what it points at, and a refusal is recorded.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  registerAllRecords();
  const { id } = await params;
  const context = await requireContext();

  try {
    const file = await withCurrentUser((tx) =>
      attachments.download(tx, { principal: context.principal, branchCode: context.scope.branchCode }, id),
    );

    return new NextResponse(new Uint8Array(file.content), {
      headers: {
        'Content-Type': file.contentType,
        // `attachment` rather than `inline`: the browser is not asked to
        // render somebody else's file in our origin.
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        'Content-Length': String(file.content.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    // One answer for "no such file" and "not yours": the difference is itself
    // information about records this person cannot see.
    return new NextResponse(null, { status: 404 });
  }
}
