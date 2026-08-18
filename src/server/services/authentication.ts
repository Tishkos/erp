/**
 * Authentication service — Phase 01.1.
 *
 * better-auth owns the HTTP protocol — cookies, sign-in routes, CSRF. This
 * module owns the rules §25 adds on top of it, and it owns them in one place so
 * that every path into the system asks the same questions:
 *
 *   is the password strong enough, wherever it was set?
 *   is this session still live, on **this** request?
 *   does this account need a second factor, and did it present one?
 *
 * The functions here take the transaction, so a sign-in and the audit record of
 * it commit together.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  SessionInvalidError,
  assertAccountUsable,
  assertPasswordAcceptable,
  assertSecondFactorSatisfied,
  assertSessionUsable,
  base32Encode,
  requiresSecondFactor,
  verifyTotp,
  type PasswordPolicy,
} from '../domain/authentication';
import {
  appUser,
  authAccount,
  authSession,
  role,
  userMfa,
  userRole,
} from '../db/schema';
import { hashPassword, verifyPassword } from '../auth';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';

/** better-auth's name for a password credential. */
const CREDENTIAL_PROVIDER = 'credential';

/** How long a session lives. Mirrors the better-auth configuration. */
const SESSION_SECONDS = 8 * 60 * 60;

export class CredentialsInvalidError extends Error {
  readonly code = 'CREDENTIALS_INVALID';
  constructor() {
    // Deliberately the same message whether the account is unknown or the
    // password is wrong: distinguishing them tells an attacker which e-mail
    // addresses exist.
    super('Those credentials are not valid.');
    this.name = 'CredentialsInvalidError';
  }
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Sets or replaces a password.
 *
 * One function for signup, self-service change and administrative reset — the
 * 01.1 gate says the policy applies "at set time, not only at signup", and the
 * only way to be sure is to have one place where a password can be set.
 */
export async function setPassword(
  tx: Tx,
  userId: string,
  password: string,
  options: { temporary?: boolean; policy?: PasswordPolicy } = {},
): Promise<void> {
  const [user] = await tx.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  if (!user) throw new CredentialsInvalidError();

  assertPasswordAcceptable(
    password,
    { email: user.email, displayName: user.displayName },
    options.policy,
  );

  const hash = await hashPassword(password);

  const [existing] = await tx
    .select({ id: authAccount.id })
    .from(authAccount)
    .where(
      and(eq(authAccount.userId, userId), eq(authAccount.providerId, CREDENTIAL_PROVIDER)),
    )
    .limit(1);

  if (existing) {
    await tx
      .update(authAccount)
      .set({ password: hash, updatedAt: new Date() })
      .where(eq(authAccount.id, existing.id));
  } else {
    await tx.insert(authAccount).values({
      id: randomUUID(),
      userId,
      accountId: userId,
      providerId: CREDENTIAL_PROVIDER,
      password: hash,
    });
  }

  await tx
    .update(appUser)
    .set({
      // §25 — a temporary password must be replaced before the account works.
      mustChangePassword: options.temporary ?? false,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(appUser.id, userId));
}

/** Checks an e-mail and password. Returns the user, or refuses without detail. */
export async function verifyCredentials(
  tx: Tx,
  email: string,
  password: string,
): Promise<typeof appUser.$inferSelect> {
  const [user] = await tx
    .select()
    .from(appUser)
    .where(eq(appUser.email, email.trim().toLowerCase()))
    .limit(1);

  if (!user) throw new CredentialsInvalidError();

  const [credential] = await tx
    .select({ password: authAccount.password })
    .from(authAccount)
    .where(
      and(eq(authAccount.userId, user.id), eq(authAccount.providerId, CREDENTIAL_PROVIDER)),
    )
    .limit(1);

  if (!credential?.password) throw new CredentialsInvalidError();
  if (!(await verifyPassword(password, credential.password))) {
    throw new CredentialsInvalidError();
  }

  assertAccountUsable(user);
  return user;
}

// ---------------------------------------------------------------------------
// §25 — the second factor
// ---------------------------------------------------------------------------

/** Whether this account must present a second factor, and why. */
export async function secondFactorRequirement(tx: Tx, userId: string) {
  const [user] = await tx
    .select({ isSuperUser: appUser.isSuperUser })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);

  const roles = await tx
    .select({ code: role.code })
    .from(userRole)
    .innerJoin(role, eq(role.code, userRole.roleCode))
    .where(and(eq(userRole.userId, userId), eq(role.requiresMfa, true)));

  return requiresSecondFactor({
    isSuperUser: user?.isSuperUser ?? false,
    rolesRequiringMfa: roles.map((r) => r.code),
  });
}

/** Starts enrolment. The secret is returned once, for the authenticator app. */
export async function beginMfaEnrolment(tx: Tx, userId: string): Promise<{ secret: string }> {
  const secret = base32Encode(randomBytes(20));

  await tx
    .insert(userMfa)
    .values({ userId, secret })
    .onConflictDoUpdate({
      target: userMfa.userId,
      // Re-enrolling replaces the factor and un-enrols it until confirmed, so a
      // half-finished re-enrolment cannot leave the account with neither.
      set: { secret, enrolledAt: null },
    });

  return { secret };
}

/** Confirms enrolment by proving the app produces the right code. */
export async function confirmMfaEnrolment(
  tx: Tx,
  ctx: ActorContext,
  userId: string,
  code: string,
  atSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const [enrolment] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  if (!enrolment) throw new CredentialsInvalidError();

  if (!verifyTotp(enrolment.secret, code, atSeconds)) {
    throw new CredentialsInvalidError();
  }

  const now = new Date();
  await tx
    .update(userMfa)
    .set({ enrolledAt: now, lastVerifiedAt: now })
    .where(eq(userMfa.userId, userId));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'authentication.mfa_enrolled',
    objectType: 'user',
    objectId: userId,
    branchCode: ctx.branchCode,
    // The secret is never audited: §25 keeps keys out of logs, and the audit
    // trail is a log that many roles can read.
    after: { enrolled: true },
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/**
 * The sign-in gate: refuses to complete without the factor that is required.
 *
 * §25 and the 01.1 test gate — "a privileged role cannot complete sign-in
 * without the second factor".
 */
export async function assertSecondFactor(
  tx: Tx,
  userId: string,
  code: string | null,
  atSeconds = Math.floor(Date.now() / 1000),
): Promise<void> {
  const requirement = await secondFactorRequirement(tx, userId);
  if (!requirement.required) return;

  const [enrolment] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  const enrolled = Boolean(enrolment?.enrolledAt);
  const verified = enrolled && code !== null && verifyTotp(enrolment!.secret, code, atSeconds);

  const [user] = await tx
    .select({ isSuperUser: appUser.isSuperUser })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);

  const roles = await tx
    .select({ code: role.code })
    .from(userRole)
    .innerJoin(role, eq(role.code, userRole.roleCode))
    .where(and(eq(userRole.userId, userId), eq(role.requiresMfa, true)));

  assertSecondFactorSatisfied(
    { isSuperUser: user?.isSuperUser ?? false, rolesRequiringMfa: roles.map((r) => r.code) },
    { enrolled, verified },
  );

  if (verified) {
    await tx
      .update(userMfa)
      .set({ lastVerifiedAt: new Date() })
      .where(eq(userMfa.userId, userId));
  }
}

// ---------------------------------------------------------------------------
// §25 — sessions
// ---------------------------------------------------------------------------

/**
 * The token is returned raw once and stored as a digest.
 *
 * A database dump should not be a set of live sessions, and a support engineer
 * reading the table should not be able to become a user.
 */
function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  readonly sessionId: string;
  /** Returned once. The cookie holds this; the database holds its digest. */
  readonly token: string;
  readonly expiresAt: Date;
}

export async function createSession(
  tx: Tx,
  userId: string,
  context: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<IssuedSession> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_SECONDS * 1000);
  const sessionId = randomUUID();

  await tx.insert(authSession).values({
    id: sessionId,
    userId,
    token: digest(token),
    expiresAt,
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { sessionId, token, expiresAt };
}

/**
 * Resolves a session on **this** request — the 01.1 gate.
 *
 * "Revoking a session terminates access on the next request, not at token
 * expiry." That is this function: the row is read every time, so a revocation
 * that happened a second ago is seen now. It is also why the cookie cache is
 * disabled in the better-auth configuration.
 */
export async function resolveSession(
  tx: Tx,
  token: string,
  now = new Date(),
): Promise<{ session: typeof authSession.$inferSelect; user: typeof appUser.$inferSelect }> {
  const [row] = await tx
    .select({ session: authSession, user: appUser })
    .from(authSession)
    .innerJoin(appUser, eq(appUser.id, authSession.userId))
    .where(eq(authSession.token, digest(token)))
    .limit(1);

  if (!row) throw new SessionInvalidError('it was not recognised');

  assertSessionUsable(
    {
      id: row.session.id,
      userId: row.session.userId,
      expiresAt: row.session.expiresAt,
      revokedAt: row.session.revokedAt,
    },
    now,
  );

  // §25 — revocation is immediate, and deactivating an account revokes it.
  assertAccountUsable(row.user);

  return row;
}

/** Ends one session, keeping the record of why (§5.4). */
export async function revokeSession(
  tx: Tx,
  ctx: ActorContext,
  sessionId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(authSession)
    .set({ revokedAt: new Date(), revokedBy: ctx.principal.userId, revokedReason: reason })
    .where(and(eq(authSession.id, sessionId), isNull(authSession.revokedAt)));

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'authentication.session_revoked',
    objectType: 'session',
    objectId: sessionId,
    branchCode: ctx.branchCode,
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });
}

/** Ends every live session for an account — what deactivation and a compromise need. */
export async function revokeAllSessionsFor(
  tx: Tx,
  ctx: ActorContext,
  userId: string,
  reason: string,
): Promise<number> {
  const live = await tx
    .select({ id: authSession.id })
    .from(authSession)
    .where(and(eq(authSession.userId, userId), isNull(authSession.revokedAt)));

  for (const session of live) {
    await tx
      .update(authSession)
      .set({ revokedAt: new Date(), revokedBy: ctx.principal.userId, revokedReason: reason })
      .where(eq(authSession.id, session.id));
  }

  await audit.record(tx, {
    actorUserId: ctx.principal.userId,
    action: 'authentication.all_sessions_revoked',
    objectType: 'user',
    objectId: userId,
    branchCode: ctx.branchCode,
    after: { revokedSessions: live.length },
    reason,
    outcome: 'success',
    requestId: ctx.requestId ?? null,
  });

  return live.length;
}

/** The sessions an administrator sees on a user record. */
export async function sessionsFor(tx: Tx, userId: string) {
  return tx
    .select({
      id: authSession.id,
      createdAt: authSession.createdAt,
      expiresAt: authSession.expiresAt,
      revokedAt: authSession.revokedAt,
      revokedReason: authSession.revokedReason,
      ipAddress: authSession.ipAddress,
      userAgent: authSession.userAgent,
    })
    .from(authSession)
    .where(eq(authSession.userId, userId))
    .orderBy(authSession.createdAt);
}
