/**
 * Development and end-to-end seed — Phase 01.12.
 *
 * Creates the minimum a person needs to sign in and reach a screen: one branch,
 * one department, and two users who differ only in role, so that the
 * maker-checker behaviour and the permission-driven navigation can be seen and
 * tested rather than described.
 *
 * NOT a migration and never run against production. Migrations carry the
 * reference data the system cannot work without (statuses, roles, the account
 * groups); this file carries the data a *developer* needs, which is a different
 * thing and must not end up in a customer's database.
 *
 *   npm run db:seed
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { db, applyScope } from '../src/server/db/client';
import { setPassword } from '../src/server/services/authentication';
import { sql } from 'drizzle-orm';

const OFFICER_EMAIL = 'officer@example.com';
const MANAGER_EMAIL = 'manager@example.com';
const OUTSIDER_EMAIL = 'outsider@example.com';
/**
 * A super user, for reviewing screens rather than for testing permissions.
 *
 * The three roles above exist to *demonstrate* permission: the officer may read
 * and submit, the manager may approve and export, the outsider is refused. None
 * of them holds a grant on a reporting or configuration object, so of the 218
 * screens in the approved tree the most privileged of them can open 43. That is
 * correct behaviour and wrong for a developer, who needs to see the other 175
 * to know whether they are built properly.
 *
 * Kept deliberately separate from the three: nothing that asserts a denial
 * should ever sign in as this user, and no test does.
 */
const ADMIN_EMAIL = 'admin@example.com';
const PASSWORD = 'Ledger-Trial-Balance-7';

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('The development seed must not run against production.');
  }

  await db.transaction(async (tx) => {
    await applyScope(tx, { userId: randomUUID(), branchCode: 'HQ', isSuperUser: true });

    // §4.1 — a branch, its default warehouse and its default cash account are
    // created together. The deferred constraint that enforces this fires at
    // COMMIT, so all three must be in this one transaction; a branch left
    // without them is exactly the half-configured state it exists to prevent.
    const existing = await tx.execute(sql`SELECT 1 FROM branch WHERE code = 'HQ'`);

    if (existing.rows.length === 0) {
      await tx.execute(sql`INSERT INTO branch (code, name, active) VALUES ('HQ', 'Head Office', true)`);

      await tx.execute(sql`
        INSERT INTO warehouse (code, name, branch_code, warehouse_type)
        VALUES ('WH-HQ', 'Head Office Main Warehouse', 'HQ', 'main')
      `);

      const account = await tx.execute(sql`
        INSERT INTO chart_of_account
          (code, name, account_type, parent_id, is_group, is_active, approval_status, level,
           currency_restriction)
        SELECT 'A100001', 'Head Office Cash at Bank', 'asset', id, false, true, 'approved', 1,
               'IQD'
          FROM chart_of_account WHERE code = 'A000001'
        RETURNING id
      `);
      const glAccountId = (account.rows[0] as { id: string }).id;

      const cash = await tx.execute(sql`
        INSERT INTO bank_cash_account
          (code, name, account_type, bank_name, account_number, gl_account_id, branch_code)
        VALUES ('CASH-HQ', 'Head Office Cash Account', 'bank', 'Seed Bank', 'ACC-HQ',
                ${glAccountId}, 'HQ')
        RETURNING id
      `);

      await tx.execute(sql`
        UPDATE branch
           SET default_warehouse_code = 'WH-HQ',
               default_cash_account_id = ${(cash.rows[0] as { id: string }).id}
         WHERE code = 'HQ'
      `);
    }

    await tx.execute(sql`
      INSERT INTO department (code, name, active, is_finance)
      VALUES ('FIN', 'Finance', true, true), ('OPS', 'Operations', true, false)
      ON CONFLICT (code) DO NOTHING
    `);

    for (const [email, name, role] of [
      [OFFICER_EMAIL, 'Accounting Officer', 'accounting_officer'],
      [MANAGER_EMAIL, 'Accounting Manager', 'accounting_manager'],
      // A signed-in user holding nothing. §25's deny-by-default is only
      // demonstrable if somebody is denied, and the 01.2 gate asks for a
      // denial on the direct URL rather than a hidden menu item.
      [OUTSIDER_EMAIL, 'No Permissions', null],
    ] as const) {
      const [row] = (
        await tx.execute(sql`
          INSERT INTO app_user (email, display_name, is_active)
          VALUES (${email}, ${name}, true)
          ON CONFLICT (lower(email)) DO UPDATE SET display_name = excluded.display_name
          RETURNING id
        `)
      ).rows as { id: string }[];

      const userId = row!.id;

      if (role) {
        await tx.execute(sql`
          INSERT INTO user_role (user_id, role_code) VALUES (${userId}, ${role})
          ON CONFLICT DO NOTHING
        `);
      }

      // §5.2 — the manager toggle is per department, so it is set on the row.
      await tx.execute(sql`
        INSERT INTO user_department_scope (user_id, department_code, is_manager)
        VALUES (${userId}, 'FIN', ${role === 'accounting_manager'})
        ON CONFLICT (user_id, department_code) DO UPDATE SET is_manager = excluded.is_manager
      `);

      await tx.execute(sql`
        INSERT INTO user_branch_scope (user_id, branch_code, is_default)
        VALUES (${userId}, 'HQ', true)
        ON CONFLICT (user_id, branch_code) DO UPDATE SET is_default = true
      `);

      await setPassword(tx, userId, PASSWORD, { temporary: false });
    }

    // The reviewer. `is_super_user` is the same flag the permission layer
    // already honours, so this adds no new path through authorisation — it
    // exercises the one that exists, from a user who is not part of any
    // permission assertion.
    const [admin] = (
      await tx.execute(sql`
        INSERT INTO app_user (email, display_name, is_active, is_super_user)
        VALUES (${ADMIN_EMAIL}, 'System Administrator', true, true)
        ON CONFLICT (lower(email)) DO UPDATE
          SET display_name = excluded.display_name, is_super_user = true
        RETURNING id
      `)
    ).rows as { id: string }[];

    const adminId = admin!.id;
    await tx.execute(sql`
      INSERT INTO user_department_scope (user_id, department_code, is_manager)
      VALUES (${adminId}, 'FIN', true)
      ON CONFLICT (user_id, department_code) DO UPDATE SET is_manager = true
    `);
    await tx.execute(sql`
      INSERT INTO user_branch_scope (user_id, branch_code, is_default)
      VALUES (${adminId}, 'HQ', true)
      ON CONFLICT (user_id, branch_code) DO UPDATE SET is_default = true
    `);
    await setPassword(tx, adminId, PASSWORD, { temporary: false });
  });

  // Stock to look at and to issue from — Phase 04. Written through raw SQL
  // rather than the service because a seed is not a user, and the availability
  // rules it would exercise are proved by the tests, not by the seed.
  await db.transaction(async (tx) => {
    await applyScope(tx, { userId: randomUUID(), branchCode: 'HQ', isSuperUser: true });

    const existing = await tx.execute(sql`SELECT 1 FROM item WHERE code = 'ITM-SEED'`);
    if (existing.rows.length > 0) return;

    const item = await tx.execute(sql`
      INSERT INTO item (code, name, is_stock, base_uom_code, tracking, category)
      VALUES ('ITM-SEED', 'Seed Cable 2m', true, 'EA', 'batch', 'CABLES')
      RETURNING id
    `);
    await tx.execute(sql`
      INSERT INTO item_uom (item_id, uom_code, conversion_numerator, conversion_denominator)
      VALUES (${(item.rows[0] as { id: string }).id}, 'EA', 1, 1)
    `);

    const owner = (
      await tx.execute(sql`SELECT id FROM app_user WHERE lower(email) = ${MANAGER_EMAIL}`)
    ).rows[0] as { id: string };

    const movement = await tx.execute(sql`
      INSERT INTO inventory_movement
        (item_code, warehouse_code, branch_code, kind, quantity, movement_date,
         batch_number, created_by)
      VALUES ('ITM-SEED', 'WH-HQ', 'HQ', 'opening_stock', 250, '2026-01-01',
              'B-SEED', ${owner.id})
      RETURNING id
    `);

    await tx.execute(sql`
      INSERT INTO cost_layer
        (item_code, warehouse_code, branch_code, layer_date, sequence,
         original_quantity, remaining_quantity, unit_cost_iqd, created_by_movement_id)
      VALUES ('ITM-SEED', 'WH-HQ', 'HQ', '2026-01-01', 1, 250, 250, 12.5000,
              ${(movement.rows[0] as { id: string }).id})
    `);
  });

  console.log(
    `seeded ${OFFICER_EMAIL}, ${MANAGER_EMAIL}, ${OUTSIDER_EMAIL} and ` +
      `${ADMIN_EMAIL} (super user) — password ${PASSWORD}`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
