/**
 * Branches — Phase 0 requirement 2.
 *
 * "Branches can be created, edited and deactivated." Created is the hard one:
 * §4.1 says a branch, its default warehouse and its default cash account come
 * into existence together, and the database holds that line with a deferred
 * constraint that fires at COMMIT. So `create` writes four rows — the branch,
 * a main warehouse, a GL cash account under Assets, and the cash account
 * itself — in the caller's one transaction. A branch is never deleted; it is
 * deactivated, and the `organisation_reject_delete` trigger would refuse the
 * alternative anyway.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, bankCashAccount, branch, chartOfAccount, warehouse } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  codeFromName,
  normaliseCode,
  uniqueCode,
  optionalText,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import { allocateDocumentNumber } from './numbering';

export const PERMISSION_OBJECT = 'branch';

export interface BranchInput {
  readonly name: string;
  readonly address?: string | null;
  readonly managerUserId?: string | null;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: branch.code,
      name: branch.name,
      active: branch.active,
      address: branch.address,
      managerUserId: branch.managerUserId,
      managerName: appUser.displayName,
      defaultWarehouseCode: branch.defaultWarehouseCode,
      createdAt: branch.createdAt,
    })
    .from(branch)
    .leftJoin(appUser, eq(appUser.id, branch.managerUserId))
    .orderBy(asc(branch.code));
}

/** The record page's view: the row plus the codes of its defaults. */
export async function detail(tx: Tx, code: string) {
  const row = await get(tx, code);
  const [cash] = row.defaultCashAccountId
    ? await tx
        .select({ code: bankCashAccount.code, name: bankCashAccount.name })
        .from(bankCashAccount)
        .where(eq(bankCashAccount.id, row.defaultCashAccountId))
        .limit(1)
    : [];
  return { ...row, defaultCashAccount: cash ? `${cash.code} · ${cash.name}` : null };
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(branch).where(eq(branch.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('branch', code);
  return row;
}

async function assertManager(tx: Tx, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [user] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId));
  if (!user) throw new AdminValidationError('managerUserId', 'is not a known user');
  return user.id;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: BranchInput & { readonly code?: string },
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);

  const name = requireText(input.name, 'name');
  // The code follows the name unless one was typed: BAGHDAD OFFICE → BAGHDAD_OFFICE.
  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(name), async (candidate) => {
        const [row] = await tx.select({ code: branch.code }).from(branch).where(eq(branch.code, candidate));
        return Boolean(row);
      });
  const managerUserId = await assertManager(tx, input.managerUserId ?? null);

  const [existing] = await tx.select({ code: branch.code }).from(branch).where(eq(branch.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already a branch`);

  await tx.insert(branch).values({
    code,
    name,
    address: optionalText(input.address),
    managerUserId,
    active: true,
  });

  // §4.1 — the three defaults, in this transaction.
  const warehouseCode = `WH-${code}`;
  await tx.insert(warehouse).values({
    code: warehouseCode,
    name: `${name} Main Warehouse`,
    branchCode: code,
    warehouseType: 'main',
  });

  const [assetRoot] = await tx
    .select({ id: chartOfAccount.id })
    .from(chartOfAccount)
    .where(and(eq(chartOfAccount.accountType, 'asset'), isNull(chartOfAccount.parentId)))
    .limit(1);
  if (!assetRoot) throw new AdminValidationError('chart', 'the Assets root account is missing');

  const { documentNo: glCode } = await allocateDocumentNumber(
    tx,
    'ACCOUNT_CODE_ASSET',
    {},
    ctx.principal.userId,
  );
  const [glAccount] = await tx
    .insert(chartOfAccount)
    .values({
      code: glCode,
      name: `${name} Cash`,
      accountType: 'asset',
      parentId: assetRoot.id,
      isGroup: false,
      isActive: true,
      approvalStatus: 'approved',
      level: 1,
      currencyRestriction: 'IQD',
      createdBy: ctx.principal.userId,
    })
    .returning({ id: chartOfAccount.id });

  const [cash] = await tx
    .insert(bankCashAccount)
    .values({
      code: `CASH-${code}`,
      name: `${name} Cash Account`,
      accountType: 'cash',
      // A cash account must have a custodian; the branch manager if named,
      // otherwise the administrator who opened the branch, until changed.
      custodianUserId: managerUserId ?? ctx.principal.userId,
      glAccountId: glAccount!.id,
    })
    .returning({ id: bankCashAccount.id });

  await tx
    .update(branch)
    .set({ defaultWarehouseCode: warehouseCode, defaultCashAccountId: cash!.id })
    .where(eq(branch.code, code));

  await recordChange(tx, ctx, {
    action: 'branch.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: { code, name, managerUserId, defaultWarehouseCode: warehouseCode, glCode },
  });

  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: BranchInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const values = {
    name: requireText(input.name, 'name'),
    address: optionalText(input.address),
    managerUserId: await assertManager(tx, input.managerUserId ?? null),
  };
  await tx.update(branch).set(values).where(eq(branch.code, code));
  await recordChange(tx, ctx, {
    action: 'branch.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name, address: before.address, managerUserId: before.managerUserId },
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
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate a branch');
  }
  await tx.update(branch).set({ active }).where(eq(branch.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'branch.reactivated' : 'branch.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}
