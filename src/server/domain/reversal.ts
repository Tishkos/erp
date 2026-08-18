/**
 * Reversal engine — Phase 02.8.
 *
 * §14.3: "Manual Journal corrections use Full Reversal only."
 * §14.3: "Reversal Date must equal or be later than the original Posting Date."
 * §3.2:  "A posted document may be corrected only by the approved reversal or
 *         return document for that process."
 * Appendix C: "Original and reversal linked permanently."
 *
 * ── Why full only ───────────────────────────────────────────────────────────
 * A partial reversal is an adjustment wearing a correction's clothes. It leaves
 * the original standing with a different effective value than it states, so the
 * journal a reader sees and the balance it produced no longer agree. Full
 * reversal keeps both documents true: the original says what was posted, the
 * reversal says it was undone, and the net is exactly zero.
 *
 * ── Why the original's rates, not today's ───────────────────────────────────
 * The reversal copies the IQD and USD figures from the original rather than
 * reconverting. Reconverting at today's rate would leave a residue on every
 * account the journal touched — the reversal would not actually reverse it.
 * Whatever movement in rates has occurred is an FX matter (§16), not something
 * a correction should silently create.
 */
import type { JournalLineDraft } from './journal';

export type JournalStatusForReversal = string;

export interface ReversibleJournal {
  readonly id: string;
  readonly entryNo: string;
  readonly status: JournalStatusForReversal;
  readonly postingDate: string;
  /** 'manual' or 'system'. */
  readonly source: string;
  /** Set when this journal is itself a reversal of another. */
  readonly reversesId: string | null;
  /** Set when this journal has already been reversed. */
  readonly reversedById: string | null;
}

export class NotReversibleError extends Error {
  readonly code = 'JOURNAL_NOT_REVERSIBLE';
  constructor(
    readonly entryNo: string,
    detail: string,
  ) {
    super(`Journal ${entryNo} cannot be reversed: ${detail}`);
    this.name = 'NotReversibleError';
  }
}

export class ReversalDateError extends Error {
  readonly code = 'REVERSAL_DATE_INVALID';
  constructor(
    readonly entryNo: string,
    readonly reversalDate: string,
    readonly originalPostingDate: string,
  ) {
    super(
      `A reversal dated ${reversalDate} is earlier than journal ${entryNo}, which posted on ${originalPostingDate}. ` +
        'The reversal date must equal or follow the original posting date (§14.3) — otherwise the correction ' +
        'lands in a period before the thing it corrects.',
    );
    this.name = 'ReversalDateError';
  }
}

export class ReversalReasonRequiredError extends Error {
  readonly code = 'REVERSAL_REASON_REQUIRED';
  constructor(readonly entryNo: string) {
    super(
      `Reversing journal ${entryNo} requires a reason, and the reason is stored with both documents (§5.4).`,
    );
    this.name = 'ReversalReasonRequiredError';
  }
}

/**
 * Everything that must hold before a journal may be reversed.
 *
 * The last check is the one that is easy to miss: a reversal cannot itself be
 * reversed. Allowing it would recreate the original's effect under a third
 * document number, and the trail would read as three postings where the
 * business did one thing and undid it.
 */
export function assertReversible(journal: ReversibleJournal): void {
  if (journal.status !== 'posted') {
    throw new NotReversibleError(
      journal.entryNo,
      journal.status === 'reversed'
        ? 'it has already been reversed. A journal is reversed once, and the reversal is permanent.'
        : `it is ${journal.status}, not posted. Only a posted journal has an effect to reverse — cancel a draft instead (§3.2).`,
    );
  }

  if (journal.reversedById) {
    throw new NotReversibleError(
      journal.entryNo,
      'it has already been reversed. A journal is reversed once, and the reversal is permanent.',
    );
  }

  if (journal.reversesId) {
    throw new NotReversibleError(
      journal.entryNo,
      'it is itself a reversal. Reversing it would recreate the effect the original reversal removed — ' +
        'post a fresh journal instead, so the trail says what actually happened.',
    );
  }

  if (journal.source !== 'manual') {
    // §3.2 — an automatic journal belongs to its source document, and is
    // corrected by that document's own return or credit note.
    throw new NotReversibleError(
      journal.entryNo,
      'it was posted automatically from a source document. Correct it through that document’s approved ' +
        'reversal or return, so the subledger and the operational record stay in step (§3.2).',
    );
  }
}

export function assertReversalDate(
  journal: ReversibleJournal,
  reversalDate: string,
): void {
  if (reversalDate < journal.postingDate) {
    throw new ReversalDateError(journal.entryNo, reversalDate, journal.postingDate);
  }
}

export function assertReversalReason(entryNo: string, reason?: string | null): void {
  if (!reason?.trim()) {
    throw new ReversalReasonRequiredError(entryNo);
  }
}

/**
 * The mirrored lines.
 *
 * Debit becomes credit and credit becomes debit, in every currency, with the
 * dimensions and the account carried across unchanged. The net effect on every
 * account **and every dimension** is then exactly zero — which is the 02.8 gate,
 * and is why the dimensions are copied rather than re-derived.
 */
export function mirrorLines(lines: readonly JournalLineDraft[]): JournalLineDraft[] {
  return lines.map((line) => ({
    ...line,
    debitTxn: line.creditTxn,
    creditTxn: line.debitTxn,
    debitIqd: line.creditIqd,
    creditIqd: line.debitIqd,
    debitUsd: line.creditUsd,
    creditUsd: line.debitUsd,
  }));
}

/** The net movement of a set of lines, per account. Zero for original + reversal. */
export function netByAccount(lines: readonly JournalLineDraft[]): Map<string, bigint> {
  const net = new Map<string, bigint>();
  for (const line of lines) {
    const current = net.get(line.accountId) ?? 0n;
    net.set(line.accountId, current + line.debitIqd - line.creditIqd);
  }
  return net;
}
