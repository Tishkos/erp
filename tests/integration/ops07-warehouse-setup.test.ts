/**
 * Warehouse Setup — Operations build, block 7 (2026-09-15).
 *
 *   Warehouse Setup   Warehouse Name; Warehouse Code.
 *
 * Until this, a warehouse could only come into being as a side effect of
 * creating a branch, so a company had exactly as many warehouses as branches.
 * Every screen that moves stock names one, which made that limit the whole of
 * block 7 stuck behind it.
 *
 * The interesting cases are not the happy one. They are the code that is
 * already taken — because a code is what every movement refers to — and closing
 * a warehouse that holds stock, which must hide it from the pickers without
 * pretending the stock is gone.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as warehouses from '@/server/services/warehouses';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';

let manager: ActorContext;
let officer: ActorContext;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

const make = (ctx: ActorContext, code: string, name: string) =>
  withScope(scope(ctx), (tx) => warehouses.create(tx, ctx, { code, name }));

const listed = (ctx: ActorContext) => withScope(scope(ctx), (tx) => warehouses.list(tx));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');
});

// ---------------------------------------------------------------------------
describe('ops 7 · setting up a warehouse', () => {
  it('takes a name and a code, and nothing else', async () => {
    await make(manager, 'WH-EAST', 'East Warehouse');

    const rows = await listed(manager);
    const created = rows.find((row) => row.code === 'WH-EAST');
    expect(created).toMatchObject({
      code: 'WH-EAST',
      name: 'East Warehouse',
      branchCode: BAGHDAD,
      active: true,
    });
  });

  it('puts it in the branch of whoever made it', async () => {
    // The branch is not on the form and cannot be absent from the record, so
    // it comes from the person. This is the assertion that says so.
    await make(manager, 'WH-EAST', 'East Warehouse');
    const [row] = (await listed(manager)).filter((r) => r.code === 'WH-EAST');
    expect(row!.branchCode).toBe(manager.branchCode);
  });

  it('upper-cases the code, so WH-east and WH-EAST are one warehouse', async () => {
    await make(manager, 'wh-east', 'East Warehouse');
    expect((await listed(manager)).some((row) => row.code === 'WH-EAST')).toBe(true);

    await expect(make(manager, 'WH-EAST', 'Another')).rejects.toThrow(/already exists/i);
  });

  it('refuses a code that is already taken, and says what holds it', async () => {
    await make(manager, 'WH-EAST', 'East Warehouse');

    // A code is what every stock movement names. Two warehouses sharing one
    // would put stock in a place that is two places.
    await expect(make(manager, 'WH-EAST', 'East Annexe')).rejects.toThrow(
      /already exists — it is 'East Warehouse'/,
    );
  });

  it('refuses a blank name or a blank code', async () => {
    await expect(make(manager, 'WH-X', '   ')).rejects.toThrow(/needs a name/i);
    await expect(make(manager, '   ', 'Nameless')).rejects.toThrow(/needs a code/i);
  });

  it('refuses somebody without the verb', async () => {
    // The officer may look at the list and may not add to it.
    await expect(make(officer, 'WH-EAST', 'East Warehouse')).rejects.toThrow();
    expect(await listed(officer)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('ops 7 · changing one afterwards', () => {
  it('renames it without touching its code', async () => {
    await make(manager, 'WH-EAST', 'East Warehouse');
    await withScope(scope(manager), (tx) =>
      warehouses.rename(tx, manager, 'WH-EAST', 'Eastern Depot'),
    );

    const [row] = (await listed(manager)).filter((r) => r.code === 'WH-EAST');
    expect(row!.name).toBe('Eastern Depot');
  });

  it('closes one without deleting it', async () => {
    await make(manager, 'WH-EAST', 'East Warehouse');
    // Closing costs a reason — "why" is the question somebody asks a year
    // later, and the service has required it since the warehouses kept their
    // history.
    await withScope(scope(manager), (tx) =>
      warehouses.setActive(tx, manager, 'WH-EAST', false, 'The depot lease ended.'),
    );

    // Gone from the pickers, still in the record — the movements that put stock
    // there point at this row, and where the stock was is part of the history.
    const picker = await withScope(scope(manager), (tx) => warehouses.listActive(tx));
    expect(picker.some((row) => row.code === 'WH-EAST')).toBe(false);

    const rows = await listed(manager);
    expect(rows.find((row) => row.code === 'WH-EAST')).toMatchObject({ active: false });
  });

  it('reopens one that was closed', async () => {
    await make(manager, 'WH-EAST', 'East Warehouse');
    await withScope(scope(manager), (tx) =>
      warehouses.setActive(tx, manager, 'WH-EAST', false, 'Closed for stocktaking.'),
    );
    await withScope(scope(manager), (tx) => warehouses.setActive(tx, manager, 'WH-EAST', true));

    const picker = await withScope(scope(manager), (tx) => warehouses.listActive(tx));
    expect(picker.some((row) => row.code === 'WH-EAST')).toBe(true);
  });

  it('refuses to rename one that does not exist', async () => {
    await expect(
      withScope(scope(manager), (tx) => warehouses.rename(tx, manager, 'WH-NOPE', 'Ghost')),
    ).rejects.toThrow(/No warehouse with code/i);
  });

  it('offers only ordinary warehouses to a picker', async () => {
    await make(manager, 'WH-EAST', 'East Warehouse');
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type, is_transit)
       values ('WH-TRANSIT','In Transit',$1,'transit',true)`,
      [BAGHDAD],
    );

    // Transit, quarantine and damaged-goods warehouses hold stock that is not
    // available to sell. Offering one where a person meant an ordinary
    // warehouse would leave them unable to see why their stock vanished.
    const picker = await withScope(scope(manager), (tx) => warehouses.listActive(tx));
    expect(picker.some((row) => row.code === 'WH-TRANSIT')).toBe(false);
    expect(picker.some((row) => row.code === 'WH-EAST')).toBe(true);
  });
});
