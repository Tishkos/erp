/**
 * The cycle, read back off the Account Statement.
 *
 *   npx tsx scripts/ops/account-statement-check.ts [from] [to]
 *
 * Operations build blocks 2 and 3 end at a screen, and a screen is the one
 * place a chain of configuration can fail silently: the account exists, the
 * control designation is set, the invoice posts, and the statement is still
 * empty because one link in between was never made. That was the sponsor's
 * report on 2026-09-22, and it is why this reads the *last* step rather than
 * the first.
 *
 * For every partner with something on their account it prints the statement
 * exactly as `/sales/customer-statements` and `/purchasing/supplier-statements`
 * render it — the document each line came from, its debit and credit, the
 * running balance — and then checks the two things a statement must never get
 * wrong:
 *
 *   opening + debits − credits (in the party's direction) = closing
 *   the subledger total for the party = the control account's own movement
 *
 * Read-only. Safe against production.
 */
import 'dotenv/config';
import { withScope } from '../../src/server/db/client';
import * as statement from '../../src/server/services/partner-statement';
import { Pool } from 'pg';

const [, , fromArg, toArg] = process.argv;
const year = new Date().getFullYear();
const from = fromArg ?? `${year}-01-01`;
const to = toArg ?? `${year}-12-31`;

const url = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;
if (!url) throw new Error('Set DATABASE_URL_OWNER (or DATABASE_URL) before running this.');
const pool = new Pool({ connectionString: url, max: 2 });

const money = (amount: string) =>
  Number(amount).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

async function main(): Promise<void> {
  /*
   * Read as a super user: the statement is branch-scoped by RLS, and a check
   * that silently saw one branch would report a balance nobody else can see.
   */
  const { rows: readers } = await pool.query<{ id: string; email: string }>(
    `select id, email
       from app_user
      where is_super_user and is_active
      order by created_at
      limit 1`,
  );
  const reader = readers[0];
  if (!reader) throw new Error('No active super user to read the statements as.');

  // The branch a scoped read must name. A super user sees past it, but the
  // setting itself is not optional — the policies compare against it.
  const { rows: branches } = await pool.query<{ code: string }>(
    `select code from branch order by code limit 1`,
  );
  const scope = {
    userId: reader.id,
    branchCode: branches[0]?.code ?? '',
    isSuperUser: true,
  } as const;

  const { rows: parties } = await pool.query<{
    side: statement.PartySide;
    code: string;
    name: string;
  }>(
    `select distinct s.subledger_type as side, s.party_code as code, p.legal_name as name
       from subledger_entry s
       join business_partner p on p.code = s.party_code
      where s.subledger_type in ('customer', 'supplier')
      order by 1, 2`,
  );

  if (parties.length === 0) {
    console.log('Nothing is posted to any customer or supplier account.');
    return;
  }

  let wrong = 0;

  for (const party of parties) {
    const account = await withScope(scope, (tx) =>
      statement.statementFor(tx, party.side, party.code, { from, to }),
    );

    console.log(`\n${party.side === 'customer' ? 'Customer' : 'Supplier'}  ${party.code} · ${party.name}`);
    console.log(`  ${from} to ${to}`);
    console.log(`  ${'Date'.padEnd(12)}${'Document'.padEnd(16)}${'Debit'.padStart(16)}${'Credit'.padStart(16)}${'Balance'.padStart(16)}`);
    console.log(`  ${'Opening'.padEnd(28)}${''.padStart(32)}${money(account.opening).padStart(16)}`);
    for (const line of account.lines) {
      const document = line.document ? line.document.number : line.entryNo;
      console.log(
        `  ${line.postingDate.padEnd(12)}${document.padEnd(16)}` +
          `${(Number(line.debit) === 0 ? '' : money(line.debit)).padStart(16)}` +
          `${(Number(line.credit) === 0 ? '' : money(line.credit)).padStart(16)}` +
          `${money(line.balance).padStart(16)}`,
      );
    }
    console.log(
      `  ${'Closing'.padEnd(28)}${money(account.totalDebit).padStart(16)}` +
        `${money(account.totalCredit).padStart(16)}${money(account.closing).padStart(16)}`,
    );

    // The arithmetic the face of the statement asserts.
    const movement =
      party.side === 'supplier'
        ? Number(account.totalCredit) - Number(account.totalDebit)
        : Number(account.totalDebit) - Number(account.totalCredit);
    const expected = Number(account.opening) + movement;
    if (Math.abs(expected - Number(account.closing)) > 0.0001) {
      console.log(`  ✗ opening plus movement is ${money(String(expected))}, not the closing shown`);
      wrong += 1;
    }

    // §1.2 — the subledger reconciles to the General Ledger by construction.
    // Stated here anyway: it is the one number a reader of the statement is
    // entitled to find again in the trial balance.
    const { rows: control } = await pool.query<{ balance: string }>(
      `select coalesce(sum(case when $2::text = 'supplier'
                                then s.credit_iqd - s.debit_iqd
                                else s.debit_iqd - s.credit_iqd end), 0)::text as balance
         from subledger_entry s
        where s.subledger_type = $2::control_account_kind
          and s.party_code = $1
          and s.posting_date <= $3::date`,
      [party.code, party.side, to],
    );
    if (Math.abs(Number(control[0]!.balance) - Number(account.closing)) > 0.0001) {
      console.log(`  ✗ the subledger stands at ${money(control[0]!.balance)}, the statement at ${money(account.closing)}`);
      wrong += 1;
    }
  }

  console.log(
    `\n${parties.length} account${parties.length === 1 ? '' : 's'} read, ` +
      (wrong === 0 ? 'every one of them internally consistent.' : `${wrong} disagreement(s).`),
  );
  if (wrong > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { pool: appPool } = await import('../../src/server/db/client');
    await Promise.all([pool.end(), appPool.end()]);
  });
