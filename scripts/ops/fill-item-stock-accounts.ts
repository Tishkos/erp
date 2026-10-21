/**
 * Items that cannot be sold for want of a stock account (0423; 2026-10-21, by
 * direction: "when I create and approve an invoice it does not post … assign
 * the appropriate COGS account to each item, or configure a default account
 * for the item group").
 *
 *   npx tsx scripts/ops/fill-item-stock-accounts.ts
 *       lists the stock items that name no inventory or COGS account, by category
 *   npx tsx scripts/ops/fill-item-stock-accounts.ts --as finance@company.com \
 *       (--company | --category "<name>") [--inventory <code>] [--cogs <code>] [--apply]
 *       sets that default (accounts by their chart code) and fills the items it answers for
 *   npx tsx scripts/ops/fill-item-stock-accounts.ts --as finance@company.com --fill [--apply]
 *       fills every such item from the defaults already set
 *
 * It does exactly what Items › Category accounts does — `items.setCategoryAccounts`
 * or `items.fillMissingAccounts`, as the person named by --as, who must hold
 * `configure` on `item`, one audit row per item filled. An account an item
 * already names is never replaced. Dry run unless --apply: the transaction is
 * rolled back after the service has done its work, and what it would have
 * filled is printed.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db, withScope } from '../../src/server/db/client';
import { loadPrincipal } from '../../src/server/services/authorization';
import * as items from '../../src/server/services/items';

const args = process.argv.slice(2);
const valueOf = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? (args[at + 1] ?? '').trim() : '';
};
const email = valueOf('--as').toLowerCase();
const category = valueOf('--category');
const company = args.includes('--company');
const fill = args.includes('--fill');
const inventoryCode = valueOf('--inventory');
const cogsCode = valueOf('--cogs');
const apply = args.includes('--apply');

const usage =
  'usage: npx tsx scripts/ops/fill-item-stock-accounts.ts [--as you@company.com ((--company | --category "<name>") [--inventory <code>] [--cogs <code>] | --fill) [--apply]]';

if (email && !fill && !company && !category) {
  console.error(usage);
  process.exit(1);
}
if ((company || category) && !inventoryCode && !cogsCode) {
  console.error('Name the account the default should be: --inventory <code>, --cogs <code>, or both.');
  process.exit(1);
}

class DryRun extends Error {}

async function report(): Promise<void> {
  const result = await db.execute(sql`
    select coalesce(i.category, '(no category)') as category,
           count(*) filter (where i.inventory_account_id is null)::int as "noInventory",
           count(*) filter (where i.cogs_account_id is null)::int      as "noCogs",
           string_agg(i.code, ', ' order by i.code)                  as codes
      from item i
     where i.is_stock and (i.inventory_account_id is null or i.cogs_account_id is null)
     group by 1 order by 1`);
  const rows = result.rows as { category: string; noInventory: number; noCogs: number; codes: string }[];
  if (rows.length === 0) {
    console.log('Every stock item names an inventory and a COGS account.');
    return;
  }
  for (const row of rows) {
    console.log(`${row.category}: ${row.noInventory} without inventory, ${row.noCogs} without COGS — ${row.codes}`);
  }
}

async function accountId(code: string): Promise<string | null> {
  if (!code) return null;
  const found = await db.execute(sql`select id from chart_of_account where code = ${code} limit 1`);
  const row = found.rows[0] as { id: string } | undefined;
  if (!row) throw new Error(`${code}: no account with that code in the chart.`);
  return row.id;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);
  console.log('before:');
  await report();
  if (!email) return;

  const found = await db.execute(
    sql`select u.id, u.email, u.is_active, coalesce(
          (select s.branch_code from user_branch_scope s where s.user_id = u.id order by s.is_default desc limit 1), 'HQ') as branch
          from app_user u where lower(u.email) = ${email} limit 1`,
  );
  const person = found.rows[0] as { id: string; email: string; is_active: boolean; branch: string } | undefined;
  if (!person || !person.is_active) {
    console.error(`${email}: no active user with that e-mail.`);
    process.exit(1);
  }
  const inventoryAccountId = await accountId(inventoryCode);
  const cogsAccountId = await accountId(cogsCode);

  const scope = { userId: person.id, branchCode: person.branch, isSuperUser: true };
  try {
    await withScope(scope, async (tx) => {
      await applyScope(tx, scope);
      const ctx = { principal: await loadPrincipal(tx, person.id), branchCode: person.branch };
      if (fill) {
        const filled = await items.fillMissingAccounts(tx, ctx, {});
        console.log(`filled ${filled.length}: ${filled.map((one) => one.code).join(', ') || '—'}`);
      } else {
        const { filled } = await items.setCategoryAccounts(tx, ctx, {
          category: company ? null : category,
          inventoryAccountId,
          cogsAccountId,
        });
        console.log(`default for ${company ? 'the company' : category} set; ${filled} item(s) filled.`);
      }
      if (!apply) throw new DryRun('dry run');
    });
    console.log(`written as ${person.email}, audited (item.category_accounts_set / item.stock_accounts_defaulted).`);
    console.log('after:');
    await report();
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    console.log('dry run: nothing written. Add --apply to write it.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
