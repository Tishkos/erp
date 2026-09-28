/**
 * Roles and Permissions — Phase 0 requirement 5.
 *
 * "Access can be assigned by system section and permitted action." A role is
 * a named set of (object, verb) grants; a user holds roles. The objects are
 * the Appendix A menu's objects — the "system sections" — and the verbs are
 * the closed §5.3 list. There are no deny rows and no wildcards: what is not
 * granted is refused (`permissions.ts`).
 *
 * System roles keep their code and name; their grants may still be edited,
 * because which sections Finance reaches is a business decision.
 */
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { role, roleGrant, userRole } from '../db/schema';
import { menuObjects } from '../domain/menu';
import { phaseObjects } from '../phase-gate';
import { PERMISSION_VERBS, isPermissionVerb, type PermissionVerb } from '../domain/permissions';
import {
  AdminNotFoundError,
  AdminValidationError,
  codeFromName,
  normaliseCode,
  uniqueCode,
  optionalText,
  permit,
  permitCeo,
  recordChange,
  requireText,
  type ActorContext,
} from './administration';

export const PERMISSION_OBJECT = 'role';

export interface RoleInput {
  readonly name: string;
  readonly description?: string | null;
}

export interface GrantInput {
  readonly object: string;
  readonly verb: string;
}

/**
 * The roles, each with what it may do and who holds it.
 *
 * The count is of grants over things that **exist** — a role also carries
 * grants for the phases that have not arrived, and counting those would put
 * a number on screen that no amount of ticking could ever explain.
 */
export async function listAll(tx: Tx) {
  const roles = await tx.select().from(role).orderBy(asc(role.code));
  const grants = await tx.select().from(roleGrant);
  const holders = await tx.select({ roleCode: userRole.roleCode }).from(userRole);
  const live = phaseObjects();
  return roles.map((r) => ({
    ...r,
    grantCount: grants.filter((g) => g.roleCode === r.code && live.has(g.object)).length,
    holderCount: holders.filter((h) => h.roleCode === r.code).length,
  }));
}

export async function get(tx: Tx, code: string) {
  const [row] = await tx.select().from(role).where(eq(role.code, code)).limit(1);
  if (!row) throw new AdminNotFoundError('role', code);
  const grants = await tx
    .select({ object: roleGrant.object, verb: roleGrant.verb })
    .from(roleGrant)
    .where(eq(roleGrant.roleCode, code));
  return { ...row, grants };
}

/** Every (object, verb) held by every role — the Permissions matrix. */
export async function matrix(tx: Tx) {
  const roles = await tx.select({ code: role.code, name: role.name }).from(role).orderBy(asc(role.code));
  const grants = await tx.select().from(roleGrant);
  return { roles, grants, objects: grantableObjects(), verbs: PERMISSION_VERBS };
}

/** The system sections access can be assigned by — the menu's objects. */
export function grantableObjects(): readonly string[] {
  return menuObjects();
}

export async function create(tx: Tx, ctx: ActorContext, input: RoleInput & { readonly code?: string }) {
  await permitCeo(ctx);
  await permit(ctx, 'create', PERMISSION_OBJECT);
  const name = requireText(input.name, 'name', 120);
  // "Accountant Branch" becomes accountant_branch.
  const code = input.code?.trim()
    ? normaliseCode(input.code).toLowerCase()
    : await uniqueCode(codeFromName(name, 'lower'), async (candidate) => {
        const [row] = await tx.select({ code: role.code }).from(role).where(eq(role.code, candidate));
        return Boolean(row);
      });
  const [existing] = await tx.select({ code: role.code }).from(role).where(eq(role.code, code));
  if (existing) throw new AdminValidationError('code', `'${code}' is already a role`);
  const values = { code, name, description: optionalText(input.description), isSystem: false };
  await tx.insert(role).values(values);
  await recordChange(tx, ctx, {
    action: 'role.created',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    after: values,
  });
  return get(tx, code);
}

export async function update(tx: Tx, ctx: ActorContext, code: string, input: RoleInput) {
  await permitCeo(ctx);
  await permit(ctx, 'configure', PERMISSION_OBJECT, code);
  const before = await get(tx, code);
  if (before.isSystem) throw new AdminValidationError('role', 'a system role keeps its name');
  const values = {
    name: requireText(input.name, 'name', 120),
    description: optionalText(input.description),
  };
  await tx.update(role).set(values).where(eq(role.code, code));
  await recordChange(tx, ctx, {
    action: 'role.updated',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { name: before.name, description: before.description },
    after: values,
  });
}

/** Replaces the role's grants with exactly this set. */
export async function setGrants(
  tx: Tx,
  ctx: ActorContext,
  code: string,
  grants: readonly GrantInput[],
  options?: { readonly offeredObjects?: readonly string[] },
) {
  await permitCeo(ctx);
  await permit(ctx, 'administer', 'permission', code);
  const before = await get(tx, code);

  const objects = new Set(grantableObjects());
  const wanted = new Map<string, { object: string; verb: PermissionVerb }>();
  for (const grant of grants) {
    if (!objects.has(grant.object)) {
      throw new AdminValidationError('object', `'${grant.object}' is not a system section`);
    }
    if (!isPermissionVerb(grant.verb)) {
      throw new AdminValidationError('verb', `'${grant.verb}' is not a permitted action`);
    }
    wanted.set(`${grant.object}:${grant.verb}`, { object: grant.object, verb: grant.verb });
  }

  // Only the objects the screen offered are replaced. A grant on something
  // this phase does not show is left alone: an editor cannot revoke what it
  // never displayed, so saving a role never quietly loses a permission.
  const offered = new Set(options?.offeredObjects ?? [...new Set([...wanted.values()].map((g) => g.object))]);
  if (offered.size > 0) {
    await tx
      .delete(roleGrant)
      .where(and(eq(roleGrant.roleCode, code), inArray(roleGrant.object, [...offered])));
  }
  if (wanted.size > 0) {
    await tx
      .insert(roleGrant)
      .values([...wanted.values()].map((g) => ({ roleCode: code, object: g.object, verb: g.verb })))
      .onConflictDoNothing();
  }

  await recordChange(tx, ctx, {
    action: 'role.grants_set',
    objectType: PERMISSION_OBJECT,
    objectId: code,
    before: { grants: before.grants },
    after: { grants: [...wanted.values()] },
  });
}
