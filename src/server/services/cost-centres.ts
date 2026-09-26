/**
 * Cost centres — Phase 2 requirement 1.
 *
 * *"Cost centres can be created, edited and deactivated so they can be
 *  selected later in accounting and operational transactions and used in
 *  reporting."*
 *
 * §2.1 makes them independent of departments, and the table follows that: a
 * cost centre is not a child of a department, because a cost centre that is
 * structurally a department cannot be reported on separately — which is the
 * one thing cost centres exist to do.
 *
 * A branch is optional. Some cost centres belong to one place (a branch's
 * vehicle fleet); others are company-wide (group marketing), and forcing those
 * into a branch would make every report about them wrong by exactly the amount
 * spent elsewhere.
 *
 * Deactivated, never deleted — the `organisation_reject_delete` trigger
 * refuses the alternative, and it is right to: a posted line carrying a cost
 * centre must stay explainable for as long as the line exists.
 */
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, branch, costCentre } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import { allocateFreeCode } from './numbering';

export const PERMISSION_OBJECT = 'cost_centre';

export interface CostCentreInput {
  readonly name: string;
  readonly ownerUserId?: string | null;
  readonly branchCode?: string | null;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: costCentre.code,
      name: costCentre.name,
      active: costCentre.active,
      ownerUserId: costCentre.ownerUserId,
      ownerName: appUser.displayName,
      branchCode: costCentre.branchCode,
      createdAt: costCentre.createdAt,
    })
    .from(costCentre)
    .leftJoin(appUser, eq(appUser.id, costCentre.ownerUserId))
    .orderBy(asc(costCentre.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(costCentre).where(eq(costCentre.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('cost centre', code);
  return row;
}

/** The record page's view: the row, with its owner and branch named. */
export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [owner] = row.ownerUserId
    ? await tx
        .select({ name: appUser.displayName, email: appUser.email })
        .from(appUser)
        .where(eq(appUser.id, row.ownerUserId))
        .limit(1)
    : [];
  const [place] = row.branchCode
    ? await tx.select({ name: branch.name }).from(branch).where(eq(branch.code, row.branchCode)).limit(1)
    : [];
  return {
    ...row,
    ownerName: owner?.name ?? null,
    ownerEmail: owner?.email ?? null,
    branchName: place?.name ?? null,
  };
}

async function assertOwner(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [user] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId));
  if (!user) throw new AdminValidationError('ownerUserId', 'is not a known user');
  return user.id;
}

async function assertBranch(tx: Tx, code: string | null): Promise<string | null> {
  if (!code) return null;
  const [row] = await tx.select({ code: branch.code }).from(branch).where(eq(branch.code, code));
  if (!row) throw new AdminValidationError('branchCode', 'is not a known branch');
  return row.code;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: CostCentreInput,
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  // Minted, never typed — Critical Rule 1 (migration 0208).
  const code = await allocateFreeCode(
    tx,
    'COST_CENTRE_CODE',
    async (candidate) => {
      const [row] = await tx.select({ code: costCentre.code }).from(costCentre).where(eq(costCentre.code, candidate));
      return Boolean(row);
    },
    ctx.principal.userId,
  );

  const values = {
    code,
    name,
    ownerUserId: await assertOwner(tx, input.ownerUserId ?? null),
    branchCode: await assertBranch(tx, input.branchCode ?? null),
    active: true,
  };
  await tx.insert(costCentre).values(values);

  await recordChange(tx, ctx, {
    action: 'cost_centre.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: values,
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: CostCentreInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const values = {
    name: requireText(input.name, 'name'),
    ownerUserId: await assertOwner(tx, input.ownerUserId ?? null),
    branchCode: await assertBranch(tx, input.branchCode ?? null),
  };
  await tx.update(costCentre).set(values).where(eq(costCentre.code, code));
  await recordChange(tx, ctx, {
    action: 'cost_centre.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name, ownerUserId: before.ownerUserId, branchCode: before.branchCode },
    after: values,
  });
  return get(tx, code);
}

export async function setActive(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  active: boolean,
  reason: string | null,
) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  if (before.active === active) return before;
  // The reason is the record of *why* a structure changed. Without it the audit
  // trail says a cost centre stopped being used and nothing about the decision.
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate a cost centre');
  }
  await tx.update(costCentre).set({ active }).where(eq(costCentre.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'cost_centre.reactivated' : 'cost_centre.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}

/** The cost centres a picker may offer — active only, code order. */
export async function listActive(tx: Tx) {
  return tx
    .select({ code: costCentre.code, name: costCentre.name })
    .from(costCentre)
    .where(eq(costCentre.active, true))
    .orderBy(asc(costCentre.code));
}
