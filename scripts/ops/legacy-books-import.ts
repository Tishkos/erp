/**
 * Load the accountant's old books — REQ-LEGACY-001, from the command line.
 *
 *   npx tsx scripts/ops/legacy-books-import.ts <dir> <cut-over date>            # dry run
 *   npx tsx scripts/ops/legacy-books-import.ts <dir> <cut-over date> --apply    # and write
 *
 * The same service the Legacy Import screen calls, run where the files are.
 * The screen is the accountant's way in and stays the way in; this exists for
 * the cut-over itself, when the books have to be loaded onto an install whose
 * only user has not finished setting their password yet.
 *
 * A dry run reads every workbook, decides everything and writes nothing but
 * its own report row. `--apply` does the same and then, in one transaction,
 * creates what is missing, posts the opening balances as one journal per
 * currency, raises an Opening Stock document per warehouse **submitted and
 * not approved** — the old system's stock figure and the sum of its latest
 * costs disagree, and which is right is the accountant's judgement, made on
 * that screen — and keeps every old sale, purchase, receipt and payment as
 * read-only history.
 *
 * Re-running adds only what is missing: the opening journal's source id
 * carries the hash of the file set, so the same books post once.
 */
import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { applyScope, db, withScope } from '../../src/server/db/client';
import { loadPrincipal } from '../../src/server/services/authorization';
import * as legacy from '../../src/server/services/legacy-import';

const dir = (process.argv[2] ?? '').trim();
const cutOverDate = (process.argv[3] ?? '').trim();
const apply = process.argv.includes('--apply');

if (!dir || !/^\d{4}-\d{2}-\d{2}$/.test(cutOverDate)) {
  console.error('usage: npx tsx scripts/ops/legacy-books-import.ts <dir> <YYYY-MM-DD> [--apply]');
  process.exit(1);
}
if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`not a directory: ${dir}`);
  process.exit(1);
}

const files = readdirSync(dir)
  .filter((name) => /\.(xlsx|xls)$/i.test(name) && !name.startsWith('~$'))
  .sort()
  .map((fileName) => ({ fileName, content: readFileSync(join(dir, fileName)) }));

if (files.length === 0) {
  console.error(`no .xlsx or .xls files in ${dir}`);
  process.exit(1);
}

function money(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : value;
}

async function main(): Promise<void> {
  const who = await db.transaction(async (tx) => {
    const rows = (
      await tx.execute(sql`select id, email from app_user where is_super_user order by created_at limit 1`)
    ).rows as { id: string; email: string }[];
    if (!rows[0]) throw new Error('no super user on this install — run create-first-user.ts first');
    return rows[0];
  });

  const branch = await db.transaction(async (tx) => {
    await applyScope(tx, { userId: who.id, branchCode: '', isSuperUser: true });
    const rows = (
      await tx.execute(sql`
        select branch_code from user_branch_scope where user_id = ${who.id} order by is_default desc limit 1`)
    ).rows as { branch_code: string }[];
    if (!rows[0]) throw new Error(`${who.email} has no branch scope`);
    return rows[0].branch_code;
  });

  const scope = { userId: who.id, branchCode: branch, isSuperUser: true };
  const principal = await withScope(scope, (tx) => loadPrincipal(tx, who.id));
  const ctx = { principal, branchCode: branch };

  console.log(`${files.length} workbook(s) · cut-over ${cutOverDate} · as ${who.email} in ${branch}`);
  console.log(apply ? 'APPLY — this writes\n' : 'DRY RUN — nothing is written\n');

  const report = await withScope(scope, (tx) =>
    apply ? legacy.apply(tx, ctx, { files, cutOverDate }) : legacy.dryRun(tx, ctx, { files, cutOverDate }),
  );

  for (const file of report.files) {
    for (const sheet of file.sheets) console.log(`  ${file.fileName} :: ${sheet.sheet} → ${sheet.kind} (${sheet.rows} rows)`);
  }
  console.log('');
  console.log(`  missing kinds   ${report.missing.length ? report.missing.join(', ') : 'none'}`);
  console.log(`  rate implied    ${report.rate.implied ?? '—'}   erp ${report.rate.erp ?? '—'}`);
  console.log('');
  console.log(`  partners        create ${report.partners.create.length} · matched ${report.partners.matched.length} · conflicts ${report.partners.conflicts.length}`);
  console.log(`  warehouses      create ${report.warehouses.create.length} · matched ${report.warehouses.matched.length}`);
  console.log(`  items           create ${report.items.create.length} · matched ${report.items.matched.length}`);
  console.log('');
  console.log(`  balances        ${report.balances.lines.length} lines · agrees with the trial balance: ${report.balances.agrees ? 'yes' : 'NO'}`);
  console.log(`    customers     IQD ${money(report.balances.totals.customerIqd)} · USD ${money(report.balances.totals.customerUsd)}`);
  console.log(`    suppliers     IQD ${money(report.balances.totals.supplierIqd)} · USD ${money(report.balances.totals.supplierUsd)}`);
  for (const journal of report.balances.journals) {
    console.log(`    journal       ${journal.currency}: ${journal.entryNo ?? '(dry run)'} · ${journal.lines} lines · equity ${money(journal.equity)}`);
  }
  console.log('');
  console.log(`  stock           ${report.stock.documents.length} document(s) · proposed IQD ${money(report.stock.proposedValueIqd)} · old books say ${money(report.stock.tbValueIqd)}`);
  for (const document of report.stock.documents) {
    console.log(`    ${document.warehouse.padEnd(18)} ${String(document.lines).padStart(4)} lines · ${money(document.costIqd)} IQD · ${document.documentNo ?? '(dry run)'}`);
  }
  if (report.stock.noCost.length > 0) console.log(`    ${report.stock.noCost.length} line(s) with no cost in the old books — left out of the document`);
  if (report.stock.inTransit.length > 0) console.log(`    ${report.stock.inTransit.length} line(s) in transit or negative — listed, not stock (the accountant, 2026-10-02)`);

  console.log('');
  if (report.stops.length > 0) {
    console.log('  STOPS — an apply is refused while these stand:');
    for (const stop of report.stops) console.log(`    • ${stop}`);
  } else {
    console.log('  stops           none');
  }

  if (report.problems.length > 0) {
    console.log('');
    console.log(`  problems (${report.problems.length}, first 20):`);
    for (const problem of report.problems.slice(0, 20)) {
      console.log(`    • ${problem.fileName} :: ${problem.sheet} row ${problem.row}: ${problem.message}`);
    }
  } else {
    console.log('  problems        none');
  }
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`\nfailed: ${error instanceof Error ? error.message : String(error)}`);
    const cause = (error as { cause?: unknown }).cause;
    if (cause) console.error(`cause: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  });
