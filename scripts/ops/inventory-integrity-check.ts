/**
 * The nightly stock-ledger check.
 *
 *   npx tsx scripts/ops/inventory-integrity-check.ts            report, notify, exit 1 if unclean
 *   npx tsx scripts/ops/inventory-integrity-check.ts --quiet    the same, printing only findings
 *
 * Runs `services/inventory-integrity.check` — documents without ledger rows,
 * rows without documents, transfers out of balance, layers adrift from the
 * ledger, warehouses below zero — and, when anything is found, writes one
 * in-app notification to every accounting manager and super user. Scheduled
 * by cron on the server (see docs/RUNBOOK-database-recovery.md, "Nightly
 * checks"), so the person who keeps the books is told before they find it by
 * arithmetic (2026-09-27).
 *
 * Connects as the owner: the check reads every branch, and row-level security
 * would otherwise show a branch-scoped app connection only its own rows. The
 * super-user flag is set for the same reason, on this transaction only.
 *
 * Exit status 1 when the ledger is not clean, so a cron mail or a monitor
 * notices even if nobody opens the inbox.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/server/db/schema';
import * as integrity from '../../src/server/services/inventory-integrity';

const quiet = process.argv.includes('--quiet');
const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL_OWNER (or DATABASE_URL) before running this.');

const pool = new Pool({ connectionString: url, max: 2 });

async function main(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const db = drizzle(pool, { schema });

  const { report, notified } = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_super_user', 'true', true)`);
    const report = await integrity.check(tx);
    const { notified } = await integrity.notifyFindings(tx, report, today);
    return { report, notified };
  });

  if (report.clean) {
    if (!quiet) console.log(`${today}: the stock ledger agrees with its documents. Nothing to report.`);
    return 0;
  }

  console.log(`${today}: ${integrity.findingCount(report)} thing(s) to look at in the stock ledger:`);
  for (const line of integrity.describe(report)) console.log(`  * ${line}`);
  console.log(
    notified > 0
      ? `Told ${notified} accounting manager(s) / super user(s) in the application.`
      : 'Everyone who should know has already been told today.',
  );
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
