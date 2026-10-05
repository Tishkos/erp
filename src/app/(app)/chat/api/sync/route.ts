import { z } from 'zod';
import { registerAllRecords } from '@/server/records';
import { runChatApi, sameOrigin } from '@/server/chat-api';
import * as chatRead from '@/server/services/chat-read';

/**
 * The chat's one poll — what the header badge and the chat screen ask every
 * few seconds (`domain/chat.pollIntervalMs`).
 *
 * The body carries the page's acknowledgements in (what reached the browser,
 * what was read on screen, whether the person is typing) and the answer
 * carries the list, the open thread when it moved, and who is typing. The
 * work is `chat-read.sync`, in the asker's own scope; this file only checks
 * who is asking and what shape they sent. No cache, no push: a poll.
 */
export const dynamic = 'force-dynamic';

const id = z.string().uuid();

const Body = z.object({
  open: id.nullable(),
  visible: z.boolean(),
  active: z.boolean(),
  revs: z.record(id, z.number().int().nonnegative()).default({}),
  ack: z.record(id, z.number().int().nonnegative()).default({}),
  seen: z.object({ id, upTo: z.number().int().nonnegative() }).nullish(),
  typing: z.boolean().nullish(),
  limit: z.number().int().min(1).max(200).optional(),
});

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  if (!(await sameOrigin())) return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE });
  }
  registerAllRecords();
  try {
    const outcome = await runChatApi((tx, ctx) =>
      chatRead.sync(tx, ctx, {
        open: parsed.open,
        visible: parsed.visible,
        active: parsed.active,
        revs: parsed.revs,
        ack: parsed.ack,
        seen: parsed.seen ?? null,
        typing: parsed.typing ?? null,
        limit: parsed.limit,
      }),
    );
    if (outcome.status === 'signed_out') return Response.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
    if (outcome.status === 'restricted') return Response.json({ error: 'restricted' }, { status: 403, headers: NO_STORE });
    return Response.json(outcome.value, { headers: NO_STORE });
  } catch (error) {
    // Not enough chat for this person (no grant), or the database is away: the page backs off and tries again.
    const refused = error instanceof Error && error.name === 'ChatError';
    return Response.json({ error: refused ? 'refused' : 'unavailable' }, { status: refused ? 403 : 503, headers: NO_STORE });
  }
}
