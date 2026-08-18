/**
 * Attachments — Phase 01.8.
 *
 * §21: "stored using an immutable object identifier and linked to the parent
 * record; later versions do not overwrite prior versions."
 *
 * The parent is referenced as `(object_type, object_id)` text rather than by
 * foreign key, because an attachment hangs off anything — a journal, a partner,
 * a purchase order that does not exist yet. What that costs is referential
 * integrity; what it buys is that Phase 05 does not have to alter this table to
 * attach a delivery note. The access check pays the cost back: a row here means
 * nothing until the parent says who may see it.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { SCAN_STATUSES } from '../../domain/attachments';
import { appUser } from './platform';

export const scanStatus = pgEnum('attachment_scan_status', SCAN_STATUSES);

export const attachment = pgTable(
  'attachment',
  {
    /** §21's "immutable object identifier". Never reused, never re-pointed. */
    id: uuid('id').primaryKey().defaultRandom(),

    /** The record this belongs to. Text, so any module can attach to anything. */
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),

    fileName: text('file_name').notNull(),
    /** What the **content** says it is, not what the name claimed. */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** TECHSTACK A7 — SHA-256, so a duplicate upload is recognisable. */
    sha256: text('sha256').notNull(),

    /** Where the bytes live. Derived from the id and hash; never from the name. */
    storageKey: text('storage_key').notNull(),

    /** §21 — versions accumulate; they do not overwrite. */
    version: integer('version').notNull().default(1),
    /** The version this one replaced. Null for the first. */
    supersedesId: uuid('supersedes_id'),
    /** Set when a later version replaced this one. Both stay retrievable. */
    supersededById: uuid('superseded_by_id'),

    /**
     * §21 — the malware scan. An attachment is not linked to its parent until
     * this says `clean`; anything else is quarantined and invisible to the
     * document.
     */
    scanStatus: scanStatus('scan_status').notNull().default('pending'),
    scanDetail: text('scan_detail'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),

    /** §21 — retention metadata and legal hold. */
    retentionUntil: date('retention_until'),
    legalHold: boolean('legal_hold').notNull().default(false),
    disposedAt: timestamp('disposed_at', { withTimezone: true }),
    disposedBy: uuid('disposed_by').references(() => appUser.id),

    uploadedBy: uuid('uploaded_by')
      .notNull()
      .references(() => appUser.id),
    branchCode: text('branch_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The document's own attachment list: current versions of a parent.
    index('attachment_parent_idx').on(t.objectType, t.objectId, t.version),
    index('attachment_hash_idx').on(t.sha256),
    uniqueIndex('attachment_storage_key_uniq').on(t.storageKey),

    // A version chain is linear: one predecessor, one successor.
    uniqueIndex('attachment_supersedes_uniq')
      .on(t.supersedesId)
      .where(sql`${t.supersedesId} is not null`),

    check('attachment_size_positive', sql`${t.sizeBytes} > 0`),
    check('attachment_version_positive', sql`${t.version} >= 1`),
    check('attachment_hash_shape', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    // A scan result and its timestamp arrive together.
    check(
      'attachment_scan_result_complete',
      sql`(${t.scanStatus} = 'pending') = (${t.scannedAt} is null)`,
    ),
    // §21 — disposal is an audited administrative action, so it names an actor.
    check(
      'attachment_disposal_complete',
      sql`(${t.disposedAt} is null) = (${t.disposedBy} is null)`,
    ),
    // A held document is not disposed of, whatever its retention date says.
    check(
      'attachment_hold_blocks_disposal',
      sql`not (${t.legalHold} and ${t.disposedAt} is not null)`,
    ),
  ],
);

/**
 * §21 — "Every upload, download and replacement is in the audit trail."
 *
 * Downloads are recorded here rather than only in `audit_event` because a
 * download is high-volume and needs its own index: "who has read this
 * contract?" is a question asked of a document, not of the whole trail.
 */
export const attachmentAccess = pgTable(
  'attachment_access',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachment.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id),
    /** 'download', 'view', 'link_issued'. */
    action: text('action').notNull(),
    /** Set when access was refused, with the reason. */
    denied: boolean('denied').notNull().default(false),
    reason: text('reason'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('attachment_access_attachment_idx').on(t.attachmentId, t.occurredAt),
    index('attachment_access_user_idx').on(t.userId, t.occurredAt),
    check('attachment_access_denial_has_reason', sql`(not ${t.denied}) or ${t.reason} is not null`),
  ],
);
