/**
 * The automation runner — platform phase, Agent 10.
 *
 *   npx tsx scripts/ops/automation-run.ts             take what is due off the outbox and run the rules (every five minutes)
 *   npx tsx scripts/ops/automation-run.ts --produce   first read today's sweep events (tasks overdue, containers past
 *                                                     their ETA, customer invoices past due), then run (once a morning)
 *   npx tsx scripts/ops/automation-run.ts --produce YYYY-MM-DD   the same for a business day that was missed
 *
 * `--produce` reads through the services that already know the answer
 * (`tasks.owedWithDueDate`, `logistics-views.shipmentTracking`, `open-items.openItems`) and
 * only for an event some enabled rule is listening to; it records one outbox row per record
 * per business day, so running it twice records nothing new. The run that follows acts as
 * each rule's owner (`services/automation-runner.ts`): what a person could not do by hand
 * is not done for them, a failing action is retried and logged, a rule that keeps failing
 * pauses itself and tells the administrators. Nothing here posts, pays or moves stock.
 *
 * Exit 0: every event was handled (a rule that skipped or a retry waiting is not an error).
 * Exit 2: an action failed for good or a producer's payload did not fit its event; the health
 * check reports the job as failed so somebody looks.
 */
import 'dotenv/config';
import { withScope } from '../../src/server/db/client';
import { businessToday } from '../../src/server/domain/business-date';
import * as events from '../../src/server/services/automation-events';
import { runOnce } from '../../src/server/services/automation-runner';
import { systemScope } from '../../src/server/services/notification-runner';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const produce = args.includes('--produce');
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? businessToday();
  let exit = 0;

  if (produce) {
    const scope = await systemScope();
    const results = await withScope(scope, async (tx) => events.produce(tx, await events.operatorPrincipal(tx, scope.userId), date));
    for (const r of results) {
      console.log(`${date} ${r.event}: ${r.listening ? `${r.read} found, ${r.recorded} recorded${r.capped > 0 ? `, ${r.capped} left for the next run (the morning's cap)` : ''}` : 'no enabled rule is listening'}.`);
      if (r.capped > 0) exit = 2;
      for (const problem of r.problems) {
        console.error(`  ${problem}`);
        exit = 2;
      }
    }
  }

  const run = await runOnce();
  console.log(
    `${run.events} events: ${run.runs.done} done, ${run.runs.skipped} skipped, ${run.runs.failed} failed (${run.retrying} to be tried again)` +
      `${run.paused.length > 0 ? `; paused: ${run.paused.join(', ')}` : ''}${run.switchedOff ? '; automation is switched off, nothing was run' : ''}.`,
  );
  return exit;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
