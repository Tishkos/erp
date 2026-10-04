/**
 * Import logistics — REQ-LOG-001. The rules the Logistics screens read, pure and
 * framework-free, so a unit test holds them without a database.
 *
 *   * **Shipment tracking.** What a container is waiting for next, from the
 *     stage it is at and the dates it carries; how late it is against its ETA.
 *   * **The customs declaration's life.** Draft → Submitted → Accepted →
 *     Assessed → Cleared, or Cancelled / Rejected on the way. Forward only; the
 *     three ends are final. The figures on it are what was *declared* — the
 *     money is the import's landed-cost charges, never this record.
 *   * **A charge's state** on the registers: withdrawn, locked, or waiting.
 */

// ---------------------------------------------------------------------------
// Shipment tracking
// ---------------------------------------------------------------------------

export const NEXT_ACTIONS = [
  'load',
  'await_arrival',
  'chase_eta',
  'clear_customs',
  'send_port_file',
  'receive',
  'claim_shortage',
] as const;
export type NextAction = (typeof NEXT_ACTIONS)[number];

/**
 * What the container waits for next. Null when nothing is left to do: it was
 * received whole, or cancelled.
 */
export function nextAction(container: {
  readonly statusCode: string;
  readonly cancelled: boolean;
  readonly customsClearedOn: string | null;
  readonly portFileSentOn: string | null;
}): NextAction | null {
  if (container.cancelled) return null;
  switch (container.statusCode) {
    case 'not_loaded':
      return 'load';
    case 'on_sea':
      return 'await_arrival';
    case 'late':
      return 'chase_eta';
    case 'at_port':
      return 'clear_customs';
    case 'customs_cleared':
      return container.portFileSentOn ? 'receive' : 'send_port_file';
    case 'missing_damaged':
      return 'claim_shortage';
    default:
      return null;
  }
}

const DAY = 86_400_000;

/** Whole days between two business dates (`to − from`). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
}

/**
 * Days past the ETA for a container not yet received; zero when it is on
 * time or has no ETA; null once it is in (its delay is history, not news).
 */
export function delayDays(eta: string | null, receivedOn: string | null, asOf: string): number | null {
  if (receivedOn) return null;
  if (!eta) return 0;
  const late = daysBetween(eta, asOf);
  return late > 0 ? late : 0;
}

// ---------------------------------------------------------------------------
// The customs declaration
// ---------------------------------------------------------------------------

export const DECLARATION_STATUSES = ['draft', 'submitted', 'accepted', 'assessed', 'cleared', 'cancelled', 'rejected'] as const;
export type DeclarationStatus = (typeof DECLARATION_STATUSES)[number];

export const DECLARATION_FINAL: readonly DeclarationStatus[] = ['cleared', 'cancelled', 'rejected'];

/** Where a declaration may go from where it is — forward, one step, or out. */
const MOVES: Readonly<Record<DeclarationStatus, readonly DeclarationStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['accepted', 'rejected', 'cancelled'],
  accepted: ['assessed', 'rejected', 'cancelled'],
  assessed: ['cleared', 'rejected', 'cancelled'],
  cleared: [],
  cancelled: [],
  rejected: [],
};

export class DeclarationRuleError extends Error {
  readonly code = 'CUSTOMS_DECLARATION_RULE';
  constructor(detail: string) {
    super(detail);
    this.name = 'DeclarationRuleError';
  }
}

export function isDeclarationStatus(value: string): value is DeclarationStatus {
  return (DECLARATION_STATUSES as readonly string[]).includes(value);
}

export function nextDeclarationStatuses(from: DeclarationStatus): readonly DeclarationStatus[] {
  return MOVES[from];
}

/** Refuses a move the declaration's life does not have, saying why. */
export function assertDeclarationMove(declarationNo: string, from: DeclarationStatus, to: DeclarationStatus): void {
  if (DECLARATION_FINAL.includes(from)) {
    throw new DeclarationRuleError(`${declarationNo} is ${from}; a ${from} declaration is the record and does not move again.`);
  }
  if (!MOVES[from].includes(to)) {
    const allowed = MOVES[from].join(', ');
    throw new DeclarationRuleError(`${declarationNo} is ${from}; from there it goes to ${allowed} — not ${to}.`);
  }
}

/** The status chip each declaration status wears — the shared palette, nothing new drawn. */
export function declarationChip(status: string): string {
  switch (status) {
    case 'cleared':
      return 'settled';
    case 'assessed':
    case 'accepted':
      return 'approved';
    case 'submitted':
      return 'submitted';
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    default:
      return 'draft';
  }
}

// ---------------------------------------------------------------------------
// A landed-cost charge, as the registers show it
// ---------------------------------------------------------------------------

export type ChargeState = 'withdrawn' | 'locked' | 'unlocked';

export function chargeState(charge: { readonly cancelledAt: unknown; readonly lockId: string | null }): ChargeState {
  if (charge.cancelledAt) return 'withdrawn';
  return charge.lockId ? 'locked' : 'unlocked';
}

/** The register's charge types (REQ-LOG-001 Q5: insurance and handling are `other`). */
export const DUTY_TYPES = ['customs_asycuda'] as const;
export const FREIGHT_TYPES = ['freight', 'port_forwarding', 'other'] as const;

/**
 * Why the landed cost is where it is, as one code a screen can translate —
 * `landed-cost.lockableState`'s answer said in a word.
 */
export function lockReason(state: {
  readonly pdsWrittenOff: boolean;
  readonly containersIn: boolean;
  readonly unlocked: number;
  readonly locked: boolean;
}): 'locked' | 'late_charges' | 'ready' | 'waiting_pds' | 'waiting_containers' | 'nothing_charged' {
  if (state.locked) return state.unlocked > 0 ? 'late_charges' : 'locked';
  if (state.unlocked === 0) return 'nothing_charged';
  if (!state.pdsWrittenOff) return 'waiting_pds';
  if (!state.containersIn) return 'waiting_containers';
  return 'ready';
}
