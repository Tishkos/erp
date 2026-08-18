/**
 * Background jobs — Phase 01.10.
 *
 * §24: "Background jobs and scheduler", and the report "Documents stuck in a
 * status beyond target time".
 * §24: "The posting engine emits events after commit so downstream
 * notifications cannot cause partial financial posting."
 * §25: "Support tools may inspect status and retry safe jobs but may not edit
 * posted financial data."
 *
 * ── Why an outbox row rather than a direct enqueue ──────────────────────────
 * The posting engine must not lose an event, and must not let a subscriber roll
 * back a posting. Those pull opposite ways: enqueue *inside* the transaction and
 * a failing subscriber can abort the posting; enqueue *after* it and a crash
 * between commit and enqueue loses the event silently.
 *
 * The outbox resolves it. A row is written inside the posting transaction, so
 * it commits with the money or not at all. A dispatcher then hands committed
 * rows to the queue after the fact. A crash leaves the row, so delivery is
 * at-least-once — which is why every handler must be idempotent, and why that
 * is stated here rather than assumed.
 */

export const JOB_OUTBOX_STATUSES = ['pending', 'dispatched', 'abandoned'] as const;
export type JobOutboxStatus = (typeof JOB_OUTBOX_STATUSES)[number];

export const JOB_RUN_STATUSES = ['queued', 'active', 'completed', 'failed', 'dead_letter'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/**
 * A queue's operating policy.
 *
 * §24 asks for retry with a dead letter; §25 adds that failures must be owned.
 * An unowned dead-letter queue is a list nobody reads.
 */
export interface QueuePolicy {
  readonly name: string;
  /** Who is alerted when a job dies. §25 — failures are "visible, owned". */
  readonly ownerRole: string;
  /**
   * Retries **after** the first attempt, as the name says and as pg-boss reads
   * it. A limit of 2 means three attempts in total; a limit of 0 means the
   * first failure is the last.
   */
  readonly retryLimit: number;
  /** Seconds before the first retry. Doubles each attempt when backoff is on. */
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  /**
   * §24 — "Documents stuck in a status beyond target time." A job still
   * unfinished after this many seconds is reported, whether or not it failed.
   */
  readonly targetSeconds: number;
}

export class QueuePolicyError extends Error {
  readonly code = 'QUEUE_POLICY_INVALID';
  constructor(detail: string) {
    super(`Queue policy is not usable: ${detail}`);
    this.name = 'QueuePolicyError';
  }
}

export function assertQueuePolicy(policy: QueuePolicy): void {
  if (!policy.name.trim()) {
    throw new QueuePolicyError('it has no name');
  }

  if (!policy.ownerRole.trim()) {
    throw new QueuePolicyError(
      `${policy.name} names no owner. A dead-letter queue nobody owns is a list nobody reads (§25).`,
    );
  }

  if (policy.retryLimit < 0 || policy.retryLimit > 20) {
    throw new QueuePolicyError(
      `${policy.name} retries ${policy.retryLimit} times; 0–20 is the range. ` +
        'Beyond that a permanent failure is retried until someone notices the load, not the failure.',
    );
  }

  if (policy.retryDelaySeconds < 0) {
    throw new QueuePolicyError(`${policy.name} has a negative retry delay`);
  }

  if (policy.targetSeconds <= 0) {
    throw new QueuePolicyError(
      `${policy.name} has no target time, so nothing can be reported as stuck (§24).`,
    );
  }
}

/**
 * When the next attempt should run.
 *
 * Exponential backoff by default: a queue that retries a failing downstream
 * service every second turns one outage into two. The delay is capped so a
 * later attempt is not scheduled beyond anyone's patience.
 */
export function nextRetryDelaySeconds(policy: QueuePolicy, attempt: number): number {
  if (!policy.retryBackoff) return policy.retryDelaySeconds;

  const capped = Math.min(attempt, 10);
  return Math.min(policy.retryDelaySeconds * 2 ** capped, 60 * 60);
}

/** `attempt` is how many attempts have been made, the first one included. */
export function hasAttemptsLeft(policy: QueuePolicy, attempt: number): boolean {
  return attempt <= policy.retryLimit;
}

export class DeadLetterError extends Error {
  readonly code = 'JOB_DEAD_LETTERED';
  constructor(
    readonly queueName: string,
    readonly attempts: number,
    readonly reason: string,
  ) {
    super(
      `Job on '${queueName}' failed ${attempts} time(s) and has been moved to the dead-letter queue: ${reason}`,
    );
    this.name = 'DeadLetterError';
  }
}

/**
 * §24 — the "stuck beyond target time" test.
 *
 * A job counts as stuck when it has been unfinished for longer than its queue's
 * target, whether it is retrying quietly or has never been picked up at all.
 * Both look identical to the business waiting for the thing to happen.
 */
export function isStuck(
  job: { status: JobRunStatus; createdAt: Date; completedAt: Date | null },
  policy: QueuePolicy,
  now: Date,
): boolean {
  if (job.status === 'completed') return false;

  const elapsedSeconds = (now.getTime() - job.createdAt.getTime()) / 1000;
  return elapsedSeconds > policy.targetSeconds;
}

/**
 * §25 — "Support tools may inspect status and retry safe jobs but may not edit
 * posted financial data."
 *
 * A queue declares whether support may replay it. Replaying a notification is
 * safe; replaying something that moves money is not, because at-least-once
 * delivery means a replay may be a second delivery.
 */
export interface SupportAction {
  readonly queueName: string;
  readonly retryableBySupport: boolean;
}

export class SupportActionRefusedError extends Error {
  readonly code = 'SUPPORT_ACTION_REFUSED';
  constructor(readonly queueName: string) {
    super(
      `Jobs on '${queueName}' cannot be replayed by support: a replay may be a second delivery, ` +
        'and this queue has a financial effect. Correct it through the module that raised it (§25).',
    );
    this.name = 'SupportActionRefusedError';
  }
}

export function assertSupportMayRetry(action: SupportAction): void {
  if (!action.retryableBySupport) {
    throw new SupportActionRefusedError(action.queueName);
  }
}
