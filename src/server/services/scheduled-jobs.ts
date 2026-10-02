/**
 * Background jobs — REQ-IMPROVE-001 OP-4 / OP-7: what the "Background Jobs"
 * screen shows.
 *
 * Two kinds of job exist and the screen shows both:
 *
 *   * the scheduled ones — the lines of `scripts/ops/crontab.erp`, each run
 *     through `run-job.sh`, which leaves `<name>.last` ("<when> <exit>
 *     <seconds>") in `var/jobs`. The crontab is the one source of the
 *     schedule, so the screen parses the same file cron was installed from
 *     rather than keeping a second list that could disagree with it;
 *   * the transactional outbox (`job_outbox`) and the notification
 *     deliveries — rows written with a posting and handed on afterwards, so
 *     a count of what is still waiting is the health of the hand-off.
 *
 * Read-only. Running a job is a shell matter (`run-job.sh`) and stays one;
 * what a screen can offer is the truth about the last run and where its
 * log is.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { parseCrontab, parseLastRun } from '../domain/scheduled-jobs';
import type { ActorContext } from './chart-of-accounts';
import * as authz from './authorization';

export { parseCrontab, parseLastRun };

function crontabPath(): string | null {
  for (const candidate of ['scripts/ops/crontab.erp', '../scripts/ops/crontab.erp', '../../scripts/ops/crontab.erp']) {
    const path = join(process.cwd(), candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

export const PERMISSION_OBJECT = 'job';

export interface ScheduledJob {
  readonly name: string;
  /** The five cron fields as written. */
  readonly schedule: string;
  readonly timeoutSeconds: number;
  readonly command: string;
  readonly lastRunAt: string | null;
  readonly lastExit: number | null;
  readonly lastSeconds: number | null;
  readonly logPath: string;
  readonly state: 'ok' | 'failed' | 'never';
}

export interface JobsOptions {
  readonly jobStateDir?: string;
  readonly logDir?: string;
  readonly crontab?: string;
}

export async function listScheduled(ctx: ActorContext, options: JobsOptions = {}): Promise<readonly ScheduledJob[]> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const path = options.crontab ?? crontabPath();
  if (!path) return [];
  const stateDir = options.jobStateDir ?? process.env.JOB_STATE_DIR ?? join(process.cwd(), 'var', 'jobs');
  const logDir = options.logDir ?? process.env.JOB_LOG_DIR ?? '/var/log/qs-erp';
  const lastFiles = existsSync(stateDir) ? new Set(readdirSync(stateDir)) : new Set<string>();
  return parseCrontab(readFileSync(path, 'utf8')).map((job) => {
    const file = `${job.name}.last`;
    const last = lastFiles.has(file) ? parseLastRun(readFileSync(join(stateDir, file), 'utf8')) : null;
    return {
      ...job,
      lastRunAt: last?.at ?? null,
      lastExit: last?.exit ?? null,
      lastSeconds: last?.seconds ?? null,
      logPath: join(logDir, `${job.name}.log`),
      state: last === null ? 'never' : last.exit === 0 ? 'ok' : 'failed',
    };
  });
}

export interface OutboxQueue {
  readonly queue: string;
  readonly pending: number;
  readonly dispatched: number;
  readonly abandoned: number;
  readonly oldestPendingAt: string | null;
}

export interface DeliverySummary {
  readonly channel: string;
  readonly status: string;
  readonly count: number;
}

/** The transactional outbox, queue by queue, and the notification deliveries by state. */
export async function outbox(tx: Tx, ctx: ActorContext): Promise<{ queues: readonly OutboxQueue[]; deliveries: readonly DeliverySummary[] }> {
  await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const queues = (await tx.execute(sql`
    select q.name as queue,
           count(*) filter (where o.status = 'pending')::int as pending,
           count(*) filter (where o.status = 'dispatched')::int as dispatched,
           count(*) filter (where o.status = 'abandoned')::int as abandoned,
           min(o.created_at) filter (where o.status = 'pending') as oldest_pending_at
      from job_queue q left join job_outbox o on o.queue_name = q.name
     group by q.name order by q.name`)).rows as {
    queue: string; pending: number; dispatched: number; abandoned: number; oldest_pending_at: Date | string | null;
  }[];
  const deliveries = (await tx.execute(sql`
    select channel, status, count(*)::int as count from notification_delivery group by channel, status order by channel, status`)).rows as unknown as DeliverySummary[];
  return {
    queues: queues.map((q) => ({
      queue: q.queue,
      pending: q.pending,
      dispatched: q.dispatched,
      abandoned: q.abandoned,
      oldestPendingAt: q.oldest_pending_at ? new Date(q.oldest_pending_at).toISOString() : null,
    })),
    deliveries,
  };
}
