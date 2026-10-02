/**
 * Deciding a document from chat — REQ-WA-001 WA-6.
 *
 * The audit that asked for this feature also wrote the rule it has to live
 * with: *an inbound WhatsApp message is untrusted text* (W-R2 of the first
 * release put write actions out of scope for exactly that reason). This file
 * is the doorway that was added afterwards, and the lock on it is four
 * independent things — no one of them is trusted alone:
 *
 *   1. **The contact may act.** `whatsapp_contact.allow_actions`, off until an
 *      administrator turns it on for one person (the sponsor's instruction
 *      that it must not be available to everyone). A contact that may not ask
 *      may not decide.
 *   2. **Only what is already waiting for them.** The candidates come from
 *      that person's own approval inbox, loaded under their own principal. A
 *      document nobody asked them to approve cannot be named at all — there
 *      is no "approve anything by number" path to abuse.
 *   3. **An explicit command and a one-time code.** `approve PAYAPP-…` opens
 *      a request and answers with six digits; nothing happens until those
 *      digits come back from the same contact. A forwarded message, a
 *      screenshot, or a sentence the agent misread cannot complete that round
 *      trip, and the code expires.
 *   4. **The permissions of the person, at the database.** The decision runs
 *      through `approvals.decide` as that principal, so the approval engine,
 *      the maker-checker rule, the branch scope and the open period refuse
 *      exactly as they do on the screen. This file grants nothing; it opens a
 *      door to rights that already exist.
 *
 * Everything — the request, the refusal, the confirmation, the outcome — is a
 * row in `whatsapp_action`, the message log and the audit trail (W-R4).
 */
import { randomInt } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { withScope, type Tx } from '../db/client';
import { whatsappAction, whatsappContact } from '../db/schema';
import type { Principal } from '../domain/permissions';
import { registerAllRecords } from '../records';
import * as approvals from './approvals';
import * as audit from './audit';
import { recordSource } from './record';
import { mayAct, principalOf, withReadOnlyScope, type ResolvedSender } from './whatsapp';

/** How long a code is good for. Long enough to read the document, short enough to matter. */
export const CODE_MINUTES = 10;

/**
 * A refusal is a value, not an exception.
 *
 * Both steps here write before they refuse — an expired code is *marked*
 * expired, a refused decision keeps the service's own words on the row — and
 * a thrown error would roll that writing back with the transaction, leaving
 * the code live and the reason lost. So the business answers are returned and
 * only a programming fault throws.
 */
export class ActionRefused extends Error {
  readonly code = 'WHATSAPP_ACTION_REFUSED';
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'ActionRefused';
  }
}

export type Refusal = { readonly ok: false; readonly reason: string };

export interface Waiting {
  readonly documentType: string;
  readonly documentId: string;
  readonly documentNumber: string;
  readonly status: string;
  readonly submittedByName: string | null;
  readonly submittedAt: Date;
  readonly branchCode: string | null;
}

/**
 * What is waiting for this person, with the number they would type.
 *
 * Read-only and under their own scope: the same list their Approvals inbox
 * shows them, nothing more. A row whose document type has no record source
 * (so no number a person could name) is left out rather than guessed at.
 */
export async function waitingFor(userId: string): Promise<Waiting[]> {
  registerAllRecords();
  const principal = await principalOf(userId);
  const scope = { userId, branchCode: principal.defaultBranchCode ?? '', isSuperUser: principal.isSuperUser };
  return withReadOnlyScope(scope, async (tx) => {
    const inbox = await approvals.inbox(tx, principal);
    const out: Waiting[] = [];
    for (const item of inbox) {
      const header = await headerOf(tx, item.documentTypeCode, item.documentId);
      if (!header?.documentNumber) continue;
      out.push({
        documentType: item.documentTypeCode,
        documentId: item.documentId,
        documentNumber: header.documentNumber,
        status: header.status,
        submittedByName: item.submittedByName,
        submittedAt: item.submittedAt,
        branchCode: item.branchCode,
      });
    }
    return out;
  });
}

async function headerOf(tx: Tx, documentType: string, documentId: string) {
  try {
    const source = recordSource(documentType);
    return await source.loadHeader(tx, documentId);
  } catch {
    // A type with no record source cannot be named in chat; it is simply not
    // offered. Nothing is decided on a guess.
    return null;
  }
}

/** The document the typed number means — only among what is waiting for them. */
function match(waiting: readonly Waiting[], typed: string): Waiting | null {
  const key = typed.trim().toUpperCase();
  if (!key) return null;
  const exact = waiting.find((row) => row.documentNumber.toUpperCase() === key);
  if (exact) return exact;
  const tail = waiting.filter((row) => row.documentNumber.toUpperCase().endsWith(key));
  return tail.length === 1 ? tail[0]! : null;
}

export interface RequestInput {
  readonly sender: ResolvedSender;
  readonly groupJid: string | null;
  readonly decision: 'approve' | 'reject';
  readonly documentNo: string;
  readonly reason: string | null;
}

export interface RequestOutcome {
  readonly ok: true;
  readonly code: string;
  readonly waiting: Waiting;
  readonly expiresAt: Date;
}

export type RequestResult = RequestOutcome | Refusal;

/**
 * Step one: name a document and get a code back.
 *
 * Writes the request row as the operator (the bridge's own transaction), after
 * reading the candidates as the asker. Replaces any code that person had
 * outstanding — the partial unique index is what makes "one live code" true
 * rather than hoped for.
 */
export async function request(tx: Tx, input: RequestInput): Promise<RequestResult> {
  const allowed = mayAct(input.sender);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };
  if (input.decision === 'reject' && !(input.reason ?? '').trim()) {
    return { ok: false, reason: 'a rejection says why — send: reject <number> <reason>' };
  }

  const waiting = await waitingFor(input.sender.userId);
  if (waiting.length === 0) return { ok: false, reason: 'nothing is waiting for your approval' };
  const chosen = match(waiting, input.documentNo);
  if (!chosen) {
    return {
      ok: false,
      reason: `'${input.documentNo.trim()}' is not one of the ${waiting.length} documents waiting for you`,
    };
  }

  // One live code per contact: the old one is cancelled, never left standing.
  await tx
    .update(whatsappAction)
    .set({ status: 'cancelled', settledAt: new Date() })
    .where(and(eq(whatsappAction.contactId, input.sender.contactId), eq(whatsappAction.status, 'awaiting')));

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const expiresAt = new Date(Date.now() + CODE_MINUTES * 60_000);
  await tx.insert(whatsappAction).values({
    contactId: input.sender.contactId,
    userId: input.sender.userId,
    groupJid: input.groupJid,
    documentType: chosen.documentType,
    documentId: chosen.documentId,
    documentNo: chosen.documentNumber,
    decision: input.decision,
    reason: input.reason?.trim() || null,
    code,
    expiresAt,
  });

  await audit.record(tx, {
    actorUserId: input.sender.userId,
    action: 'whatsapp.action_requested',
    objectType: 'whatsapp_action',
    objectId: chosen.documentId,
    after: { decision: input.decision, documentNo: chosen.documentNumber, documentType: chosen.documentType, via: input.groupJid ? 'group' : 'direct' },
    outcome: 'success',
  });

  return { ok: true, code, waiting: chosen, expiresAt };
}

export interface ConfirmOutcome {
  readonly ok: true;
  readonly decision: 'approve' | 'reject';
  readonly documentNo: string;
  readonly documentType: string;
  readonly status: string;
}

export type ConfirmResult = ConfirmOutcome | Refusal;

/**
 * Step two: the code comes back, and the ERP decides.
 *
 * The decision itself is a second transaction under the asker's own scope —
 * `approvals.decide` and everything beneath it (permissions, maker-checker,
 * the period, the document's own rules) sees the person, not the bridge. A
 * refusal is kept on the row and answered in words; it never silently passes.
 */
export async function confirm(
  tx: Tx,
  input: { readonly sender: ResolvedSender; readonly code: string },
): Promise<ConfirmResult> {
  const allowed = mayAct(input.sender);
  if (!allowed.ok) return { ok: false, reason: allowed.reason };

  const [row] = await tx
    .select()
    .from(whatsappAction)
    .where(and(eq(whatsappAction.contactId, input.sender.contactId), eq(whatsappAction.status, 'awaiting')))
    .limit(1);
  if (!row) return { ok: false, reason: 'nothing is waiting for a code' };

  if (row.expiresAt.getTime() < Date.now()) {
    // Marked, then refused — and because this is a value and not a throw, the
    // marking survives the transaction.
    await settle(tx, row.id, 'expired', 'the code expired');
    return { ok: false, reason: `that code expired — send the ${row.decision} again` };
  }
  if (row.code !== input.code.trim()) {
    // The row stays awaiting: a wrong digit is a typo, not a reason to throw
    // the request away. It still expires on its own.
    return { ok: false, reason: 'that code does not match' };
  }

  const principal = await principalOf(input.sender.userId);
  let refusal: string | null = null;
  let status = row.decision === 'approve' ? 'approved' : 'rejected';
  try {
    const result = await withScope(
      { userId: input.sender.userId, branchCode: row.groupJid ? (principal.defaultBranchCode ?? '') : (principal.defaultBranchCode ?? ''), isSuperUser: principal.isSuperUser },
      async (inner) => decideAs(inner, principal, row),
    );
    status = result.status ?? status;
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }

  await settle(tx, row.id, refusal ? 'refused' : 'done', refusal);
  await audit.record(tx, {
    actorUserId: input.sender.userId,
    action: refusal ? 'whatsapp.action_refused' : 'whatsapp.action_decided',
    objectType: 'whatsapp_action',
    objectId: row.documentId,
    after: { decision: row.decision, documentNo: row.documentNo, documentType: row.documentType, refusal },
    reason: row.reason,
    outcome: refusal ? 'denied' : 'success',
  });

  if (refusal) return { ok: false, reason: refusal };
  return { ok: true, decision: row.decision as 'approve' | 'reject', documentNo: row.documentNo, documentType: row.documentType, status };
}

async function decideAs(
  tx: Tx,
  principal: Principal,
  row: { documentType: string; documentId: string; decision: string; reason: string | null; groupJid: string | null },
): Promise<{ status: string | null }> {
  registerAllRecords();
  const result = await approvals.decide(tx, principal, {
    documentTypeCode: row.documentType,
    documentId: row.documentId,
    decision: row.decision as 'approve' | 'reject',
    reason: row.reason,
  });
  return { status: (result as { status?: string } | undefined)?.status ?? null };
}

async function settle(tx: Tx, id: string, status: 'done' | 'refused' | 'expired' | 'cancelled', refusal: string | null): Promise<void> {
  await tx
    .update(whatsappAction)
    .set({ status, refusal, settledAt: new Date() })
    .where(eq(whatsappAction.id, id));
}

/** Housekeeping: codes nobody answered stop being live. */
export async function expireStale(tx: Tx, now = new Date()): Promise<number> {
  const rows = await tx
    .update(whatsappAction)
    .set({ status: 'expired', refusal: 'the code expired', settledAt: now })
    .where(and(eq(whatsappAction.status, 'awaiting'), lt(whatsappAction.expiresAt, now)))
    .returning({ id: whatsappAction.id });
  return rows.length;
}

/** The outstanding request for a contact, for the log screen and the tests. */
export async function awaiting(tx: Tx, contactId: string) {
  const [row] = await tx
    .select()
    .from(whatsappAction)
    .where(and(eq(whatsappAction.contactId, contactId), eq(whatsappAction.status, 'awaiting')))
    .limit(1);
  return row ?? null;
}

export { whatsappContact, sql };
