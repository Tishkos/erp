/**
 * The demo's one account: `admin` / `admin` (domain/demo.ts; 2026-10-16, by
 * direction: "a demo version, logins with admin and admin").
 *
 *   npx tsx scripts/ops/demo-admin.ts          # run by scripts/ops/demo-instance.sh, in the demo's environment
 *
 * `create-first-user.ts` makes the account (Super User and the administrator's
 * roles, the branch) with a temporary password; this sets the password the demo
 * publishes on its sign-in card, which no password policy would accept — that is
 * why it is written here, by hash, and only here:
 *
 *   * it refuses unless the process is the demo (`ERP_DEMO=on`) and the database
 *     it is connected to is not the live books — the same rule as the
 *     application's demo mode, asked of the database itself;
 *   * it touches the one account `admin@demo.qs-groups.com` and nothing else;
 *   * it seats the account in Finance as its manager, so journal entries can be
 *     raised (`new-company-setup.sh` seats `admin@qs-groups.com`, who is not here);
 *   * it writes one audit row.
 *
 * Idempotent: a second run sets the same password again.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { DEMO_DOMAIN, LIVE_DATABASE, databaseNameOf, demoEnabled } from '../../src/server/domain/demo';
import { hashPassword } from '../../src/server/auth';

const EMAIL = `admin@${DEMO_DOMAIN}`;
const PASSWORD = 'admin';

async function main(): Promise<void> {
  if (!demoEnabled(process.env)) {
    console.error('Refusing: this is not the demo (ERP_DEMO=on with a DATABASE_URL that is not the live books).');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL_OWNER ?? '';
  const named = databaseNameOf(url);
  if (!named || named.toLowerCase() === LIVE_DATABASE || named !== databaseNameOf(process.env.DATABASE_URL)) {
    console.error('Refusing: DATABASE_URL_OWNER must name the same database as DATABASE_URL, and not the live books.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    const { rows: [db] } = await client.query<{ name: string }>('select current_database() as name');
    if (!db || db.name.toLowerCase() === LIVE_DATABASE) {
      console.error(`Refusing: connected to ${db?.name ?? 'nothing'}.`);
      process.exit(1);
    }

    await client.query('begin');
    const { rows: [user] } = await client.query<{ id: string; branch: string | null }>(
      `select u.id,
              (select s.branch_code from user_branch_scope s where s.user_id = u.id order by s.is_default desc limit 1) as branch
         from app_user u where lower(u.email) = $1`,
      [EMAIL],
    );
    if (!user) {
      console.error(`No ${EMAIL} on ${db.name}: run create-first-user.ts first.`);
      process.exit(1);
    }

    const hash = await hashPassword(PASSWORD);
    const updated = await client.query(
      `update auth_account set password = $2, updated_at = now() where user_id = $1 and provider_id = 'credential'`,
      [user.id, hash],
    );
    if (updated.rowCount !== 1) throw new Error(`expected one credential for ${EMAIL}, found ${updated.rowCount}`);
    await client.query(
      `update app_user set must_change_password = false, password_changed_at = now(), updated_at = now() where id = $1`,
      [user.id],
    );

    // Finance: journal entries are raised from a finance department.
    await client.query(
      `insert into user_department_scope (user_id, department_code, is_manager)
       select $1::uuid, d.code, true from department d where d.code = 'FIN'
       on conflict (user_id, department_code) do update set is_manager = true`,
      [user.id],
    );
    await client.query(`update department set manager_user_id = $1::uuid where code = 'FIN' and manager_user_id is null`, [user.id]);

    await client.query(
      `insert into audit_event (actor_user_id, action, object_type, object_id, branch_code, after_value, reason, outcome)
       values ($1::uuid, 'app_user.demo_password_set', 'app_user', $1::text, $2, $3::jsonb, $4, 'success')`,
      [
        user.id,
        user.branch,
        JSON.stringify({ temporary: false }),
        'The demo account’s published password, set by scripts/ops/demo-admin.ts',
      ],
    );
    await client.query('commit');
    console.log(`${EMAIL} on ${db.name}: password set to the demo's, not temporary; Finance manager.`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
