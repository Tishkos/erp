/**
 * Proposing and running an action from chat — REQ-WA-001 WA-8, the service.
 *
 * Two halves, deliberately far apart:
 *
 *   `prepare`  reads. It resolves what was named into a real document under
 *              the asker's own read-only scope, refuses what cannot be done
 *              before anybody is asked to confirm it, and writes the sentence
 *              of facts Noah has to put to them. Nothing changes here.
 *   `run`      writes, once, after a person has said yes. It calls the ERP's
 *              own service as that person; every rule the screen enforces is
 *              enforced here because it is the same code path.
 *
 * Adding an action is adding a case to each half and a name to
 * `ACTION_NAMES`. Resist adding one whose service does not already refuse
 * properly on its own: this file must never be the thing that decides whether
 * something is allowed.
 */
import { withScope, type Tx } from '../db/client';
import type { Principal } from '../domain/permissions';
import { money } from '../domain/whatsapp';
import { actionLabel, type ActionName, type PendingAction } from '../domain/whatsapp-do';
import { registerAllRecords } from '../records';
import * as approvals from './approvals';
import * as audit from './audit';
import * as openingStockService from './opening-stock';
import { principalOf, type ReadContext } from './whatsapp';
import { waitingFor } from './whatsapp-actions';

const NL = String.fromCharCode(10);

export type Prepared = { readonly ok: true; readonly pending: PendingAction } | { readonly ok: false; readonly reason: string };
export type Ran = { readonly ok: true; readonly said: string } | { readonly ok: false; readonly reason: string };

/**
 * What a document's number was given as, tidied.
 *
 * People type a number out of a message they are looking at, so it arrives
 * with the case and spacing of wherever it was copied from.
 */
function documentNumber(args: Record<string, unknown>): string {
  return String(args.document ?? args.documentNo ?? args.no ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Resolve and describe, without changing anything.
 *
 * The refusals here are the ones worth giving before a person is asked to
 * confirm: a document that does not exist, one that is not in a state to be
 * acted on, one that is not theirs to decide. Everything else — their
 * permissions, the maker-checker rule, the period — is the service's to
 * refuse at the moment it runs, and it says so in its own words.
 */
export async function prepare(input: {
  readonly ctx: ReadContext;
  readonly userId: string;
  readonly chat: string;
  readonly action: string;
  readonly args: Record<string, unknown>;
  readonly now?: Date;
}): Promise<Prepared> {
  const action = input.action as ActionName;
  const no = documentNumber(input.args);
  const reason = String(input.args.reason ?? '').trim() || null;
  const proposedAt = (input.now ?? new Date()).toISOString();
  const base = { action, userId: input.userId, chat: input.chat, reason, proposedAt };

  if (action === 'approve_document' || action === 'reject_document') {
    if (!no) return { ok: false, reason: 'Which document? I need its number.' };
    if (action === 'reject_document' && !reason) {
      return { ok: false, reason: 'A rejection needs a reason — ask them what it is and propose it again with the reason.' };
    }
    // Only what is already waiting for this person: there is no "approve
    // anything by number" path, exactly as in WA-6.
    const waiting = await waitingFor(input.userId);
    const found = waiting.find((item) => item.documentNumber.toUpperCase() === no);
    if (!found) {
      const list = waiting.length > 0 ? waiting.map((item) => item.documentNumber).join(', ') : 'nothing';
      return {
        ok: false,
        reason: `${no} is not waiting for their decision. What is: ${list}. Tell them that, and that a document has to be routed to them before they can decide it.`,
      };
    }
    const verb = action === 'approve_document' ? 'approve' : 'reject';
    const sentence = [
      `${verb} ${found.documentNumber} (${found.documentType.replace(/_/g, ' ')})`,
      `raised by ${found.submittedByName ?? 'somebody'} on ${found.submittedAt.toISOString().slice(0, 10)}${found.branchCode ? `, branch ${found.branchCode}` : ''}`,
      reason ? `reason: ${reason}` : '',
      verb === 'approve'
        ? 'Approving it lets it take effect, and a posted document is reversed afterwards rather than edited.'
        : 'Rejecting it sends it back to whoever raised it.',
    ]
      .filter((part) => part !== '')
      .join(NL);
    return {
      ok: true,
      pending: {
        ...base,
        target: { kind: found.documentType, id: found.documentId, documentNo: found.documentNumber, branchCode: found.branchCode },
        sentence,
      },
    };
  }

  if (action === 'approve_opening_stock') {
    if (!no) return { ok: false, reason: 'Which opening stock document? I need its number, such as OPN-HQ-2026-000008.' };
    const found = await openingStockService.viewByNo(input.ctx.tx, no);
    if (!found) return { ok: false, reason: `There is no opening stock document ${no} on the system.` };
    const header = (found as unknown as { document?: Record<string, unknown> }).document ?? (found as unknown as Record<string, unknown>);
    const lines = (found as unknown as { lines?: Record<string, unknown>[] }).lines ?? [];
    const status = String(header.status ?? '');
    if (status !== 'submitted') {
      return {
        ok: false,
        reason: `${no} is ${status || 'in an unknown state'}, and only a submitted document can be approved. Tell them what state it is in.`,
      };
    }
    // Each line already carries its own value, worked out by the service that
    // owns the arithmetic. Summing those is right; multiplying quantity by
    // cost again here would be a second opinion on the company's money.
    const total = lines.reduce((sum, line) => sum + (Number(line.totalIqd ?? 0) || 0), 0);
    const sentence = [
      `approve opening stock ${no} for ${String(header.warehouseName ?? header.warehouseCode ?? 'the warehouse')}`,
      `${lines.length} line(s), ${money(total)} IQD at cost`,
      'This posts the quantities into the inventory ledger and opens their FIFO cost layers. From then on the stock is real: it can be sold and moved, and the document cannot be edited — only reversed.',
    ].join(NL);
    return {
      ok: true,
      pending: {
        ...base,
        target: {
          kind: 'opening_stock',
          id: String(header.id ?? ''),
          documentNo: no,
          branchCode: (header.branchCode as string | null) ?? null,
        },
        sentence,
      },
    };
  }

  return { ok: false, reason: `I cannot do "${input.action}". What I can do: ${actionNames()}.` };
}

function actionNames(): string {
  return 'approve or reject a document that is waiting for you, and approve opening stock';
}

/**
 * Do it.
 *
 * In its own writable transaction, as the person who said yes, through the
 * ERP's own service. A refusal from the service is returned in its own words
 * rather than thrown: it is the answer, and the audit row for the attempt has
 * to survive it.
 */
export async function run(input: {
  readonly userId: string;
  readonly pending: PendingAction;
  readonly e164: string;
}): Promise<Ran> {
  registerAllRecords();
  const principal: Principal = await principalOf(input.userId);
  const branchCode = input.pending.target.branchCode ?? principal.defaultBranchCode ?? '';
  const scope = { userId: input.userId, branchCode, isSuperUser: principal.isSuperUser };

  try {
    return await withScope(scope, async (tx) => {
      const said = await perform(tx, principal, branchCode, input.pending);
      await auditDone(tx, input, 'success', said);
      return { ok: true, said } as const;
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // The attempt is recorded even though it failed, in its own transaction —
    // the one it was refused in has been rolled back.
    await withScope(scope, (tx) => auditDone(tx, input, 'denied', reason)).catch(() => {
      /* the refusal is the answer; a failed audit of it must not hide it */
    });
    return { ok: false, reason };
  }
}

async function perform(tx: Tx, principal: Principal, branchCode: string, pending: PendingAction): Promise<string> {
  if (pending.action === 'approve_document' || pending.action === 'reject_document') {
    const decision = pending.action === 'approve_document' ? 'approve' : 'reject';
    await approvals.decide(tx, principal, {
      documentTypeCode: pending.target.kind,
      documentId: pending.target.id,
      decision,
      reason: pending.reason,
      branchCode: pending.target.branchCode,
    });
    return `${pending.target.documentNo} ${decision === 'approve' ? 'approved' : 'rejected'}.`;
  }

  const result = await openingStockService.approve(tx, { principal, branchCode }, pending.target.id);
  const movements = result.movementIds.length;
  return [
    `${pending.target.documentNo} approved.`,
    `${movements} stock movement(s) posted${result.journalEntryId ? ' and the opening journal raised' : ''}.`,
    'The quantities are in the inventory ledger now, so the warehouse reports will show them.',
  ].join(' ');
}

function auditDone(
  tx: Tx,
  input: { readonly userId: string; readonly pending: PendingAction; readonly e164: string },
  outcome: 'success' | 'denied',
  detail: string,
) {
  return audit.record(tx, {
    actorUserId: input.userId,
    action: `whatsapp.action.${input.pending.action}`,
    objectType: input.pending.target.kind,
    objectId: input.pending.target.id || input.pending.target.documentNo,
    branchCode: input.pending.target.branchCode,
    outcome: outcome === 'success' ? 'success' : 'denied',
    after: {
      e164: input.e164,
      chat: input.pending.chat,
      documentNo: input.pending.target.documentNo,
      what: actionLabel(input.pending.action),
      proposedAt: input.pending.proposedAt,
      confirmed: true,
      detail: detail.slice(0, 500),
    },
  });
}
