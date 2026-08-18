/**
 * Status machine repository — Phase 01.6.
 *
 * The allow-list lives in `document_status_transition`, one row per permitted
 * move. §24 acceptance: "Invalid status transitions are rejected from both UI
 * and API" — both call `assertTransitionAllowed`, so there is nothing to keep
 * in step.
 */
import { eq } from 'drizzle-orm';
import {
  assertTransition,
  type DocumentStatus,
  type TransitionRule,
} from '../domain/statuses';
import { documentStatusTransition } from '../db/schema';
import type { Tx } from '../db/client';

export async function transitionRulesFor(
  tx: Tx,
  documentTypeCode: string,
): Promise<TransitionRule[]> {
  const rows = await tx
    .select({
      from: documentStatusTransition.fromStatus,
      to: documentStatusTransition.toStatus,
    })
    .from(documentStatusTransition)
    .where(eq(documentStatusTransition.documentTypeCode, documentTypeCode));

  return rows;
}

/**
 * Rejects a move that is not on this document type's list.
 *
 * A document type with no rows configured can make no moves at all. That is
 * deliberate: failing closed on missing configuration is the only safe default
 * for a status machine that gates posting.
 */
export async function assertTransitionAllowed(
  tx: Tx,
  documentTypeCode: string,
  from: DocumentStatus,
  to: DocumentStatus,
  reason?: string | null,
): Promise<void> {
  const rules = await transitionRulesFor(tx, documentTypeCode);
  assertTransition(documentTypeCode, rules, from, to, reason);
}
