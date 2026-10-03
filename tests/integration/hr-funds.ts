/**
 * REQ-HR-001 — money in a fixture bank or till before HR pays out of it.
 *
 * Since C-20 (`0259_bank_never_negative`) a bank or cash account cannot hold
 * less than nothing, so a test that pays a payroll, an advance or a claim
 * from the trading world's bank first puts money in it: one posted journal,
 * Dr the account, Cr return clearing, dated the year's first day. A test
 * that reads the account's balance counts the funding in.
 */
import { randomUUID } from 'node:crypto';
import { ownerPool } from './setup';
import { BAGHDAD, type TradingWorld } from './trading-fixture';

/** The trading world's bank, funded. */
export const fundBank = (world: TradingWorld, amountIqd = '1000000000.0000') => fundAccount(world, world.accounts.bank!, amountIqd);

/** Any bank or cash account's G/L account, funded. */
export async function fundAccount(world: TradingWorld, glAccountId: string, amountIqd: string, on = '2026-01-01'): Promise<void> {
  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows: periods } = await client.query(`select id from fiscal_period where starts_on <= $1::date and ends_on >= $1::date limit 1`, [on]);
    const { rows: entry } = await client.query(
      `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, total_debit_iqd, total_credit_iqd, created_by)
       values ($1, $2, $2, $3, $4, 'Opening funds for HR tests', 'draft', $5, $5, $6) returning id`,
      [`FUND-HR-${randomUUID().slice(0, 8)}`, on, periods[0].id, BAGHDAD, amountIqd, world.manager.principal.userId],
    );
    await client.query(
      `insert into journal_line (journal_entry_id, line_no, account_id, debit_txn, credit_txn, debit_iqd, credit_iqd, debit_usd, credit_usd, currency, branch_code)
       values ($1, 1, $2, $3, 0, $3, 0, 0, 0, 'IQD', $5), ($1, 2, $4, 0, $3, 0, $3, 0, 0, 'IQD', $5)`,
      [entry[0].id, glAccountId, amountIqd, world.accounts.return_clearing, BAGHDAD],
    );
    await client.query(`update journal_entry set status = 'posted', approved_by = $2, posted_at = now() where id = $1`, [entry[0].id, world.manager.principal.userId]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
