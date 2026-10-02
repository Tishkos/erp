/**
 * The period-close checklist — REQ-IMPROVE-001 IMPROVE-2a (FC-2, FC-4).
 *
 * One question per row: "may this period be closed?" answered by the
 * figures the screens already show — the sub-ledger reconciliation, the
 * G/L integrity view, the stock ledger's integrity report, the calendar's
 * sequence — gathered on one screen and asked again, by the database's own
 * module, before a close is written. A *blocking* check that fails refuses
 * the close; a *warning* is shown and recorded with the close's reason but
 * does not stop it, because a company that has never reconciled its bank is
 * still allowed to close its month — knowing it.
 *
 * Every figure is as at the period's last day, except the two that have no
 * history (the layers' value and what is on hand), which are as of now and
 * say so.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { FiscalPeriod } from '../domain/periods';
import { businessToday } from '../domain/business-date';
import * as inventoryIntegrity from './inventory-integrity';
import * as subledger from './subledger';

export type CheckSeverity = 'blocking' | 'warning';
export type CheckState = 'pass' | 'fail' | 'warn';

export interface CloseCheck {
  readonly code: string;
  readonly severity: CheckSeverity;
  readonly state: CheckState;
  /** The figure the check looked at: a count, a difference, a date. */
  readonly figure: string;
  /** The rows behind the figure, for the screen: codes and amounts. */
  readonly detail: readonly string[];
  /** The screen that shows the same thing in full. */
  readonly route: string;
}

export interface CloseReport {
  readonly period: FiscalPeriod;
  readonly asOf: string;
  readonly checks: readonly CloseCheck[];
  readonly mayClose: boolean;
  readonly blockingFailures: readonly string[];
  readonly warnings: readonly string[];
}

const ZERO = /^-?0(\.0+)?$/;
const isZero = (value: string) => ZERO.test(value.trim());

function outcome(code: string, severity: CheckSeverity, failed: boolean, figure: string, detail: readonly string[], route: string): CloseCheck {
  return { code, severity, state: failed ? (severity === 'blocking' ? 'fail' : 'warn') : 'pass', figure, detail, route };
}

/** The checklist for one period. Reads only. */
export async function report(tx: Tx, period: FiscalPeriod): Promise<CloseReport> {
  const asOf = period.endsOn;
  const checks: CloseCheck[] = [];

  // 1. Sequence (FC-2): every earlier period of the year is closed.
  const earlier = (
    await tx.execute(sql`
      select p.name from fiscal_period p
        join fiscal_year y on y.id = p.fiscal_year_id
       where y.code = ${period.fiscalYearCode} and p.period_no < ${period.periodNo} and p.status <> 'closed'
       order by p.period_no`)
  ).rows as { name: string }[];
  checks.push(outcome('sequence', 'blocking', earlier.length > 0, String(earlier.length), earlier.map((r) => r.name), '/finance/periods'));

  // 2. The G/L integrity view: unbalanced or orphaned postings.
  const issues = (await tx.execute(sql`select issue, reference from gl_integrity_issue order by issue, reference limit 50`)).rows as { issue: string; reference: string }[];
  const [issueCount] = (await tx.execute(sql`select count(*)::int as n from gl_integrity_issue`)).rows as { n: number }[];
  checks.push(outcome('gl_integrity', 'blocking', (issueCount?.n ?? 0) > 0, String(issueCount?.n ?? 0), issues.map((r) => `${r.issue} ${r.reference}`), '/finance/trial-balance'));

  // 3. Journals dated in the period that have not posted.
  const unposted = (
    await tx.execute(sql`
      select entry_no as "entryNo", status::text as status from journal_entry
       where posting_date between ${period.startsOn}::date and ${period.endsOn}::date
         and status in ('draft', 'submitted', 'approved')
       order by entry_no limit 50`)
  ).rows as { entryNo: string; status: string }[];
  const [unpostedCount] = (
    await tx.execute(sql`
      select count(*)::int as n from journal_entry
       where posting_date between ${period.startsOn}::date and ${period.endsOn}::date
         and status in ('draft', 'submitted', 'approved')`)
  ).rows as { n: number }[];
  checks.push(outcome('unposted_journals', 'blocking', (unpostedCount?.n ?? 0) > 0, String(unpostedCount?.n ?? 0), unposted.map((r) => `${r.entryNo} (${r.status})`), '/finance/journals'));

  // 4. Sub-ledger = G/L on every control account, as at the period's end (FC-4).
  const recon = await subledger.reconciliation(tx, asOf);
  const differences = recon.filter((row) => !isZero(row.difference));
  checks.push(
    outcome('subledger_equals_gl', 'blocking', differences.length > 0, String(differences.length), differences.map((r) => `${r.accountCode} ${r.accountName}: ${r.difference}`), '/finance/gl-inquiry'),
  );

  // 5. The stock ledger agrees with its documents and its layers (now).
  const stock = await inventoryIntegrity.check(tx);
  const adrift = stock.adriftPositions.filter((p) => p.issue !== 'negative_position');
  const structural = stock.documentsWithoutLedger.length + stock.ledgerWithoutDocument.length + stock.unbalancedTransfers.length + adrift.length;
  checks.push(
    outcome(
      'stock_ledger_integrity',
      'blocking',
      structural > 0,
      String(structural),
      [
        ...stock.documentsWithoutLedger.map((d) => `${d.documentNo} without ledger rows`),
        ...stock.ledgerWithoutDocument.map((m) => `${m.sourceDocumentType} ${m.sourceDocumentId} without a document`),
        ...stock.unbalancedTransfers.map((t) => `${t.documentNo ?? t.sourceDocumentId} unbalanced`),
        ...adrift.map((p) => `${p.itemCode} @ ${p.warehouseCode} ledger ≠ layers by ${p.detail}`),
      ].slice(0, 50),
      '/inventory/stock-ledger',
    ),
  );

  // 6. Stock documents dated in the period still waiting.
  const waiting = (
    await tx.execute(sql`
      select document_no as "documentNo", status from opening_stock
       where document_date between ${period.startsOn}::date and ${period.endsOn}::date
         and status in ('draft', 'submitted')
       order by document_no limit 50`)
  ).rows as { documentNo: string; status: string }[];
  checks.push(outcome('stock_documents_waiting', 'blocking', waiting.length > 0, String(waiting.length), waiting.map((r) => `${r.documentNo} (${r.status})`), '/inventory/opening-stock'));

  // 7. Inventory value: the layers (now) against the inventory accounts (now).
  // The Warehouses Report's own arithmetic: remaining quantity at each
  // layer's unit cost; beside it, the part whose movement carries no journal
  // of its own (§22's "not yet posted"), for the reader's eye.
  const [layers] = (
    await tx.execute(sql`
      select coalesce(sum(l.remaining_quantity * l.unit_cost_iqd), 0)::text as value,
             coalesce(sum(l.remaining_quantity * l.unit_cost_iqd) filter (where m.journal_entry_id is null), 0)::text as provisional
        from cost_layer l
        join inventory_movement m on m.id = l.created_by_movement_id
       where l.remaining_quantity > 0`)
  ).rows as { value: string; provisional: string }[];
  const [glInventory] = (
    await tx.execute(sql`
      select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as value
        from journal_line l
        join journal_entry e on e.id = l.journal_entry_id
       where e.status in ('posted', 'reversed')
         and l.account_id in (select distinct inventory_account_id from item where inventory_account_id is not null)`)
  ).rows as { value: string }[];
  const inventoryDifference = (Number(layers?.value ?? 0) - Number(glInventory?.value ?? 0)).toFixed(4);
  checks.push(
    outcome(
      'inventory_value_equals_gl',
      'warning',
      !isZero(inventoryDifference),
      inventoryDifference,
      [`layers ${layers?.value ?? '0'} · accounts ${glInventory?.value ?? '0'} · not yet posted ${layers?.provisional ?? '0'} · as of ${businessToday()}`],
      '/inventory/fifo-valuation',
    ),
  );

  // 8. Positions below zero (the accountant's "still at sea"): a warning, named.
  const negative = stock.adriftPositions.filter((p) => p.issue === 'negative_position');
  checks.push(outcome('negative_stock', 'warning', negative.length > 0, String(negative.length), negative.map((p) => `${p.itemCode} @ ${p.warehouseCode}: ${p.detail}`).slice(0, 50), '/inventory/fifo-valuation'));

  // 9. Every active bank account reconciled up to the period's end.
  const unreconciled = (
    await tx.execute(sql`
      select b.code, b.name,
             (select max(r.as_of_date)::text from bank_reconciliation r
               where r.bank_cash_account_id = b.id and r.approved_at is not null) as "lastReconciled"
        from bank_cash_account b
       where b.active and b.account_type = 'bank'
         and not exists (
           select 1 from bank_reconciliation r
            where r.bank_cash_account_id = b.id and r.approved_at is not null and r.as_of_date >= ${asOf}::date)
       order by b.code`)
  ).rows as { code: string; name: string; lastReconciled: string | null }[];
  checks.push(outcome('bank_reconciled', 'warning', unreconciled.length > 0, String(unreconciled.length), unreconciled.map((b) => `${b.code} ${b.name} — last ${b.lastReconciled ?? 'never'}`), '/treasury/bank-reconciliation'));

  // 10. A USD rate on the period's last day.
  const [rate] = (
    await tx.execute(sql`
      select iqd_per_unit::text as rate, effective_from::text as "effectiveFrom" from exchange_rate
       where currency_code = 'USD' and superseded_at is null and effective_from <= ${asOf}::date
       order by effective_from desc limit 1`)
  ).rows as { rate: string; effectiveFrom: string }[];
  const stale = !rate || rate.effectiveFrom < period.startsOn;
  checks.push(outcome('fx_rate_current', 'warning', stale, rate ? `${rate.rate} from ${rate.effectiveFrom}` : 'none', rate ? [] : ['no USD rate'], '/finance/periods'));

  // 11. Clearing accounts carrying a balance at the period's end.
  const clearing = (
    await tx.execute(sql`
      with roles as (
        select distinct r.account_id, r.line_role from posting_rule r
         where r.is_active and r.line_role in ('customer_clearing', 'grni', 'return_clearing', 'landed_cost_clearing')
      )
      select a.code, a.name, roles.line_role as role,
             coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as balance
        from roles
        join chart_of_account a on a.id = roles.account_id
        left join journal_line l on l.account_id = a.id
        left join journal_entry e on e.id = l.journal_entry_id and e.status in ('posted', 'reversed') and e.posting_date <= ${asOf}::date
       group by a.code, a.name, roles.line_role
      having coalesce(sum(case when e.id is null then 0 else l.debit_iqd - l.credit_iqd end), 0) <> 0
       order by a.code`)
  ).rows as { code: string; name: string; role: string; balance: string }[];
  checks.push(outcome('clearing_balances', 'warning', clearing.length > 0, String(clearing.length), clearing.map((c) => `${c.code} ${c.name} (${c.role}): ${c.balance}`), '/finance/gl-inquiry'));

  const blockingFailures = checks.filter((c) => c.state === 'fail').map((c) => c.code);
  const warnings = checks.filter((c) => c.state === 'warn').map((c) => c.code);
  return { period, asOf, checks, mayClose: blockingFailures.length === 0, blockingFailures, warnings };
}

/** The codes, for the screen's labels and the tests. */
export const CHECK_CODES = [
  'sequence',
  'gl_integrity',
  'unposted_journals',
  'subledger_equals_gl',
  'stock_ledger_integrity',
  'stock_documents_waiting',
  'inventory_value_equals_gl',
  'negative_stock',
  'bank_reconciled',
  'fx_rate_current',
  'clearing_balances',
] as const;
export type CheckCode = (typeof CHECK_CODES)[number];

// ---------------------------------------------------------------------------
// The nightly job (FC-4): the next period to close, checked, and the people
// who keep the books told when something blocks it.
// ---------------------------------------------------------------------------

/** The earliest period not yet closed whose last day has passed — the one month-end is about. */
export async function nextToClose(tx: Tx, today = businessToday()): Promise<FiscalPeriod | null> {
  const [row] = (
    await tx.execute(sql`
      select p.id, y.code as "fiscalYearCode", p.period_no as "periodNo", p.name, p.starts_on::text as "startsOn", p.ends_on::text as "endsOn", p.status
        from fiscal_period p join fiscal_year y on y.id = p.fiscal_year_id
       where p.status <> 'closed' and p.ends_on < ${today}::date
       order by p.starts_on limit 1`)
  ).rows as unknown as FiscalPeriod[];
  return row ?? null;
}

/**
 * One in-app notification per accounting manager (and super user) per day
 * per set of failing checks: the same failures tomorrow say it once more
 * under tomorrow's key; a new failure says so again today.
 */
export async function notifyFailures(tx: Tx, checked: CloseReport, today = businessToday()): Promise<{ notified: number }> {
  if (checked.mayClose) return { notified: 0 };
  const failing = checked.checks.filter((c) => c.state === 'fail');
  const lines = failing.map((c) => `${c.code}: ${c.figure}${c.detail.length ? ` — ${c.detail.slice(0, 5).join('; ')}` : ''}`);
  const recipients = (
    await tx.execute(sql`
      select distinct u.id as user_id
        from app_user u
        left join user_role r on r.user_id = u.id
       where u.is_active and (u.is_super_user or r.role_code = 'accounting_manager')`)
  ).rows as { user_id: string }[];
  const key = failing.map((c) => c.code).join(',');
  let notified = 0;
  for (const { user_id } of recipients) {
    const inserted = (
      await tx.execute(sql`
        insert into notification
          (rule_code, event_type, object_type, object_id, recipient_user_id, subject, body, context, dedupe_key, branch_code)
        values
          (null, 'fiscal_period.close_blocked', 'fiscal_period', ${checked.period.id}, ${user_id},
           ${`${checked.period.name} cannot close yet: ${failing.length} check(s) fail`},
           ${lines.join('\n')},
           ${JSON.stringify({ day: today, period: checked.period.name, failing: failing.map((c) => c.code) })}::jsonb,
           ${`closing-checks:${today}:${checked.period.id}:${key}:${user_id}`}, null)
        on conflict (dedupe_key) do nothing
        returning id`)
    ).rows;
    notified += inserted.length;
  }
  return { notified };
}
