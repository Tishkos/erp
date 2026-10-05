/**
 * The Task Center's morning sweep — platform phase, Agent 3.
 *
 * Work that is due soon or overdue is raised once each (`services/task-sweep.ts`):
 * due-soon notices to the assignee, overdue notices to the assignee and the
 * assigner, each only to people who may open the task. It writes notifications
 * and nothing else.
 *
 * Safe to run twice: every notice's dedupe key says what makes it distinct, so a
 * second run raises nothing new. Job delivery is at-least-once (01.10).
 *
 *   npx tsx scripts/ops/task-sweep.ts [YYYY-MM-DD]
 *
 * The date is for backfilling a morning that was missed; without it, today.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import { businessToday } from '../../src/server/domain/business-date';
import * as taskSweep from '../../src/server/services/task-sweep';

async function main(): Promise<void> {
  const asOf = process.argv[2] ?? businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`"${asOf}" is not a date. Use YYYY-MM-DD, or pass nothing for today.`);

  await db.transaction(async (tx) => {
    // Run as the system administrator, as the other sweeps: it reads every branch's tasks and decides who hears.
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
    if (!operator) throw new Error('No active system administrator or super user to run the task sweep as.');

    await applyScope(tx, { userId: operator.id, branchCode: 'HQ', isSuperUser: true });
    const run = await taskSweep.run(tx, asOf);
    console.log(`${run.asOf}: ${run.dueSoon} tasks due soon, ${run.overdue} overdue — ${run.created} notices raised.`);
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
