/**
 * Migration runner — Phase 00.3.
 *
 * Runs as erp_owner. Drizzle's migrator records applied migrations in
 * drizzle.__drizzle_migrations, so re-running is a no-op rather than an error —
 * that is the Phase 00.3 test gate:
 *
 *   [ ] A clean database migrates to head with no manual step
 *   [ ] A migration applied twice is a no-op, not an error
 *
 * Blueprint §25: "Database schema changes use versioned migrations with
 * rollback or recovery plan and tested backup."
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';

const MIGRATIONS = './src/server/db/migrations';

/**
 * Two lines of history met at 0245 (2026-10-02). The WhatsApp line ran
 * `0245_whatsapp_group_and_actions`, `0246_whatsapp_group_only` and
 * `0247_whatsapp_noah_opus` at the journal times 049–051; the main line ran
 * the Project System's first three stages at the same three times. Drizzle
 * runs only what is later than the last time a database recorded, so a
 * database from the WhatsApp line would pass over PM-1 to PM-3 for ever and
 * fail on PM-4, which builds on them.
 *
 * Before the migrator, each of the three is run where it would be passed
 * over *and* the table it creates is missing — a fact about the database,
 * not about a file's hash (files edited since they ran have other hashes on
 * every database that ran them). Recorded under its own hash and time, as
 * if it had run in its place. A database from the main line has the tables
 * and meets nothing here.
 */
const LINEAGE_REPAIRS: readonly { readonly tag: string; readonly table: string }[] = [
  { tag: '0245_project_system', table: 'project_type' },
  { tag: '0246_project_budget', table: 'project_budget_document' },
  { tag: '0247_project_execution', table: 'project_material_issue' },
];

async function repairLineage(client: PoolClient): Promise<void> {
  const tracked = await client.query(`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if (!tracked.rows[0].present) return;
  const last = await client.query(`select coalesce(max(created_at), 0)::text as last from drizzle.__drizzle_migrations`);
  const lastAt = Number(last.rows[0].last);
  const journal = JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, 'utf8')).entries as { tag: string; when: number }[];
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  for (const repair of LINEAGE_REPAIRS) {
    const index = journal.findIndex((entry) => entry.tag === repair.tag);
    if (index < 0) continue;
    const file = files[index]!;
    if (file.folderMillis > lastAt) continue; // the migrator will run it in its turn
    const exists = await client.query(`select to_regclass($1) is not null as present`, [`public.${repair.table}`]);
    if (exists.rows[0].present) continue;
    await client.query('begin');
    try {
      for (const statement of file.sql) if (statement.trim()) await client.query(statement);
      await client.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`, [file.hash, file.folderMillis]);
      await client.query('commit');
      console.log(`lineage repair: ran ${repair.tag}, which this database had passed over`);
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }
}

/**
 * The other way round (2026-10-03): REQ-HR-001 HR-3 to HR-5 reached main as
 * `0257_hr_payroll`, `0258_hr_advances` and `0259_hr_talent` at journal times
 * …064–…066, earlier than main's own 0256–0260 (…066–…070), so a database
 * that had run those would pass all three over. They are `0262_hr_payroll`,
 * `0263_hr_advances` and `0264_hr_talent` at …072–…074 now. A database that
 * did run them under the old names — one migrated from scratch while the
 * journal held them — has their tables already: there each is recorded under
 * its new hash and time rather than run a second time. A database without the
 * tables meets nothing here and runs them in their turn.
 */
const RENAMED: readonly { readonly tag: string; readonly table: string }[] = [
  { tag: '0262_hr_payroll', table: 'payroll_run' },
  { tag: '0263_hr_advances', table: 'employee_advance' },
  { tag: '0264_hr_talent', table: 'vacancy' },
];

async function recordRenamed(client: PoolClient): Promise<void> {
  const tracked = await client.query(`select to_regclass('drizzle.__drizzle_migrations') is not null as present`);
  if (!tracked.rows[0].present) return;
  const journal = JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, 'utf8')).entries as { tag: string; when: number }[];
  const files = readMigrationFiles({ migrationsFolder: MIGRATIONS });
  const present = async (table: string) => Boolean((await client.query(`select to_regclass($1) is not null as present`, [`public.${table}`])).rows[0].present);
  const states = [];
  for (const renamed of RENAMED) {
    const index = journal.findIndex((entry) => entry.tag === renamed.tag);
    if (index < 0) continue;
    const file = files[index]!;
    // Recorded at its new time already (the hash alone is not enough: the old
    // name ran the same text, so its hash is there under the old time).
    const recorded = Boolean((await client.query(`select 1 from drizzle.__drizzle_migrations where created_at = $1`, [file.folderMillis])).rowCount);
    states.push({ renamed, file, recorded, exists: await present(renamed.table) });
  }
  for (const [i, state] of states.entries()) {
    if (state.recorded) continue;
    if (state.exists) {
      await client.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`, [state.file.hash, state.file.folderMillis]);
      console.log(`lineage repair: ${state.renamed.tag} had already run under its earlier name; recorded, not run again`);
      continue;
    }
    // Missing here, but a later one is recorded now: the migrator, which runs
    // only what is later than the last time recorded, would pass this one
    // over — so it is run here, in its place.
    if (states.slice(i + 1).some((later) => later.exists || later.recorded)) {
      await client.query('begin');
      try {
        for (const statement of state.file.sql) if (statement.trim()) await client.query(statement);
        await client.query(`insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`, [state.file.hash, state.file.folderMillis]);
        await client.query('commit');
        console.log(`lineage repair: ran ${state.renamed.tag}, which its earlier name had not run here`);
      } catch (error) {
        await client.query('rollback');
        throw error;
      }
    }
  }
}

const url = process.argv.includes('--test')
  ? process.env.DATABASE_URL_TEST
  : process.env.DATABASE_URL_OWNER;

if (!url) {
  console.error(
    'No owner connection string. Copy .env.example to .env.\n' +
      'Migrations run as erp_owner, never as the application role (TECHSTACK.md A3).',
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });

try {
  const db = drizzle(pool);
  const started = Date.now();
  const client = await pool.connect();
  try {
    await repairLineage(client);
    await recordRenamed(client);
  } finally {
    client.release();
  }
  await migrate(db, { migrationsFolder: MIGRATIONS });
  console.log(`migrations applied in ${Date.now() - started}ms`);
} catch (error) {
  console.error('migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
