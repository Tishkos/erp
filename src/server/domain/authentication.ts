/**
 * Identity and authentication — Phase 01.1.
 *
 * §25 requires: "strong password policy, temporary-password setup,
 * multi-factor authentication for privileged and high-risk roles, session
 * expiry and immediate revocation."
 *
 * ── On choosing the password rule ───────────────────────────────────────────
 * §25 says "strong" and does not define it, so the definition comes from the
 * reference basis Appendix E names — OWASP ASVS. That means **length and a
 * blocklist, not composition rules**: ASVS 2.1 explicitly drops the
 * upper/lower/digit/symbol requirement, because it produces `Password1!` and
 * trains people to write passwords down. Twelve characters, a generous
 * maximum so a passphrase is not truncated, and a refusal of the passwords
 * that are actually guessed.
 *
 * The minimum length is configurable; the *shape* of the rule is not, because
 * making composition rules available is how they get switched on.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PasswordPolicy {
  readonly minimumLength: number;
  readonly maximumLength: number;
}

/** ASVS-aligned default. The Business Process Owner may raise the minimum. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minimumLength: 12,
  // Long enough for any passphrase; bounded so a megabyte password cannot be
  // used to make the hash function a denial-of-service tool.
  maximumLength: 256,
};

export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_POLICY';
  constructor(detail: string) {
    super(`That password cannot be used: ${detail}`);
    this.name = 'PasswordPolicyError';
  }
}

/**
 * Passwords that are guessed first, whatever else a policy says.
 *
 * A short list held here rather than a breach corpus: the full check belongs in
 * Phase 20 with a maintained dataset. What this catches is the case that makes
 * a password policy look absurd — a twelve-character password that is
 * `Password1234`.
 */
const BLOCKED = [
  'password',
  'passw0rd',
  'welcome',
  'qwerty',
  'letmein',
  'admin',
  'iloveyou',
  'monkey',
  'dragon',
  'changeme',
  'temporary',
];

/**
 * §25 — checked at **set** time, not only at signup.
 *
 * The 01.1 gate says so explicitly, and the reason is that password *changes*
 * and administrative resets are the paths a weak password usually arrives by:
 * a signup screen with a policy and a reset screen without one is a policy that
 * exists for new users only.
 */
export function assertPasswordAcceptable(
  password: string,
  context: { email?: string | null; displayName?: string | null } = {},
  policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
): void {
  if (password.length < policy.minimumLength) {
    throw new PasswordPolicyError(
      `it is ${password.length} characters; ${policy.minimumLength} is the minimum. ` +
        'A passphrase of a few words is easier to remember and harder to guess.',
    );
  }

  if (password.length > policy.maximumLength) {
    throw new PasswordPolicyError(`it is longer than ${policy.maximumLength} characters.`);
  }

  const lowered = password.toLowerCase();

  for (const blocked of BLOCKED) {
    if (lowered.includes(blocked)) {
      throw new PasswordPolicyError(
        `it contains "${blocked}", which is among the first passwords anyone tries.`,
      );
    }
  }

  if (/^(.)\1+$/.test(password)) {
    throw new PasswordPolicyError('it is the same character repeated.');
  }

  if (isSequential(lowered)) {
    throw new PasswordPolicyError('it is a straight run of characters from the keyboard.');
  }

  const localPart = context.email?.split('@')[0]?.toLowerCase();
  if (localPart && localPart.length >= 4 && lowered.includes(localPart)) {
    throw new PasswordPolicyError('it contains the account name.');
  }

  const name = context.displayName?.toLowerCase().replace(/\s+/g, '');
  if (name && name.length >= 4 && lowered.replace(/\s+/g, '').includes(name)) {
    throw new PasswordPolicyError('it contains the account holder’s name.');
  }
}

function isSequential(value: string): boolean {
  if (value.length < 6) return false;

  let ascending = true;
  let descending = true;

  for (let i = 1; i < value.length; i++) {
    const step = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (step !== 1) ascending = false;
    if (step !== -1) descending = false;
  }

  return ascending || descending;
}

// ---------------------------------------------------------------------------
// §25 — temporary passwords
// ---------------------------------------------------------------------------

export class PasswordChangeRequiredError extends Error {
  readonly code = 'PASSWORD_CHANGE_REQUIRED';
  constructor() {
    super(
      'This account is on a temporary password and must set a new one before it can be used (§25).',
    );
    this.name = 'PasswordChangeRequiredError';
  }
}

/**
 * §25 — "temporary-password setup, forced change."
 *
 * A temporary password gets an account started and nothing else: until it is
 * replaced, the session it produces may do exactly one thing. Allowing the rest
 * of the system through would make the forced change a suggestion.
 */
export function assertPasswordNotTemporary(user: { mustChangePassword: boolean }): void {
  if (user.mustChangePassword) {
    throw new PasswordChangeRequiredError();
  }
}

// ---------------------------------------------------------------------------
// §25 — multi-factor authentication for privileged and high-risk roles
// ---------------------------------------------------------------------------

export interface MfaSubject {
  /** §5.1 — Super Users retain full administration access. */
  readonly isSuperUser: boolean;
  /** Roles the Business Process Owner has marked as privileged or high-risk. */
  readonly rolesRequiringMfa: readonly string[];
}

export class SecondFactorRequiredError extends Error {
  readonly code = 'SECOND_FACTOR_REQUIRED';
  constructor(readonly reason: string) {
    super(`This account requires a second factor to sign in: ${reason} (§25).`);
    this.name = 'SecondFactorRequiredError';
  }
}

export class SecondFactorNotEnrolledError extends Error {
  readonly code = 'SECOND_FACTOR_NOT_ENROLLED';
  constructor() {
    super(
      'This account requires a second factor but has not enrolled one. Enrol before signing in (§25).',
    );
    this.name = 'SecondFactorNotEnrolledError';
  }
}

/**
 * Whether this account must present a second factor.
 *
 * Super User is always in scope, and that is not a configuration choice: §5.1
 * gives a Super User full administration access, which is the definition of
 * privileged. Which *other* roles count is the Business Process Owner's call
 * (§28), held as a flag on the role.
 */
export function requiresSecondFactor(subject: MfaSubject): { required: boolean; reason: string } {
  if (subject.isSuperUser) {
    return { required: true, reason: 'it holds full administration access' };
  }

  if (subject.rolesRequiringMfa.length > 0) {
    return {
      required: true,
      reason: `it holds the privileged role ${subject.rolesRequiringMfa.join(', ')}`,
    };
  }

  return { required: false, reason: '' };
}

/** The sign-in gate: refuses to complete without the factor that is required. */
export function assertSecondFactorSatisfied(
  subject: MfaSubject,
  presented: { enrolled: boolean; verified: boolean },
): void {
  const { required, reason } = requiresSecondFactor(subject);
  if (!required) return;

  if (!presented.enrolled) {
    throw new SecondFactorNotEnrolledError();
  }

  if (!presented.verified) {
    throw new SecondFactorRequiredError(reason);
  }
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238
// ---------------------------------------------------------------------------

const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

/**
 * Verifies a time-based one-time password.
 *
 * A one-step window either side, because a phone's clock and a server's clock
 * are never quite the same and refusing a code that was right ten seconds ago
 * teaches people to hate the second factor. Wider than that starts to matter:
 * every extra step is another code an attacker may replay.
 *
 * `atSeconds` is a parameter rather than a call to the clock, so this is a pure
 * function and a test can prove the window rather than approximate it.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  atSeconds: number,
  windowSteps = 1,
): boolean {
  const normalised = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalised)) return false;

  const counter = Math.floor(atSeconds / TOTP_STEP_SECONDS);
  const expected = Buffer.from(normalised, 'utf8');

  for (let offset = -windowSteps; offset <= windowSteps; offset++) {
    const candidate = Buffer.from(totpAt(secretBase32, counter + offset), 'utf8');
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      return true;
    }
  }

  return false;
}

export function totpAt(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`"${char}" is not a base32 character.`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

// ---------------------------------------------------------------------------
// §25 — session expiry and immediate revocation
// ---------------------------------------------------------------------------

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export class SessionInvalidError extends Error {
  readonly code = 'SESSION_INVALID';
  constructor(reason: string) {
    super(`This session is no longer valid: ${reason}. Sign in again.`);
    this.name = 'SessionInvalidError';
  }
}

/**
 * §25 — "session expiry and immediate revocation."
 *
 * The 01.1 gate is the sharper statement: "Revoking a session terminates access
 * on the **next request**, not at token expiry." That is only possible if the
 * session is looked up on every request, which is why TECHSTACK B1 chose
 * database-backed sessions over stateless JWTs — a signed token that carries
 * its own validity cannot be withdrawn before it expires.
 *
 * `now` is a parameter for the same reason `atSeconds` is above.
 */
export function assertSessionUsable(session: SessionRecord, now: Date): void {
  if (session.revokedAt) {
    throw new SessionInvalidError('it was revoked');
  }

  if (session.expiresAt <= now) {
    throw new SessionInvalidError('it expired');
  }
}

/** Whether a deactivated account's sessions still count. They do not (§25). */
export function assertAccountUsable(user: { isActive: boolean }): void {
  if (!user.isActive) {
    throw new SessionInvalidError('the account has been deactivated');
  }
}
