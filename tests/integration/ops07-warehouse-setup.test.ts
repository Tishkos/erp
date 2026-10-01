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

const make = (ctx: ActorContext, name: string) =>
  withScope(scope(ctx), (tx) => warehouses.create(tx, ctx, { name }));

const listed = (ctx: ActorContext) => withScope(scope(ctx), (tx) => warehouses.list(tx));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');
});

// ---------------------------------------------------------------------------
describe('ops 7 · setting up a warehouse', () => {
  it('takes a name, and the system gives it its code', async () => {
    const east = await make(manager, 'East Warehouse');
    expect(east.code).toMatch(/^WH-\d{4}$/);

    const rows = await listed(manager);
    expect(rows.find((row) => row.code === east.code)).toMatchObject({
      name: 'East Warehouse',
      branchCode: BAGHDAD,
      active: true,
    });
  });

  it('puts it in the branch of whoever made it', async () => {
    // The branch is not on the form and cannot be absent from the record, so
    // it comes from the person. This is the assertion that says so.
    const east = await make(manager, 'East Warehouse');
    const [row] = (await listed(manager)).filter((r) => r.code === east.code);
    expect(row!.branchCode).toBe(manager.branchCode);
  });

  it('mints a different code every time, so two warehouses can never share one', async () => {
    const first = await make(manager, 'East Warehouse');
    const second = await make(manager, 'East Warehouse');
    expect(second.code).not.toBe(first.code);
  });

  it('takes no code from the caller, even one slipped into the request', async () => {
    const made = await withScope(scope(manager), (tx) =>
      warehouses.create(tx, manager, { name: 'East', code: 'TYPED' } as never),
    );
    expect(made.code).toMatch(/^WH-\d{4}$/);
    expect((await listed(manager)).some((row) => row.code === 'TYPED')).toBe(false);
  });

  it('refuses a blank name', async () => {
    await expect(make(manager, '   ')).rejects.toThrow(/needs a name/i);
  });

  it('refuses somebody without the verb', async () => {
    // The officer may look at the list and may not add to it.
    await expect(make(officer, 'East Warehouse')).rejects.toThrow();
    expect(await listed(officer)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('ops 7 · changing one afterwards', () => {
  it('renames it without touching its code', async () => {
    const { code } = await make(manager, 'East Warehouse');
    await withScope(scope(manager), (tx) => warehouses.rename(tx, manager, code, 'Eastern Depot'));

    const [row] = (await listed(manager)).filter((r) => r.code === code);
    expect(row!.name).toBe('Eastern Depot');
  });

  it('closes one without deleting it', async () => {
    const { code } = await make(manager, 'East Warehouse');
    // Closing costs a reason — "why" is the question somebody asks a year
    // later, and the service has required it since the warehouses kept their
    // history.
    await withScope(scope(manager), (tx) =>
      warehouses.setActive(tx, manager, code, false, 'The depot lease ended.'),
    );

    // Gone from the pickers, still in the record — the movements that put stock
    // there point at this row, and where the stock was is part of the history.
    const picker = await withScope(scope(manager), (tx) => warehouses.listActive(tx));
    expect(picker.some((row) => row.code === code)).toBe(false);

    const rows = await listed(manager);
    expect(rows.find((row) => row.code === code)).toMatchObject({ active: false });
  });

  it('reopens one that was closed', async () => {
    const { code } = await make(manager, 'East Warehouse');
    await withScope(scope(manager), (tx) =>
      warehouses.setActive(tx, manager, code, false, 'Closed for stocktaking.'),
    );
    await withScope(scope(manager), (tx) => warehouses.setActive(tx, manager, code, true));

    const picker = await withScope(scope(manager), (tx) => warehouses.listActive(tx));
    expect(picker.some((row) => row.code === code)).toBe(true);
  });

  it('refuses to rename one that does not exist', async () => {
    await expect(
      withScope(scope(manager), (tx) => warehouses.rename(tx, manager, 'WH-NOPE', 'Ghost')),
    ).rejects.toThrow(/No warehouse with code/i);
  });

  it('offers only ordinary warehouses to a picker', async () => {
    const { code } = await make(manager, 'East Warehouse');
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
    expect(picker.some((row) => row.code === code)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ops 7 · the warehouses block 8 needs', () => {
  const ensure = (ctx: ActorContext) =>
    withScope(scope(ctx), (tx) => warehouses.ensureStageWarehouses(tx, ctx));

  it('makes one warehouse for each shipment stage', async () => {
    const made = await ensure(manager);

    expect(made.map((entry) => entry.stage)).toEqual(['in_process', 'on_board', 'on_port']);
    expect(made.map((entry) => entry.name)).toEqual(['In Process', 'On Board', 'On Port']);
    expect(made.every((entry) => entry.created)).toBe(true);
    // Minted like any other warehouse's — Critical Rule 1 has no exception for
    // a warehouse the system asks for rather than a person.
    expect(made.every((entry) => /^WH-\d{4}$/.test(entry.code))).toBe(true);
  });

  it('makes them transit, and keeps them out of the pickers stock is put away from (REQ-AP-001 §17.4)', async () => {
    const made = await ensure(manager);
    const inProcess = made.find((entry) => entry.stage === 'in_process')!;

    // Since REQ-AP-001 Stage 5 (0234) goods at sea are owned, not available:
    // a stage warehouse is a transit warehouse. Nobody books into it by hand —
    // an import invoice puts its stock lines there itself, and the container
    // receipt takes them out — so the everyday picker leaves it out, while the
    // stock reports still show it.
    const picker = await withScope(scope(manager), (tx) => warehouses.listActive(tx));
    expect(picker.some((row) => row.code === inProcess.code)).toBe(false);
    const reports = await withScope(scope(manager), (tx) => warehouses.listForReports(tx));
    expect(reports.find((row) => row.code === inProcess.code)?.warehouseType).toBe('transit');
  });

  it('creates nothing the second time, so it can be run on a live database', async () => {
    const first = await ensure(manager);
    const again = await ensure(manager);

    expect(again.every((entry) => entry.created)).toBe(false);
    expect(again.map((entry) => entry.code)).toEqual(first.map((entry) => entry.code));

    const stages = await withScope(scope(manager), (tx) => warehouses.stageWarehouses(tx));
    expect(stages).toHaveLength(3);
  });

  it('keeps a stage a company renamed its own way', async () => {
    const [inProcess] = await ensure(manager);
    await withScope(scope(manager), (tx) =>
      warehouses.rename(tx, manager, inProcess!.code, 'Customs Clearance'),
    );

    // Idempotent on the stage, not on the name: a second run must not decide
    // the renamed warehouse is a different one and make a second In Process.
    const again = await ensure(manager);
    expect(again[0]).toMatchObject({ code: inProcess!.code, name: 'Customs Clearance', created: false });
    expect(await withScope(scope(manager), (tx) => warehouses.stageWarehouses(tx))).toHaveLength(3);
  });

  it('refuses somebody who may not create a warehouse', async () => {
    await expect(ensure(officer)).rejects.toThrow();
  });
});
