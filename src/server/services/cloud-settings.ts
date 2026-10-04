/**
 * QS Cloud Files — the integration's settings (Platform phase, Agent 4).
 *
 * Everything is configured on a screen (IM2-6): whether the Document Center is
 * on, the address of the Nextcloud installation, where the Document Center
 * starts and where record folders are made, and which Nextcloud group each ERP
 * role maps to (REQ-FIX-001 FIX-6: read / write / share). Every change is an
 * audit event; a mapping is deactivated with a reason, never deleted.
 *
 * The settings screen is `cloud_setting` (`view` opens it, `configure`
 * changes it). The row is readable by everyone signed in — the Document Center
 * must know whether it is on — but holds nothing secret: the address is not a
 * credential.
 */
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { cloudGroupMapping, cloudSetting, role } from '../db/schema';
import {
  CloudConfigError,
  assertGroupName,
  isWithin,
  normaliseBaseUrl,
  normaliseCloudPath,
} from '../domain/cloud-files';
import { secretKeyProblem } from '../secret-box';
import { AdminValidationError, permit, recordChange } from './administration';
import type { ActorContext } from './chart-of-accounts';

export const PERMISSION_OBJECT = 'cloud_setting';
/** The Document Center and the links on a record. */
export const FILES_OBJECT = 'cloud_files';

export interface CloudSettings {
  readonly enabled: boolean;
  readonly baseUrl: string | null;
  readonly rootPath: string;
  readonly recordRoot: string;
  readonly updatedAt: Date;
}

export async function get(tx: Tx): Promise<CloudSettings> {
  const [row] = await tx.select().from(cloudSetting).where(eq(cloudSetting.id, 1)).limit(1);
  if (!row) return { enabled: false, baseUrl: null, rootPath: '/', recordRoot: '/Qimah', updatedAt: new Date(0) };
  return {
    enabled: row.enabled,
    baseUrl: row.baseUrl ? row.baseUrl : null,
    rootPath: row.rootPath,
    recordRoot: row.recordRoot,
    updatedAt: row.updatedAt,
  };
}

/** The integration is on and has somewhere to go. */
export const isConfigured = (settings: CloudSettings): boolean => settings.enabled && Boolean(settings.baseUrl);

export interface SaveSettingsInput {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly rootPath: string;
  readonly recordRoot: string;
}

function invalid(field: string, error: unknown): never {
  throw new AdminValidationError(field, error instanceof Error ? error.message : String(error));
}

export async function save(tx: Tx, ctx: ActorContext, input: SaveSettingsInput): Promise<CloudSettings> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, '1');
  const before = await get(tx);

  let baseUrl: string | null = null;
  if (input.baseUrl.trim() !== '') {
    try {
      baseUrl = normaliseBaseUrl(input.baseUrl);
    } catch (error) {
      if (error instanceof CloudConfigError) invalid('address', error);
      throw error;
    }
  }
  if (input.enabled && !baseUrl) invalid('address', 'is required to switch Cloud Files on');
  if (input.enabled) {
    // A person's app password is kept sealed with the server's key; without it nobody could link.
    const problem = secretKeyProblem();
    if (problem) invalid('server key', `${problem} Cloud Files cannot keep anyone's app password until it is set.`);
  }

  let rootPath: string;
  let recordRoot: string;
  try {
    rootPath = normaliseCloudPath(input.rootPath);
    recordRoot = normaliseCloudPath(input.recordRoot);
  } catch (error) {
    return invalid('folder', error);
  }
  if (recordRoot === '/' || !isWithin(rootPath, recordRoot)) {
    invalid('record folders', 'must be a folder inside the Document Center folder');
  }

  await tx
    .update(cloudSetting)
    .set({ enabled: input.enabled, baseUrl, rootPath, recordRoot, updatedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(cloudSetting.id, 1));

  await recordChange(tx, ctx, {
    action: 'cloud_setting.updated',
    objectType: PERMISSION_OBJECT,
    objectId: '1',
    before: { enabled: before.enabled, baseUrl: before.baseUrl, rootPath: before.rootPath, recordRoot: before.recordRoot },
    after: { enabled: input.enabled, baseUrl, rootPath, recordRoot },
  });
  return get(tx);
}

// ---------------------------------------------------------------------------
// Role -> Nextcloud group
// ---------------------------------------------------------------------------

export interface MappingRow {
  readonly roleCode: string;
  readonly roleName: string;
  readonly groupName: string;
  readonly canWrite: boolean;
  readonly canShare: boolean;
  readonly active: boolean;
  readonly deactivatedReason: string | null;
}

export async function listMappings(tx: Tx): Promise<readonly MappingRow[]> {
  const rows = await tx
    .select({
      roleCode: cloudGroupMapping.roleCode,
      roleName: role.name,
      groupName: cloudGroupMapping.groupName,
      canWrite: cloudGroupMapping.canWrite,
      canShare: cloudGroupMapping.canShare,
      active: cloudGroupMapping.active,
      deactivatedReason: cloudGroupMapping.deactivatedReason,
    })
    .from(cloudGroupMapping)
    .innerJoin(role, eq(role.code, cloudGroupMapping.roleCode))
    .orderBy(asc(role.name));
  return rows;
}

/** The roles a mapping can still be made for: every role, whether or not it has one. */
export async function listRoles(tx: Tx): Promise<ReadonlyArray<{ code: string; name: string }>> {
  return tx.select({ code: role.code, name: role.name }).from(role).orderBy(asc(role.name));
}

export interface SaveMappingInput {
  readonly roleCode: string;
  readonly groupName: string;
  readonly canWrite: boolean;
  readonly canShare: boolean;
}

/** Maps a role to a Nextcloud group (or changes, or switches back on, the mapping it has). */
export async function saveMapping(tx: Tx, ctx: ActorContext, input: SaveMappingInput): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, input.roleCode);
  let groupName: string;
  try {
    groupName = assertGroupName(input.groupName);
  } catch (error) {
    return invalid('group', error);
  }
  const [roleRow] = await tx.select({ code: role.code }).from(role).where(eq(role.code, input.roleCode)).limit(1);
  if (!roleRow) invalid('role', 'is not a role of this system');

  const [before] = await tx.select().from(cloudGroupMapping).where(eq(cloudGroupMapping.roleCode, input.roleCode)).limit(1);
  const now = new Date();
  if (before) {
    await tx
      .update(cloudGroupMapping)
      .set({ groupName, canWrite: input.canWrite, canShare: input.canShare, active: true, deactivatedReason: null, updatedBy: ctx.principal.userId, updatedAt: now })
      .where(eq(cloudGroupMapping.roleCode, input.roleCode));
  } else {
    await tx
      .insert(cloudGroupMapping)
      .values({ roleCode: input.roleCode, groupName, canWrite: input.canWrite, canShare: input.canShare, updatedBy: ctx.principal.userId, updatedAt: now });
  }
  await recordChange(tx, ctx, {
    action: 'cloud_group_mapping.saved',
    objectType: 'cloud_group_mapping',
    objectId: input.roleCode,
    before: before
      ? { groupName: before.groupName, canWrite: before.canWrite, canShare: before.canShare, active: before.active }
      : null,
    after: { groupName, canWrite: input.canWrite, canShare: input.canShare, active: true },
  });
}

export async function deactivateMapping(tx: Tx, ctx: ActorContext, roleCode: string, reason: string): Promise<void> {
  await permit(ctx, 'configure', PERMISSION_OBJECT, roleCode);
  if (reason.trim() === '') invalid('reason', 'is required to switch a mapping off');
  const [before] = await tx.select().from(cloudGroupMapping).where(eq(cloudGroupMapping.roleCode, roleCode)).limit(1);
  if (!before) invalid('role', 'has no mapping');
  if (!before.active) return;
  await tx
    .update(cloudGroupMapping)
    .set({ active: false, deactivatedReason: reason.trim(), updatedBy: ctx.principal.userId, updatedAt: new Date() })
    .where(eq(cloudGroupMapping.roleCode, roleCode));
  await recordChange(tx, ctx, {
    action: 'cloud_group_mapping.deactivated',
    objectType: 'cloud_group_mapping',
    objectId: roleCode,
    before: { groupName: before.groupName, active: true },
    after: { active: false },
    reason: reason.trim(),
  });
}
