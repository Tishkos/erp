/**
 * The dashboard is composed out of permissions — REQ-DASH-001 §2.
 *
 * The claim under test is the one the sponsor asked for on 2026-09-29: *"each
 * role permission has different dashboard … CEO sees everything … but some
 * people shouldn't be able to see this"*. Nothing in the page configures that.
 * Every band asks the same permission object its own screen asks, so the shape
 * of a person's dashboard falls out of their grants — and the thing worth
 * testing is precisely that it falls out, rather than being a list somebody
 * maintains beside the grants and forgets.
 *
 * A band a person may not see is `null`, and the page does not render it. That
 * is not the same as a refusal: the absence of a band is not a disclosure,
 * while "you may not see this" names what is behind the wall.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authorization from '@/server/services/authorization';
import * as dashboard from '@/server/services/dashboard';
import { registerAllLists } from '@/server/lists';
import type { Principal } from '@/server/domain/permissions';

const BRANCH = 'HQ';

async function userWithRole(role: string | null): Promise<Principal> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    role ?? 'no role',
  ]);
  if (role) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BRANCH]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`,
    [id],
  );
  return withScope({ userId: id, branchCode: BRANCH }, (tx) => authorization.loadPrincipal(tx, id));
}

const read = (principal: Principal) =>
  withScope({ userId: principal.userId, branchCode: BRANCH }, (tx) =>
    dashboard.forPrincipal(tx, principal, BRANCH),
  );

let ceo: Principal;
let manager: Principal;
let officer: Principal;
let nobody: Principal;

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');
  await ownerPool.query(`insert into department (code, name, active) values ('FIN','Finance',true) on conflict do nothing`);
  registerAllLists();
  [ceo, manager, officer, nobody] = await Promise.all([
    userWithRole('ceo'),
    userWithRole('accounting_manager'),
    userWithRole('accounting_officer'),
    userWithRole(null),
  ]);
});

describe('the dashboard is built out of grants, not out of roles', () => {
  it('gives the CEO the audit trail and gives it to nobody else below the administrator', async () => {
    // `audit_event` is the one object migration 0221 grants the CEO and not
    // the accounting roles, so the activity band is the clearest difference
    // between one person's dashboard and another's.
    expect((await read(ceo)).activity).not.toBeNull();
    expect((await read(manager)).activity).toBeNull();
    expect((await read(officer)).activity).toBeNull();
  });

  it('gives the money bands to everyone who may view the documents behind them', async () => {
    for (const principal of [ceo, manager, officer]) {
      const view = await read(principal);
      expect(view.receivable, 'receivable').not.toBeNull();
      expect(view.payable, 'payable').not.toBeNull();
      expect(view.balances, 'balances').not.toBeNull();
      expect(view.result, 'result').not.toBeNull();
    }
  });

  it('gives a person holding nothing an empty page rather than a refusal', async () => {
    const view = await read(nobody);
    expect(view.activity).toBeNull();
    expect(view.receivable).toBeNull();
    expect(view.payable).toBeNull();
    expect(view.balances).toBeNull();
    expect(view.result).toBeNull();
    // The two bands that ask nothing of the chart still answer, with nothing
    // in them — a person with no grants has no approvals and no findings.
    expect(view.waiting?.approvals).toEqual([]);
    expect(view.attention && dashboard.hasAttention(view.attention)).toBe(false);
  });

  it('says which branch and which day every figure belongs to', async () => {
    const view = await read(manager);
    expect(view.branchCode).toBe(BRANCH);
    expect(view.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('answers with empty ageing rather than a total nobody can reconcile', async () => {
    // No invoices exist in this suite, so every bucket is absent and the total
    // is zero — not null, which would read as "could not be read".
    const view = await read(manager);
    expect(view.receivable?.buckets).toEqual([]);
    expect(view.receivable?.invoices).toBe(0);
    expect(Number(view.receivable?.totalIqd)).toBe(0);
  });
});
