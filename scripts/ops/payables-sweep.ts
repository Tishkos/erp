/**
 * The payables sweep — REQ-AP-001 §19.3. Run daily by cron beside due-notices.
 *
 * For every active check with an implemented query, any payable over the
 * limit in force gets one OVER_LIMIT_DETECTED event and one automatic hold
 * with reason PENDING_REASON — "Stopped? YES, reason required" — and never a
 * second for the same condition, so running it twice is safe. It also keeps
 * the status log's partitions a year ahead and escalates unowned holds.
 *
 *   npx tsx scripts/ops/payables-sweep.ts [YYYY-MM-DD]
 *
 * The date is for backfilling a missed morning; without it, today.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db, pool } from '../../src/server/db/client';
import * as sweep from '../../src/server/services/payables-sweep';
import { businessToday } from '../../src/server/domain/business-date';

async function main(): Promise<void> {
  const asOf = process.argv[2] ?? businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new Error(`"${asOf}" is not a date. Use YYYY-MM-DD, or pass nothing for today.`);
  }

  const result = await db.transaction(async (tx) => {
    /*
     * Run as the system, deliberately super-scoped: the sweep reads every
     * branch's payables — a clock scoped to one accountant's branches would
     * quietly miss the rest (the same reasoning as due-notices).
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
      throw new Error('No active system administrator or super user to run the sweep as.');
    }

    await applyScope(tx, { userId: operator.id, branchCode: '', isSuperUser: true });
    return sweep.runSweep(tx, asOf);
  });

  console.log(
    `[payables-sweep] ${result.asOf}: ${result.checked} checks ran, ` +
      `${result.opened} holds opened, ${result.escalated} escalated` +
      (result.skipped.length > 0
        ? ` (inert until their stage lands: ${result.skipped.join(', ')})`
        : ''),
  );
}

main()
  .catch((error) => {
    console.error('[payables-sweep] failed:', error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
