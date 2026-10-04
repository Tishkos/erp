/**
 * QS Cloud Files — browsing, uploading, folders, sharing and the links to ERP
 * records (Platform phase, Agent 4; REQ-FIX-001 FIX-6).
 *
 * Qimah is the ERP-aware window; the cloud is the store and the authority.
 * Everything a person sees or does here is done AS THEM at the cloud (their own
 * app password, `cloud-accounts.connect`), so a file the cloud does not show
 * them is a file this screen does not show them. What Qimah adds is the
 * ERP's side of it:
 *
 *   - the permission to use the Document Center at all (`cloud_files`);
 *   - links between a cloud file and an ERP record, made only for records the
 *     person may open (`cloud-link-targets`), listed in both directions;
 *   - folders made from the ERP, shared with the Nextcloud groups mapped to
 *     the ERP roles (`cloud-settings`), and named for the record they hold;
 *   - the audit trail: every upload, folder, share, link and download.
 *
 * Nothing is copied. A link holds the cloud's file id and the name its maker
 * saw; the bytes are fetched from the cloud, through the ERP's own route, each
 * time. "Uploaded" is said only when the cloud has answered 201/204 AND a
 * listing of the new file shows the size that was sent.
 */
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Tx } from '../db/client';
import { cloudFileLink, roleGrant, appUser } from '../db/schema';
import {
  CloudLinkError,
  CloudPathError,
  MAX_UPLOAD_BYTES,
  assertFileName,
  assertLinkShape,
  assertWithin,
  folderNameForRecord,
  joinPath,
  normaliseCloudPath,
  openInCloudUrl,
  parentOf,
  sharesFor,
  type GroupMapping,
} from '../domain/cloud-files';
import { DEFAULT_UPLOAD_POLICY, extensionOf, inspect } from '../domain/attachments';
import { can } from '../domain/permissions';
import { AdminValidationError, permit, recordChange } from './administration';
import * as audit from './audit';
import type { ActorContext } from './chart-of-accounts';
import {
  CloudConflictError,
  CloudRequestError,
  type CloudClient,
  type CloudEntry,
} from './cloud-client';
import { openRecord, targetOf, type RecordRef } from './cloud-link-targets';
import * as settings from './cloud-settings';

export const FILES_OBJECT = settings.FILES_OBJECT;

// ---------------------------------------------------------------------------
// What a person may do in a folder — as the cloud says it
// ---------------------------------------------------------------------------

/** Nextcloud's permission letters, read for what the Document Center offers. */
export function folderRights(entry: Pick<CloudEntry, 'permissions' | 'isFolder'>): { upload: boolean; makeFolder: boolean } {
  if (!entry.isFolder) return { upload: false, makeFolder: false };
  const letters = entry.permissions ?? '';
  // The cloud did not say: do not offer what it may refuse. (A real Nextcloud always says.)
  return { upload: letters.includes('C'), makeFolder: letters.includes('K') };
}

// ---------------------------------------------------------------------------
// Links — file -> record
// ---------------------------------------------------------------------------

export interface LinkedRecord {
  readonly linkId: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly label: string;
  readonly href: string;
}

/**
 * The ERP records each of these cloud files is linked to — only those this
 * person may open (one answer for "no link" and "a link to a record you cannot
 * see"). Keyed by the cloud's file id.
 */
export async function recordsLinkedTo(tx: Tx, ctx: ActorContext, serverUrl: string, fileIds: readonly string[]): Promise<ReadonlyMap<string, readonly LinkedRecord[]>> {
  const result = new Map<string, LinkedRecord[]>();
  if (fileIds.length === 0 || !can(ctx.principal, 'view', FILES_OBJECT)) return result;
  const rows = await tx
    .select()
    .from(cloudFileLink)
    .where(and(eq(cloudFileLink.serverUrl, serverUrl), inArray(cloudFileLink.fileId, [...fileIds]), isNull(cloudFileLink.unlinkedAt)));
  const opened = new Map<string, RecordRef | null>();
  for (const row of rows) {
    const key = `${row.objectType}\u0000${row.objectId}`;
    if (!opened.has(key)) opened.set(key, await openRecord(tx, ctx.principal, row.objectType, row.objectId));
    const record = opened.get(key);
    if (!record) continue;
    const list = result.get(row.fileId) ?? [];
    list.push({ linkId: row.id, objectType: row.objectType, objectId: row.objectId, label: record.label, href: record.href });
    result.set(row.fileId, list);
  }
  return result;
}

export interface LinkRow {
  readonly id: string;
  readonly fileId: string;
  readonly name: string;
  readonly isFolder: boolean;
  readonly path: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly recordLabel: string;
  readonly linkedBy: string;
  readonly linkedByName: string | null;
  readonly linkedAt: Date;
}

/** The record's links, newest first — the ERP's side only; the cloud has not been asked. Empty for a record this person cannot open. */
export async function linksOfRecord(tx: Tx, ctx: ActorContext, serverUrl: string, objectType: string, objectId: string): Promise<readonly LinkRow[]> {
  if (!can(ctx.principal, 'view', FILES_OBJECT)) return [];
  if (!(await openRecord(tx, ctx.principal, objectType, objectId))) return [];
  const rows = await tx
    .select({
      id: cloudFileLink.id,
      fileId: cloudFileLink.fileId,
      name: cloudFileLink.name,
      isFolder: cloudFileLink.isFolder,
      path: cloudFileLink.path,
      objectType: cloudFileLink.objectType,
      objectId: cloudFileLink.objectId,
      recordLabel: cloudFileLink.recordLabel,
      linkedBy: cloudFileLink.linkedBy,
      linkedByName: appUser.displayName,
      linkedAt: cloudFileLink.linkedAt,
    })
    .from(cloudFileLink)
    .leftJoin(appUser, eq(appUser.id, cloudFileLink.linkedBy))
    .where(and(eq(cloudFileLink.serverUrl, serverUrl), eq(cloudFileLink.objectType, objectType), eq(cloudFileLink.objectId, objectId), isNull(cloudFileLink.unlinkedAt)))
    .orderBy(desc(cloudFileLink.linkedAt));
  return rows;
}

/** How many files are linked to a record (the paperclip's count). Zero for a record this person cannot open. */
export async function countLinks(tx: Tx, ctx: ActorContext, serverUrl: string | null, objectType: string, objectId: string): Promise<number> {
  if (!serverUrl) return 0;
  return (await linksOfRecord(tx, ctx, serverUrl, objectType, objectId)).length;
}

export type LinkState = 'available' | 'unavailable' | 'unverified';

export interface VerifiedLink extends LinkRow {
  /** Whether the cloud showed this person the file: only then is its name given. */
  readonly state: LinkState;
  readonly entry: CloudEntry | null;
  readonly openUrl: string | null;
}

/**
 * Asks the cloud, as this person, whether they can see each linked file.
 * A file the cloud does not show them is "unavailable" and loses its name here
 * — the cloud's permissions are the truth, and a link is not a way around them.
 */
export async function verifyLinks(client: CloudClient, serverUrl: string, links: readonly LinkRow[]): Promise<readonly VerifiedLink[]> {
  const out: VerifiedLink[] = new Array(links.length);
  let next = 0;
  const worker = async () => {
    while (next < links.length) {
      const index = next++;
      const link = links[index]!;
      const entry = await resolveForPerson(client, link);
      out[index] = {
        ...link,
        name: entry ? link.name : '',
        state: entry ? 'available' : 'unavailable',
        entry,
        openUrl: entry?.fileId ? openInCloudUrl(serverUrl, entry.fileId) : null,
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, links.length) }, worker));
  return out;
}

/** The links when the cloud has not been asked (not linked, unreachable): present, but nothing of the file shown. */
export function unverified(links: readonly LinkRow[]): readonly VerifiedLink[] {
  return links.map((link) => ({ ...link, name: '', state: 'unverified' as const, entry: null, openUrl: null }));
}

/** Finds the file as this person sees it: where its linker saw it, or wherever the cloud says it is for them. */
export async function resolveForPerson(client: CloudClient, link: Pick<LinkRow, 'fileId' | 'path'>): Promise<CloudEntry | null> {
  const where = await client.stat(link.path).catch((error) => {
    if (error instanceof CloudRequestError || error instanceof CloudConflictError) return null;
    throw error;
  });
  if (where && where.fileId === link.fileId) return where;
  const path = await client.pathOfFileId(link.fileId);
  if (!path) return null;
  const found = await client.stat(path);
  return found && found.fileId === link.fileId ? found : null;
}

export interface MakeLinkInput {
  readonly path: string;
  readonly objectType: string;
  readonly objectId: string;
}

/** Document -> record: links the file or folder at `path` (as this person sees it) to a record they may open. */
export async function linkPath(tx: Tx, ctx: ActorContext, client: CloudClient, config: settings.CloudSettings, input: MakeLinkInput): Promise<LinkRow> {
  await permit(ctx, 'create', FILES_OBJECT, input.objectId);
  const path = assertWithin(config.rootPath, input.path);
  const record = await openRecord(tx, ctx.principal, input.objectType, input.objectId);
  if (!record) {
    await refuse(ctx, 'cloud_file.link_refused', input.objectType, input.objectId, 'the record cannot be opened by this person');
    throw new CloudLinkError('You cannot link files to that record.');
  }
  const entry = await client.stat(path);
  if (!entry) throw new CloudLinkError('That file is not available to you in Cloud Files.');
  return linkEntry(tx, ctx, client.baseUrl, entry, record);
}

/** Records the link for an entry the cloud has just shown this person (or made for them). */
export async function linkEntry(tx: Tx, ctx: ActorContext, serverUrl: string, entry: CloudEntry, record: RecordRef): Promise<LinkRow> {
  if (!entry.fileId) throw new CloudLinkError('That file has no identifier in Cloud Files, so it cannot be linked.');
  assertLinkShape({ fileId: entry.fileId, objectType: record.type, objectId: record.id });

  const [existing] = await tx
    .select()
    .from(cloudFileLink)
    .where(and(eq(cloudFileLink.serverUrl, serverUrl), eq(cloudFileLink.fileId, entry.fileId), eq(cloudFileLink.objectType, record.type), eq(cloudFileLink.objectId, record.id), isNull(cloudFileLink.unlinkedAt)))
    .limit(1);
  if (existing) {
    return { ...existing, linkedByName: null };
  }
  const [row] = await tx
    .insert(cloudFileLink)
    .values({
      serverUrl,
      fileId: entry.fileId,
      name: entry.name,
      isFolder: entry.isFolder,
      path: entry.path,
      objectType: record.type,
      objectId: record.id,
      recordLabel: record.label,
      branchCode: record.branchCode,
      linkedBy: ctx.principal.userId,
    })
    .returning();
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cloud_file.linked',
    objectType: record.auditObject,
    objectId: record.id,
    branchCode: record.branchCode ?? ctx.branchCode,
    after: { file: entry.name, folder: entry.isFolder, path: entry.path },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
    relatedObjectId: row!.id,
  });
  return { ...row!, linkedByName: null };
}

/** Ends a link. The row stays, with who ended it and why; the file in the cloud is untouched. */
export async function unlinkFile(tx: Tx, ctx: ActorContext, linkId: string, reason: string): Promise<void> {
  await permit(ctx, 'create', FILES_OBJECT, linkId);
  const [row] = await tx.select().from(cloudFileLink).where(and(eq(cloudFileLink.id, linkId), isNull(cloudFileLink.unlinkedAt))).limit(1);
  if (!row) throw new CloudLinkError('That link no longer exists.');
  const record = await openRecord(tx, ctx.principal, row.objectType, row.objectId);
  if (!record) {
    await refuse(ctx, 'cloud_file.unlink_refused', row.objectType, row.objectId, 'the record cannot be opened by this person');
    throw new CloudLinkError('You cannot change the files linked to that record.');
  }
  if (reason.trim() === '') throw new AdminValidationError('reason', 'is required to unlink a file');
  await tx
    .update(cloudFileLink)
    .set({ unlinkedAt: new Date(), unlinkedBy: ctx.principal.userId, unlinkReason: reason.trim() })
    .where(eq(cloudFileLink.id, linkId));
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cloud_file.unlinked',
    objectType: record.auditObject,
    objectId: record.id,
    branchCode: record.branchCode ?? ctx.branchCode,
    before: { file: row.name, path: row.path },
    reason: reason.trim(),
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
    relatedObjectId: row.id,
  });
}

async function refuse(ctx: ActorContext, action: string, objectType: string, objectId: string, reason: string): Promise<void> {
  await audit.recordSecurity(
    { userId: ctx.principal.userId, branchCode: ctx.branchCode },
    {
      actorUserId: ctx.principal.userId,
      action,
      objectType: targetOf(objectType)?.auditObject ?? objectType,
      objectId,
      branchCode: ctx.branchCode,
      reason,
      outcome: 'denied',
      requestId: ctx.requestId ?? null,
      clientIp: ctx.clientIp ?? null,
    },
  );
}

// ---------------------------------------------------------------------------
// Folders and sharing
// ---------------------------------------------------------------------------

export interface ShareResult {
  readonly group: string;
  readonly outcome: 'shared' | 'already' | 'unknown_group' | 'refused';
  readonly message: string;
}

export async function activeMappings(tx: Tx): Promise<readonly GroupMapping[]> {
  const rows = await settings.listMappings(tx);
  return rows.map((row) => ({ roleCode: row.roleCode, groupName: row.groupName, canWrite: row.canWrite, canShare: row.canShare, active: row.active }));
}

/** The roles that may open a kind of record — whoever holds `view` on its object. */
async function rolesThatMayOpen(tx: Tx, object: string): Promise<ReadonlySet<string>> {
  const rows = await tx.select({ role: roleGrant.roleCode }).from(roleGrant).where(and(eq(roleGrant.object, object), eq(roleGrant.verb, 'view')));
  return new Set(rows.map((row) => row.role));
}

async function shareWith(client: CloudClient, path: string, shares: ReturnType<typeof sharesFor>): Promise<ShareResult[]> {
  const results: ShareResult[] = [];
  for (const share of shares) {
    try {
      const answer = await client.shareWithGroup(path, share.groupName, share.bits);
      results.push({ group: share.groupName, outcome: answer.outcome, message: answer.message });
    } catch (error) {
      results.push({ group: share.groupName, outcome: 'refused', message: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export interface CreateFolderInput {
  readonly parent: string;
  readonly name: string;
  /** Share it with the Nextcloud groups the ERP roles are mapped to. */
  readonly shareWithMapped: boolean;
}

export interface FolderMade {
  readonly entry: CloudEntry;
  readonly shares: readonly ShareResult[];
}

/** A new folder in the Document Center, optionally shared with the mapped groups. Confirmed by the cloud before it is reported. */
export async function createFolder(tx: Tx, ctx: ActorContext, client: CloudClient, config: settings.CloudSettings, input: CreateFolderInput): Promise<FolderMade> {
  await permit(ctx, 'create', FILES_OBJECT, null);
  const parent = assertWithin(config.rootPath, input.parent);
  let path: string;
  try {
    path = joinPath(parent, input.name);
  } catch (error) {
    throw new AdminValidationError('name', error instanceof Error ? error.message : String(error));
  }
  assertWithin(config.rootPath, path);
  try {
    await client.mkcol(path);
  } catch (error) {
    if (error instanceof CloudConflictError) throw new AdminValidationError('name', 'is already taken in this folder, or the folder is not there any more');
    throw error;
  }
  const entry = await client.stat(path);
  if (!entry || !entry.isFolder) throw new CloudRequestError('Cloud Files did not confirm the new folder.', null);

  const shares = input.shareWithMapped ? await shareWith(client, path, sharesFor(await activeMappings(tx), null)) : [];
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cloud_file.folder_created',
    objectType: 'cloud_file',
    objectId: entry.fileId ?? path,
    branchCode: ctx.branchCode,
    after: { path, shares: shares.map((s) => `${s.group}:${s.outcome}`) },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return { entry, shares };
}

export interface RecordFolder {
  readonly entry: CloudEntry;
  readonly created: boolean;
  readonly shares: readonly ShareResult[];
  readonly link: LinkRow;
}

/**
 * The folder for one ERP record: `<record root>/<kind>/<number>`, made if it is
 * not there, shared with the groups of the roles that may open that kind of
 * record, and linked to the record so it appears behind its paperclip.
 */
export async function ensureRecordFolder(tx: Tx, ctx: ActorContext, client: CloudClient, config: settings.CloudSettings, record: RecordRef): Promise<RecordFolder> {
  await permit(ctx, 'create', FILES_OBJECT, record.id);
  const target = targetOf(record.type);
  if (!target) throw new CloudLinkError('That kind of record has no folder in Cloud Files.');
  const kindFolder = joinPath(config.recordRoot, target.folderName);
  const path = joinPath(kindFolder, folderNameForRecord(record.label));
  assertWithin(config.rootPath, path);

  const madeParents = await client.ensureFolder(kindFolder);
  void madeParents;
  const existing = await client.stat(path);
  let created = false;
  if (!existing) {
    await client.mkcol(path);
    created = true;
  } else if (!existing.isFolder) {
    throw new CloudConflictError(`"${path}" is a file, not a folder.`, 409);
  }
  const entry = await client.stat(path);
  if (!entry || !entry.isFolder) throw new CloudRequestError('Cloud Files did not confirm the record folder.', null);

  const roles = await rolesThatMayOpen(tx, target.object);
  const shares = await shareWith(client, path, sharesFor(await activeMappings(tx), roles));
  const link = await linkEntry(tx, ctx, client.baseUrl, entry, record);
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: created ? 'cloud_file.record_folder_created' : 'cloud_file.record_folder_shared',
    objectType: record.auditObject,
    objectId: record.id,
    branchCode: record.branchCode ?? ctx.branchCode,
    after: { path, shares: shares.map((s) => `${s.group}:${s.outcome}`) },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return { entry, created, shares, link };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export class UploadRefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'UploadRefusedError';
  }
}

/**
 * What may be said about an upload before a byte leaves for the cloud: the
 * name, the size and the first bytes. Executables and bare archives are
 * refused as the paperclip refuses them (§21) — a cloud folder shared with a
 * group is a way to put a file in front of the whole company.
 */
export function assertUploadAllowed(fileName: string, length: number, head: Buffer): void {
  try {
    assertFileName(fileName);
  } catch (error) {
    throw new UploadRefusedError(error instanceof Error ? error.message : String(error));
  }
  if (!Number.isInteger(length) || length <= 0) throw new UploadRefusedError(`${fileName} was not accepted: it is empty.`);
  if (length > MAX_UPLOAD_BYTES) {
    throw new UploadRefusedError(`${fileName} was not accepted: it is ${Math.ceil(length / 1024 / 1024)} MB; the limit is ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)} MB.`);
  }
  const extension = extensionOf(fileName);
  if (DEFAULT_UPLOAD_POLICY.blockedExtensions.includes(extension)) {
    throw new UploadRefusedError(`${fileName} was not accepted: files ending .${extension} are not accepted.`);
  }
  const inspection = inspect(head);
  if (inspection.isExecutable) {
    throw new UploadRefusedError(`${fileName} was not accepted: its content is ${inspection.executableLabel}. Renaming it does not change what it is.`);
  }
}

/**
 * Reads the first bytes of a stream without losing them: returns them, and a
 * stream that yields them again followed by the rest.
 */
export async function peek(stream: ReadableStream<Uint8Array>, bytes = 4096): Promise<{ head: Buffer; whole: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  while (size < bytes && !done) {
    const next = await reader.read();
    if (next.done) done = true;
    else {
      chunks.push(next.value);
      size += next.value.length;
    }
  }
  const head = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).subarray(0, bytes);
  const whole = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      if (done) return;
      const next = await reader.read();
      if (next.done) {
        done = true;
        controller.close();
      } else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, whole };
}

export interface UploadedFile {
  readonly entry: CloudEntry;
}

/**
 * Sends one file to the cloud and says so only when the cloud confirms it:
 * a 201/204 to the PUT *and* a listing that shows the file at the size sent.
 * Nothing is overwritten (`If-None-Match: *`); a name already taken is refused.
 */
export async function sendToCloud(client: CloudClient, config: settings.CloudSettings, input: { directory: string; fileName: string; length: number; mime: string | null; head: Buffer; body: ReadableStream<Uint8Array> }): Promise<UploadedFile> {
  assertUploadAllowed(input.fileName, input.length, input.head);
  const directory = assertWithin(config.rootPath, input.directory);
  const path = joinPath(directory, input.fileName);
  try {
    await client.put(path, input.body, input.length, input.mime);
  } catch (error) {
    if (error instanceof CloudConflictError) {
      throw new UploadRefusedError(`${input.fileName} was not uploaded: a file with that name is already there, or the folder is not.`);
    }
    throw error;
  }
  const entry = await client.stat(path);
  if (!entry || entry.isFolder || (entry.size !== null && entry.size !== input.length)) {
    throw new CloudRequestError('Cloud Files did not confirm the upload, so it is not counted as uploaded. Try again.', null);
  }
  return { entry };
}

/** The audit row for a confirmed upload, and the link if it was made from a record. */
export async function recordUpload(tx: Tx, ctx: ActorContext, client: CloudClient, uploaded: UploadedFile, link: RecordRef | null): Promise<LinkRow | null> {
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cloud_file.uploaded',
    objectType: 'cloud_file',
    objectId: uploaded.entry.fileId ?? uploaded.entry.path,
    branchCode: ctx.branchCode,
    after: { path: uploaded.entry.path, sizeBytes: uploaded.entry.size, contentType: uploaded.entry.mime },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
  return link ? linkEntry(tx, ctx, client.baseUrl, uploaded.entry, link) : null;
}

// ---------------------------------------------------------------------------
// Download and preview
// ---------------------------------------------------------------------------

export async function recordDownload(tx: Tx, ctx: ActorContext, entry: CloudEntry): Promise<void> {
  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'cloud_file.downloaded',
    objectType: 'cloud_file',
    objectId: entry.fileId ?? entry.path,
    branchCode: ctx.branchCode,
    after: { path: entry.path, sizeBytes: entry.size },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
    clientIp: ctx.clientIp ?? null,
  });
}

export { CloudPathError, normaliseCloudPath, parentOf, recordChange };
