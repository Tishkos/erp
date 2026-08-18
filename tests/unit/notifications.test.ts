/**
 * Phase 01.9 test gate — rules, dedupe keys, escalation timing and the §21
 * boundary between a notification and an approval.
 */
import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_CHANNELS,
  NotificationRuleError,
  approvalRequirementAfterDelivery,
  assertRule,
  dedupeKeyFor,
  isEscalationDue,
  renderNotification,
  type NotificationRule,
} from '@domain/notifications';

const rule = (overrides: Partial<NotificationRule> = {}): NotificationRule => ({
  code: 'journal_awaiting_approval',
  eventType: 'journal_entry.submitted',
  channels: ['in_app', 'email'],
  recipientRole: 'accounting_manager',
  escalateAfterSeconds: 86_400,
  escalateToRole: 'accounting_manager',
  active: true,
  ...overrides,
});

describe('§21 · rules', () => {
  it('delivers on the two channels the blueprint names', () => {
    expect(NOTIFICATION_CHANNELS).toEqual(['in_app', 'email']);
  });

  it('accepts a well-formed rule', () => {
    expect(() => assertRule(rule())).not.toThrow();
  });

  it('refuses a rule with no channel', () => {
    // It would generate a notification nobody receives, which looks like
    // working software and is not.
    expect(() => assertRule(rule({ channels: [] }))).toThrow(NotificationRuleError);
  });

  it('refuses an escalation with nowhere to go', () => {
    expect(() => assertRule(rule({ escalateToRole: null }))).toThrow(
      /names nobody to escalate to/,
    );
  });

  it('accepts a rule that does not escalate — information is not a task', () => {
    expect(() =>
      assertRule(rule({ escalateAfterSeconds: null, escalateToRole: null })),
    ).not.toThrow();
  });

  it('refuses an escalation interval of zero or less', () => {
    expect(() => assertRule(rule({ escalateAfterSeconds: 0 }))).toThrow(NotificationRuleError);
  });
});

describe('§21 · duplicate suppression', () => {
  const event = {
    eventType: 'journal_entry.submitted',
    objectType: 'journal_entry',
    objectId: 'je-1',
    occurrence: '1',
  };

  it('produces the same key for the same event, so a retry is recognised', () => {
    // At-least-once job delivery makes a repeat normal, not exceptional.
    expect(dedupeKeyFor(rule(), event, 'user-1')).toBe(dedupeKeyFor(rule(), event, 'user-1'));
  });

  it('produces a different key per recipient', () => {
    expect(dedupeKeyFor(rule(), event, 'user-1')).not.toBe(
      dedupeKeyFor(rule(), event, 'user-2'),
    );
  });

  it('produces a different key for a genuinely different occurrence', () => {
    // A journal submitted, rejected and submitted again is two tasks, not one.
    expect(dedupeKeyFor(rule(), { ...event, occurrence: '2' }, 'user-1')).not.toBe(
      dedupeKeyFor(rule(), event, 'user-1'),
    );
  });

  it('produces a different key per rule', () => {
    expect(dedupeKeyFor({ code: 'other_rule' }, event, 'user-1')).not.toBe(
      dedupeKeyFor(rule(), event, 'user-1'),
    );
  });
});

describe('§21 · escalation when a task is not acted upon', () => {
  const createdAt = new Date('2026-08-16T12:00:00Z');
  const state = (overrides: Partial<Parameters<typeof isEscalationDue>[1]> = {}) => ({
    createdAt,
    actedAt: null,
    escalatedAt: null,
    ...overrides,
  });

  it('is due once the interval has elapsed', () => {
    const justAfter = new Date('2026-08-17T12:00:01Z');
    expect(isEscalationDue(rule(), state(), justAfter)).toBe(true);
  });

  it('is not due before it', () => {
    const justBefore = new Date('2026-08-17T11:59:59Z');
    expect(isEscalationDue(rule(), state(), justBefore)).toBe(false);
  });

  it('stops when the task is acted upon, not when it is read', () => {
    // Someone opening an e-mail and doing nothing is exactly the case
    // escalation exists for.
    const later = new Date('2026-08-20T12:00:00Z');
    expect(
      isEscalationDue(rule(), state({ actedAt: new Date('2026-08-16T13:00:00Z') }), later),
    ).toBe(false);
  });

  it('does not escalate twice', () => {
    const later = new Date('2026-08-20T12:00:00Z');
    expect(
      isEscalationDue(rule(), state({ escalatedAt: new Date('2026-08-17T12:00:00Z') }), later),
    ).toBe(false);
  });

  it('never escalates a rule that does not escalate', () => {
    const muchLater = new Date('2027-01-01T00:00:00Z');
    expect(isEscalationDue(rule({ escalateAfterSeconds: null }), state(), muchLater)).toBe(false);
  });
});

describe('§21 · a notification is not an approval', () => {
  it('leaves the approval requirement unchanged, whatever happened to delivery', () => {
    // "A missed e-mail must never change the underlying approval requirement."
    const requirement = { approvalRequired: true, approverRole: 'accounting_manager' };

    for (const outcome of ['pending', 'sent', 'failed', 'suppressed', 'not_attempted'] as const) {
      expect(approvalRequirementAfterDelivery(requirement, outcome)).toBe(requirement);
    }
  });

  it('says so in the message the recipient reads', () => {
    const { body } = renderNotification({
      eventType: 'journal_entry.submitted',
      objectType: 'journal_entry',
      objectId: 'je-1',
    });

    expect(body).toMatch(/The approval itself is recorded on the document/);
  });
});

describe('the rendered message', () => {
  it('names the event and the document', () => {
    const { subject, body } = renderNotification(
      { eventType: 'journal_entry.submitted', objectType: 'journal_entry', objectId: 'je-1' },
      { reference: 'JE-2026-000001', amountIqd: '1000.0000' },
    );

    expect(subject).toBe('Journal entry submitted — JE-2026-000001');
    expect(body).toContain('JE-2026-000001');
    expect(body).toContain('Amount Iqd: 1000.0000');
  });

  it('falls back to the object id when there is no friendlier reference', () => {
    const { subject } = renderNotification({
      eventType: 'chart_of_account.submitted',
      objectType: 'chart_of_account',
      objectId: 'acc-99',
    });

    expect(subject).toContain('acc-99');
  });

  it('omits empty context rather than printing blanks', () => {
    const { body } = renderNotification(
      { eventType: 'x.y', objectType: 'x', objectId: '1' },
      { present: 'yes', absent: null, missing: undefined },
    );

    expect(body).toContain('Present: yes');
    expect(body).not.toContain('Absent');
    expect(body).not.toContain('Missing');
  });
});
