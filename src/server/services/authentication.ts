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
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
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
  signInAttempt,
  userMfa,
  userRole,
  type SignInOutcome,
} from '../db/schema';
import { hashPassword, verifyPassword } from '../auth';
import type { Tx } from '../db/client';
import type { ActorContext } from './chart-of-accounts';
import * as audit from './audit';
import { businessDateOf } from '../domain/business-date';

/** better-auth's name for a password credential. */
const CREDENTIAL_PROVIDER = 'credential';

/** How long a session lives. Mirrors the better-auth configuration. */
const SESSION_SECONDS = 8 * 60 * 60;

/** HD2 — a temporary password is good for this long after it was issued. */
export const TEMPORARY_PASSWORD_HOURS = 72;
/** HD3 / D-HD-3 — five failures in fifteen minutes lock the account from that address. */
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;
/**
 * The same window per address whatever the account — the scrypt cost makes
 * the form a DoS path. High, because an office behind one NAT address is one
 * address: this stops a script, not a building.
 */
export const LOCKOUT_FAILURES_PER_ADDRESS = 100;
/** HD4 / D-HD-5 — days a privileged account may sign in before it has enrolled a factor. */
export const MFA_ENROLMENT_GRACE_DAYS = 7;

export class TemporaryPasswordExpiredError extends Error {
  readonly code = 'TEMPORARY_PASSWORD_EXPIRED';
  constructor() {
    super('The temporary password has expired; ask an administrator for a new one.');
    this.name = 'TemporaryPasswordExpiredError';
  }
}

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
  now = new Date(),
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
  // HD2 — a temporary password that was never replaced stops working on its
  // own; an administrator issues another (which replaces this one).
  if (user.mustChangePassword && temporaryPasswordExpired(user, now)) {
    throw new TemporaryPasswordExpiredError();
  }
  return user;
}

export function temporaryPasswordExpired(
  user: { mustChangePassword: boolean; passwordChangedAt: Date | null },
  now = new Date(),
): boolean {
  if (!user.mustChangePassword) return false;
  if (!user.passwordChangedAt) return true;
  return now.getTime() - user.passwordChangedAt.getTime() > TEMPORARY_PASSWORD_HOURS * 3_600_000;
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

/** What the security screen shows: required?, enrolled?, grace end. */
export async function mfaStatus(tx: Tx, userId: string, now = new Date()) {
  const requirement = await secondFactorRequirement(tx, userId);
  const [enrolment] = await tx.select().from(userMfa).where(eq(userMfa.userId, userId)).limit(1);
  const [user] = await tx
    .select({ mfaRequiredSince: appUser.mfaRequiredSince })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);
  const since = user?.mfaRequiredSince ?? null;
  const due = since ? new Date(since.getTime() + MFA_ENROLMENT_GRACE_DAYS * 86_400_000) : null;
  return {
    required: requirement.required,
    reason: requirement.reason,
    enrolled: Boolean(enrolment?.enrolledAt),
    /** A begun, unconfirmed enrolment: the secret the app was given. */
    pendingSecret: enrolment && !enrolment.enrolledAt ? enrolment.secret : null,
    enrolledAt: enrolment?.enrolledAt ?? null,
    lastVerifiedAt: enrolment?.lastVerifiedAt ?? null,
    enrolmentDue: due,
    graceExpired: Boolean(due && now > due && !enrolment?.enrolledAt),
  };
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
// HD2 / HD3 / HD4 — the sign-in, as one function, so every path asks the same
// questions in the same order: locked? credentials? temporary password still
// valid? second factor? Every answer is written to sign_in_attempt and to the
// audit trail, succeeded or refused.
// ---------------------------------------------------------------------------

export interface SignInInput {
  readonly email: string;
  readonly password: string;
  /** The authenticator code, when the form offered the field. */
  readonly code?: string | null;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly now?: Date | undefined;
}

/**
 * What a session may do besides sign out:
 *   'password' — HD2: only replace the temporary password;
 *   'mfa'      — HD4: only enrol the second factor (the grace has run out);
 *   null       — everything its grants allow.
 */
export type SessionRestriction = 'password' | 'mfa' | null;

export interface SignInSuccess {
  readonly ok: true;
  readonly session: IssuedSession;
  readonly userId: string;
  readonly restriction: SessionRestriction;
  /** HD4 — enrolment is required and the grace is running: nudge, don't block. */
  readonly enrolmentDue: Date | null;
}

/**
 * A refusal is returned, not thrown: the attempt and its audit row are written
 * in the same transaction and must commit, and a throw would roll them back.
 */
export interface SignInRefusal {
  readonly ok: false;
  readonly refusal: 'locked' | 'credentials' | 'temporary_expired' | 'second_factor_required' | 'second_factor_wrong';
}

export type SignInResult = SignInSuccess | SignInRefusal;

async function recordAttempt(
  tx: Tx,
  input: SignInInput,
  outcome: SignInOutcome,
  userId: string | null,
  now: Date,
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  await tx.insert(signInAttempt).values({
    email,
    userId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    outcome,
    occurredAt: now,
  });
  // HD3 — the audit trail carries it too, so the one screen that reads
  // "who did what" shows the sign-ins beside everything else.
  await audit.record(tx, {
    actorUserId: userId,
    action: outcome === 'success' ? 'authentication.signed_in' : 'authentication.sign_in_refused',
    objectType: 'user',
    objectId: userId ?? email,
    branchCode: null,
    after: { email, outcome, ipAddress: input.ipAddress ?? null },
    outcome: outcome === 'success' ? 'success' : 'denied',
    requestId: null,
  });
}

/** D-HD-3 — the lockout, read from the attempts of the last window. */
export async function isLockedOut(
  tx: Tx,
  email: string,
  ipAddress: string | null,
  now = new Date(),
): Promise<boolean> {
  const since = new Date(now.getTime() - LOCKOUT_MINUTES * 60_000);
  const failures = ['failed', 'second_factor_wrong'] as const;
  const [account] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(signInAttempt)
    .where(
      and(
        eq(signInAttempt.email, email.trim().toLowerCase()),
        ipAddress ? eq(signInAttempt.ipAddress, ipAddress) : isNull(signInAttempt.ipAddress),
        inArray(signInAttempt.outcome, [...failures]),
        gte(signInAttempt.occurredAt, since),
      ),
    );
  if ((account?.n ?? 0) >= LOCKOUT_FAILURES) return true;
  if (!ipAddress) return false;
  const [address] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(signInAttempt)
    .where(
      and(
        eq(signInAttempt.ipAddress, ipAddress),
        inArray(signInAttempt.outcome, [...failures]),
        gte(signInAttempt.occurredAt, since),
      ),
    );
  return (address?.n ?? 0) >= LOCKOUT_FAILURES_PER_ADDRESS;
}

export async function signIn(tx: Tx, input: SignInInput): Promise<SignInResult> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();

  if (await isLockedOut(tx, email, input.ipAddress ?? null, now)) {
    await recordAttempt(tx, input, 'locked', null, now);
    return { ok: false, refusal: 'locked' };
  }

  let user: typeof appUser.$inferSelect;
  try {
    user = await verifyCredentials(tx, email, input.password, now);
  } catch (error) {
    const outcome: SignInOutcome =
      error instanceof TemporaryPasswordExpiredError
        ? 'temporary_expired'
        : error instanceof SessionInvalidError
          ? 'inactive'
          : 'failed';
    const [known] = await tx.select({ id: appUser.id }).from(appUser).where(eq(appUser.email, email)).limit(1);
    await recordAttempt(tx, input, outcome, known?.id ?? null, now);
    return { ok: false, refusal: outcome === 'temporary_expired' ? 'temporary_expired' : 'credentials' };
  }

  // HD4 — the second factor. Enrolled: the code must be right. Not enrolled:
  // the grace runs from the first privileged sign-in; inside it the person
  // gets in and is told; after it the session can only enrol.
  let restriction: SessionRestriction = user.mustChangePassword ? 'password' : null;
  let enrolmentDue: Date | null = null;
  const requirement = await secondFactorRequirement(tx, user.id);
  if (requirement.required) {
    const [enrolment] = await tx.select().from(userMfa).where(eq(userMfa.userId, user.id)).limit(1);
    if (enrolment?.enrolledAt) {
      const code = input.code?.trim() ?? '';
      if (!code) {
        await recordAttempt(tx, input, 'second_factor_required', user.id, now);
        return { ok: false, refusal: 'second_factor_required' };
      }
      if (!verifyTotp(enrolment.secret, code, Math.floor(now.getTime() / 1000))) {
        await recordAttempt(tx, input, 'second_factor_wrong', user.id, now);
        return { ok: false, refusal: 'second_factor_wrong' };
      }
      await tx.update(userMfa).set({ lastVerifiedAt: now }).where(eq(userMfa.userId, user.id));
    } else {
      const since = user.mfaRequiredSince ?? now;
      if (!user.mfaRequiredSince) {
        await tx.update(appUser).set({ mfaRequiredSince: now }).where(eq(appUser.id, user.id));
      }
      enrolmentDue = new Date(since.getTime() + MFA_ENROLMENT_GRACE_DAYS * 86_400_000);
      if (now > enrolmentDue && restriction === null) restriction = 'mfa';
      else {
        // Inside the grace: told once a day, in the bell, not blocked.
        await tx.execute(sql`
          select app_notify(null, 'authentication.enrol_second_factor', 'user', ${user.id}, ${user.id}::uuid,
                            'Enrol your authenticator',
                            ${`This account must sign in with an authenticator code from ${businessDateOf(enrolmentDue)}. Enrol it under My profile → Security.`},
                            ${JSON.stringify({ due: businessDateOf(enrolmentDue) })}::jsonb,
                            ${`mfa-enrol:${user.id}:${businessDateOf(now)}`}, null)`);
      }
    }
  }

  const session = await createSession(tx, user.id, {
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });
  await recordAttempt(tx, input, 'success', user.id, now);
  return { ok: true, session, userId: user.id, restriction, enrolmentDue };
}

/**
 * The restriction a live session carries now — computed on the request, not
 * stored, so replacing the password or enrolling lifts it at once.
 */
export async function restrictionFor(
  tx: Tx,
  user: { id: string; mustChangePassword: boolean; mfaRequiredSince: Date | null },
  now = new Date(),
): Promise<SessionRestriction> {
  if (user.mustChangePassword) return 'password';
  if (!user.mfaRequiredSince) return null;
  if (now.getTime() - user.mfaRequiredSince.getTime() <= MFA_ENROLMENT_GRACE_DAYS * 86_400_000) return null;
  const [enrolment] = await tx
    .select({ enrolledAt: userMfa.enrolledAt })
    .from(userMfa)
    .where(eq(userMfa.userId, user.id))
    .limit(1);
  if (enrolment?.enrolledAt) return null;
  return (await secondFactorRequirement(tx, user.id)).required ? 'mfa' : null;
}

/** HD3 — the login history an administrator reads. */
export async function signInHistory(tx: Tx, options: { userId?: string; limit?: number } = {}) {
  return tx
    .select()
    .from(signInAttempt)
    .where(options.userId ? eq(signInAttempt.userId, options.userId) : undefined)
    .orderBy(sql`${signInAttempt.occurredAt} desc`)
    .limit(options.limit ?? 200);
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
