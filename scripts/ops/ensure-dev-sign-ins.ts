/**
 * The sign-ins the end-to-end suite needs, on a development database that
 * carries real books — 2026-10-03.
 *
 * `scripts/seed-dev.ts` makes these accounts, and it makes a whole fixture
 * company around them: items, partners, warehouses, documents. Once a
 * development database has been formatted and a company's own books imported
 * into it, running the seed to get four sign-ins back would write fixture
 * master data over the top of them. This is the same four accounts and nothing
 * else.
 *
 *   npx tsx scripts/ops/ensure-dev-sign-ins.ts
 *
 * Idempotent, and development only, on the terms `ensure-ceo-user.ts` already
 * sets: refused while the live marker exists, refused against a database that
 * is not on this machine, and the password is the one published in this
 * repository — which is right for a development box and the reason both
 * refusals are there.
 *
 * A password that is already set is left alone. These are the suite's
 * accounts, but a person may have been using one.
 */
import { refuseOnLive } from '../lib/live-guard';
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { applyScope, db } from '../../src/server/db/client';
import { setPassword } from '../../src/server/services/authentication';

const PASSWORD = process.env.SEED_PASSWORD ?? 'Ledger-Trial-Balance-7';

/** Exactly what the development seed makes, less the fixture company. */
const PEOPLE = [
  { email: 'officer@example.com', name: 'Accounting Officer', role: 'accounting_officer', superUser: false },
  { email: 'manager@example.com', name: 'Accounting Manager', role: 'accounting_manager', superUser: false },
  { email: 'ceo@example.com', name: 'CEO', role: 'ceo', superUser: false },
  // For reviewing screens, never for testing a denial — the seed says the same.
  { email: 'admin@example.com', name: 'System Administrator', role: null, superUser: true },
] as const;

async function main(): Promise<void> {
  refuseOnLive('create the development sign-ins');

  const url = process.env.DATABASE_URL ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(
      `Refusing to run against a database that is not local: ${url.replace(/:[^:@]*@/, ':***@')}`,
    );
  }

  await db.transaction(async (tx) => {
    // Row-level security is on: a script that writes users says who it is.
    await applyScope(tx, { userId: randomUUID(), branchCode: 'HQ', isSuperUser: true });

    // The branch they are scoped to has to be one this database has.
    const [branch] = (
      await tx.execute(sql`
        SELECT code FROM branch
         ORDER BY (code = 'HQ') DESC, code
         LIMIT 1
      `)
    ).rows as { code: string }[];
    if (!branch) throw new Error('this database has no branches — nothing to scope a user to');

    for (const person of PEOPLE) {
      const [existing] = (
        await tx.execute(sql`SELECT id FROM app_user WHERE lower(email) = lower(${person.email}) LIMIT 1`)
      ).rows as { id: string }[];

      const [row] = (
        await tx.execute(sql`
          INSERT INTO app_user (email, display_name, is_active, is_super_user)
          VALUES (${person.email}, ${person.name}, true, ${person.superUser})
          ON CONFLICT (lower(email)) DO UPDATE
            SET display_name = excluded.display_name,
                is_active = true,
                is_super_user = excluded.is_super_user
          RETURNING id
        `)
      ).rows as { id: string }[];
      const userId = row!.id;

      if (person.role) {
        await tx.execute(sql`
          INSERT INTO user_role (user_id, role_code)
          SELECT ${userId}, ${person.role}
           WHERE EXISTS (SELECT 1 FROM role WHERE code = ${person.role})
          ON CONFLICT DO NOTHING
        `);
      }
      await tx.execute(sql`
        INSERT INTO user_branch_scope (user_id, branch_code, is_default)
        VALUES (${userId}, ${branch.code}, true)
        ON CONFLICT (user_id, branch_code) DO UPDATE SET is_default = true
      `);

      // Only on the first run: a password already set is somebody's, not ours.
      if (!existing) await setPassword(tx, userId, PASSWORD, { temporary: false });
      console.log(`${existing ? 'Updated' : 'Created'} ${person.email}`);
    }

    console.log(`Branch ${branch.code}; password is the development one.`);
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
