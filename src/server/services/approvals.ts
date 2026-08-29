/**
 * My Approvals — Phase 0 requirement 6, seen from the approver's chair.
 *
 * "A normal employee submits a document to the Department Manager for
 * approval. A Department Manager can finalise documents created within their
 * own department without a second approval." The routing itself lives in
 * `department-routing.ts` and the engine in `workflow.ts`; this service only
 * answers two questions for the inbox screen — what is waiting for me, and
 * what happened to what I decided — and carries a decision through the same
 * `perform` path the record page uses, so an approval from the inbox is the
 * approval the status machine and the audit trail expect.
 */
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  chartOfAccount,
  workflowDecisionLog,
  workflowInstance,
  workflowStep,
} from '../db/schema';
import type { Principal } from '../domain/permissions';
import { assertCan } from '../domain/permissions';
import { registerAllRecords } from '../records';
import { perform } from './document-actions';

export const PERMISSION_OBJECT = 'workflow_instance';

export interface InboxItem {
  readonly instanceId: string;
  readonly documentTypeCode: string;
  readonly documentId: string;
  readonly departmentCode: string | null;
  readonly branchCode: string | null;
  readonly submittedBy: string;
  readonly submittedByName: string | null;
  readonly submittedAt: Date;
  readonly currentStep: number | null;
  readonly approverKind: string | null;
  readonly approverRole: string | null;
}

/**
 * What is waiting for this person: instances assigned to them by name
 * (department routing), plus instances whose current step is approved by a
 * role they hold.
 */
export async function inbox(tx: Tx, principal: Principal): Promise<InboxItem[]> {
  assertCan(principal, 'view', PERMISSION_OBJECT);
  const roles = principal.roleCodes.length > 0 ? [...principal.roleCodes] : ['—'];

  return tx
    .select({
      instanceId: workflowInstance.id,
      documentTypeCode: workflowInstance.documentTypeCode,
      documentId: workflowInstance.documentId,
      departmentCode: workflowInstance.departmentCode,
      branchCode: workflowInstance.branchCode,
      submittedBy: workflowInstance.submittedBy,
      submittedByName: appUser.displayName,
      submittedAt: workflowInstance.submittedAt,
      currentStep: workflowInstance.currentStep,
      approverKind: workflowStep.approverKind,
      approverRole: workflowStep.approverRole,
    })
    .from(workflowInstance)
    .leftJoin(
      workflowStep,
      and(
        eq(workflowStep.definitionId, workflowInstance.definitionId),
        eq(workflowStep.sequence, workflowInstance.currentStep),
      ),
    )
    .leftJoin(appUser, eq(appUser.id, workflowInstance.submittedBy))
    .where(
      and(
        eq(workflowInstance.isComplete, false),
        or(
          eq(workflowInstance.assignedToUserId, principal.userId),
          and(
            sql`${workflowInstance.assignedToUserId} is null`,
            eq(workflowStep.approverKind, 'role'),
            inArray(workflowStep.approverRole, roles),
          ),
        ),
      ),
    )
    .orderBy(asc(workflowInstance.submittedAt));
}

/** What this person submitted that is still open, or was decided lately. */
export async function mySubmissions(tx: Tx, principal: Principal, limit = 20) {
  assertCan(principal, 'view', PERMISSION_OBJECT);
  return tx
    .select({
      instanceId: workflowInstance.id,
      documentTypeCode: workflowInstance.documentTypeCode,
      documentId: workflowInstance.documentId,
      departmentCode: workflowInstance.departmentCode,
      submittedAt: workflowInstance.submittedAt,
      isComplete: workflowInstance.isComplete,
      completedAt: workflowInstance.completedAt,
      lastDecision: sql<string | null>`(
        select d.decision::text from workflow_decision d
         where d.instance_id = workflow_instance.id
         order by d.decided_at desc limit 1)`,
    })
    .from(workflowInstance)
    .where(eq(workflowInstance.submittedBy, principal.userId))
    .orderBy(desc(workflowInstance.submittedAt))
    .limit(limit);
}

/** The decisions this person made, most recent first. */
export async function myDecisions(tx: Tx, principal: Principal, limit = 20) {
  assertCan(principal, 'view', PERMISSION_OBJECT);
  return tx
    .select({
      documentTypeCode: workflowInstance.documentTypeCode,
      documentId: workflowInstance.documentId,
      decision: workflowDecisionLog.decision,
      reason: workflowDecisionLog.reason,
      decidedAt: workflowDecisionLog.decidedAt,
    })
    .from(workflowDecisionLog)
    .innerJoin(workflowInstance, eq(workflowInstance.id, workflowDecisionLog.instanceId))
    .where(eq(workflowDecisionLog.actorUserId, principal.userId))
    .orderBy(desc(workflowDecisionLog.decidedAt))
    .limit(limit);
}

/**
 * Approve or reject from the inbox.
 *
 * Goes through `perform`, which asks the record framework the same question
 * the record page asks — is this action enabled for this status and this
 * person — and runs the document type's effects on approval.
 */
export async function decide(
  tx: Tx,
  principal: Principal,
  input: {
    readonly documentTypeCode: string;
    readonly documentId: string;
    readonly decision: 'approve' | 'reject';
    readonly reason?: string | null;
    readonly branchCode?: string | null;
  },
) {
  registerAllRecords();
  return perform(tx, principal, {
    documentType: input.documentTypeCode,
    documentId: input.documentId,
    action: input.decision,
    reason: input.reason ?? null,
    branchCode: input.branchCode ?? null,
  });
}

/**
 * Where an inbox row leads.
 *
 * The engine keys an instance by the document's id; a record page is keyed by
 * what a person knows — the chart by account code. This resolves one to the
 * other for the document types that have a record page today.
 */
export async function recordReference(
  tx: Tx,
  documentTypeCode: string,
  documentId: string,
): Promise<{ readonly label: string; readonly href: string | null; readonly recordId: string }> {
  if (documentTypeCode === 'chart_of_account') {
    const [account] = await tx
      .select({ code: chartOfAccount.code, name: chartOfAccount.name })
      .from(chartOfAccount)
      .where(eq(chartOfAccount.id, documentId))
      .limit(1);
    if (account) {
      return {
        label: `${account.code} — ${account.name}`,
        href: `/master-data/chart-of-accounts/${encodeURIComponent(account.code)}`,
        recordId: account.code,
      };
    }
  }
  return { label: documentId, href: null, recordId: documentId };
}
