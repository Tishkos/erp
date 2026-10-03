/**
 * A way back in when nobody can sign in — REQ-IMPROVE-001 OP-12.
 *
 *   npx tsx scripts/ops/reset-user-password.ts you@company.com
 *
 * Every way of resetting a password is behind a sign-in, which is fine until
 * the only administrator has forgotten theirs. `create-first-user.ts` is the
 * companion to this and deliberately refuses any install that has users, so it
 * cannot be used as a back door; this is the other half, for an install that
 * has people and no way in.
 *
 * It does exactly what the Users screen's own Reset does —
 * `users.resetPassword`, which mints a temporary password, marks it
 * `must_change_password`, revokes every live session and writes the audit row
 * — and differs only in running as the system operator rather than as somebody
 * who had to log in first.
 *
 * The password is generated here and printed once. It is not stored, not
 * logged and not recoverable: the next sign-in must change it, and the session
 * it produces can reach the password screen and nothing else (HD2).
 *
 * Why this is not a hole: it runs on the server, as a shell user who already
 * has the database password in `.env` and could change any row by hand. What
 * it adds over `psql` is the audit row, the session revocation and the forced
 * change — the things a hand-written UPDATE would miss.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db, withScope } from '../../src/server/db/client';
import { loadPrincipal } from '../../src/server/services/authorization';
import * as users from '../../src/server/services/users';

const email = (process.argv[2] ?? '').trim().toLowerCase();

if (!email || !email.includes('@')) {
  console.error('usage: npx tsx scripts/ops/reset-user-password.ts you@company.com');
  process.exit(1);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);

  // Read the user and an operator to act as, outside any scope: this runs
  // before anybody has signed in, so there is no session to borrow.
  const found = await db.execute(
    sql`select id, email, display_name, is_active from app_user where lower(email) = ${email} limit 1`,
  );
  const row = found.rows[0] as
    | { id: string; email: string; display_name: string; is_active: boolean }
    | undefined;
  if (!row) {
    console.error(`no user with that e-mail. Known accounts:`);
    const all = await db.execute(sql`select email from app_user order by email`);
    for (const other of all.rows) console.error(`  ${(other as { email: string }).email}`);
    process.exit(1);
  }
  if (!row.is_active) {
    console.error(`${row.email} is deactivated. Re-activate it on the Users screen first.`);
    process.exit(1);
  }

  /*
   * Acting as a system administrator who is not the person being reset, where
   * one exists — so the audit row names somebody real rather than the account
   * whose password this is. Falling back to the account itself is honest
   * enough when it is the only administrator left, which is the case this
   * script exists for.
   */
  const admins = await db.execute(sql`
    select u.id
      from app_user u
      join user_role r on r.user_id = u.id
     where u.is_active
       and r.role_code = 'system_administrator'
       and u.id <> ${row.id}
     limit 1
  `);
  const actorId = (admins.rows[0] as { id: string } | undefined)?.id ?? row.id;

  const branch = await db.execute(
    sql`select branch_code from user_branch_scope where user_id = ${actorId} limit 1`,
  );
  const branchCode = (branch.rows[0] as { branch_code: string } | undefined)?.branch_code ?? 'HQ';

  const password = await withScope({ userId: actorId, branchCode, isSuperUser: true }, async (tx) => {
    await applyScope(tx, { userId: actorId, branchCode, isSuperUser: true });
    const principal = await loadPrincipal(tx, actorId);
    return users.resetPassword(tx, { principal, branchCode }, row.id);
  });

  console.log('');
  console.log(`  ${row.display_name} <${row.email}>`);
  console.log(`  temporary password: ${password}`);
  console.log('');
  console.log('  It must be changed at the next sign-in, every session it had has been');
  console.log('  revoked, and it is not written down anywhere else. Copy it now.');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
