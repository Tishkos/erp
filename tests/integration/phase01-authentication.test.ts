/**
 * Phase 01.1 — identity and authentication, against a real PostgreSQL instance.
 *
 * §27's Release 1 acceptance dependency opens with "Authentication…". The three
 * gate items that cannot be proved without a database are here: that a
 * credential is not recoverable from the table, that revoking a session ends
 * access on the **next request** rather than at expiry, and that a privileged
 * account cannot complete sign-in without its second factor.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authn from '@/server/services/authentication';
import * as authz from '@/server/services/authorization';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import {
  PasswordPolicyError,
  SecondFactorNotEnrolledError,
  SecondFactorRequiredError,
  SessionInvalidError,
  totpAt,
} from '@domain/authentication';

const BAGHDAD = 'BGW';
const GOOD_PASSWORD = 'correct horse battery staple';

let admin: ActorContext;

async function createUser(options: {
  email?: string;
  isSuperUser?: boolean;
  roleCode?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`,
    [id, options.email ?? `${id}@example.com`, 'Test User', options.isSuperUser ?? false],
  );
  if (options.roleCode) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
      id,
      options.roleCode,
    ]);
  }
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  return id;
}

async function contextFor(userId: string): Promise<ActorContext> {
  const principal = await withScope({ userId, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, userId),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  admin = await contextFor(await createUser({ isSuperUser: true }));
});

// ---------------------------------------------------------------------------
describe('§25 · credentials are not recoverable from the database', () => {
  it('stores a hash, never the password', async () => {
    const userId = await createUser({ email: 'ahmed@example.com' });
    await withScope(scope(admin), (tx) => authn.setPassword(tx, userId, GOOD_PASSWORD));

    const { rows } = await ownerPool.query(
      `select password from auth_account where user_id = $1`,
      [userId],
    );

    expect(rows[0].password).not.toContain(GOOD_PASSWORD);
    expect(rows[0].password).toMatch(/^scrypt\$/);
    // Nothing in the row is the password, in any encoding.
    const serialised = JSON.stringify(rows[0]);
    expect(serialised).not.toContain('correct horse');
    expect(serialised).not.toContain(Buffer.from(GOOD_PASSWORD).toString('base64'));
  });

  it('refuses a plaintext password written straight into the column', async () => {
    // The database cannot prove a value is a hash — nothing can — but it can
    // refuse the shapes a password takes, so a fixture, a migration or a
    // support script cannot put one there by accident.
    const userId = await createUser();
    const message = await rejection(
      ownerPool.query(
        `insert into auth_account (id, user_id, account_id, provider_id, password)
         values ($1,$2,$3,'credential','hunter2')`,
        [randomUUID(), userId, userId],
      ),
    );
    expect(message).toMatch(/auth_account_password_is_hashed/);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const userId = await createUser({ email: 'ahmed@example.com' });
    await withScope(scope(admin), (tx) => authn.setPassword(tx, userId, GOOD_PASSWORD));

    const user = await withScope(scope(admin), (tx) =>
      authn.verifyCredentials(tx, 'ahmed@example.com', GOOD_PASSWORD),
    );
    expect(user.id).toBe(userId);

    await expect(
      withScope(scope(admin), (tx) =>
        authn.verifyCredentials(tx, 'ahmed@example.com', 'the wrong passphrase entirely'),
      ),
    ).rejects.toThrow(/not valid/);
  });

  it('says the same thing whether the account is unknown or the password wrong', async () => {
    // Distinguishing them tells an attacker which e-mail addresses exist.
    const userId = await createUser({ email: 'ahmed@example.com' });
    await withScope(scope(admin), (tx) => authn.setPassword(tx, userId, GOOD_PASSWORD));

    const wrongPassword = await rejection(
      withScope(scope(admin), (tx) =>
        authn.verifyCredentials(tx, 'ahmed@example.com', 'wrong passphrase here'),
      ),
    );
    const unknownAccount = await rejection(
      withScope(scope(admin), (tx) =>
        authn.verifyCredentials(tx, 'nobody@example.com', 'wrong passphrase here'),
      ),
    );
    expect(unknownAccount).toBe(wrongPassword);
  });

  it('applies the policy on a reset, not only at signup', async () => {
    const userId = await createUser({ email: 'ahmed@example.com' });
    await withScope(scope(admin), (tx) => authn.setPassword(tx, userId, GOOD_PASSWORD));

    // The same function is the only way to set a password, so the second time
    // is checked exactly like the first.
    await expect(
      withScope(scope(admin), (tx) => authn.setPassword(tx, userId, 'short')),
    ).rejects.toThrow(PasswordPolicyError);
  });

  it('refuses a password containing the account name', async () => {
    const userId = await createUser({ email: 'ahmed.hassan@example.com' });
    await expect(
      withScope(scope(admin), (tx) => authn.setPassword(tx, userId, 'ahmed.hassan.2026')),
    ).rejects.toThrow(/contains the account name/);
  });

  it('marks an account that was given a temporary password (§25)', async () => {
    const userId = await createUser();
    await withScope(scope(admin), (tx) =>
      authn.setPassword(tx, userId, GOOD_PASSWORD, { temporary: true }),
    );

    const { rows } = await ownerPool.query(
      `select must_change_password from app_user where id = $1`,
      [userId],
    );
    expect(rows[0].must_change_password).toBe(true);

    // And replacing it clears the flag.
    await withScope(scope(admin), (tx) =>
      authn.setPassword(tx, userId, 'a different passphrase entirely'),
    );
    const after = await ownerPool.query(
      `select must_change_password from app_user where id = $1`,
      [userId],
    );
    expect(after.rows[0].must_change_password).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('§25 · sessions expire and are revoked immediately', () => {
  it('stores the token as a digest, not as the token', async () => {
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));

    const { rows } = await ownerPool.query(`select token from auth_session where id = $1`, [
      session.sessionId,
    ]);
    expect(rows[0].token).not.toBe(session.token);
    expect(rows[0].token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a live session', async () => {
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));

    const resolved = await withScope(scope(admin), (tx) =>
      authn.resolveSession(tx, session.token),
    );
    expect(resolved.user.id).toBe(userId);
  });

  it('terminates access on the next request after revocation, not at expiry', async () => {
    // The 01.1 gate, stated exactly. The session below has eight hours left.
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));

    await expect(
      withScope(scope(admin), (tx) => authn.resolveSession(tx, session.token)),
    ).resolves.toBeDefined();

    await withScope(scope(admin), (tx) =>
      authn.revokeSession(tx, admin, session.sessionId, 'Access withdrawn by administrator'),
    );

    await expect(
      withScope(scope(admin), (tx) => authn.resolveSession(tx, session.token)),
    ).rejects.toThrow(/it was revoked/);

    // The session had not expired — revocation, not expiry, ended it.
    const { rows } = await ownerPool.query(
      `select expires_at > now() as still_within_expiry from auth_session where id = $1`,
      [session.sessionId],
    );
    expect(rows[0].still_within_expiry).toBe(true);
  });

  it('refuses an expired session', async () => {
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));

    const later = new Date(Date.now() + 9 * 60 * 60 * 1000);
    await expect(
      withScope(scope(admin), (tx) => authn.resolveSession(tx, session.token, later)),
    ).rejects.toThrow(/it expired/);
  });

  it('refuses an unrecognised token', async () => {
    await expect(
      withScope(scope(admin), (tx) => authn.resolveSession(tx, 'not-a-real-token')),
    ).rejects.toThrow(SessionInvalidError);
  });

  it('ends every session when an account is deactivated', async () => {
    const userId = await createUser();
    const first = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));
    const second = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));

    const revoked = await withScope(scope(admin), (tx) =>
      authn.revokeAllSessionsFor(tx, admin, userId, 'Account deactivated'),
    );
    expect(revoked).toBe(2);

    for (const session of [first, second]) {
      await expect(
        withScope(scope(admin), (tx) => authn.resolveSession(tx, session.token)),
      ).rejects.toThrow(/it was revoked/);
    }
  });

  it('refuses a session belonging to a deactivated account, even before revocation', async () => {
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));

    await ownerPool.query(`update app_user set is_active = false where id = $1`, [userId]);

    await expect(
      withScope(scope(admin), (tx) => authn.resolveSession(tx, session.token)),
    ).rejects.toThrow(/deactivated/);
  });

  it('keeps the record of a revocation, and will not reinstate it', async () => {
    // A deleted session cannot be asked why it ended. §5.4 needs the row.
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));
    await withScope(scope(admin), (tx) =>
      authn.revokeSession(tx, admin, session.sessionId, 'Suspected compromise'),
    );

    const { rows } = await ownerPool.query(
      `select revoked_reason, revoked_by from auth_session where id = $1`,
      [session.sessionId],
    );
    expect(rows[0].revoked_reason).toBe('Suspected compromise');
    expect(rows[0].revoked_by).toBe(admin.principal.userId);

    expect(
      await rejection(
        ownerPool.query(`update auth_session set revoked_at = null where id = $1`, [
          session.sessionId,
        ]),
      ),
    ).toMatch(/cannot be reinstated/);

    expect(
      await rejection(
        ownerPool.query(`update auth_session set revoked_reason = 'routine' where id = $1`, [
          session.sessionId,
        ]),
      ),
    ).toMatch(/record of a revocation cannot be changed/);
  });

  it('audits a revocation with its reason', async () => {
    const userId = await createUser();
    const session = await withScope(scope(admin), (tx) => authn.createSession(tx, userId));
    await withScope(scope(admin), (tx) =>
      authn.revokeSession(tx, admin, session.sessionId, 'Laptop lost'),
    );

    const { rows } = await ownerPool.query(
      `select action, reason from audit_event where action = 'authentication.session_revoked'`,
    );
    expect(rows[0].reason).toBe('Laptop lost');
  });
});

// ---------------------------------------------------------------------------
describe('§25 · multi-factor for privileged and high-risk roles', () => {
  const at = 1_700_000_000;

  it('requires a second factor of a Super User', async () => {
    const userId = await createUser({ isSuperUser: true });

    const requirement = await withScope(scope(admin), (tx) =>
      authn.secondFactorRequirement(tx, userId),
    );
    expect(requirement.required).toBe(true);
  });

  it('requires it of a role the Business Process Owner has flagged', async () => {
    await ownerPool.query(`update role set requires_mfa = true where code = 'accounting_manager'`);
    const userId = await createUser({ roleCode: 'accounting_manager' });

    const requirement = await withScope(scope(admin), (tx) =>
      authn.secondFactorRequirement(tx, userId),
    );
    expect(requirement.required).toBe(true);
    expect(requirement.reason).toMatch(/accounting_manager/);
  });

  it('does not require it of an ordinary account', async () => {
    const userId = await createUser({ roleCode: 'accounting_officer' });

    const requirement = await withScope(scope(admin), (tx) =>
      authn.secondFactorRequirement(tx, userId),
    );
    expect(requirement.required).toBe(false);

    await expect(
      withScope(scope(admin), (tx) => authn.assertSecondFactor(tx, userId, null, at)),
    ).resolves.toBeUndefined();
  });

  it('refuses sign-in for a privileged account that has enrolled nothing', async () => {
    const userId = await createUser({ isSuperUser: true });

    await expect(
      withScope(scope(admin), (tx) => authn.assertSecondFactor(tx, userId, null, at)),
    ).rejects.toThrow(SecondFactorNotEnrolledError);
  });

  it('refuses sign-in without the code, and accepts it with (§25)', async () => {
    // The 01.1 gate: "A privileged role cannot complete sign-in without the
    // second factor."
    const userId = await createUser({ isSuperUser: true });
    const ctx = await contextFor(userId);

    const { secret } = await withScope(scope(ctx), (tx) => authn.beginMfaEnrolment(tx, userId));
    await withScope(scope(ctx), (tx) =>
      authn.confirmMfaEnrolment(tx, ctx, userId, totpAt(secret, Math.floor(at / 30)), at),
    );

    await expect(
      withScope(scope(ctx), (tx) => authn.assertSecondFactor(tx, userId, null, at)),
    ).rejects.toThrow(SecondFactorRequiredError);

    await expect(
      withScope(scope(ctx), (tx) => authn.assertSecondFactor(tx, userId, '000000', at)),
    ).rejects.toThrow(SecondFactorRequiredError);

    await expect(
      withScope(scope(ctx), (tx) =>
        authn.assertSecondFactor(tx, userId, totpAt(secret, Math.floor(at / 30)), at),
      ),
    ).resolves.toBeUndefined();
  });

  it('does not put the shared secret in the audit trail', async () => {
    // §25 — no keys in logs, and the audit trail is a log many roles can read.
    const userId = await createUser({ isSuperUser: true });
    const ctx = await contextFor(userId);
    const { secret } = await withScope(scope(ctx), (tx) => authn.beginMfaEnrolment(tx, userId));
    await withScope(scope(ctx), (tx) =>
      authn.confirmMfaEnrolment(tx, ctx, userId, totpAt(secret, Math.floor(at / 30)), at),
    );

    const { rows } = await ownerPool.query(
      `select after_value from audit_event where action = 'authentication.mfa_enrolled'`,
    );
    expect(JSON.stringify(rows[0].after_value)).not.toContain(secret);
    expect(rows[0].after_value).toEqual({ enrolled: true });
  });

  it('leaves a re-enrolling account unenrolled until the new factor is confirmed', async () => {
    const userId = await createUser({ isSuperUser: true });
    const ctx = await contextFor(userId);

    const first = await withScope(scope(ctx), (tx) => authn.beginMfaEnrolment(tx, userId));
    await withScope(scope(ctx), (tx) =>
      authn.confirmMfaEnrolment(tx, ctx, userId, totpAt(first.secret, Math.floor(at / 30)), at),
    );

    await withScope(scope(ctx), (tx) => authn.beginMfaEnrolment(tx, userId));

    // A half-finished re-enrolment must not leave the account with neither
    // factor working and sign-in open.
    await expect(
      withScope(scope(ctx), (tx) =>
        authn.assertSecondFactor(tx, userId, totpAt(first.secret, Math.floor(at / 30)), at),
      ),
    ).rejects.toThrow(SecondFactorNotEnrolledError);
  });
});
