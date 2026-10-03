/**
 * Employee requests and documents — REQ-HR-001 Stage HR-6: the rules, with
 * no database.
 *
 * A request is one of four kinds, each numbered in its own series: an expense
 * claim (ECLM), a trip (TRV), a letter (LTR) or anything else (ERQ). Every
 * kind is asked, submitted and approved or refused; then a claim is
 * reimbursed and a letter issued, while a trip or another request ends at
 * its approval. A claim may name its trip: what the trip's advance still
 * owes is settled from the claim before any cash is paid (B-HR-28).
 *
 * A document is valid until it is superseded by its renewal or withdrawn
 * with a reason; its expiry is read against the day and the warning limit.
 */
import { MONEY_SCALE } from './money';

export const REQUEST_KINDS = ['expense_claim', 'travel', 'letter', 'other'] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATUSES = ['draft', 'submitted', 'approved', 'refused', 'paid', 'issued', 'cancelled'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Each kind's series: the number says what the paper is. */
export const REQUEST_SERIES: Readonly<Record<RequestKind, string>> = {
  expense_claim: 'EXPENSE_CLAIM',
  travel: 'TRAVEL_REQUEST',
  letter: 'HR_LETTER',
  other: 'EMPLOYEE_REQUEST',
};

/** The document type each kind posts or prints as. */
export const REQUEST_DOCUMENT_TYPE: Readonly<Record<RequestKind, string>> = {
  expense_claim: 'expense_claim',
  travel: 'travel_request',
  letter: 'hr_letter',
  other: 'employee_request',
};

export const LETTER_TYPES = ['employment', 'experience', 'other'] as const;
export type LetterType = (typeof LETTER_TYPES)[number];

export class RequestError extends Error {
  readonly code = 'HR_REQUEST';
  constructor(message: string) {
    super(message);
    this.name = 'RequestError';
  }
}

export const isRequestKind = (value: string): value is RequestKind => (REQUEST_KINDS as readonly string[]).includes(value);

/** Where a request of this kind may go from here. */
export function nextStatuses(kind: RequestKind, from: string): RequestStatus[] {
  switch (from) {
    case 'draft':
      return ['submitted', 'cancelled'];
    case 'submitted':
      return ['approved', 'refused', 'cancelled'];
    case 'approved':
      // A claim waits to be reimbursed, a letter to be issued; until then it may still be called off.
      if (kind === 'expense_claim') return ['paid', 'cancelled'];
      if (kind === 'letter') return ['issued', 'cancelled'];
      return [];
    default:
      return [];
  }
}

export function assertRequestTransition(requestNo: string, kind: RequestKind, from: string, to: RequestStatus): void {
  if (!nextStatuses(kind, from).includes(to)) throw new RequestError(`${requestNo} is ${from}; it cannot become ${to}.`);
}

const DINAR = 10n ** MONEY_SCALE;

/**
 * A claim reimbursed against its trip's advance: what the advance still owes
 * is settled first, up to the claim; the rest is paid. Nothing is paid twice
 * and the advance never goes below nothing.
 */
export function claimSettlement(claim: bigint, advanceOwed: bigint): { offset: bigint; cash: bigint } {
  if (claim <= 0n) throw new RequestError('A claim of nothing is not reimbursed.');
  const owed = advanceOwed > 0n ? advanceOwed : 0n;
  const offset = owed < claim ? owed : claim;
  return { offset, cash: claim - offset };
}

/**
 * The first month a trip's advance is recovered from pay when no claim has
 * settled it: the second month after the trip ends — a month to claim.
 */
export function tripAdvanceFirstMonth(travelTo: string): string {
  const [y, m] = travelTo.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m + 1, 1)).toISOString().slice(0, 10);
}

/** An estimate turned into an advance: whole dinars, rounded up so the trip is covered. */
export function wholeDinarsUp(amount: bigint): bigint {
  return amount % DINAR === 0n ? amount : (amount / DINAR + 1n) * DINAR;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DOCUMENT_TYPES = ['contract', 'national_id', 'passport', 'residence', 'work_permit', 'certificate', 'licence', 'handover', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const isDocumentType = (value: string): value is DocumentType => (DOCUMENT_TYPES as readonly string[]).includes(value);

export type ExpiryState = 'no_expiry' | 'valid' | 'expiring' | 'expired';

const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / 86_400_000;

/** Days from `today` to `expiresOn` (negative once it has passed). */
export function daysLeft(expiresOn: string, today: string): number {
  return Math.round(dayNumber(expiresOn) - dayNumber(today));
}

/** Where a document's expiry stands today, against the warning limit in days. */
export function expiryState(expiresOn: string | null, today: string, warnDays: number): ExpiryState {
  if (!expiresOn) return 'no_expiry';
  const left = daysLeft(expiresOn, today);
  if (left < 0) return 'expired';
  return left <= warnDays ? 'expiring' : 'valid';
}

// ---------------------------------------------------------------------------
// Letters
// ---------------------------------------------------------------------------

export interface LetterFacts {
  readonly fullName: string;
  readonly employeeNo: string;
  readonly position: string | null;
  readonly department: string;
  readonly hireDate: string;
  readonly endDate: string | null;
  readonly addressedTo: string | null;
  readonly company: string;
}

/**
 * The letter's text as HR is offered it to issue — in English; HR may edit it
 * (or write the Arabic) before issuing, and what is issued is kept as issued.
 */
export function letterText(type: LetterType, facts: LetterFacts): string {
  const to = facts.addressedTo?.trim() ? facts.addressedTo.trim() : 'To whom it may concern';
  const role = facts.position ? `${facts.position}, ${facts.department}` : facts.department;
  if (type === 'employment')
    return `${to},\n\nThis is to certify that ${facts.fullName} (${facts.employeeNo}) has been employed by ${facts.company} since ${facts.hireDate} and works as ${role}.\n\nThis letter is issued at their request.`;
  if (type === 'experience')
    return `${to},\n\nThis is to certify that ${facts.fullName} (${facts.employeeNo}) worked for ${facts.company} from ${facts.hireDate}${facts.endDate ? ` to ${facts.endDate}` : ''} as ${role}.\n\nWe wish them well.`;
  return `${to},\n\n`;
}
