/**
 * A sample document, for the record half of every `document` screen.
 *
 * Appendix A rules 2–4 govern a record page: it shows status, owner, branch,
 * dates, source, approvals, related documents, journal entries and an audit
 * timeline; a draft is unmistakably marked; and only actions valid for the
 * status and the caller's permissions are offered.
 *
 * Those rules are about *structure*, so a sample record has to carry the same
 * structure a real one does — an approval chain with decisions on it, journals
 * that balance, an audit trail whose entries are in order. A record page drawn
 * over three dummy fields would review as fine and then need rebuilding.
 *
 * Deterministic from the document number, like the rest of `src/sample`.
 */
import type { DocumentStatus, TransitionRule } from '@domain/statuses';
import { seeded } from './generate';

/**
 * A plausible lifecycle, in the absence of the configured one.
 *
 * §01.6 puts the real transitions in the database, per document type. Nothing
 * here reads the database, so the record page uses this standard shape to
 * decide which actions a status offers. It is deliberately the ordinary path —
 * draft to submitted to approved to posted — because the point is to show the
 * action bar behaving, not to model a particular module's exceptions.
 */
export const SAMPLE_TRANSITIONS: readonly TransitionRule[] = [
  { from: 'draft', to: 'submitted' },
  { from: 'draft', to: 'cancelled' },
  { from: 'submitted', to: 'approved' },
  { from: 'submitted', to: 'rejected' },
  { from: 'submitted', to: 'draft' },
  { from: 'approved', to: 'executed' },
  { from: 'approved', to: 'posted' },
  { from: 'approved', to: 'cancelled' },
  { from: 'executed', to: 'settled' },
  { from: 'executed', to: 'posted' },
  { from: 'posted', to: 'reversed' },
  { from: 'posted', to: 'closed' },
  { from: 'settled', to: 'closed' },
];

const OWNERS = ['Ahmed Karim', 'Sara Mahmoud', 'Rania Hassan', 'Tishko Sabir'] as const;
const BRANCHES = ['HQ', 'BSR', 'ERB', 'MSL'] as const;
const DEPARTMENTS = ['Finance', 'Operations', 'Logistics', 'Procurement'] as const;

const LINE_ITEMS = [
  'Marine diesel filter',
  'Container seal, steel',
  'Pallet wrap 500mm',
  'Hydraulic hose 3/4"',
  'Safety helmet, white',
  'Bearing assembly 6205',
  'Freight and handling',
  'Customs clearance fee',
] as const;

const AUDIT_ACTIONS = ['created', 'updated', 'submitted', 'approved', 'posted'] as const;

export interface SampleLine {
  readonly id: string;
  readonly lineNo: number;
  readonly description: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly lineTotal: number;
}

export interface SampleApproval {
  readonly id: string;
  readonly step: number;
  readonly approver: string;
  readonly decision: 'approved' | 'rejected' | 'pending';
  readonly at: string | null;
}

export interface SampleRelated {
  readonly id: string;
  readonly relation: string;
  readonly reference: string;
  readonly status: DocumentStatus;
}

export interface SampleJournal {
  readonly id: string;
  readonly reference: string;
  readonly postedAt: string;
  readonly debit: number;
  readonly credit: number;
  readonly isReversal: boolean;
}

export interface SampleAudit {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly action: string;
  readonly field: string | null;
}

export interface SampleRecord {
  readonly documentNumber: string;
  readonly status: DocumentStatus;
  readonly owner: string;
  readonly branch: string;
  readonly department: string;
  readonly documentDate: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: string | null;
  readonly partner: string;
  readonly lines: readonly SampleLine[];
  readonly total: number;
  readonly approvals: readonly SampleApproval[];
  readonly related: readonly SampleRelated[];
  readonly journals: readonly SampleJournal[];
  readonly audit: readonly SampleAudit[];
}

/**
 * The status a document number implies.
 *
 * Derived from the number rather than picked freshly, so that opening a row
 * from a list shows the status that row displayed. A record whose status
 * changed on the way in from the list would be worse than no record page.
 */
function statusFor(random: () => number): DocumentStatus {
  const pool: readonly DocumentStatus[] = [
    'draft',
    'submitted',
    'approved',
    'posted',
    'posted',
    'settled',
    'cancelled',
    'closed',
  ];
  return pool[Math.floor(random() * pool.length)]!;
}

function dayBefore(days: number): string {
  return new Date(Date.UTC(2026, 7, 21) - days * 86_400_000).toISOString().slice(0, 10);
}

function instantBefore(days: number, hours: number): string {
  return new Date(Date.UTC(2026, 7, 21, 9, 0) - days * 86_400_000 - hours * 3_600_000).toISOString();
}

/** One document, complete enough to exercise all nine record sections. */
export function sampleRecord(screenKey: string, documentNumber: string): SampleRecord {
  const random = seeded(`${screenKey}:${documentNumber}`);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const between = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));

  const status = statusFor(random);
  const age = between(2, 60);
  const isFinal = status === 'posted' || status === 'settled' || status === 'closed';

  const lines: SampleLine[] = Array.from({ length: between(3, 7) }, (_, index) => {
    const quantity = between(2, 240);
    const unitPrice = between(3, 320) * 250;
    return {
      id: `${documentNumber}-line-${index}`,
      lineNo: index + 1,
      description: pick(LINE_ITEMS),
      quantity,
      unitPrice,
      lineTotal: quantity * unitPrice,
    };
  });

  const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);

  // An approval chain that matches the status: a draft has none, a submitted
  // document is waiting on someone, an approved one has its decisions in.
  const approvals: SampleApproval[] =
    status === 'draft'
      ? []
      : Array.from({ length: status === 'submitted' ? 2 : 2 }, (_, index) => {
          const pending = status === 'submitted' && index === 1;
          return {
            id: `${documentNumber}-approval-${index}`,
            step: index + 1,
            approver: pick(OWNERS),
            decision: pending ? 'pending' : status === 'rejected' && index === 1 ? 'rejected' : 'approved',
            at: pending ? null : instantBefore(age - index, index * 3),
          };
        });

  const related: SampleRelated[] = Array.from({ length: between(1, 3) }, (_, index) => ({
    id: `${documentNumber}-related-${index}`,
    relation: ['source', 'fulfils', 'invoiced_by'][index % 3]!,
    reference: `${['SO', 'DN', 'INV'][index % 3]}-2026-${String(between(100, 899)).padStart(5, '0')}`,
    status: pick(['posted', 'approved', 'settled', 'draft'] as const),
  }));

  // Only a document that reached the ledger has journals, and they balance.
  const journals: SampleJournal[] = isFinal
    ? [
        {
          id: `${documentNumber}-journal-0`,
          reference: `JV-2026-${String(between(100, 899)).padStart(5, '0')}`,
          postedAt: dayBefore(age - 1),
          debit: total,
          credit: total,
          isReversal: false,
        },
      ]
    : [];

  const audit: SampleAudit[] = AUDIT_ACTIONS.slice(
    0,
    status === 'draft' ? 2 : isFinal ? 5 : 3,
  ).map((action, index) => ({
    id: `${documentNumber}-audit-${index}`,
    at: instantBefore(age - index, (AUDIT_ACTIONS.length - index) * 2),
    actor: pick(OWNERS),
    action,
    field: action === 'updated' ? 'document_date' : null,
  }));

  return {
    documentNumber,
    status,
    owner: pick(OWNERS),
    branch: pick(BRANCHES),
    department: pick(DEPARTMENTS),
    documentDate: dayBefore(age),
    createdAt: instantBefore(age, 6),
    updatedAt: instantBefore(Math.max(age - 4, 0), 2),
    source: random() > 0.4 ? `SO-2026-${String(between(100, 899)).padStart(5, '0')}` : null,
    partner: pick([
      'Al Noor Trading Co.',
      'Gulf Supplies Ltd.',
      'Modern Builders Group',
      'Tigris Logistics',
      'Basra Marine Services',
    ] as const),
    lines,
    total,
    approvals,
    related,
    journals,
    audit,
  };
}
