/**
 * What the legacy books import asks for before it will post — REQ-LEGACY-001.
 *
 *   npx tsx scripts/ops/prepare-legacy-import.ts [cut-over date] [USD rate]
 *
 * The dry run of the accountant's ten workbooks names four things it cannot
 * decide for itself, and refuses to apply while any of them stands:
 *
 *   1. no accounting period covers the cut-over date;
 *   2. no posting mapping for `customer_receivable`;
 *   3. no posting mapping for `supplier_payable`;
 *   4. no posting mapping for `opening_balance`.
 *
 * Each is configuration an administrator would type on a screen — Accounting
 * Periods, Chart of Accounts, Posting Mappings, Currencies and Rates. On a
 * freshly rebuilt install there is nobody to type them before the books can
 * be loaded, so this does the same thing in one go, with the same codes and
 * names `scripts/seed-dev.ts` uses for a configured company, and nothing
 * else: no partners, no items, no balances. Those come from the workbooks.
 *
 * Every statement is idempotent, so it may be run twice. Everything it
 * creates is editable afterwards on the screen that owns it — these are
 * defaults to start from, not decisions nobody may revisit.
 *
 * The rate deserves a word. The books imply 1,470 IQD to the dollar (the
 * USD balances against their own IQD trial balance), and the opening journal
 * converts at the ERP's rate for the cut-over date: seeding the books' own
 * implied rate is what makes the opening position agree with the system it
 * came from. The CBI official rate is 1,320; use it instead by passing it,
 * or supersede it later on Currencies and Rates, which is where rates belong.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';

const cutOver = (process.argv[2] ?? '').trim() || new Date().toISOString().slice(0, 10);
const usdRate = (process.argv[3] ?? '').trim() || '1470';
const year = Number(cutOver.slice(0, 4));

if (!/^\d{4}-\d{2}-\d{2}$/.test(cutOver)) {
  console.error('usage: npx tsx scripts/ops/prepare-legacy-import.ts 2026-10-01 [1470]');
  process.exit(1);
}

/** The three accounts the opening journal needs, under the seeded roots. */
const ACCOUNTS: readonly { code: string; name: string; parent: string; control: string | null }[] = [
  { code: 'A100020', name: 'Trade Receivables', parent: 'A000001', control: 'customer' },
  { code: 'L100010', name: 'Trade Payables', parent: 'L000001', control: 'supplier' },
  { code: 'E100010', name: 'Opening Balance Equity', parent: 'E000001', control: null },
];

/** The three roles the import posts through. */
const MAPPINGS: readonly { event: string; role: string; code: string }[] = [
  { event: 'legacy.opening_balance', role: 'customer_receivable', code: 'A100020' },
  { event: 'legacy.opening_balance', role: 'supplier_payable', code: 'L100010' },
  { event: 'legacy.opening_balance', role: 'opening_balance', code: 'E100010' },
];

async function main(): Promise<void> {
  const did: string[] = [];

  await db.transaction(async (tx) => {
    const [admin] = (
      await tx.execute(sql`select id, email from app_user where is_super_user order by created_at limit 1`)
    ).rows as { id: string; email: string }[];
    if (!admin) throw new Error('no super user on this install — run create-first-user.ts first');

    await applyScope(tx, { userId: admin.id, branchCode: '', isSuperUser: true });

    // 1 — Finance. A journal entry may only be raised from a finance
    // department, and the import posts one.
    await tx.execute(sql`
      insert into department (code, name, is_finance, active)
      values ('FIN', 'Finance', true, true)
      on conflict (code) do update set is_finance = true`);
    await tx.execute(sql`
      insert into user_department_scope (user_id, department_code, is_manager)
      values (${admin.id}, 'FIN', true)
      on conflict (user_id, department_code) do nothing`);
    did.push('finance department FIN, with the administrator in it as manager');

    // 2 — The year, open, month by month. A posting needs a period.
    await tx.execute(sql`
      insert into fiscal_year (code, name, starts_on, ends_on, status)
      values (${`FY${year}`}, ${String(year)}, ${`${year}-01-01`}, ${`${year}-12-31`}, 'open')
      on conflict (code) do nothing`);
    for (let month = 1; month <= 12; month += 1) {
      const from = `${year}-${String(month).padStart(2, '0')}-01`;
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const to = `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
      await tx.execute(sql`
        insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on, status)
        select id, ${month}, ${`${year}-${String(month).padStart(2, '0')}`}, ${from}, ${to}, 'open'
          from fiscal_year where code = ${`FY${year}`}
        on conflict do nothing`);
    }
    did.push(`fiscal year FY${year}, twelve periods, open`);

    // 3 — The rate, from the first day of the year so any cut-over in it is
    // covered. Entered by the administrator, as a typed rate would be.
    await tx.execute(sql`
      insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, source, entered_by)
      values ('USD', 'accounting', ${usdRate}, ${`${year}-01-01`}, 'legacy books (implied)', ${admin.id})
      on conflict do nothing`);
    did.push(`USD accounting rate ${usdRate} from ${year}-01-01`);

    // 4 — The three accounts, approved, so they may be posted to.
    for (const account of ACCOUNTS) {
      await tx.execute(sql`
        insert into chart_of_account
          (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
           currency_restriction, control_account)
        select ${account.code}, ${account.name}, account_type, id, false, true, 'approved', 1, 'IQD',
               ${account.control}::control_account_kind
          from chart_of_account where code = ${account.parent}
        on conflict (code) do nothing`);
    }
    did.push(`accounts ${ACCOUNTS.map((a) => a.code).join(', ')}`);

    // 5 — The mappings the import's journal posts through.
    for (const mapping of MAPPINGS) {
      await tx.execute(sql`
        insert into posting_rule (event_type, line_role, account_id, is_active)
        select ${mapping.event}, ${mapping.role}, id, true
          from chart_of_account where code = ${mapping.code}
        on conflict do nothing`);
    }
    did.push(`mappings ${MAPPINGS.map((m) => `${m.role}→${m.code}`).join(', ')}`);
  });

  console.log('');
  for (const line of did) console.log(`  ✓ ${line}`);
  console.log('');
  console.log('  Each of these is editable on its own screen: Departments, Accounting');
  console.log('  Periods, Currencies and Rates, Chart of Accounts, Posting Mappings.');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
