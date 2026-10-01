/**
 * Holds — REQ-AP-001 §19. "Where is it stopped, and why?"
 *
 * A hold is a record with an owner, not a flag: reason code, who is following
 * up, since when, what happens next and by when. The thread
 * (`payable_hold_update`) is append-only — the hold's current values are a
 * projection of it, shown whole like the AR collection activity is.
 *
 * Two doors in: the stop/follow-up dialog (anyone who may edit the payable),
 * and the sweep (§19.3), which opens a `PENDING_REASON` hold with no owner —
 * the state the workbench sorts to the top and the lane guard enforces until
 * somebody answers for it (D2 names who, by default).
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { holdReasonCode, payable, payableHold, payableHoldUpdate } from '../db/schema';
import { PENDING_REASON, assertHoldComplete } from '../domain/payables';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import * as events from './payable-events';
import * as notifications from './notifications';
import * as payables from './payables';

export class HoldNotFoundError extends Error {
  readonly code = 'HOLD_NOT_FOUND';
  constructor(id: string) {
    super(`No hold '${id}', or it is outside the branches you may see.`);
    this.name = 'HoldNotFoundError';
  }
}

export class HoldStateError extends Error {
  readonly code = 'HOLD_STATE';
  constructor(detail: string) {
    super(detail);
    this.name = 'HoldStateError';
  }
}

async function loadHold(tx: Tx, id: string) {
  const [row] = await tx.select().from(payableHold).where(eq(payableHold.id, id)).limit(1);
  if (!row) throw new HoldNotFoundError(id);
  return row;
}

async function reason(tx: Tx, code: string) {
  const [row] = await tx
    .select()
    .from(holdReasonCode)
    .where(eq(holdReasonCode.code, code))
    .limit(1);
  if (!row || !row.active) {
    throw new HoldStateError(`'${code}' is not an active stop reason. Pick one from the list.`);
  }
  return row;
}

/** `on_hold` on the payable is a projection of its open holds (§19.2). */
async function refreshOnHold(tx: Tx, payableId: string): Promise<void> {
  const [open] = await tx
    .select({ id: payableHold.id })
    .from(payableHold)
    .where(and(eq(payableHold.payableId, payableId), eq(payableHold.status, 'open')))
    .limit(1);
  await tx
    .update(payable)
    .set({ onHold: Boolean(open), updatedAt: new Date() })
    .where(eq(payable.id, payableId));
}

async function thread(
  tx: Tx,
  input: {
    holdId: string;
    payableId: string;
    kind: 'opened' | 'completed' | 'updated' | 'reassigned' | 'resolved' | 'escalated';
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    note?: string | null;
    changedBy: string | null;
  },
): Promise<void> {
  await tx.insert(payableHoldUpdate).values({
    holdId: input.holdId,
    payableId: input.payableId,
    kind: input.kind,
    before: input.before ?? null,
    after: input.after ?? null,
    note: input.note ?? null,
    changedBy: input.changedBy,
  });
}

// ---------------------------------------------------------------------------
// Opening — by hand (§19.1 second bullet)
// ---------------------------------------------------------------------------

export interface OpenHoldInput {
  readonly payableId: string;
  readonly laneCode: string;
  readonly reasonCode: string;
  readonly detail?: string | null;
  readonly ownerUserId: string;
  /** Today, or an earlier date the stop actually began. */
  readonly startedAt?: Date;
  readonly nextAction: string;
  readonly nextActionDue: string;
  readonly sourceType?: string | null;
  readonly sourceId?: string | null;
}

export async function open(
  tx: Tx,
  ctx: ActorContext,
  input: OpenHoldInput,
): Promise<{ id: string }> {
  const parent = await payables.load(tx, input.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', payables.PERMISSION_OBJECT, {
    branchCode: parent.branchCode,
    objectId: parent.id,
  });

  const code = await reason(tx, input.reasonCode);
  assertHoldComplete({
    reasonCode: code.code,
    reasonRequiresDetail: code.requiresDetail,
    detail: input.detail,
    ownerUserId: input.ownerUserId,
    nextAction: input.nextAction,
    nextActionDue: input.nextActionDue,
  });

  const startedAt = input.startedAt ?? new Date();
  const [created] = await tx
    .insert(payableHold)
    .values({
      payableId: parent.id,
      laneCode: input.laneCode,
      stageCode: parent.stageCode,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reasonCode: code.code,
      detail: input.detail?.trim() || null,
      ownerUserId: input.ownerUserId,
      startedAt,
      nextAction: input.nextAction.trim(),
      nextActionDue: input.nextActionDue,
      createdBy: ctx.principal.userId,
    })
    .returning({ id: payableHold.id });

  const holdId = created!.id;

  await thread(tx, {
    holdId,
    payableId: parent.id,
    kind: 'opened',
    after: {
      lane: input.laneCode,
      reason: code.code,
      owner: input.ownerUserId,
      nextAction: input.nextAction.trim(),
      nextActionDue: input.nextActionDue,
    },
    note: input.detail?.trim() || null,
    changedBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'HOLD_OPENED',
    summary: `STOPPED: ${code.code} — ${code.name}${input.detail?.trim() ? ` · ${input.detail.trim()}` : ''}`,
    holdId,
    actorUserId: ctx.principal.userId,
  });

  await refreshOnHold(tx, parent.id);

  await notifications.raise(
    tx,
    {
      eventType: 'payable.hold.opened',
      objectType: 'payable',
      objectId: parent.id,
      occurrence: new Date().toISOString().slice(0, 10),
    },
    { payableNo: parent.payableNo, reason: code.name, lane: input.laneCode },
    { branchCode: parent.branchCode, actorUserId: ctx.principal.userId },
  );

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.hold_opened',
    objectType: payables.PERMISSION_OBJECT,
    objectId: parent.id,
    branchCode: parent.branchCode,
    after: { holdId, reason: code.code, lane: input.laneCode },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return { id: holdId };
}

// ---------------------------------------------------------------------------
// Opening — by the sweep (§19.3). Internal; no principal, no permission.
// ---------------------------------------------------------------------------

export async function openAutomatic(
  tx: Tx,
  input: {
    payableId: string;
    laneCode: string;
    checkCode: string;
    /** The day the limit was passed — the stop began then, not when noticed. */
    startedAt: Date;
    summary: string;
    sourceType?: string | null;
    sourceId?: string | null;
  },
): Promise<{ id: string } | null> {
  // One open hold per (payable, check) — the partial unique index backs this;
  // the pre-check keeps the sweep quiet rather than relying on the error.
  const [already] = await tx
    .select({ id: payableHold.id })
    .from(payableHold)
    .where(
      and(
        eq(payableHold.payableId, input.payableId),
        eq(payableHold.checkCode, input.checkCode),
        eq(payableHold.status, 'open'),
      ),
    )
    .limit(1);
  if (already) return null;

  const parent = await payables.load(tx, input.payableId);

  const [created] = await tx
    .insert(payableHold)
    .values({
      payableId: parent.id,
      laneCode: input.laneCode,
      stageCode: parent.stageCode,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      reasonCode: PENDING_REASON,
      startedAt: input.startedAt,
      checkCode: input.checkCode,
      createdBy: null,
    })
    .returning({ id: payableHold.id });

  const holdId = created!.id;

  await thread(tx, {
    holdId,
    payableId: parent.id,
    kind: 'opened',
    after: { lane: input.laneCode, reason: PENDING_REASON, check: input.checkCode },
    note: input.summary,
    changedBy: null,
  });

  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'OVER_LIMIT_DETECTED',
    summary: input.summary,
    holdId,
    actorUserId: null,
  });
  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'HOLD_OPENED',
    summary: `STOPPED — over time limit, reason required (${input.checkCode})`,
    holdId,
    actorUserId: null,
  });

  await refreshOnHold(tx, parent.id);

  await notifications.raise(
    tx,
    {
      eventType: 'payable.hold.opened',
      objectType: 'payable',
      objectId: parent.id,
      occurrence: new Date().toISOString().slice(0, 10),
    },
    { payableNo: parent.payableNo, reason: 'Over time limit — reason required', lane: input.laneCode },
    { branchCode: parent.branchCode },
  );

  return { id: holdId };
}

// ---------------------------------------------------------------------------
// Completing, updating, reassigning, resolving (§19.2)
// ---------------------------------------------------------------------------

async function authorizeOnHold(tx: Tx, ctx: ActorContext, holdId: string) {
  const hold = await loadHold(tx, holdId);
  const parent = await payables.load(tx, hold.payableId);
  await authz.authorize(ctx.principal, 'edit_draft', payables.PERMISSION_OBJECT, {
    branchCode: parent.branchCode,
    objectId: parent.id,
  });
  return { hold, parent };
}

/** §19.1 — answering a `PENDING_REASON` hold: reason, owner, next action. */
export async function complete(
  tx: Tx,
  ctx: ActorContext,
  input: {
    holdId: string;
    reasonCode: string;
    detail?: string | null;
    ownerUserId: string;
    nextAction: string;
    nextActionDue: string;
  },
): Promise<void> {
  const { hold, parent } = await authorizeOnHold(tx, ctx, input.holdId);
  if (hold.status !== 'open') throw new HoldStateError('This hold is already resolved.');
  if (hold.reasonCode !== PENDING_REASON) {
    throw new HoldStateError('This hold already has its reason — use Update instead.');
  }

  const code = await reason(tx, input.reasonCode);
  assertHoldComplete({
    reasonCode: code.code,
    reasonRequiresDetail: code.requiresDetail,
    detail: input.detail,
    ownerUserId: input.ownerUserId,
    nextAction: input.nextAction,
    nextActionDue: input.nextActionDue,
  });

  await tx
    .update(payableHold)
    .set({
      reasonCode: code.code,
      detail: input.detail?.trim() || null,
      ownerUserId: input.ownerUserId,
      nextAction: input.nextAction.trim(),
      nextActionDue: input.nextActionDue,
      updatedAt: new Date(),
    })
    .where(eq(payableHold.id, hold.id));

  await thread(tx, {
    holdId: hold.id,
    payableId: parent.id,
    kind: 'completed',
    before: { reason: PENDING_REASON },
    after: {
      reason: code.code,
      owner: input.ownerUserId,
      nextAction: input.nextAction.trim(),
      nextActionDue: input.nextActionDue,
    },
    note: input.detail?.trim() || null,
    changedBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'HOLD_COMPLETED',
    summary: `Stop reason: ${code.code} — ${code.name}${input.detail?.trim() ? ` · ${input.detail.trim()}` : ''}`,
    holdId: hold.id,
    actorUserId: ctx.principal.userId,
  });
}

/** A new thread entry — progress, a changed next action, anything learned. */
export async function update(
  tx: Tx,
  ctx: ActorContext,
  input: { holdId: string; note: string; nextAction?: string | null; nextActionDue?: string | null },
): Promise<void> {
  const { hold, parent } = await authorizeOnHold(tx, ctx, input.holdId);
  if (hold.status !== 'open') throw new HoldStateError('This hold is already resolved.');

  const note = input.note.trim();
  if (!note) throw new HoldStateError('An update with nothing in it is not an update.');

  if (input.nextAction || input.nextActionDue) {
    await tx
      .update(payableHold)
      .set({
        nextAction: input.nextAction?.trim() || hold.nextAction,
        nextActionDue: input.nextActionDue ?? hold.nextActionDue,
        updatedAt: new Date(),
      })
      .where(eq(payableHold.id, hold.id));
  }

  await thread(tx, {
    holdId: hold.id,
    payableId: parent.id,
    kind: 'updated',
    before: { nextAction: hold.nextAction, nextActionDue: hold.nextActionDue },
    after: {
      nextAction: input.nextAction?.trim() || hold.nextAction,
      nextActionDue: input.nextActionDue ?? hold.nextActionDue,
    },
    note,
    changedBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'HOLD_UPDATED',
    summary: note,
    holdId: hold.id,
    actorUserId: ctx.principal.userId,
  });
}

export async function reassign(
  tx: Tx,
  ctx: ActorContext,
  input: { holdId: string; ownerUserId: string },
): Promise<void> {
  const { hold, parent } = await authorizeOnHold(tx, ctx, input.holdId);
  if (hold.status !== 'open') throw new HoldStateError('This hold is already resolved.');

  await tx
    .update(payableHold)
    .set({ ownerUserId: input.ownerUserId, updatedAt: new Date() })
    .where(eq(payableHold.id, hold.id));

  await thread(tx, {
    holdId: hold.id,
    payableId: parent.id,
    kind: 'reassigned',
    before: { owner: hold.ownerUserId },
    after: { owner: input.ownerUserId },
    changedBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'HOLD_REASSIGNED',
    summary: 'Follow-up reassigned',
    holdId: hold.id,
    actorUserId: ctx.principal.userId,
  });
}

/** What happened — required. The hold stays, resolved, as part of the story. */
export async function resolve(
  tx: Tx,
  ctx: ActorContext,
  input: { holdId: string; resolution: string },
): Promise<void> {
  const { hold, parent } = await authorizeOnHold(tx, ctx, input.holdId);
  if (hold.status !== 'open') throw new HoldStateError('This hold is already resolved.');

  const resolution = input.resolution.trim();
  if (!resolution) {
    throw new HoldStateError('Say what happened — a resolution without words resolves nothing.');
  }

  await tx
    .update(payableHold)
    .set({
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: ctx.principal.userId,
      resolution,
      updatedAt: new Date(),
    })
    .where(eq(payableHold.id, hold.id));

  await thread(tx, {
    holdId: hold.id,
    payableId: parent.id,
    kind: 'resolved',
    after: { resolution },
    changedBy: ctx.principal.userId,
  });

  await events.record(tx, {
    payableId: parent.id,
    eventCode: 'HOLD_RESOLVED',
    summary: `Resolved: ${resolution}`,
    holdId: hold.id,
    actorUserId: ctx.principal.userId,
  });

  await refreshOnHold(tx, parent.id);

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'payable.hold_resolved',
    objectType: payables.PERMISSION_OBJECT,
    objectId: parent.id,
    branchCode: parent.branchCode,
    after: { holdId: hold.id, resolution },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** The thread, oldest first — shown whole on the dialog (§21.12). */
export async function threadFor(tx: Tx, holdId: string) {
  return tx
    .select()
    .from(payableHoldUpdate)
    .where(eq(payableHoldUpdate.holdId, holdId))
    .orderBy(asc(payableHoldUpdate.changedAt));
}
