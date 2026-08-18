/**
 * Document status machine — Phase 01.6.
 *
 * §24 gives one common status model for every document in the system, and
 * §3.2 says each document type uses "only the states applicable to its
 * operational and accounting effect". So the vocabulary is fixed here and the
 * allowed moves are configured per document type — one engine, eleven words,
 * no module inventing its own lifecycle.
 *
 * §24 acceptance: "Invalid status transitions are rejected from both UI and
 * API." That holds because both call this.
 */

/** The eleven statuses of §24. Closed list. */
export const DOCUMENT_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'partially_executed',
  'executed',
  'posted',
  'settled',
  'rejected',
  'cancelled',
  'reversed',
  'closed',
] as const;

export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function isDocumentStatus(value: string): value is DocumentStatus {
  return (DOCUMENT_STATUSES as readonly string[]).includes(value);
}

/**
 * Statuses in which the document body may still be edited.
 *
 * §24: "Submission freezes controlled fields and starts the approval workflow."
 * Draft is the only status in which everything is open. Rejected returns to
 * draft as a new revision (§01.7), so it is not editable in place.
 */
const EDITABLE: ReadonlySet<DocumentStatus> = new Set(['draft']);

/**
 * Statuses a document cannot leave by editing — §3.2: "A final operational or
 * accounting document cannot be edited or deleted." Corrections go through the
 * approved reversal or return document for that process.
 */
const FINAL: ReadonlySet<DocumentStatus> = new Set([
  'posted',
  'settled',
  'cancelled',
  'reversed',
  'closed',
]);

/** Transitions that cannot be made without a stated reason (§24, §5.4). */
const REASON_REQUIRED: ReadonlySet<DocumentStatus> = new Set(['rejected', 'cancelled', 'reversed']);

export function isEditable(status: DocumentStatus): boolean {
  return EDITABLE.has(status);
}

export function isFinal(status: DocumentStatus): boolean {
  return FINAL.has(status);
}

export function requiresReason(to: DocumentStatus): boolean {
  return REASON_REQUIRED.has(to);
}

/** One allowed move for one document type. */
export interface TransitionRule {
  readonly from: DocumentStatus;
  readonly to: DocumentStatus;
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_STATUS_TRANSITION';

  constructor(
    readonly documentType: string,
    readonly from: DocumentStatus,
    readonly to: DocumentStatus,
    allowed: readonly DocumentStatus[],
  ) {
    super(
      `A ${documentType} cannot move from '${from}' to '${to}'. ` +
        (allowed.length > 0
          ? `From '${from}' it may move to: ${allowed.join(', ')}.`
          : `'${from}' is a final status for this document type.`),
    );
    this.name = 'InvalidTransitionError';
  }
}

export class TransitionReasonRequiredError extends Error {
  readonly code = 'TRANSITION_REASON_REQUIRED';

  constructor(readonly to: DocumentStatus) {
    super(`Moving a document to '${to}' requires a reason, and the reason is stored (§5.4).`);
    this.name = 'TransitionReasonRequiredError';
  }
}

export class DocumentNotEditableError extends Error {
  readonly code = 'DOCUMENT_NOT_EDITABLE';

  constructor(
    readonly documentType: string,
    readonly status: DocumentStatus,
  ) {
    super(
      `A ${documentType} in status '${status}' cannot be edited. ` +
        (isFinal(status)
          ? 'A final document is corrected by the approved reversal or return document for that process (§3.2).'
          : 'Submission freezes the controlled fields (§24).'),
    );
    this.name = 'DocumentNotEditableError';
  }
}

export class DocumentNotDeletableError extends Error {
  readonly code = 'DOCUMENT_NOT_DELETABLE';

  constructor(readonly documentType: string) {
    super(
      `A saved ${documentType} cannot be deleted. It may be edited while draft, or cancelled with a reason (§3.2).`,
    );
    this.name = 'DocumentNotDeletableError';
  }
}

/** The moves available from `from`, given this document type's allow-list. */
export function allowedTargets(
  rules: readonly TransitionRule[],
  from: DocumentStatus,
): DocumentStatus[] {
  return rules.filter((rule) => rule.from === from).map((rule) => rule.to);
}

/**
 * The check. Deny-by-default: a move that is not on the list is refused, so a
 * document type that forgets to configure a transition fails closed.
 */
export function assertTransition(
  documentType: string,
  rules: readonly TransitionRule[],
  from: DocumentStatus,
  to: DocumentStatus,
  reason?: string | null,
): void {
  const targets = allowedTargets(rules, from);

  if (!targets.includes(to)) {
    throw new InvalidTransitionError(documentType, from, to, targets);
  }

  if (requiresReason(to) && !reason?.trim()) {
    throw new TransitionReasonRequiredError(to);
  }
}

export function assertEditable(documentType: string, status: DocumentStatus): void {
  if (!isEditable(status)) {
    throw new DocumentNotEditableError(documentType, status);
  }
}

/**
 * Deletion is never permitted for a saved document — §1.1: "No deletion of
 * saved or posted records."
 *
 * A function that always throws looks pointless until you notice it gives every
 * caller one obvious thing to call, and one error message that explains what to
 * do instead.
 */
export function assertDeletable(documentType: string): never {
  throw new DocumentNotDeletableError(documentType);
}
