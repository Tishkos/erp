/**
 * The nightly period-close check — REQ-IMPROVE-001 IMPROVE-2a (FC-4).
 *
 *   npx tsx scripts/ops/closing-checks.ts            report, notify, exit 1 if blocked
 *   npx tsx scripts/ops/closing-checks.ts --quiet    the same, printing only findings
 *
 * Runs `services/closing-checks.report` for the earliest period not yet
 * closed whose last day has passed — the month the accountant is closing —
 * and, when a blocking check fails, writes one in-app notification to every
 * accounting manager and super user, so the month-end does not begin by
 * discovering what the checklist already knew.
 *
 * Connects as the owner, as the stock-ledger check does: the checks read
 * every branch. Exit status 1 when the close is blocked.
 */
import 'dotenv/config';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/server/db/schema';
import * as closing from '../../src/server/services/closing-checks';
import { businessToday } from '../../src/server/domain/business-date';

const quiet = process.argv.includes('--quiet');
const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL_OWNER (or DATABASE_URL) before running this.');

const pool = new Pool({ connectionString: url, max: 2 });

async function main(): Promise<number> {
  const today = businessToday();
  const db = drizzle(pool, { schema });
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.is_super_user', 'true', true)`);
    const period = await closing.nextToClose(tx, today);
    if (!period) return null;
    const checked = await closing.report(tx, period);
    const { notified } = await closing.notifyFailures(tx, checked, today);
    return { checked, notified };
  });

  if (!result) {
    if (!quiet) console.log(`${today}: every past period is closed. Nothing to check.`);
    return 0;
  }
  const { checked, notified } = result;
  if (checked.mayClose) {
    if (!quiet) console.log(`${today}: ${checked.period.name} may be closed — every blocking check passes${checked.warnings.length ? ` (warnings: ${checked.warnings.join(', ')})` : ''}.`);
    return 0;
  }
  console.log(`${today}: ${checked.period.name} cannot be closed yet:`);
  for (const check of checked.checks.filter((c) => c.state === 'fail')) {
    console.log(`  * ${check.code}: ${check.figure}${check.detail.length ? ` — ${check.detail.slice(0, 5).join('; ')}` : ''}`);
  }
  console.log(notified > 0 ? `Told ${notified} accounting manager(s) / super user(s) in the application.` : 'Everyone who should know has already been told today.');
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
