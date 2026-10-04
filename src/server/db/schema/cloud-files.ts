/**
 * QS Cloud Files — the Document Center's connection (Platform phase, Agent 4).
 * Migrations 0320 (settings, mapping, accounts), 0321 (links), 0322 (grants).
 *
 * Nextcloud keeps the files; these tables keep only what Qimah needs to ask
 * it on a person's behalf and to remember which files belong to which ERP
 * records. No bytes, no copy of the cloud's tree.
 *
 *   cloud_setting        the one row: on/off, address, where things start
 *   cloud_group_mapping  ERP role -> Nextcloud group (+ write, + share)
 *   cloud_account        a person's app password, sealed with ERP_SECRET_KEY
 *   cloud_link_attempt   a Login Flow v2 begun and not yet finished
 *   cloud_file_link      cloud file id <-> (record type, record id)
 */
import { boolean, index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { appUser, branch, role } from './platform';

export const cloudSetting = pgTable('cloud_setting', {
  id: smallint('id').primaryKey().default(1),
  enabled: boolean('enabled').notNull().default(false),
  baseUrl: text('base_url'),
  rootPath: text('root_path').notNull().default('/'),
  recordRoot: text('record_root').notNull().default('/Qimah'),
  updatedBy: uuid('updated_by').references(() => appUser.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cloudGroupMapping = pgTable('cloud_group_mapping', {
  roleCode: text('role_code')
    .primaryKey()
    .references(() => role.code),
  groupName: text('group_name').notNull(),
  canWrite: boolean('can_write').notNull().default(false),
  canShare: boolean('can_share').notNull().default(false),
  active: boolean('active').notNull().default(true),
  deactivatedReason: text('deactivated_reason'),
  updatedBy: uuid('updated_by').references(() => appUser.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const cloudAccount = pgTable('cloud_account', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => appUser.id),
  serverUrl: text('server_url').notNull(),
  cloudUser: text('cloud_user').notNull(),
  displayName: text('display_name'),
  /** The app password, sealed (`v1.<iv>.<tag>.<ciphertext>`). */
  secret: text('secret').notNull(),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  lastOkAt: timestamp('last_ok_at', { withTimezone: true }),
  lastError: text('last_error'),
});

export const cloudLinkAttempt = pgTable('cloud_link_attempt', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => appUser.id),
  serverUrl: text('server_url').notNull(),
  pollEndpoint: text('poll_endpoint').notNull(),
  /** Sealed. */
  pollToken: text('poll_token').notNull(),
  loginUrl: text('login_url').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

export const cloudFileLink = pgTable(
  'cloud_file_link',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverUrl: text('server_url').notNull(),
    fileId: text('file_id').notNull(),
    name: text('name').notNull(),
    isFolder: boolean('is_folder').notNull().default(false),
    path: text('path').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id').notNull(),
    recordLabel: text('record_label').notNull(),
    branchCode: text('branch_code').references(() => branch.code),
    linkedBy: uuid('linked_by')
      .notNull()
      .references(() => appUser.id),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
    unlinkedBy: uuid('unlinked_by').references(() => appUser.id),
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    unlinkReason: text('unlink_reason'),
  },
  (table) => [
    uniqueIndex('cloud_file_link_live_uniq')
      .on(table.serverUrl, table.fileId, table.objectType, table.objectId)
      .where(sql`${table.unlinkedAt} is null`),
    index('cloud_file_link_record_idx')
      .on(table.objectType, table.objectId)
      .where(sql`${table.unlinkedAt} is null`),
    index('cloud_file_link_file_idx')
      .on(table.serverUrl, table.fileId)
      .where(sql`${table.unlinkedAt} is null`),
  ],
);
