/**
 * Phase 01.1 test gate — password policy, second factor and session validity.
 *
 * "Credentials are not recoverable from the database" and "revocation takes
 * effect on the next request" are database facts and are in
 * tests/integration/phase01-authentication.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PASSWORD_POLICY,
  PasswordChangeRequiredError,
  PasswordPolicyError,
  SecondFactorNotEnrolledError,
  SecondFactorRequiredError,
  SessionInvalidError,
  assertAccountUsable,
  assertPasswordAcceptable,
  assertPasswordNotTemporary,
  assertSecondFactorSatisfied,
  assertSessionUsable,
  base32Decode,
  base32Encode,
  requiresSecondFactor,
  totpAt,
  verifyTotp,
} from '@domain/authentication';

describe('§25 · the password policy', () => {
  it('accepts a passphrase of reasonable length', () => {
    expect(() => assertPasswordAcceptable('correct horse battery staple')).not.toThrow();
  });

  it('requires at least the configured minimum length', () => {
    expect(() => assertPasswordAcceptable('short1234')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable('short1234')).toThrow(/12 is the minimum/);
  });

  it('does not impose composition rules', () => {
    // ASVS 2.1 drops upper/lower/digit/symbol requirements: they produce
    // `Password1!` and train people to write passwords down.
    expect(() => assertPasswordAcceptable('thequickbrownfoxjumps')).not.toThrow();
    expect(DEFAULT_PASSWORD_POLICY.minimumLength).toBe(12);
  });

  it('refuses the passwords that are actually guessed', () => {
    // A twelve-character password that is `Password1234` is what makes a
    // length-only policy look absurd.
    expect(() => assertPasswordAcceptable('Password1234')).toThrow(/among the first passwords/);
    expect(() => assertPasswordAcceptable('letmein123456')).toThrow(PasswordPolicyError);
    expect(() => assertPasswordAcceptable('changeme12345')).toThrow(PasswordPolicyError);
  });

  it('refuses a repeated character and a keyboard run', () => {
    expect(() => assertPasswordAcceptable('aaaaaaaaaaaaaa')).toThrow(/same character repeated/);
    expect(() => assertPasswordAcceptable('abcdefghijklm')).toThrow(/straight run/);
    expect(() => assertPasswordAcceptable('zyxwvutsrqpon')).toThrow(/straight run/);
  });

  it('refuses a password containing the account name or the holder’s name', () => {
    expect(() =>
      assertPasswordAcceptable('ahmed.hassan.2026', { email: 'ahmed.hassan@example.com' }),
    ).toThrow(/contains the account name/);

    expect(() =>
      assertPasswordAcceptable('AhmedHassanRules', { displayName: 'Ahmed Hassan' }),
    ).toThrow(/contains the account holder/);
  });

  it('bounds the maximum so a hash cannot be weaponised', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(300) + 'z')).toThrow(/longer than 256/);
  });

  it('applies at set time, not only at signup', () => {
    // The 01.1 gate says so: a signup screen with a policy and a reset screen
    // without one is a policy that exists for new users only. One function,
    // called by both.
    expect(() => assertPasswordAcceptable('weak')).toThrow(PasswordPolicyError);
  });
});

describe('§25 · temporary passwords', () => {
  it('lets an ordinary account through', () => {
    expect(() => assertPasswordNotTemporary({ mustChangePassword: false })).not.toThrow();
  });

  it('stops an account that has not replaced its temporary password', () => {
    expect(() => assertPasswordNotTemporary({ mustChangePassword: true })).toThrow(
      PasswordChangeRequiredError,
    );
  });
});

describe('§25 · multi-factor for privileged roles', () => {
  it('always requires it of a Super User', () => {
    // §5.1 gives a Super User full administration access, which is the
    // definition of privileged. Not a configuration choice.
    const { required, reason } = requiresSecondFactor({
      isSuperUser: true,
      rolesRequiringMfa: [],
    });
    expect(required).toBe(true);
    expect(reason).toMatch(/full administration access/);
  });

  it('requires it of a role the Business Process Owner has flagged', () => {
    const { required, reason } = requiresSecondFactor({
      isSuperUser: false,
      rolesRequiringMfa: ['treasury_manager'],
    });
    expect(required).toBe(true);
    expect(reason).toMatch(/treasury_manager/);
  });

  it('does not require it of an ordinary account', () => {
    expect(
      requiresSecondFactor({ isSuperUser: false, rolesRequiringMfa: [] }).required,
    ).toBe(false);
  });

  it('refuses to complete sign-in without the second factor', () => {
    // The 01.1 gate, stated exactly.
    expect(() =>
      assertSecondFactorSatisfied(
        { isSuperUser: true, rolesRequiringMfa: [] },
        { enrolled: true, verified: false },
      ),
    ).toThrow(SecondFactorRequiredError);
  });

  it('refuses to complete sign-in when nothing is enrolled', () => {
    expect(() =>
      assertSecondFactorSatisfied(
        { isSuperUser: true, rolesRequiringMfa: [] },
        { enrolled: false, verified: false },
      ),
    ).toThrow(SecondFactorNotEnrolledError);
  });

  it('lets an ordinary account through without one', () => {
    expect(() =>
      assertSecondFactorSatisfied(
        { isSuperUser: false, rolesRequiringMfa: [] },
        { enrolled: false, verified: false },
      ),
    ).not.toThrow();
  });

  it('lets a privileged account through once verified', () => {
    expect(() =>
      assertSecondFactorSatisfied(
        { isSuperUser: true, rolesRequiringMfa: [] },
        { enrolled: true, verified: true },
      ),
    ).not.toThrow();
  });
});

describe('TOTP (RFC 6238)', () => {
  // The RFC's own test vector secret, "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890', 'utf8'));

  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
    expect(() => base32Decode('not-base32!')).toThrow();
  });

  it('produces the RFC 6238 reference codes', () => {
    // Counter values from the RFC's test table: 59s and 1111111109s.
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('accepts the code for the current step', () => {
    const now = 1_700_000_000;
    const code = totpAt(secret, Math.floor(now / 30));
    expect(verifyTotp(secret, code, now)).toBe(true);
  });

  it('accepts one step either side, and no more', () => {
    // A phone's clock and a server's are never quite the same; refusing a code
    // that was right ten seconds ago teaches people to hate the second factor.
    const now = 1_700_000_000;
    const step = Math.floor(now / 30);

    expect(verifyTotp(secret, totpAt(secret, step - 1), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, step + 1), now)).toBe(true);
    // Wider than that is another code an attacker may replay.
    expect(verifyTotp(secret, totpAt(secret, step - 2), now)).toBe(false);
    expect(verifyTotp(secret, totpAt(secret, step + 2), now)).toBe(false);
  });

  it('refuses anything that is not six digits', () => {
    const now = 1_700_000_000;
    expect(verifyTotp(secret, '12345', now)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', now)).toBe(false);
    expect(verifyTotp(secret, '', now)).toBe(false);
  });

  it('tolerates a code typed with a space', () => {
    const now = 1_700_000_000;
    const code = totpAt(secret, Math.floor(now / 30));
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(true);
  });
});

describe('§25 · session expiry and revocation', () => {
  const now = new Date('2026-08-16T12:00:00Z');

  const session = (overrides: Partial<Parameters<typeof assertSessionUsable>[0]> = {}) => ({
    id: 's-1',
    userId: 'u-1',
    expiresAt: new Date('2026-08-16T13:00:00Z'),
    revokedAt: null,
    ...overrides,
  });

  it('accepts a live session', () => {
    expect(() => assertSessionUsable(session(), now)).not.toThrow();
  });

  it('refuses an expired one', () => {
    expect(() =>
      assertSessionUsable(session({ expiresAt: new Date('2026-08-16T11:59:59Z') }), now),
    ).toThrow(/it expired/);
  });

  it('refuses a revoked one immediately, not at expiry', () => {
    // The 01.1 gate: "Revoking a session terminates access on the next request,
    // not at token expiry." The session below has an hour left on it.
    expect(() =>
      assertSessionUsable(session({ revokedAt: new Date('2026-08-16T11:00:00Z') }), now),
    ).toThrow(SessionInvalidError);
    expect(() =>
      assertSessionUsable(session({ revokedAt: new Date('2026-08-16T11:00:00Z') }), now),
    ).toThrow(/it was revoked/);
  });

  it('refuses a session belonging to a deactivated account', () => {
    expect(() => assertAccountUsable({ isActive: false })).toThrow(/deactivated/);
    expect(() => assertAccountUsable({ isActive: true })).not.toThrow();
  });
});
