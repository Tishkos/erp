/**
 * Record assembly — Phase 01.12, Appendix A global UI rule 2.
 *
 * *"Every record shows status, owner, branch, dates, source, approvals, related
 * documents, journal entries and audit timeline."*
 *
 * One assembler for every document type in the system. A module registers where
 * its header comes from and what counts as a related document; everything else
 * — approvals, journals, the audit timeline, which actions are enabled — is the
 * same for all of them and is answered here.
 *
 * This is §24's rule applied to the record screen: *"Duplicating these
 * mechanisms inside each module will create inconsistent controls and expensive
 * maintenance."* A module that assembled its own record page would sooner or
 * later show eight of the nine facts.
 */
import { and, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  documentStatusTransition,
  workflowDecisionLog,
  workflowInstance,
} from '../db/schema';
import { assertCan, type Principal } from '../domain/permissions';
import type { DocumentStatus, TransitionRule } from '../domain/statuses';
import {
  actionsFor,
  draftMarkingFor,
  type ActionDefinition,
  type ApprovalSummary,
  type AuditEntry,
  type JournalSummary,
  type RecordHeader,
  type RecordView,
  type RelatedDocument,
} from '../domain/record-view';
import * as audit from './audit';

/**
 * What a module must supply for its documents to have record pages.
 *
 * Three functions, none of which know anything about approvals, audit or
 * actions — those are not the module's business.
 */
export interface RecordSource {
  /** Document type code, matching Appendix B and `document_type.code`. */
  readonly documentType: string;
  /** Permission object, usually the same string. */
  readonly object: string;
  readonly loadHeader: (tx: Tx, documentId: string) => Promise<RecordHeader | null>;
  /** Documents on either side of this one — derived, reversing, allocated. */
  readonly loadRelated?: (tx: Tx, documentId: string) => Promise<readonly RelatedDocument[]>;
  /** The journals this document produced. Absent for documents that never post. */
  readonly loadJournals?: (tx: Tx, documentId: string) => Promise<readonly JournalSummary[]>;
  /** Extra actions beyond the standard set, or module conditions on them. */
  readonly actions?: readonly ActionDefinition[];
  readonly actionOverrides?: (
    tx: Tx,
    header: RecordHeader,
  ) => Promise<Readonly<Record<string, { available: boolean; reasonKey: string }>>>;
}

const registry = new Map<string, RecordSource>();

export function registerRecord(source: RecordSource): void {
  registry.set(source.documentType, source);
}

export class UnknownRecordTypeError extends Error {
  readonly code = 'UNKNOWN_RECORD_TYPE';
  constructor(documentType: string) {
    super(`No record source is registered for '${documentType}'.`);
    this.name = 'UnknownRecordTypeError';
  }
}

export class RecordNotFoundError extends Error {
  readonly code = 'RECORD_NOT_FOUND';
  constructor(
    readonly documentType: string,
    readonly documentId: string,
  ) {
    // Deliberately the same message whether the record is absent or out of the
    // reader's scope — distinguishing them confirms that a record exists to
    // someone not entitled to know it does.
    super('That record does not exist, or is outside the data you may see.');
    this.name = 'RecordNotFoundError';
  }
}

export function recordSource(documentType: string): RecordSource {
  const source = registry.get(documentType);
  if (!source) throw new UnknownRecordTypeError(documentType);
  return source;
}

/** The configured status machine for a document type (§01.6). */
export async function transitionsFor(
  tx: Tx,
  documentType: string,
): Promise<readonly TransitionRule[]> {
  const rows = await tx
    .select({
      from: documentStatusTransition.fromStatus,
      to: documentStatusTransition.toStatus,
    })
    .from(documentStatusTransition)
    .where(eq(documentStatusTransition.documentTypeCode, documentType));

  return rows;
}

/** Every approval this document has been through, current revision last. */
export async function approvalsFor(
  tx: Tx,
  documentType: string,
  documentId: string,
): Promise<readonly ApprovalSummary[]> {
  const instances = await tx
    .select()
    .from(workflowInstance)
    .where(
      and(
        eq(workflowInstance.documentTypeCode, documentType),
        eq(workflowInstance.documentId, documentId),
      ),
    )
    .orderBy(workflowInstance.revision);

  const summaries: ApprovalSummary[] = [];

  for (const instance of instances) {
    const decisions = await tx
      .select()
      .from(workflowDecisionLog)
      .where(eq(workflowDecisionLog.instanceId, instance.id))
      .orderBy(workflowDecisionLog.decidedAt, workflowDecisionLog.id);

    summaries.push({
      instanceId: instance.id,
      revision: instance.revision,
      currentStep: instance.currentStep,
      isComplete: instance.isComplete,
      assignedToUserId: instance.assignedToUserId,
      // The rejected and recalled attempts are kept, not just the successful
      // one — 01.7's gate is the *full* decision history.
      decisions: decisions.map((d) => ({
        stepSequence: d.stepSequence,
        actorUserId: d.actorUserId,
        decision: d.decision,
        reason: d.reason,
        decidedAt: d.decidedAt.toISOString(),
      })),
    });
  }

  return summaries;
}

export interface RecordViewOptions {
  /** The timeline is long on old documents; a screen shows a window of it. */
  readonly auditLimit?: number;
}

/**
 * Assemble everything a record screen renders.
 *
 * `view` is asserted here rather than trusted from the route, because §23
 * requires the API and the UI to enforce the same rules and both arrive here.
 * Row scope is not re-checked in code — RLS decides it, so a record outside the
 * reader's branches simply does not load, and is reported as not found.
 */
export async function view(
  tx: Tx,
  principal: Principal,
  documentType: string,
  documentId: string,
  options: RecordViewOptions = {},
): Promise<RecordView> {
  const source = recordSource(documentType);
  assertCan(principal, 'view', source.object);

  const header = await source.loadHeader(tx, documentId);
  if (!header) throw new RecordNotFoundError(documentType, documentId);

  // Sequential, not `Promise.all`: a transaction is one connection, and issuing
  // concurrent queries on it is deprecated in `pg` and an error from pg@9. The
  // driver serialises them regardless, so the parallel form buys nothing — the
  // rule `dimensions.ts` writes down, applied here too.
  const transitions = await transitionsFor(tx, documentType);
  const approvals = await approvalsFor(tx, documentType, header.workflowDocumentId ?? documentId);
  const related = await (source.loadRelated?.(tx, documentId) ?? Promise.resolve([]));
  const journals = await (source.loadJournals?.(tx, documentId) ?? Promise.resolve([]));
  const timeline = await audit.timelineFor(
    tx,
    source.object,
    header.auditObjectId ?? documentId,
    options.auditLimit ?? 200,
  );
  const overrides = await (source.actionOverrides?.(tx, header) ?? Promise.resolve({}));

  const actions = actionsFor(
    {
      documentType: source.object,
      status: header.status,
      transitions,
      principal,
      overrides,
    },
    source.actions,
  );

  return {
    header,
    approvals,
    related: header.source ? [header.source, ...related] : related,
    journals,
    audit: timeline.map(toAuditEntry),
    actions,
    draftMarking: draftMarkingFor(header.status),
  };
}

function toAuditEntry(row: Record<string, unknown>): AuditEntry {
  const occurred = row.occurred_at;
  return {
    at: occurred instanceof Date ? occurred.toISOString() : String(occurred),
    actorUserId: (row.actor_user_id as string | null) ?? null,
    action: String(row.action),
    field: null,
    oldValue: row.before_value === null ? null : JSON.stringify(row.before_value),
    newValue: row.after_value === null ? null : JSON.stringify(row.after_value),
  };
}

/**
 * The status of one document, without assembling the rest.
 *
 * Used by list screens to decide row-level action enablement without loading
 * nine facts per row.
 */
export async function statusOf(
  tx: Tx,
  source: RecordSource,
  documentId: string,
): Promise<DocumentStatus | null> {
  const header = await source.loadHeader(tx, documentId);
  return header?.status ?? null;
}

/** Registered document types — for the coverage test and the menu builder. */
export function registeredRecordTypes(): readonly string[] {
  return [...registry.keys()].sort();
}

/** Count of related documents, for the tab badge, without loading them. */
export async function relatedCount(
  tx: Tx,
  documentType: string,
  documentId: string,
): Promise<number> {
  const source = recordSource(documentType);
  if (!source.loadRelated) return 0;
  const related = await source.loadRelated(tx, documentId);
  return related.length;
}

/** Exposed for tests: clears the registry between suites. */
export function resetRecordRegistry(): void {
  registry.clear();
}

