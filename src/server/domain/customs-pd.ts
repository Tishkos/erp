/**
 * PD / ASYCUDA — REQ-AP-001 §16, the rules a database cannot hold.
 *
 *   * **Which PDs count.** A PD that a re-registration superseded is history;
 *     a rejected or expired one that nobody has re-registered is a stop.
 *   * **Pays against it?** Its status allows payment, it has not expired by
 *     the day the bank pays, and — when both name one — it is registered with
 *     the bank the money leaves from (§15.3 check 1).
 *   * **The ASYCUDA list.** What the customs officer pastes from the ASYCUDA
 *     document list — PD number, status, sometimes a date — read line by line
 *     into changes, with every line it cannot read named rather than dropped.
 */

export interface PdStatusRow {
  readonly code: string;
  readonly name: string;
  readonly asycudaLabel: string;
  readonly allowsPayment: boolean;
  readonly isTerminal: boolean;
  readonly isExpired: boolean;
  readonly active?: boolean;
}

export interface PdFacts {
  readonly id: string;
  readonly pdNo: string;
  readonly statusCode: string;
  readonly expiryDate: string;
  readonly bankCode: string | null;
  /** Another PD names this one in `supersedes_pd_id`. */
  readonly superseded: boolean;
}

export class PdValidationError extends Error {
  readonly code = 'PD_INVALID';
  constructor(detail: string) {
    super(detail);
    this.name = 'PdValidationError';
  }
}

/** Whole days from `today` to `date` (negative once it has passed). */
export function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** Registered and not dead: not superseded, not rejected, not expired. Written off counts. */
export function isLivePd(pd: PdFacts, statuses: ReadonlyMap<string, PdStatusRow>): boolean {
  if (pd.superseded) return false;
  const status = statuses.get(pd.statusCode);
  if (!status) return false;
  return !(status.isExpired || pd.statusCode === 'rejected');
}

/** §20.1 — every standing PD of the import is totally written off (and there is one). */
export function allWrittenOff(pds: readonly PdFacts[]): boolean {
  const standing = pds.filter((pd) => !pd.superseded);
  return standing.length > 0 && standing.every((pd) => pd.statusCode === 'totally_written_off');
}

/** A rejected or expired PD nobody re-registered: the import stops on it (§16.2). */
export function needsReRegistration(pd: PdFacts, statuses: ReadonlyMap<string, PdStatusRow>): boolean {
  if (pd.superseded) return false;
  const status = statuses.get(pd.statusCode);
  return Boolean(status && (status.isExpired || pd.statusCode === 'rejected'));
}

export interface PaymentReadiness {
  readonly outcome: 'pass' | 'fail';
  readonly detail: string;
  /** The PD the bank pays against, when there is one. */
  readonly pdId: string | null;
}

/**
 * §15.3 check 1 — "needs validated PD". The PD must allow payment and still
 * be valid on the day; when the account and the PD both name their bank, the
 * two must be the same bank.
 */
export function paymentReadiness(
  pds: readonly PdFacts[],
  statuses: ReadonlyMap<string, PdStatusRow>,
  input: { asOf: string; accountBankCode: string | null; bankName?: (code: string) => string },
): PaymentReadiness {
  const name = (code: string) => input.bankName?.(code) ?? code;
  const standing = pds.filter((pd) => !pd.superseded);
  const payable = standing.filter((pd) => {
    const status = statuses.get(pd.statusCode);
    return Boolean(status?.allowsPayment && !status.isExpired && pd.expiryDate >= input.asOf);
  });

  if (payable.length === 0) {
    if (standing.length === 0) {
      return {
        outcome: 'fail',
        detail: 'No PD is registered for this import — the bank pays only against a validated PD.',
        pdId: null,
      };
    }
    const why = standing
      .map((pd) => {
        const status = statuses.get(pd.statusCode);
        if (status?.allowsPayment && pd.expiryDate < input.asOf) return `PD ${pd.pdNo} expired on ${pd.expiryDate}`;
        return `PD ${pd.pdNo} is ${status?.name ?? pd.statusCode}`;
      })
      .join('; ');
    return { outcome: 'fail', detail: `${why} — the bank pays only against a validated PD.`, pdId: null };
  }

  const sameBank = input.accountBankCode
    ? payable.find((pd) => pd.bankCode === input.accountBankCode || pd.bankCode === null)
    : payable[0];
  if (!sameBank) {
    const pd = payable[0]!;
    return {
      outcome: 'fail',
      detail:
        `PD ${pd.pdNo} is registered with ${name(pd.bankCode!)} and the money would leave from ` +
        `${name(input.accountBankCode!)} — pay from an account of the PD's bank.`,
      pdId: pd.id,
    };
  }
  return {
    outcome: 'pass',
    detail: `PD ${sameBank.pdNo} is validated, valid until ${sameBank.expiryDate}.`,
    pdId: sameBank.id,
  };
}

/** The status an expiring PD moves to (§16.2): validated or partly written off, expired. */
export function expiredStatusFor(statusCode: string): string | null {
  if (statusCode === 'validated') return 'expired_validated';
  if (statusCode === 'partially_written_off') return 'expired_part_written_off';
  return null;
}

// ---------------------------------------------------------------------------
// The ASYCUDA list
// ---------------------------------------------------------------------------

export interface AsycudaLine {
  readonly line: number;
  readonly pdNo: string;
  readonly statusCode: string;
  readonly effectiveDate: string | null;
}

export interface AsycudaUnreadable {
  readonly line: number;
  readonly text: string;
  readonly why: string;
}

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z]/g, '');

function dateOf(token: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(token);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(token);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  return null;
}

/**
 * Reads a pasted ASYCUDA list. A line is the PD number, then the status as
 * ASYCUDA writes it ("Validated", "Partially Written Off", even "Submited"),
 * then optionally a date — separated by tabs, commas, semicolons or two or
 * more spaces. A header line, a blank line, a status nobody configured: each
 * is reported with its line number, never silently skipped.
 */
export function parseAsycudaList(
  text: string,
  statuses: readonly PdStatusRow[],
): { rows: AsycudaLine[]; unreadable: AsycudaUnreadable[] } {
  const byLabel = new Map<string, string>();
  for (const status of statuses) {
    if (status.active === false) continue;
    byLabel.set(normalise(status.asycudaLabel), status.code);
    byLabel.set(normalise(status.name), status.code);
    byLabel.set(normalise(status.code), status.code);
  }

  const rows: AsycudaLine[] = [];
  const unreadable: AsycudaUnreadable[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed) return;
    // The PD number first (it has digits in it), then everything else.
    const head = /^([A-Za-z0-9/-]*\d[A-Za-z0-9/-]*)[\s,;]+(.+)$/.exec(trimmed);
    if (!head) {
      unreadable.push({ line, text: trimmed, why: 'needs a PD number and then a status' });
      return;
    }
    const rest = head[2]!;
    const dated = /(\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{4})/.exec(rest);
    const effectiveDate = dated ? dateOf(dated[1]!) : null;
    const statusText = (dated ? rest.replace(dated[0], ' ') : rest).replace(/[\t,;]+/g, ' ').trim();
    const statusCode = byLabel.get(normalise(statusText));
    if (!statusCode) {
      unreadable.push({ line, text: trimmed, why: `"${statusText}" is not a PD status` });
      return;
    }
    rows.push({ line, pdNo: head[1]!.toUpperCase(), statusCode, effectiveDate });
  });
  return { rows, unreadable };
}
