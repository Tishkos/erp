/**
 * The notification delivery job — REQ-HARDEN-001 F1–F3 (HARDEN-3), delivered
 * with REQ-WA-001 WA-1.
 *
 *   npx tsx scripts/ops/deliver-notifications.ts            one pass
 *   npx tsx scripts/ops/deliver-notifications.ts --loop     every 60 s until stopped
 *
 * Owns the e-mail channel: dispatches the committed outbox onto the queue,
 * runs the queued `notification.deliver` jobs (the in-app rows complete, the
 * e-mail rows are sent through SMTP, the WhatsApp rows are left for the
 * bridge), then sweeps the e-mail channel for anything still due — rows
 * raised before a runner existed, and failed rows whose retry is due
 * (D-HD-4: three attempts, 1 / 10 / 60 minutes apart).
 *
 * With mail unconfigured on the host, e-mail deliveries are marked
 * *suppressed* — a fact about this deployment, not a failure to retry.
 *
 * Exit status 1 when any delivery failed this pass, so the cron wrapper's log
 * and health-check.ts notice.
 */
import 'dotenv/config';
import { pool } from '../../src/server/db/client';
import * as mail from '../../src/server/services/mail';
import * as runner from '../../src/server/services/notification-runner';

const LOOP = process.argv.includes('--loop');

async function pass(): Promise<number> {
  const scope = await runner.systemScope();
  const result = await runner.runOnce(scope, { channels: ['email'] });
  console.log(`[deliver-notifications] ${new Date().toISOString()} ${runner.describe(result)}`);
  const email = result.channels.email;
  return (email && email.failed > 0) || result.jobs.deadLetter > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  if (!mail.isConfigured()) {
    console.log('[deliver-notifications] mail is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS): e-mail deliveries will be marked suppressed.');
  }
  runner.registerEmailSender();
  if (!LOOP) return pass();
  let code = 0;
  for (;;) {
    code = await pass();
    await new Promise((r) => setTimeout(r, 60_000));
  }
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
