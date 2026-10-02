/**
 * Attachment service — Phase 01.8.
 *
 * §21 acceptance: "Users cannot access an attachment when they cannot access
 * its parent record."
 *
 * ── How that is made true rather than promised ──────────────────────────────
 * An attachment has no access rules of its own. Every read asks the **parent's**
 * module whether this person may see the parent, and a parent type with no
 * registered answer is denied — §25's deny-by-default, applied to a table that
 * would otherwise be a way around every permission in the system.
 *
 * That is why `objectType`/`objectId` are loose text: the check is not a join,
 * it is a question put to whoever owns the record.
 */
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  AttachmentAccessError,
  DEFAULT_UPLOAD_POLICY,
  assertCanSupersede,
  assertDisposable,
  assertUploadAcceptable,
  contentHash,
  nextVersion,
  storageKeyFor,
  type ScanStatus,
  type UploadPolicy,
} from '../domain/attachments';
import { attachment, attachmentAccess } from '../db/schema';
import { applyScope, db, type Tx } from '../db/client';
import type { Principal } from '../domain/permissions';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import * as authz from './authorization';
import { businessToday } from '../domain/business-date';

export const PERMISSION_OBJECT = 'attachment';

// ---------------------------------------------------------------------------
// Storage — TECHSTACK A7
// ---------------------------------------------------------------------------

/**
 * Where the bytes live.
 *
 * S3 or Cloudflare R2 in a deployment; an in-memory adapter in tests. The
 * interface is deliberately small — put, get, and nothing that can overwrite,
 * because §21 forbids a later version replacing an earlier one and the easiest
 * way to honour that is to have no operation that could.
 */
export interface StorageAdapter {
  put(key: string, content: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

let storage: StorageAdapter | null = null;

export function registerStorage(adapter: StorageAdapter): void {
  storage = adapter;
}

export function clearStorage(): void {
  storage = null;
}

function requireStorage(): StorageAdapter {
  if (!storage) {
    throw new Error(
      'No attachment storage is configured. Register one before accepting uploads (TECHSTACK A7).',
    );
  }
  return storage;
}

// ---------------------------------------------------------------------------
// §21 — malware scanning
// ---------------------------------------------------------------------------

export type MalwareScanner = (
  content: Buffer,
  fileName: string,
) => Promise<{ status: ScanStatus; detail?: string }> | { status: ScanStatus; detail?: string };

let scanner: MalwareScanner | null = null;

/**
 * Registers the scanner.
 *
 * Deliberately required. §21 puts a malware scan in the upload pipeline, and a
 * default that accepted everything would satisfy the type system while removing
 * the control — so an unconfigured deployment refuses uploads rather than
 * accepting them unscanned.
 */
export function registerScanner(implementation: MalwareScanner): void {
  scanner = implementation;
}

export function clearScanner(): void {
  scanner = null;
}

// ---------------------------------------------------------------------------
// §21 — access inherited from the parent
// ---------------------------------------------------------------------------

export type ParentAccessCheck = (
  tx: Tx,
  principal: Principal,
  objectId: string,
) => Promise<boolean> | boolean;

const parentAccessChecks = new Map<string, ParentAccessCheck>();

/**
 * Teaches the attachment service how to ask a module about its own records.
 *
 * A parent type with no registered check is **denied**, not allowed. Without
 * that, attaching a document to an unregistered object type would be a way to
 * read it without any permission at all.
 */
export function registerParentAccessCheck(objectType: string, check: ParentAccessCheck): void {
  parentAccessChecks.set(objectType, check);
}

export function clearParentAccessChecks(): void {
  parentAccessChecks.clear();
}

async function assertParentAccess(
  tx: Tx,
  principal: Principal,
  objectType: string,
  objectId: string,
): Promise<void> {
  const check = parentAccessChecks.get(objectType);

  if (!check) {
    throw new AttachmentAccessError(
      `Access to '${objectType}' attachments cannot be determined, so it is refused (§25). ` +
        'The module that owns that record must register how its access is decided.',
    );
  }

  if (!(await check(tx, principal, objectId))) {
    throw new AttachmentAccessError(
      'You cannot access this attachment because you cannot access the record it belongs to (§21).',
    );
  }
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface UploadInput {
  readonly objectType: string;
  readonly objectId: string;
  readonly fileName: string;
  readonly content: Buffer;
  /** Set to replace an existing attachment; the previous version is kept. */
  readonly supersedesId?: string | null;
  readonly retentionUntil?: string | null;
  readonly policy?: UploadPolicy;
}

export interface UploadResult {
  readonly attachmentId: string;
  readonly version: number;
  readonly scanStatus: ScanStatus;
  readonly quarantined: boolean;
}

/**
 * The §21 upload pipeline, in order: permission, parent access, content
 * inspection, malware scan, store, link.
 *
 * A file that fails its scan is stored and recorded but **never linked** to its
 * parent — the row exists so the attempt is auditable, and its scan status is
 * what keeps it out of every list.
 */
export async function upload(
  tx: Tx,
  ctx: ActorContext,
  input: UploadInput,
): Promise<UploadResult> {
  await authz.authorize(ctx.principal, 'create', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: input.objectId,
    requestId: ctx.requestId ?? null,
  });

  // §21 — the attachment inherits the parent's policy, including at upload:
  // someone who cannot see a journal cannot staple a document to it.
  await assertParentAccess(tx, ctx.principal, input.objectType, input.objectId);

  const inspection = assertUploadAcceptable(
    input.fileName,
    input.content,
    input.policy ?? DEFAULT_UPLOAD_POLICY,
  );

  if (!scanner) {
    throw new Error(
      'No malware scanner is configured, so uploads are refused (§21). Register one before accepting files.',
    );
  }

  const scan = await scanner(input.content, input.fileName);
  const hash = contentHash(input.content);

  let previousVersion = 1;
  if (input.supersedesId) {
    const [previous] = await tx
      .select()
      .from(attachment)
      .where(eq(attachment.id, input.supersedesId))
      .limit(1);

    if (!previous) {
      throw new AttachmentAccessError('The version being replaced does not exist.');
    }

    assertCanSupersede({
      id: previous.id,
      version: previous.version,
      supersededById: previous.supersededById,
      scanStatus: previous.scanStatus,
    });
    previousVersion = nextVersion({
      id: previous.id,
      version: previous.version,
      supersededById: previous.supersededById,
      scanStatus: previous.scanStatus,
    });
  }

  const attachmentId = crypto.randomUUID();
  const storageKey = storageKeyFor(attachmentId, hash);

  // Stored before the row exists, so a row never points at bytes that are not
  // there. The reverse — bytes with no row — is recoverable; a dangling
  // reference is not.
  await requireStorage().put(storageKey, input.content);

  await tx.insert(attachment).values({
    id: attachmentId,
    objectType: input.objectType,
    objectId: input.objectId,
    fileName: input.fileName,
    // What the content says it is, not what the uploader called it.
    contentType: inspection.detectedContentType ?? 'application/octet-stream',
    sizeBytes: input.content.length,
    sha256: hash,
    storageKey,
    version: input.supersedesId ? previousVersion : 1,
    supersedesId: input.supersedesId ?? null,
    scanStatus: scan.status,
    scanDetail: scan.detail ?? null,
    scannedAt: new Date(),
    retentionUntil: input.retentionUntil ?? null,
    uploadedBy: ctx.principal.userId,
    branchCode: ctx.branchCode,
  });

  const quarantined = scan.status !== 'clean';

  // The link is made only by a clean file. A quarantined one is recorded and
  // invisible to the document it was aimed at.
  if (!quarantined && input.supersedesId) {
    await tx
      .update(attachment)
      .set({ supersededById: attachmentId })
      .where(eq(attachment.id, input.supersedesId));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: quarantined ? 'attachment.quarantined' : 'attachment.uploaded',
    objectType: PERMISSION_OBJECT,
    objectId: attachmentId,
    branchCode: ctx.branchCode,
    after: {
      parent: `${input.objectType}:${input.objectId}`,
      fileName: input.fileName,
      contentType: inspection.detectedContentType,
      sizeBytes: input.content.length,
      sha256: hash,
      version: input.supersedesId ? previousVersion : 1,
      scanStatus: scan.status,
    },
    reason: quarantined ? (scan.detail ?? 'Failed malware scan') : null,
    outcome: quarantined ? 'failure' : 'success',
    requestId: ctx.requestId ?? null,
  });

  return {
    attachmentId,
    version: input.supersedesId ? previousVersion : 1,
    scanStatus: scan.status,
    quarantined,
  };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Records a refused read on its own connection.
 *
 * The caller is about to throw, so its transaction is about to roll back — and
 * a denial written inside it would roll back with the thing it was recording.
 * The same reasoning as the refused-request audit in 01.4: the attempt that
 * failed is the one worth keeping.
 */
async function recordDenial(
  attachmentId: string,
  userId: string,
  reason: string,
  branchCode: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    // HD5 / A11 — the access table is behind row-level security now; a
    // connection with no scope could not write the denial.
    await applyScope(tx, { userId, branchCode });
    await tx.insert(attachmentAccess).values({
      attachmentId,
      userId,
      action: 'download',
      denied: true,
      reason,
    });
  });
}

/**
 * Fetches the bytes, after asking the parent's module whether this person may.
 *
 * §21's acceptance criterion is that knowing the object id is not enough — so
 * the check happens here, on every fetch, and a refusal is recorded. A refused
 * read is the interesting one.
 */
export async function download(
  tx: Tx,
  ctx: ActorContext,
  attachmentId: string,
): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  const [row] = await tx
    .select()
    .from(attachment)
    .where(eq(attachment.id, attachmentId))
    .limit(1);

  if (!row) {
    throw new AttachmentAccessError('No such attachment.');
  }

  try {
    await authz.authorize(ctx.principal, 'view', PERMISSION_OBJECT, {
      branchCode: ctx.branchCode,
      objectId: attachmentId,
      requestId: ctx.requestId ?? null,
    });
    await assertParentAccess(tx, ctx.principal, row.objectType, row.objectId);
  } catch (error) {
    await recordDenial(
      attachmentId,
      ctx.principal.userId,
      error instanceof Error ? error.message : String(error),
      ctx.branchCode,
    );
    throw error;
  }

  if (row.scanStatus !== 'clean') {
    await recordDenial(
      attachmentId,
      ctx.principal.userId,
      `Quarantined: scan status is ${row.scanStatus}`,
      ctx.branchCode,
    );
    throw new AttachmentAccessError(
      'This file did not pass its malware scan and cannot be downloaded (§21).',
    );
  }

  if (row.disposedAt) {
    await recordDenial(attachmentId, ctx.principal.userId, 'Disposed of under the retention policy', ctx.branchCode);
    throw new AttachmentAccessError('This document has been disposed of under retention (§21).');
  }

  const content = await requireStorage().get(row.storageKey);
  if (!content) {
    throw new AttachmentAccessError('The stored file could not be read.');
  }

  // §21 — "Every upload, download and replacement is in the audit trail."
  await tx.insert(attachmentAccess).values({
    attachmentId,
    userId: ctx.principal.userId,
    action: 'download',
  });

  return { fileName: row.fileName, contentType: row.contentType, content };
}

/** The attachments a document currently shows: clean, not superseded, not disposed. */
/**
 * How many current files each record of a type carries — one grouped query,
 * for a register that wants to say which entries have their paperwork. The
 * same filters as currentFor, so the count never disagrees with the panel.
 */
export async function countByObject(
  tx: Tx,
  objectType: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await tx
    .select({ objectId: attachment.objectId, n: count() })
    .from(attachment)
    .where(
      and(
        eq(attachment.objectType, objectType),
        eq(attachment.scanStatus, 'clean'),
        isNull(attachment.supersededById),
        isNull(attachment.disposedAt),
      ),
    )
    .groupBy(attachment.objectId);
  return new Map(rows.map((r) => [r.objectId, Number(r.n)]));
}

export async function currentFor(tx: Tx, objectType: string, objectId: string) {
  return tx
    .select()
    .from(attachment)
    .where(
      and(
        eq(attachment.objectType, objectType),
        eq(attachment.objectId, objectId),
        eq(attachment.scanStatus, 'clean'),
        isNull(attachment.supersededById),
        isNull(attachment.disposedAt),
      ),
    )
    .orderBy(asc(attachment.createdAt));
}

/**
 * The whole version chain, oldest first.
 *
 * §21 — earlier versions stay retrievable. An invoice that was attached and
 * then replaced is evidence of what was attached at the time, which is the
 * reason financial systems keep documents at all.
 */
export async function versionsOf(tx: Tx, attachmentId: string) {
  const chain: Array<typeof attachment.$inferSelect> = [];

  let cursor: string | null = attachmentId;
  // Walk back to the first version.
  while (cursor) {
    const [row] = await tx.select().from(attachment).where(eq(attachment.id, cursor)).limit(1);
    if (!row) break;
    chain.unshift(row);
    cursor = row.supersedesId;
  }

  // Then forward from the one asked about.
  let forward: string | null = chain[chain.length - 1]?.supersededById ?? null;
  while (forward) {
    const [row] = await tx.select().from(attachment).where(eq(attachment.id, forward)).limit(1);
    if (!row) break;
    chain.push(row);
    forward = row.supersededById;
  }

  return chain;
}

/** Who has read this document — the question §21's audit requirement answers. */
export async function accessLogFor(tx: Tx, attachmentId: string) {
  return tx
    .select()
    .from(attachmentAccess)
    .where(eq(attachmentAccess.attachmentId, attachmentId))
    .orderBy(desc(attachmentAccess.occurredAt));
}

// ---------------------------------------------------------------------------
// §21 — retention and legal hold
// ---------------------------------------------------------------------------

export async function setLegalHold(
  tx: Tx,
  ctx: ActorContext,
  attachmentId: string,
  hold: boolean,
  reason: string,
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: attachmentId,
    requestId: ctx.requestId ?? null,
  });

  await tx.update(attachment).set({ legalHold: hold }).where(eq(attachment.id, attachmentId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: hold ? 'attachment.legal_hold_placed' : 'attachment.legal_hold_lifted',
    objectType: PERMISSION_OBJECT,
    objectId: attachmentId,
    branchCode: ctx.branchCode,
    after: { legalHold: hold },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** §21 — "disposal is an audited administrative action". */
export async function dispose(
  tx: Tx,
  ctx: ActorContext,
  attachmentId: string,
  reason: string,
  on = businessToday(),
): Promise<void> {
  await authz.authorize(ctx.principal, 'configure', PERMISSION_OBJECT, {
    branchCode: ctx.branchCode,
    objectId: attachmentId,
    requestId: ctx.requestId ?? null,
  });

  const [row] = await tx
    .select()
    .from(attachment)
    .where(eq(attachment.id, attachmentId))
    .limit(1);

  if (!row) throw new AttachmentAccessError('No such attachment.');

  assertDisposable({ retentionUntil: row.retentionUntil, legalHold: row.legalHold }, on);

  await tx
    .update(attachment)
    .set({ disposedAt: new Date(), disposedBy: ctx.principal.userId })
    .where(eq(attachment.id, attachmentId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'attachment.disposed',
    objectType: PERMISSION_OBJECT,
    objectId: attachmentId,
    branchCode: ctx.branchCode,
    before: { retentionUntil: row.retentionUntil, legalHold: row.legalHold },
    after: { disposed: true },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * Everything attached to a record that is being thrown away.
 *
 * An attachment points at its record by type and id rather than by a foreign
 * key, so nothing removes it when that record goes and the rows would linger
 * pointing at nothing — unreachable rather than preserved, which is the worst
 * of both. This is only ever called for a draft: §21's retention rules are
 * about documents that entered the flow, and a draft never did.
 *
 * A legal hold still wins. If somebody has frozen a file, the draft it hangs
 * off cannot be discarded until that is lifted.
 */
export async function discardFor(tx: Tx, objectType: string, objectId: string): Promise<number> {
  const rows = await tx
    .select({ id: attachment.id, legalHold: attachment.legalHold, fileName: attachment.fileName })
    .from(attachment)
    .where(and(eq(attachment.objectType, objectType), eq(attachment.objectId, objectId)));

  if (rows.length === 0) return 0;

  const held = rows.filter((row) => row.legalHold);
  if (held.length > 0) {
    throw new AttachmentAccessError(
      `${held.map((row) => row.fileName).join(', ')} is under legal hold and cannot be removed. ` +
        'Lift the hold before discarding this draft.',
    );
  }

  const ids = rows.map((row) => row.id);
  await tx.delete(attachmentAccess).where(inArray(attachmentAccess.attachmentId, ids));
  await tx.delete(attachment).where(inArray(attachment.id, ids));
  return ids.length;
}
