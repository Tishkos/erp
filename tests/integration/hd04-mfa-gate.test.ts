/**
 * REQ-HARDEN-001 HD4 — the second factor is enforced at sign-in.
 *
 * D-HD-5: a privileged account (a role with requires_mfa, or a super user)
 * gets seven days from its first privileged sign-in to enrol. Inside the
 * grace it signs in and is told; after it the session can only enrol; once
 * enrolled the authenticator code is required and a wrong one counts
 * towards the lockout.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authn from '@/server/services/authentication';
import * as authz from '@/server/services/authorization';
import * as users from '@/server/services/users';
import { totpAt } from '@domain/authentication';

const BAGHDAD = 'BGW';
const NIL = '00000000-0000-0000-0000-000000000000';
const PASSWORD = 'correct horse battery staple';

async function createUser(roleCode: string | null): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@example.com`;
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Test User')`, [id, email]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  if (roleCode) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.setPassword(tx, id, PASSWORD));
  return { id, email };
}
const signIn = (email: string, password: string, code: string | null, now: Date) =>
  withScope({ userId: NIL, branchCode: '' }, (tx) => authn.signIn(tx, { email, password, code, now }));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(`update role set requires_mfa = true where code = 'accounting_manager'`);
});

describe('HD4 · the second factor', () => {
  it('gives a privileged account seven days to enrol, then restricts it to enrolment', async () => {
    const { id, email } = await createUser('accounting_manager');
    const t0 = new Date('2026-10-02T08:00:00Z');
    const first = await signIn(email, PASSWORD, null, t0);
    expect(first.ok && first.restriction).toBeNull();
    expect(first.ok && first.enrolmentDue?.toISOString()).toBe('2026-10-09T08:00:00.000Z');

    const late = await signIn(email, PASSWORD, null, new Date('2026-10-10T08:00:00Z'));
    expect(late.ok && late.restriction).toBe('mfa');
    const user = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => users.get(tx, id));
    expect(await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.restrictionFor(tx, user, new Date('2026-10-10T08:00:00Z')))).toBe('mfa');

    // Enrolling lifts it on the next request.
    const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
    const { secret } = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.beginMfaEnrolment(tx, id));
    const at = Math.floor(new Date('2026-10-10T08:05:00Z').getTime() / 1000);
    await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
      authn.confirmMfaEnrolment(tx, { principal, branchCode: BAGHDAD }, id, totpAt(secret, Math.floor(at / 30)), at),
    );
    expect(await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.restrictionFor(tx, user, new Date('2026-10-10T08:06:00Z')))).toBeNull();
  });

  it('requires the code once enrolled; a wrong code is refused and counts towards the lockout', async () => {
    const { id, email } = await createUser('accounting_manager');
    const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
    const { secret } = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.beginMfaEnrolment(tx, id));
    const now = new Date('2026-10-02T10:00:00Z');
    const at = Math.floor(now.getTime() / 1000);
    await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
      authn.confirmMfaEnrolment(tx, { principal, branchCode: BAGHDAD }, id, totpAt(secret, Math.floor(at / 30)), at),
    );

    expect(await signIn(email, PASSWORD, null, now)).toEqual({ ok: false, refusal: 'second_factor_required' });
    expect(await signIn(email, PASSWORD, '000000', now)).toEqual({ ok: false, refusal: 'second_factor_wrong' });
    const good = await signIn(email, PASSWORD, totpAt(secret, Math.floor(at / 30)), now);
    expect(good.ok && good.restriction).toBeNull();
    const { rows } = await ownerPool.query(`select outcome from sign_in_attempt where user_id = $1 order by id`, [id]);
    expect(rows.map((r) => r.outcome)).toEqual(['second_factor_required', 'second_factor_wrong', 'success']);
  });

  it('never asks an ordinary account for a code', async () => {
    const { email } = await createUser(null);
    const result = await signIn(email, PASSWORD, null, new Date());
    expect(result.ok && result.restriction).toBeNull();
    expect(result.ok && result.enrolmentDue).toBeNull();
  });
});
