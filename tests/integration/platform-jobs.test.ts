/**
 * Phase 01.10 — background jobs, against a real PostgreSQL instance.
 *
 * The four gate items are all about survival: a job survives a restart, a
 * failure survives its retries into an owned dead letter, a dead letter
 * survives long enough to be replayed, and support survives contact with the
 * financial queues without being able to touch them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as jobs from '@/server/services/jobs';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { SupportActionRefusedError } from '@domain/jobs';

const BAGHDAD = 'BGW';
const SAFE_QUEUE = 'notification.deliver';
const FINANCIAL_QUEUE = 'posting.posted';

let manager: ActorContext;
let officer: ActorContext;

async function createUser(roleCode: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
    id,
    roleCode,
  ]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  jobs.clearHandlers();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');
});

afterEach(() => {
  jobs.clearHandlers();
});

// ---------------------------------------------------------------------------
describe('§24 · the event commits with the work that caused it', () => {
  it('writes the outbox row inside the caller’s transaction', async () => {
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, {
        queueName: SAFE_QUEUE,
        payload: { message: 'a thing happened' },
        idempotencyKey: 'evt-1',
      }),
    );

    const { rows } = await ownerPool.query(
      `select queue_name, status, idempotency_key from job_outbox`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ queue_name: SAFE_QUEUE, status: 'pending' });
  });

  it('loses the event when the work that caused it rolls back', async () => {
    // This is the half that a post-commit enqueue gets right and a pre-commit
    // one gets wrong: no work, no event.
    await expect(
      withScope(scope(manager), async (tx) => {
        await jobs.enqueue(tx, manager.principal.userId, {
          queueName: SAFE_QUEUE,
          payload: { message: 'never happened' },
        });
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');

    const { rows } = await ownerPool.query(`select count(*)::int as n from job_outbox`);
    expect(rows[0].n).toBe(0);
  });

  it('keeps the event when the process dies before dispatch', async () => {
    // And this is the half a post-commit enqueue gets wrong: the row is still
    // there, so the event is delivered late rather than never.
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, {
        queueName: SAFE_QUEUE,
        payload: { message: 'owed' },
      }),
    );

    // No dispatcher has run. The outbox still owes it.
    const pending = await withScope(scope(manager), (tx) => jobs.pendingOutbox(tx));
    expect(pending).toHaveLength(1);

    const result = await jobs.dispatch(scope(manager));
    expect(result.dispatched).toBe(1);
  });

  it('refuses to enqueue to a queue that does not exist', async () => {
    await expect(
      withScope(scope(manager), (tx) =>
        jobs.enqueue(tx, manager.principal.userId, { queueName: 'nope', payload: {} }),
      ),
    ).rejects.toThrow(jobs.UnknownQueueError);
  });

  it('hands each event over exactly once', async () => {
    for (let i = 0; i < 3; i++) {
      await withScope(scope(manager), (tx) =>
        jobs.enqueue(tx, manager.principal.userId, {
          queueName: SAFE_QUEUE,
          payload: { n: i },
        }),
      );
    }

    const first = await jobs.dispatch(scope(manager));
    const second = await jobs.dispatch(scope(manager));

    expect(first.dispatched).toBe(3);
    expect(second.dispatched).toBe(0);

    const { rows } = await ownerPool.query(`select count(*)::int as n from job_run`);
    expect(rows[0].n).toBe(3);
  });

  it('will not return a dispatched event to the outbox', async () => {
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, { queueName: SAFE_QUEUE, payload: {} }),
    );
    await jobs.dispatch(scope(manager));

    expect(
      await rejection(ownerPool.query(`update job_outbox set status = 'pending'`)),
    ).toMatch(/cannot be returned to the outbox/);
  });
});

// ---------------------------------------------------------------------------
describe('§24 · a job survives a restart', () => {
  it('is still there, and still runs, after the process that queued it is gone', async () => {
    // Nothing is held in memory: the queue is a table. "Restart" here is the
    // handler being registered by a different process than the one that
    // enqueued — which is exactly what a restart looks like from the database.
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, {
        queueName: SAFE_QUEUE,
        payload: { message: 'survives' },
      }),
    );
    await jobs.dispatch(scope(manager));

    jobs.clearHandlers(); // the process that enqueued it has gone

    const seen: unknown[] = [];
    jobs.registerHandler(SAFE_QUEUE, (payload) => {
      seen.push(payload);
    });

    const result = await jobs.runNext(scope(manager), SAFE_QUEUE);
    expect(result.outcome).toBe('completed');
    expect(seen).toEqual([{ message: 'survives' }]);
  });

  it('reports idle when there is nothing to do', async () => {
    jobs.registerHandler(SAFE_QUEUE, () => {});
    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
describe('§24, §25 · retry, dead letter, owner and alert', () => {
  async function queueOneFailingJob() {
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, {
        queueName: SAFE_QUEUE,
        payload: { message: 'will fail' },
      }),
    );
    await jobs.dispatch(scope(manager));

    jobs.registerHandler(SAFE_QUEUE, () => {
      throw new Error('the notification service is unreachable');
    });
  }

  it('retries per policy and then dead-letters', async () => {
    // The seeded policy for this queue retries five times.
    await ownerPool.query(
      `update job_queue set retry_limit = 2, retry_delay_seconds = 0, retry_backoff = false
        where name = $1`,
      [SAFE_QUEUE],
    );
    await queueOneFailingJob();

    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('failed');
    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('failed');
    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('dead_letter');

    const { rows } = await ownerPool.query(
      `select status, attempt, error_message from job_run`,
    );
    expect(rows[0]).toMatchObject({ status: 'dead_letter', attempt: 3 });
    expect(rows[0].error_message).toMatch(/unreachable/);
  });

  it('does not retry before the backoff has elapsed', async () => {
    await ownerPool.query(
      `update job_queue set retry_limit = 5, retry_delay_seconds = 3600 where name = $1`,
      [SAFE_QUEUE],
    );
    await queueOneFailingJob();

    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('failed');
    // An hour away, so the next poll finds nothing rather than hammering it.
    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('idle');
  });

  it('names the owner and raises an alert when a job dies (§25)', async () => {
    await ownerPool.query(
      `update job_queue set retry_limit = 0 where name = $1`,
      [SAFE_QUEUE],
    );
    await queueOneFailingJob();
    await jobs.runNext(scope(manager), SAFE_QUEUE);

    const { rows } = await ownerPool.query(
      `select action, outcome, reason, after_value from audit_event
        where action = 'job.dead_lettered'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('failure');
    expect(rows[0].after_value).toMatchObject({
      queue: SAFE_QUEUE,
      owner: 'accounting_manager',
    });
    expect(rows[0].reason).toMatch(/unreachable/);
  });

  it('lists dead letters with who has to act on them', async () => {
    await ownerPool.query(`update job_queue set retry_limit = 0 where name = $1`, [SAFE_QUEUE]);
    await queueOneFailingJob();
    await jobs.runNext(scope(manager), SAFE_QUEUE);

    const letters = await withScope(scope(manager), (tx) => jobs.deadLetters(tx));
    expect(letters).toHaveLength(1);
    expect(letters[0]).toMatchObject({
      queueName: SAFE_QUEUE,
      ownerRole: 'accounting_manager',
      retryableBySupport: true,
    });
  });

  it('dead-letters a job whose queue has no handler at all', async () => {
    await ownerPool.query(`update job_queue set retry_limit = 0 where name = $1`, [SAFE_QUEUE]);
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, { queueName: SAFE_QUEUE, payload: {} }),
    );
    await jobs.dispatch(scope(manager));

    const result = await jobs.runNext(scope(manager), SAFE_QUEUE);
    expect(result.outcome).toBe('dead_letter');
  });
});

// ---------------------------------------------------------------------------
describe('§24, §25 · replay, and what support may not do', () => {
  async function deadLetterOne(queueName: string) {
    await ownerPool.query(`update job_queue set retry_limit = 0 where name = $1`, [queueName]);
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, {
        queueName,
        payload: { message: 'original payload' },
      }),
    );
    await jobs.dispatch(scope(manager));
    jobs.registerHandler(queueName, () => {
      throw new Error('downstream is down');
    });
    await jobs.runNext(scope(manager), queueName);

    const { rows } = await ownerPool.query(
      `select id from job_run where status = 'dead_letter' and queue_name = $1`,
      [queueName],
    );
    return BigInt(rows[0].id);
  }

  it('replays a dead-lettered job without anyone editing data by hand', async () => {
    const jobId = await deadLetterOne(SAFE_QUEUE);

    const { newJobId } = await withScope(scope(manager), (tx) =>
      jobs.replay(tx, manager, jobId),
    );

    // The payload is replayed verbatim: what changed is that the downstream
    // service was fixed, not the message.
    const { rows } = await ownerPool.query(
      `select payload, status, replayed_from, replayed_by from job_run where id = $1`,
      [newJobId.toString()],
    );
    expect(rows[0].payload).toEqual({ message: 'original payload' });
    expect(rows[0].status).toBe('queued');
    expect(String(rows[0].replayed_from)).toBe(String(jobId));
    expect(rows[0].replayed_by).toBe(manager.principal.userId);

    // And it now succeeds.
    jobs.registerHandler(SAFE_QUEUE, () => {});
    expect((await jobs.runNext(scope(manager), SAFE_QUEUE)).outcome).toBe('completed');
  });

  it('refuses to replay a queue with a financial effect (§25)', async () => {
    // Delivery is at-least-once, so a replay may be a second delivery.
    const jobId = await deadLetterOne(FINANCIAL_QUEUE);

    await expect(
      withScope(scope(manager), (tx) => jobs.replay(tx, manager, jobId)),
    ).rejects.toThrow(SupportActionRefusedError);
  });

  it('refuses a replay from someone without the execute verb', async () => {
    const jobId = await deadLetterOne(SAFE_QUEUE);

    await expect(
      withScope(scope(officer), (tx) => jobs.replay(tx, officer, jobId)),
    ).rejects.toThrow(/Permission denied/);
  });

  it('refuses to replay a job that has not finished failing', async () => {
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, { queueName: SAFE_QUEUE, payload: {} }),
    );
    const { runIds } = await jobs.dispatch(scope(manager));

    await expect(
      withScope(scope(manager), (tx) => jobs.replay(tx, manager, runIds[0]!)),
    ).rejects.toThrow(/has not finished failing/);
  });

  it('will not let a finished run be rewritten (§25)', async () => {
    // Support may inspect status, and may not tidy a failure away.
    const jobId = await deadLetterOne(SAFE_QUEUE);

    expect(
      await rejection(
        ownerPool.query(`update job_run set error_message = 'all fine' where id = $1`, [
          jobId.toString(),
        ]),
      ),
    ).toMatch(/cannot be rewritten/);

    expect(
      await rejection(ownerPool.query(`delete from job_run where id = $1`, [jobId.toString()])),
    ).toMatch(/append-only/i);
  });
});

// ---------------------------------------------------------------------------
describe('§24 · the "stuck beyond target time" report', () => {
  it('reports a job that has outlived its queue’s target', async () => {
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, { queueName: SAFE_QUEUE, payload: {} }),
    );
    await jobs.dispatch(scope(manager));

    // Nothing is stuck yet.
    const now = await withScope(scope(manager), (tx) => jobs.stuckJobs(tx));
    expect(now).toHaveLength(0);

    // The seeded target for this queue is fifteen minutes.
    const later = new Date(Date.now() + 20 * 60 * 1000);
    const stuck = await withScope(scope(manager), (tx) => jobs.stuckJobs(tx, later));

    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ queueName: SAFE_QUEUE, ownerRole: 'accounting_manager' });
    expect(stuck[0]!.waitingSeconds).toBeGreaterThan(900);
  });

  it('does not report a job that finished in time', async () => {
    await withScope(scope(manager), (tx) =>
      jobs.enqueue(tx, manager.principal.userId, { queueName: SAFE_QUEUE, payload: {} }),
    );
    await jobs.dispatch(scope(manager));
    jobs.registerHandler(SAFE_QUEUE, () => {});
    await jobs.runNext(scope(manager), SAFE_QUEUE);

    const later = new Date(Date.now() + 20 * 60 * 1000);
    expect(await withScope(scope(manager), (tx) => jobs.stuckJobs(tx, later))).toHaveLength(0);
  });
});
