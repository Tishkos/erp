/**
 * REQ-AP-001 A6 — a changed time limit applies on the next sweep, without a
 * deployment, and the old row keeps its validity. R4 as a test.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as payables from '@/server/services/payables';
import * as settings from '@/server/services/payables-settings';
import * as sweep from '@/server/services/payables-sweep';
import {
  BRANCH,
  buildPayablesWorld,
  scope,
  type PayablesWorld,
} from './payables-fixture';

const TODAY = '2026-10-01';

let world: PayablesWorld;
let payableId: string;

const superScope = () => ({
  userId: world.manager.principal.userId,
  branchCode: BRANCH,
  isSuperUser: true,
});

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();

  // Unconfirmed for 16 days — over the seeded 10, under a loosened 30.
  const created = await withScope(scope(world.manager), (tx) =>
    payables.create(tx, world.manager, {
      payableTypeCode: 'service',
      supplierReference: 'LIMITS-1',
      supplierId: world.supplierId,
      branchCode: BRANCH,
      departmentCode: 'FIN',
      currency: 'USD',
      documentDate: '2026-09-15',
      description: 'Limit fixture',
      amountTxn: '100',
    }),
  );
  payableId = created.id;
  await ownerPool.query(
    `update payable set stage_since = '2026-09-15T08:00:00Z' where id = $1`,
    [payableId],
  );
});

describe('ap01 · the limits are settings, and settings are live', () => {
  it('a loosened limit quiets the next sweep; tightening it back wakes it — no deployment', async () => {
    // Loosen: a type-scoped 30 outranks the seeded all-scope 10.
    await withScope(scope(world.manager), (tx) =>
      settings.setTimeLimit(tx, world.manager, {
        checkCode: 'service_unconfirmed',
        scope: 'type:service',
        limitDays: 30,
        validFrom: '2026-01-01',
      }),
    );

    const quiet = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    expect(quiet.opened).toBe(0);

    // Tighten the same scope: a NEW dated row; the 30 closes but stays.
    await withScope(scope(world.manager), (tx) =>
      settings.setTimeLimit(tx, world.manager, {
        checkCode: 'service_unconfirmed',
        scope: 'type:service',
        limitDays: 5,
        validFrom: '2026-01-02',
      }),
    );

    const loud = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    expect(loud.opened).toBe(1);

    // The history is whole: all-scope seed, the closed 30, the live 5.
    const { rows } = await ownerPool.query(
      `select scope, limit_days, active from stage_time_limit
        where check_code = 'service_unconfirmed'
        order by created_at`,
    );
    expect(rows).toEqual([
      { scope: 'all', limit_days: 10, active: true },
      { scope: 'type:service', limit_days: 30, active: false },
      { scope: 'type:service', limit_days: 5, active: true },
    ]);
  });

  it('only the configure grant may set a limit, and the change is audited', async () => {
    const refusal = await rejection(
      withScope(scope(world.officer), (tx) =>
        settings.setTimeLimit(tx, world.officer, {
          checkCode: 'service_unconfirmed',
          scope: 'all',
          limitDays: 99,
          validFrom: '2026-01-01',
        }),
      ),
    );
    expect(refusal).toMatch(/Permission denied/);

    await withScope(scope(world.manager), (tx) =>
      settings.setTimeLimit(tx, world.manager, {
        checkCode: 'service_unconfirmed',
        scope: 'all',
        limitDays: 12,
        validFrom: '2026-01-02',
      }),
    );

    const { rows } = await ownerPool.query(
      `select count(*)::int as n from audit_event
        where action = 'payables_settings.time_limit_set'`,
    );
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('a deactivated check runs nothing, and reactivates without a deployment', async () => {
    await ownerPool.query(
      `update sweep_check set active = false where code = 'service_unconfirmed'`,
    );
    const quiet = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    expect(quiet.opened).toBe(0);

    await ownerPool.query(
      `update sweep_check set active = true where code = 'service_unconfirmed'`,
    );
    const loud = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    expect(loud.opened).toBe(1);
  });

  it('the seeded later-stage checks sit inert, named, until their build lands', async () => {
    const run = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    // Stage 3 (0232) implemented the payment clocks and Stage 4 (0233) the
    // PD clocks; the container clocks wait for Stage 5.
    expect(run.skipped).not.toContain('swift_pending');
    expect(run.skipped).not.toContain('invoice_unfunded');
    expect(run.skipped).not.toContain('pd_not_validated');
    expect(run.skipped).not.toContain('pd_expired');
    expect(run.skipped).toContain('container_eta_passed');
  });
});
