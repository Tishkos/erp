/**
 * Phase 01.4 test gate — the redaction and shape rules.
 *
 * "Every create, update and status transition produces an audit event", the
 * append-only guarantee and the same-transaction guarantee are database
 * properties and are proved in tests/integration/phase01-platform-core.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  AuditReasonRequiredError,
  REDACTED,
  buildAuditEvent,
  fingerprint,
  isRedactedKey,
  redact,
} from '@domain/audit';

describe('§25 · no secret reaches the audit trail', () => {
  it('redacts credential-shaped keys wherever they appear', () => {
    const before = {
      email: 'user@example.com',
      password: 'hunter2',
      passwordHash: '$2b$12$abcdef',
      apiToken: 'tok_live_123',
      nested: { refreshToken: 'r_456', displayName: 'Ali' },
      list: [{ secret: 's' }, { keep: 'this' }],
    };

    const after = redact(before) as Record<string, any>;

    expect(after.email).toBe('user@example.com');
    expect(after.password).toBe(REDACTED);
    expect(after.passwordHash).toBe(REDACTED);
    expect(after.apiToken).toBe(REDACTED);
    expect(after.nested.refreshToken).toBe(REDACTED);
    expect(after.nested.displayName).toBe('Ali');
    expect(after.list[0].secret).toBe(REDACTED);
    expect(after.list[1].keep).toBe('this');
  });

  it('redacts the identity and payment fields §25 calls out for masking', () => {
    for (const key of ['iban', 'swift', 'cardNumber', 'cvv', 'mfaSecret', 'otpCode']) {
      expect(isRedactedKey(key), key).toBe(true);
    }
  });

  it('does not redact ordinary business fields', () => {
    for (const key of ['amountIqd', 'branchCode', 'postingDate', 'supplierName', 'keyAccount']) {
      expect(isRedactedKey(key), key).toBe(false);
    }
  });

  it('truncates rather than serialising an arbitrarily deep object', () => {
    // §21 warns against putting sensitive document contents in the trail. An
    // audit entry records a business change, not an object graph.
    let deep: any = { leaf: 'bottom' };
    for (let i = 0; i < 10; i++) deep = { level: deep };

    expect(JSON.stringify(redact(deep))).toContain('[truncated]');
  });

  it('leaves primitives and nulls alone', () => {
    expect(redact(null)).toBeNull();
    expect(redact('plain')).toBe('plain');
    expect(redact(42)).toBe(42);
  });
});

describe('§5.4 · the event shape', () => {
  const base = {
    actorUserId: 'u-1',
    objectType: 'journal_entry',
    objectId: 'JE-000001',
    outcome: 'success',
  } as const;

  it('carries actor, action, object, outcome and branch', () => {
    const event = buildAuditEvent({ ...base, action: 'journal_entry.posted', branchCode: 'BGW' });

    expect(event.actorUserId).toBe('u-1');
    expect(event.action).toBe('journal_entry.posted');
    expect(event.objectType).toBe('journal_entry');
    expect(event.objectId).toBe('JE-000001');
    expect(event.branchCode).toBe('BGW');
    expect(event.outcome).toBe('success');
  });

  it('records before and after values, redacted', () => {
    const event = buildAuditEvent({
      ...base,
      action: 'user.updated',
      before: { displayName: 'Ali', password: 'old' },
      after: { displayName: 'Ali Hassan', password: 'new' },
    });

    expect(event.beforeValue).toEqual({ displayName: 'Ali', password: REDACTED });
    expect(event.afterValue).toEqual({ displayName: 'Ali Hassan', password: REDACTED });
  });

  it('distinguishes an absent snapshot from an empty one', () => {
    const created = buildAuditEvent({ ...base, action: 'journal_entry.created', after: {} });
    expect(created.beforeValue).toBeNull();
    expect(created.afterValue).toEqual({});
  });

  it('refuses to record a cancellation without a reason', () => {
    // §5.4 requires the reason to be stored with the decision, and §24 makes
    // "Cancelling requires a reason" a status-machine rule. An event that can
    // be written without one makes the rule unenforceable after the fact.
    expect(() =>
      buildAuditEvent({ ...base, action: 'journal_entry.cancelled', outcome: 'success' }),
    ).toThrow(AuditReasonRequiredError);

    expect(() =>
      buildAuditEvent({ ...base, action: 'journal_entry.cancelled', reason: '   ' }),
    ).toThrow(AuditReasonRequiredError);

    const withReason = buildAuditEvent({
      ...base,
      action: 'journal_entry.cancelled',
      reason: 'Duplicate of JE-000004',
    });
    expect(withReason.reason).toBe('Duplicate of JE-000004');
  });

  it('applies the same rule to rejection, reversal, override and deactivation', () => {
    for (const action of [
      'purchase_order.rejected',
      'journal_entry.reversed',
      'period.overridden',
      'user.deactivated',
    ]) {
      expect(() => buildAuditEvent({ ...base, action }), action).toThrow(AuditReasonRequiredError);
    }
  });

  it('stores a session fingerprint, never the session identifier', () => {
    const sessionId = 'sess_9f2c1a77e4b34d0e';
    const event = buildAuditEvent({ ...base, action: 'user.signed_in', sessionId });

    expect(event.sessionId).not.toBe(sessionId);
    expect(event.sessionId).not.toContain(sessionId);
    expect(event.sessionId).toMatch(/^s_[0-9a-f]{16}$/);
  });

  it('fingerprints the same session consistently and different sessions apart', () => {
    expect(fingerprint('sess_a')).toBe(fingerprint('sess_a'));
    expect(fingerprint('sess_a')).not.toBe(fingerprint('sess_b'));
  });

  it('accepts a null actor for a pre-authentication event', () => {
    // A failed sign-in has no actor yet, and it is exactly the event §25
    // requires to be logged.
    const event = buildAuditEvent({
      actorUserId: null,
      action: 'authentication.failed',
      objectType: 'session',
      outcome: 'denied',
    });
    expect(event.actorUserId).toBeNull();
    expect(event.outcome).toBe('denied');
  });
});
