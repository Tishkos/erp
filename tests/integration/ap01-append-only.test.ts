/**
 * REQ-AP-001 A3 — the record of what happened cannot be rewritten.
 *
 * UPDATE and DELETE on the status log and the hold thread raise — for the
 * owner as much as for the application, because the trigger is the control —
 * and the application role holds no DELETE on the payable itself: an import
 * ends cleared or cancelled-with-reason, never gone (R3).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData } from './setup';
import { withScope } from '@/server/db/client';
import { sql } from 'drizzle-orm';
import * as holds from '@/server/services/payable-holds';
import * as payables from '@/server/services/payables';
import {
  IMPORT_INPUT,
  buildPayablesWorld,
  scope,
  type PayablesWorld,
} from './payables-fixture';

let world: PayablesWorld;
let payableId: string;

beforeEach(async () => {
  await resetTestData();
  world = await buildPayablesWorld();
  const created = await withScope(scope(world.manager), (tx) =>
    payables.create(tx, world.manager, IMPORT_INPUT(world)),
  );
  payableId = created.id;
});

describe('ap01 · append, never overwrite', () => {
  it('the status log rejects UPDATE and DELETE, even from the owner', async () => {
    const update = await ownerPool
      .query(`update payable_event set summary = 'rewritten' where payable_id = $1`, [payableId])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(update).toMatch(/append-only/);

    const remove = await ownerPool
      .query(`delete from payable_event where payable_id = $1`, [payableId])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(remove).toMatch(/append-only/);
  });

  it('the hold thread rejects UPDATE and DELETE', async () => {
    await withScope(scope(world.manager), (tx) =>
      holds.open(tx, world.manager, {
        payableId,
        laneCode: 'payment',
        reasonCode: 'BANK',
        ownerUserId: world.manager.principal.userId,
        nextAction: 'Call the trade desk',
        nextActionDue: '2026-10-10',
      }),
    );

    const update = await ownerPool
      .query(`update payable_hold_update set note = 'rewritten' where payable_id = $1`, [
        payableId,
      ])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(update).toMatch(/append-only/);

    const remove = await ownerPool
      .query(`delete from payable_hold_update where payable_id = $1`, [payableId])
      .then(() => 'allowed')
      .catch((error: Error) => error.message);
    expect(remove).toMatch(/append-only/);
  });

  it('the application role cannot DELETE a payable, a hold, or an event', async () => {
    for (const table of ['payable', 'payable_hold', 'payable_event'] as const) {
      const message = await rejection(
        withScope(scope(world.manager), (tx) =>
          tx.execute(sql.raw(`delete from ${table}`)),
        ),
      );
      expect(message, table).toMatch(/permission denied/i);
    }
  });

  it('a correction is a new row that points at the one it corrects', async () => {
    const { rows } = await ownerPool.query(
      `select id from payable_event where payable_id = $1 limit 1`,
      [payableId],
    );
    const original = rows[0].id as string;

    const events = await import('@/server/services/payable-events');
    await withScope(scope(world.manager), (tx) =>
      events.record(tx, {
        payableId,
        eventCode: 'CORRECTION',
        summary: 'The PI date was typed as September; the paper says August.',
        correctionOfId: original,
        actorUserId: world.manager.principal.userId,
      }),
    );

    const { rows: corrections } = await ownerPool.query(
      `select correction_of_id from payable_event
        where payable_id = $1 and event_code = 'CORRECTION'`,
      [payableId],
    );
    expect(corrections[0].correction_of_id).toBe(original);
  });
});
