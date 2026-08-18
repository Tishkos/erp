/**
 * Background job service — Phase 01.10.
 *
 * §24 asks for two things that pull against each other, and this module is
 * where they are reconciled:
 *
 *   "The posting engine emits events after commit so downstream notifications
 *    cannot cause partial financial posting."
 *   — and, implicitly, that the event is not lost if the process dies.
 *
 * `enqueue` writes an outbox row **inside** the caller's transaction, so the
 * event commits with the money or not at all. `dispatch` moves committed rows
 * onto the queue afterwards. A crash between the two leaves the row, so
 * delivery is at-least-once and every handler must be idempotent.
 */
import { and, asc, eq, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  DeadLetterError,
  assertSupportMayRetry,
  hasAttemptsLeft,
  nextRetryDelaySeconds,
  type QueuePolicy,
} from '../domain/jobs';
import { jobOutbox, jobQueue, jobRun } from '../db/schema';
import { db, withScope, type RequestScope, type Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';

export const PERMISSION_OBJECT = 'job';

export class UnknownQueueError extends Error {
  readonly code = 'UNKNOWN_QUEUE';
  constructor(name: string) {
    super(`There is no queue called '${name}'. Register it before enqueuing to it.`);
    this.name = 'UnknownQueueError';
  }
}

export async function policyFor(tx: Tx, queueName: string): Promise<QueuePolicy> {
  const [row] = await tx.select().from(jobQueue).where(eq(jobQueue.name, queueName)).limit(1);
  if (!row || !row.active) throw new UnknownQueueError(queueName);

  return {
    name: row.name,
    ownerRole: row.ownerRole,
    retryLimit: row.retryLimit,
    retryDelaySeconds: row.retryDelaySeconds,
    retryBackoff: row.retryBackoff,
    targetSeconds: row.targetSeconds,
  };
}

// ---------------------------------------------------------------------------
// Enqueue — inside the caller's transaction
// ---------------------------------------------------------------------------

export interface EnqueueInput {
  readonly queueName: string;
  readonly payload: Record<string, unknown>;
  /**
   * The deterministic reference of whatever caused this. Delivery is
   * at-least-once, so a handler uses this to recognise a repeat — the same
   * discipline §24 requires of posting.
   */
  readonly idempotencyKey?: string | null;
  readonly branchCode?: string | null;
}

/**
 * Records that an event is owed.
 *
 * Runs in the caller's transaction, deliberately. A module that posts and then
 * enqueues in two transactions can commit the money and lose the notification;
 * one that enqueues inside a *worker's* transaction can let a failing
 * notification roll back the money. Neither is acceptable, and the outbox is
 * why neither happens.
 */
export async function enqueue(
  tx: Tx,
  actorUserId: string | null,
  input: EnqueueInput,
): Promise<{ outboxId: bigint }> {
  await policyFor(tx, input.queueName);

  const [created] = await tx
    .insert(jobOutbox)
    .values({
      queueName: input.queueName,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: actorUserId,
      branchCode: input.branchCode ?? null,
    })
    .returning({ id: jobOutbox.id });

  return { outboxId: created!.id };
}

// ---------------------------------------------------------------------------
// Dispatch — after commit
// ---------------------------------------------------------------------------

export interface DispatchResult {
  readonly dispatched: number;
  readonly runIds: readonly bigint[];
}

/**
 * Moves committed outbox rows onto the queue.
 *
 * Runs in its own transaction, after the one that wrote the rows has committed
 * — which is what makes the emission "after commit" (§24). It is safe to run
 * concurrently: the outbox rows are locked as they are claimed, so two
 * dispatchers cannot hand the same event over twice.
 */
export async function dispatch(scope: RequestScope, limit = 100): Promise<DispatchResult> {
  return withScope(scope, async (tx) => {
    const claimed = await tx.execute(sql`
      update job_outbox
         set status = 'dispatched', dispatched_at = now()
       where id in (
             select id from job_outbox
              where status = 'pending'
              order by created_at
              limit ${limit}
              for update skip locked
       )
      returning id, queue_name, payload, idempotency_key
    `);

    const rows = claimed.rows as Array<{
      id: string;
      queue_name: string;
      payload: Record<string, unknown>;
      idempotency_key: string | null;
    }>;

    const runIds: bigint[] = [];

    for (const row of rows) {
      const [run] = await tx
        .insert(jobRun)
        .values({
          queueName: row.queue_name,
          outboxId: BigInt(row.id),
          payload: row.payload,
          idempotencyKey: row.idempotency_key,
          status: 'queued',
        })
        .returning({ id: jobRun.id });

      runIds.push(run!.id);
    }

    return { dispatched: rows.length, runIds };
  });
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

export type JobHandler = (payload: Record<string, unknown>) => Promise<void> | void;

const handlers = new Map<string, JobHandler>();

export function registerHandler(queueName: string, handler: JobHandler): void {
  handlers.set(queueName, handler);
}

export function clearHandlers(): void {
  handlers.clear();
}

/**
 * Runs one queued job.
 *
 * A failure is retried per the queue's policy and then dead-lettered. The
 * distinction matters: a retry is a transient fault, a dead letter is a
 * decision that nobody should keep trying, and §25 requires the second to be
 * visible and owned rather than silent.
 */
export async function runNext(
  scope: RequestScope,
  queueName: string,
  now = new Date(),
): Promise<{ ranJobId: bigint | null; outcome: 'completed' | 'failed' | 'dead_letter' | 'idle' }> {
  const claimed = await withScope(scope, async (tx) => {
    const result = await tx.execute(sql`
      update job_run
         set status = 'active', started_at = now(), attempt = attempt + 1
       where id = (
             select id from job_run
              where queue_name = ${queueName}
                and status in ('queued', 'failed')
                and (retry_after is null or retry_after <= ${now})
              order by created_at
              limit 1
              for update skip locked
       )
      returning id, payload, attempt
    `);

    return (result.rows[0] ?? null) as { id: string; payload: Record<string, unknown>; attempt: number } | null;
  });

  if (!claimed) return { ranJobId: null, outcome: 'idle' };

  const jobId = BigInt(claimed.id);
  const handler = handlers.get(queueName);

  try {
    if (!handler) {
      throw new Error(`No handler is registered for queue '${queueName}'.`);
    }
    await handler(claimed.payload);
  } catch (error) {
    const outcome = await recordFailure(scope, jobId, queueName, claimed.attempt, error);
    return { ranJobId: jobId, outcome };
  }

  await withScope(scope, (tx) =>
    tx
      .update(jobRun)
      .set({ status: 'completed', completedAt: new Date(), retryAfter: null })
      .where(eq(jobRun.id, jobId)),
  );

  return { ranJobId: jobId, outcome: 'completed' };
}

async function recordFailure(
  scope: RequestScope,
  jobId: bigint,
  queueName: string,
  attempt: number,
  error: unknown,
): Promise<'failed' | 'dead_letter'> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : 'JOB_FAILED';

  return withScope(scope, async (tx) => {
    const policy = await policyFor(tx, queueName);

    if (hasAttemptsLeft(policy, attempt)) {
      const delay = nextRetryDelaySeconds(policy, attempt);
      await tx
        .update(jobRun)
        .set({
          status: 'failed',
          errorCode: code,
          errorMessage: message,
          retryAfter: new Date(Date.now() + delay * 1000),
        })
        .where(eq(jobRun.id, jobId));

      return 'failed';
    }

    // §25 — a dead letter is visible and owned. The audit record names the
    // role that has to do something about it.
    await tx
      .update(jobRun)
      .set({
        status: 'dead_letter',
        completedAt: new Date(),
        retryAfter: null,
        errorCode: code,
        errorMessage: message,
      })
      .where(eq(jobRun.id, jobId));

    await audit.record(tx, {
      actorUserId: null,
      action: 'job.dead_lettered',
      objectType: PERMISSION_OBJECT,
      objectId: String(jobId),
      branchCode: null,
      after: {
        queue: queueName,
        attempts: attempt,
        owner: policy.ownerRole,
        errorCode: code,
      },
      reason: message,
      outcome: 'failure',
    });

    return 'dead_letter';
  });
}

// ---------------------------------------------------------------------------
// §24 — the "stuck beyond target time" report
// ---------------------------------------------------------------------------

export interface StuckJob {
  readonly id: string;
  readonly queueName: string;
  readonly status: string;
  readonly attempt: number;
  readonly ownerRole: string;
  readonly waitingSeconds: number;
  readonly errorMessage: string | null;
}

/**
 * Every job that has been unfinished for longer than its queue's target.
 *
 * A job retrying quietly and a job nobody ever picked up look identical to the
 * business waiting for the thing to happen, so both appear here.
 */
export async function stuckJobs(tx: Tx, now = new Date()): Promise<StuckJob[]> {
  const result = await tx.execute(sql`
    select r.id::text                                       as "id",
           r.queue_name                                     as "queueName",
           r.status::text                                   as "status",
           r.attempt                                        as "attempt",
           q.owner_role                                     as "ownerRole",
           floor(extract(epoch from (${now} - r.created_at)))::int as "waitingSeconds",
           r.error_message                                  as "errorMessage"
      from job_run r
      join job_queue q on q.name = r.queue_name
     where r.status <> 'completed'
       and extract(epoch from (${now} - r.created_at)) > q.target_seconds
     order by r.created_at
  `);

  return result.rows as unknown as StuckJob[];
}

/** The dead-letter queue, grouped by who has to act on it (§25). */
export async function deadLetters(tx: Tx) {
  return tx
    .select({
      id: jobRun.id,
      queueName: jobRun.queueName,
      attempt: jobRun.attempt,
      errorCode: jobRun.errorCode,
      errorMessage: jobRun.errorMessage,
      completedAt: jobRun.completedAt,
      ownerRole: jobQueue.ownerRole,
      retryableBySupport: jobQueue.retryableBySupport,
    })
    .from(jobRun)
    .innerJoin(jobQueue, eq(jobQueue.name, jobRun.queueName))
    .where(eq(jobRun.status, 'dead_letter'))
    .orderBy(asc(jobRun.completedAt));
}

/**
 * Replays a dead-lettered job — §24: "can be reprocessed", §25: "retry safe
 * jobs but may not edit posted financial data."
 *
 * The payload is replayed verbatim: what makes the difference is that whatever
 * was broken has been fixed, not that someone edited the message. And a queue
 * with a financial effect refuses, because at-least-once delivery means a
 * replay may be a second delivery.
 */
export async function replay(
  tx: Tx,
  ctx: ActorContext,
  jobId: bigint,
): Promise<{ newJobId: bigint }> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: String(jobId),
    requestId: ctx.requestId ?? null,
  });

  const [original] = await tx
    .select({
      id: jobRun.id,
      queueName: jobRun.queueName,
      payload: jobRun.payload,
      idempotencyKey: jobRun.idempotencyKey,
      status: jobRun.status,
      outboxId: jobRun.outboxId,
      retryableBySupport: jobQueue.retryableBySupport,
    })
    .from(jobRun)
    .innerJoin(jobQueue, eq(jobQueue.name, jobRun.queueName))
    .where(eq(jobRun.id, jobId))
    .limit(1);

  if (!original) {
    throw new UnknownQueueError(`job ${jobId}`);
  }

  if (original.status !== 'dead_letter') {
    throw new DeadLetterError(
      original.queueName,
      0,
      'only a dead-lettered job is replayed; this one has not finished failing.',
    );
  }

  assertSupportMayRetry({
    queueName: original.queueName,
    retryableBySupport: original.retryableBySupport,
  });

  const [created] = await tx
    .insert(jobRun)
    .values({
      queueName: original.queueName,
      outboxId: original.outboxId,
      payload: original.payload,
      idempotencyKey: original.idempotencyKey,
      status: 'queued',
      replayedFrom: original.id,
      replayedBy: ctx.principal.userId,
    })
    .returning({ id: jobRun.id });

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'job.replayed',
    objectType: PERMISSION_OBJECT,
    objectId: String(created!.id),
    branchCode: ctx.branchCode,
    before: { deadLetteredJob: String(jobId) },
    after: { queue: original.queueName, newJob: String(created!.id) },
    relatedObjectId: String(jobId),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { newJobId: created!.id };
}

/** Everything still owed but not yet handed over — the outbox's own backlog. */
export async function pendingOutbox(tx: Tx) {
  return tx
    .select()
    .from(jobOutbox)
    .where(eq(jobOutbox.status, 'pending'))
    .orderBy(asc(jobOutbox.createdAt));
}

export { db, and, or, isNull, lt, ne };
