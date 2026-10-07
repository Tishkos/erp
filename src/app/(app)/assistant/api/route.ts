import { z } from 'zod';
import { sameOrigin } from '@/server/chat-api';
import { optionalContext } from '@/server/session';
import * as assistant from '@/server/services/assistant';

/**
 * The AI dock's one route (2026-10-07): a question to Noah as the signed-in
 * person, or the Yes / No to what he proposed. A route, not a page: a visitor
 * with no session gets a 401 for the panel to show, never a redirect.
 *
 * `history` is the panel's own conversation, oldest first — the browser keeps
 * it, the server keeps nothing between questions. A picture pasted into the
 * panel goes with the question as the group's pictures do.
 */
export const dynamic = 'force-dynamic';
// A question may walk several tools and take a live picture: the bridge gives its brain four minutes.
export const maxDuration = 300;

const Turn = z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(assistant.QUESTION_MAX * 4) });
const Picture = z.object({
  mediaType: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
  base64: z.string().max(6_000_000),
});
const Body = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ask'),
    text: z.string().min(1).max(assistant.QUESTION_MAX),
    history: z.array(Turn).max(assistant.HISTORY_TURNS * 2).default([]),
    pictures: z.array(Picture).max(2).default([]),
    locale: z.enum(['en', 'ar']).optional(),
  }),
  z.object({ kind: z.literal('yes') }),
  z.object({ kind: z.literal('no') }),
]);

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(request: Request): Promise<Response> {
  if (!(await sameOrigin())) return Response.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
  let parsed: z.infer<typeof Body>;
  try {
    parsed = Body.parse(await request.json());
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400, headers: NO_STORE });
  }
  const context = await optionalContext();
  if (!context) return Response.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
  if (context.restriction) return Response.json({ error: 'restricted' }, { status: 403, headers: NO_STORE });
  const userId = context.principal.userId;

  try {
    if (parsed.kind === 'yes') return Response.json(await assistant.confirm(userId), { headers: NO_STORE });
    if (parsed.kind === 'no') return Response.json(assistant.decline(userId), { headers: NO_STORE });
    const answer = await assistant.ask({
      userId,
      text: parsed.text,
      history: parsed.history,
      pictures: parsed.pictures,
      ...(parsed.locale ? { locale: parsed.locale } : {}),
    });
    return Response.json(answer, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof assistant.AssistantUnavailable) {
      return Response.json({ error: 'unavailable', detail: error.message }, { status: 503, headers: NO_STORE });
    }
    if (error instanceof Error && error.name === 'NotAllowedToAsk') {
      return Response.json({ error: 'refused', detail: error.message }, { status: 403, headers: NO_STORE });
    }
    // The failure is logged by the instrumentation with its digest; the panel gets one line.
    console.error('[assistant] failed', error instanceof Error ? error.message : error);
    return Response.json({ error: 'failed' }, { status: 500, headers: NO_STORE });
  }
}
