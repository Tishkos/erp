/**
 * better-auth configuration — Phase 01.1.
 *
 * TECHSTACK B1 chose better-auth "configured with database-backed sessions, not
 * stateless JWTs", because §25 requires *immediate* revocation and the 01.1
 * gate states it as "revoking a session terminates access on the next request,
 * not at token expiry". A signed token carries its own validity; a row can be
 * withdrawn.
 *
 * ── What is mapped, and why ─────────────────────────────────────────────────
 * better-auth's models are pointed at our tables rather than its defaults, so
 * `app_user` stays the one business identity every other table references. A
 * second user table would mean two answers to "who is this?", and the first
 * time they disagree is when someone is deactivated in one of them.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db/client';
import * as schema from '../db/schema';
import {
  DEFAULT_PASSWORD_POLICY,
  assertPasswordAcceptable,
} from '../domain/authentication';

const secret = process.env.BETTER_AUTH_SECRET;

if (!secret) {
  throw new Error(
    'BETTER_AUTH_SECRET is not set. Copy .env.example to .env — sessions cannot be signed without it.',
  );
}

/**
 * How long a session lasts before it must be renewed.
 *
 * §25 lists "session expiry" among the required controls but sets no number —
 * that is D4's territory (availability and operational targets). Eight hours is
 * a working day, which is the shortest defensible default; the Business Process
 * Owner may shorten it.
 */
const SESSION_SECONDS = 8 * 60 * 60;

export const auth = betterAuth({
  secret,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',

  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.appUser,
      session: schema.authSession,
      account: schema.authAccount,
      verification: schema.authVerification,
    },
  }),

  // `app_user.id` is a uuid the database generates. Letting better-auth mint
  // its own string ids would put two id formats in one column.
  advanced: {
    database: { generateId: false },
  },

  user: {
    modelName: 'app_user',
    fields: {
      // Our column is `display_name`; better-auth calls it `name`.
      name: 'displayName',
      emailVerified: 'emailVerified',
    },
  },

  session: {
    modelName: 'auth_session',
    expiresIn: SESSION_SECONDS,
    // Re-issue when a session is more than half spent, so an active user is not
    // signed out mid-task and an idle one still expires on time.
    updateAge: SESSION_SECONDS / 2,
    // §25 — the session is read from the database on every request. Caching it
    // in the cookie would reintroduce exactly the delay revocation must not
    // have.
    cookieCache: { enabled: false },
  },

  account: { modelName: 'auth_account' },
  verification: { modelName: 'auth_verification' },

  emailAndPassword: {
    enabled: true,
    // The policy lives in the domain and is applied at every path that sets a
    // password — signup, change and administrative reset alike (01.1 gate).
    minPasswordLength: DEFAULT_PASSWORD_POLICY.minimumLength,
    maxPasswordLength: DEFAULT_PASSWORD_POLICY.maximumLength,
    password: {
      verify: async ({ password, hash }) => verifyPassword(password, hash),
      hash: async (password) => {
        assertPasswordAcceptable(password);
        return hashPassword(password);
      },
    },
  },
});

export type Auth = typeof auth;

/**
 * Password hashing.
 *
 * scrypt from `node:crypto` — memory-hard, in the standard library, and with no
 * dependency to keep current. The parameters follow OWASP's scrypt guidance
 * (N=2^16, r=8, p=1), which Appendix E's reference basis points at.
 *
 * The stored form is `scrypt$N$r$p$salt$hash`, so a future parameter change can
 * verify old hashes and re-hash on next sign-in rather than locking everyone
 * out.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const SCRYPT = { N: 2 ** 16, r: 8, p: 1, keyLength: 64 };
const MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keyLength, { ...SCRYPT, maxmem: MAXMEM });

  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64!, 'base64');
  const expected = Buffer.from(hashB64!, 'base64');

  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });

  // Constant time: a comparison that returns early leaks how much of the hash
  // matched, one byte at a time.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
