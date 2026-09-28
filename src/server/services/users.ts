/**
 * User Management — Phase 0 requirement 4.
 *
 * "Users can be created, activated or deactivated and assigned to their
 * authorised branches and departments. Each employee uses an individual
 * system account."
 *
 * A new account gets a temporary password the administrator hands over once;
 * `must_change_password` is set so it is replaced at first sign-in. Deactivating
 * an account revokes every live session at the same moment (§25 — revocation
 * is immediate), and an account is never deleted: its id is cited by the audit
 * trail and by everything it ever approved.
 */
import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import {
  appUser,
  authAccount,
  branch,
  department,
  role,
  userBranchScope,
  userDepartmentScope,
  userRole,
} from '../db/schema';
import {
  AdminNotFoundError,
  AdminValidationError,
  permit,
  permitCeo,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';
import {
  revokeAllSessionsFor,
  revokeSession,
  sessionsFor,
  setPassword,
  verifyCredentials,
} from './authentication';

export const PERMISSION_OBJECT = 'app_user';

export interface UserInput {
  readonly email: string;
  readonly displayName: string;
  readonly roleCodes?: readonly string[];
  readonly branchCodes?: readonly string[];
  readonly defaultBranchCode?: string | null;
  readonly departmentCodes?: readonly string[];
}

export async function listAll(tx: Tx) {
  return tx
    .select({
      id: appUser.id,
      email: appUser.email,
      displayName: appUser.displayName,
      isActive: appUser.isActive,
      isSuperUser: appUser.isSuperUser,
      mustChangePassword: appUser.mustChangePassword,
      image: appUser.image,
      createdAt: appUser.createdAt,
    })
    .from(appUser)
    .innerJoin(
      authAccount,
      and(eq(authAccount.userId, appUser.id), eq(authAccount.providerId, 'credential')),
    )
    .orderBy(asc(appUser.displayName));
}

export async function get(tx: Tx, id: string) {
  const [row] = await tx
    .select({ user: appUser })
    .from(appUser)
    .innerJoin(
      authAccount,
      and(eq(authAccount.userId, appUser.id), eq(authAccount.providerId, 'credential')),
    )
    .where(eq(appUser.id, id))
    .limit(1);
  if (!row) throw new AdminNotFoundError('account', id);
  return row.user;
}

/** Everything the Users record page shows: roles, scopes, sessions. */
export async function detail(tx: Tx, id: string) {
  const user = await get(tx, id);
  const roles = await tx
    .select({ code: userRole.roleCode, name: role.name })
    .from(userRole)
    .innerJoin(role, eq(role.code, userRole.roleCode))
    .where(eq(userRole.userId, id))
    .orderBy(asc(userRole.roleCode));
  const branches = await tx
    .select({ code: userBranchScope.branchCode, name: branch.name, isDefault: userBranchScope.isDefault })
    .from(userBranchScope)
    .innerJoin(branch, eq(branch.code, userBranchScope.branchCode))
    .where(eq(userBranchScope.userId, id))
    .orderBy(asc(userBranchScope.branchCode));
  const departments = await tx
    .select({
      code: userDepartmentScope.departmentCode,
      name: department.name,
      isManager: userDepartmentScope.isManager,
    })
    .from(userDepartmentScope)
    .innerJoin(department, eq(department.code, userDepartmentScope.departmentCode))
    .where(eq(userDepartmentScope.userId, id))
    .orderBy(asc(userDepartmentScope.departmentCode));
  const sessions = await sessionsFor(tx, id);
  return { user, roles, branches, departments, sessions };
}

/**
 * A temporary password: 16 characters from a URL-safe alphabet, which
 * satisfies the policy (length, not a blocked word, not a run) without
 * being something a person would keep.
 */
export function temporaryPassword(): string {
  return randomBytes(12).toString('base64url').slice(0, 16);
}

function normaliseEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdminValidationError('email', 'is not a valid address');
  }
  return email;
}

export async function create(tx: Tx, ctx: ActorContext, input: UserInput) {
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const email = normaliseEmail(input.email);
  const displayName = requireText(input.displayName, 'displayName', 120);

  const [clash] = await tx
    .select({ id: appUser.id })
    .from(appUser)
    .where(eq(appUser.email, email));
  if (clash) throw new AdminValidationError('email', 'already has an account');

  const [created] = await tx
    .insert(appUser)
    .values({ email, displayName, isActive: true })
    .returning({ id: appUser.id });
  const id = created!.id;

  const password = temporaryPassword();
  await setPassword(tx, id, password, { temporary: true });

  for (const code of input.roleCodes ?? []) await setRole(tx, ctx, id, code, true, { quiet: true });
  const branches = input.branchCodes ?? [];
  for (const code of branches) {
    await setBranchScope(tx, ctx, id, code, true, { quiet: true });
  }
  const defaultBranch = input.defaultBranchCode ?? branches[0] ?? null;
  if (defaultBranch) await setDefaultBranch(tx, ctx, id, defaultBranch, { quiet: true });
  for (const code of input.departmentCodes ?? []) {
    await setDepartmentScope(tx, ctx, id, code, true, { quiet: true });
  }

  await recordChange(tx, ctx, {
    action: 'app_user.created',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    after: {
      email,
      displayName,
      roleCodes: input.roleCodes ?? [],
      branchCodes: branches,
      departmentCodes: input.departmentCodes ?? [],
    },
  });

  return { id, email, displayName, temporaryPassword: password };
}

export async function update(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  input: { readonly displayName: string },
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, id);
  const before = await get(tx, id);
  const displayName = requireText(input.displayName, 'displayName', 120);
  await tx.update(appUser).set({ displayName, updatedAt: new Date() }).where(eq(appUser.id, id));
  await recordChange(tx, ctx, {
    action: 'app_user.updated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { displayName: before.displayName },
    after: { displayName },
  });
}

export async function setActive(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  active: boolean,
  reason: string | null,
) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, id);
  const before = await get(tx, id);
  if (before.isActive === active) return;
  if (!active && id === ctx.principal.userId) {
    throw new AdminValidationError('user', 'you cannot deactivate your own account');
  }
  if (!active && !reason?.trim()) {
    throw new AdminValidationError('reason', 'is required to deactivate an account');
  }
  await tx.update(appUser).set({ isActive: active, updatedAt: new Date() }).where(eq(appUser.id, id));
  if (!active) {
    await revokeAllSessionsFor(tx, ctx, id, `Account deactivated: ${reason!.trim()}`);
  }
  await recordChange(tx, ctx, {
    action: active ? 'app_user.reactivated' : 'app_user.deactivated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { isActive: before.isActive },
    after: { isActive: active },
    reason: reason?.trim() || null,
  });
}

/** Issues a new temporary password, ending the old sessions. Returned once. */
export async function resetPassword(tx: Tx, ctx: ActorContext, id: string) {
  await permit(ctx, 'administer', PERMISSION_OBJECT, id);
  await get(tx, id);
  const password = temporaryPassword();
  await setPassword(tx, id, password, { temporary: true });
  await revokeAllSessionsFor(tx, ctx, id, 'Password reset by administrator');
  await recordChange(tx, ctx, {
    action: 'app_user.password_reset',
    objectType: PERMISSION_OBJECT,
    objectId: id,
  });
  return password;
}

interface Quiet {
  readonly quiet?: boolean;
}

export async function setRole(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  roleCode: string,
  on: boolean,
  options: Quiet = {},
) {
  await permitCeo(ctx);
  await permit(ctx, 'configure', PERMISSION_OBJECT, id);
  await get(tx, id);
  const [known] = await tx.select({ code: role.code }).from(role).where(eq(role.code, roleCode));
  if (!known) throw new AdminValidationError('roleCode', `'${roleCode}' is not a role`);
  if (on) {
    await tx
      .insert(userRole)
      .values({ userId: id, roleCode, grantedBy: ctx.principal.userId })
      .onConflictDoNothing();
  } else {
    await tx.delete(userRole).where(and(eq(userRole.userId, id), eq(userRole.roleCode, roleCode)));
  }
  if (!options.quiet) {
    await recordChange(tx, ctx, {
      action: on ? 'app_user.role_granted' : 'app_user.role_revoked',
      objectType: PERMISSION_OBJECT,
      objectId: id,
      after: { roleCode },
    });
  }
}

export async function setBranchScope(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  branchCode: string,
  on: boolean,
  options: Quiet = {},
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, id);
  const [known] = await tx.select({ code: branch.code }).from(branch).where(eq(branch.code, branchCode));
  if (!known) throw new AdminValidationError('branchCode', `'${branchCode}' is not a branch`);
  if (on) {
    await tx.insert(userBranchScope).values({ userId: id, branchCode }).onConflictDoNothing();
  } else {
    await tx
      .delete(userBranchScope)
      .where(and(eq(userBranchScope.userId, id), eq(userBranchScope.branchCode, branchCode)));
  }
  if (!options.quiet) {
    await recordChange(tx, ctx, {
      action: on ? 'app_user.branch_scope_granted' : 'app_user.branch_scope_revoked',
      objectType: PERMISSION_OBJECT,
      objectId: id,
      after: { branchCode },
    });
  }
}

export async function setDefaultBranch(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  branchCode: string,
  options: Quiet = {},
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, id);
  const [scope] = await tx
    .select({ code: userBranchScope.branchCode })
    .from(userBranchScope)
    .where(and(eq(userBranchScope.userId, id), eq(userBranchScope.branchCode, branchCode)));
  if (!scope) throw new AdminValidationError('branchCode', 'the user is not scoped to that branch');
  // One default at a time — the partial unique index holds the line.
  await tx.update(userBranchScope).set({ isDefault: false }).where(eq(userBranchScope.userId, id));
  await tx
    .update(userBranchScope)
    .set({ isDefault: true })
    .where(and(eq(userBranchScope.userId, id), eq(userBranchScope.branchCode, branchCode)));
  if (!options.quiet) {
    await recordChange(tx, ctx, {
      action: 'app_user.default_branch_set',
      objectType: PERMISSION_OBJECT,
      objectId: id,
      after: { branchCode },
    });
  }
}

export async function setDepartmentScope(
  tx: Tx,
  ctx: ActorContext,
  id: string,
  departmentCode: string,
  on: boolean,
  options: Quiet = {},
) {
  await permit(ctx, 'configure', PERMISSION_OBJECT, id);
  const [known] = await tx
    .select({ code: department.code })
    .from(department)
    .where(eq(department.code, departmentCode));
  if (!known) throw new AdminValidationError('departmentCode', `'${departmentCode}' is not a department`);
  if (on) {
    await tx
      .insert(userDepartmentScope)
      .values({ userId: id, departmentCode, isManager: false })
      .onConflictDoNothing();
  } else {
    await tx
      .delete(userDepartmentScope)
      .where(
        and(eq(userDepartmentScope.userId, id), eq(userDepartmentScope.departmentCode, departmentCode)),
      );
    await tx
      .update(department)
      .set({ managerUserId: null })
      .where(and(eq(department.code, departmentCode), eq(department.managerUserId, id)));
  }
  if (!options.quiet) {
    await recordChange(tx, ctx, {
      action: on ? 'app_user.department_scope_granted' : 'app_user.department_scope_revoked',
      objectType: PERMISSION_OBJECT,
      objectId: id,
      after: { departmentCode },
    });
  }
}

// ---------------------------------------------------------------------------
// Self-service — what a signed-in person may do to their own account without
// any administration grant: rename themselves, and replace their password.
// ---------------------------------------------------------------------------

export async function updateOwnProfile(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly displayName: string },
) {
  const id = ctx.principal.userId;
  const before = await get(tx, id);
  const displayName = requireText(input.displayName, 'displayName', 120);
  await tx.update(appUser).set({ displayName, updatedAt: new Date() }).where(eq(appUser.id, id));
  await recordChange(tx, ctx, {
    action: 'app_user.profile_updated',
    objectType: PERMISSION_OBJECT,
    objectId: id,
    before: { displayName: before.displayName },
    after: { displayName },
  });
}

/**
 * Replaces the caller's own password. The current one is checked first — a
 * session left open on a shared machine must not be enough to lock the real
 * owner out — and every *other* session is ended, so a password change is
 * also the remedy for a suspected leak.
 */
export async function changeOwnPassword(
  tx: Tx,
  ctx: ActorContext,
  input: { readonly currentPassword: string; readonly newPassword: string; readonly confirm: string },
  keepSessionId: string,
) {
  const id = ctx.principal.userId;
  const user = await get(tx, id);
  if (input.newPassword !== input.confirm) {
    throw new AdminValidationError('confirm', 'the two new passwords do not match');
  }
  try {
    await verifyCredentials(tx, user.email, input.currentPassword);
  } catch {
    throw new AdminValidationError('currentPassword', 'the current password is not correct');
  }
  await setPassword(tx, id, input.newPassword, { temporary: false });
  await revokeOtherSessions(tx, ctx, id, keepSessionId, 'Password changed by the account holder');
  await recordChange(tx, ctx, {
    action: 'app_user.password_changed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
  });
}

async function revokeOtherSessions(
  tx: Tx,
  ctx: ActorContext,
  userId: string,
  keepSessionId: string,
  reason: string,
) {
  const open = await sessionsFor(tx, userId);
  for (const session of open) {
    if (session.id === keepSessionId || session.revokedAt) continue;
    await revokeSession(tx, ctx, session.id, reason);
  }
}

/** The profile picture, kept on the account row as a data URL (small, square). */
export const AVATAR_MAX_BYTES = 400 * 1024;
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export async function updateOwnAvatar(
  tx: Tx,
  ctx: ActorContext,
  file: { readonly type: string; readonly size: number; readonly bytes: () => Promise<Uint8Array> } | null,
) {
  const id = ctx.principal.userId;
  await get(tx, id);
  let image: string | null = null;
  if (file) {
    if (!AVATAR_TYPES.has(file.type)) {
      throw new AdminValidationError('avatar', 'use a PNG, JPEG or WebP image');
    }
    if (file.size > AVATAR_MAX_BYTES) {
      throw new AdminValidationError('avatar', `is larger than ${Math.round(AVATAR_MAX_BYTES / 1024)} KB`);
    }
    image = `data:${file.type};base64,${Buffer.from(await file.bytes()).toString('base64')}`;
  }
  await tx.update(appUser).set({ image, updatedAt: new Date() }).where(eq(appUser.id, id));
  await recordChange(tx, ctx, {
    action: image ? 'app_user.avatar_updated' : 'app_user.avatar_removed',
    objectType: PERMISSION_OBJECT,
    objectId: id,
  });
}
