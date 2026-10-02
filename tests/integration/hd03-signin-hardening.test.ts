/**
 * REQ-HARDEN-001 HD3 — sign-in is rate-limited, locked out and audited.
 *
 * D-HD-3: five failures in fifteen minutes lock the account from that
 * address; every attempt — success or refusal — is a sign_in_attempt row and
 * an audit event; the lock applies whether or not the account exists, so the
 * form does not say which addresses hold one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authn from '@/server/services/authentication';

const BAGHDAD = 'BGW';
const NIL = '00000000-0000-0000-0000-000000000000';
const PASSWORD = 'correct horse battery staple';

async function createUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `${id}@example.com`;
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Test User')`, [id, email]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authn.setPassword(tx, id, PASSWORD));
  return { id, email };
}
const attempt = (email: string, password: string, ipAddress: string | null, now?: Date) =>
  withScope({ userId: NIL, branchCode: '' }, (tx) => authn.signIn(tx, { email, password, ipAddress, now }));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
});

describe('HD3 · lockout and audit', () => {
  it('locks the account from that address after five failures, for fifteen minutes', async () => {
    const { email } = await createUser();
    const t0 = new Date('2026-10-02T08:00:00Z');
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt(email, 'wrong', '10.0.0.1', t0)).ok).toBe(false);
    }
    // The right password is refused while locked, and the refusal is recorded as such.
    expect(await attempt(email, PASSWORD, '10.0.0.1', new Date(t0.getTime() + 60_000))).toEqual({ ok: false, refusal: 'locked' });
    // Another address is not locked — the lock is per account + address.
    expect((await attempt(email, PASSWORD, '10.0.0.2', new Date(t0.getTime() + 60_000))).ok).toBe(true);
    // Fifteen minutes later the window has passed.
    expect((await attempt(email, PASSWORD, '10.0.0.1', new Date(t0.getTime() + 16 * 60_000))).ok).toBe(true);

    const { rows } = await ownerPool.query(`select outcome, ip_address from sign_in_attempt where email = $1 order by id`, [email]);
    expect(rows.map((r) => r.outcome)).toEqual(['failed', 'failed', 'failed', 'failed', 'failed', 'locked', 'success', 'success']);
    const { rows: audit } = await ownerPool.query(
      `select action, outcome from audit_event where object_type = 'user' and action like 'authentication.%' order by id`,
    );
    expect(audit.filter((a) => a.action === 'authentication.sign_in_refused' && a.outcome === 'denied')).toHaveLength(6);
    expect(audit.filter((a) => a.action === 'authentication.signed_in')).toHaveLength(2);
  });

  it('locks an unknown address the same way, and an address that hammers many accounts', async () => {
    const t0 = new Date('2026-10-02T09:00:00Z');
    for (let i = 0; i < 5; i += 1) await attempt('nobody@example.com', 'x', '10.0.0.9', t0);
    expect(await attempt('nobody@example.com', 'x', '10.0.0.9', t0)).toEqual({ ok: false, refusal: 'locked' });

    const { email } = await createUser();
    for (let i = 0; i < 100; i += 1) await attempt(`guess${i}@example.com`, 'x', '10.0.0.7', t0);
    expect(await attempt(email, PASSWORD, '10.0.0.7', t0)).toEqual({ ok: false, refusal: 'locked' });
  });
});
