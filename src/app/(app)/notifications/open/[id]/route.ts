import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { registerAllRecords } from '@/server/records';
import { runAdmin } from '@/server/admin-action';
import { requireContext } from '@/server/session';
import * as center from '@/server/services/notification-center';

/**
 * Click on a notification: work out where it leads **now**, for this reader,
 * and send them there — or say it is gone.
 *
 * The address is never stored. It is resolved in the reader's own scope when
 * they click (`notification-center.open`): a record that was removed, moved out
 * of their branch, or whose grant they lost answers "no longer available" and
 * the person lands on the list with that said, rather than on a page that
 * refuses them. Only an opened notification is marked read.
 *
 * A GET with a side effect on the reader's own state, so it ignores anything
 * that is not a person clicking: a prefetch, and a request another site
 * started.
 */
export const dynamic = 'force-dynamic';

const ID = /^\d{1,18}$/;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<never> {
  const { id } = await context.params;
  const list = await headers();
  const prefetch = (list.get('sec-purpose') ?? list.get('purpose') ?? '').includes('prefetch');
  const foreign = list.get('sec-fetch-site') === 'cross-site';
  if (!ID.test(id) || prefetch || foreign) redirect('/notifications');

  // Signed out: the sign-in page, as for every screen. A swallowed redirect inside runAdmin would read as "gone".
  await requireContext();
  registerAllRecords();
  const outcome = await runAdmin((tx, ctx) => center.open(tx, ctx, BigInt(id)));
  if (outcome.ok && outcome.value?.status === 'ok') redirect(outcome.value.href);
  redirect('/notifications?gone=1');
}
