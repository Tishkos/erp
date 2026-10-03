/**
 * Notification engine — Phase 01.9.
 *
 * §21: "Notification rules must suppress duplicates, record delivery status and
 * allow escalation if a task is not acted upon."
 *
 * And the sentence that governs the whole design:
 *
 *   §21 — "System notifications are not a substitute for workflow status. A
 *   missed e-mail must never change the underlying approval requirement."
 *
 * ── What that sentence rules out ────────────────────────────────────────────
 * It means notifications may **read** the workflow and may never write to it.
 * Nothing in this module or its service returns a value the approval engine
 * consults, and nothing it fails to do can release a document. The 01.9 gate
 * states the consequence as a test: "Suppressing notifications entirely leaves
 * every approval requirement intact." That passes because there is no path from
 * here to there — not because the paths are careful.
 */

/** §21 — the two channels this release delivers on. */
// REQ-WA-001 — the WhatsApp bridge delivers the third channel (2026-10-02).
export const NOTIFICATION_CHANNELS = ['in_app', 'email', 'whatsapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'suppressed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * A rule: when this event happens, tell these people, on these channels, and
 * chase it after this long.
 */
export interface NotificationRule {
  readonly code: string;
  /** The event that qualifies, e.g. 'journal_entry.submitted'. */
  readonly eventType: string;
  readonly channels: readonly NotificationChannel[];
  /** The role notified. Resolved to people at raise time. */
  readonly recipientRole: string;
  /**
   * §21 — "escalation if a task is not acted upon". Null means no escalation:
   * some notifications are information rather than a task.
   */
  readonly escalateAfterSeconds: number | null;
  readonly escalateToRole: string | null;
  readonly active: boolean;
}

export class NotificationRuleError extends Error {
  readonly code = 'NOTIFICATION_RULE_INVALID';
  constructor(detail: string) {
    super(`Notification rule is not usable: ${detail}`);
    this.name = 'NotificationRuleError';
  }
}

export function assertRule(rule: NotificationRule): void {
  if (!rule.eventType.trim()) {
    throw new NotificationRuleError(`${rule.code} names no event`);
  }

  if (rule.channels.length === 0) {
    throw new NotificationRuleError(
      `${rule.code} has no channel, so it would generate a notification nobody receives.`,
    );
  }

  if (!rule.recipientRole.trim()) {
    throw new NotificationRuleError(`${rule.code} names no recipient role`);
  }

  // An escalation with nowhere to go is a timer that fires into nothing.
  if (rule.escalateAfterSeconds !== null && !rule.escalateToRole) {
    throw new NotificationRuleError(
      `${rule.code} escalates after ${rule.escalateAfterSeconds}s but names nobody to escalate to (§21).`,
    );
  }

  if (rule.escalateAfterSeconds !== null && rule.escalateAfterSeconds <= 0) {
    throw new NotificationRuleError(
      `${rule.code} escalates after ${rule.escalateAfterSeconds}s, which is immediately or in the past.`,
    );
  }
}

// ---------------------------------------------------------------------------
// §21 — duplicate suppression
// ---------------------------------------------------------------------------

export interface QualifyingEvent {
  readonly eventType: string;
  /** What the event is about — the document, the record. */
  readonly objectType: string;
  readonly objectId: string;
  /**
   * Distinguishes two genuinely different occurrences on the same object: a
   * journal submitted, rejected and submitted again is two tasks, not one.
   * Usually the workflow revision or the status being entered.
   */
  readonly occurrence?: string | null;
}

/**
 * The key that makes "exactly one notification per qualifying event" true.
 *
 * Deterministic, so the same event recomputed after a crash produces the same
 * key — which is the only way a unique index can recognise a repeat. Job
 * delivery is at-least-once (01.10), so a repeat is not an edge case: it is the
 * normal consequence of a retry.
 *
 * Per event and recipient, not per rule. The rules are written per role and a
 * person may hold two that cover one event; keyed by the rule, one supplier
 * payment told the same person twice (live, 2026-10-02).
 */
/**
 * The event a dedupe key names, without the person it was for.
 *
 * For anything that must happen once per event rather than once per recipient
 * — the copy into the WhatsApp group, on 2026-10-03. The occurrence stays in
 * it, so a daily notice is one copy a day and not one copy ever.
 *
 * The recipient is a UUID and carries no separator, so the last one is where
 * it begins.
 */
export function eventKeyOf(dedupeKey: string): string {
  const cut = dedupeKey.lastIndexOf('|');
  return cut === -1 ? dedupeKey : dedupeKey.slice(0, cut);
}

export function dedupeKeyFor(event: QualifyingEvent, recipientUserId: string): string {
  return [
    // The event type, which the rule's code used to carry implicitly. Without
    // it `payable.held` and `payable.released` would share a key on one
    // payable and the second would be suppressed as a repeat of the first.
    event.eventType,
    event.objectType,
    event.objectId,
    event.occurrence ?? '',
    recipientUserId,
  ].join('|');
}

// ---------------------------------------------------------------------------
// §21 — escalation
// ---------------------------------------------------------------------------

export interface NotificationState {
  readonly createdAt: Date;
  /** Set when the recipient did the thing, not when they read about it. */
  readonly actedAt: Date | null;
  readonly escalatedAt: Date | null;
}

/**
 * Whether a notification is due to be escalated.
 *
 * The clock runs from when the task was raised and stops when it is **acted
 * upon** — not when it is read. §21 says "if a task is not acted upon", and
 * someone opening an e-mail and doing nothing is precisely the case escalation
 * exists for.
 */
export function isEscalationDue(
  rule: Pick<NotificationRule, 'escalateAfterSeconds'>,
  state: NotificationState,
  now: Date,
): boolean {
  if (rule.escalateAfterSeconds === null) return false;
  if (state.actedAt) return false;
  if (state.escalatedAt) return false;

  const elapsed = (now.getTime() - state.createdAt.getTime()) / 1000;
  return elapsed >= rule.escalateAfterSeconds;
}

// ---------------------------------------------------------------------------
// §21 — the boundary
// ---------------------------------------------------------------------------

/**
 * The invariant this module exists to keep, stated as code so it can be tested.
 *
 * §21: "A missed e-mail must never change the underlying approval requirement."
 *
 * A delivery outcome — sent, failed, suppressed, never attempted — carries no
 * information about whether the document may proceed. This function returns the
 * approval requirement **unchanged**, whatever happened to the notification,
 * and the 01.9 gate asserts it.
 */
export function approvalRequirementAfterDelivery<T>(
  approvalRequirement: T,
  _deliveryOutcome: DeliveryStatus | 'not_attempted',
): T {
  return approvalRequirement;
}

export class NotificationsAreNotApprovalsError extends Error {
  readonly code = 'NOTIFICATIONS_ARE_NOT_APPROVALS';
  constructor() {
    super(
      'A notification cannot approve, reject or release a document. §21: system notifications are not a ' +
        'substitute for workflow status.',
    );
    this.name = 'NotificationsAreNotApprovalsError';
  }
}

/** Renders the message. Kept pure so the wording is testable without a mailbox. */
export function renderNotification(
  event: QualifyingEvent,
  context: Readonly<Record<string, string | number | null | undefined>> = {},
): { subject: string; body: string } {
  const label = event.eventType.replace(/[._]/g, ' ');
  const reference = context.reference ?? event.objectId;

  const details = Object.entries(context)
    .filter(([key, value]) => key !== 'reference' && value !== null && value !== undefined)
    .map(([key, value]) => `${humanise(key)}: ${value}`);

  return {
    subject: `${humanise(label)} — ${reference}`,
    body: [
      `${humanise(label)} for ${reference}.`,
      ...details,
      // §21, said to the recipient rather than only to the developer.
      'This message is a reminder. The approval itself is recorded on the document.',
    ].join('\n'),
  };
}

function humanise(value: string): string {
  const spaced = value.replace(/[._]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------------------------------------------------------------------------
// Delivery retries — REQ-HARDEN-001 D-HD-4, delivered with REQ-WA-001 WA-1
// ---------------------------------------------------------------------------

/** Three attempts, then it stays failed and visible: 1 min, 10 min, 60 min. */
export const DELIVERY_RETRY_DELAYS_SECONDS = [60, 600, 3600] as const;
export const DELIVERY_MAX_ATTEMPTS = DELIVERY_RETRY_DELAYS_SECONDS.length;

/**
 * Whether a delivery is due another attempt: a pending row always is; a
 * failed one when it has attempts left and the back-off since the last has
 * elapsed; a sent or suppressed one never.
 */
export function isDeliveryDue(
  delivery: { readonly status: DeliveryStatus; readonly attempts: number; readonly lastAttemptAt: Date | null },
  now: Date,
): boolean {
  if (delivery.status === 'pending') return true;
  if (delivery.status !== 'failed') return false;
  if (delivery.attempts >= DELIVERY_MAX_ATTEMPTS) return false;
  const wait = DELIVERY_RETRY_DELAYS_SECONDS[Math.max(0, delivery.attempts - 1)] ?? DELIVERY_RETRY_DELAYS_SECONDS[DELIVERY_RETRY_DELAYS_SECONDS.length - 1]!;
  const since = delivery.lastAttemptAt ? (now.getTime() - delivery.lastAttemptAt.getTime()) / 1000 : Infinity;
  return since >= wait;
}
