/**
 * The HR morning sweep — REQ-HR-001 Stage HR-2.
 *
 * Contracts ending soon, leave requests waiting for a decision, annual leave
 * that will not carry into the next year: read once a morning, raised once
 * each (`services/hr-sweep.ts`; the limits are rows on HR Settings).
 *
 * Safe to run twice: every notice's dedupe key says what makes it distinct,
 * so a second run raises nothing new. Job delivery is at-least-once (01.10).
 *
 *   npx tsx scripts/ops/hr-sweep.ts [YYYY-MM-DD]
 *
 * The date is for backfilling a morning that was missed; without it, today.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import { businessToday } from '../../src/server/domain/business-date';
import * as authz from '../../src/server/services/authorization';
import * as hrSweep from '../../src/server/services/hr-sweep';

async function main(): Promise<void> {
  const asOf = process.argv[2] ?? businessToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`"${asOf}" is not a date. Use YYYY-MM-DD, or pass nothing for today.`);

  await db.transaction(async (tx) => {
    // Run as the system administrator, as the other sweeps: the sweep reads
    // every branch's people and decides who should hear about each.
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
    if (!operator) throw new Error('No active system administrator or super user to run the HR sweep as.');

    await applyScope(tx, { userId: operator.id, branchCode: 'HQ', isSuperUser: true });
    const principal = await authz.loadPrincipal(tx, operator.id);
    const run = await hrSweep.run(tx, principal, asOf);
    console.log(`${run.asOf}: ${run.contractsExpiring} contracts ending, ${run.leaveWaiting} leave requests waiting, ` + `${run.leaveLapsing} balances lapsing — ${run.created} notices raised.`);
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
