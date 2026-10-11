/**
 * Re-records the document numbers a table already holds, so the counter
 * starts after them.
 *
 *   npx tsx scripts/ops/resync-document-numbers.ts          what is missing
 *   npx tsx scripts/ops/resync-document-numbers.ts --apply  write it
 *
 * Why this exists (2026-10-11): the format of the live books on 2026-10-07
 * cleared `doc_number_allocation` with the documents — every counter back to
 * one — but left the master tables standing, employees among them. Eleven
 * employees EMP-HQ-0001…0011 remained with no allocation behind them, so the
 * next "New employee" was handed EMP-HQ-0001 again and refused by
 * `employee_no_uniq`; the two ports, PRT-0001 and PRT-0002, were one new port
 * away from the same. `next_document_serial` (migration 0214) catches a
 * counter up from `doc_number_allocation`, so recording the numbers is the
 * whole repair: nothing in the tables moves, the counter resumes after what
 * exists, and the serials the format took stay the gaps they are.
 *
 * Only the tables a format keeps are listed (`KEPT`): a document table is
 * emptied with its counter, and nothing there needs recording. A number the
 * series did not write — a hand-typed warehouse code, WH-PORT — is passed
 * over. Idempotent: a number already recorded is left alone, so this runs at
 * the end of every format (`format-live-database.sh`) and whenever a counter
 * is suspected of being behind. It writes nothing but allocation rows, and
 * only with --apply.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import { parseDocumentNumber, validateSequenceDefinition, type SequenceDefinition } from '../../src/server/domain/numbering';

/** The series whose numbers live in a table a format keeps: series → where its numbers are. */
const KEPT: ReadonlyArray<{ readonly key: string; readonly table: string; readonly column: string }> = [
  { key: 'EMPLOYEE', table: 'employee', column: 'employee_no' },
  { key: 'PORT_CODE', table: 'port', column: 'code' },
  { key: 'POSITION_CODE', table: 'position', column: 'code' },
  { key: 'TAX_CODE', table: 'tax_code', column: 'code' },
  { key: 'SUPPLIER_CODE', table: 'business_partner', column: 'code' },
  { key: 'CUSTOMER_CODE', table: 'business_partner', column: 'code' },
  { key: 'ITEM_CODE', table: 'item', column: 'code' },
  { key: 'WAREHOUSE_CODE', table: 'warehouse', column: 'code' },
  { key: 'BANK_ACCOUNT_CODE', table: 'bank_cash_account', column: 'code' },
  { key: 'CASH_ACCOUNT_CODE', table: 'bank_cash_account', column: 'code' },
];

interface Missing {
  readonly key: string;
  readonly scopeKey: string;
  readonly serial: bigint;
  readonly documentNo: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);
  console.log(apply ? 'mode:     APPLY' : 'mode:     dry run (--apply to write)');

  await db.transaction(async (tx) => {
    // Row-level security is on: the tables are read and the allocations
    // written as the first system administrator (or super user), the same
    // person ensure-user-employees.ts acts as.
    const [actor] = (
      await tx.execute(sql`
        SELECT u.id
          FROM app_user u
         WHERE u.is_active
           AND (u.is_super_user OR EXISTS (SELECT 1 FROM user_role r WHERE r.user_id = u.id AND r.role_code = 'system_administrator'))
         ORDER BY u.is_super_user DESC, u.created_at
         LIMIT 1
      `)
    ).rows as { id: string }[];
    if (!actor) throw new Error('No active system administrator to act as.');
    await applyScope(tx, { userId: actor.id, branchCode: '' });
    await tx.execute(sql`select set_config('app.is_super_user', 'true', true)`);

    const missing: Missing[] = [];
    for (const kept of KEPT) {
      const [row] = (
        await tx.execute(sql`select key, prefix, pattern, padding, scope_branch, scope_year, active from doc_sequence where key = ${kept.key}`)
      ).rows as Array<{ key: string; prefix: string; pattern: string; padding: number; scope_branch: boolean; scope_year: boolean; active: boolean }>;
      if (!row || !row.active) {
        console.log(`${kept.key.padEnd(20)} no active series — skipped`);
        continue;
      }
      const def: SequenceDefinition = { key: row.key, prefix: row.prefix, pattern: row.pattern, padding: row.padding, scopeBranch: row.scope_branch, scopeYear: row.scope_year };
      validateSequenceDefinition(def);

      const held = (await tx.execute(sql`select ${sql.identifier(kept.column)} as no from ${sql.identifier(kept.table)}`)).rows as Array<{ no: string | null }>;
      const written = held
        .map((one) => (one.no ?? '').trim())
        .filter((no) => no !== '')
        .map((no) => ({ no, parsed: parseDocumentNumber(def, no) }))
        .filter((one): one is { no: string; parsed: NonNullable<ReturnType<typeof parseDocumentNumber>> } => one.parsed !== null);
      const recorded = new Set(
        ((await tx.execute(sql`select document_no from doc_number_allocation where sequence_key = ${kept.key}`)).rows as Array<{ document_no: string }>).map((one) => one.document_no),
      );
      const gaps = written.filter((one) => !recorded.has(one.no));
      for (const one of gaps) missing.push({ key: kept.key, scopeKey: one.parsed.scopeKey, serial: one.parsed.serial, documentNo: one.no });
      console.log(`${kept.key.padEnd(20)} ${String(held.length).padStart(5)} rows, ${String(written.length).padStart(5)} of this series, ${String(recorded.size).padStart(5)} recorded, ${String(gaps.length).padStart(5)} to record`);
    }

    if (missing.length === 0) {
      console.log('every number is recorded; nothing to do');
      return;
    }
    for (const one of missing) console.log(`  ${one.key.padEnd(20)} ${one.scopeKey.padEnd(12)} ${one.serial.toString().padStart(6)}  ${one.documentNo}`);
    if (!apply) {
      console.log(`${missing.length} number(s) would be recorded. Run again with --apply.`);
      return;
    }
    for (const one of missing) {
      // A serial another number already holds in this counter is not taken
      // twice: that pair is left for somebody to look at, and said so.
      const done = await tx.execute(sql`
        insert into doc_number_allocation (sequence_key, scope_key, serial, document_no, allocated_by)
        values (${one.key}, ${one.scopeKey}, ${one.serial.toString()}::bigint, ${one.documentNo}, null)
        on conflict do nothing
        returning id
      `);
      if (done.rows.length === 0) console.log(`  NOT recorded: ${one.documentNo} — serial ${one.serial} of ${one.key} ${one.scopeKey} is already another number's`);
    }
    console.log(`${missing.length} number(s) recorded; the counters resume after them.`);
  });

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
