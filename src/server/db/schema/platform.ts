/**
 * Platform core schema — Phase 01.
 *
 * Covers 01.1 (identity record), 01.2 (permissions and data scope), 01.3 (the
 * Department Manager toggle), 01.4 (audit) and 01.5 (numbering).
 *
 * What Drizzle cannot express — RLS policies, append-only triggers, REVOKEs,
 * the numbering functions — is hand-appended to the generated migration and
 * reviewed as part of the §25 release record. Those are the actual controls;
 * this file is the type surface over them.
 *
 * Branch and Department are declared here rather than in Phase 03 because
 * §5.1 scopes every user by branch and department, so Phase 01.2 cannot be
 * built or tested without them. Phase 03 (§4.1) extends these rows with the
 * organisation-structure attributes; it does not replace them.
 */
import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  bigint,
  boolean,
  check,
  index,
  inet,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { PERMISSION_VERBS } from '../../domain/permissions';

/** §5.3 — the thirteen verbs. The domain owns the list; this mirrors it. */
export const permissionVerb = pgEnum('permission_verb', PERMISSION_VERBS);

/** §25 — every attempt is audited, including the ones that were refused. */
export const auditOutcome = pgEnum('audit_outcome', ['success', 'denied', 'failure']);

// ---------------------------------------------------------------------------
// Organisation units that data scope hangs from (§5.1)
// ---------------------------------------------------------------------------

export const branch = pgTable('branch', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),

  // §4.1 attributes, added in Phase 03. The foreign keys to warehouse and to
  // the cash account are declared in migration 0010 rather than here: warehouse
  // references branch and branch references warehouse, and stating both in
  // TypeScript would be an import cycle. The database has no such difficulty.
  address: text('address'),
  managerUserId: uuid('manager_user_id'),
  /** §4.1 — the warehouse a branch's stock movements default to. */
  defaultWarehouseCode: text('default_warehouse_code'),
  /** §4.1 — the cash account a branch's receipts default to. Master is 03.5. */
  defaultCashAccountId: uuid('default_cash_account_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const department = pgTable('department', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  active: boolean('active').notNull().default(true),

  /** §4.1 — departments form a hierarchy. A cycle is refused by trigger. */
  parentCode: text('parent_code').references((): AnyPgColumn => department.code),
  managerUserId: uuid('manager_user_id').references((): AnyPgColumn => appUser.id),
  /**
   * §14 — "Journal Entries belong exclusively to the Finance Department."
   *
   * A flag rather than a well-known code, so "which department is Finance?" is
   * configuration the Business Process Owner sets, not a string this code
   * assumes. More than one may carry it: a group with two finance functions is
   * a structure question, not a technical one.
   */
  isFinance: boolean('is_finance').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// 01.1 — identity
//
// Credentials, sessions and MFA are better-auth's tables, added when 01.1 is
// wired. This is the *business* identity every other table references: it must
// exist first, and it must survive an identity-provider change without
// rewriting every foreign key in the system.
// ---------------------------------------------------------------------------

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    /** §5.1 — "Super Users retain full administration access." */
    isSuperUser: boolean('is_super_user').notNull().default(false),
    /**
     * This person's own look — null follows the company default. 0172.
     * Checked like the company's: an unknown name would strip the styling
     * from every screen this person opens.
     */
    uiPalette: text('ui_palette'),
    uiAccent: text('ui_accent'),
    /** Deactivation, never deletion — §1.1 "No deletion of saved or posted records." */
    isActive: boolean('is_active').notNull().default(true),

    // Phase 01.1 — the fields authentication needs. `emailVerified` and `image`
    // are better-auth's own; the rest are §25's.
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    /** §25 — "temporary-password setup, forced change". */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** A6 — optimistic concurrency. */
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('app_user_email_uniq').on(sql`lower(${t.email})`),
    check('app_user_email_shape', sql`position('@' in ${t.email}) > 1`),
    check(
      'app_user_ui_palette_known',
      sql`${t.uiPalette} is null or ${t.uiPalette} in ('sand', 'classic', 'slate', 'graphite', 'pearl', 'midnight', 'carbon', 'ocean', 'obsidian_plum', 'evergreen', 'espresso', 'lunar_slate', 'ivory_linen', 'glacier', 'sage_white', 'porcelain_rose', 'dune_bronze', 'harbor_mist')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 01.2 — roles, grants and scope
// ---------------------------------------------------------------------------

export const role = pgTable('role', {
  code: text('code').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  /** System roles are referenced by the platform and cannot be deleted. */
  isSystem: boolean('is_system').notNull().default(false),
  /**
   * §25 — "multi-factor authentication for privileged and high-risk roles."
   *
   * Which roles those are is the Business Process Owner's decision (§28), so it
   * is a flag rather than a list in code. Super User is in scope regardless:
   * §5.1 gives it full administration access, which is what privileged means.
   */
  requiresMfa: boolean('requires_mfa').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per (role, object, verb).
 *
 * There is no "deny" row and no wildcard: a grant that is absent is a denial,
 * which is what §25's deny-by-default means. Adding a deny row would create two
 * ways to express the same outcome and a precedence rule to argue about.
 */
export const roleGrant = pgTable(
  'role_grant',
  {
    roleCode: text('role_code')
      .notNull()
      .references(() => role.code, { onDelete: 'cascade' }),
    object: text('object').notNull(),
    verb: permissionVerb('verb').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleCode, t.object, t.verb] })],
);

export const userRole = pgTable(
  'user_role',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    roleCode: text('role_code')
      .notNull()
      .references(() => role.code, { onDelete: 'cascade' }),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    grantedBy: uuid('granted_by').references(() => appUser.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleCode] })],
);

/** §5.1 — branch data scope. No rows means no branches, never all branches. */
export const userBranchScope = pgTable(
  'user_branch_scope',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    branchCode: text('branch_code')
      .notNull()
      .references(() => branch.code),
    /**
     * The branch this user works in unless they switch (01.12).
     *
     * A user with several branches has to land in one of them, and a new
     * document defaults to the branch of the session it was raised in. Leaving
     * that to row order would make which branch a document posts against depend
     * on the query plan, so it is a stated fact instead. At most one per user,
     * enforced by a partial unique index in the migration.
     */
    isDefault: boolean('is_default').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.branchCode] }),
    uniqueIndex('user_branch_scope_default_uniq').on(t.userId).where(sql`${t.isDefault}`),
  ],
);

/**
 * §5.2 — department assignment, with the Department Manager toggle held **per
 * department**. A user may manage Finance and be an ordinary user in Sales;
 * that is one row each, and the flag is on the row, not on the user.
 */
export const userDepartmentScope = pgTable(
  'user_department_scope',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    departmentCode: text('department_code')
      .notNull()
      .references(() => department.code),
    isManager: boolean('is_manager').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.userId, t.departmentCode] })],
);

// ---------------------------------------------------------------------------
// 01.4 — audit
//
// Append-only at the database level: the app role holds SELECT and INSERT only,
// and a trigger rejects UPDATE and DELETE from every role including the owner.
// §5.4: "Audit entries cannot be edited or deleted by application users."
// ---------------------------------------------------------------------------

export const auditEvent = pgTable(
  'audit_event',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    /** Stamped by the database — an event cannot be back-dated by its caller. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** Null only before authentication: a failed sign-in has no actor yet. */
    actorUserId: uuid('actor_user_id').references(() => appUser.id),
    action: text('action').notNull(),
    objectType: text('object_type').notNull(),
    objectId: text('object_id'),
    branchCode: text('branch_code').references(() => branch.code),
    beforeValue: jsonb('before_value'),
    afterValue: jsonb('after_value'),
    reason: text('reason'),
    outcome: auditOutcome('outcome').notNull(),
    /** Fingerprinted, never the raw session key — §25. */
    sessionId: text('session_id'),
    requestId: text('request_id'),
    clientIp: inet('client_ip'),
    /** §5.4 — "links to original and reversing documents". */
    relatedObjectId: text('related_object_id'),
  },
  (t) => [
    index('audit_event_object_idx').on(t.objectType, t.objectId, t.occurredAt),
    index('audit_event_actor_idx').on(t.actorUserId, t.occurredAt),
    index('audit_event_action_idx').on(t.action, t.occurredAt),
  ],
);

// ---------------------------------------------------------------------------
// 01.5 — document numbering
//
// The counter is a PostgreSQL sequence, created on demand per scope. Sequences
// do not roll back, so a number is never reused (§14.2) and a failed document
// leaves a gap that `document_number_gaps()` reports (§24).
// ---------------------------------------------------------------------------

export const docSequence = pgTable(
  'doc_sequence',
  {
    key: text('key').primaryKey(),
    prefix: text('prefix').notNull(),
    /** Template over {PREFIX} {BRANCH} {YY} {YYYY} {SERIAL}. */
    pattern: text('pattern').notNull(),
    padding: smallint('padding').notNull().default(6),
    /** Reset rules — §4.3. */
    scopeBranch: boolean('scope_branch').notNull().default(false),
    scopeYear: boolean('scope_year').notNull().default(false),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    check('doc_sequence_pattern_has_serial', sql`${t.pattern} like '%{SERIAL}%'`),
    check('doc_sequence_padding_range', sql`${t.padding} between 1 and 18`),
    // A sequence that resets per branch but does not print the branch would
    // mint the same number twice. Rejected at configuration time.
    check(
      'doc_sequence_branch_pattern',
      sql`not ${t.scopeBranch} or ${t.pattern} like '%{BRANCH}%'`,
    ),
    check(
      'doc_sequence_year_pattern',
      sql`not ${t.scopeYear} or (${t.pattern} like '%{YY}%' or ${t.pattern} like '%{YYYY}%')`,
    ),
  ],
);

/**
 * The committed record of every number that reached a document.
 *
 * Rolled back with its document, deliberately — the difference between the
 * sequence's position and the rows here *is* the gap report.
 */
export const docNumberAllocation = pgTable(
  'doc_number_allocation',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity().primaryKey(),
    sequenceKey: text('sequence_key')
      .notNull()
      .references(() => docSequence.key),
    /** Branch/year discriminator; empty string when the sequence never resets. */
    scopeKey: text('scope_key').notNull(),
    serial: bigint('serial', { mode: 'bigint' }).notNull(),
    documentNo: text('document_no').notNull(),
    allocatedAt: timestamp('allocated_at', { withTimezone: true }).notNull().defaultNow(),
    allocatedBy: uuid('allocated_by').references(() => appUser.id),
  },
  (t) => [
    uniqueIndex('doc_number_allocation_serial_uniq').on(t.sequenceKey, t.scopeKey, t.serial),
    uniqueIndex('doc_number_allocation_document_no_uniq').on(t.documentNo),
  ],
);
