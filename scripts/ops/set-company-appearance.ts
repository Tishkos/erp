/**
 * Everyone's default appearance, from a file (0419; 2026-10-07, by direction:
 * "I want my current setup to be the main default setup for everyone").
 *
 *   npx tsx scripts/ops/set-company-appearance.ts --as owner@company.com --from-json appearance.json [--apply]
 *   npx tsx scripts/ops/set-company-appearance.ts --as owner@company.com --reset [--apply]
 *
 * The file holds the palette, the accent and every layout and navigation
 * setting, by the names the Appearance drawer uses ("palette": "pearl",
 * "navigation": "side", …); other keys ("source") are ignored. It is what the
 * drawer's "Make my appearance everyone's default" writes, for a database
 * where nobody is going to press it — another install, the live one after a
 * rebuild.
 *
 * It does exactly what the drawer does — `user-appearance.setCompanyDefaults`
 * or `resetCompanyDefaults`, as the person named by --as, who must hold
 * `configure` on the company, and audited as them with before and after. A
 * person who chose their own appearance keeps it. Dry run unless --apply: the
 * transaction is rolled back after the service has checked everything.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { applyScope, db, withScope } from '../../src/server/db/client';
import { COMPANY_DEFAULT_NAMES, parseCompanyDefaults } from '../../src/server/domain/appearance';
import { loadPrincipal } from '../../src/server/services/authorization';
import * as userAppearance from '../../src/server/services/user-appearance';

const args = process.argv.slice(2);
const valueOf = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? (args[at + 1] ?? '') : '';
};
const email = valueOf('--as').trim().toLowerCase();
const file = valueOf('--from-json').trim();
const reset = args.includes('--reset');
const apply = args.includes('--apply');

if (!email.includes('@') || (!file && !reset) || (file && reset)) {
  console.error('usage: npx tsx scripts/ops/set-company-appearance.ts --as you@company.com (--from-json <file> | --reset) [--apply]');
  process.exit(1);
}

class DryRun extends Error {}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);

  const defaults = file
    ? parseCompanyDefaults(
        Object.fromEntries(
          Object.entries(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>).filter(([name]) =>
            (COMPANY_DEFAULT_NAMES as readonly string[]).includes(name),
          ),
        ),
      )
    : null;

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

  const scope = { userId: person.id, branchCode: person.branch, isSuperUser: true };
  try {
    await withScope(scope, async (tx) => {
      await applyScope(tx, scope);
      const ctx = { principal: await loadPrincipal(tx, person.id), branchCode: person.branch };
      const before = await userAppearance.storedCompanyDefaults(tx);
      if (defaults) await userAppearance.setCompanyDefaults(tx, ctx, defaults);
      else await userAppearance.resetCompanyDefaults(tx, ctx);
      console.log(`before: ${before ? JSON.stringify(before) : 'the built-in default'}`);
      console.log(`after:  ${defaults ? JSON.stringify(defaults) : 'the built-in default'}`);
      if (!apply) throw new DryRun('dry run');
    });
    console.log(`written as ${person.email}, audited (company.appearance_defaults_${defaults ? 'set' : 'reset'}).`);
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
