/**
 * Departments — Phase 0 requirement 3.
 *
 * "Departments can be created and maintained, with a Department Manager
 * assigned where required." The manager is two facts kept in step: the
 * department's `manager_user_id`, and the `is_manager` flag on that person's
 * `user_department_scope` row — the flag is what the §5.2 approval routing
 * reads, so setting a manager here is what makes them able to finalise.
 */
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { appUser, department, userDepartmentScope } from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  codeFromName,
  normaliseCode,
  uniqueCode,
  permit,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'department';

export interface DepartmentInput {
  readonly name: string;
  readonly parentCode?: string | null;
  readonly isFinance?: boolean;
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      code: department.code,
      name: department.name,
      active: department.active,
      parentCode: department.parentCode,
      isFinance: department.isFinance,
      managerUserId: department.managerUserId,
      managerName: appUser.displayName,
      createdAt: department.createdAt,
    })
    .from(department)
    .leftJoin(appUser, eq(appUser.id, department.managerUserId))
    .orderBy(asc(department.code));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(department).where(eq(department.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('department', code);
  return row;
}

/** Everyone scoped to a department, with the manager flag. */
export async function members(tx: Tx, code: string) {
  return tx
    .select({
      userId: appUser.id,
      email: appUser.email,
      displayName: appUser.displayName,
      isActive: appUser.isActive,
      isManager: userDepartmentScope.isManager,
    })
    .from(userDepartmentScope)
    .innerJoin(appUser, eq(appUser.id, userDepartmentScope.userId))
    .where(eq(userDepartmentScope.departmentCode, code))
    .orderBy(asc(appUser.displayName));
}

async function parentOrNull(tx: Tx, parentCode: string | null | undefined, self?: string) {
  const code = parentCode?.trim() ? normaliseCode(parentCode, 'parentCode') : null;
  if (!code) return null;
  if (code === self) throw new AdminValidationError('parentCode', 'cannot be the department itself');
  const [parent] = await tx.select({ code: department.code }).from(department).where(eq(department.code, code));
  if (!parent) throw new AdminValidationError('parentCode', 'is not a known department');
  return code;
}

export async function create(
  tx: Tx,
  ctx: ActorContext,
  input: DepartmentInput & { readonly code?: string },
) {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const name = requireText(input.name, 'name');
  const code = input.code?.trim()
    ? normaliseCode(input.code)
    : await uniqueCode(codeFromName(name), async (candidate) => {
        const [row] = await tx.select({ code: department.code }).from(department).where(eq(department.code, candidate));
        return Boolean(row);
      });
  const [existing] = await tx.select({ code: department.code }).from(department).where(eq(department.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already a department`);

  const values = {
    code,
    name,
    parentCode: await parentOrNull(tx, input.parentCode),
    isFinance: input.isFinance ?? false,
    active: true,
  };
  await tx.insert(department).values(values);
  await recordChange(tx, ctx, {
    action: 'department.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: values,
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: DepartmentInput) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  const values = {
    name: requireText(input.name, 'name'),
    parentCode: await parentOrNull(tx, input.parentCode, code),
    isFinance: input.isFinance ?? before.isFinance,
  };
  await tx.update(department).set(values).where(eq(department.code, code));
  await recordChange(tx, ctx, {
    action: 'department.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name, parentCode: before.parentCode, isFinance: before.isFinance },
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
    throw new AdminValidationError('reason', 'is required to deactivate a department');
  }
  await tx.update(department).set({ active }).where(eq(department.code, code));
  await recordChange(tx, ctx, {
    action: active ? 'department.reactivated' : 'department.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { active: before.active },
    after: { active },
    reason: reason?.trim() || null,
  });
  return get(tx, code);
}

/**
 * Who may change a department's membership: an administrator who holds the
 * toggle, or the department's own manager (by direction, 2026-08-29 — a
 * manager runs their department, and that includes who is in it). The
 * manager's standing is read from the scope table, the same place §5.2's
 * approval routing reads it.
 */
async function permitMembership(tx: Tx, ctx: ActorContext, code: string): Promise<void> {
  if (await isManagerOf(tx, ctx.principal.userId, code)) return;
  await permit(ctx, 'configure', 'user_department_scope', code);
}

/** Is this person the manager of the department? For the screen that offers the controls. */
export async function isManagerOf(tx: Tx, userId: string, code: string): Promise<boolean> {
  const [scope] = await tx
    .select({ isManager: userDepartmentScope.isManager })
    .from(userDepartmentScope)
    .where(and(eq(userDepartmentScope.userId, userId), eq(userDepartmentScope.departmentCode, code)));
  return Boolean(scope?.isManager);
}

/**
 * Takes somebody out of a department.
 *
 * If they were its manager, the department is left without one and says so;
 * the person keeps their account and their other departments.
 */
export async function removeMember(tx: Tx, ctx: ActorContext, code: string, userId: string): Promise<void> {
  await permitMembership(tx, ctx, code);
  const dept = await get(tx, code);
  const [user] = await tx
    .select({ id: appUser.id, displayName: appUser.displayName })
    .from(appUser)
    .where(eq(appUser.id, userId));
  if (!user) throw new AdminValidationError('userId', 'is not a known user');

  await tx
    .delete(userDepartmentScope)
    .where(and(eq(userDepartmentScope.userId, userId), eq(userDepartmentScope.departmentCode, code)));
  if (dept.managerUserId === userId) {
    await tx.update(department).set({ managerUserId: null }).where(eq(department.code, code));
  }

  await recordChange(tx, ctx, {
    action: 'department.member_removed',
    objectType: 'user_department_scope',
    objectId: `${userId}:${code}`,
    before: { departmentCode: code, userId, displayName: user.displayName },
    after: null,
  });
}

/**
 * Makes — or unmakes — someone the Department Manager (§5.2).
 *
 * The person is scoped to the department if they were not already. Clearing
 * the flag leaves them a member. The department's own `manager_user_id`
 * follows: set to this person when made manager, cleared when they were it.
 */
export async function setManager(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  userId: string,
  isManager: boolean,
) {
  await permitMembership(tx, ctx, code);
  const dept = await get(tx, code);
  const [user] = await tx.select({ id: appUser.id, displayName: appUser.displayName }).from(appUser).where(eq(appUser.id, userId));
  if (!user) throw new AdminValidationError('userId', 'is not a known user');

  const [scope] = await tx
    .select({ isManager: userDepartmentScope.isManager })
    .from(userDepartmentScope)
    .where(and(eq(userDepartmentScope.userId, userId), eq(userDepartmentScope.departmentCode, code)));

  if (scope) {
    await tx
      .update(userDepartmentScope)
      .set({ isManager })
      .where(and(eq(userDepartmentScope.userId, userId), eq(userDepartmentScope.departmentCode, code)));
  } else {
    await tx.insert(userDepartmentScope).values({ userId, departmentCode: code, isManager });
  }

  if (isManager) {
    await tx.update(department).set({ managerUserId: userId }).where(eq(department.code, code));
  } else if (dept.managerUserId === userId) {
    await tx.update(department).set({ managerUserId: null }).where(eq(department.code, code));
  }

  await recordChange(tx, ctx, {
    action: isManager ? 'department.manager_assigned' : 'department.manager_removed',
    objectType: 'user_department_scope',
    objectId: `${userId}:${code}`,
    before: { isManager: scope?.isManager ?? null },
    after: { isManager, userId, departmentCode: code, displayName: user.displayName },
  });
}
