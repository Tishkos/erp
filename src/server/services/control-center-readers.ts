/**
 * The Control Center's checks — platform phase, Agent 9: one reader per check.
 *
 * Every reader asks a question a service already answers and says what it
 * found as a `Reading` (`domain/control-center`): the figures it compared and,
 * if something needs attention, the first things that do. None repeats the
 * arithmetic of the service it reads, none writes, and none decides who may
 * run it — `services/control-center.run` has already checked the grants of the
 * screen the check summarises, and runs the reader as the viewer, inside a
 * transaction PostgreSQL holds read-only and a savepoint of its own.
 *
 * Where the Exception Center already has a detector for the condition, the
 * reader runs that detector as the viewer (`RUNNERS`) and shows what it found
 * in the detector's own words, so the two screens cannot describe one fault
 * differently. Where the check is about FIGURES that agree — the sub-ledger
 * and its control account, the trial balance's two sides, the stock layers and
 * the inventory accounts — the reader shows the figures even when they agree.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { userRole } from '../db/schema';
import { businessDateOf } from '../domain/business-date';
import {
  capItems,
  compareAmounts,
  isZeroAmount,
  jobState,
  minutesSince,
  readingOf,
  sumAmounts,
  transitIssues,
  unknownObjects,
  type Figure,
  type Item,
  type Reading,
} from '../domain/control-center';
import { detectorOf, severityRank, type ExceptionFacts, type Finding } from '../domain/exceptions';
import { menuObjects } from '../domain/menu';
import { MONEY_SCALE, parseDecimal, toDecimalString } from '../domain/money';
import { assertCan, type Principal } from '../domain/permissions';
import { profileHref } from '../domain/profiles';
import { registerAllRecords } from '../records';
import { secretKeyProblem } from '../secret-box';
import * as accountsCloud from './cloud-accounts';
import * as attachments from './attachments';
import * as cloudSettings from './cloud-settings';
import * as customerReconciliation from './customer-reconciliation';
import { RUNNERS } from './exception-detectors';
import { FX_ROLE } from './exception-detectors/accounting';
import type { DetectContext } from './exception-detectors/shared';
import { enc } from './exception-detectors/shared';
import * as valuation from './inventory-valuation';
import * as logisticsViews from './logistics-views';
import * as openItems from './open-items';
import * as roles from './roles';
import * as scheduledJobs from './scheduled-jobs';
import * as supplierBalances from './supplier-balances';
import * as health from './system-health';
import * as trialBalance from './trial-balance';
import * as users from './users';
import * as whatsapp from './whatsapp';

/** Host files and services a few checks read. Tests point them at a temporary directory; production uses the defaults. */
export interface HostOptions {
  readonly backupRoot?: string;
  readonly jobStateDir?: string;
  readonly logDir?: string;
  readonly crontab?: string;
  readonly diskPath?: string;
}

export interface CheckContext {
  readonly tx: Tx;
  readonly principal: Principal;
  /** The branch the request works in — the scope the jobs service authorises against. */
  readonly branchCode: string;
  readonly today: string;
  readonly now: Date;
  readonly host: HostOptions;
  /** Loads once per run what several checks share; a failed load is not remembered. */
  readonly memo: <T>(key: string, load: () => Promise<T>) => Promise<T>;
}

export type Reader = (context: CheckContext) => Promise<Reading>;

// ---------------------------------------------------------------------------
// Small shapers
// ---------------------------------------------------------------------------

const amount = (key: string, value: string, params?: Figure['params']): Figure => ({ key, amountIqd: value, ...(params ? { params } : {}) });
const count = (key: string, value: number, params?: Figure['params']): Figure => ({ key, count: value, ...(params ? { params } : {}) });
const text = (key: string, value: string, params?: Figure['params']): Figure => ({ key, text: value, ...(params ? { params } : {}) });

const item = (code: string, params: Item['params'], ref: string | null, href: string | null): Item => ({ code, params, ref, href });

/** The options that were given — the services declare optional properties as absent, not undefined. */
const defined = <T extends Record<string, string | undefined>>(options: T): { [K in keyof T]?: string } =>
  Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)) as { [K in keyof T]?: string };

const local = (href: string | null | undefined): string | null => (href && href.startsWith('/') ? href : null);

/** Facts are `string | number | null`; an item's parameters are `string | number`. */
const paramsOf = (facts: ExceptionFacts): Record<string, string | number> =>
  Object.fromEntries(Object.entries(facts).map(([name, value]) => [name, value ?? '']));

/** A finding of the Exception Center, as an item worded by its detector. */
const itemOfFinding = (finding: Finding): Item => ({
  code: finding.detector,
  detector: finding.detector,
  params: paramsOf(finding.facts),
  ref: finding.record.label || null,
  href: local(finding.record.href) ?? local(finding.action),
});

const detectContext = (context: CheckContext): DetectContext => ({
  tx: context.tx,
  principal: context.principal,
  today: context.today,
  now: context.now,
  truncated: new Map(),
});

/**
 * What the viewer may be told of the findings a detector made. The detectors run as the viewer, so every table they
 * read through is narrowed by row-level security — but a few read through views the database owner owns, and a
 * finding names a record and its figures. So the Exception Center's own three rules are applied here to each
 * finding: the viewer holds the grant of the object the detector is about, the finding's branch is one of theirs
 * (a finding of no branch is the company's), and the record it names is one they may open
 * (`attachments.mayAccessParent`, the rule Search and the paperclip ask).
 */
async function runDetector(context: CheckContext, code: string): Promise<Finding[]> {
  const runner = RUNNERS[code];
  const definition = detectorOf(code);
  if (!runner || !definition) throw new Error(`no detector ${code}`);
  const { principal, tx } = context;
  assertCan(principal, 'view', definition.object);
  registerAllRecords();
  const found = await runner(detectContext(context));
  const kept: Finding[] = [];
  const memo = new Map<string, boolean>();
  for (const finding of found) {
    if (finding.branchCode !== null && !principal.isSuperUser && !principal.branchCodes.includes(finding.branchCode)) continue;
    const key = `${finding.record.type}|${finding.record.id}`;
    let open = memo.get(key);
    if (open === undefined) {
      open = (await attachments.mayAccessParent(tx, principal, finding.record.type, finding.record.id)) !== false;
      memo.set(key, open);
    }
    if (open) kept.push(finding);
  }
  return kept;
}

/** The reading of a check whose whole question is "does this detector find anything?". */
async function readFindings(context: CheckContext, codes: readonly string[], extra: readonly Figure[] = []): Promise<Reading> {
  const found: Finding[] = [];
  for (const code of codes) found.push(...(await runDetector(context, code)));
  found.sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return readingOf({ figures: [...extra, count('found', found.length)], items: found.map(itemOfFinding), attention: found.length });
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

const ALL_TIME = { from: '1900-01-01', to: '9999-12-31' } as const;

const trialBalanceReader: Reader = async ({ tx }) => {
  const rows = await trialBalance.trialBalance(tx, { ...ALL_TIME, allPermittedBranches: true });
  const totals = trialBalance.totalsOf(rows);
  const comparison = compareAmounts(totals.debit, totals.credit);
  const items = comparison.equal
    ? []
    : [item('trial_balance_difference', { debitIqd: comparison.leftIqd, creditIqd: comparison.rightIqd, differenceIqd: comparison.differenceIqd }, null, '/finance/trial-balance')];
  return readingOf({
    figures: [amount('debit', comparison.leftIqd), amount('credit', comparison.rightIqd), amount('difference', comparison.differenceIqd), count('accounts', rows.length)],
    items,
    attention: items.length,
  });
};

const journalIntegrityReader: Reader = async ({ tx }) => {
  const all = await trialBalance.integrityReport(tx);
  // `gl_integrity_issue` is a view owned by the database owner, so it names every branch's journals; the viewer is
  // told only of the ones row-level security lets them read.
  const references = [...new Set(all.map((issue) => issue.reference))];
  const readable = new Set<string>();
  if (references.length > 0) {
    const rows = (await tx.execute(sql`select entry_no as "entryNo" from journal_entry where entry_no in (${sql.join(references.map((r) => sql`${r}`), sql`, `)})`)).rows as { entryNo: string }[];
    for (const row of rows) readable.add(row.entryNo);
  }
  const issues = all.filter((issue) => readable.has(issue.reference));
  return readingOf({
    figures: [count('issues', issues.length)],
    // Worded by the Exception Center's detector for the same view (`accounting.gl_integrity`).
    items: issues.map((issue) => ({
      code: 'accounting.gl_integrity',
      detector: 'accounting.gl_integrity',
      params: { entry: issue.reference, issue: issue.issue, detail: issue.detail },
      ref: issue.reference,
      href: `/finance/journals/${enc(issue.reference)}`,
    })),
    attention: issues.length,
  });
};

const bankReconciliationReader: Reader = (context) => readFindings(context, ['accounting.bank_reconciliation_difference']);

const bankAccountsReader: Reader = async ({ tx }) => {
  const dangling = await health.unlinkedBankAccounts(tx);
  return readingOf({
    figures: [count('accounts_unlinked', dangling.length)],
    items: dangling.map((account) =>
      item(
        'bank_account_unlinked',
        { account: account.code },
        account.code,
        profileHref(account.accountType === 'cash' ? 'cash_account' : 'bank_account', account.code) ?? '/master-data/bank-accounts',
      ),
    ),
    attention: dangling.length,
  });
};

const unmappedRoles = (context: CheckContext) => context.memo('accounting.posting_role_unmapped', () => runDetector(context, 'accounting.posting_role_unmapped'));

const postingRolesReader: Reader = async (context) => {
  const found = (await unmappedRoles(context)).filter((finding) => !FX_ROLE.test(String(finding.facts.postingRole ?? '')));
  return readingOf({ figures: [count('found', found.length)], items: found.map(itemOfFinding), attention: found.length });
};

const fxMappingReader: Reader = async (context) => {
  const found = (await unmappedRoles(context)).filter((finding) => FX_ROLE.test(String(finding.facts.postingRole ?? '')));
  return readingOf({ figures: [count('found', found.length)], items: found.map(itemOfFinding), attention: found.length });
};

const postingFailuresReader: Reader = (context) => readFindings(context, ['accounting.posting_failed']);

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const stockVsGlReader: Reader = async ({ tx, today }) => {
  const figure = await valuation.stockAgainstGl(tx, today);
  // The question the period close and Inventory Checks already ask: do the FIFO layers and the inventory accounts
  // hold the same value, to the fils. `provisional` — layers whose making movement carries no journal of its own,
  // such as the layers a container receipt makes out of goods the invoice already booked — is shown beside the
  // figures and is not subtracted: the accounts already hold that value by the invoice's journal, so taking it
  // out would invent a difference where there is none.
  const comparison = compareAmounts(figure.layersIqd, figure.glIqd);
  const items = comparison.equal
    ? []
    : [
        item(
          'stock_gl_difference',
          { layersIqd: comparison.leftIqd, glIqd: comparison.rightIqd, provisionalIqd: figure.provisionalIqd, differenceIqd: comparison.differenceIqd },
          null,
          '/inventory/fifo-valuation',
        ),
      ];
  return readingOf({
    figures: [amount('stock_layers', comparison.leftIqd), amount('stock_accounts', comparison.rightIqd), amount('difference', comparison.differenceIqd), amount('stock_provisional', figure.provisionalIqd)],
    items,
    attention: items.length,
  });
};

const negativeStockReader: Reader = (context) => readFindings(context, ['inventory.negative_stock']);
const fifoLayersReader: Reader = (context) => readFindings(context, ['inventory.layer_mismatch']);
const documentsLedgerReader: Reader = (context) => readFindings(context, ['inventory.document_ledger_mismatch']);
const transitReader: Reader = (context) => readFindings(context, ['inventory.transit_mismatch']);

// ---------------------------------------------------------------------------
// Receivables and payables
// ---------------------------------------------------------------------------

/** The sub-ledger against the control accounts of one side, with the lines that make a difference. */
async function controlAccountReading(
  context: CheckContext,
  side: openItems.Side,
  accounts: readonly { accountCode: string; accountName: string; subledgerIqd: string; generalLedgerIqd: string; differenceIqd: string }[],
  route: string,
): Promise<Reading> {
  const subledger = sumAmounts(accounts.map((a) => a.subledgerIqd));
  const control = sumAmounts(accounts.map((a) => a.generalLedgerIqd));
  const total = compareAmounts(subledger, control);
  const differing = accounts.filter((a) => !isZeroAmount(a.differenceIqd));
  const lines = await runDetector(context, side === 'customer' ? 'receivables.ledger_inconsistency' : 'payables.ledger_inconsistency');
  const items: Item[] = [
    ...differing.map((a) =>
      item(
        'control_difference',
        { account: `${a.accountCode} ${a.accountName}`, subledgerIqd: a.subledgerIqd, glIqd: a.generalLedgerIqd, differenceIqd: a.differenceIqd },
        a.accountCode,
        route,
      ),
    ),
    ...lines.map(itemOfFinding),
  ];
  return readingOf({
    figures: [amount('subledger', total.leftIqd), amount('control_account', total.rightIqd), amount('difference', total.differenceIqd), count('lines', lines.length)],
    items,
    attention: differing.length + lines.length,
  });
}

const receivablesControlReader: Reader = async (context) => {
  const rows = await customerReconciliation.controlAccounts(context.tx, context.principal, context.today);
  return controlAccountReading(context, 'customer', rows, '/sales/customer-reconciliation');
};

const payablesControlReader: Reader = async (context) => {
  const rows = await supplierBalances.controlAccounts(context.tx, context.principal, context.today);
  return controlAccountReading(
    context,
    'supplier',
    rows.map((r) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      subledgerIqd: toDecimalString(r.subledgerIqd),
      generalLedgerIqd: toDecimalString(r.generalLedgerIqd),
      differenceIqd: toDecimalString(r.differenceIqd),
    })),
    '/payables/reconciliation',
  );
};

/**
 * The statement against the ageing, party by party: what the sub-ledger says is owed, and the open documents that
 * account for it (`open-items.reconcile`). A party whose statement shows MORE owed than their open documents has a
 * debit with no document behind it — the finding. One who has paid ahead (credit not yet applied) is shown in the
 * figures and is not a fault.
 */
async function statementAgeingReading(context: CheckContext, side: openItems.Side): Promise<Reading> {
  const { tx, principal, today } = context;
  const documents = await openItems.openItems(tx, principal, side, today, { outstandingOnly: true });
  const balances = await openItems.ledgerBalances(tx, principal, side, today);
  const rows = openItems.reconcile(documents, balances);
  const totals = openItems.reconciliationTotals(rows);
  const largestFirst = (a: openItems.Reconciliation, b: openItems.Reconciliation): number => {
    const d = parseDecimal(b.otherNonInvoiceDebitIqd, MONEY_SCALE) - parseDecimal(a.otherNonInvoiceDebitIqd, MONEY_SCALE);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  };
  const above = rows.filter((row) => !isZeroAmount(row.otherNonInvoiceDebitIqd)).sort(largestFirst);
  return readingOf({
    figures: [
      amount('statement', totals.ledgerIqd),
      amount('ageing', totals.documentsIqd),
      amount('unapplied_credits', totals.unappliedCreditsIqd),
      amount('debits_without_document', totals.otherNonInvoiceDebitsIqd),
      count('parties', rows.length),
    ],
    items: above.map((row) =>
      item(
        'statement_above_ageing',
        { party: `${row.partyCode} ${row.partyName}`, ledgerIqd: row.ledgerIqd, documentsIqd: row.documentsIqd, differenceIqd: row.otherNonInvoiceDebitIqd },
        row.partyCode,
        profileHref(side === 'customer' ? 'customer' : 'supplier', row.partyCode),
      ),
    ),
    attention: above.length,
  });
}

const receivablesStatementReader: Reader = (context) => statementAgeingReading(context, 'customer');
const payablesStatementReader: Reader = (context) => statementAgeingReading(context, 'supplier');
const supplierCreditsReader: Reader = (context) => readFindings(context, ['payables.supplier_credit_inconsistency']);

// ---------------------------------------------------------------------------
// Logistics
// ---------------------------------------------------------------------------

const transitIssuesReader: Reader = async ({ tx }) => {
  const { rows } = await logisticsViews.inTransitInventory(tx, { view: 'all' });
  const found = rows.flatMap((row) =>
    transitIssues({ ordered: row.ordered, shipped: row.shipped, received: row.received, inTransit: row.inTransit, containers: row.containers, containersOpen: row.containersOpen }).map((issue) => ({ row, issue })),
  );
  return readingOf({
    figures: [count('imports', new Set(rows.map((r) => r.payableId)).size), count('found', found.length)],
    items: found.map(({ row, issue }) =>
      item(
        `transit_${issue}`,
        { importNo: row.payableNo, item: `${row.itemCode} ${row.itemName ?? ''}`.trim(), orderedQty: row.ordered, shippedQty: row.shipped, receivedQty: row.received, inTransitQty: row.inTransit },
        row.payableNo,
        profileHref('import', row.payableNo),
      ),
    ),
    attention: found.length,
  });
};

const landedCostsReader: Reader = (context) => readFindings(context, ['logistics.landed_cost_blocked']);
const customsReader: Reader = (context) => readFindings(context, ['logistics.customs_issue']);
const shipmentDelaysReader: Reader = (context) => readFindings(context, ['logistics.container_delayed', 'logistics.shipment_update_stale']);

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

const actorOf = (context: CheckContext) => ({ principal: context.principal, branchCode: context.branchCode });

const jobsReader: Reader = async (context) => {
  const stateDir = context.host.jobStateDir ?? process.env.JOB_STATE_DIR ?? join(process.cwd(), 'var', 'jobs');
  if (!existsSync(stateDir)) return readingOf({ unavailable: { code: 'no_host_data', params: { what: 'jobs' } } });
  const listed = await scheduledJobs.listScheduled(actorOf(context), { jobStateDir: stateDir, ...defined({ logDir: context.host.logDir, crontab: context.host.crontab }) });
  if (listed.length === 0) return readingOf({ unavailable: { code: 'no_host_data', params: { what: 'crontab' } } });
  const items: Item[] = [];
  let ok = 0;
  for (const job of listed) {
    const state = jobState({ name: job.name, schedule: job.schedule, lastRunAt: job.lastRunAt, lastExit: job.lastExit }, context.now);
    if (state === 'ok') {
      ok += 1;
    } else if (state === 'failed') {
      items.push(item('job_failed', { job: job.name, exit: job.lastExit ?? 0, lastDate: businessDateOf(new Date(job.lastRunAt!)) }, job.name, '/administration/jobs'));
    } else if (state === 'overdue') {
      const minutes = minutesSince(job.lastRunAt, context.now) ?? 0;
      items.push(item('job_overdue', { job: job.name, hours: Math.floor(minutes / 60), schedule: job.schedule }, job.name, '/administration/jobs'));
    } else {
      items.push(item('job_never', { job: job.name }, job.name, '/administration/jobs'));
    }
  }
  return readingOf({ figures: [count('jobs', listed.length), count('jobs_ok', ok)], items, attention: items.length });
};

const DAY_MS = 24 * 3_600_000;

const outboxReader: Reader = async (context) => {
  const { queues } = await scheduledJobs.outbox(context.tx, actorOf(context));
  const items: Item[] = [];
  for (const queue of queues) {
    if (queue.abandoned > 0) items.push(item('outbox_abandoned', { queue: queue.queue, abandoned: queue.abandoned }, queue.queue, '/administration/jobs'));
    if (queue.pending > 0 && queue.oldestPendingAt && context.now.getTime() - Date.parse(queue.oldestPendingAt) > DAY_MS) {
      items.push(item('outbox_waiting', { queue: queue.queue, pending: queue.pending, oldestDate: businessDateOf(new Date(queue.oldestPendingAt)) }, queue.queue, '/administration/jobs'));
    }
  }
  const pending = queues.reduce((n, q) => n + q.pending, 0);
  const abandoned = queues.reduce((n, q) => n + q.abandoned, 0);
  return readingOf({ figures: [count('queues', queues.length), count('pending', pending), count('abandoned', abandoned)], items, attention: items.length });
};

/** A failed delivery counts for a week: a mail that bounced last month is history, one from this week needs the mail settings looked at. */
const FAILED_DELIVERY_DAYS = 7;

const deliveriesReader: Reader = async ({ tx, now }) => {
  const stuck = await health.stuckDeliveries(tx);
  const since = new Date(now.getTime() - FAILED_DELIVERY_DAYS * DAY_MS).toISOString();
  const failed = (
    await tx.execute(sql`
      select channel::text as channel, count(*)::int as n
        from notification_delivery
       where status = 'failed' and last_attempt_at >= ${since}::timestamptz
       group by channel order by channel`)
  ).rows as { channel: string; n: number }[];
  const items: Item[] = [];
  if (stuck > 0) items.push(item('deliveries_stuck', { count: stuck }, null, '/administration/jobs'));
  for (const row of failed) items.push(item('deliveries_failed', { channel: row.channel, count: row.n, days: FAILED_DELIVERY_DAYS }, row.channel, '/administration/jobs'));
  const failedTotal = failed.reduce((n, row) => n + row.n, 0);
  return readingOf({ figures: [count('deliveries_stuck', stuck), count('deliveries_failed', failedTotal, { days: FAILED_DELIVERY_DAYS })], items, attention: items.length });
};

/** The bridge writes its heartbeat every minute; five minutes of silence is a stopped bridge. */
const BRIDGE_SILENCE_MS = 5 * 60_000;

const whatsappReader: Reader = async ({ tx, now }) => {
  const status = await whatsapp.bridgeStatus(tx);
  if (!status.paired && status.lastSeenAt === null) return readingOf({ notConfigured: true });
  const items: Item[] = [];
  if (!status.paired) items.push(item('whatsapp_not_paired', { state: status.state ?? '' }, null, '/administration/whatsapp'));
  if (status.paired && status.state !== 'connected') items.push(item('whatsapp_state', { state: status.state ?? '' }, status.me, '/administration/whatsapp'));
  if (status.lastSeenAt === null) {
    items.push(item('whatsapp_never_seen', {}, status.me, '/administration/whatsapp'));
  } else if (now.getTime() - status.lastSeenAt.getTime() > BRIDGE_SILENCE_MS) {
    items.push(item('whatsapp_silent', { lastSeenDate: businessDateOf(status.lastSeenAt) }, status.me, '/administration/whatsapp'));
  }
  return readingOf({
    figures: [text('bridge_state', status.state ?? '—'), count('pending_deliveries', status.pendingDeliveries)],
    items,
    attention: items.length,
  });
};

/** The runner is scheduled every five minutes; an event still waiting after half an hour means it is not running. */
const AUTOMATION_BEHIND_MS = 30 * 60_000;

/**
 * Automation (platform phase, Agent 10): reads the rules and the run log as they are —
 * a rule paused by its failures, a rule whose runs failed this week, events the runner
 * has not taken, and the whole of automation left switched off. Nothing set up (no rule
 * yet) is not a problem: "not set up here".
 */
const automationReader: Reader = async ({ tx, now }) => {
  const [totals] = (
    await tx.execute(sql`
      select (select count(*)::int from automation_rule) as rules,
             (select count(*)::int from automation_rule where enabled) as "on",
             (select count(*)::int from automation_run where outcome = 'failed' and started_at > ${now.toISOString()}::timestamptz - interval '7 days') as failed_week,
             (select count(*)::int from automation_event where status in ('pending', 'retry')) as waiting,
             (select value from automation_setting where key = 'enabled') as switch`)
  ).rows as { rules: number; on: number; failed_week: number; waiting: number; switch: string | null }[];
  if (!totals || totals.rules === 0) return readingOf({ notConfigured: true });
  const items: Item[] = [];
  if (totals.switch === 'off') items.push(item('automation_off', {}, null, '/administration/automation'));
  const paused = (
    await tx.execute(sql`select rule_no, name, paused_reason, paused_at from automation_rule where paused_at is not null order by paused_at desc limit 20`)
  ).rows as { rule_no: string; name: string; paused_reason: string | null; paused_at: Date | string }[];
  for (const rule of paused) {
    items.push(item('automation_paused', { name: rule.name, reason: (rule.paused_reason ?? '').slice(0, 200), pausedDate: businessDateOf(new Date(rule.paused_at)) }, rule.rule_no, `/administration/automation/${encodeURIComponent(rule.rule_no)}`));
  }
  const failing = (
    await tx.execute(sql`
      select r.rule_no, r.name, count(*)::int as failed, max(x.started_at) as last_at
        from automation_run x join automation_rule r on r.id = x.rule_id
       where x.outcome = 'failed' and x.started_at > ${now.toISOString()}::timestamptz - interval '7 days' and r.paused_at is null
       group by r.rule_no, r.name order by max(x.started_at) desc limit 20`)
  ).rows as { rule_no: string; name: string; failed: number; last_at: Date | string }[];
  for (const rule of failing) {
    items.push(item('automation_failing', { name: rule.name, failed: rule.failed, lastDate: businessDateOf(new Date(rule.last_at)) }, rule.rule_no, `/administration/automation/${encodeURIComponent(rule.rule_no)}`));
  }
  const [behind] = (
    await tx.execute(sql`
      select count(*)::int as n, min(occurred_at) as since from automation_event
       where status in ('pending', 'retry') and next_attempt_at < ${new Date(now.getTime() - AUTOMATION_BEHIND_MS).toISOString()}::timestamptz`)
  ).rows as { n: number; since: Date | string | null }[];
  if (behind && behind.n > 0 && behind.since) items.push(item('automation_behind', { count: behind.n, sinceDate: businessDateOf(new Date(behind.since)) }, null, '/administration/automation'));
  return readingOf({
    figures: [count('automation_rules', totals.rules), count('automation_rules_on', totals.on), count('automation_failed_runs', totals.failed_week), count('automation_waiting', totals.waiting)],
    items,
    attention: items.length,
  });
};

const cloudReader: Reader = async ({ tx, principal }) => {
  const own = await accountsCloud.stateFor(tx, principal.userId);
  if (!own.settings.enabled) return readingOf({ notConfigured: true });
  const items: Item[] = [];
  if (!own.settings.baseUrl) items.push(item('cloud_no_address', {}, null, '/administration/cloud-files'));
  const keyProblem = secretKeyProblem();
  if (keyProblem) items.push(item('cloud_secret_key', { message: keyProblem }, null, '/administration/cloud-files'));
  if (own.state === 'relink') items.push(item('cloud_relink', {}, own.account?.cloudUser ?? null, '/administration/cloud-files'));
  let strayed = 0;
  let live = 0;
  if (own.settings.baseUrl) {
    const [row] = (
      await tx.execute(sql`
        select count(*)::int as live, count(*) filter (where server_url <> ${own.settings.baseUrl})::int as strayed
          from cloud_file_link where unlinked_at is null`)
    ).rows as { live: number; strayed: number }[];
    live = row?.live ?? 0;
    strayed = row?.strayed ?? 0;
    if (strayed > 0) items.push(item('cloud_links_elsewhere', { count: strayed }, null, '/administration/cloud-files'));
  }
  return readingOf({
    figures: [text('cloud_address', own.settings.baseUrl ?? '—'), count('cloud_links', live), text('cloud_own_connection', own.state)],
    items,
    attention: items.length,
  });
};

/** Findings the health report raises that another check of this screen owns. */
const OWNED_ELSEWHERE = new Set(['job_failed', 'deliveries_stuck', 'bank_account_unlinked']);

const systemHealthReader: Reader = async ({ tx, now, host }) => {
  const probe = await health.probe(tx);
  const report = await health.check(tx, { now, ...defined({ backupRoot: host.backupRoot, jobStateDir: host.jobStateDir, diskPath: host.diskPath }) });
  const items: Item[] = [];
  if (!probe.database) items.push(item('health_database', {}, null, '/administration/backup-health'));
  if (probe.database && !probe.migrations.atHead) {
    items.push(item('health_migrations', { applied: probe.migrations.applied, expected: probe.migrations.expected ?? 0 }, null, '/administration/backup-health'));
  }
  for (const finding of report.findings.filter((f) => !OWNED_ELSEWHERE.has(f.code))) {
    items.push(item('health_finding', { healthCheck: finding.code, message: finding.message.slice(0, 400) }, finding.code, '/administration/backup-health'));
  }
  return readingOf({
    figures: [text('migrations', `${probe.migrations.applied}${probe.migrations.expected === null ? '' : ` / ${probe.migrations.expected}`}`), text('build', probe.build), count('health_checked', report.checked.length)],
    items,
    attention: items.length,
  });
};

const usersWithoutRoleReader: Reader = async ({ tx }) => {
  const all = await users.listAll(tx);
  const withRole = new Set((await tx.select({ userId: userRole.userId }).from(userRole)).map((r) => r.userId));
  const active = all.filter((user) => user.isActive);
  // A Super User passes every check without a role; the check about them is `platform.super_users`.
  const bare = active.filter((user) => !user.isSuperUser && !withRole.has(user.id));
  return readingOf({
    figures: [count('users_active', active.length), count('users_without_role', bare.length)],
    items: bare.map((user) => item('user_without_role', { user: user.displayName, email: user.email }, user.email, profileHref('user', user.id))),
    attention: bare.length,
  });
};

const unknownGrantsReader: Reader = async ({ tx }) => {
  const { grants } = await roles.matrix(tx);
  const objects = [...new Set(grants.map((g) => g.object))];
  const unknown = unknownObjects(objects, menuObjects());
  return readingOf({
    figures: [count('grant_objects', objects.length), count('grants_unknown', unknown.length)],
    items: unknown.map((object) => {
      const holders = [...new Set(grants.filter((g) => g.object === object).map((g) => g.roleCode))];
      return item('unknown_grant', { object, roles: holders.join(', ') }, object, '/administration/permissions');
    }),
    attention: unknown.length,
  });
};

const superUsersReader: Reader = async ({ tx }) => {
  const supers = (await users.listAll(tx)).filter((user) => user.isActive && user.isSuperUser);
  const listed = capItems(supers).shown;
  const needsAttention = supers.length > 1;
  return readingOf({
    figures: [count('super_users', supers.length), ...listed.map((user) => text('super_user', user.email, { user: user.displayName }))],
    items: needsAttention ? supers.map((user) => item('super_user', { user: user.displayName, email: user.email }, user.email, profileHref('user', user.id))) : [],
    attention: needsAttention ? supers.length : 0,
  });
};

const employeeLinksReader: Reader = async ({ tx }) => {
  // A user is expected to have an employee in their first branch (`employees.createForUser`); employee rows are
  // branch-scoped, so a user whose branch the viewer cannot read is not counted as missing one.
  const missing = (
    await tx.execute(sql`
      select u.id::text as id, u.email, u.display_name as "displayName"
        from app_user u
        left join lateral (
          select s.branch_code from user_branch_scope s
           where s.user_id = u.id order by s.is_default desc, s.branch_code limit 1) b on true
       where u.is_active
         and not exists (select 1 from employee e where e.app_user_id = u.id)
         and ((b.branch_code is null and app_is_super_user()) or (b.branch_code is not null and app_branch_allowed(b.branch_code)))
       order by u.email`)
  ).rows as { id: string; email: string; displayName: string }[];
  const ended = (
    await tx.execute(sql`
      select e.employee_no as "employeeNo", e.full_name_en as "name", u.email
        from employee e join app_user u on u.id = e.app_user_id
       where e.status = 'ended' and u.is_active
       order by e.employee_no`)
  ).rows as { employeeNo: string; name: string; email: string }[];
  const items: Item[] = [
    ...missing.map((row) => item('user_without_employee', { user: row.displayName, email: row.email }, row.email, profileHref('user', row.id))),
    ...ended.map((row) => item('employee_ended_user_active', { employee: row.name, email: row.email }, row.employeeNo, profileHref('employee', row.employeeNo))),
  ];
  return readingOf({
    figures: [count('users_without_employee', missing.length), count('ended_with_active_user', ended.length)],
    items,
    attention: items.length,
  });
};

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const READERS: Readonly<Record<string, Reader>> = Object.freeze({
  'accounting.trial_balance': trialBalanceReader,
  'accounting.journal_integrity': journalIntegrityReader,
  'accounting.bank_reconciliation': bankReconciliationReader,
  'accounting.bank_accounts': bankAccountsReader,
  'accounting.posting_roles': postingRolesReader,
  'accounting.fx_mapping': fxMappingReader,
  'accounting.posting_failures': postingFailuresReader,
  'inventory.stock_vs_gl': stockVsGlReader,
  'inventory.negative_stock': negativeStockReader,
  'inventory.fifo_layers': fifoLayersReader,
  'inventory.documents_ledger': documentsLedgerReader,
  'inventory.transit': transitReader,
  'receivables.control_account': receivablesControlReader,
  'receivables.statement_ageing': receivablesStatementReader,
  'payables.control_account': payablesControlReader,
  'payables.statement_ageing': payablesStatementReader,
  'payables.supplier_credits': supplierCreditsReader,
  'logistics.transit_issues': transitIssuesReader,
  'logistics.landed_costs': landedCostsReader,
  'logistics.customs': customsReader,
  'logistics.shipment_delays': shipmentDelaysReader,
  'platform.jobs': jobsReader,
  'platform.outbox': outboxReader,
  'platform.deliveries': deliveriesReader,
  'platform.whatsapp': whatsappReader,
  'platform.automation': automationReader,
  'platform.cloud': cloudReader,
  'platform.system_health': systemHealthReader,
  'platform.users_without_role': usersWithoutRoleReader,
  'platform.unknown_grants': unknownGrantsReader,
  'platform.super_users': superUsersReader,
  'platform.employee_links': employeeLinksReader,
});
