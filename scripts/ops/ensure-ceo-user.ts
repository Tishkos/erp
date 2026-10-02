/**
 * Creates the CEO sign-in for a development database — REQ-DASH-001.
 *
 * `scripts/seed-dev.ts` already seeds `ceo@example.com`, but a database that
 * was seeded before the role existed (0206) has the role and nobody holding
 * it, so the CEO's dashboard cannot be looked at. Re-running the whole seed to
 * add one person would rewrite master data somebody has been working in, which
 * is a much bigger hammer than the nail.
 *
 * Idempotent, and development only: it refuses to touch a database that has the
 * live marker set, and it uses the same `setPassword` the seed uses so the
 * credential is hashed rather than written by hand.
 *
 *   npx tsx scripts/ops/ensure-ceo-user.ts
 */
import { refuseOnLive } from '../lib/live-guard';
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import { setPassword } from '../../src/server/services/authentication';

const EMAIL = 'ceo@example.com';
const NAME = 'CEO';
const PASSWORD = process.env.SEED_PASSWORD ?? 'Ledger-Trial-Balance-7';

async function main(): Promise<void> {
  // IM4 — on the live system this would create an active account with a
  // known password: refused while the marker exists, whatever the address.
  refuseOnLive('create the development CEO account');
  const url = process.env.DATABASE_URL ?? '';
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    throw new Error(`Refusing to run against a database that is not local: ${url.replace(/:[^:@]*@/, ':***@')}`);
  }

  // The same scope the development seed opens with: row-level security is on,
  // so a script that writes users has to say who it is.
  await db.transaction(async (tx) => {
    await applyScope(tx, { userId: randomUUID(), branchCode: 'HQ', isSuperUser: true });

    const [existing] = (
      await tx.execute(sql`SELECT id FROM app_user WHERE lower(email) = lower(${EMAIL}) LIMIT 1`)
    ).rows as { id: string }[];

    const [row] = (
      await tx.execute(sql`
        INSERT INTO app_user (email, display_name, is_active)
        VALUES (${EMAIL}, ${NAME}, true)
        ON CONFLICT (lower(email)) DO UPDATE SET display_name = excluded.display_name, is_active = true
        RETURNING id
      `)
    ).rows as { id: string }[];
    const userId = row!.id;

    await tx.execute(sql`
      INSERT INTO user_role (user_id, role_code) VALUES (${userId}, 'ceo') ON CONFLICT DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO user_department_scope (user_id, department_code, is_manager)
      VALUES (${userId}, 'FIN', false)
      ON CONFLICT (user_id, department_code) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO user_branch_scope (user_id, branch_code, is_default)
      VALUES (${userId}, 'HQ', true)
      ON CONFLICT (user_id, branch_code) DO UPDATE SET is_default = true
    `);

    // Only on the first run: a password already set is somebody's, not ours.
    if (!existing) await setPassword(tx, userId, PASSWORD, { temporary: false });

    console.log(`${existing ? 'Updated' : 'Created'} ${EMAIL} with the ceo role, HQ branch.`);
  });
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
