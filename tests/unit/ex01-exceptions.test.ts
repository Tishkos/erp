/**
 * Exception Center — the rules, the registry, the wording and the migrations
 * hold together, with no database (platform phase, Agent 7).
 *
 * The road is one table (`domain/exceptions.allowedPairs`); migration 0380's
 * guard trigger holds the same pairs and this reads the migration as text and
 * fails when the two disagree. Every detector in the catalogue has a runner
 * and wording in both languages; the wording, rendered with facts, never shows
 * a raw code or a placeholder; the detectors contain no write. The detectors
 * on a real database, the lifecycle, the visibility and the "no business row
 * moved" guarantee are `tests/integration/ex01-exceptions.test.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DETECTORS,
  DOMAINS,
  EVIDENCE_CAP,
  EVIDENCE_ROW,
  HISTORY_EVENTS,
  SEVERITIES,
  SEVERITY_TONE,
  STATUSES,
  STATUS_TONE,
  THRESHOLDS,
  acknowledgeable,
  allowedPairs,
  atLeast,
  canMove,
  detectorKey,
  detectorOf,
  findingKey,
  interrupts,
  isDomain,
  isLocalPath,
  isSeverity,
  maxSeverity,
  notificationKind,
  plan,
  refusal,
  severityByDays,
  severityRank,
  shift,
  stable,
  type Finding,
  type FoundFinding,
  type Severity,
  type StoredFinding,
} from '@/server/domain/exceptions';
import { KINDS, categoryOf, kindDef, kindKey } from '@/server/domain/notification-center';
import { PROFILE_KINDS, profileHref } from '@/server/domain/profiles';
import { viewableRoute } from '@/server/domain/saved-view-routes';
import { SCREENS } from '@/server/domain/screens';
import { MENU } from '@/server/domain/menu';
import { STATUS_CODES } from '@/server/domain/search';
import { EXPORT_ACCESS } from '@/server/print/access';
import { exceptionType } from '@/server/search/entities/exceptions';
import * as text from '@/server/services/exception-text';
import en from '../../messages/en.json';
import ar from '../../messages/ar.json';

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const CORE = read('src/server/db/migrations/0380_exception_core.sql');
const DETECTOR_FILES = readdirSync(join(ROOT, 'src/server/services/exception-detectors')).filter((f) => f.endsWith('.ts'));

type Catalogue = Record<string, unknown>;
const lookup = (catalogue: Catalogue, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node && typeof node === 'object' ? (node as Catalogue)[key] : undefined), catalogue);
const CATALOGUES = { en: en as unknown as Catalogue, ar: ar as unknown as Catalogue } as const;
const LOCALES = ['en', 'ar'] as const;

const at = (iso: string) => new Date(iso);

// ---------------------------------------------------------------------------
// Severity and keys
// ---------------------------------------------------------------------------

describe('severity', () => {
  it('ranks critical above high above medium above low, as the database does', () => {
    expect(SEVERITIES.map(severityRank)).toEqual([4, 3, 2, 1]);
    expect(atLeast('high', 'medium')).toBe(true);
    expect(atLeast('low', 'medium')).toBe(false);
    expect(maxSeverity('low', 'critical')).toBe('critical');
    expect(CORE).toContain("ARRAY['low', 'medium', 'high', 'critical']");
  });

  it('shifts one step and stays inside the four', () => {
    expect(shift('medium', 1)).toBe('high');
    expect(shift('critical', 3)).toBe('critical');
    expect(shift('low', -3)).toBe('low');
    expect(shift('high', -1)).toBe('medium');
  });

  it('grows with the days a condition has lasted: the last step reached wins, under the first there is nothing', () => {
    const steps = THRESHOLDS.receivableOverdue;
    expect(severityByDays(0, steps)).toBeNull();
    expect(severityByDays(29, steps)).toBeNull();
    expect(severityByDays(30, steps)).toBe('low');
    expect(severityByDays(59, steps)).toBe('low');
    expect(severityByDays(60, steps)).toBe('medium');
    expect(severityByDays(90, steps)).toBe('high');
    expect(severityByDays(400, steps)).toBe('critical');
  });

  it('keeps every threshold table ascending in days and in severity', () => {
    for (const [name, value] of Object.entries(THRESHOLDS)) {
      if (!Array.isArray(value)) continue;
      const days = value.map((s) => s.atLeast);
      expect(days, name).toEqual([...days].sort((a, b) => a - b));
      expect(new Set(days).size, name).toBe(days.length);
      const ranks = value.map((s) => severityRank(s.severity));
      expect(ranks, name).toEqual([...ranks].sort((a, b) => a - b));
    }
  });

  it('gives every severity and every status a chip tone the application already draws', () => {
    for (const severity of SEVERITIES) expect(SEVERITY_TONE[severity]).toBeTruthy();
    for (const status of STATUSES) expect(STATUS_TONE[status]).toBeTruthy();
    const css = read('src/app/globals.css');
    for (const tone of new Set([...Object.values(SEVERITY_TONE), ...Object.values(STATUS_TONE)])) expect(css, tone).toContain(`.status--${tone}`);
  });
});

describe('identity', () => {
  it('is the detector and the subject, nothing else', () => {
    expect(findingKey('tasks.overdue', 'abc')).toBe('tasks.overdue|abc');
    expect(findingKey('tasks.overdue', 'abc')).not.toBe(findingKey('tasks.blocked', 'abc'));
    expect(detectorKey('inventory.negative_stock')).toBe('inventory_negative_stock');
  });

  it('hashes the same facts the same whatever order they were built in', () => {
    expect(stable({ b: 1, a: [2, { y: 1, x: 2 }] })).toBe(stable({ a: [2, { x: 2, y: 1 }], b: 1 }));
    expect(stable({ a: 1, b: undefined })).toBe(stable({ a: 1 }));
    expect(stable({ a: 1 })).not.toBe(stable({ a: 2 }));
  });

  it('accepts only local links', () => {
    expect(isLocalPath('/finance/journals/JE-1')).toBe(true);
    expect(isLocalPath('//evil.example')).toBe(false);
    expect(isLocalPath('/\\evil.example')).toBe(false);
    expect(isLocalPath('https://evil.example')).toBe(false);
    expect(isLocalPath('/')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The road
// ---------------------------------------------------------------------------

describe('the road', () => {
  it('allows open → acknowledged | resolved, acknowledged → open | resolved, resolved → open and nothing else', () => {
    expect(canMove('open', 'acknowledged')).toBe(true);
    expect(canMove('open', 'resolved')).toBe(true);
    expect(canMove('acknowledged', 'open')).toBe(true);
    expect(canMove('acknowledged', 'resolved')).toBe(true);
    expect(canMove('resolved', 'open')).toBe(true);
    expect(canMove('resolved', 'acknowledged')).toBe(false);
    expect(canMove('open', 'open')).toBe(false);
    expect(acknowledgeable('open')).toBe(true);
    expect(acknowledgeable('acknowledged')).toBe(false);
    expect(acknowledgeable('resolved')).toBe(false);
  });

  it('is the same list in the migration: the guard trigger holds what the domain says', () => {
    const block = /FROM \(VALUES([\s\S]*?)\) AS p\(from_status, to_status\)/.exec(CORE);
    expect(block, 'the allowed pairs in exception_lifecycle_guard').not.toBeNull();
    const inSql = [...block![1]!.matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const inDomain = allowedPairs().map(([a, b]) => `${a}>${b}`).sort();
    expect(inSql).toEqual(inDomain);
  });

  it('knows the same statuses, severities and history events as the table constraints', () => {
    for (const status of STATUSES) expect(CORE, status).toContain(`'${status}'`);
    for (const severity of SEVERITIES) expect(CORE, severity).toContain(`'${severity}'`);
    for (const event of HISTORY_EVENTS) expect(CORE, event).toContain(`'${event}'`);
    for (const domain of DOMAINS) expect(CORE, domain).toContain(`'${domain}'`);
  });

  it('is sealed against deletion and hand-made rows, by the database', () => {
    expect(CORE).toMatch(/exception_no_delete/);
    expect(CORE).toMatch(/An exception is raised by the sweep, not by hand/);
    expect(CORE).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(CORE).toMatch(/exception_history/);
  });
});

// ---------------------------------------------------------------------------
// What the sweep does
// ---------------------------------------------------------------------------

describe('the sweep plan', () => {
  const started = at('2026-10-04T10:00:00Z');
  const before = at('2026-10-04T09:00:00Z');
  const stored = (key: string, over: Partial<StoredFinding> = {}): StoredFinding => ({
    key,
    detector: key.split('|')[0]!,
    status: 'open',
    severity: 'high',
    contentHash: 'h1',
    lastSeenAt: before,
    ...over,
  });
  const found = (key: string, over: Partial<FoundFinding> = {}): FoundFinding => ({ key, detector: key.split('|')[0]!, severity: 'high', contentHash: 'h1', ...over });
  const run = (storedRows: StoredFinding[], foundRows: FoundFinding[], ranOk: string[] = ['d.a']) => plan({ stored: storedRows, found: foundRows, ranOk: new Set(ranOk), startedAt: started });

  it('creates a finding it has not seen', () => {
    expect(run([], [found('d.a|1')])).toEqual([{ kind: 'create', key: 'd.a|1' }]);
  });

  it('touches one that is unchanged, so a second sweep creates nothing', () => {
    expect(run([stored('d.a|1')], [found('d.a|1')])).toEqual([{ kind: 'touch', key: 'd.a|1' }]);
  });

  it('updates one whose content or severity changed, and says if it got worse', () => {
    expect(run([stored('d.a|1')], [found('d.a|1', { contentHash: 'h2' })])).toEqual([{ kind: 'update', key: 'd.a|1', severityRaised: false }]);
    expect(run([stored('d.a|1', { severity: 'medium' })], [found('d.a|1')])).toEqual([{ kind: 'update', key: 'd.a|1', severityRaised: true }]);
    expect(run([stored('d.a|1')], [found('d.a|1', { severity: 'medium' })])).toEqual([{ kind: 'update', key: 'd.a|1', severityRaised: false }]);
  });

  it('resolves, by itself, what the detector that ran no longer finds', () => {
    expect(run([stored('d.a|1')], [])).toEqual([{ kind: 'resolve', key: 'd.a|1' }]);
    expect(run([stored('d.a|1', { status: 'acknowledged' })], [])).toEqual([{ kind: 'resolve', key: 'd.a|1' }]);
  });

  it('resolves nothing when the detector failed or was not asked: not finding is not evidence', () => {
    expect(run([stored('d.a|1')], [], ['d.other'])).toEqual([]);
    expect(run([stored('d.a|1')], [], [])).toEqual([]);
  });

  it('leaves alone what a later sweep has seen: two sweeps in flight cannot undo each other', () => {
    expect(run([stored('d.a|1', { lastSeenAt: at('2026-10-04T10:00:01Z') })], [])).toEqual([]);
    expect(run([stored('d.a|1', { lastSeenAt: started })], [])).toEqual([]);
  });

  it('reopens a resolved finding that is found again', () => {
    expect(run([stored('d.a|1', { status: 'resolved' })], [found('d.a|1')])).toEqual([{ kind: 'reopen', key: 'd.a|1', from: 'resolved' }]);
  });

  it('keeps an acknowledged finding acknowledged while it is the same, and reopens it only when it got worse', () => {
    expect(run([stored('d.a|1', { status: 'acknowledged' })], [found('d.a|1')])).toEqual([{ kind: 'touch', key: 'd.a|1' }]);
    expect(run([stored('d.a|1', { status: 'acknowledged' })], [found('d.a|1', { contentHash: 'h2' })])).toEqual([{ kind: 'update', key: 'd.a|1', severityRaised: false }]);
    expect(run([stored('d.a|1', { status: 'acknowledged', severity: 'medium' })], [found('d.a|1')])).toEqual([{ kind: 'reopen', key: 'd.a|1', from: 'acknowledged' }]);
  });

  it('counts a subject once even if a detector names it twice', () => {
    expect(run([], [found('d.a|1'), found('d.a|1', { contentHash: 'x' })])).toEqual([{ kind: 'create', key: 'd.a|1' }]);
  });

  it('never resolves an already resolved finding again', () => {
    expect(run([stored('d.a|1', { status: 'resolved' })], [])).toEqual([]);
  });

  it('interrupts somebody only for a critical or high finding that is new, back, or got worse', () => {
    expect(interrupts({ kind: 'create', key: 'k' }, 'critical')).toBe(true);
    expect(interrupts({ kind: 'create', key: 'k' }, 'high')).toBe(true);
    expect(interrupts({ kind: 'create', key: 'k' }, 'medium')).toBe(false);
    expect(interrupts({ kind: 'reopen', key: 'k', from: 'resolved' }, 'high')).toBe(true);
    expect(interrupts({ kind: 'update', key: 'k', severityRaised: true }, 'high')).toBe(true);
    expect(interrupts({ kind: 'update', key: 'k', severityRaised: false }, 'high')).toBe(false);
    expect(interrupts({ kind: 'touch', key: 'k' }, 'critical')).toBe(false);
    expect(interrupts({ kind: 'resolve', key: 'k' }, 'critical')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A finding is checked before it is written
// ---------------------------------------------------------------------------

describe('a finding', () => {
  const good = (over: Partial<Finding> = {}): Finding => ({
    detector: 'tasks.overdue',
    subject: 'abc',
    severity: 'high',
    facts: { task: 'TASK-1' },
    evidence: [],
    record: { type: 'task', id: 'abc', label: 'TASK-1', href: '/tasks/TASK-1' },
    action: '/tasks/TASK-1',
    branchCode: 'HQ',
    ...over,
  });

  it('passes when it names its detector, subject, record and local links', () => {
    expect(refusal(good())).toBeNull();
  });

  it('is refused when it is not a registered detector, names no subject or record, or links away from the application', () => {
    expect(refusal(good({ detector: 'made.up' }))).toMatch(/not a registered detector/);
    expect(refusal(good({ subject: ' ' }))).toMatch(/subject/);
    expect(refusal(good({ severity: 'urgent' as Severity }))).toMatch(/severity/);
    expect(refusal(good({ record: { type: '', id: 'a', label: 'b', href: '/x' } }))).toMatch(/record/);
    expect(refusal(good({ action: 'https://evil.example' }))).toMatch(/local paths/);
    expect(refusal(good({ evidence: [EVIDENCE_ROW({ ref: 'r', href: '//evil.example' })] }))).toMatch(/evidence link/);
    expect(refusal(good({ evidence: Array.from({ length: EVIDENCE_CAP + 1 }, (_, i) => EVIDENCE_ROW({ ref: String(i) })) }))).toMatch(/at most/);
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the detector registry', () => {
  const registry = read('src/server/services/exception-detectors/index.ts');
  const runnerCodes = [...registry.matchAll(/^\s*'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]!);

  it('has a runner for every detector but the sweep notice, and a detector for every runner', () => {
    const catalogue = DETECTORS.map((d) => d.code).filter((c) => c !== 'platform.sweep_truncated').sort();
    expect([...runnerCodes].sort()).toEqual(catalogue);
  });

  it('names each detector <domain>.<name> with a known domain, once', () => {
    expect(new Set(DETECTORS.map((d) => d.code)).size).toBe(DETECTORS.length);
    for (const d of DETECTORS) {
      expect(d.code.split('.')[0], d.code).toBe(d.domain);
      expect(isDomain(d.domain)).toBe(true);
      expect(d.severities.length, d.code).toBeGreaterThan(0);
      for (const severity of d.severities) expect(isSeverity(severity), `${d.code} ${severity}`).toBe(true);
      expect(detectorOf(d.code)).toBe(d);
    }
  });

  it('covers every domain of the brief with at least one detector', () => {
    for (const domain of DOMAINS) expect(DETECTORS.some((d) => d.domain === domain), domain).toBe(true);
  });

  it('is about permission objects the system has a grant for', () => {
    const grants = read('src/server/db/migrations/0381_exception_grants.sql');
    expect(grants).toContain("'exception'");
    for (const d of DETECTORS) expect(d.object.length, d.code).toBeGreaterThan(0);
  });

  it('marks the host-dependent detector, and only it', () => {
    expect(DETECTORS.filter((d) => d.hostDependent).map((d) => d.code)).toEqual(['platform.system_health']);
  });

  it('contains no write: a detector reads through the services and the sweep persists', () => {
    expect(DETECTOR_FILES.length).toBeGreaterThan(5);
    for (const file of DETECTOR_FILES) {
      const source = read(`src/server/services/exception-detectors/${file}`);
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/\.(insert|update|delete)\(/);
      expect(code, file).not.toMatch(/\b(insert\s+into|update\s+[a-z_"]+\s+set|delete\s+from|truncate\s)/i);
      expect(code, file).not.toMatch(/set_config|markSystemSweep|applyScope|\.execute\(sql`\s*(alter|drop|create)/i);
    }
  });

  it('runs the detectors in a transaction the database holds read-only', () => {
    const service = read('src/server/services/exceptions.ts');
    expect(service).toMatch(/set local transaction_read_only = on/);
  });

  it('keeps the host-dependent health check out of the tests that need a clean sweep (documented, not hidden)', () => {
    const health = read('src/server/services/exception-detectors/platform.ts');
    expect(health).toMatch(/host dependent/i);
  });
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

/** Plausible facts for each detector — a name the wording asks for, as the detector builds it. */
const SAMPLE: Readonly<Record<string, Record<string, string | number | null>>> = {
  'accounting.bank_reconciliation_difference': { reconciliation: 'BRC-1', account: '1010 Bank', asOfDate: '2026-09-30', days: 12, differenceIqd: '1500.0000', unmatchedStatementLines: 2, unmatchedLedgerItems: 1 },
  'accounting.control_account_difference': { account: '1200 AR', side: 'customer', subledgerIqd: '100', glIqd: '150', differenceIqd: '50', lines: 1 },
  'accounting.gl_integrity': { entry: 'JE-1', issue: 'unbalanced_journal', detail: 'debits 1, credits 2' },
  'accounting.posting_role_unmapped': { postingEvent: 'sales.ar_invoice', postingRole: 'customer_receivable', reason: 'missing', account: null },
  'accounting.posting_failed': { postingEvent: 'sales.ar_invoice', document: 'INV-1', module: 'sales', errorMessage: 'Boom', attempts: 2, sinceDate: '2026-10-01', days: 3 },
  'accounting.period_close_blocked': { period: 'Sep 2026', endDate: '2026-09-30', days: 5, periodCheck: 'journals_posted', figure: '3' },
  'receivables.overdue_exposure': { party: 'Acme', partyCode: 'C-1', branch: 'HQ', overdueIqd: '5000', invoices: 2, days: 45, oldestInvoice: 'INV-1', oldestDueDate: '2026-08-20' },
  'receivables.ledger_inconsistency': { entry: 'JE-2', reason: 'no_subledger', account: '1200', party: 'C-1', lines: 1, postingDate: '2026-09-01' },
  'payables.overdue_exposure': { party: 'Sup', partyCode: 'S-1', branch: 'HQ', overdueIqd: '5000', invoices: 1, days: 45, oldestInvoice: 'PI-1', oldestDueDate: '2026-08-20' },
  'payables.ledger_inconsistency': { entry: 'JE-2', reason: 'amount', account: '2100', party: 'S-1', lines: 3, postingDate: '2026-09-01' },
  'payables.supplier_credit_inconsistency': { memo: 'SCM-1', supplier: 'S-1 Sup', creditIqd: '100', allocatedIqd: '100', appliedIqd: '60', differenceIqd: '40' },
  'inventory.negative_stock': { item: 'ITM-1 Pipe', warehouse: 'WH1 Main', quantityQty: '-3' },
  'inventory.layer_mismatch': { item: 'ITM-1 Pipe', warehouse: 'WH1 Main', quantityQty: '2' },
  'inventory.document_ledger_mismatch': { kind: 'unbalanced', documentType: 'stock_transfer', document: 'TRF-1', items: 2, movements: 3 },
  'inventory.gl_difference': { layersIqd: '100', glIqd: '80', provisionalIqd: '5', unexplainedIqd: '20' },
  'inventory.transit_mismatch': { item: 'ITM-1', ledgerQty: '10', importsQty: '8', differenceQty: '2' },
  'logistics.container_delayed': { container: 'MSCU1234567', bl: 'BL-1', supplier: 'Sup', importNo: 'IMP-1', etaDate: '2026-09-20', days: 14 },
  'logistics.shipment_update_stale': { container: 'MSCU1234567', bl: 'BL-1', supplier: 'Sup', lastDate: '2026-09-01', days: 33 },
  'logistics.customs_issue': { pd: 'PD-1', issue: 'expiring', expiryDate: '2026-10-10', days: 6, importNo: 'IMP-1' },
  'logistics.landed_cost_blocked': { importNo: 'IMP-1', supplier: 'Sup', state: 'waiting_containers', charges: 3, unlockedIqd: '900', days: 30, containersIn: 1, containers: 2, pds: '' },
  'tasks.overdue': { task: 'TASK-1', taskTitle: 'Do it', dueDate: '2026-09-20', days: 14, priority: 'urgent', assignee: 'Ann' },
  'logistics.automation_container_eta': { container: 'MSCU1234567', bl: 'BL-1', supplier: 'Sup', importNo: 'IMP-1', etaDate: '2026-09-20', days: 14, rule: 'AUT-001', note: 'Chase the forwarder' },
  'tasks.automation_task_overdue': { task: 'TASK-1', taskTitle: 'Do it', assignee: 'Ann', priority: 'urgent', dueDate: '2026-09-20', days: 14, rule: 'AUT-001', note: '' },
  'receivables.automation_invoice_overdue': { invoice: 'INV-1', customer: 'Acme', customerCode: 'C-1', amountIqd: '5000', dueDate: '2026-08-20', days: 45, rule: 'AUT-001', note: '' },
  'tasks.blocked': { task: 'TASK-1', taskTitle: 'Do it', sinceDate: '2026-09-20', days: 14, priority: 'high', assignee: 'Ann', reason: 'waiting for a part' },
  'approvals.waiting_too_long': { docKind: 'journal_entry', document: 'JE-9', submitter: 'Bob', approver: 'Cy', sinceDate: '2026-09-20', days: 14 },
  'platform.system_health': { healthCheck: 'backup_stale', job: null, message: 'The newest backup is 40 hours old' },
  'platform.sweep_truncated': { sourceDetector: 'tasks.overdue', shown: 200, total: 340 },
};

/** Every value of an enum-like fact the wording branches on, so each branch is rendered once. */
const BRANCHES: readonly { detector: string; fact: string; values: readonly string[] }[] = [
  { detector: 'accounting.gl_integrity', fact: 'issue', values: ['unbalanced_journal', 'single_sided_journal', 'orphan_subledger_entry', 'posted_to_group_account', 'something_new'] },
  { detector: 'accounting.posting_role_unmapped', fact: 'reason', values: ['missing', 'stale', 'something_new'] },
  { detector: 'accounting.control_account_difference', fact: 'side', values: ['customer', 'supplier'] },
  { detector: 'receivables.ledger_inconsistency', fact: 'reason', values: ['no_subledger', 'account', 'amount', 'not_posted'] },
  { detector: 'payables.ledger_inconsistency', fact: 'reason', values: ['no_subledger', 'account', 'amount', 'not_posted'] },
  { detector: 'inventory.document_ledger_mismatch', fact: 'kind', values: ['no_ledger', 'no_document', 'unbalanced', 'something_new'] },
  { detector: 'logistics.customs_issue', fact: 'issue', values: ['rejected', 'expired', 'past_expiry', 'expiring'] },
  { detector: 'logistics.landed_cost_blocked', fact: 'state', values: ['waiting_pds', 'waiting_containers', 'ready', 'late_charges', 'something_new'] },
];

/** A snake_case word of three or more parts or a dotted code in a sentence is a code that leaked. */
/** Words that are spelt in capitals on purpose. */
const ACRONYMS = /\b(?:FIFO|IBAN|SWIFT)\b/g;
const RAW_CODE = /\b[a-z]+(?:_[a-z]+){1,}\b|\b[a-z]+\.[a-z_]+\b|undefined|\[object|\{\w+\}|NaN/;

describe('the wording', () => {
  it('has a name, a title, an explanation and an action for every detector, in both languages', () => {
    for (const locale of LOCALES) {
      for (const d of DETECTORS) {
        const base = `admin.exceptions.detector.${detectorKey(d.code)}`;
        for (const leaf of ['name', 'title', 'explanation', 'action']) {
          const value = lookup(CATALOGUES[locale], `${base}.${leaf}`);
          expect(typeof value, `${locale} ${base}.${leaf}`).toBe('string');
          expect((value as string).length, `${locale} ${base}.${leaf}`).toBeGreaterThan(3);
        }
      }
    }
  });

  it('has no wording for a detector that does not exist', () => {
    for (const locale of LOCALES) {
      const detectors = lookup(CATALOGUES[locale], 'admin.exceptions.detector') as Record<string, unknown>;
      expect(Object.keys(detectors).sort(), locale).toEqual(DETECTORS.map((d) => detectorKey(d.code)).sort());
    }
  });

  it('says the same set of things in English and in Arabic', () => {
    const keys = (node: unknown, prefix = ''): string[] =>
      node && typeof node === 'object' ? Object.entries(node as Catalogue).flatMap(([k, v]) => keys(v, `${prefix}${k}.`)) : [prefix.slice(0, -1)];
    const enKeys = keys(lookup(CATALOGUES.en, 'admin.exceptions')).sort();
    const arKeys = keys(lookup(CATALOGUES.ar, 'admin.exceptions')).sort();
    expect(arKeys).toEqual(enKeys);
  });

  it('renders every detector in both languages without a raw code, a placeholder or a gap', () => {
    for (const d of DETECTORS) {
      const facts = SAMPLE[d.code];
      expect(facts, `sample facts for ${d.code}`).toBeTruthy();
      for (const locale of LOCALES) {
        const words = text.render(locale, d.code, facts!);
        for (const [leaf, value] of Object.entries(words)) {
          expect(value.length, `${locale} ${d.code} ${leaf}`).toBeGreaterThan(3);
          expect(value, `${locale} ${d.code} ${leaf}`).not.toMatch(RAW_CODE);
          expect(value.replace(ACRONYMS, ''), `${locale} ${d.code} ${leaf}`).not.toMatch(/Error \d+|\b[A-Z_]{4,}\b(?!-)/);
        }
        // English wording is English and Arabic wording is Arabic around the same figures.
        if (locale === 'ar') expect(words.title + words.explanation, d.code).toMatch(/[؀-ۿ]/);
        if (locale === 'en') expect(words.title + words.explanation, d.code).not.toMatch(/[؀-ۿ]/);
      }
    }
  });

  it('renders every branch of the wording that depends on a kind of problem', () => {
    for (const branch of BRANCHES) {
      for (const value of branch.values) {
        for (const locale of LOCALES) {
          const words = text.render(locale, branch.detector, { ...SAMPLE[branch.detector]!, [branch.fact]: value });
          expect(words.title, `${locale} ${branch.detector} ${value}`).not.toMatch(RAW_CODE);
          expect(words.explanation, `${locale} ${branch.detector} ${value}`).not.toMatch(RAW_CODE);
          expect(words.title.length).toBeGreaterThan(3);
        }
      }
    }
  });

  it('shows money, quantities and dates as the application shows them, by the suffix of their name', () => {
    const facts = text.formatFacts({ differenceIqd: '1500.0000', quantityQty: '-3.5', asOfDate: '2026-09-30', other: 'x', empty: null, days: 4 }, 'en');
    expect(facts.differenceIqd).toBe('1,500 IQD');
    expect(facts.quantityQty).toMatch(/3\.5/);
    expect(facts.asOfDate).toBe('Sep 30, 2026');
    expect(facts.other).toBe('x');
    expect(facts.empty).toBe('');
    expect(facts.days).toBe(4);
  });

  it('turns a posting event, a role, a priority and a health check into words', () => {
    const facts = text.formatFacts({ postingEvent: 'sales.ar_invoice', postingRole: 'customer_receivable', priority: 'urgent', healthCheck: 'disk_low', docKind: 'journal_entry', sourceDetector: 'tasks.overdue' }, 'en');
    for (const [name, value] of Object.entries(facts)) expect(String(value), name).not.toMatch(/[a-z]_[a-z]|\./);
    expect(facts.healthCheck).toBe('Disk space low');
    expect(facts.docKind).toBe('Journal entry');
    expect(facts.sourceDetector).toBe('Overdue task');
  });

  it('reads an unknown code as its own name, never as nothing or as a key', () => {
    expect(text.render('en', 'made.up_thing', {}).title).toBe('Made up thing');
    expect(text.noteText('en', { code: 'no_such_note' })).toBe('No such note');
    expect(text.noteText('en', null)).toBe('');
  });

  it('has a note for every evidence code the detectors write, in both languages', () => {
    const literal = new Set<string>();
    for (const file of DETECTOR_FILES) {
      const source = read(`src/server/services/exception-detectors/${file}`);
      for (const m of source.matchAll(/code:\s*'([a-z_]+)'/g)) literal.add(m[1]!);
      for (const m of source.matchAll(/code:\s*`([a-z_]+)\$\{/g)) literal.add(`${m[1]}*`);
    }
    // The families written from a code the data carries: ledger_<reason>, gl_<issue>, pd_<issue>.
    const family = {
      'ledger_*': ['ledger_no_subledger', 'ledger_amount', 'ledger_account', 'ledger_not_posted'],
      'gl_*': ['gl_unbalanced_journal', 'gl_single_sided_journal', 'gl_orphan_subledger_entry', 'gl_posted_to_group_account'],
      'pd_*': ['pd_rejected', 'pd_expired', 'pd_past_expiry', 'pd_expiring'],
    } as const;
    const needed = new Set<string>();
    for (const code of literal) {
      if (code.endsWith('*')) for (const c of family[code as keyof typeof family] ?? []) needed.add(c);
      else needed.add(code);
    }
    expect(needed.size).toBeGreaterThan(25);
    for (const locale of LOCALES) {
      for (const code of needed) {
        const value = lookup(CATALOGUES[locale], `admin.exceptions.evidence_note.${code}`);
        expect(typeof value, `${locale} evidence_note.${code}`).toBe('string');
      }
    }
  });

  it('renders a note with its figures in both languages', () => {
    expect(text.noteText('en', { code: 'overdue_days', params: { days: 45 } })).toBe('45 days overdue');
    expect(text.noteText('ar', { code: 'overdue_days', params: { days: 45 } })).toMatch(/45/);
    expect(text.noteText('en', { code: 'bank_unmatched', params: { statement: 1, ledger: 3 } })).toBe('1 statement line and 3 ledger items not yet matched');
    expect(text.noteText('ar', { code: 'bank_unmatched', params: { statement: 2, ledger: 1 } })).toMatch(/[؀-ۿ]/);
  });

  it('labels every severity, domain, status and history event on the screens, in both languages', () => {
    for (const locale of LOCALES) {
      for (const severity of SEVERITIES) expect(typeof lookup(CATALOGUES[locale], `admin.exceptions.severity_${severity}`)).toBe('string');
      for (const domain of DOMAINS) expect(typeof lookup(CATALOGUES[locale], `admin.exceptions.domain_${domain}`)).toBe('string');
      for (const status of [...STATUSES, 'live', 'all']) expect(typeof lookup(CATALOGUES[locale], `admin.exceptions.status_${status}`), status).toBe('string');
      for (const event of HISTORY_EVENTS) expect(typeof lookup(CATALOGUES[locale], `admin.exceptions.event_${event}`), event).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

describe('the registrations', () => {
  it('raises one notification kind per domain, in the category the registry reserves for exceptions, labelled in both languages', () => {
    // All of them are Accounting's: the registry reserves the `exception.` prefix for that category and no kind has two.
    const expected: Record<string, string> = Object.fromEntries(DOMAINS.map((domain) => [domain, 'accounting']));
    for (const domain of DOMAINS) {
      const kind = notificationKind(domain);
      expect(KINDS[kind], kind).toBeDefined();
      expect(categoryOf(kind), kind).toBe(expected[domain]);
      expect(kindDef(kind).object).toBe('exception');
      expect(kindDef(kind).window).toBe('occurrence');
      for (const locale of LOCALES) {
        expect(typeof lookup(CATALOGUES[locale], `notifications.kind.${kindKey(kind)}.title`), `${locale} ${kind}`).toBe('string');
        expect(typeof lookup(CATALOGUES[locale], `notifications.kind.${kindKey(kind)}.detail`), `${locale} ${kind}`).toBe('string');
      }
    }
  });

  it('is a record the print, the profile, the search, the saved views and the menu all know', () => {
    expect(EXPORT_ACCESS.exception).toEqual({ kind: 'document', route: '/exceptions', object: 'exception' });
    expect(read('src/server/print/registry.ts')).toContain('exception: byId(exceptionDocuments.exception)');
    for (const locale of LOCALES) expect(typeof lookup(CATALOGUES[locale], 'print.titles.exception')).toBe('string');

    expect(PROFILE_KINDS).toContain('exception');
    expect(profileHref('exception', 'EXC-0001')).toBe('/exceptions/EXC-0001');

    expect(exceptionType.key).toBe('exception');
    expect(exceptionType.grant).toEqual({ object: 'exception' });
    expect(exceptionType.route).toBe('/exceptions');
    expect(read('src/server/search/entities/index.ts')).toContain('exceptionType');
    for (const locale of LOCALES) expect(typeof lookup(CATALOGUES[locale], 'search.types.exception')).toBe('string');
    for (const status of ['open', 'acknowledged', 'resolved']) {
      expect(STATUS_CODES, status).toContain(status);
      for (const locale of LOCALES) expect(typeof lookup(CATALOGUES[locale], `search.status.${status}`), `${locale} ${status}`).toBe('string');
    }

    const view = viewableRoute('exceptions.list');
    expect(view?.route).toBe('/exceptions');
    expect(Object.keys(view?.params ?? {})).toEqual(['q', 'domain', 'severity', 'status', 'owner']);

    const home = MENU.find((section) => section.key === 'home')!;
    expect(home.items.find((item) => item.key === 'exceptions')).toEqual({ key: 'exceptions', object: 'exception', href: '/exceptions' });
    expect(SCREENS.exceptions).toBe('document');
    for (const locale of LOCALES) expect(typeof lookup(CATALOGUES[locale], 'page.exceptions')).toBe('string');
  });

  it('is kept by the resets: the tables in both lists, the series kept', () => {
    const setup = read('tests/integration/setup.ts');
    expect(setup).toMatch(/truncate exception_history, exception_sweep_run, exception/);
    expect(setup).toContain("'EXCEPTION'");
    const format = read('scripts/ops/format-live-database.sh');
    for (const table of ['exception_history', 'exception', 'exception_sweep_run']) expect(format, table).toMatch(new RegExp(`^${table}$`, 'm'));
  });

  it('runs on a schedule of its own, locked, with a timeout, and writes only its own tables', () => {
    const lines = read('scripts/ops/crontab.erp').split('\n').filter((l) => l.includes('exception-sweep') && !l.trim().startsWith('#'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('$RUN exception-sweep');
    expect(lines[0]).toMatch(/^\*\/30 /);
    expect(existsSync(join(ROOT, 'scripts/ops/exception-sweep.ts'))).toBe(true);
  });

  it('exposes the three reads the Dashboard and the record pages are promised', () => {
    const service = read('src/server/services/exceptions.ts');
    expect(service).toMatch(/export async function openFor\(/);
    expect(service).toMatch(/export async function countsFor\(/);
    expect(service).toMatch(/export async function byRecord\(/);
    expect(service).toMatch(/export const PERMISSION_OBJECT = 'exception'/);
  });
});
