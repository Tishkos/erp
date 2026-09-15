/**
 * Gives the Balance Sheet the same lines the Cash Flow Statement already has.
 *
 *   npx tsx scripts/ops/link-balance-sheet-to-cash-flow.ts [--apply]
 *
 * Without --apply it prints what it would do and changes nothing.
 *
 * ── The problem ───────────────────────────────────────────────────────────
 * The Cash Flow Statement names things: Accounts Receivable, Inventory,
 * Equipment. The Balance Sheet was never mapped at all, so every asset fell to
 * `current_assets` by account type and printed as one figure:
 *
 *   Current assets   27,780,170
 *
 * Both statements were individually right. Neither could be read against the
 * other, because the Balance Sheet had no Accounts Receivable line to compare
 * the Cash Flow's Accounts Receivable to — and the one bucket also swept in
 * Equipment, which is not a current asset, and the bank, which belongs under
 * cash.
 *
 * ── Why the Cash Flow decides ─────────────────────────────────────────────
 * Because it already holds the answer. Somebody has been through the chart and
 * said which account is receivables and which is inventory; that judgement is
 * recorded, correct, and in use. Asking for it again on a second screen would
 * be asking the same question twice and accepting two answers — which is the
 * shape of the defect this fixes, not a fix for it.
 *
 * So each account's Balance Sheet line follows its Cash Flow line, through the
 * correspondences below. Only accounts with no Balance Sheet line of their own
 * are touched: an explicit mapping somebody made is a decision, and this does
 * not overrule decisions.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const apply = process.argv.includes('--apply');

const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_OWNER is not set.');
  process.exit(2);
}

/**
 * Which Balance Sheet line an account belongs on, given where the Cash Flow
 * already files it. Named rather than derived: "operating activities" does not
 * imply "current asset", and a rule that pretended it did would be wrong the
 * first time somebody added a line.
 */
const CORRESPONDENCE: ReadonlyArray<{
  readonly cashFlow: string;
  /** An existing Balance Sheet line to use, where one already fits. */
  readonly use?: string;
  /** A line to create, where the chart has no home for these accounts. */
  readonly create?: { readonly name: string; readonly side: 'asset' | 'liability' | 'equity' };
}> = [
  // The asset side is where the complaint was: these had no line of their own
  // and printed as one "Current assets" figure that could not be read against
  // the Cash Flow.
  { cashFlow: 'cf_receivables', create: { name: 'Accounts Receivable', side: 'asset' } },
  { cashFlow: 'cf_inventory', create: { name: 'Inventory', side: 'asset' } },
  { cashFlow: 'cf_equipment', create: { name: 'Property and Equipment', side: 'asset' } },
  { cashFlow: 'cf_depreciation', create: { name: 'Accumulated Depreciation', side: 'asset' } },

  // The liability side already has lines that fit, so it gets no new ones.
  // Creating an "Accounts Payable" line for an account somebody named "Current
  // Liabilities" would rename it on one statement and not the other, which is
  // the kind of disagreement this script exists to remove.
  { cashFlow: 'cf_payables', use: 'current_liabilities' },
  { cashFlow: 'accrued_salaries', use: 'current_liabilities' },
  { cashFlow: 'cf_loan', use: 'non_current_liabilities' },
];

const pool = new Pool({ connectionString: url });

const slug = (name: string) =>
  `bs_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;

async function main(): Promise<void> {
  const planned: string[] = [];

  // Cash is its own case: the accounts the Cash Flow calls cash are the ones
  // the Balance Sheet should show under Cash and cash equivalents, and that
  // line already exists.
  const { rows: cashLine } = await pool.query(
    `select code from financial_statement_line
      where statement = 'cash_flow' and is_cash = true limit 1`,
  );

  for (const entry of CORRESPONDENCE) {
    const { rows: accounts } = await pool.query(
      `select code, name, account_type from chart_of_account
        where cash_flow_line = $1 and balance_sheet_line is null
        order by code`,
      [entry.cashFlow],
    );
    if (accounts.length === 0) continue;

    let code = entry.use ?? '';
    let label = entry.use ?? '';

    if (entry.create) {
      code = slug(entry.create.name);
      label = entry.create.name;

      const { rows: existing } = await pool.query(
        `select code from financial_statement_line where code = $1`,
        [code],
      );

      if (existing.length === 0) {
        planned.push(`create Balance Sheet line "${entry.create.name}" (${entry.create.side})`);
        if (apply) {
          // Last among its siblings, as the screen would place it; the ordering
          // is then the person's to change with the arrows.
          await pool.query(
            `insert into financial_statement_line
               (code, name, statement, parent_id, is_header, is_subtotal, ordinal, side, is_cash)
             values ($1, $2, 'balance_sheet', null, false, false,
                     (select coalesce(max(ordinal), 0) + 10 from financial_statement_line
                       where statement = 'balance_sheet' and parent_id is null),
                     $3, false)`,
            [code, entry.create.name, entry.create.side],
          );
        }
      }
    }

    for (const account of accounts) {
      planned.push(`  ${account.code} ${account.name} -> ${label}`);
      if (apply) {
        await pool.query(`update chart_of_account set balance_sheet_line = $1 where code = $2`, [
          code,
          account.code,
        ]);
      }
    }
  }

  if (cashLine.length > 0) {
    const { rows: accounts } = await pool.query(
      `select code, name from chart_of_account
        where cash_flow_line = $1 and balance_sheet_line is null order by code`,
      [cashLine[0].code],
    );
    for (const account of accounts) {
      planned.push(`  ${account.code} ${account.name} -> Cash and cash equivalents`);
      if (apply) {
        await pool.query(
          `update chart_of_account set balance_sheet_line = 'cash_and_equivalents' where code = $1`,
          [account.code],
        );
      }
    }
  }

  if (planned.length === 0) {
    console.log('\nEvery account already has a Balance Sheet line. Nothing to do.\n');
    return;
  }

  console.log(apply ? '\nApplied:\n' : '\nWould apply (re-run with --apply):\n');
  for (const line of planned) console.log(line);
  console.log('');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
