/**
 * The record framework — Phase 01.12, Appendix A global UI rules 2–4.
 *
 * *"Every record shows status, owner, branch, dates, source, approvals, related
 * documents, journal entries and audit timeline."*
 * *"Only actions valid for the current status and permission are enabled."*
 * *"Draft documents are clearly marked and cannot be confused with final
 * documents."*
 *
 * The header is a type rather than a convention. If it were a convention, the
 * eighth module would show six of the nine facts and nobody would notice until
 * someone needed the source document during an audit.
 *
 * Action enablement is computed from two independent facts — the status machine
 * and the permission model — and both must say yes. Neither alone is enough:
 * permission without status lets someone post a draft; status without
 * permission lets anyone post a submitted one. The reason for a disabled action
 * is carried with it, because a greyed-out button with no explanation produces
 * a support call rather than a corrected document.
 */
import {
  allowedTargets,
  isEditable,
  isFinal,
  type DocumentStatus,
  type TransitionRule,
} from './statuses';
import { can, type PermissionVerb, type Principal } from './permissions';

/**
 * The nine facts Appendix A requires on every record.
 *
 * Nullable where the fact may genuinely not exist — a manual journal has no
 * source document — but never optional, so a module that has nothing to show
 * must say so rather than omit the field.
 */
export interface RecordHeader {
  readonly documentType: string;
  readonly documentId: string;
  readonly workflowDocumentId?: string | null;
  /**
   * The identity the audit trail keys this record by, when it differs from the
   * one the URL uses.
   *
   * They differ more often than they look as though they should: an account is
   * addressed by its code, because that is what an accountant knows, but audit
   * events reference its immutable row id, because a code can in principle be
   * corrected while a draft. Assuming the two are the same produces a record
   * page with a permanently empty audit timeline — which reads as "nothing ever
   * happened to this record" rather than as a wiring mistake.
   */
  readonly auditObjectId?: string | null;
  /** The human-facing number from the numbering service (§01.5). */
  readonly documentNumber: string | null;
  readonly status: DocumentStatus;
  readonly ownerUserId: string | null;
  readonly branchCode: string | null;
  readonly departmentCode: string | null;
  /** Business date (ISO string — never a JS Date; see TECHSTACK A10). */
  readonly documentDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  /** The document this one came from — PO for a receipt, and so on. */
  readonly source: RelatedDocument | null;
}

export interface RelatedDocument {
  readonly documentType: string;
  readonly documentId: string;
  readonly documentNumber: string | null;
  readonly status: DocumentStatus | null;
  /** How it relates: 'source', 'derived', 'reversal', 'allocation'. */
  readonly relation: string;
}

export interface ApprovalSummary {
  readonly instanceId: string;
  readonly revision: number;
  readonly currentStep: number | null;
  readonly isComplete: boolean;
  readonly assignedToUserId: string | null;
  readonly decisions: readonly {
    readonly stepSequence: number;
    readonly actorUserId: string;
    readonly decision: string;
    readonly reason: string | null;
    readonly decidedAt: string;
  }[];
}

export interface JournalSummary {
  readonly journalId: string;
  readonly journalNumber: string | null;
  readonly postedAt: string | null;
  readonly totalDebitIqd: string;
  readonly totalCreditIqd: string;
  readonly isReversal: boolean;
}

export interface AuditEntry {
  readonly at: string;
  readonly actorUserId: string | null;
  readonly action: string;
  readonly field: string | null;
  readonly oldValue: string | null;
  readonly newValue: string | null;
}

/** Everything a record screen renders, assembled once by `services/record.ts`. */
export interface RecordView {
  readonly header: RecordHeader;
  readonly approvals: readonly ApprovalSummary[];
  readonly related: readonly RelatedDocument[];
  readonly journals: readonly JournalSummary[];
  readonly audit: readonly AuditEntry[];
  readonly actions: readonly RecordAction[];
  /** Rule 4 — the draft marking, decided here so no module can forget it. */
  readonly draftMarking: DraftMarking;
}

/**
 * Appendix A rule 4.
 *
 * `isDraft` drives a visible band on screen and a watermark on print. A draft
 * that prints looking like a final document is the failure this rule exists to
 * prevent, so the decision is made server-side and travels with the record
 * rather than being a CSS class someone might forget on the print stylesheet.
 */
export interface DraftMarking {
  readonly isDraft: boolean;
  readonly isFinal: boolean;
  /** Message key for the banner (§25 — labels live in the catalogue). */
  readonly labelKey: string;
}

export function draftMarkingFor(status: DocumentStatus): DraftMarking {
  if (status === 'draft') {
    return { isDraft: true, isFinal: false, labelKey: 'record.marking.draft' };
  }
  if (status === 'submitted') {
    return { isDraft: true, isFinal: false, labelKey: 'record.marking.pending_approval' };
  }
  if (status === 'cancelled' || status === 'rejected' || status === 'reversed') {
    return { isDraft: false, isFinal: true, labelKey: `record.marking.${status}` };
  }
  return { isDraft: false, isFinal: isFinal(status), labelKey: 'record.marking.final' };
}

/** An action offered on a record, enabled or explained. */
export interface RecordAction {
  readonly key: string;
  readonly verb: PermissionVerb;
  /** The status this action moves the document to, if it moves it. */
  readonly targetStatus: DocumentStatus | null;
  readonly enabled: boolean;
  /** Why not — a message key, never a generic failure (§25). */
  readonly disabledReasonKey: string | null;
}

/** The standard verbs a document supports, in the order they appear on screen. */
export interface ActionDefinition {
  readonly key: string;
  readonly verb: PermissionVerb;
  readonly targetStatus: DocumentStatus | null;
  /** Extra condition the module supplies, e.g. "only if fully matched". */
  readonly available?: boolean;
  readonly unavailableReasonKey?: string;
}

export const STANDARD_ACTIONS: readonly ActionDefinition[] = Object.freeze([
  { key: 'edit', verb: 'edit_draft', targetStatus: null },
  { key: 'submit', verb: 'submit', targetStatus: 'submitted' },
  { key: 'approve', verb: 'approve', targetStatus: 'approved' },
  { key: 'reject', verb: 'approve', targetStatus: 'rejected' },
  { key: 'execute', verb: 'execute', targetStatus: 'executed' },
  { key: 'post', verb: 'post', targetStatus: 'posted' },
  { key: 'reverse', verb: 'reverse_cancel', targetStatus: 'reversed' },
  { key: 'cancel', verb: 'reverse_cancel', targetStatus: 'cancelled' },
  { key: 'print', verb: 'print', targetStatus: null },
  { key: 'export', verb: 'export', targetStatus: null },
]);

export interface ActionContext {
  readonly documentType: string;
  readonly status: DocumentStatus;
  /** The transitions configured for this document type (§01.6, from the DB). */
  readonly transitions: readonly TransitionRule[];
  readonly principal: Principal;
  /** Module-supplied overrides, keyed by action. */
  readonly overrides?: Readonly<Record<string, { available: boolean; reasonKey: string }>>;
}

/**
 * Which actions are offered, and for the rest, why not.
 *
 * Order of checks matters for the message: permission is reported before
 * status, because "you may not post" is the more useful thing to tell someone
 * who will never be able to post this document, whereas "not in this status" of
 * an action they cannot perform anyway invites them to keep trying.
 */
export function actionsFor(
  context: ActionContext,
  definitions: readonly ActionDefinition[] = STANDARD_ACTIONS,
): readonly RecordAction[] {
  const targets = allowedTargets(context.transitions, context.status);

  return definitions.map((definition) => {
    const disabled = (reasonKey: string): RecordAction => ({
      key: definition.key,
      verb: definition.verb,
      targetStatus: definition.targetStatus,
      enabled: false,
      disabledReasonKey: reasonKey,
    });

    if (!can(context.principal, definition.verb, context.documentType)) {
      return disabled('action.disabled.no_permission');
    }

    const override = context.overrides?.[definition.key];
    if (override && !override.available) {
      return disabled(override.reasonKey);
    }

    if (definition.key === 'edit' && !isEditable(context.status)) {
      return disabled('action.disabled.not_editable');
    }

    if (definition.targetStatus !== null && !targets.includes(definition.targetStatus)) {
      return disabled('action.disabled.wrong_status');
    }

    return {
      key: definition.key,
      verb: definition.verb,
      targetStatus: definition.targetStatus,
      enabled: true,
      disabledReasonKey: null,
    };
  });
}

/** Convenience for a screen: just the enabled ones, in definition order. */
export function enabledActions(actions: readonly RecordAction[]): readonly RecordAction[] {
  return actions.filter((a) => a.enabled);
}
