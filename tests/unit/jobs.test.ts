/**
 * Phase 01.10 test gate — retry policy, the stuck rule and the support limit.
 *
 * Durability, dead-lettering and replay are database facts and are in
 * tests/integration/phase01-jobs.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  QueuePolicyError,
  SupportActionRefusedError,
  assertQueuePolicy,
  assertSupportMayRetry,
  hasAttemptsLeft,
  isStuck,
  nextRetryDelaySeconds,
  type QueuePolicy,
} from '@domain/jobs';

const policy = (overrides: Partial<QueuePolicy> = {}): QueuePolicy => ({
  name: 'notification.deliver',
  ownerRole: 'accounting_manager',
  retryLimit: 3,
  retryDelaySeconds: 30,
  retryBackoff: true,
  targetSeconds: 300,
  ...overrides,
});

describe('§25 · a queue must be owned', () => {
  it('accepts a well-formed policy', () => {
    expect(() => assertQueuePolicy(policy())).not.toThrow();
  });

  it('refuses one with no owner', () => {
    // A dead-letter queue nobody owns is a list nobody reads.
    expect(() => assertQueuePolicy(policy({ ownerRole: '  ' }))).toThrow(QueuePolicyError);
    expect(() => assertQueuePolicy(policy({ ownerRole: '' }))).toThrow(/nobody owns/);
  });

  it('refuses one with no target time', () => {
    // §24's "stuck beyond target time" report needs a target to compare with.
    expect(() => assertQueuePolicy(policy({ targetSeconds: 0 }))).toThrow(/nothing can be reported as stuck/);
  });

  it('bounds the retry limit', () => {
    // Beyond a point a permanent failure is retried until someone notices the
    // load, not the failure.
    expect(() => assertQueuePolicy(policy({ retryLimit: 50 }))).toThrow(/0–20 is the range/);
    expect(() => assertQueuePolicy(policy({ retryLimit: -1 }))).toThrow(QueuePolicyError);
    expect(() => assertQueuePolicy(policy({ retryLimit: 0 }))).not.toThrow();
  });
});

describe('§24 · retry policy', () => {
  it('backs off exponentially', () => {
    // A queue that retries a failing downstream service every second turns one
    // outage into two.
    const p = policy({ retryDelaySeconds: 30, retryBackoff: true });
    expect(nextRetryDelaySeconds(p, 0)).toBe(30);
    expect(nextRetryDelaySeconds(p, 1)).toBe(60);
    expect(nextRetryDelaySeconds(p, 2)).toBe(120);
    expect(nextRetryDelaySeconds(p, 3)).toBe(240);
  });

  it('caps the delay so a later attempt is still within anyone’s patience', () => {
    const p = policy({ retryDelaySeconds: 30, retryBackoff: true });
    expect(nextRetryDelaySeconds(p, 20)).toBe(60 * 60);
  });

  it('uses a fixed delay when backoff is off', () => {
    const p = policy({ retryDelaySeconds: 15, retryBackoff: false });
    expect(nextRetryDelaySeconds(p, 0)).toBe(15);
    expect(nextRetryDelaySeconds(p, 5)).toBe(15);
  });

  it('knows when the attempts are used up', () => {
    // The limit counts retries *after* the first attempt, so three retries
    // means four attempts in total.
    const p = policy({ retryLimit: 3 });
    expect(hasAttemptsLeft(p, 1)).toBe(true);
    expect(hasAttemptsLeft(p, 2)).toBe(true);
    expect(hasAttemptsLeft(p, 3)).toBe(true);
    expect(hasAttemptsLeft(p, 4)).toBe(false);
  });

  it('dead-letters immediately when the queue does not retry', () => {
    expect(hasAttemptsLeft(policy({ retryLimit: 0 }), 1)).toBe(false);
  });
});

describe('§24 · the stuck report', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const job = (overrides: Partial<Parameters<typeof isStuck>[0]> = {}) => ({
    status: 'queued' as const,
    createdAt: new Date('2026-08-17T11:00:00Z'),
    completedAt: null,
    ...overrides,
  });

  it('reports a job that has outlived its target', () => {
    expect(isStuck(job(), policy({ targetSeconds: 300 }), now)).toBe(true);
  });

  it('does not report one still within it', () => {
    expect(isStuck(job(), policy({ targetSeconds: 7200 }), now)).toBe(false);
  });

  it('reports a job that is retrying quietly, not only one nobody picked up', () => {
    // Both look identical to the business waiting for the thing to happen.
    expect(isStuck(job({ status: 'failed' }), policy({ targetSeconds: 300 }), now)).toBe(true);
    expect(isStuck(job({ status: 'active' }), policy({ targetSeconds: 300 }), now)).toBe(true);
  });

  it('never reports a finished job', () => {
    expect(
      isStuck(
        job({ status: 'completed', completedAt: new Date('2026-08-17T11:30:00Z') }),
        policy({ targetSeconds: 60 }),
        now,
      ),
    ).toBe(false);
  });

  it('reports a dead letter — it is finished, but nothing happened', () => {
    expect(isStuck(job({ status: 'dead_letter' }), policy({ targetSeconds: 300 }), now)).toBe(
      true,
    );
  });
});

describe('§25 · what support may replay', () => {
  it('permits a queue that declares itself safe', () => {
    expect(() =>
      assertSupportMayRetry({ queueName: 'notification.deliver', retryableBySupport: true }),
    ).not.toThrow();
  });

  it('refuses one with a financial effect', () => {
    // Delivery is at-least-once, so a replay may be a second delivery — which
    // on a financial event is a second effect.
    expect(() =>
      assertSupportMayRetry({ queueName: 'posting.posted', retryableBySupport: false }),
    ).toThrow(SupportActionRefusedError);
    expect(() =>
      assertSupportMayRetry({ queueName: 'posting.posted', retryableBySupport: false }),
    ).toThrow(/may be a second delivery/);
  });

  it('says what to do instead', () => {
    expect(() =>
      assertSupportMayRetry({ queueName: 'posting.posted', retryableBySupport: false }),
    ).toThrow(/Correct it through the module that raised it/);
  });
});
