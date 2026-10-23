/**
 * Imports paid after the goods arrive — the switch on an existing import
 * (0426, 2026-10-24, by direction: "a button where we skip … the current
 * import which pays later … in existing application"). The rules are
 * `domain/pay-after-arrival.ts`; an import opened from a purchase invoice
 * ticked "Pay after the goods arrive" is born with it (`payables.create`).
 *
 * Its own module because it reaches three others — the import, the advance
 * hold and the stops — and `payable-holds` already imports `payables`.
 *
 * Setting it ON:
 *   * moves whatever waits in On Process (Without SWIFT) for an advance on to
 *     In Process (`advance-hold.release`, said as a release without a payment);
 *   * resolves the import's open stops on the three payment clocks the flag
 *     stops (`PAYMENT_CLOCKS`), each with the reason given; a stop somebody
 *     opened by hand is theirs and stays;
 *   * leaves every payment application as it is — none is mandatory, and one
 *     may still be raised whenever somebody chooses.
 * Setting it OFF puts the import back on the ordinary road from that day: the
 * clocks run again at the next sweep. Goods already moved on are not held
 * again ("linked purchases cannot go back to steps", 2026-10-07).
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { payable, payableHold } from '../db/schema';
import { businessToday } from '../domain/business-date';
import { PayAfterArrivalError } from '../domain/pay-after-arrival';
import type { ActorContext } from './chart-of-accounts';
import * as advanceHold from './advance-hold';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as holds from './payable-holds';
import * as payables from './payables';

/** The sweep's payment clocks that do not run for an import paid after arrival until its goods are in. */
export const PAYMENT_CLOCKS = ['invoice_unfunded', 'swift_pending', 'transfer_pending'] as const;

export interface SetPayAfterArrivalInput {
  readonly payableId: string;
  readonly on: boolean;
  readonly reason: string;
}

export async function setPayAfterArrival(
  tx: Tx,
  ctx: ActorContext,
  input: SetPayAfterArrivalInput,
): Promise<{ readonly released: bigint; readonly holdsResolved: number }> {
  const row = await payables.lock(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', payables.PERMISSION_OBJECT, {
    branchCode: row.branchCode,
    objectId: row.id,
  });

  const reason = input.reason.trim();
  if (!reason) throw new PayAfterArrivalError('Say why — the reason stays on the import.');
  if (reason.length > 500) throw new PayAfterArrivalError('Keep the reason under 500 characters.');
  if (row.payableTypeCode !== 'import') {
    throw new PayAfterArrivalError(`${row.payableNo} is not an import; only an import is paid after its goods arrive.`);
  }
  if (row.cancelledAt) throw new PayAfterArrivalError(`${row.payableNo} is cancelled.`);
  if (row.closedAt) throw new PayAfterArrivalError(`${row.payableNo} is cleared; there is nothing left to pay later.`);
  if (row.payAfterArrival === input.on) {
    throw new PayAfterArrivalError(
      input.on
        ? `${row.payableNo} is already paid after the goods arrive.`
        : `${row.payableNo} is already paid before arrival.`,
    );
  }

  const now = new Date();
  await tx
    .update(payable)
    .set(
      input.on
        ? {
            payAfterArrival: true,
            payAfterArrivalSetBy: ctx.principal.userId,
            payAfterArrivalSetAt: now,
            payAfterArrivalReason: reason,
            updatedAt: now,
          }
        : {
            payAfterArrival: false,
            payAfterArrivalSetBy: null,
            payAfterArrivalSetAt: null,
            payAfterArrivalReason: null,
            updatedAt: now,
          },
    )
    .where(eq(payable.id, row.id));

  await events.record(tx, {
    payableId: row.id,
    eventCode: input.on ? 'PAY_AFTER_ARRIVAL_SET' : 'PAY_AFTER_ARRIVAL_CLEARED',
    summary: input.on ? `To be paid after the goods arrive — ${reason}` : `To be paid before arrival again — ${reason}`,
    before: { payAfterArrival: row.payAfterArrival, reason: row.payAfterArrivalReason },
    after: { payAfterArrival: input.on, reason },
    actorUserId: ctx.principal.userId,
  });

  let released = 0n;
  let holdsResolved = 0;
  if (input.on) {
    released = await advanceHold.release(tx, ctx, row.id, { reason, on: businessToday() });
    const stops = await tx
      .select({ id: payableHold.id })
      .from(payableHold)
      .where(
        and(
          eq(payableHold.payableId, row.id),
          eq(payableHold.status, 'open'),
          inArray(payableHold.checkCode, [...PAYMENT_CLOCKS]),
        ),
      );
    for (const stop of stops) {
      await holds.resolve(tx, ctx, { holdId: stop.id, resolution: `Paid after the goods arrive — ${reason}` });
      holdsResolved += 1;
    }
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: input.on ? 'payable.pay_after_arrival_set' : 'payable.pay_after_arrival_cleared',
    objectType: payables.PERMISSION_OBJECT,
    objectId: row.id,
    branchCode: row.branchCode,
    before: {
      payAfterArrival: row.payAfterArrival,
      setAt: row.payAfterArrivalSetAt ? row.payAfterArrivalSetAt.toISOString() : null,
      reason: row.payAfterArrivalReason,
    },
    after: {
      payAfterArrival: input.on,
      setAt: input.on ? now.toISOString() : null,
      reason,
      releasedQuantity: released.toString(),
      holdsResolved,
    },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { released, holdsResolved };
}
