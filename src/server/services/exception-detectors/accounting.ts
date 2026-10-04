/**
 * Accounting detectors — platform phase, Agent 7.
 *
 * Each reads a condition an existing service already knows how to ask; none
 * repeats its arithmetic. They return findings and write nothing.
 */
import { sql } from 'drizzle-orm';
import { daysBetween } from '../../domain/ageing';
import { EVIDENCE_CAP, EVIDENCE_ROW, THRESHOLDS, severityByDays, type EvidenceRow, type Finding } from '../../domain/exceptions';
import { POSTING_MAP, mappingAccountEligible } from '../../domain/posting-map';
import { toDecimalString } from '../../domain/money';
import * as bankReconciliation from '../bank-reconciliation';
import * as chart from '../chart-of-accounts';
import * as closingChecks from '../closing-checks';
import * as customerReconciliation from '../customer-reconciliation';
import * as posting from '../posting';
import * as subledger from '../subledger';
import * as supplierBalances from '../supplier-balances';
import { enc, isZero, rowsOf, userNames, type DetectContext } from './shared';

// ---------------------------------------------------------------------------
// A bank reconciliation left open with a difference
// ---------------------------------------------------------------------------

/**
 * A reconciliation nobody has signed whose statement ended a while ago and
 * whose figures still do not agree. Today's figures, not the ones stored when
 * it was opened: `bank-reconciliation.position` is the workspace's own
 * arithmetic.
 */
export async function bankReconciliationDifference(ctx: DetectContext): Promise<Finding[]> {
  const { tx, principal, today } = ctx;
  const open = rowsOf<{
    id: string;
    reconciliation_no: string;
    branch_code: string;
    as_of_date: string;
    prepared_by: string;
    statement_no: string;
    account_code: string;
    account_name: string;
  }>(
    await tx.execute(sql`
      select r.id::text, r.reconciliation_no, r.branch_code, r.as_of_date::text, r.prepared_by::text,
             s.statement_no, b.code as account_code, b.name as account_name
        from bank_reconciliation r
        join bank_statement s on s.id = r.statement_id
        join bank_cash_account b on b.id = r.bank_cash_account_id
       where r.approved_at is null
       order by r.as_of_date, r.reconciliation_no`),
  );
  const names = await userNames(tx, open.map((r) => r.prepared_by));
  const findings: Finding[] = [];
  for (const row of open) {
    const days = daysBetween(row.as_of_date, today);
    const severity = severityByDays(days, THRESHOLDS.bankReconciliation);
    if (severity === null) continue;
    const position = await bankReconciliation.position(tx, { principal, branchCode: row.branch_code }, row.id);
    if (position.differenceIqd === 0n) continue;
    const href = `/treasury/bank-reconciliation/${enc(row.statement_no)}`;
    findings.push({
      detector: 'accounting.bank_reconciliation_difference',
      subject: row.reconciliation_no,
      severity,
      facts: {
        reconciliation: row.reconciliation_no,
        account: `${row.account_code} ${row.account_name}`,
        asOfDate: row.as_of_date,
        days,
        differenceIqd: toDecimalString(position.differenceIqd),
        unmatchedStatementLines: position.unmatchedStatementLines,
        unmatchedLedgerItems: position.unmatchedLedgerItems,
      },
      evidence: [
        EVIDENCE_ROW({ ref: row.statement_no, href, date: row.as_of_date, amount: toDecimalString(position.statementClosingIqd), note: { code: 'bank_statement_closing' } }),
        EVIDENCE_ROW({ ref: row.account_code, href, date: row.as_of_date, amount: toDecimalString(position.ledgerBalanceIqd), note: { code: 'bank_ledger_balance' } }),
        EVIDENCE_ROW({ ref: row.reconciliation_no, href, amount: toDecimalString(position.differenceIqd), note: { code: 'bank_difference' } }),
        EVIDENCE_ROW({ ref: row.reconciliation_no, href, note: { code: 'bank_unmatched', params: { statement: position.unmatchedStatementLines, ledger: position.unmatchedLedgerItems } } }),
      ],
      record: { type: 'bank_reconciliation', id: row.id, label: row.reconciliation_no, href },
      action: href,
      branchCode: row.branch_code,
      owner: { userId: row.prepared_by, name: names.get(row.prepared_by) ?? '' },
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A control account that does not equal its sub-ledger
// ---------------------------------------------------------------------------

/** The sub-ledger totals against the general ledger on every control account, as at today (close check 4). */
export async function controlAccountDifference(ctx: DetectContext): Promise<Finding[]> {
  const { tx, principal, today } = ctx;
  const rows = (await subledger.reconciliation(tx, today)).filter((row) => !isZero(row.difference));
  if (rows.length === 0) return [];
  const ids = new Map(
    rowsOf<{ code: string; id: string }>(await tx.execute(sql`select code, id::text from chart_of_account where control_account is not null`)).map((r) => [r.code, r.id]),
  );
  const customerLines = await customerReconciliation.exceptions(tx, principal, today);
  const supplierLines = await supplierBalances.exceptions(tx, principal, today);
  const findings: Finding[] = [];
  for (const row of rows) {
    const lines = (row.subledgerType === 'customer' ? customerLines : supplierLines).filter((line) => line.accountCode === row.accountCode);
    const evidence: EvidenceRow[] = lines.slice(0, EVIDENCE_CAP).map((line) =>
      EVIDENCE_ROW({
        ref: line.entryNo,
        href: `/finance/journals/${enc(line.entryNo)}`,
        date: line.postingDate,
        amount: isZero(line.lineDebitIqd) ? `-${line.lineCreditIqd}` : line.lineDebitIqd,
        note: { code: `ledger_${line.reason}` },
      }),
    );
    findings.push({
      detector: 'accounting.control_account_difference',
      subject: row.accountCode,
      severity: 'critical',
      facts: {
        account: `${row.accountCode} ${row.accountName}`,
        side: row.subledgerType,
        subledgerIqd: row.subledgerBalance,
        glIqd: row.generalLedgerBalance,
        differenceIqd: row.difference,
        lines: lines.length,
      },
      evidence,
      record: { type: 'chart_of_account', id: ids.get(row.accountCode) ?? row.accountCode, label: row.accountCode, href: `/master-data/chart-of-accounts/${enc(row.accountCode)}` },
      action: '/finance/account-reconciliation',
      branchCode: null,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The general ledger's own integrity view
// ---------------------------------------------------------------------------

/** Posted journals that do not balance, have one line, orphaned sub-ledger entries, postings to group accounts (close check 2). */
export async function glIntegrity(ctx: DetectContext): Promise<Finding[]> {
  const { tx } = ctx;
  const issues = rowsOf<{ issue: string; reference: string; detail: string; entry_id: string | null }>(
    await tx.execute(sql`
      select i.issue, i.reference, i.detail, e.id::text as entry_id
        from gl_integrity_issue i
        left join journal_entry e on e.entry_no = i.reference
       order by i.issue, i.reference
       limit ${THRESHOLDS.findingsPerDetector + 1}`),
  );
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const issue of issues) {
    const subject = `${issue.issue}|${issue.reference}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    const href = `/finance/journals/${enc(issue.reference)}`;
    findings.push({
      detector: 'accounting.gl_integrity',
      subject,
      severity: 'critical',
      facts: { entry: issue.reference, issue: issue.issue, detail: issue.detail },
      evidence: [EVIDENCE_ROW({ ref: issue.reference, href, note: { code: `gl_${issue.issue}`, params: { detail: issue.detail } } })],
      record: { type: 'journal_entry', id: issue.entry_id ?? issue.reference, label: issue.reference, href },
      action: '/finance/trial-balance',
      branchCode: null,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A posting role with no account
// ---------------------------------------------------------------------------

const FX_ROLE = /exchange|revaluation/;

/**
 * A line a document cannot post without (`always`) and a foreign-exchange
 * line, for which the mapping in force is missing or names an account that is
 * no longer eligible — the Posting Mappings screen's own readiness rule.
 */
export async function postingRoleUnmapped(ctx: DetectContext): Promise<Finding[]> {
  const { tx } = ctx;
  const [rules, accounts] = [await posting.rules(tx), await chart.postableAccounts(tx)];
  const mapped = new Map(
    rules
      .filter((rule) => rule.isActive && !rule.itemGroup && !rule.partnerGroup && !rule.warehouseCode && !rule.projectCode && !rule.branchCode)
      .map((rule) => [`${rule.eventType} ${rule.lineRole}`, rule]),
  );
  const findings: Finding[] = [];
  for (const document of POSTING_MAP) {
    for (const line of document.lines) {
      const fx = FX_ROLE.test(line.role);
      if (!line.always && !fx) continue;
      const rule = mapped.get(`${document.event} ${line.role}`) ?? null;
      const eligible = accounts.some((account) => rule !== null && account.id === rule.accountId && mappingAccountEligible(document.event, line.role, account));
      if (rule !== null && eligible) continue;
      findings.push({
        detector: 'accounting.posting_role_unmapped',
        subject: `${document.event}|${line.role}`,
        severity: line.always ? 'high' : 'medium',
        facts: { postingEvent: document.event, postingRole: line.role, reason: rule === null ? 'missing' : 'stale', account: rule?.accountCode ?? null },
        evidence: [],
        record: { type: 'posting_rule', id: `${document.event}:${line.role}`, label: `${document.event} · ${line.role}`, href: '/finance/posting-mappings' },
        action: '/finance/posting-mappings',
        branchCode: null,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// A posting that failed and was not replayed
// ---------------------------------------------------------------------------

export async function postingFailed(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const failures = rowsOf<{
    event_type: string;
    source_module: string;
    source_doc_id: string;
    source_event: string;
    error_code: string;
    error_message: string;
    branch_code: string | null;
    occurred_at: string;
    n: number;
  }>(
    await tx.execute(sql`
      select distinct on (f.source_module, f.source_doc_id, f.source_event)
             f.event_type, f.source_module, f.source_doc_id, f.source_event, f.error_code, f.error_message, f.branch_code,
             f.occurred_at::text as occurred_at,
             count(*) over (partition by f.source_module, f.source_doc_id, f.source_event)::int as n
        from posting_failure f
       where f.resolved_at is null
       order by f.source_module, f.source_doc_id, f.source_event, f.occurred_at desc
       limit ${THRESHOLDS.findingsPerDetector + 1}`),
  );
  return failures.map((row) => ({
    detector: 'accounting.posting_failed',
    subject: `${row.source_module}|${row.source_doc_id}|${row.source_event}`,
    severity: 'high' as const,
    facts: {
      postingEvent: row.event_type,
      document: row.source_doc_id,
      module: row.source_module,
      errorMessage: row.error_message.slice(0, 300),
      attempts: row.n,
      sinceDate: row.occurred_at.slice(0, 10),
      days: daysBetween(row.occurred_at.slice(0, 10), today),
    },
    evidence: [EVIDENCE_ROW({ ref: row.source_doc_id, date: row.occurred_at.slice(0, 10), note: { code: 'posting_error', params: { message: row.error_message.slice(0, 300) } } })],
    record: { type: 'posting_failure', id: `${row.source_module}:${row.source_doc_id}:${row.source_event}`, label: row.source_doc_id, href: '/finance/posting-mappings' },
    action: '/finance/posting-mappings',
    branchCode: row.branch_code,
  }));
}

// ---------------------------------------------------------------------------
// The period that should have closed and cannot
// ---------------------------------------------------------------------------

/** Close checks other detectors own (the sub-ledger, the GL integrity, the stock ledger) are not repeated here. */
const OWNED_ELSEWHERE = new Set(['subledger_equals_gl', 'gl_integrity', 'stock_ledger_integrity']);

/**
 * The earliest period whose last day has passed and is not closed, and the
 * blocking checks of its close list that fail: journals dated in it that have
 * not posted, stock documents dated in it that are still waiting.
 */
export async function periodCloseBlocked(ctx: DetectContext): Promise<Finding[]> {
  const { tx, today } = ctx;
  const period = await closingChecks.nextToClose(tx, today);
  if (!period) return [];
  const report = await closingChecks.report(tx, period);
  const daysAfter = daysBetween(period.endsOn, today);
  const severity = daysAfter >= THRESHOLDS.periodCloseGraceDays ? ('high' as const) : ('medium' as const);
  return report.checks
    .filter((check) => check.state === 'fail' && !OWNED_ELSEWHERE.has(check.code))
    .map((check) => ({
      detector: 'accounting.period_close_blocked',
      subject: `${period.id}|${check.code}`,
      severity,
      facts: { period: period.name, endDate: period.endsOn, days: daysAfter, periodCheck: check.code, figure: check.figure },
      evidence: check.detail.slice(0, EVIDENCE_CAP).map((line) => EVIDENCE_ROW({ ref: line, href: check.route.startsWith('/') ? check.route : null })),
      record: { type: 'fiscal_period', id: period.id, label: period.name, href: '/finance/periods' },
      action: check.route.startsWith('/') ? check.route : '/finance/periods',
      branchCode: null,
    }));
}
