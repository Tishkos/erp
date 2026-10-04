/**
 * The Exception Center — platform phase, Agent 7.
 *
 * ── What it is ─────────────────────────────────────────────────────────────
 * The place that holds *what is wrong now* and needs a person: a finding for
 * each condition the detectors (`exception-detectors/`) find in the books, the
 * stock, the imports, the work and the approvals. A finding is persisted and
 * de-duplicated by its key (detector + subject); it opens, is acknowledged by
 * a person with a note, and resolves *by itself* when the detector no longer
 * finds the condition. A person cannot fix the underlying accounting or stock
 * issue here, and nothing here ever does: this module reads business data in
 * a transaction PostgreSQL holds read-only, and writes only its own three
 * tables.
 *
 * ── The three reads others rely on ─────────────────────────────────────────
 *   openFor(tx, principal, { limit?, domain?, minSeverity? })   the Dashboard's contract
 *   countsFor(tx, principal)                                    the same, as numbers
 *   byRecord(tx, principal, recordType, recordId)               "what is wrong with this record"
 * Each returns only what the principal may see: the grant on `exception`, the
 * grant on the object the finding is about, the branch (row-level security),
 * and the affected record's own access rule (`attachments.mayAccessParent`,
 * the rule the paperclip, Search and the Task Center ask) — a task's
 * exception is invisible to someone who cannot open that task.
 *
 * ── Two transactions per sweep ─────────────────────────────────────────────
 * Detect, then persist. The first runs as the system operator, `READ ONLY`,
 * one savepoint per detector (one that fails is recorded and resolves nothing
 * — not finding is evidence only when the question was answered). The second
 * takes an advisory lock, plans (`domain/exceptions.plan`) and writes. Two
 * sweeps at once serialise on the lock and the second leaves alone anything
 * the first saw later than its own detection started, so neither undoes the
 * other and a second run changes nothing.
 */
import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { applyScope, db, markSystemSweep, type RequestScope, type Tx } from '../db/client';
import { exception, exceptionHistory, exceptionSweepRun } from '../db/schema';
import { businessToday } from '../domain/business-date';
import {
  DETECTORS,
  DOMAINS,
  SEVERITIES,
  THRESHOLDS,
  detectorOf,
  findingKey,
  interrupts,
  isDomain,
  isSeverity,
  isStatus,
  notificationKind,
  plan,
  refusal,
  severityRank,
  stable,
  NOTE_MAX,
  type EvidenceRow,
  type ExceptionDomain,
  type ExceptionFacts,
  type ExceptionStatus,
  type Finding,
  type FoundFinding,
  type Severity,
  type StoredFinding,
  type SweepAction,
} from '../domain/exceptions';
import { can, type Principal } from '../domain/permissions';
import type { Locale } from '../../i18n/config';
import { isLocale } from '../../i18n/config';
import * as attachments from './attachments';
import { recordChange } from './administration';
import * as authz from './authorization';
import type { ActorContext } from './chart-of-accounts';
import { RUNNERS } from './exception-detectors';
import * as text from './exception-text';
import * as notifications from './notifications';
import { systemScope } from './notification-runner';
import { allocateDocumentNumber } from './numbering';
import { REGISTER_PAGE_SIZE, type RegisterPage } from './register-page';
import { registerAllRecords } from '../records';

export const PERMISSION_OBJECT = 'exception';
export const SEQUENCE_KEY = 'EXCEPTION';

type Row = typeof exception.$inferSelect;

export class ExceptionError extends Error {
  readonly code: 'NOT_FOUND' | 'NOT_ACKNOWLEDGEABLE' | 'NOTE_REQUIRED' | 'NOTE_TOO_LONG';
  constructor(code: ExceptionError['code'], message: string) {
    super(message);
    this.name = 'ExceptionError';
    this.code = code;
  }
}

const iso = (value: Date | string | null | undefined): string | null => (value ? new Date(value).toISOString() : null);

// ---------------------------------------------------------------------------
// Who may see a row
// ---------------------------------------------------------------------------

/**
 * The finding's own grant, then the affected record's access rule. Row-level
 * security has already narrowed the rows to the grant on `exception` and on
 * the object and to the branch; this asks the one question SQL cannot — can
 * this person open *that record* (a task is its parties' alone).
 */
export async function recordVisible(
  tx: Tx,
  principal: Principal,
  row: Pick<Row, 'permissionObject' | 'recordType' | 'recordId' | 'ownerUserId'>,
  memo: Map<string, boolean> = new Map(),
): Promise<boolean> {
  if (!can(principal, 'view', PERMISSION_OBJECT) || !can(principal, 'view', row.permissionObject)) return false;
  const key = `${row.recordType}|${row.recordId}|${row.ownerUserId ?? ''}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  let verdict: boolean;
  if (row.recordType === 'workflow_instance') {
    // An approval waiting is its approver's to see, and the managers of the workflow's.
    verdict = row.ownerUserId === principal.userId || can(principal, 'administer', 'workflow_instance') || can(principal, 'configure', 'workflow_instance');
  } else {
    registerAllRecords();
    verdict = (await attachments.mayAccessParent(tx, principal, row.recordType, row.recordId)) !== false;
  }
  memo.set(key, verdict);
  return verdict;
}

async function filterVisible(tx: Tx, principal: Principal, rows: readonly Row[]): Promise<Row[]> {
  const memo = new Map<string, boolean>();
  const kept: Row[] = [];
  for (const row of rows) if (await recordVisible(tx, principal, row, memo)) kept.push(row);
  return kept;
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

/** The reader's language when asked inside a request; English in a script or a test. */
async function requestLocale(): Promise<Locale> {
  try {
    const { getLocale } = await import('next-intl/server');
    const locale = await getLocale();
    return isLocale(locale) ? locale : 'en';
  } catch {
    return 'en';
  }
}

// ---------------------------------------------------------------------------
// The contract with the Dashboard (RULES-PLATFORM §10)
// ---------------------------------------------------------------------------

/** One open exception, as the Dashboard and the Control Center draw it. */
export interface ExceptionBrief {
  readonly id: string;
  /** EXC-0001 */
  readonly no: string;
  readonly severity: Severity;
  readonly domain: ExceptionDomain;
  /** In the reader's language. */
  readonly title: string;
  readonly explanation: string;
  /** The affected record. */
  readonly recordType: string;
  readonly recordId: string;
  /** The exception's own page — always openable by whoever was handed this row. */
  readonly href: string;
  readonly createdAt: string;
  readonly ownerName: string | null;
  /** Beyond the contract: the affected record's page, and the direct action with its label. */
  readonly recordHref: string;
  readonly actionHref: string;
  readonly actionLabel: string;
}

function brief(row: Row, locale: Locale): ExceptionBrief {
  const words = text.render(locale, row.detector, row.facts);
  return {
    id: row.id,
    no: row.exceptionNo,
    severity: row.severity as Severity,
    domain: row.domain as ExceptionDomain,
    title: words.title,
    explanation: words.explanation,
    recordType: row.recordType,
    recordId: row.recordId,
    href: `/exceptions/${encodeURIComponent(row.exceptionNo)}`,
    createdAt: iso(row.createdAt)!,
    ownerName: row.ownerName,
    recordHref: row.recordHref,
    actionHref: row.href,
    actionLabel: words.action,
  };
}

const bySeverityThenAge = [desc(sql`exception_severity_rank(${exception.severity})`), sql`${exception.firstDetectedAt} asc`, sql`${exception.exceptionNo} asc`] as const;

export interface OpenForOptions {
  readonly limit?: number;
  readonly domain?: ExceptionDomain;
  readonly minSeverity?: Severity;
  /** Defaults to the request's language (English outside a request). */
  readonly locale?: Locale;
  /** Also those a person has acknowledged. The Dashboard's default is open only. */
  readonly includeAcknowledged?: boolean;
}

/**
 * The most severe open exceptions the principal may see, most severe first,
 * oldest first within a severity. Acknowledged ones are somebody's in hand
 * and are not counted as needing attention unless asked for.
 */
export async function openFor(tx: Tx, principal: Principal, options: OpenForOptions = {}): Promise<ExceptionBrief[]> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return [];
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 20)));
  const locale = options.locale ?? (await requestLocale());
  const rows = await fetchLive(tx, {
    statuses: options.includeAcknowledged ? ['open', 'acknowledged'] : ['open'],
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.minSeverity ? { minSeverity: options.minSeverity } : {}),
    cap: limit * 4 + 50,
  });
  return (await filterVisible(tx, principal, rows)).slice(0, limit).map((row) => brief(row, locale));
}

export interface ExceptionCounts {
  readonly total: number;
  readonly bySeverity: Readonly<Record<Severity, number>>;
  readonly byDomain: Readonly<Record<ExceptionDomain, number>>;
}

const COUNT_CAP = 5000;

/** How many open exceptions the principal may see, by severity and by domain. */
export async function countsFor(tx: Tx, principal: Principal): Promise<ExceptionCounts> {
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byDomain = Object.fromEntries(DOMAINS.map((d) => [d, 0])) as Record<ExceptionDomain, number>;
  if (!can(principal, 'view', PERMISSION_OBJECT)) return { total: 0, bySeverity, byDomain };
  const rows = await filterVisible(tx, principal, await fetchLive(tx, { statuses: ['open'], cap: COUNT_CAP }));
  for (const row of rows) {
    bySeverity[row.severity as Severity] += 1;
    byDomain[row.domain as ExceptionDomain] += 1;
  }
  return { total: rows.length, bySeverity, byDomain };
}

export interface RecordException extends ExceptionBrief {
  readonly status: ExceptionStatus;
}

/**
 * What is wrong with one record, for a record page or the Control Center:
 * the exceptions that name it, open or acknowledged, most severe first.
 */
export async function byRecord(
  tx: Tx,
  principal: Principal,
  recordType: string,
  recordId: string,
  options: { readonly locale?: Locale } = {},
): Promise<RecordException[]> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return [];
  const locale = options.locale ?? (await requestLocale());
  const rows = await tx
    .select()
    .from(exception)
    .where(and(eq(exception.recordType, recordType), eq(exception.recordId, recordId), inArray(exception.status, ['open', 'acknowledged'])))
    .orderBy(...bySeverityThenAge)
    .limit(50);
  return (await filterVisible(tx, principal, rows)).map((row) => ({ ...brief(row, locale), status: row.status as ExceptionStatus }));
}

async function fetchLive(
  tx: Tx,
  input: { readonly statuses: readonly ExceptionStatus[]; readonly domain?: ExceptionDomain; readonly minSeverity?: Severity; readonly cap: number },
): Promise<Row[]> {
  const parts: SQL[] = [inArray(exception.status, [...input.statuses])];
  if (input.domain) parts.push(eq(exception.domain, input.domain));
  if (input.minSeverity) parts.push(sql`exception_severity_rank(${exception.severity}) >= ${severityRank(input.minSeverity)}`);
  return tx
    .select()
    .from(exception)
    .where(and(...parts))
    .orderBy(...bySeverityThenAge)
    .limit(input.cap);
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

export const STATUS_FILTERS = ['live', 'open', 'acknowledged', 'resolved', 'all'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface ListFilter {
  readonly domain?: string | null;
  readonly severity?: string | null;
  readonly status?: string | null;
  /** `me`: the person's own; `none`: nobody's; a user id. */
  readonly owner?: string | null;
  readonly q?: string | null;
  readonly page?: number | null;
  readonly locale?: Locale;
}

export interface ExceptionListRow extends ExceptionBrief {
  readonly status: ExceptionStatus;
  readonly detector: string;
  readonly recordLabel: string;
  readonly branchCode: string | null;
  readonly firstDetectedAt: string;
  readonly lastSeenAt: string;
  readonly occurrence: number;
}

/** The list screen: filtered, then narrowed to what the principal may open, then paged. */
export async function listForScreen(tx: Tx, principal: Principal, filter: ListFilter = {}): Promise<RegisterPage<ExceptionListRow> & { counts: ExceptionCounts }> {
  const empty = { rows: [], total: 0, page: 1, pageSize: REGISTER_PAGE_SIZE, pages: 1, counts: await countsFor(tx, principal) };
  if (!can(principal, 'view', PERMISSION_OBJECT)) return empty;
  const locale = filter.locale ?? (await requestLocale());
  const parts: SQL[] = [];
  const status = (STATUS_FILTERS as readonly string[]).includes(filter.status ?? '') ? (filter.status as StatusFilter) : 'live';
  if (status === 'live') parts.push(inArray(exception.status, ['open', 'acknowledged']));
  else if (status !== 'all' && isStatus(status)) parts.push(eq(exception.status, status));
  if (filter.domain && isDomain(filter.domain)) parts.push(eq(exception.domain, filter.domain));
  if (filter.severity && isSeverity(filter.severity)) parts.push(eq(exception.severity, filter.severity));
  if (filter.owner === 'me') parts.push(eq(exception.ownerUserId, principal.userId));
  else if (filter.owner === 'none') parts.push(sql`${exception.ownerUserId} is null`);
  else if (filter.owner && /^[0-9a-f-]{36}$/i.test(filter.owner)) parts.push(eq(exception.ownerUserId, filter.owner));
  const needle = (filter.q ?? '').trim();
  if (needle) {
    const pattern = `%${needle.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    parts.push(sql`(${exception.exceptionNo} ilike ${pattern} escape '\\' or ${exception.title} ilike ${pattern} escape '\\' or ${exception.recordLabel} ilike ${pattern} escape '\\' or coalesce(${exception.ownerName}, '') ilike ${pattern} escape '\\')`);
  }
  const rows = await tx
    .select()
    .from(exception)
    .where(parts.length ? and(...parts) : undefined)
    .orderBy(...bySeverityThenAge)
    .limit(COUNT_CAP);
  const visible = await filterVisible(tx, principal, rows);
  const pageSize = REGISTER_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(Number(filter.page ?? 1)) || 1), pages);
  const window = visible.slice((page - 1) * pageSize, page * pageSize);
  return {
    rows: window.map((row) => ({
      ...brief(row, locale),
      status: row.status as ExceptionStatus,
      detector: row.detector,
      recordLabel: row.recordLabel,
      branchCode: row.branchCode,
      firstDetectedAt: iso(row.firstDetectedAt)!,
      lastSeenAt: iso(row.lastSeenAt)!,
      occurrence: row.occurrence,
    })),
    total: visible.length,
    page,
    pageSize,
    pages,
    counts: empty.counts,
  };
}

export interface HistoryLine {
  readonly event: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly fromSeverity: string | null;
  readonly toSeverity: string;
  readonly occurrence: number;
  readonly actorName: string | null;
  readonly note: string | null;
  readonly occurredAt: string;
}

export interface EvidenceView extends EvidenceRow {
  readonly noteText: string;
}

export interface ExceptionDetail extends ExceptionListRow {
  readonly branchCode: string | null;
  readonly subject: string;
  readonly recordType: string;
  readonly partyCode: string | null;
  readonly ownerUserId: string | null;
  readonly resolvedAt: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgementNote: string | null;
  readonly evidence: readonly EvidenceView[];
  readonly history: readonly HistoryLine[];
  readonly mayAcknowledge: boolean;
}

/** One exception by its number, for its page; null when it does not exist or the principal may not open it. */
export async function byNo(tx: Tx, principal: Principal, no: string, options: { readonly locale?: Locale } = {}): Promise<ExceptionDetail | null> {
  if (!can(principal, 'view', PERMISSION_OBJECT)) return null;
  const locale = options.locale ?? (await requestLocale());
  const [row] = await tx.select().from(exception).where(eq(exception.exceptionNo, no)).limit(1);
  if (!row || !(await recordVisible(tx, principal, row))) return null;
  const history = await tx
    .select({
      event: exceptionHistory.event,
      fromStatus: exceptionHistory.fromStatus,
      toStatus: exceptionHistory.toStatus,
      fromSeverity: exceptionHistory.fromSeverity,
      toSeverity: exceptionHistory.toSeverity,
      occurrence: exceptionHistory.occurrence,
      actorName: sql<string | null>`(select display_name from app_user where id = ${exceptionHistory.actorUserId})`,
      note: exceptionHistory.note,
      occurredAt: exceptionHistory.occurredAt,
    })
    .from(exceptionHistory)
    .where(eq(exceptionHistory.exceptionId, row.id))
    .orderBy(desc(exceptionHistory.id));
  const [ackBy] = row.acknowledgedBy
    ? ((await tx.execute(sql`select display_name from app_user where id = ${row.acknowledgedBy}::uuid`)) as unknown as { rows: { display_name: string }[] }).rows
    : [];
  return {
    ...brief(row, locale),
    status: row.status as ExceptionStatus,
    detector: row.detector,
    subject: row.subject,
    recordLabel: row.recordLabel,
    branchCode: row.branchCode,
    partyCode: row.partyCode,
    ownerUserId: row.ownerUserId,
    firstDetectedAt: iso(row.firstDetectedAt)!,
    lastSeenAt: iso(row.lastSeenAt)!,
    resolvedAt: iso(row.resolvedAt),
    acknowledgedAt: iso(row.acknowledgedAt),
    acknowledgedByName: ackBy?.display_name ?? null,
    acknowledgementNote: row.acknowledgementNote,
    occurrence: row.occurrence,
    evidence: row.evidence.map((e) => ({ ...e, noteText: text.noteText(locale, e.note) })),
    history: history.map((h) => ({ ...h, occurredAt: iso(h.occurredAt)! })),
    mayAcknowledge: row.status === 'open' && can(principal, 'execute', PERMISSION_OBJECT),
  };
}

// ---------------------------------------------------------------------------
// Acknowledging
// ---------------------------------------------------------------------------

/**
 * A person has seen it and says what they know and what will be done. The
 * note is required; the step is audited; the finding stays until the cause is
 * gone — acknowledging hides nothing from the list, only from "needs
 * attention". The database holds who may take the step and that nothing else
 * about the finding changes with it.
 */
export async function acknowledge(tx: Tx, ctx: ActorContext, no: string, note: string): Promise<void> {
  await authz.authorize(ctx.principal, 'execute', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const trimmed = note.trim();
  if (!trimmed) throw new ExceptionError('NOTE_REQUIRED', 'Say what you know and what will be done: an acknowledgement carries a note.');
  if (trimmed.length > NOTE_MAX) throw new ExceptionError('NOTE_TOO_LONG', `The note is at most ${NOTE_MAX} characters.`);

  const [locked] = ((await tx.execute(sql`select id::text from exception where exception_no = ${no} for update`)) as unknown as { rows: { id: string }[] }).rows;
  const [row] = locked ? await tx.select().from(exception).where(eq(exception.id, locked.id)).limit(1) : [];
  if (!row || !(await recordVisible(tx, ctx.principal, row))) throw new ExceptionError('NOT_FOUND', `No exception ${no}.`);
  if (row.status !== 'open') {
    throw new ExceptionError('NOT_ACKNOWLEDGEABLE', row.status === 'acknowledged' ? `${no} has been acknowledged already.` : `${no} is resolved; the cause is gone.`);
  }
  await tx
    .update(exception)
    .set({ status: 'acknowledged', acknowledgementNote: trimmed, acknowledgedBy: ctx.principal.userId, acknowledgedAt: new Date() })
    .where(eq(exception.id, row.id));
  await recordChange(tx, ctx, {
    action: 'exception.acknowledged',
    objectType: PERMISSION_OBJECT,
    objectId: no,
    branchCode: row.branchCode,
    before: { status: 'open', severity: row.severity },
    after: { status: 'acknowledged', severity: row.severity, detector: row.detector, record: row.recordLabel, note: trimmed },
  });
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

export interface DetectorResult {
  readonly code: string;
  readonly found: number;
  readonly error: string | null;
  readonly ms: number;
}

export interface SweepResult {
  readonly runId: string;
  readonly trigger: 'schedule' | 'manual';
  readonly businessDate: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly found: number;
  readonly created: number;
  readonly updated: number;
  readonly reopened: number;
  readonly resolved: number;
  readonly notified: number;
  readonly detectors: readonly DetectorResult[];
  /** Set when a manual refresh found a sweep so recent that it answered with that one. */
  readonly reused?: boolean;
}

export interface SweepInput {
  readonly trigger: 'schedule' | 'manual';
  readonly triggeredBy?: string | null;
  /** Only these detectors (the others are left exactly as they are). Tests and a repair run use it; the schedule runs all. */
  readonly only?: readonly string[];
  readonly now?: Date;
  /** The scope to run as; the system operator when omitted. */
  readonly scope?: RequestScope;
}

/** A detector's findings, with the shape every finding must have. */
interface Detected {
  readonly results: DetectorResult[];
  readonly findings: Finding[];
  readonly ranOk: Set<string>;
  readonly truncated: Map<string, { total: number; shown: number }>;
}

async function detect(scope: RequestScope, input: SweepInput, now: Date, today: string): Promise<Detected> {
  const codes = (input.only ?? DETECTORS.map((d) => d.code)).filter((code) => RUNNERS[code]);
  return db.transaction(async (tx) => {
    await applyScope(tx, scope);
    // Whatever a detector does, it cannot write a business row: PostgreSQL refuses.
    await tx.execute(sql`set local transaction_read_only = on`);
    const principal = await authz.loadPrincipal(tx, scope.userId);
    const truncated = new Map<string, { total: number; shown: number }>();
    const results: DetectorResult[] = [];
    const findings: Finding[] = [];
    const ranOk = new Set<string>();
    for (const code of codes) {
      const started = Date.now();
      try {
        const found = await tx.transaction(async (savepoint) => RUNNERS[code]!({ tx: savepoint, principal, today, now, truncated }));
        const refused = found.map(refusal).find((reason) => reason !== null);
        if (refused) throw new Error(refused);
        const owned = found.filter((f) => f.detector === code);
        if (owned.length !== found.length) throw new Error(`${code} returned a finding of another detector.`);
        const kept = [...found].sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (a.subject < b.subject ? -1 : 1)).slice(0, THRESHOLDS.findingsPerDetector);
        if (found.length > kept.length) truncated.set(code, { total: found.length, shown: kept.length });
        findings.push(...kept);
        ranOk.add(code);
        results.push({ code, found: found.length, error: null, ms: Date.now() - started });
      } catch (error) {
        results.push({ code, found: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300), ms: Date.now() - started });
      }
    }
    return { results, findings, ranOk, truncated };
  });
}

/** The finding that says a detector showed only part of what it found — never silently drop. */
function truncationFindings(truncated: Detected['truncated'], ranOk: ReadonlySet<string>): Finding[] {
  return [...truncated].map(([code, count]) => ({
    detector: 'platform.sweep_truncated',
    subject: code,
    severity: 'medium' as const,
    facts: { sourceDetector: code, shown: count.shown, total: count.total },
    evidence: [],
    record: { type: 'detector', id: code, label: code, href: '/exceptions' },
    action: `/exceptions?q=${encodeURIComponent(code.split('.')[1] ?? code)}`,
    branchCode: null,
  })).filter((f) => ranOk.has(f.subject));
}

function hashOf(finding: Finding, english: { title: string; explanation: string }): string {
  return createHash('sha256')
    .update(
      stable({
        s: finding.severity,
        f: finding.facts,
        e: finding.evidence,
        r: finding.record,
        a: finding.action,
        b: finding.branchCode,
        p: finding.partyCode ?? null,
        o: finding.owner ?? null,
        t: english,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

const LOCK_NAME = 'exception_sweep';

/** Runs the detectors and brings the stored findings in line. Safe to run twice, and from two places at once. */
export async function sweep(input: SweepInput): Promise<SweepResult> {
  // A notification asks, as each recipient, whether they can open the exception: that goes through the record registry,
  // which a script (the schedule) has not loaded.
  registerAllRecords();
  const scope = input.scope ?? (await systemScope());
  const now = input.now ?? new Date();
  const today = businessToday(now);
  const startedAt = new Date();

  const detected = await detect(scope, input, now, today);
  const candidates = [...detected.findings, ...truncationFindings(detected.truncated, detected.ranOk)];
  // The truncation notices belong to the sweep itself: it ran them, so they may resolve.
  const ranOk = new Set([...detected.ranOk, 'platform.sweep_truncated']);
  const ownDetectors = input.only ? new Set(input.only) : null;

  const english = new Map<string, { title: string; explanation: string }>();
  const prepared = candidates.map((finding) => {
    const words = text.render('en', finding.detector, finding.facts);
    english.set(findingKey(finding.detector, finding.subject), words);
    return { finding, key: findingKey(finding.detector, finding.subject), hash: hashOf(finding, words) };
  });
  const byKey = new Map(prepared.map((p) => [p.key, p]));

  return db.transaction(async (tx) => {
    await applyScope(tx, scope);
    await markSystemSweep(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAME}))`);

    const keys = prepared.map((p) => p.key);
    const storedRows = await tx
      .select()
      .from(exception)
      .where(keys.length > 0 ? sql`${exception.status} <> 'resolved' or ${inArray(exception.findingKey, keys)}` : sql`${exception.status} <> 'resolved'`);
    const stored = storedRows.filter((row) => !ownDetectors || ownDetectors.has(row.detector) || (row.detector === 'platform.sweep_truncated' && detected.ranOk.has(row.subject)));
    const storedByKey = new Map(storedRows.map((row) => [row.findingKey, row]));

    const actions = plan({
      stored: stored.map((row): StoredFinding => ({
        key: row.findingKey,
        detector: row.detector,
        status: row.status as ExceptionStatus,
        severity: row.severity as Severity,
        contentHash: row.contentHash,
        lastSeenAt: row.lastSeenAt,
      })),
      found: prepared.map((p): FoundFinding => ({ key: p.key, detector: p.finding.detector, severity: p.finding.severity, contentHash: p.hash })),
      ranOk,
      startedAt,
    });

    const counts = { created: 0, updated: 0, reopened: 0, resolved: 0, notified: 0 };
    const touched: string[] = [];
    const announce: { id: string; no: string; row: Finding; occurrence: number; permissionObject: string; ownerUserId: string | null; title: string; explanation: string }[] = [];
    const changedNos: string[] = [];

    for (const action of actions) {
      const prep = byKey.get(action.key);
      const existing = storedByKey.get(action.key);
      if (action.kind === 'touch') {
        touched.push(action.key);
        continue;
      }
      if (action.kind === 'resolve') {
        await tx.update(exception).set({ status: 'resolved' }).where(eq(exception.findingKey, action.key));
        counts.resolved += 1;
        if (existing) changedNos.push(existing.exceptionNo);
        continue;
      }
      if (!prep) continue;
      const f = prep.finding;
      const def = detectorOf(f.detector)!;
      const words = english.get(prep.key)!;
      const content = {
        severity: f.severity,
        title: words.title,
        explanation: words.explanation,
        facts: f.facts as ExceptionFacts,
        evidence: [...f.evidence] as EvidenceRow[],
        contentHash: prep.hash,
        recordType: f.record.type,
        recordId: f.record.id,
        recordLabel: f.record.label,
        recordHref: f.record.href,
        href: f.action,
        partyCode: f.partyCode ?? null,
        branchCode: f.branchCode,
        ownerUserId: f.owner?.userId ?? null,
        ownerName: f.owner?.name || null,
        permissionObject: def.object,
        lastSeenAt: startedAt,
      };
      if (action.kind === 'create') {
        const allocated = await allocateDocumentNumber(tx, SEQUENCE_KEY, {}, null);
        const [made] = await tx
          .insert(exception)
          .values({
            exceptionNo: allocated.documentNo,
            findingKey: prep.key,
            detector: f.detector,
            subject: f.subject,
            domain: def.domain,
            status: 'open',
            firstDetectedAt: startedAt,
            ...content,
          })
          .returning({ id: exception.id, occurrence: exception.occurrence });
        counts.created += 1;
        changedNos.push(allocated.documentNo);
        if (interrupts(action, f.severity)) {
          announce.push({ id: made!.id, no: allocated.documentNo, row: f, occurrence: made!.occurrence, permissionObject: def.object, ownerUserId: content.ownerUserId, title: words.title, explanation: words.explanation });
        }
      } else if (existing) {
        // `last_seen_at` never moves backwards: a sweep that detected earlier than another must not rewrite it.
        const lastSeenAt = existing.lastSeenAt > startedAt ? existing.lastSeenAt : startedAt;
        const reopening = action.kind === 'reopen';
        const [after] = await tx
          .update(exception)
          .set({ ...content, lastSeenAt, ...(reopening ? { status: 'open' as const } : {}) })
          .where(eq(exception.id, existing.id))
          .returning({ occurrence: exception.occurrence });
        if (reopening) {
          counts.reopened += 1;
          changedNos.push(existing.exceptionNo);
        } else {
          counts.updated += 1;
        }
        if (interrupts(action, f.severity)) {
          announce.push({ id: existing.id, no: existing.exceptionNo, row: f, occurrence: after?.occurrence ?? existing.occurrence, permissionObject: def.object, ownerUserId: content.ownerUserId, title: words.title, explanation: words.explanation });
        }
      }
    }

    if (touched.length > 0) {
      await tx
        .update(exception)
        .set({ lastSeenAt: sql`greatest(${exception.lastSeenAt}, ${startedAt.toISOString()}::timestamptz)` })
        .where(inArray(exception.findingKey, touched));
    }

    for (const item of announce) counts.notified += await tell(tx, item);

    const finishedAt = new Date();
    const detectorRows: DetectorResult[] = detected.results;
    const [run] = await tx
      .insert(exceptionSweepRun)
      .values({
        businessDate: today,
        trigger: input.trigger,
        triggeredBy: input.triggeredBy ?? null,
        startedAt,
        finishedAt,
        found: prepared.length,
        created: counts.created,
        updated: counts.updated,
        reopened: counts.reopened,
        resolved: counts.resolved,
        notified: counts.notified,
        detectors: detectorRows,
      })
      .returning({ id: exceptionSweepRun.id });

    if (counts.created + counts.reopened + counts.resolved > 0) {
      await recordChange(
        tx,
        { principal: await authz.loadPrincipal(tx, scope.userId), branchCode: scope.branchCode },
        {
          action: 'exception.swept',
          objectType: PERMISSION_OBJECT,
          objectId: String(run!.id),
          after: { trigger: input.trigger, created: counts.created, reopened: counts.reopened, resolved: counts.resolved, notified: counts.notified, numbers: changedNos.slice(0, 50) },
        },
      );
    }

    return {
      runId: String(run!.id),
      trigger: input.trigger,
      businessDate: today,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      found: prepared.length,
      ...counts,
      detectors: detectorRows,
    };
  });
}

/**
 * Tells the people who can see a new critical or high finding — the holders
 * of `view` on the exception and on the object it is about, in its branch,
 * and its owner — once per occurrence and severity. The Notification Center
 * dedupes; each recipient is asked whether they can open it before a row is
 * written, so nobody is told of what they could not open.
 */
async function tell(
  tx: Tx,
  item: { id: string; no: string; row: Finding; occurrence: number; permissionObject: string; ownerUserId: string | null; title: string; explanation: string },
): Promise<number> {
  const branch = item.row.branchCode;
  const people = (
    (await tx.execute(sql`
      select u.id::text as id
        from app_user u
       where u.is_active
         and (
              u.is_super_user
           or (
                exists (select 1 from user_role ur join role_grant g on g.role_code = ur.role_code
                         where ur.user_id = u.id and g.object = ${PERMISSION_OBJECT} and g.verb = 'view')
            and exists (select 1 from user_role ur join role_grant g on g.role_code = ur.role_code
                         where ur.user_id = u.id and g.object = ${item.permissionObject} and g.verb = 'view')
            and (${branch}::text is null or exists (select 1 from user_branch_scope s where s.user_id = u.id and s.branch_code = ${branch}))
           )
         )`)) as unknown as { rows: { id: string }[] }
  ).rows.map((r) => r.id);
  if (item.ownerUserId) people.push(item.ownerUserId);
  const result = await notifications.emit(tx, {
    kind: notificationKind(detectorOf(item.row.detector)!.domain),
    objectType: PERMISSION_OBJECT,
    objectId: item.id,
    recipients: people,
    subject: `${item.no}: ${item.title}`,
    body: item.explanation,
    context: { reference: item.no, severity: item.row.severity, reason: item.row.severity, domain: detectorOf(item.row.detector)!.domain, title: item.title, href: `/exceptions/${encodeURIComponent(item.no)}` },
    occurrence: `${item.occurrence}:${item.row.severity}`,
    branchCode: branch,
    recordAccess: true,
  });
  return result.created;
}

// ---------------------------------------------------------------------------
// Refresh now
// ---------------------------------------------------------------------------

/** A manual refresh within this many seconds of the last sweep answers with that one: the question has just been asked. */
export const REFRESH_MIN_SECONDS = 30;

export async function lastRun(tx: Tx): Promise<{ id: string; trigger: string; finishedAt: string; found: number; created: number; reopened: number; resolved: number; failed: number } | null> {
  const [row] = await tx.select().from(exceptionSweepRun).orderBy(desc(exceptionSweepRun.id)).limit(1);
  if (!row) return null;
  const detectors = (row.detectors as DetectorResult[]) ?? [];
  return {
    id: String(row.id),
    trigger: row.trigger,
    finishedAt: iso(row.finishedAt)!,
    found: row.found,
    created: row.created,
    reopened: row.reopened,
    resolved: row.resolved,
    failed: detectors.filter((d) => d.error).length,
  };
}

/**
 * "Refresh now": the same sweep the schedule runs, for a person who holds
 * `administer` on the exception centre, reporting what it really did. It runs
 * as the system operator (it must read every branch to be right) but is
 * started, and audited, by the person; the findings stay narrowed by their
 * own grants when anybody reads them.
 */
export async function refreshNow(tx: Tx, ctx: ActorContext): Promise<SweepResult> {
  await authz.authorize(ctx.principal, 'administer', PERMISSION_OBJECT, { branchCode: ctx.branchCode });
  const scope = await systemScope();
  const last = await db.transaction(async (tx) => {
    await applyScope(tx, scope);
    const [row] = ((await tx.execute(sql`
      select id::text, trigger, business_date::text as "businessDate", started_at, finished_at, found, created, updated, reopened, resolved, notified, detectors,
             extract(epoch from (now() - finished_at))::int as age
        from exception_sweep_run order by id desc limit 1`)) as unknown as { rows: Record<string, unknown>[] }).rows;
    return row ?? null;
  });
  if (last && Number(last.age) < REFRESH_MIN_SECONDS) {
    return {
      runId: String(last.id),
      trigger: last.trigger as 'schedule' | 'manual',
      businessDate: String(last.businessDate),
      startedAt: new Date(last.started_at as string).toISOString(),
      finishedAt: new Date(last.finished_at as string).toISOString(),
      found: Number(last.found),
      created: Number(last.created),
      updated: Number(last.updated),
      reopened: Number(last.reopened),
      resolved: Number(last.resolved),
      notified: Number(last.notified),
      detectors: last.detectors as DetectorResult[],
      reused: true,
    };
  }
  const result = await sweep({ trigger: 'manual', triggeredBy: ctx.principal.userId, scope });
  await recordChange(tx, ctx, {
    action: 'exception.refreshed',
    objectType: PERMISSION_OBJECT,
    objectId: result.runId,
    after: { found: result.found, created: result.created, reopened: result.reopened, resolved: result.resolved, failed: result.detectors.filter((d) => d.error).length },
  });
  return result;
}

