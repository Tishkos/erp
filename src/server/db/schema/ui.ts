/**
 * Saved views — Phase 01.12, Appendix A global UI rule 1.
 *
 * *"Every list supports permission-controlled search, filters, sorting, saved
 * views and export."*
 *
 * A saved view stores a query, not a result set. Storing rows would make the
 * view a snapshot that quietly goes stale, and would let someone share rows
 * they may see with someone who may not. Storing the query means the person
 * opening it runs it as themselves — their permissions, their data scope — so a
 * shared view is a shared *question*, never a shared answer.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser } from './platform';

export const savedView = pgTable(
  'saved_view',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The list this view belongs to — `ListDefinition.key`. */
    listKey: text('list_key').notNull(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id),
    /**
     * Shared views are visible to everyone; the query still runs under the
     * reader's own permissions and scope, so sharing widens who can ask, never
     * what they may see.
     */
    isShared: boolean('is_shared').notNull().default(false),
    /** The user's default for this list. At most one, enforced below. */
    isDefault: boolean('is_default').notNull().default(false),
    /**
     * The `RawListQuery` — search, filters, sort, page size. Validated against
     * the list definition every time it is opened, never trusted from storage:
     * the list may have lost a column since it was saved, and the reader is not
     * necessarily the author.
     */
    query: jsonb('query').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('saved_view_name_uniq').on(t.ownerUserId, t.listKey, t.name),
    index('saved_view_list_idx').on(t.listKey, t.ownerUserId),
    // One default per user per list — a partial unique index, so "which view
    // opens?" has exactly one answer rather than a first-row-wins race.
    uniqueIndex('saved_view_default_uniq')
      .on(t.ownerUserId, t.listKey)
      .where(sql`${t.isDefault}`),
    check('saved_view_name_present', sql`btrim(${t.name}) <> ''`),
  ],
);
