/**
 * REQ-HARDEN-001 HD2 — the temporary password.
 *
 * An administrator-issued password is good for one thing: setting a real one.
 * The session it produces is restricted to the password screen; the password
 * expires 72 hours after issue; replacing it clears the flag and the
 * restriction in the same statement; a re-issue replaces the old one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authn from '@/server/services/authentication';
import * as authz from '@/server/services/authorization';
import * as users from '@/server/services/users';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
const NIL = '00000000-0000-0000-0000-000000000000';
let admin: ActorContext;

async function createUser(isSuperUser = false, roleCode?: string): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [
    id,
    `${id}@example.com`,
    'Test User',
    isSuperUser,
  ]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  if (roleCode) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  // An account the administrator can reset: one with a credential row.
  await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.setPassword(tx, id, 'an ordinary first phrase'));
  return id;
}
async function contextFor(userId: string): Promise<ActorContext> {
  const principal = await withScope({ userId, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, userId));
  return { principal, branchCode: BAGHDAD };
}
const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const signIn = (email: string, password: string, now?: Date) =>
  withScope({ userId: NIL, branchCode: '' }, (tx) => authn.signIn(tx, { email, password, now }));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  admin = await contextFor(await createUser(true));
});

describe('HD2 · a temporary password opens one door', () => {
  it('restricts the session to the password screen until it is replaced, then lifts', async () => {
    const userId = await createUser();
    const email = `${userId}@example.com`;
    const temporary = await withScope(scope(admin), (tx) => users.resetPassword(tx, admin, userId));

    const first = await signIn(email, temporary);
    expect(first.ok && first.restriction).toBe('password');

    const user = await withScope(scope(admin), (tx) => users.get(tx, userId));
    expect(await withScope({ userId, branchCode: BAGHDAD }, (tx) => authn.restrictionFor(tx, user))).toBe('password');

    const me = await contextFor(userId);
    await withScope({ userId, branchCode: BAGHDAD }, (tx) =>
      users.changeOwnPassword(
        tx,
        me,
        { currentPassword: temporary, newPassword: 'a long and particular phrase', confirm: 'a long and particular phrase' },
        first.ok ? first.session.sessionId : '',
      ),
    );
    const after = await withScope(scope(admin), (tx) => users.get(tx, userId));
    expect(after.mustChangePassword).toBe(false);
    expect(await withScope({ userId, branchCode: BAGHDAD }, (tx) => authn.restrictionFor(tx, after))).toBeNull();
    const second = await signIn(email, 'a long and particular phrase');
    expect(second.ok && second.restriction).toBeNull();
  });

  it('expires 72 hours after issue, and a re-issue replaces it', async () => {
    const userId = await createUser();
    const email = `${userId}@example.com`;
    const temporary = await withScope(scope(admin), (tx) => users.resetPassword(tx, admin, userId));
    const issued = (await withScope(scope(admin), (tx) => users.get(tx, userId))).passwordChangedAt!;

    const inTime = await signIn(email, temporary, new Date(issued.getTime() + 71 * 3_600_000));
    expect(inTime.ok).toBe(true);
    const late = await signIn(email, temporary, new Date(issued.getTime() + 73 * 3_600_000));
    expect(late).toEqual({ ok: false, refusal: 'temporary_expired' });
    const { rows } = await ownerPool.query(`select outcome from sign_in_attempt where user_id = $1 order by id`, [userId]);
    expect(rows.map((r) => r.outcome)).toEqual(['success', 'temporary_expired']);

    const again = await withScope(scope(admin), (tx) => users.resetPassword(tx, admin, userId));
    expect(again).not.toBe(temporary);
    expect((await signIn(email, temporary)).ok).toBe(false);
    expect((await signIn(email, again)).ok).toBe(true);
  });
});
