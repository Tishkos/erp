/**
 * Which accounts moved, and which statement lines they will print on.
 *
 *   npx tsx scripts/ops/statement-coverage.ts [from] [to]
 *
 * The Balance Sheet and the Cash Flow Statement read the same journal and are
 * mapped separately, and the Balance Sheet falls back on the account type when
 * nobody has mapped an account while the Cash Flow deliberately does not. That
 * asymmetry is right — which activity a movement belongs to is a judgement the
 * chart cannot make — but it has a consequence nobody was being shown: an
 * account can appear in the Balance Sheet's Accounts Receivable and, in the
 * same period, sit under the Cash Flow's "Not yet classified".
 *
 * Both statements are then individually correct and disagree with each other,
 * which is the hardest kind of wrong to find, because each one balances.
 *
 * So this prints, for a period, every account with movement that is not cash
 * and not inside Net Income, and says whether each is classified on each face.
 * Anything marked MISSING is a figure that will be in one statement's totals
 * and not where a reader expects it in the other's.
 *
 * Read-only. Safe against production.
 */
import 'dotenv/config';
import { Pool } from 'pg';

const from = process.argv[2] ?? `${new Date().getFullYear()}-01-01`;
const to = process.argv[3] ?? `${new Date().getFullYear()}-12-31`;

const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;

if (!url) {
  console.error('DATABASE_URL_OWNER is not set. Copy .env.example to .env.');
  process.exit(2);
}

const pool = new Pool({ connectionString: url });

/** IQD, as the statements print it: thousands separated, negatives bracketed. */
const money = (raw: string): string => {
  const value = Number(raw) / 1;
  const shown = Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return value < 0 ? `(${shown})` : shown;
};

async function main(): Promise<void> {
  const { rows } = await pool.query(
    `select a.code,
            a.name,
            a.account_type,
            a.control_account,
            a.balance_sheet_line,
            a.cash_flow_line,
            sum(l.debit_iqd) - sum(l.credit_iqd) as movement
       from journal_line l
       join chart_of_account a on a.id = l.account_id
       join journal_entry e on e.id = l.journal_entry_id
       -- Cash is what the statement explains, not one of its explanations, so
       -- the accounts on the line flagged is_cash are left out of the list.
       left join financial_statement_line f on f.code = a.cash_flow_line
      where e.posting_date between $1 and $2
        and e.status = 'posted'
        and a.account_type in ('asset', 'liability', 'equity')
        and coalesce(f.is_cash, false) = false
      group by a.code, a.name, a.account_type, a.control_account,
               a.balance_sheet_line, a.cash_flow_line
     having sum(l.debit_iqd) - sum(l.credit_iqd) <> 0
      order by a.code`,
    [from, to],
  );

  console.log(`\nStatement coverage, ${from} to ${to}\n`);

  if (rows.length === 0) {
    console.log('No asset, liability or equity account moved in this period.\n');
    return;
  }

  const pad = (text: string, width: number) => text.padEnd(width).slice(0, width);
  console.log(
    `${pad('Account', 10)}${pad('Name', 30)}${pad('Movement', 16)}${pad('Balance Sheet', 22)}Cash Flow`,
  );
  console.log('-'.repeat(100));

  const unmapped: typeof rows = [];

  for (const row of rows) {
    const sheet = row.balance_sheet_line ?? '(by account type)';
    const flow = row.cash_flow_line ?? 'MISSING — Not yet classified';
    if (!row.cash_flow_line) unmapped.push(row);

    console.log(
      `${pad(row.code, 10)}${pad(row.name, 30)}${pad(money(row.movement), 16)}${pad(sheet, 22)}${flow}`,
    );
  }

  if (unmapped.length === 0) {
    console.log('\nEvery account that moved is classified on both faces.\n');
    return;
  }

  console.log(
    `\n${unmapped.length} account(s) will print under the Cash Flow's "Not yet classified" while ` +
      `the Balance Sheet counts them in its totals:\n`,
  );

  for (const row of unmapped) {
    const kind = row.control_account ? ` [${row.control_account} control account]` : '';
    console.log(`  ${row.code}  ${row.name}${kind}  ${money(row.movement)}`);
  }

  // The reader's question is never "which accounts are unmapped" — it is "does
  // Accounts Receivable agree between the two statements". Answer that.
  const byControl = new Map<string, { mapped: bigint; missing: bigint }>();
  for (const row of rows) {
    if (!row.control_account) continue;
    const entry = byControl.get(row.control_account) ?? { mapped: 0n, missing: 0n };
    const amount = BigInt(Math.round(Number(row.movement)));
    if (row.cash_flow_line) entry.mapped += amount;
    else entry.missing += amount;
    byControl.set(row.control_account, entry);
  }

  for (const [control, totals] of byControl) {
    if (totals.missing === 0n) continue;
    const total = totals.mapped + totals.missing;
    console.log(
      `\n  ${control}: the Balance Sheet moves ${money(String(total))}, the Cash Flow classifies ` +
        `${money(String(totals.mapped))} and leaves ${money(String(totals.missing))} unclassified.`,
    );
  }

  console.log(
    '\nMap them on Master Data → Statement Mapping, or the two statements will keep disagreeing.\n',
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
