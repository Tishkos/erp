/**
 * CRM rules — Phase 08, §6.
 *
 * > §6: *"A lead can exist without an approved Business Partner; a Sales Order,
 * > Project, invoice or service transaction cannot."*
 * > §6: *"Duplicate detection by name, phone, email, registration number and
 * > bank details."*
 * > §6: *"Completed activities and stage changes remain in the audit trail."*
 * > Appendix B, Opportunity: Open, Qualified, Won, Lost, Closed · effect:
 * > **No posting.**
 *
 * CRM is the module that comes *before* money. Nothing here posts, nothing here
 * commits stock, and nothing here creates an obligation — which is exactly why
 * the one rule worth being strict about is **identity**: the lead, the
 * opportunity, the order and the project must all be provably the same customer
 * and the same source, or §6's first acceptance criterion is unprovable.
 *
 * Pure. Money is scaled at 10^4; probability is a whole percentage.
 */
import { toDecimalString } from './money';

// ---------------------------------------------------------------------------
// Duplicate detection — §6
// ---------------------------------------------------------------------------

/** §6's five criteria, named. The order is §6's own. */
export const DUPLICATE_CRITERIA = [
  'name',
  'phone',
  'email',
  'registration_number',
  'bank_details',
] as const;

export type DuplicateCriterion = (typeof DUPLICATE_CRITERIA)[number];

export interface Identity {
  readonly name: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly registrationNo: string | null;
  /** An account number or IBAN, however it was typed. */
  readonly bankAccountNumber: string | null;
}

export interface DuplicateHit {
  readonly criterion: DuplicateCriterion;
  readonly value: string;
}

/**
 * Comparison forms, chosen per field because the ways people mistype them
 * differ.
 *
 * A phone number is compared on its digits: `+964 770 123 4567`,
 * `00964-770-1234567` and `07701234567` are one number typed three ways, and a
 * duplicate check that missed that would miss most real duplicates. An email is
 * lower-cased but not otherwise touched, because the local part is technically
 * case-sensitive and stripping punctuation would merge genuinely different
 * addresses. A name is squeezed to letters and digits, so "Al-Rasheed Trading
 * Co." and "Al Rasheed Trading Co" collide as they should.
 */
function comparable(criterion: DuplicateCriterion, value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  switch (criterion) {
    case 'phone': {
      // Keep the digits, and drop an international prefix so the same number
      // dialled two ways is one number. Iraq is +964; a leading 0 is the
      // domestic trunk code for the same subscriber.
      const digits = trimmed.replace(/\D+/g, '').replace(/^00964|^964/, '').replace(/^0/, '');
      return digits.length >= 6 ? digits : null;
    }
    case 'email':
      return trimmed.toLowerCase();
    case 'bank_details':
      return trimmed.toUpperCase().replace(/[^A-Z0-9]+/g, '');
    default:
      return trimmed.toLowerCase().replace(/[^a-z0-9]+/g, '');
  }
}

/**
 * §6 — *"duplicate detection by name, phone, email, registration number and bank
 * details."*
 *
 * Returns **every** criterion that matched rather than the first, and returns
 * them rather than throwing. Both are deliberate: a match on a phone number is a
 * different kind of evidence from a match on a name, and the person deciding
 * whether this really is the same customer needs to see which. §6 asks for
 * detection, not prevention — the same distinction §8.4's tolerance and §15's
 * blocked supplier draw.
 */
export function findDuplicates(
  candidate: Identity,
  existing: Identity,
): DuplicateHit[] {
  const fields: Record<DuplicateCriterion, [string | null, string | null]> = {
    name: [candidate.name, existing.name],
    phone: [candidate.phone, existing.phone],
    email: [candidate.email, existing.email],
    registration_number: [candidate.registrationNo, existing.registrationNo],
    bank_details: [candidate.bankAccountNumber, existing.bankAccountNumber],
  };

  const hits: DuplicateHit[] = [];

  for (const criterion of DUPLICATE_CRITERIA) {
    const [left, right] = fields[criterion];
    const a = comparable(criterion, left);
    const b = comparable(criterion, right);
    if (a !== null && b !== null && a === b) {
      hits.push({ criterion, value: (left as string).trim() });
    }
  }

  return hits;
}

// ---------------------------------------------------------------------------
// Opportunity stages — Appendix B
// ---------------------------------------------------------------------------

/** Appendix B's own list, in its own order. */
export const OPPORTUNITY_STAGES = ['open', 'qualified', 'won', 'lost', 'closed'] as const;
export type OpportunityStage = (typeof OPPORTUNITY_STAGES)[number];

const ALLOWED: Record<OpportunityStage, readonly OpportunityStage[]> = {
  open: ['qualified', 'lost', 'closed'],
  qualified: ['won', 'lost', 'closed'],
  // Won and lost are outcomes; closed is the filing of an outcome.
  won: ['closed'],
  lost: ['closed'],
  closed: [],
};

export class StageTransitionError extends Error {
  readonly code = 'OPPORTUNITY_STAGE_INVALID';
  constructor(
    readonly from: OpportunityStage,
    readonly to: OpportunityStage,
  ) {
    super(
      `An opportunity cannot go from '${from}' to '${to}' (Appendix B). ` +
        (from === 'won' || from === 'lost' || from === 'closed'
          ? 'It has already been decided; a new approach to the same customer is a new opportunity, ' +
            'which keeps the pipeline honest about how often we win.'
          : `From '${from}' it can go to: ${ALLOWED[from].join(', ')}.`),
    );
    this.name = 'StageTransitionError';
  }
}

/**
 * Appendix B's stages, as a machine.
 *
 * Re-opening a won or lost opportunity is refused, and that is the rule that
 * matters. A pipeline where yesterday's loss can quietly become today's open
 * opportunity reports a conversion rate that nobody can rely on — and §6's
 * lost-opportunity report exists precisely to be read.
 */
export function assertStageTransition(from: OpportunityStage, to: OpportunityStage): void {
  if (!ALLOWED[from].includes(to)) throw new StageTransitionError(from, to);
}

export class LostNeedsReasonError extends Error {
  readonly code = 'LOST_NEEDS_REASON';
  constructor() {
    super(
      'A lost opportunity needs a reason (§6). The lost-opportunity report is the only place the ' +
        'company finds out why it loses, and a report of blanks teaches nothing.',
    );
    this.name = 'LostNeedsReasonError';
  }
}

export function assertLostHasReason(to: OpportunityStage, reason: string | null): void {
  if (to !== 'lost') return;
  if (!reason || !reason.trim()) throw new LostNeedsReasonError();
}

// ---------------------------------------------------------------------------
// Identity carried across a conversion — §6 acceptance criterion 1
// ---------------------------------------------------------------------------

export interface SourceIdentity {
  /** The business partner, once one exists. Null on an unqualified lead. */
  readonly partnerId: string | null;
  readonly leadSourceCode: string | null;
  readonly campaignCode: string | null;
}

export class IdentityNotCarriedError extends Error {
  readonly code = 'IDENTITY_NOT_CARRIED';
  constructor(readonly field: string) {
    super(
      `The ${field} changed during the conversion (§6 acceptance criterion 1). ` +
        'A lead, its opportunity and the order it becomes are one customer and one source; if they ' +
        'can differ, no report can say which campaign produced which revenue.',
    );
    this.name = 'IdentityNotCarriedError';
  }
}

/**
 * §6 acceptance criterion 1 — *"lead-to-opportunity and opportunity-to-order /
 * project conversion retain the same customer and source identifiers."*
 *
 * Written as an assertion over the two records rather than as a copy, because
 * copying is what the service does and this is what proves the copy was
 * faithful. The customer may be **filled in** by the conversion — a lead is
 * allowed to have no partner and an opportunity is not — but it may never
 * *change*.
 */
export function assertIdentityCarried(from: SourceIdentity, to: SourceIdentity): void {
  if (from.partnerId !== null && from.partnerId !== to.partnerId) {
    throw new IdentityNotCarriedError('customer');
  }
  if (from.leadSourceCode !== null && from.leadSourceCode !== to.leadSourceCode) {
    throw new IdentityNotCarriedError('lead source');
  }
  if (from.campaignCode !== null && from.campaignCode !== to.campaignCode) {
    throw new IdentityNotCarriedError('campaign');
  }
}

// ---------------------------------------------------------------------------
// Pipeline arithmetic — §6, Appendix D
// ---------------------------------------------------------------------------

export interface PipelineEntry {
  readonly stage: OpportunityStage;
  readonly ownerUserId: string;
  readonly expectedValueIqd: bigint;
  readonly probabilityPercent: number;
}

export interface PipelineTotal {
  readonly stage: OpportunityStage;
  readonly count: number;
  readonly expectedValueIqd: string;
  /** Expected value weighted by probability — the number sales actually plan on. */
  readonly weightedValueIqd: string;
}

/**
 * Appendix D — *"pipeline by stage and owner."*
 *
 * Both an unweighted and a weighted total, because they answer different
 * questions: the first is what is on the table, the second is what a treasurer
 * should believe. Reporting only the first is how a forecast becomes a wish.
 */
export function pipelineByStage(entries: readonly PipelineEntry[]): PipelineTotal[] {
  const byStage = new Map<OpportunityStage, { count: number; value: bigint; weighted: bigint }>();

  for (const entry of entries) {
    const current = byStage.get(entry.stage) ?? { count: 0, value: 0n, weighted: 0n };
    byStage.set(entry.stage, {
      count: current.count + 1,
      value: current.value + entry.expectedValueIqd,
      weighted:
        current.weighted + (entry.expectedValueIqd * BigInt(entry.probabilityPercent)) / 100n,
    });
  }

  return OPPORTUNITY_STAGES.filter((stage) => byStage.has(stage)).map((stage) => {
    const totals = byStage.get(stage)!;
    return {
      stage,
      count: totals.count,
      expectedValueIqd: toDecimalString(totals.value, 4n),
      weightedValueIqd: toDecimalString(totals.weighted, 4n),
    };
  });
}

/**
 * Appendix D — *"lead-source conversion."*
 *
 * Counted from what actually happened, never estimated: leads that reached an
 * opportunity, and opportunities that were won. A rate computed from anything
 * else is a rate that flatters whichever source somebody believes in.
 */
export function conversionRate(converted: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((converted / total) * 1000) / 10;
}
