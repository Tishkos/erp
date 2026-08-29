/**
 * Trial Balance and G/L inquiry — Phase 02.10.
 *
 * §14.1 puts Trial Balance, G/L Inquiry and Account Activity on the Finance
 * menu. §14.8 requires source-document journals to "drill back to the
 * originating operational document". §24 requires an integrity report that is
 * "expected to be zero".
 *
 * ── Reported in IQD or USD, computed from neither ───────────────────────────
 * §2.3: reports are available in IQD or USD "without changing the original
 * transaction currency or ledger amount". Both columns are already on every
 * journal line, stored at the historical rate that applied when it posted. So
 * switching the report currency changes which column is summed and nothing
 * else — no conversion happens at report time, which is what makes a re-run of
 * last March reproduce last March.
 */
import { sql } from 'drizzle-orm';
import type { Tx } from '../db/client';
import type { ChartRow } from '../domain/report-levels';

export type ReportCurrency = 'IQD' | 'USD';

export interface TrialBalanceFilter {
  readonly from: string;
  readonly to: string;
  readonly branchCode?: string | null;
  /**
   * D10 — consolidate across every branch the user is permitted.
   *
   * Off by default, because a Trial Balance is read as a statement *of* a
   * branch: §4.2 makes Branch a dimension precisely so that "Baghdad Profit &
   * Loss" and "all branches combined" are two different reports rather than one
   * ambiguous one. So the report opens on the Active Branch, a named
   * `branchCode` moves it, and this consolidates — bounded, as everything is, by
   * what the user is permitted rather than by what exists.
   */
  readonly allPermittedBranches?: boolean;
  readonly currency?: ReportCurrency;
  /** §4.2 dimensions, any subset. */
  readonly departmentCode?: string | null;
  readonly businessLineCode?: string | null;
  readonly projectCode?: string | null;
}

/**
 * The branch predicate every report here shares.
 *
 * Row-level security has already decided which branches the user may see
 * (D10 — `app_branch_allowed`). This decides which of those the report is
 * *about*, which is a different question and the reason it is a filter rather
 * than a permission.
 *
 * A Super User is not defaulted to a branch: they hold every branch, so an
 * Active Branch is a seat rather than a scope, and head office reads these
 * reports consolidated.
 */
function branchPredicate(filter: {
  branchCode?: string | null;
  allPermittedBranches?: boolean;
}) {
  if (filter.branchCode) return sql`e.branch_code = ${filter.branchCode}`;
  if (filter.allPermittedBranches) return sql`true`;
  return sql`(app_is_super_user() OR e.branch_code = current_setting('app.branch_code', true))`;
}

export interface TrialBalanceRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly debit: string;
  readonly credit: string;
  /** Signed by the account's normal balance — see `@domain/accounts`. */
  readonly balance: string;
}

/**
 * The Trial Balance.
 *
 * Only posted and reversed journals are included: a draft has no accounting
 * effect, and a reversal has one that must show. Grouped by posting account,
 * because a group account has no balance of its own — its figure is the sum of
 * its children, which the caller rolls up from these rows.
 */
export async function trialBalance(
  tx: Tx,
  filter: TrialBalanceFilter,
): Promise<TrialBalanceRow[]> {
  const usd = (filter.currency ?? 'IQD') === 'USD';
  const debitColumn = usd ? sql`l.debit_usd` : sql`l.debit_iqd`;
  const creditColumn = usd ? sql`l.credit_usd` : sql`l.credit_iqd`;

  const result = await tx.execute(sql`
    select a.code                                     as "accountCode",
           a.name                                     as "accountName",
           a.account_type::text                       as "accountType",
           coalesce(sum(${debitColumn}), 0)::text     as "debit",
           coalesce(sum(${creditColumn}), 0)::text    as "credit",
           (coalesce(sum(${debitColumn}), 0) - coalesce(sum(${creditColumn}), 0))::text as "balance"
      from journal_line l
      join journal_entry e   on e.id = l.journal_entry_id
      join chart_of_account a on a.id = l.account_id
     where e.status in ('posted', 'reversed')
       and e.posting_date between ${filter.from}::date and ${filter.to}::date
       and ${branchPredicate(filter)}
       and (${filter.departmentCode ?? null}::text    is null or l.department_code    = ${filter.departmentCode ?? null})
       and (${filter.businessLineCode ?? null}::text  is null or l.business_line_code = ${filter.businessLineCode ?? null})
       and (${filter.projectCode ?? null}::text       is null or l.project_code       = ${filter.projectCode ?? null})
     group by a.code, a.name, a.account_type
    having coalesce(sum(${debitColumn}), 0) <> 0 or coalesce(sum(${creditColumn}), 0) <> 0
     order by a.code
  `);

  return result.rows as unknown as TrialBalanceRow[];
}

export interface TrialBalanceTotals {
  readonly debit: string;
  readonly credit: string;
  readonly difference: string;
  readonly balances: boolean;
}

/**
 * The totals, and whether they agree.
 *
 * §14.8's first acceptance is that debits equal credits for every period. In
 * IQD that is a guarantee, because every journal balances in IQD and the Trial
 * Balance is a sum of journals. In USD it is *not* guaranteed and is not
 * expected to be: USD figures are historical-rate equivalents of each line, so
 * a multi-rate period can leave a residue. Reporting that residue rather than
 * hiding it is the honest behaviour.
 */
export function totalsOf(rows: readonly TrialBalanceRow[]): TrialBalanceTotals {
  const debit = rows.reduce((sum, row) => sum + toScaled(row.debit), 0n);
  const credit = rows.reduce((sum, row) => sum + toScaled(row.credit), 0n);

  return {
    debit: fromScaled(debit),
    credit: fromScaled(credit),
    difference: fromScaled(debit - credit),
    balances: debit === credit,
  };
}

function toScaled(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(`${whole}${fraction.padEnd(4, '0').slice(0, 4)}`);
}

function fromScaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return `${negative ? '-' : ''}${abs / 10_000n}.${(abs % 10_000n).toString().padStart(4, '0')}`;
}

/**
 * Account Activity — every movement on one account, with the journal and the
 * source document it came from.
 *
 * §14.8: "Source-document journals drill back to the originating operational
 * document." That is what `sourceModule` and `sourceDocId` are for; a manual
 * journal has neither, and that absence is itself the answer to "where did this
 * come from?"
 */
/** One posted line of the General Ledger, as the report reads it. */
export interface AccountActivityRow {
  readonly entryNo: string;
  readonly postingDate: string;
  readonly description: string | null;
  readonly sourceModule: string | null;
  readonly sourceDocId: string | null;
  readonly status: string;
  readonly lineNo: number;
  readonly lineRole: string | null;
  readonly sourceLineId: string | null;
  readonly debitIqd: string;
  readonly creditIqd: string;
  readonly debitUsd: string;
  readonly creditUsd: string;
  readonly currency: string;
  readonly departmentCode: string | null;
  readonly businessPartnerCode: string | null;
  readonly journalEntryId: string;
}

export async function accountActivity(
  tx: Tx,
  accountCode: string,
  filter: {
    from: string;
    to: string;
    branchCode?: string | null;
    allPermittedBranches?: boolean;
  },
) {
  const result = await tx.execute(sql`
    select e.entry_no          as "entryNo",
           e.posting_date      as "postingDate",
           e.description       as "description",
           e.source_module     as "sourceModule",
           e.source_doc_id     as "sourceDocId",
           e.status::text      as "status",
           l.line_no           as "lineNo",
           l.line_role         as "lineRole",
           l.source_line_id    as "sourceLineId",
           l.debit_iqd::text   as "debitIqd",
           l.credit_iqd::text  as "creditIqd",
           l.debit_usd::text   as "debitUsd",
           l.credit_usd::text  as "creditUsd",
           l.currency          as "currency",
           l.department_code   as "departmentCode",
           l.business_partner_code as "businessPartnerCode",
           e.id                as "journalEntryId"
      from journal_line l
      join journal_entry e    on e.id = l.journal_entry_id
      join chart_of_account a on a.id = l.account_id
     where a.code = ${accountCode}
       and e.status in ('posted', 'reversed')
       and e.posting_date between ${filter.from}::date and ${filter.to}::date
       and ${branchPredicate(filter)}
     order by e.posting_date, e.entry_no, l.line_no
  `);

  return result.rows as unknown as AccountActivityRow[];
}

export interface IntegrityIssue {
  readonly issue: string;
  readonly objectId: string;
  readonly reference: string;
  readonly detail: string;
}

/**
 * §24 — "Unbalanced or orphan-entry integrity report, expected to be zero."
 *
 * The definition lives in the `gl_integrity_issue` view, so the report, the
 * tests and anyone querying the database directly all see the same thing.
 */
export async function integrityReport(tx: Tx): Promise<IntegrityIssue[]> {
  const result = await tx.execute(sql`
    select issue, object_id as "objectId", reference, detail
      from gl_integrity_issue
     order by issue, reference
  `);

  return result.rows as unknown as IntegrityIssue[];
}

/**
 * The §24 duplicate-source-reference check.
 *
 * The unique index makes duplicates impossible, so this is expected to be empty
 * always. It exists because "the constraint is there" and "the data is clean"
 * are different claims, and an integrity report should assert the second.
 */
export async function duplicateSourceReferences(tx: Tx) {
  const result = await tx.execute(sql`
    select source_module as "sourceModule",
           source_doc_id as "sourceDocId",
           source_event  as "sourceEvent",
           count(*)::int as "journals"
      from journal_entry
     where source_module is not null
     group by source_module, source_doc_id, source_event
    having count(*) > 1
  `);

  return result.rows as unknown as Array<Record<string, unknown>>;
}

/** The chart as the roll-up needs it — every account, its parent and its kind. */
export async function chartRows(tx: Tx): Promise<ChartRow[]> {
  const result = await tx.execute(sql`
    select id, code, name, parent_id as "parentId", is_group as "isGroup",
           account_type::text as "accountType"
      from chart_of_account
     order by code
  `);
  return result.rows as unknown as ChartRow[];
}

/**
 * The General Ledger, read as a table of balances.
 *
 * By direction (2026-08-29): the ledger opens on every account with its
 * balance, debit or credit, and an account is opened by pressing it — nobody
 * chooses one from a list first. Every posting account that may take an
 * entry is listed, with or without movement, so a reader can see the accounts
 * that have nothing on them yet rather than wonder whether they exist.
 *
 * Everything posted from the beginning up to `asAt`: a balance is a position,
 * not a period's movement.
 */
export interface LedgerBalanceRow extends TrialBalanceRow {
  readonly isActive: boolean;
}

export async function ledgerBalances(
  tx: Tx,
  filter: { asAt: string; currency?: ReportCurrency; allPermittedBranches?: boolean; branchCode?: string | null },
): Promise<LedgerBalanceRow[]> {
  const usd = (filter.currency ?? 'IQD') === 'USD';
  const debitColumn = usd ? sql`l.debit_usd` : sql`l.debit_iqd`;
  const creditColumn = usd ? sql`l.credit_usd` : sql`l.credit_iqd`;

  const result = await tx.execute(sql`
    with posted as (
      select l.account_id,
             coalesce(sum(${debitColumn}), 0)  as debit,
             coalesce(sum(${creditColumn}), 0) as credit
        from journal_line l
        join journal_entry e on e.id = l.journal_entry_id
       where e.status in ('posted', 'reversed')
         and e.posting_date <= ${filter.asAt}::date
         and ${branchPredicate(filter)}
       group by l.account_id
    )
    select a.code                              as "accountCode",
           a.name                              as "accountName",
           a.account_type::text                as "accountType",
           a.is_active                         as "isActive",
           coalesce(p.debit, 0)::text          as "debit",
           coalesce(p.credit, 0)::text         as "credit",
           (coalesce(p.debit, 0) - coalesce(p.credit, 0))::text as "balance"
      from chart_of_account a
      left join posted p on p.account_id = a.id
     where a.is_group = false
       and (
         (a.is_active and a.approval_status = 'approved')
         or coalesce(p.debit, 0) <> 0 or coalesce(p.credit, 0) <> 0
       )
     order by a.code
  `);

  return result.rows as unknown as LedgerBalanceRow[];
}
