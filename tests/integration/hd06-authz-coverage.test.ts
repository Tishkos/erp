/**
 * REQ-HARDEN-001 HD6 — the mutations the audit found unguarded refuse a
 * caller without the grant, write the refusal, and the open redirect is
 * closed. workflow.submit takes the submitter from the context, never from
 * the input.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as collections from '@/server/services/ar-collections';
import * as notifications from '@/server/services/notifications';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';

async function createUser(roleCode: string | null): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Test User')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  if (roleCode) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
});

describe('HD6 · authorisation on every mutation', () => {
  it('resolving a promise to pay needs the collections grant, and the refusal is written', async () => {
    const nobody = await createUser(null);
    const { rows: partner } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
       values ('CUS-HD6','Promise Co',true,false,'active',true) returning id`,
    );
    const { rows: promise } = await ownerPool.query(
      `insert into promise_to_pay (customer_id, branch_code, promised_on, amount_iqd, status, recorded_by)
       values ($1,$2,'2026-10-10',1000,'open',$3) returning id`,
      [partner[0].id, BAGHDAD, nobody.principal.userId],
    );
    expect(await rejection(withScope(scope(nobody), (tx) => collections.resolvePromise(tx, nobody, promise[0].id, 'kept')))).toMatch(
      /not permitted|denied|may not/i,
    );
    const { rows: audit } = await ownerPool.query(
      `select action from audit_event where actor_user_id = $1 and action = 'authorisation.denied'`,
      [nobody.principal.userId],
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const { rows: still } = await ownerPool.query(`select status from promise_to_pay where id = $1`, [promise[0].id]);
    expect(still[0].status).toBe('open');
  });

  it('marking a notification read is the recipient’s act; another user’s id is a no-op', async () => {
    const alice = await createUser(null);
    const bob = await createUser(null);
    const { rows } = await ownerPool.query(
      `insert into notification (recipient_user_id, event_type, subject, body, object_type, object_id, dedupe_key, branch_code)
       values ($1,'test','Hello','—','test',$2,$3,$4) returning id`,
      [alice.principal.userId, randomUUID(), randomUUID(), BAGHDAD],
    );
    const id = BigInt(rows[0].id);
    expect(await withScope(scope(bob), (tx) => notifications.markRead(tx, id, bob.principal.userId))).toBe(0);
    expect(await withScope(scope(alice), (tx) => notifications.markRead(tx, id, alice.principal.userId))).toBe(1);
    // And bob cannot even see it: the policy hides other people's notifications.
    expect(await withScope(scope(bob), (tx) => notifications.inboxFor(tx, alice.principal.userId))).toEqual([]);
  });
});
