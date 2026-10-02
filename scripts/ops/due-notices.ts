/**
 * The morning sweep — what falls due today, soon, or already has.
 *
 * Run by cron beside the inventory integrity check. "Due tomorrow" is not an
 * event anybody fires; it becomes true while nobody is looking, so the state is
 * read once a day and whatever is true that morning is raised.
 *
 * Safe to run twice: the notification's dedupe key carries the day, so a second
 * run within the same day suppresses rather than repeats, and tomorrow's run is
 * a fresh notice because it is a different day. Job delivery is at-least-once
 * (01.10), which makes a repeat the normal case rather than an accident.
 *
 *   npx tsx scripts/ops/due-notices.ts [YYYY-MM-DD]
 *
 * The date is for backfilling a morning that was missed; without it, today.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import * as authz from '../../src/server/services/authorization';
import * as dueNotices from '../../src/server/services/due-notices';
import { businessToday } from '../../src/server/domain/business-date';

async function main(): Promise<void> {
  const asOf = process.argv[2] ?? businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error(`"${asOf}" is not a date. Use YYYY-MM-DD, or pass nothing for today.`);
  }

  await db.transaction(async (tx) => {
    /*
     * Run as the system administrator, deliberately.
     *
     * The sweep is not somebody's action — it reads every open invoice in every
     * branch and decides who should hear about each. Running it as a named
     * accountant would scope it to that person's branches and quietly miss the
     * rest, which is the kind of gap nobody notices until an invoice nobody was
     * told about is a year old.
     */
    const [operator] = (
      await tx.execute(sql`
        select u.id
          from app_user u
          left join user_role r on r.user_id = u.id and r.role_code = 'system_administrator'
         where u.is_active and (u.is_super_user or r.user_id is not null)
         order by u.created_at
         limit 1
      `)
    ).rows as { id: string }[];

    if (!operator) {
      throw new Error(
        'No active system administrator or super user to run the sweep as. Notifications need a ' +
          'reader with sight of every branch — see the note in this file.',
      );
    }

    await applyScope(tx, { userId: operator.id, branchCode: 'HQ', isSuperUser: true });
    const principal = await authz.loadPrincipal(tx, operator.id);

    const run = await dueNotices.raiseDueNotices(tx, principal, asOf);
    console.log(
      `${run.asOf}: ${run.overdue} overdue, ${run.dueToday} due today, ${run.dueSoon} due soon — ` +
        `${run.created} notices raised, ${run.suppressed} already sent today.`,
    );
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
