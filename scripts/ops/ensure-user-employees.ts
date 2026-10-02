/**
 * Every active user is an employee — REQ-FIX-001 FIX-5 (FX14).
 *
 * From this release a new user is put in the HR register with the account
 * (*Also an employee*, ticked by default). The users made before it are
 * not, and the sponsor asked that they be. This makes one employee for each
 * active user that has none, through `employees.ensureForUsers`: numbered
 * from the branch's EMP series, a dated history (hired the day the account
 * was made), an audit row each, the user linked. Never two: a user already
 * linked is passed over, and the unique index on the link holds a race.
 *
 * Safe on the live database and meant for it — `deploy.sh` runs it after
 * the migrations. Dry run by default (made inside a transaction that is
 * rolled back, so the numbers shown are the ones it would take); --apply
 * commits.
 *
 *   npx tsx scripts/ops/ensure-user-employees.ts [--apply]
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import * as authz from '../../src/server/services/authorization';
import * as employees from '../../src/server/services/employees';

class DryRun extends Error {}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);
  console.log(apply ? 'mode:     apply' : 'mode:     dry run (--apply to commit)');

  try {
    await db.transaction(async (tx) => {
      // Row level security is on, so a script that writes says who it is: a
      // super user, else the first system administrator — whoever may create
      // a user may create the employee behind it (D-FX-9).
      const [row] = (
        await tx.execute(sql`
          SELECT u.id
            FROM app_user u
           WHERE u.is_active
             AND (u.is_super_user OR EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role_code = 'system_administrator'))
           ORDER BY u.is_super_user DESC, u.created_at
           LIMIT 1
        `)
      ).rows as { id: string }[];
      if (!row) throw new Error('No active super user or system administrator to make the employees as.');

      await applyScope(tx, { userId: row.id, branchCode: '' });
      const principal = await authz.loadPrincipal(tx, row.id);
      const outcome = await employees.ensureForUsers(tx, { principal, branchCode: '' });

      for (const made of outcome.made) {
        console.log(`made     ${made.employeeNo.padEnd(16)} ${made.email}${made.departmentAssumed ? `  (department ${made.departmentCode} assumed — HR to confirm)` : ''}`);
      }
      for (const skipped of outcome.skipped) console.log(`skipped  ${skipped.email}: ${skipped.why}`);
      console.log(`${outcome.made.length} made, ${outcome.skipped.length} skipped`);
      if (!apply) throw new DryRun();
    });
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    console.log('dry run — nothing written');
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
