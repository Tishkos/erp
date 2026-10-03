/**
 * The daily health check — REQ-IMPROVE-001 OP-4/OP-7/OP-8.
 *
 *   npx tsx scripts/ops/health-check.ts
 *
 * Asks services/system-health.check the questions a person would ask every
 * morning — is the backup fresh, do the partitions and the fiscal calendar
 * reach ahead, did a job fail, is there disk, is the outbox moving — prints
 * the answers, tells the accounting managers and super users in the
 * application, and exits 1 when something needs doing (2 when it could not
 * run at all). Scheduled by scripts/ops/crontab.erp at 06:40.
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import * as schema from '../../src/server/db/schema';
import * as health from '../../src/server/services/system-health';

const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL_OWNER (or DATABASE_URL) before running this.');
const pool = new Pool({ connectionString: url, max: 2 });

async function main(): Promise<number> {
  const db = drizzle(pool, { schema });
  const { report, notified } = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_super_user', 'true', true)`);
    const report = await health.check(tx);
    const notified = await health.notify(tx, report);
    return { report, notified };
  });
  console.log(`${report.today}: checked ${report.checked.join(', ')}.`);
  if (report.findings.length === 0) {
    console.log('Nothing needs doing.');
    return 0;
  }
  for (const finding of report.findings) console.log(`  ${finding.severity === 'stop' ? '⛔' : '⚠'} [${finding.code}] ${finding.message}`);
  console.log(notified > 0 ? `Told ${notified} person(s) in the application.` : 'Everyone who should know has already been told today.');
  return 1;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(error);
    await pool.end();
    process.exit(2);
  });
