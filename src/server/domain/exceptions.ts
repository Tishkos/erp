/**
 * The Exception Center's rules — platform phase, Agent 7. Pure: no database,
 * no request, no translation. `services/exceptions.ts` persists with these;
 * `services/exception-detectors.ts` finds with them; `tests/unit/ex01-*.test.ts`
 * holds them.
 *
 * ── What an exception is ───────────────────────────────────────────────────
 * A *finding*: something that is wrong or late now and needs a person. It is
 * not a log line and not a warning the system invented — each detector reads
 * a condition an existing service already knows how to ask (the stock ledger's
 * integrity check, the control accounts' reconciliation, the ageing, the
 * tracking of a container, the task list) and reports it with the numbers
 * behind it. A detector whose data does not exist in this system is not built;
 * the handoff lists them.
 *
 * ── Identity: the key ──────────────────────────────────────────────────────
 * `detector|subject`. The subject is the stable thing the condition is about
 * (a warehouse and an item, a customer in a branch, a container, a journal
 * entry), never a count or a date, so the same condition found on the next
 * sweep is the same exception — a row that is seen again, not a second row.
 *
 * ── The road ───────────────────────────────────────────────────────────────
 *
 *   open ───────────► acknowledged     a person, with a note
 *   open ──┐
 *   acknowledged ───► resolved         the sweep, and only when the detector no
 *                                      longer finds the condition
 *   resolved ───────► open             found again: reopened, the history kept
 *   acknowledged ───► open             the finding got worse (severity rose)
 *
 * The pairs below are held again by `exception_lifecycle_guard` (0380), which
 * also holds who walks each step. `tests/unit/ex01-exceptions.test.ts` reads
 * the migration and fails when the two disagree.
 */

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DOMAINS = ['accounting', 'receivables', 'payables', 'inventory', 'logistics', 'tasks', 'approvals', 'platform'] as const;
export type ExceptionDomain = (typeof DOMAINS)[number];

export const STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type ExceptionStatus = (typeof STATUSES)[number];

export const HISTORY_EVENTS = ['detected', 'acknowledged', 'resolved', 'reopened', 'escalated', 'severity_raised', 'severity_lowered'] as const;
export type HistoryEvent = (typeof HISTORY_EVENTS)[number];

export const isSeverity = (value: unknown): value is Severity => typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value);
export const isDomain = (value: unknown): value is ExceptionDomain => typeof value === 'string' && (DOMAINS as readonly string[]).includes(value);
export const isStatus = (value: unknown): value is ExceptionStatus => typeof value === 'string' && (STATUSES as readonly string[]).includes(value);

/** 4 for critical … 1 for low — the database's `exception_severity_rank`. */
export function severityRank(severity: Severity): number {
  return SEVERITIES.length - SEVERITIES.indexOf(severity);
}

export const atLeast = (severity: Severity, minimum: Severity): boolean => severityRank(severity) >= severityRank(minimum);

export function maxSeverity(a: Severity, b: Severity): Severity {
  return severityRank(a) >= severityRank(b) ? a : b;
}

/** One step more (or fewer) severe, kept inside the four. */
export function shift(severity: Severity, steps: number): Severity {
  const index = SEVERITIES.indexOf(severity) - steps;
  return SEVERITIES[Math.max(0, Math.min(SEVERITIES.length - 1, index))]!;
}

/** A severity chosen by how long a condition has lasted: the last step reached wins; under the first, none. */
export function severityByDays(days: number, steps: readonly { readonly atLeast: number; readonly severity: Severity }[]): Severity | null {
  let found: Severity | null = null;
  for (const step of [...steps].sort((a, b) => a.atLeast - b.atLeast)) {
    if (days >= step.atLeast) found = step.severity;
  }
  return found;
}

// ---------------------------------------------------------------------------
// The road
// ---------------------------------------------------------------------------

/** Mirrored by the VALUES list in `exception_lifecycle_guard` (0380). */
export function allowedPairs(): readonly (readonly [ExceptionStatus, ExceptionStatus])[] {
  return [
    ['open', 'acknowledged'],
    ['open', 'resolved'],
    ['acknowledged', 'open'],
    ['acknowledged', 'resolved'],
    ['resolved', 'open'],
  ];
}

export function canMove(from: ExceptionStatus, to: ExceptionStatus): boolean {
  return allowedPairs().some(([a, b]) => a === from && b === to);
}

/** A person can acknowledge an open finding, and nothing else; the sweep walks the rest. */
export const acknowledgeable = (status: ExceptionStatus): boolean => status === 'open';

export const NOTE_MAX = 1000;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export function findingKey(detector: string, subject: string): string {
  return `${detector}|${subject}`;
}

/** The detector's code is `<domain>.<name>`, lower case; the message key under `exceptions.detector` swaps the dot. */
export function detectorKey(code: string): string {
  return code.replace('.', '_');
}

// ---------------------------------------------------------------------------
// What a finding carries
// ---------------------------------------------------------------------------

/** One row the detector found, as the record page lists it. */
export interface EvidenceRow {
  /** The record's number or the thing's name — what a person recognises it by. */
  readonly ref: string;
  /** A local path to open it, when it has a page. */
  readonly href: string | null;
  readonly date: string | null;
  /** IQD, as a decimal string. */
  readonly amount: string | null;
  readonly quantity: string | null;
  /** What is wrong with this row: a code in `exceptions.evidence_note`, and the numbers its wording uses. */
  readonly note: { readonly code: string; readonly params?: Readonly<Record<string, string | number>> } | null;
}

/**
 * The numbers and names the wording is made of. A key ending `Iqd` is money (a
 * decimal string), `Qty` a quantity, `Date` a business date; anything else is
 * shown as it is. Never a sentence: the sentence is the message catalogue's.
 */
export type ExceptionFacts = Readonly<Record<string, string | number | null>>;

export interface FindingRecord {
  /** The kind of record, as its paperclip and history know it (`task`, `shipment_container`, …). */
  readonly type: string;
  /** The id the paperclip files under (a uuid, mostly). */
  readonly id: string;
  /** What a person calls it: its number or code. */
  readonly label: string;
  /** Where the record opens. */
  readonly href: string;
}

export interface Finding {
  readonly detector: string;
  readonly subject: string;
  readonly severity: Severity;
  readonly facts: ExceptionFacts;
  readonly evidence: readonly EvidenceRow[];
  readonly record: FindingRecord;
  /** The direct action: the screen where this is dealt with ("Open Landed Cost"); its label is the detector's `action` message. */
  readonly action: string;
  /** Null: company-wide. */
  readonly branchCode: string | null;
  /** A business partner's code, where the finding is about one (the profile link). */
  readonly partyCode?: string | null;
  /** Who owns it where the data has one (the assignee, the approver, the preparer); null otherwise. */
  readonly owner?: { readonly userId: string | null; readonly name: string } | null;
}

export const EVIDENCE_CAP = 25;

export const EVIDENCE_ROW = (row: Partial<EvidenceRow> & { readonly ref: string }): EvidenceRow => ({
  ref: row.ref,
  href: row.href ?? null,
  date: row.date ?? null,
  amount: row.amount ?? null,
  quantity: row.quantity ?? null,
  note: row.note ?? null,
});

// ---------------------------------------------------------------------------
// The detectors
// ---------------------------------------------------------------------------

export interface DetectorDef {
  /** `<domain>.<name>`. */
  readonly code: string;
  readonly domain: ExceptionDomain;
  /**
   * The permission object a person must hold `view` on to see a finding of
   * this detector: the object of the screen that shows the same thing in full.
   */
  readonly object: string;
  /** The kind of record the finding names (documentation; the finding carries its own). */
  readonly record: string;
  /** The severities its rule can produce, most severe first. */
  readonly severities: readonly Severity[];
  /** The existing service the condition is read from — a detector never re-derives what one already knows. */
  readonly source: string;
  /** Does it need the host (files, disk)? Its findings depend on where the sweep runs. */
  readonly hostDependent?: boolean;
}

export const DETECTORS: readonly DetectorDef[] = Object.freeze([
  // Accounting
  { code: 'accounting.bank_reconciliation_difference', domain: 'accounting', object: 'bank_reconciliation', record: 'bank_reconciliation', severities: ['critical', 'high', 'medium'], source: 'bank-reconciliation.position' },
  { code: 'accounting.control_account_difference', domain: 'accounting', object: 'gl_inquiry', record: 'chart_of_account', severities: ['critical'], source: 'subledger.reconciliation (the close check subledger_equals_gl)' },
  { code: 'accounting.gl_integrity', domain: 'accounting', object: 'journal_entry', record: 'journal_entry', severities: ['critical'], source: 'gl_integrity_issue view (the close check gl_integrity)' },
  { code: 'accounting.posting_role_unmapped', domain: 'accounting', object: 'posting_rule', record: 'posting_rule', severities: ['high', 'medium'], source: 'POSTING_MAP + posting.rules (Posting Mappings)' },
  { code: 'accounting.posting_failed', domain: 'accounting', object: 'posting_rule', record: 'posting_failure', severities: ['high'], source: 'posting_failure (the posting log)' },
  { code: 'accounting.period_close_blocked', domain: 'accounting', object: 'fiscal_period', record: 'fiscal_period', severities: ['high', 'medium'], source: 'closing-checks.nextToClose + report' },
  // Receivables
  { code: 'receivables.overdue_exposure', domain: 'receivables', object: 'ar_invoice', record: 'business_partner', severities: ['critical', 'high', 'medium', 'low'], source: 'open-items.openItems (customer side)' },
  { code: 'receivables.ledger_inconsistency', domain: 'receivables', object: 'ar_invoice', record: 'journal_entry', severities: ['high'], source: 'customer-reconciliation.exceptions' },
  // Payables
  { code: 'payables.overdue_exposure', domain: 'payables', object: 'ap_invoice', record: 'business_partner', severities: ['critical', 'high', 'medium', 'low'], source: 'open-items.openItems (supplier side)' },
  { code: 'payables.ledger_inconsistency', domain: 'payables', object: 'ap_invoice', record: 'journal_entry', severities: ['high'], source: 'supplier-balances.exceptions' },
  { code: 'payables.supplier_credit_inconsistency', domain: 'payables', object: 'supplier_credit_memo', record: 'supplier_credit_memo', severities: ['high'], source: 'supplier_credit_memo against supplier_credit_application' },
  // Inventory
  { code: 'inventory.negative_stock', domain: 'inventory', object: 'inventory_movement', record: 'warehouse', severities: ['high'], source: 'inventory-integrity.adriftPositions' },
  { code: 'inventory.layer_mismatch', domain: 'inventory', object: 'inventory_movement', record: 'warehouse', severities: ['high'], source: 'inventory-integrity.adriftPositions' },
  { code: 'inventory.document_ledger_mismatch', domain: 'inventory', object: 'inventory_movement', record: 'stock document', severities: ['critical'], source: 'inventory-integrity.documentsWithoutLedger / ledgerWithoutDocument / unbalancedTransfers' },
  { code: 'inventory.gl_difference', domain: 'inventory', object: 'inventory_movement', record: 'company', severities: ['high'], source: 'inventory-valuation.stockAgainstGl' },
  { code: 'inventory.transit_mismatch', domain: 'inventory', object: 'in_transit', record: 'item', severities: ['medium'], source: 'logistics-views.inTransitReconciliation' },
  // Logistics
  { code: 'logistics.container_delayed', domain: 'logistics', object: 'shipment_container', record: 'shipment_container', severities: ['critical', 'high', 'medium', 'low'], source: 'logistics-views.shipmentTracking' },
  { code: 'logistics.shipment_update_stale', domain: 'logistics', object: 'shipment_container', record: 'shipment_container', severities: ['high', 'medium', 'low'], source: 'logistics-views.shipmentTracking' },
  { code: 'logistics.customs_issue', domain: 'logistics', object: 'customs_pd', record: 'customs_pd', severities: ['high', 'medium'], source: 'customs_pd with pd_status' },
  { code: 'logistics.landed_cost_blocked', domain: 'logistics', object: 'landed_cost', record: 'payable', severities: ['high', 'medium'], source: 'logistics-views.landedCostsRegister' },
  // Tasks
  { code: 'tasks.overdue', domain: 'tasks', object: 'task', record: 'task', severities: ['critical', 'high', 'medium', 'low'], source: 'tasks.overdueTasks' },
  { code: 'tasks.blocked', domain: 'tasks', object: 'task', record: 'task', severities: ['critical', 'high', 'medium'], source: 'tasks.blockedTasks' },
  // Approvals
  { code: 'approvals.waiting_too_long', domain: 'approvals', object: 'workflow_instance', record: 'workflow_instance', severities: ['critical', 'high', 'medium', 'low'], source: 'workflow_instance (the approvals inbox)' },
  // Platform
  { code: 'platform.system_health', domain: 'platform', object: 'system_health', record: 'system', severities: ['critical', 'high', 'medium'], source: 'system-health.check', hostDependent: true },
  { code: 'platform.sweep_truncated', domain: 'platform', object: 'system_health', record: 'detector', severities: ['medium'], source: 'the sweep itself' },
]);

export const detectorOf = (code: string): DetectorDef | undefined => DETECTORS.find((d) => d.code === code);

/**
 * How long a condition must last before it is reported, and how severity
 * grows with it. Constants rather than a settings table: the thresholds are
 * policy for the whole company, change rarely, and a settings screen for them
 * would be a second place to be wrong. A deployment that wants other numbers
 * changes them here, in one reviewed line.
 */
type Steps = readonly { readonly atLeast: number; readonly severity: Severity }[];

interface Thresholds {
  readonly bankReconciliation: Steps;
  readonly receivableOverdue: Steps;
  readonly payableOverdue: Steps;
  readonly containerLate: Steps;
  readonly shipmentStale: Steps;
  readonly landedCostWaiting: Steps;
  readonly taskOverdue: Steps;
  readonly taskBlocked: Steps;
  readonly approvalWaiting: Steps;
  readonly periodCloseGraceDays: number;
  readonly pdExpiryWarningDays: number;
  readonly findingsPerDetector: number;
}

const THRESHOLD_VALUES: Thresholds = {
  /** A reconciliation left open with a difference this many days after its statement's last day. */
  bankReconciliation: [
    { atLeast: 7, severity: 'medium' },
    { atLeast: 30, severity: 'high' },
    { atLeast: 90, severity: 'critical' },
  ],
  /** Days past due of a customer's oldest overdue invoice. */
  receivableOverdue: [
    { atLeast: 30, severity: 'low' },
    { atLeast: 60, severity: 'medium' },
    { atLeast: 90, severity: 'high' },
    { atLeast: 180, severity: 'critical' },
  ],
  /** Days past due of a supplier's oldest overdue invoice. */
  payableOverdue: [
    { atLeast: 14, severity: 'low' },
    { atLeast: 30, severity: 'medium' },
    { atLeast: 60, severity: 'high' },
    { atLeast: 90, severity: 'critical' },
  ],
  /** Days past its ETA, still not received. */
  containerLate: [
    { atLeast: 3, severity: 'low' },
    { atLeast: 7, severity: 'medium' },
    { atLeast: 14, severity: 'high' },
    { atLeast: 30, severity: 'critical' },
  ],
  /** Days since a container's status was last written. */
  shipmentStale: [
    { atLeast: 7, severity: 'low' },
    { atLeast: 14, severity: 'medium' },
    { atLeast: 30, severity: 'high' },
  ],
  /** Days an import's charges have waited for the lock they are waiting for. */
  landedCostWaiting: [
    { atLeast: 21, severity: 'medium' },
    { atLeast: 60, severity: 'high' },
  ],
  /** Days a task is past its due date. */
  taskOverdue: [
    { atLeast: 1, severity: 'low' },
    { atLeast: 3, severity: 'medium' },
    { atLeast: 7, severity: 'high' },
    { atLeast: 30, severity: 'critical' },
  ],
  /** Days a task has been blocked. */
  taskBlocked: [
    { atLeast: 3, severity: 'medium' },
    { atLeast: 7, severity: 'high' },
    { atLeast: 21, severity: 'critical' },
  ],
  /** Days a document has waited for its decision. */
  approvalWaiting: [
    { atLeast: 3, severity: 'low' },
    { atLeast: 7, severity: 'medium' },
    { atLeast: 14, severity: 'high' },
    { atLeast: 30, severity: 'critical' },
  ],
  /** Days after a period's last day that an open close still blocks. */
  periodCloseGraceDays: 5,
  /** A PD is "expiring" this many days before its expiry date. */
  pdExpiryWarningDays: 14,
  /** Per detector: more findings than this and the rest are summarised, not dropped silently. */
  findingsPerDetector: 200,
};

export const THRESHOLDS: Thresholds = Object.freeze(THRESHOLD_VALUES);

// ---------------------------------------------------------------------------
// Which kind of notification a finding raises, and when
// ---------------------------------------------------------------------------

/** `exception.<domain>`: the Notification Center's kind for a domain, so each lands in the category it belongs to. */
export const notificationKind = (domain: ExceptionDomain): string => `exception.${domain}`;

/** Only what is critical or high interrupts anybody; the rest waits on the screen. */
export const INTERRUPTS: readonly Severity[] = ['critical', 'high'];

// ---------------------------------------------------------------------------
// The sweep's plan: what to do with what was found and what is stored
// ---------------------------------------------------------------------------

export interface StoredFinding {
  readonly key: string;
  readonly detector: string;
  readonly status: ExceptionStatus;
  readonly severity: Severity;
  readonly contentHash: string;
  readonly lastSeenAt: Date;
}

export interface FoundFinding {
  readonly key: string;
  readonly detector: string;
  readonly severity: Severity;
  readonly contentHash: string;
}

export type SweepAction =
  | { readonly kind: 'create'; readonly key: string }
  | { readonly kind: 'reopen'; readonly key: string; readonly from: 'resolved' | 'acknowledged' }
  | { readonly kind: 'update'; readonly key: string; readonly severityRaised: boolean }
  | { readonly kind: 'touch'; readonly key: string }
  | { readonly kind: 'resolve'; readonly key: string };

/**
 * Decides what the sweep does with each finding, from the stored rows and what
 * the detectors that ran found. A detector that failed (`ranOk` lacks it) can
 * resolve nothing: not finding is only evidence of a cleared cause when the
 * question was actually asked and answered. A stored finding seen by a *later*
 * sweep than this one (`lastSeenAt` not before `startedAt`) is left alone, so
 * two sweeps in flight at once cannot undo each other.
 */
export function plan(input: {
  readonly stored: readonly StoredFinding[];
  readonly found: readonly FoundFinding[];
  readonly ranOk: ReadonlySet<string>;
  readonly startedAt: Date;
}): SweepAction[] {
  const stored = new Map(input.stored.map((row) => [row.key, row]));
  const actions: SweepAction[] = [];
  const seen = new Set<string>();

  for (const found of input.found) {
    if (seen.has(found.key)) continue; // a detector must not report one subject twice; the first stands
    seen.add(found.key);
    const row = stored.get(found.key);
    if (!row) {
      actions.push({ kind: 'create', key: found.key });
    } else if (row.status === 'resolved') {
      actions.push({ kind: 'reopen', key: found.key, from: 'resolved' });
    } else if (row.status === 'acknowledged' && severityRank(found.severity) > severityRank(row.severity)) {
      actions.push({ kind: 'reopen', key: found.key, from: 'acknowledged' });
    } else if (row.contentHash !== found.contentHash || row.severity !== found.severity) {
      actions.push({ kind: 'update', key: found.key, severityRaised: severityRank(found.severity) > severityRank(row.severity) });
    } else {
      actions.push({ kind: 'touch', key: found.key });
    }
  }

  for (const row of input.stored) {
    if (seen.has(row.key) || row.status === 'resolved') continue;
    if (!input.ranOk.has(row.detector)) continue;
    if (row.lastSeenAt.getTime() >= input.startedAt.getTime()) continue;
    actions.push({ kind: 'resolve', key: row.key });
  }
  return actions;
}

/** Does this step interrupt somebody (a notification), and with which occurrence token? */
export function interrupts(action: SweepAction, severity: Severity): boolean {
  if (!INTERRUPTS.includes(severity)) return false;
  if (action.kind === 'create' || action.kind === 'reopen') return true;
  return action.kind === 'update' && action.severityRaised;
}

// ---------------------------------------------------------------------------
// A stable form of a finding's content, for noticing change
// ---------------------------------------------------------------------------

/** JSON with sorted keys: the same facts hash the same whatever order a detector built them in. */
export function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
}

/** A local path only: `/…`, never `//host` or `/\host`. */
export const isLocalPath = (value: unknown): value is string => typeof value === 'string' && /^\/[^/\\]/.test(value);

/** Checks a finding before it is written; returns what is wrong, or null. */
export function refusal(finding: Finding): string | null {
  const def = detectorOf(finding.detector);
  if (!def) return `${finding.detector} is not a registered detector.`;
  if (!finding.subject.trim()) return `${finding.detector}: a finding names its subject.`;
  if (!isSeverity(finding.severity)) return `${finding.detector}: "${finding.severity}" is not a severity.`;
  if (!finding.record.type || !finding.record.id || !finding.record.label) return `${finding.detector}: a finding names the record it is about.`;
  if (!isLocalPath(finding.record.href) || !isLocalPath(finding.action)) return `${finding.detector}: the record's link and the action must be local paths.`;
  if (finding.evidence.length > EVIDENCE_CAP) return `${finding.detector}: at most ${EVIDENCE_CAP} evidence rows.`;
  for (const row of finding.evidence) if (row.href !== null && !isLocalPath(row.href)) return `${finding.detector}: an evidence link must be a local path.`;
  return null;
}
