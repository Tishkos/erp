/**
 * Creates the three shipment-stage warehouses — Operations block 8.
 *
 *   In Process   On Board   On Port
 *
 * Block 8 tracks goods bought abroad from the purchase invoice to the shelf,
 * and each of the first three stages holds its stock in a warehouse of its
 * own. Which warehouse that is, is a property of the warehouse
 * (`shipment_stage`, migration 0190) — and nothing on any screen sets it,
 * because block 7's Warehouse Setup asks for a name and nothing else. So a
 * database that was set up before block 8, or one that was never seeded,
 * has no warehouse claiming any stage: a posted purchase invoice opens no
 * tracking, and Invoice Status Tracking is empty with nothing on it to say
 * why. `scripts/seed-dev.ts` makes them for a development database; this makes
 * them for any database, including the live one.
 *
 * Idempotent on the stage: run it twice and the second run creates nothing and
 * renames nothing. Safe on a live database — it adds three empty warehouses
 * and touches no stock, no document and no existing row.
 *
 *   npx tsx scripts/ops/ensure-stage-warehouses.ts [--branch HQ]
 *
 * The warehouses are made in the branch given, or HQ. They hold stock that is
 * at sea rather than in any one place, and the company has one of each.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { applyScope, db } from '../../src/server/db/client';
import * as authz from '../../src/server/services/authorization';
import * as warehouses from '../../src/server/services/warehouses';

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  const branchCode = argument('branch') ?? 'HQ';
  const url = process.env.DATABASE_URL ?? '';
  console.log(`database: ${url.replace(/:[^:@]*@/, ':***@') || '(unset)'}`);
  console.log(`branch:   ${branchCode}`);

  await db.transaction(async (tx) => {
    // Row level security is on, so a script that writes has to say who it is.
    // An accounting manager, because creating a warehouse is their permission
    // and this must not need a super user to be granted one.
    const [row] = (
      await tx.execute(sql`
        SELECT u.id
          FROM app_user u
          JOIN user_role r ON r.user_id = u.id
         WHERE r.role_code = 'accounting_manager' AND u.is_active
         ORDER BY u.created_at
         LIMIT 1
      `)
    ).rows as { id: string }[];

    if (!row) throw new Error('No active accounting manager to create the warehouses as.');

    await applyScope(tx, { userId: row.id, branchCode });
    const principal = await authz.loadPrincipal(tx, row.id);
    const made = await warehouses.ensureStageWarehouses(tx, { principal, branchCode });

    for (const entry of made) {
      console.log(
        `${entry.created ? 'created' : 'present'}  ${entry.stage.padEnd(10)}  ` +
          `${entry.code}  ${entry.name}`,
      );
    }
  });

  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
