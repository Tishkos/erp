/**
 * Drops and rebuilds the local development schema, then re-migrates.
 *
 * Phase 00.3's third gate is "the documented recovery procedure is executed
 * once and succeeds." This is that procedure for local development. The
 * production equivalent is restore-from-backup, exercised in Phase 20.3.
 *
 * Refuses to run against anything that looks like production.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL_OWNER;

if (!url) {
  console.error('DATABASE_URL_OWNER is not set. Copy .env.example to .env.');
  process.exit(1);
}

import { refuseOnLive } from './lib/live-guard';

refuseOnLive('reset the database');
if (process.env.APP_ENV === 'production' || process.env.NODE_ENV === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}

if (!/localhost|127\.0\.0\.1/.test(url)) {
  console.error(
    'Refusing to reset a non-local database.\n' +
      'This script drops the schema. Production recovery is restore-from-backup (Phase 20.3).',
  );
  process.exit(1);
}

const pool = new Pool({ connectionString: url, max: 1 });

try {
  // Ledger tables carry BEFORE DELETE triggers that reject mutation (A2).
  // DROP SCHEMA removes the tables and their triggers together, which is why
  // recovery is a rebuild rather than a delete.
  await pool.query('drop schema public cascade');
  await pool.query('create schema public');
  await pool.query('grant usage on schema public to erp_app');
  await pool.query('revoke create on schema public from public');
  await pool.query('drop schema if exists drizzle cascade');
  console.log('schema dropped and recreated — run `npm run db:migrate` next');
} catch (error) {
  console.error('reset failed:', error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
