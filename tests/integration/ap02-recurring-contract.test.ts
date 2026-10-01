/**
 * REQ-AP-001 A8 — the rent is in the system.
 *
 * A monthly contract generates one payable per period, `generate_days_ahead`
 * early, idempotently — the partial unique on (contract, period_start) is the
 * guarantee, and running the generator twice proves it. Auto-confirm (D8)
 * opens the period at stage 2; a period unpaid past its due date gets the
 * same automatic hold a late SWIFT gets; an amendment changes future periods
 * only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as contracts from '@/server/services/recurring-contracts';
import * as sweep from '@/server/services/payables-sweep';
import {
  BRANCH,
  buildPayablesWorld,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;

const superScope = () => ({
  userId: world.manager.principal.userId,
  branchCode: BRANCH,
  isSuperUser: true,
});

const LEASE = (world: PayablesWorld) =>
  ({
    supplierId: world.supplierId,
    departmentCode: 'FIN',
    branchCode: BRANCH,
    expenseCategoryCode: 'rent',
    description: 'Erbil office lease, 3rd floor',
    currency: 'USD',
    amountPerPeriodTxn: '2500.0000',
    frequency: 'monthly',
    startDate: '2026-09-01',
    dueRule: 'day_of_period:1',
    generateDaysAhead: 30,
    autoConfirm: true,
    invoiceExpected: false,
  }) as const;

async function activeLease() {
  const created = await withScope(scope(world.officer), (tx) =>
    contracts.create(tx, world.officer, LEASE(world)),
  );
  await withScope(scope(world.manager), (tx) =>
    contracts.approve(tx, world.manager, created.id),
  );
  return created;
}

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
});

describe('ap02 · a monthly contract pays itself into the workbench', () => {
  it('generates one payable per period, thirty days ahead, idempotently', async () => {
    const lease = await activeLease();

    // §10.2 — a period is created generate_days_ahead before it starts.
    // 1 October sees September (already running) and October; November's
    // generation day is 2 October, thirty days before 1 November.
    const first = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2026-10-01', null),
    );
    expect(first.periodsCreated).toBe(2);

    const second = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2026-10-02', null),
    );
    expect(second.periodsCreated).toBe(1);

    const again = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2026-10-02', null),
    );
    expect(again.periodsCreated).toBe(0);

    const { rows } = await ownerPool.query(
      `select period_start::text as start, due_date::text as due, stage_code, description
         from payable where recurring_contract_id = $1 order by period_start`,
      [lease.id],
    );
    expect(rows.map((row) => row.start)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    expect(rows[0].due).toBe('2026-09-01');
    expect(rows[0].description).toMatch(/lease.*2026-09/);
    // D8 — the lease is its own evidence: every period opens Confirmed.
    expect(new Set(rows.map((row) => row.stage_code))).toEqual(new Set(['confirmed']));
  });

  it('maker-checker: whoever raised the contract cannot activate it', async () => {
    // The manager holds the approve permission — the refusal is §5.2, not authz.
    const created = await withScope(scope(world.manager), (tx) =>
      contracts.create(tx, world.manager, LEASE(world)),
    );
    const refusal = await rejection(
      withScope(scope(world.manager), (tx) => contracts.approve(tx, world.manager, created.id)),
    );
    expect(refusal).toMatch(/cannot approve/);
  });

  it('an unpaid period past its due date is stopped like a late SWIFT', async () => {
    await activeLease();
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-10-01', null));

    const run = await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-02'));
    // September (due 1 Sep) and October (due 1 Oct) are both past due on the
    // 2nd; November is not.
    expect(run.opened).toBe(2);

    const { rows } = await ownerPool.query(`
      select h.check_code, h.reason_code, p.period_start::text as start
        from payable_hold h join payable p on p.id = h.payable_id
       order by p.period_start`);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.check_code))).toEqual(new Set(['recurring_overdue']));
    expect(rows.map((row) => row.start)).toEqual(['2026-09-01', '2026-10-01']);
  });

  it('an amendment is a dated row that reaches future periods only', async () => {
    const lease = await activeLease();
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-10-01', null));

    // The landlord raises the rent from December.
    await withScope(scope(world.manager), (tx) =>
      contracts.amend(tx, world.manager, {
        contractId: lease.id,
        effectiveFrom: '2026-12-01',
        amountPerPeriodTxn: '2750.0000',
        note: 'Annual escalation per clause 4.2',
      }),
    );

    // Generated periods stand at the old rent…
    const { rows: before } = await ownerPool.query(
      `select distinct amount_txn::numeric::text as amount from payable
        where recurring_contract_id = $1`,
      [lease.id],
    );
    expect(before.map((row) => row.amount)).toEqual(['2500.0000']);

    // …and December arrives at the new one.
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-11-15', null));
    const { rows: after } = await ownerPool.query(
      `select period_start::text as start, amount_txn::numeric::text as amount
         from payable where recurring_contract_id = $1 order by period_start`,
      [lease.id],
    );
    expect(after.at(-1)).toEqual({ start: '2026-12-01', amount: '2750.0000' });
    expect(after[0]!.amount).toBe('2500.0000');

    // The amendment row itself cannot be rewritten (R3).
    const update = await ownerPool
      .query(`update recurring_contract_amendment set note = 'rewritten'`)
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(update).toMatch(/append-only/);
  });

  it('ending the contract stops generation; generated periods stand (§10.3)', async () => {
    const lease = await activeLease();
    await withScope(superScope(), (tx) => contracts.generateDue(tx, '2026-10-01', null));

    await withScope(scope(world.manager), (tx) =>
      contracts.end(tx, world.manager, {
        contractId: lease.id,
        endDate: '2026-11-30',
        reason: 'Moving to the new building',
      }),
    );

    const more = await withScope(superScope(), (tx) =>
      contracts.generateDue(tx, '2027-03-01', null),
    );
    expect(more.periodsCreated).toBe(0);

    // September and October were generated before the end; November never
    // was, and §10.3 keeps what exists and raises nothing new.
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from payable where recurring_contract_id = $1`,
      [lease.id],
    );
    expect(rows[0].n).toBe(2);
  });
});
