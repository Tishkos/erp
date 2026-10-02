/**
 * The first sign-in on an install that has nobody — REQ-IMPROVE-001 OP-12.
 *
 *   npx tsx scripts/ops/create-first-user.ts you@company.com "Your Name" [BRANCH] [Branch name]
 *
 * A fresh database has roles and a chart of accounts and no people, and every
 * way of adding one is behind a sign-in. `seed-dev.ts` and
 * `ensure-ceo-user.ts` both refuse a live database and both write a password
 * that is published in this repository, which is right for a development box
 * and wrong for the company's own. This is the missing step between the two:
 *
 *   * it runs **only** on an install with no users at all. A second run, on
 *     any database that has anybody, refuses — so it cannot be used to add a
 *     back door to a working system, live marker or not;
 *   * the password is **generated here and printed once**, never chosen by
 *     whoever runs it and never stored anywhere else;
 *   * it is a **temporary** password: `must_change_password` is set, so the
 *     session it produces may reach the password screen and nothing else
 *     (REQ-HARDEN-001 HD2), and it expires 72 hours from now;
 *   * it creates the branch if the install has none, because a user's scope
 *     has to name one.
 *
 * What it grants is deliberate: Super User (so the screens open),
 * `system_administrator` (so settings may be configured),
 * `accounting_manager` (so approvals have a named role to fall to) and `ceo`
 * (the role the WhatsApp bot's questions are gated on, D-WA-3). Change them
 * on the Users screen afterwards; this is a way in, not a permanent shape.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import { setPassword } from '../../src/server/services/authentication';
import { temporaryPassword } from '../../src/server/services/users';

const email = (process.argv[2] ?? '').trim().toLowerCase();
const displayName = (process.argv[3] ?? '').trim();
const branchCode = (process.argv[4] ?? 'HQ').trim().toUpperCase();
const branchName = (process.argv[5] ?? 'Head Office').trim();

if (!email || !email.includes('@') || !displayName) {
  console.error('usage: npx tsx scripts/ops/create-first-user.ts you@company.com "Your Name" [BRANCH] [Branch name]');
  process.exit(1);
}

const ROLES = ['system_administrator', 'accounting_manager', 'ceo'] as const;

async function main(): Promise<void> {
  const id = randomUUID();
  const password = temporaryPassword();

  await db.transaction(async (tx) => {
    // The bootstrap condition, inside the transaction: an install with anybody
    // on it is not bootstrapping, and this script has no business there.
    const existing = await tx.execute(sql`select count(*)::int as n from app_user`);
    const already = (existing.rows[0] as { n: number }).n;
    if (already > 0) {
      throw new Error(
        `this install already has ${already} user(s) — add people on the Users screen, not with this script`,
      );
    }

    // Scope for the rest of the transaction: a super user, so the inserts
    // below are not refused by the policies they are creating the first row of.
    await applyScope(tx, { userId: id, branchCode: '', isSuperUser: true });

    await tx.execute(sql`
      insert into branch (code, name, is_default, active)
      values (${branchCode}, ${branchName}, true, true)
      on conflict (code) do nothing`);

    await tx.execute(sql`
      insert into app_user (id, email, display_name, is_super_user, is_active)
      values (${id}, ${email}, ${displayName}, true, true)`);

    await tx.execute(sql`
      insert into user_branch_scope (user_id, branch_code, is_default)
      values (${id}, ${branchCode}, true)`);

    for (const role of ROLES) {
      await tx.execute(sql`insert into user_role (user_id, role_code) values (${id}, ${role})`);
    }

    // The real hashing path, and `temporary` is what makes the first sign-in
    // a password change rather than a session.
    await setPassword(tx, id, password, { temporary: true });
  });

  console.log('');
  console.log(`  created ${displayName} <${email}>`);
  console.log(`  branch  ${branchCode} — ${branchName} (default)`);
  console.log(`  roles   super user, ${ROLES.join(', ')}`);
  console.log('');
  console.log(`  temporary password:  ${password}`);
  console.log('');
  console.log('  Sign in with it once: the system will refuse to go anywhere');
  console.log('  but the password screen until it is replaced. It expires in');
  console.log('  72 hours, after which this script can be run again only if');
  console.log('  the install still has nobody.');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`refused: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
