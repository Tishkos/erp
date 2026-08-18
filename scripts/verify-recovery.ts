/**
 * Proves a restored database — Phase 00.3.
 *
 * Gate: *"The documented recovery procedure is executed once and succeeds."*
 *
 * A `pg_restore` that exits zero has copied bytes. It has not shown that the
 * database is usable, and the ways it can be unusable are quiet ones: row-level
 * security restored without FORCE, grants that did not come through, a schema a
 * migration behind the code about to connect to it. Each of those produces a
 * system that starts, serves, and is wrong.
 *
 * So this asserts the five things that would be silently broken, and one that
 * would be loudly broken but is worth stating anyway: that the ledger balances.
 *
 *   npx tsx scripts/verify-recovery.ts <database>
 *
 * Exits non-zero, naming what failed. See docs/RUNBOOK-database-recovery.md.
 */
import 'dotenv/config';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const target = process.argv[2];

if (!target) {
  console.error('Usage: tsx scripts/verify-recovery.ts <database>');
  process.exit(2);
}

const base = process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL;

if (!base) {
  console.error('DATABASE_URL_OWNER is not set. Copy .env.example to .env.');
  process.exit(2);
}

/** Same host and credentials, different database. */
const connectionString = base.replace(/\/[^/?]+(\?|$)/, `/${target}$1`);
const pool = new Pool({ connectionString, max: 2 });

const failures: string[] = [];
const checks: string[] = [];

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) checks.push(`  ✓ ${name}`);
  else failures.push(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  // 1. Schema at head.
  const onDisk = readdirSync(join(process.cwd(), 'src/server/db/migrations')).filter((f) =>
    f.endsWith('.sql'),
  ).length;

  const { rows: applied } = await pool.query(
    `select count(*)::int as n from drizzle.__drizzle_migrations`,
  );
  check(
    'schema is at head',
    applied[0].n === onDisk,
    `${applied[0].n} applied, ${onDisk} migration files on disk`,
  );

  // 2. Row-level security survived, INCLUDING force. Without FORCE the owner
  //    bypasses every policy and the database looks correct while leaking.
  const { rows: rls } = await pool.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and c.relname in ('audit_event','journal_entry','journal_line','subledger_entry',
                         'posting_log','posting_failure','workflow_instance','saved_view')
  `);
  const unprotected = rls
    .filter((r) => !r.relrowsecurity || !r.relforcerowsecurity)
    .map((r) => r.relname);
  check(
    'row-level security is enabled and forced',
    rls.length > 0 && unprotected.length === 0,
    unprotected.length > 0 ? `unprotected: ${unprotected.join(', ')}` : 'no scoped tables found',
  );

  // 3. Append-only triggers.
  const { rows: triggers } = await pool.query(
    `select tgname from pg_trigger where not tgisinternal and tgname like '%append_only%'`,
  );
  check(
    'append-only triggers are present',
    triggers.length > 0,
    `${triggers.length} found`,
  );

  // 4. The application role cannot delete a document.
  const { rows: deletes } = await pool.query(`
    select table_name from information_schema.role_table_grants
     where grantee = 'erp_app' and privilege_type = 'DELETE'
       and table_name in ('journal_entry','chart_of_account','audit_event','subledger_entry',
                          'business_partner','item','workflow_instance')
  `);
  check(
    'the application role holds no DELETE on documents',
    deletes.length === 0,
    deletes.map((r) => r.table_name).join(', '),
  );

  // 5. The ledger balances. A partial restore can pass every structural check
  //    and still have lost half a journal.
  const { rows: balance } = await pool.query(`
    select coalesce(sum(total_debit_iqd), 0)  as debits,
           coalesce(sum(total_credit_iqd), 0) as credits
      from journal_entry where status = 'posted'
  `);
  check(
    'posted journals balance in IQD',
    String(balance[0].debits) === String(balance[0].credits),
    `debits ${balance[0].debits} vs credits ${balance[0].credits}`,
  );

  // 6. The account roots are there. A chart with no roots is a restore that
  //    dropped reference data the migrations seeded.
  const { rows: roots } = await pool.query(
    `select count(*)::int as n from chart_of_account where level = 0 and is_system`,
  );
  check('the five account groups are present', roots[0].n === 5, `${roots[0].n} found`);

  console.log(`\nRecovery verification — database '${target}'\n`);
  for (const line of checks) console.log(line);
  for (const line of failures) console.log(line);

  if (failures.length > 0) {
    console.log(`\n${failures.length} check(s) failed. Do not put this database into service.`);
    console.log('See docs/RUNBOOK-database-recovery.md, "If the restore fails".\n');
    process.exit(1);
  }

  console.log('\nAll checks passed. Record the rehearsal in the runbook.\n');
  process.exit(0);
}

main().catch((error) => {
  console.error('\nVerification could not run:', error instanceof Error ? error.message : error);
  process.exit(2);
});
