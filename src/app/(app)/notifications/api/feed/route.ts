import { z } from 'zod';
import { runChatApi, sameOrigin } from '@/server/chat-api';
import { BELL_LIMIT, NOTIFICATION_CATEGORIES } from '@/server/domain/notification-center';
import { BUSINESS_TIME_ZONE } from '@/server/domain/business-date';
import * as center from '@/server/services/notification-center';
import * as notifications from '@/server/services/notifications';

/**
 * The bell's poll — what the header asks every half minute, and the list when
 * the popover is open.
 *
 * Always the unread count and the per-category counts (two indexed reads);
 * the list, with where each row leads for this reader, only when the popover
 * is open (`list`). The work is the services' own, in the asker's scope: this
 * file checks who is asking and what shape they sent. No cache, no push.
 */
export const dynamic = 'force-dynamic';

const Body = z.object({
  list: z.boolean().default(false),
  scope: z.enum(['unread', 'all']).default('unread'),
  category: z.enum(NOTIFICATION_CATEGORIES).nullable().default(null),
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
  try {
    const outcome = await runChatApi(async (tx, ctx) => {
      if (!parsed.list) {
        const counts = await notifications.countsFor(tx, ctx.principal.userId);
        return { unread: counts.unread, categories: counts.categories, items: null, zone: BUSINESS_TIME_ZONE };
      }
      const feed = await center.feedFor(tx, ctx, {
        state: parsed.scope,
        category: parsed.category,
        page: 1,
        pageSize: BELL_LIMIT,
      });
      return { unread: feed.unread, categories: feed.categories, items: feed.items, zone: BUSINESS_TIME_ZONE };
    });
    if (outcome.status === 'signed_out') return Response.json({ error: 'signed_out' }, { status: 401, headers: NO_STORE });
    if (outcome.status === 'restricted') return Response.json({ error: 'restricted' }, { status: 403, headers: NO_STORE });
    return Response.json({ ...outcome.value, scope: parsed.scope, category: parsed.category }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: 'unavailable' }, { status: 503, headers: NO_STORE });
  }
}
