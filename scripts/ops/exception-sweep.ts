/**
 * The Exception Center's sweep — platform phase, Agent 7.
 *
 * Every detector (`services/exception-detectors`) looks, read-only, at the
 * books and the work; the findings are then brought into line with what is
 * stored: new ones raised, the same ones refreshed, ones whose cause has gone
 * resolved by themselves, ones that came back reopened. A new critical or high
 * finding is told, once, to the people who may open it. It repairs nothing and
 * writes to no business table — only `exception`, its history and the sweep's
 * own log.
 *
 * Safe to run twice and from two places at once: one advisory lock serialises
 * the writing step, a finding is identified by detector and subject, and
 * `last_seen_at` never moves backwards. Job delivery is at-least-once (01.10).
 *
 *   npx tsx scripts/ops/exception-sweep.ts
 *
 * Exit 0: every detector ran. Exit 2: the sweep ran but a detector could not —
 * what it covers was left exactly as it was, and the health check reports the
 * job as failed so somebody looks.
 */
import 'dotenv/config';
import * as exceptions from '../../src/server/services/exceptions';

async function main(): Promise<number> {
  const run = await exceptions.sweep({ trigger: 'schedule' });
  const failed = run.detectors.filter((d) => d.error);
  console.log(
    `${run.businessDate}: ${run.found} found — ${run.created} new, ${run.updated} refreshed, ${run.reopened} reopened, ${run.resolved} resolved, ${run.notified} notified.`,
  );
  for (const d of failed) console.error(`  ${d.code} could not run: ${d.error}`);
  return failed.length > 0 ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
