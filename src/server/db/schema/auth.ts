/**
 * Authentication tables — Phase 01.1.
 *
 * These are better-auth's own models, named in our convention and mapped back
 * through its `modelName`/`fields` options. The library owns the protocol; the
 * schema stays ours, so `app_user` remains the business identity every other
 * table references and does not become a copy of somebody else's user table.
 *
 * ── Why sessions live in the database ───────────────────────────────────────
 * TECHSTACK B1 chose better-auth "with database-backed sessions, not stateless
 * JWTs", and §25 is the reason: "session expiry and **immediate** revocation".
 * A signed token carries its own validity and cannot be withdrawn before it
 * expires — the 01.1 gate ("revoking a session terminates access on the next
 * request, not at token expiry") is unachievable with one. A row can be marked
 * revoked, and the next request reads the row.
 */
import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  check,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser } from './platform';

export const authSession = pgTable(
  'auth_session',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),

    /**
     * The session token, **hashed**. better-auth is configured to store what it
     * looks up; the raw value only ever exists in the cookie. A database dump
     * should not be a set of live sessions.
     */
    token: text('token').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /** §5.4 — "source device/session where available". */
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),

    /**
     * §25 — immediate revocation. Our addition to better-auth's model: it
     * deletes sessions, and a deleted session cannot be asked *why* it ended.
     * An administrator revoking someone's access, and an auditor reading it
     * back later, both need the row to survive.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => appUser.id),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('auth_session_token_uniq').on(t.token),
    index('auth_session_user_idx').on(t.userId, t.expiresAt),
    check(
      'auth_session_revocation_complete',
      sql`(${t.revokedAt} is null) = (${t.revokedReason} is null)`,
    ),
  ],
);

/**
 * Credentials. better-auth's `account` model: one row per sign-in method.
 *
 * `password` holds a hash and nothing else — the 01.1 gate is "credentials are
 * not recoverable from the database in plaintext or reversible form", and the
 * column is named for what better-auth calls it, not for what it contains.
 */
export const authAccount = pgTable(
  'auth_account',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),

    /** The identifier at the provider. For a password account, the user id. */
    accountId: text('account_id').notNull(),
    /** 'credential' for a password; an issuer name for anything federated. */
    providerId: text('provider_id').notNull(),

    /** A hash. Never a password. */
    password: text('password'),

    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('auth_account_provider_uniq').on(t.providerId, t.accountId),
    index('auth_account_user_idx').on(t.userId),
  ],
);

/** better-auth's `verification` model: e-mail confirmations and reset tokens. */
export const authVerification = pgTable(
  'auth_verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('auth_verification_identifier_idx').on(t.identifier, t.expiresAt)],
);

/**
 * §25 — the second factor, for privileged and high-risk roles.
 *
 * The shared secret is stored here rather than on `app_user` so that the user
 * record can be read freely without carrying a credential alongside it.
 *
 * **The secret is not yet encrypted at rest.** §25 requires "sensitive data
 * encrypted at rest with keys managed separately from application code", and
 * key management is Phase 20.2. This column is a known gap, recorded here
 * rather than in someone's memory.
 */
export const userMfa = pgTable(
  'user_mfa',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** Base32, RFC 4648 — what an authenticator app expects. */
    secret: text('secret').notNull(),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('user_mfa_secret_present', sql`length(${t.secret}) >= 16`)],
);

/**
 * REQ-HARDEN-001 HD3 — every sign-in, succeeded or refused, with where it
 * came from. The lockout counts the failures here (D-HD-3: five in fifteen
 * minutes for one account from one address); the login-history screen reads
 * it. Written and read, never changed.
 */
export const signInAttempt = pgTable(
  'sign_in_attempt',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    email: text('email').notNull(),
    userId: uuid('user_id').references(() => appUser.id),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    outcome: text('outcome').$type<SignInOutcome>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sign_in_attempt_email_idx').on(t.email, t.occurredAt),
    index('sign_in_attempt_ip_idx').on(t.ipAddress, t.occurredAt),
  ],
);

export type SignInOutcome =
  | 'success'
  | 'failed'
  | 'locked'
  | 'temporary_expired'
  | 'second_factor_required'
  | 'second_factor_wrong'
  | 'second_factor_not_enrolled'
  | 'inactive';
