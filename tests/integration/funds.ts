/**
 * Money in a fixture's bank or till before a test pays out of it.
 *
 * Since C-20 (`0259_bank_never_negative`) a bank or cash account cannot hold
 * less than nothing, so a test that pays from a fixture bank first puts money
 * in it: one posted journal, Dr the account, Cr a contra account the fixture
 * names (an equity or clearing account), dated in an open period. A test that
 * reads the account's balance counts the funding in.
 */
import { randomUUID } from 'node:crypto';
import { ownerPool } from './setup';

export interface Funding {
  /** The bank or cash account's G/L account. */
  readonly glAccountId: string;
  /** Where the money comes from: opening balance equity, return clearing… */
  readonly contraAccountId: string;
  readonly amountIqd: string;
  readonly branchCode: string;
  /** Who posts it (a user the fixture made). */
  readonly userId: string;
  /** The posting date; the year's first day unless said. */
  readonly on?: string;
}

/**
 * An equity account to fund from when the fixture has no contra of its own:
 * "Opening Funds", which no test reads. Made on first use after a reset.
 */
export async function openingFundsAccount(): Promise<string> {
  const { rows: found } = await ownerPool.query(`select id from chart_of_account where code = 'E9FUNDS'`);
  if (found[0]) return found[0].id as string;
  const { rows } = await ownerPool.query(
    `insert into chart_of_account
       (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     select 'E9FUNDS', 'Opening Funds', account_type, id, false, true, 'approved', 1, 'IQD'
       from chart_of_account where code = 'E000001'
     returning id`,
  );
  return rows[0].id as string;
}

export async function fundLedger(funding: Funding): Promise<void> {
  const on = funding.on ?? '2026-01-01';
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    if (!periods[0]) throw new Error(`fundLedger: no fiscal period covers ${on}`);
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1, $2, $2, $3, $4, 'Opening funds for tests', 'draft', $5, $5, $6) returning id`,
      [`FUND-${randomUUID().slice(0, 8)}`, on, periods[0].id, funding.branchCode, funding.amountIqd, funding.userId],
    );
    await client.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5), ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, funding.glAccountId, funding.amountIqd, funding.contraAccountId, funding.branchCode],
    );
    await client.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, funding.userId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
