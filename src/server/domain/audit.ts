/**
 * Audit — the event shape and its redaction rules, Phase 01.4.
 *
 * Blueprint §5.4 lists what every entry must carry:
 *
 *   "user, date and time, action, section, record, before and after values,
 *    approval decision, reason, source device/session where available, links to
 *    original and reversing documents."
 *
 * And §25 states the boundary:
 *
 *   "No passwords, tokens, private keys or sensitive document contents in logs."
 *
 * Those two pull against each other: before/after values are exactly where a
 * password hash or a bank account number would land. Redaction is therefore
 * part of building the event, not a filter someone remembers to apply.
 *
 * This module is pure. Writing the event inside the caller's transaction is the
 * repository's job (`src/server/services/audit.ts`) — §5.4 requires the audit
 * entry and the change it records to commit together or not at all.
 */

/** The outcome of the attempted action. Denials are audited too — §25. */
export type AuditOutcome = 'success' | 'denied' | 'failure';

/**
 * Keys whose values never reach the audit store.
 *
 * Matched on the key, not the value: a value-based heuristic fails open, and a
 * control that fails open is not a control.
 */
const REDACTED_KEY_PATTERNS: readonly RegExp[] = [
  /pass(word|phrase)/i,
  /secret/i,
  /token/i,
  /credential/i,
  /(^|_)(api|private|encryption)_?key$/i,
  /session_?id$/i,
  /mfa|otp|two_?factor/i,
  /card_?number|cvv|iban|swift/i,
  // The two headers a bearer token actually travels in. Neither contains the
  // word "token", so without naming them a logged request object carries the
  // credential straight through (01.1 gate).
  /^authori[sz]ation$/i,
  /^(set-)?cookie$/i,
];

export const REDACTED = '[redacted]' as const;

/** How deep a before/after snapshot may nest before it is truncated. */
const MAX_DEPTH = 6;

export function isRedactedKey(key: string): boolean {
  return REDACTED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

/**
 * Returns a copy of `value` with sensitive keys replaced.
 *
 * Depth-limited: an audit entry records a business change, not an object graph.
 * A snapshot deeper than MAX_DEPTH is truncated rather than serialised, because
 * §21 warns against putting "sensitive document contents" in the trail.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isRedactedKey(key) ? REDACTED : redact(item, depth + 1);
  }
  return output;
}

/**
 * What the caller supplies. `occurredAt` is not among the fields: the database
 * stamps it, so an event cannot be back-dated by the code that raises it.
 */
export interface AuditEventInput {
  /** Null only for pre-authentication events — a failed sign-in has no actor. */
  readonly actorUserId: string | null;
  /** Verb-first and past tense: 'user.signed_in', 'journal_entry.posted'. */
  readonly action: string;
  /** §5.4 "section" — the object type the action was performed on. */
  readonly objectType: string;
  /** §5.4 "record" — null for actions with no single target, e.g. a sign-in. */
  readonly objectId?: string | null;
  readonly branchCode?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  /** §5.4 — mandatory for cancellation, rejection and override actions. */
  readonly reason?: string | null;
  readonly outcome: AuditOutcome;
  /** §5.4 "source device/session where available"; §23 request correlation. */
  readonly sessionId?: string | null;
  readonly requestId?: string | null;
  readonly clientIp?: string | null;
  /** §5.4 "links to original and reversing documents". */
  readonly relatedObjectId?: string | null;
}

/** The event as it is written. Values are already redacted. */
export interface AuditEventDraft {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string | null;
  readonly branchCode: string | null;
  readonly beforeValue: unknown;
  readonly afterValue: unknown;
  readonly reason: string | null;
  readonly outcome: AuditOutcome;
  readonly sessionId: string | null;
  readonly requestId: string | null;
  readonly clientIp: string | null;
  readonly relatedObjectId: string | null;
}

/** Actions that are not recordable without a stated reason (§5.4, §3.2). */
const REASON_REQUIRED = /\.(cancelled|rejected|reversed|overridden|deactivated)$/;

export class AuditReasonRequiredError extends Error {
  readonly code = 'AUDIT_REASON_REQUIRED';

  constructor(action: string) {
    super(
      `Action '${action}' cannot be recorded without a reason. ` +
        'Blueprint §5.4 requires the reason to be stored with the decision.',
    );
    this.name = 'AuditReasonRequiredError';
  }
}

export function buildAuditEvent(input: AuditEventInput): AuditEventDraft {
  if (REASON_REQUIRED.test(input.action) && !input.reason?.trim()) {
    throw new AuditReasonRequiredError(input.action);
  }

  return {
    actorUserId: input.actorUserId,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId ?? null,
    // No selected branch is represented by an empty string in request scope;
    // audit_event stores the company-wide/no-branch case as SQL NULL.
    branchCode: input.branchCode?.trim() || null,
    beforeValue: input.before === undefined ? null : redact(input.before),
    afterValue: input.after === undefined ? null : redact(input.after),
    reason: input.reason?.trim() || null,
    outcome: input.outcome,
    // The session identifier is a credential-equivalent: recording it whole
    // would put a live session key in a table many roles can read.
    sessionId: input.sessionId ? fingerprint(input.sessionId) : null,
    requestId: input.requestId ?? null,
    clientIp: input.clientIp ?? null,
    relatedObjectId: input.relatedObjectId ?? null,
  };
}

/**
 * A short, stable, non-reversible marker for a session.
 *
 * Enough to correlate two events to one session during an investigation;
 * useless to anyone who reads the audit table. Not a security boundary — the
 * boundary is that the raw identifier is never stored.
 */
export function fingerprint(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `s_${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}
