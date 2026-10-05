/**
 * Receivables and payables detectors — platform phase, Agent 7.
 */
import { sql } from 'drizzle-orm';
import { EVIDENCE_CAP, EVIDENCE_ROW, THRESHOLDS, severityByDays, type EvidenceRow, type Finding } from '../../domain/exceptions';
import { parseDecimal, toDecimalString } from '../../domain/money';
import { profileHref } from '../../domain/profiles';
import * as customerReconciliation from '../customer-reconciliation';
import * as openItems from '../open-items';
import * as supplierBalances from '../supplier-balances';
import { enc, rowsOf, type DetectContext } from './shared';

// ---------------------------------------------------------------------------
// A customer or supplier whose invoices are overdue
// ---------------------------------------------------------------------------

/**
 * One finding per party in a branch, not per invoice: the thing that needs a
 * person is the account ("call this customer"), and a branch-scoped reader
 * must see exactly the branch's share. The severity is that of the oldest
 * overdue item; the sum and the count say how much is behind it.
 */
async function overdueExposure(ctx: DetectContext, side: openItems.Side): Promise<Finding[]> {
  const { tx, principal, today } = ctx;
  const detector = side === 'customer' ? 'receivables.overdue_exposure' : 'payables.overdue_exposure';
  const steps = side === 'customer' ? THRESHOLDS.receivableOverdue : THRESHOLDS.payableOverdue;
  const items = await openItems.openItems(tx, principal, side, today, { outstandingOnly: true, overdueOnly: true });

  const groups = new Map<string, openItems.OpenItem[]>();
  for (const item of items) {
    if (parseDecimal(item.outstandingIqd, 4n) <= 0n) continue;
    const key = `${item.partyCode}|${item.branchCode}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const findings: Finding[] = [];
  for (const [subject, list] of groups) {
    const oldest = list.reduce((a, b) => (b.daysOverdue > a.daysOverdue ? b : a));
    const severity = severityByDays(oldest.daysOverdue, steps);
    if (severity === null) continue;
    const total = list.reduce((sum, item) => sum + parseDecimal(item.outstandingIqd, 4n), 0n);
    const sorted = [...list].sort((a, b) => b.daysOverdue - a.daysOverdue);
    const evidence: EvidenceRow[] = sorted.slice(0, EVIDENCE_CAP).map((item) =>
      EVIDENCE_ROW({
        ref: item.invoiceNo,
        href: profileHref(side === 'customer' ? 'sales_invoice' : 'purchase_invoice', item.invoiceNo),
        date: item.dueDate,
        amount: item.outstandingIqd,
        note: { code: 'overdue_days', params: { days: item.daysOverdue } },
      }),
    );
    const profile = profileHref(side === 'customer' ? 'customer' : 'supplier', oldest.partyCode) ?? '/';
    findings.push({
      detector,
      subject,
      severity,
      facts: {
        party: oldest.partyName,
        partyCode: oldest.partyCode,
        branch: oldest.branchCode,
        overdueIqd: toDecimalString(total),
        invoices: list.length,
        days: oldest.daysOverdue,
        oldestInvoice: oldest.invoiceNo,
        oldestDueDate: oldest.dueDate,
      },
      evidence,
      record: { type: 'business_partner', id: oldest.partyCode, label: `${oldest.partyCode} ${oldest.partyName}`, href: profile },
      action: side === 'customer' ? `/sales/receivables?q=${enc(oldest.partyCode)}` : `/payables/open-items?q=${enc(oldest.partyCode)}`,
      branchCode: oldest.branchCode,
      partyCode: oldest.partyCode,
    });
  }
  return findings;
}

export const receivablesOverdueExposure = (ctx: DetectContext) => overdueExposure(ctx, 'customer');
export const payablesOverdueExposure = (ctx: DetectContext) => overdueExposure(ctx, 'supplier');

// ---------------------------------------------------------------------------
// A journal line on a control account that the party ledger does not agree with
// ---------------------------------------------------------------------------

type LedgerLine = customerReconciliation.ExceptionRow | supplierBalances.ExceptionRow;

async function ledgerInconsistency(ctx: DetectContext, side: openItems.Side): Promise<Finding[]> {
  const { tx, principal, today } = ctx;
  const detector = side === 'customer' ? 'receivables.ledger_inconsistency' : 'payables.ledger_inconsistency';
  const lines: LedgerLine[] =
    side === 'customer' ? await customerReconciliation.exceptions(tx, principal, today) : await supplierBalances.exceptions(tx, principal, today);
  if (lines.length === 0) return [];

  const groups = new Map<string, LedgerLine[]>();
  for (const line of lines) {
    const key = `${line.entryNo}|${line.reason}`;
    const list = groups.get(key) ?? [];
    list.push(line);
    groups.set(key, list);
  }
  const entryNos = [...new Set(lines.map((l) => l.entryNo))];
  const entries = new Map(
    rowsOf<{ entry_no: string; id: string; branch_code: string | null }>(
      await tx.execute(sql`select entry_no, id::text, branch_code from journal_entry where entry_no in (${sql.join(entryNos.map((n) => sql`${n}`), sql`, `)})`),
    ).map((r) => [r.entry_no, r]),
  );

  const findings: Finding[] = [];
  for (const [subject, list] of [...groups].slice(0, THRESHOLDS.findingsPerDetector + 1)) {
    const first = list[0]!;
    const entry = entries.get(first.entryNo);
    const href = `/finance/journals/${enc(first.entryNo)}`;
    findings.push({
      detector,
      subject,
      severity: 'high',
      facts: {
        entry: first.entryNo,
        reason: first.reason,
        account: first.accountCode,
        party: first.partyCode,
        lines: list.length,
        postingDate: first.postingDate,
      },
      evidence: list.slice(0, EVIDENCE_CAP).map((line) =>
        EVIDENCE_ROW({
          ref: line.entryNo,
          href,
          date: line.postingDate,
          amount: parseDecimal(line.lineDebitIqd, 4n) !== 0n ? line.lineDebitIqd : `-${line.lineCreditIqd}`,
          note: { code: `ledger_${line.reason}` },
        }),
      ),
      record: { type: 'journal_entry', id: entry?.id ?? first.entryNo, label: first.entryNo, href },
      action: side === 'customer' ? '/sales/customer-reconciliation' : '/payables/reconciliation',
      branchCode: entry?.branch_code ?? null,
      partyCode: first.partyCode,
    });
  }
  return findings;
}

export const receivablesLedgerInconsistency = (ctx: DetectContext) => ledgerInconsistency(ctx, 'customer');
export const payablesLedgerInconsistency = (ctx: DetectContext) => ledgerInconsistency(ctx, 'supplier');

// ---------------------------------------------------------------------------
// A supplier credit whose applications do not add up to what it says was applied
// ---------------------------------------------------------------------------

export async function supplierCreditInconsistency(ctx: DetectContext): Promise<Finding[]> {
  const { tx } = ctx;
  const rows = rowsOf<{
    id: string;
    memo_no: string;
    branch_code: string;
    amount: string;
    allocated: string;
    applied: string;
    supplier_code: string;
    supplier_name: string;
  }>(
    await tx.execute(sql`
      select m.id::text, m.memo_no, m.branch_code, m.amount_iqd::text as amount, m.allocated_amount_iqd::text as allocated,
             coalesce(sum(a.amount_iqd) filter (where a.reversed_at is null), 0)::text as applied,
             bp.code as supplier_code, bp.legal_name as supplier_name
        from supplier_credit_memo m
        join business_partner bp on bp.id = m.supplier_id
        left join supplier_credit_application a on a.supplier_credit_memo_id = m.id
       where m.status <> 'draft'
       group by m.id, bp.code, bp.legal_name
      having m.allocated_amount_iqd <> coalesce(sum(a.amount_iqd) filter (where a.reversed_at is null), 0)
          or m.allocated_amount_iqd > m.amount_iqd
       order by m.memo_no
       limit ${THRESHOLDS.findingsPerDetector + 1}`),
  );
  return rows.map((row) => {
    const href = `/payables/credit-memos/${enc(row.memo_no)}`;
    const difference = parseDecimal(row.allocated, 4n) - parseDecimal(row.applied, 4n);
    return {
      detector: 'payables.supplier_credit_inconsistency',
      subject: row.memo_no,
      severity: 'high' as const,
      facts: {
        memo: row.memo_no,
        supplier: `${row.supplier_code} ${row.supplier_name}`,
        creditIqd: row.amount,
        allocatedIqd: row.allocated,
        appliedIqd: row.applied,
        differenceIqd: toDecimalString(difference),
      },
      evidence: [
        EVIDENCE_ROW({ ref: row.memo_no, href, amount: row.amount, note: { code: 'credit_amount' } }),
        EVIDENCE_ROW({ ref: row.memo_no, href, amount: row.allocated, note: { code: 'credit_allocated' } }),
        EVIDENCE_ROW({ ref: row.memo_no, href, amount: row.applied, note: { code: 'credit_applications' } }),
      ],
      record: { type: 'supplier_credit_memo', id: row.id, label: row.memo_no, href },
      action: href,
      branchCode: row.branch_code,
      partyCode: row.supplier_code,
    };
  });
}
