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
import { Pool } from 'pg';

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
  await migrate(db, { migrationsFolder: './src/server/db/migrations' });
  console.log(`migrations applied in ${Date.now() - started}ms`);
} catch (error) {
  console.error('migration failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
