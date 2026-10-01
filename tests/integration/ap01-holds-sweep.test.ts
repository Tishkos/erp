/**
 * REQ-AP-001 A5 — the sweep, the pending-reason hold, and its completion.
 *
 * Run twice on the same day, the sweep opens exactly one PENDING_REASON hold
 * per (payable, check) over its limit; completing it demands reason, owner
 * and next action; the lane is read-only until it is answered; the thread is
 * append-only and whole.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import * as holds from '@/server/services/payable-holds';
import * as payables from '@/server/services/payables';
import * as sweep from '@/server/services/payables-sweep';
import {
  BRANCH,
  buildPayablesWorld,
  eventsOf,
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

  // A service payable nobody has confirmed, sitting since 15 September —
  // 16 days against the seeded 10-day service_unconfirmed limit (D4).
  const created = await withScope(scope(world.manager), (tx) =>
    payables.create(tx, world.manager, {
      payableTypeCode: 'service',
      supplierReference: 'CLEAN-SEP',
      supplierId: world.supplierId,
      branchCode: BRANCH,
      departmentCode: 'FIN',
      currency: 'USD',
      documentDate: '2026-09-15',
      description: 'Office deep clean',
      amountTxn: '400',
    }),
  );
  payableId = created.id;
  await ownerPool.query(
    `update payable set stage_since = '2026-09-15T08:00:00Z' where id = $1`,
    [payableId],
  );
});

describe('ap01 · the sweep answers for every clock', () => {
  it('opens exactly one hold per condition, however many times it runs', async () => {
    const first = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    expect(first.opened).toBe(1);

    const second = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    expect(second.opened).toBe(0);

    const { rows } = await ownerPool.query(
      `select reason_code, check_code, owner_user_id, status,
              started_at::date::text as started
         from payable_hold where payable_id = $1`,
      [payableId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason_code).toBe('PENDING_REASON');
    expect(rows[0].check_code).toBe('service_unconfirmed');
    expect(rows[0].owner_user_id).toBeNull();
    // The stop began the day the limit was passed, not the day it was seen:
    // 15 Sep + 10 days + 1 = 26 Sep.
    expect(rows[0].started).toBe('2026-09-26');

    const story = await eventsOf(payableId);
    const overLimit = story.filter((event) => event.eventCode === 'OVER_LIMIT_DETECTED');
    expect(overLimit).toHaveLength(1);

    const { rows: flagged } = await ownerPool.query(
      `select on_hold from payable where id = $1`,
      [payableId],
    );
    expect(flagged[0].on_hold).toBe(true);
  });

  it('the lane is read-only until somebody answers; a manager override is logged', async () => {
    await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));

    const row = await withScope(scope(world.manager), (tx) => payables.load(tx, payableId));

    // The held lane refuses the officer…
    const refusal = await rejection(
      withScope(scope(world.officer), (tx) =>
        payables.assertLaneEditable(tx, world.officer, row, 'service'),
      ),
    );
    expect(refusal).toMatch(/reason/);

    // …and other lanes do not: the stop is where the problem is, not a freeze.
    await withScope(scope(world.officer), (tx) =>
      payables.assertLaneEditable(tx, world.officer, row, 'order'),
    );

    // A manager may pass with a stated reason, and the override is an event.
    await withScope(scope(world.manager), (tx) =>
      payables.assertLaneEditable(tx, world.manager, row, 'service', {
        reason: 'Supplier on site today; confirming by hand',
      }),
    );
    const story = await eventsOf(payableId);
    expect(story.map((event) => event.summary).join('\n')).toMatch(/override/);
  });

  it('completing demands the full answer, and the thread keeps every step', async () => {
    await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    const { rows } = await ownerPool.query(
      `select id from payable_hold where payable_id = $1`,
      [payableId],
    );
    const holdId = rows[0].id as string;

    // Without an owner it is not an answer.
    const refusal = await rejection(
      withScope(scope(world.officer), (tx) =>
        holds.complete(tx, world.officer, {
          holdId,
          reasonCode: 'SUP',
          ownerUserId: '',
          nextAction: 'Chase the supplier',
          nextActionDue: '2026-10-05',
        }),
      ),
    );
    expect(refusal).toMatch(/owns/);

    await withScope(scope(world.officer), (tx) =>
      holds.complete(tx, world.officer, {
        holdId,
        reasonCode: 'SUP',
        detail: 'Supplier has not sent the completion certificate',
        ownerUserId: world.officer.principal.userId,
        nextAction: 'Chase the certificate',
        nextActionDue: '2026-10-05',
      }),
    );

    // Answered: the lane opens again.
    const row = await withScope(scope(world.officer), (tx) => payables.load(tx, payableId));
    await withScope(scope(world.officer), (tx) =>
      payables.assertLaneEditable(tx, world.officer, row, 'service'),
    );

    await withScope(scope(world.officer), (tx) =>
      holds.update(tx, world.officer, { holdId, note: 'Certificate promised Thursday' }),
    );
    await withScope(scope(world.officer), (tx) =>
      holds.resolve(tx, world.officer, { holdId, resolution: 'Certificate received; confirmed.' }),
    );

    const { rows: thread } = await ownerPool.query(
      `select kind from payable_hold_update where hold_id = $1 order by changed_at, id`,
      [holdId],
    );
    expect(thread.map((entry) => entry.kind)).toEqual([
      'opened',
      'completed',
      'updated',
      'resolved',
    ]);

    const { rows: flagged } = await ownerPool.query(
      `select on_hold from payable where id = $1`,
      [payableId],
    );
    expect(flagged[0].on_hold).toBe(false);
  });

  it('a recurring payable past its due date gets the same treatment as a late SWIFT', async () => {
    const rent = await withScope(scope(world.manager), (tx) =>
      payables.create(tx, world.manager, {
        payableTypeCode: 'recurring',
        supplierReference: 'LEASE-SEP',
        supplierId: world.supplierId,
        branchCode: BRANCH,
        departmentCode: 'FIN',
        currency: 'USD',
        documentDate: '2026-09-01',
        description: 'Office lease — September 2026',
        amountTxn: '2500',
        dueDate: '2026-09-28',
      }),
    );

    const run = await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    // Two holds this run: the unconfirmed service from the fixture, the rent.
    expect(run.opened).toBe(2);

    const { rows } = await ownerPool.query(
      `select check_code, lane_code from payable_hold where payable_id = $1`,
      [rent.id],
    );
    expect(rows[0].check_code).toBe('recurring_overdue');
    expect(rows[0].lane_code).toBe('payment');
  });

  it('a hold nobody owns is escalated once, past the configured days', async () => {
    await withScope(superScope(), (tx) => sweep.runSweep(tx, TODAY));
    // Five days later, still unowned — past the seeded escalate_after of 3.
    const later = await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-06'));
    expect(later.escalated).toBe(1);

    const again = await withScope(superScope(), (tx) => sweep.runSweep(tx, '2026-10-07'));
    expect(again.escalated).toBe(0);

    const story = await eventsOf(payableId);
    expect(story.filter((event) => event.eventCode === 'ESCALATED')).toHaveLength(1);
  });
});
