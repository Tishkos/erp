/**
 * Background jobs — Phase 01.10.
 *
 * Three tables, each answering one of §24's and §25's requirements:
 *
 *   job_queue    the policy: who owns it, how it retries, when it is late
 *   job_outbox   the transactional handoff — written with the posting, sent after
 *   job_run      what actually happened, including the dead letter
 *
 * pg-boss remains the runner (TECHSTACK B1). What it does not give us is an
 * *owned* dead letter, a target time per queue, or a record support can read
 * without being able to edit posted data — and those are the parts §24 and §25
 * actually ask for.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { JOB_OUTBOX_STATUSES, JOB_RUN_STATUSES } from '../../domain/jobs';
import { appUser } from './platform';

export const jobOutboxStatus = pgEnum('job_outbox_status', JOB_OUTBOX_STATUSES);
export const jobRunStatus = pgEnum('job_run_status', JOB_RUN_STATUSES);

/**
 * The queue registry.
 *
 * §25 requires failures to be "visible, owned and replayable". Ownership is a
 * column because an unowned dead-letter queue is a list nobody reads.
 */
export const jobQueue = pgTable(
  'job_queue',
  {
    name: text('name').primaryKey(),
    description: text('description'),

    /** The role alerted when a job on this queue dies. */
    ownerRole: text('owner_role').notNull(),

    retryLimit: integer('retry_limit').notNull().default(3),
    retryDelaySeconds: integer('retry_delay_seconds').notNull().default(30),
    retryBackoff: boolean('retry_backoff').notNull().default(true),

    /** §24 — beyond this, a job appears on the "stuck" report. */
    targetSeconds: integer('target_seconds').notNull().default(300),

    /**
     * §25 — "Support tools may inspect status and retry safe jobs but may not
     * edit posted financial data."
     *
     * Delivery is at-least-once, so a replay may be a second delivery. A queue
     * with a financial effect declares itself unsafe to replay, and support is
     * refused rather than trusted to remember.
     */
    retryableBySupport: boolean('retryable_by_support').notNull().default(false),

    active: boolean('active').notNull().default(true),
  },
  (t) => [
    check('job_queue_retry_limit_range', sql`${t.retryLimit} between 0 and 20`),
    check('job_queue_target_positive', sql`${t.targetSeconds} > 0`),
    check('job_queue_owner_present', sql`btrim(${t.ownerRole}) <> ''`),
  ],
);

/**
 * §24's transactional handoff.
 *
 * A row is written **inside** the transaction that caused it, so it commits
 * with the posting or not at all. The dispatcher hands committed rows to the
 * queue afterwards — which is what makes the emission "after commit" while
 * still making it impossible to lose.
 */
export const jobOutbox = pgTable(
  'job_outbox',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    queueName: text('queue_name')
      .notNull()
      .references(() => jobQueue.name),

    payload: jsonb('payload').notNull(),

    /**
     * The deterministic reference of whatever caused this. Delivery is
     * at-least-once, so a handler uses this to recognise a repeat — the same
     * discipline §24 requires of posting.
     */
    idempotencyKey: text('idempotency_key'),

    status: jobOutboxStatus('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    /** Set when the dispatcher gave up: the payload is unroutable. */
    abandonedReason: text('abandoned_reason'),

    createdBy: uuid('created_by').references(() => appUser.id),
    branchCode: text('branch_code'),
  },
  (t) => [
    // The dispatcher's own query: everything still waiting, oldest first.
    index('job_outbox_pending_idx').on(t.createdAt).where(sql`${t.status} = 'pending'`),
    index('job_outbox_key_idx').on(t.idempotencyKey),
    check(
      'job_outbox_dispatched_at_matches',
      sql`(${t.status} = 'dispatched') = (${t.dispatchedAt} is not null)`,
    ),
  ],
);

/**
 * What happened when the job ran.
 *
 * Append-only in effect: a run is completed or it fails, and a failure is
 * recorded rather than cleared. §25 wants support to be able to *inspect*
 * status; that is only useful if the history is still there.
 */
export const jobRun = pgTable(
  'job_run',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    queueName: text('queue_name')
      .notNull()
      .references(() => jobQueue.name),
    outboxId: bigint('outbox_id', { mode: 'bigint' }).references(() => jobOutbox.id),

    payload: jsonb('payload').notNull(),
    idempotencyKey: text('idempotency_key'),

    status: jobRunStatus('status').notNull().default('queued'),
    attempt: integer('attempt').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** When the next attempt is due. Null when there will not be one. */
    retryAfter: timestamp('retry_after', { withTimezone: true }),

    errorCode: text('error_code'),
    errorMessage: text('error_message'),

    /** Set when the run was a replay of a dead-lettered job, and by whom. */
    replayedFrom: bigint('replayed_from', { mode: 'bigint' }),
    replayedBy: uuid('replayed_by').references(() => appUser.id),
  },
  (t) => [
    index('job_run_queue_status_idx').on(t.queueName, t.status, t.createdAt),
    index('job_run_open_idx').on(t.createdAt).where(sql`${t.status} <> 'completed'`),
    index('job_run_key_idx').on(t.idempotencyKey),
    check('job_run_attempt_non_negative', sql`${t.attempt} >= 0`),
    check(
      'job_run_completed_at_matches',
      sql`(${t.status} in ('completed','dead_letter')) = (${t.completedAt} is not null)`,
    ),
    // A failure says why, and a job that has never run has nothing to say.
    // In between, a retrying job keeps the error that caused the retry — that
    // is the reason it is running again, not stale data to be cleared.
    check(
      'job_run_error_matches_status',
      sql`case
            when ${t.status} in ('failed','dead_letter') then ${t.errorMessage} is not null
            when ${t.status} = 'queued'                  then ${t.errorMessage} is null
            else true
          end`,
    ),
  ],
);
