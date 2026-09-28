/**
 * One administrator, alone, from an empty company to a posted journal.
 *
 * The rest of the Phase 1 suite is written the way a finance team is staffed:
 * an officer raises, a manager approves. That is the right shape for a real
 * team and it hides four things from view, because a two-person harness
 * satisfies each of them by accident.
 *
 * A company that has just been handed the system has one person in it. On the
 * live install that person was a Super User with no role, in no finance
 * department, with no calendar and no USD rate — and every one of those refused
 * a different action, at a different moment, with a message about a different
 * screen. This is that person, doing the whole job on their own.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import * as roles from '@/server/services/roles';
import * as users from '@/server/services/users';
import * as trialBalance from '@/server/services/trial-balance';
import { can, PermissionDeniedError } from '@/server/domain/permissions';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BRANCH = 'HQ';
const YEAR = '2026';
const ON = `${YEAR}-08-16`;
const FROM = `${YEAR}-01-01`;
const TO = `${YEAR}-12-31`;

let admin: ActorContext;
const scope = () => ({ userId: admin.principal.userId, branchCode: BRANCH });

/** Reloads the principal, for the checks that depend on a grant just made. */
async function reload(): Promise<void> {
  const principal = await withScope(scope(), (tx) =>
    authz.loadPrincipal(tx, admin.principal.userId),
  );
  admin = { principal, branchCode: BRANCH };
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Head Office');

  // The company as it is handed over: one CEO with full access.
  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,true)`,
    [id, `${id}@example.com`, 'System Administrator'],
  );
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'ceo')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BRANCH,
  ]);
  const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  admin = { principal, branchCode: BRANCH };
});

describe('role permissions can be edited safely', () => {
  const createRole = (code: string) =>
    withScope(scope(), (tx) => roles.create(tx, admin, { name: 'Invoice approver', code }));

  const roleHolder = async (code: string): Promise<ActorContext> => {
    const id = randomUUID();
    await ownerPool.query(
      `insert into app_user (id, email, display_name) values ($1,$2,$3)`,
      [id, `${id}@example.com`, 'Invoice Approver'],
    );
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
      id,
      code,
    ]);
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
      id,
      BRANCH,
    ]);
    const principal = await withScope({ userId: id, branchCode: BRANCH }, (tx) =>
      authz.loadPrincipal(tx, id),
    );
    return { principal, branchCode: BRANCH };
  };

  it('replaces offered invoice grants and preserves grants outside the offered objects', async () => {
    const code = `invoice_approver_${randomUUID().slice(0, 8)}`;
    await createRole(code);
    await withScope(scope(), (tx) =>
      roles.setGrants(
        tx,
        admin,
        code,
        [
          { object: 'ap_invoice', verb: 'view' },
          { object: 'ap_invoice', verb: 'approve' },
          { object: 'ap_invoice', verb: 'post' },
          { object: 'ar_invoice', verb: 'view' },
          { object: 'ar_invoice', verb: 'approve' },
          { object: 'ar_invoice', verb: 'post' },
        ],
        { offeredObjects: ['ap_invoice', 'ar_invoice'] },
      ),
    );

    const holder = await roleHolder(code);
    const granted = await withScope(scope(), (tx) => roles.get(tx, code));
    expect(granted.grants).toEqual(
      expect.arrayContaining([
        { object: 'ap_invoice', verb: 'approve' },
        { object: 'ap_invoice', verb: 'post' },
        { object: 'ar_invoice', verb: 'approve' },
        { object: 'ar_invoice', verb: 'post' },
      ]),
    );
    expect(can(holder.principal, 'approve', 'ap_invoice')).toBe(true);
    expect(can(holder.principal, 'approve', 'ar_invoice')).toBe(true);

    await withScope(scope(), (tx) =>
      roles.setGrants(
        tx,
        admin,
        code,
        [
          { object: 'ap_invoice', verb: 'view' },
          { object: 'ap_invoice', verb: 'post' },
        ],
        { offeredObjects: ['ap_invoice'] },
      ),
    );
    const replaced = await withScope(scope(), (tx) =>
      authz.loadPrincipal(tx, holder.principal.userId),
    );
    expect(can(replaced, 'approve', 'ap_invoice')).toBe(false);
    expect(can(replaced, 'post', 'ap_invoice')).toBe(true);
    expect(can(replaced, 'approve', 'ar_invoice')).toBe(true);
    expect(can(replaced, 'post', 'ar_invoice')).toBe(true);

    await withScope(scope(), (tx) =>
      roles.setGrants(tx, admin, code, [], { offeredObjects: ['ap_invoice'] }),
    );
    const revoked = await withScope(scope(), (tx) =>
      authz.loadPrincipal(tx, holder.principal.userId),
    );
    expect(can(revoked, 'view', 'ap_invoice')).toBe(false);
    expect(can(revoked, 'post', 'ap_invoice')).toBe(false);
    expect(can(revoked, 'approve', 'ar_invoice')).toBe(true);
    expect(can(revoked, 'post', 'ar_invoice')).toBe(true);
  });

  it('leaves prior grants unchanged when no objects are offered', async () => {
    const code = `invoice_approver_${randomUUID().slice(0, 8)}`;
    await createRole(code);
    await withScope(scope(), (tx) =>
      roles.setGrants(tx, admin, code, [{ object: 'ap_invoice', verb: 'view' }], {
        offeredObjects: ['ap_invoice'],
      }),
    );
    const before = await withScope(scope(), (tx) => roles.get(tx, code));

    await withScope(scope(), (tx) =>
      roles.setGrants(tx, admin, code, [], { offeredObjects: [] }),
    );

    const after = await withScope(scope(), (tx) => roles.get(tx, code));
    expect(after.grants).toEqual(before.grants);
  });

  it('refuses a role holder without permission administration and keeps stored grants', async () => {
    const code = `invoice_approver_${randomUUID().slice(0, 8)}`;
    await createRole(code);
    await withScope(scope(), (tx) =>
      roles.setGrants(tx, admin, code, [{ object: 'ap_invoice', verb: 'view' }], {
        offeredObjects: ['ap_invoice'],
      }),
    );
    const holder = await roleHolder(code);

    await expect(
      withScope(
        { userId: holder.principal.userId, branchCode: BRANCH },
        (tx) =>
          roles.setGrants(
            tx,
            holder,
            code,
            [{ object: 'ap_invoice', verb: 'post' }],
            { offeredObjects: ['ap_invoice'] },
          ),
      ),
    ).rejects.toThrow(PermissionDeniedError);

    const stored = await withScope(scope(), (tx) => roles.get(tx, code));
    expect(stored.grants).toEqual([{ object: 'ap_invoice', verb: 'view' }]);
  });

  it('allows only the CEO to create roles, change grants, or assign a role', async () => {
    const code = `invoice_approver_${randomUUID().slice(0, 8)}`;
    const officer = await roleHolder('accounting_officer');
    await expect(
      withScope(
        { userId: officer.principal.userId, branchCode: BRANCH },
        (tx) => roles.create(tx, officer, { name: 'Blocked role', code }),
      ),
    ).rejects.toThrow(PermissionDeniedError);

    await createRole(code);
    await withScope(scope(), (tx) =>
      roles.setGrants(tx, admin, code, [{ object: 'ap_invoice', verb: 'view' }], {
        offeredObjects: ['ap_invoice'],
      }),
    );
    await expect(
      withScope(
        { userId: officer.principal.userId, branchCode: BRANCH },
        (tx) =>
          roles.setGrants(tx, officer, code, [{ object: 'ap_invoice', verb: 'post' }], {
            offeredObjects: ['ap_invoice'],
          }),
      ),
    ).rejects.toThrow(PermissionDeniedError);

    const targetId = randomUUID();
    await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Target')`, [
      targetId,
      `${targetId}@example.com`,
    ]);
    await expect(
      withScope(
        { userId: officer.principal.userId, branchCode: BRANCH },
        (tx) => users.setRole(tx, officer, targetId, code, true),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

// ---------------------------------------------------------------------------
describe('the four things that stop a fresh company posting', () => {
  it('being CEO and a Super User is not the same as holding an approval role', async () => {
    // This is the one that reads like a bug. Every screen lets this person in,
    // every permission check says yes — and then approval asks for a role they
    // were never granted, because a role is authority to decide, not access.
    expect(admin.principal.isSuperUser).toBe(true);
    expect(admin.principal.roleCodes).toEqual(['ceo']);

    await ownerPool.query(
      `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
    );
    const { rows } = await ownerPool.query(`select id from chart_of_account where code='A000001'`);
    const created = await withScope(scope(), (tx) =>
      coa.createAccount(tx, admin, {
        name: 'Cash on Hand',
        parentId: rows[0].id,
        currencyRestriction: 'IQD',
      }),
    );
    await withScope(scope(), (tx) => coa.submitForApproval(tx, admin, created.id));

    const message = await rejection(
      withScope(scope(), (tx) => coa.approve(tx, admin, created.id)),
    );
    expect(message).toMatch(/accounting_manager/);
  });

  it('says which screens fix a missing finance department, and calls it a department', async () => {
    await ownerPool.query(
      `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
      [admin.principal.userId],
    );
    await reload();

    const message = await rejection(
      withScope(scope(), (tx) =>
        journal.createDraft(tx, admin, {
          branchCode: BRANCH,
          documentDate: ON,
          postingDate: ON,
          description: 'Opening balance',
        }),
      ),
    );
    expect(message).toMatch(/Departments/);
    expect(message).toMatch(/Users/);
    // "This account is not in one" sends an accountant to the Chart of
    // Accounts, which is the wrong screen entirely.
    expect(message).not.toMatch(/this account/i);
  });

  it('refuses a journal in IQD when only the IQD rate exists, and names the screen', async () => {
    // The trap: IQD is the ledger currency and USD the reporting one, so a
    // journal that mentions no dollars at all still needs a USD rate.
    await ownerPool.query(
      `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
    );
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
      [admin.principal.userId],
    );
    await ownerPool.query(
      `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
      [admin.principal.userId],
    );
    await reload();
    await withScope(scope(), (tx) =>
      periods.createFiscalYear(tx, admin, { code: `FY${YEAR}`, startsOn: FROM, endsOn: TO }),
    );
    await ownerPool.query(`delete from exchange_rate where currency_code = 'USD'`);

    const { rows } = await ownerPool.query(`select id from chart_of_account where code='A000001'`);
    const account = await withScope(scope(), (tx) =>
      coa.createAccount(tx, admin, {
        name: 'Cash on Hand',
        parentId: rows[0].id,
        currencyRestriction: 'IQD',
      }),
    );
    await withScope(scope(), (tx) => coa.submitForApproval(tx, admin, account.id));
    await withScope(scope(), (tx) => coa.approve(tx, admin, account.id));

    const entry = await withScope(scope(), (tx) =>
      journal.createDraft(tx, admin, {
        branchCode: BRANCH,
        documentDate: ON,
        postingDate: ON,
        description: 'Opening balance',
      }),
    );

    const message = await rejection(
      withScope(scope(), (tx) =>
        journal.addLine(tx, admin, entry.id, {
          accountId: account.id,
          debit: '1000.00',
          dimensions: { department: 'FIN' },
        }),
      ),
    );
    expect(message).toMatch(/USD/);
    expect(message).toMatch(/Currencies and Rates/);
  });
});

// ---------------------------------------------------------------------------
describe('once those four are configured', () => {
  beforeEach(async () => {
    // Exactly what scripts/ops/phase1-setup.sh applies, in the same order.
    await ownerPool.query(
      `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
    );
    await ownerPool.query(
      `insert into user_department_scope (user_id, department_code, is_manager) values ($1,'FIN',true)`,
      [admin.principal.userId],
    );
    await ownerPool.query(
      `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
      [admin.principal.userId],
    );
    await reload();
    await withScope(scope(), (tx) =>
      periods.createFiscalYear(tx, admin, { code: `FY${YEAR}`, startsOn: FROM, endsOn: TO }),
    );
    await withScope(scope(), (tx) =>
      rates.publishRate(tx, admin, {
        currency: 'USD',
        iqdPerUnit: '1320.00000000',
        effectiveFrom: FROM,
        source: 'Central Bank of Iraq',
      }),
    );
  });

  /** Opened, submitted and approved by the one person there is. */
  async function account(parentCode: string, name: string): Promise<string> {
    const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
      parentCode,
    ]);
    const created = await withScope(scope(), (tx) =>
      coa.createAccount(tx, admin, {
        name,
        parentId: rows[0].id,
        currencyRestriction: 'IQD',
      }),
    );
    await withScope(scope(), (tx) => coa.submitForApproval(tx, admin, created.id));
    await withScope(scope(), (tx) => coa.approve(tx, admin, created.id));
    return created.id;
  }

  it('opens an account and approves it single-handed', async () => {
    // Before 0168 this raised SelfApprovalError and the account stayed pending
    // for ever, because the second person it waited for did not exist.
    const cash = await account('A000001', 'Cash on Hand');

    const { rows } = await ownerPool.query<{ approval_status: string; is_active: boolean }>(
      `select approval_status, is_active from chart_of_account where id = $1`,
      [cash],
    );
    expect(rows[0]!.approval_status).toBe('approved');
    expect(rows[0]!.is_active).toBe(true);
  });

  it('posts a balanced journal and sees it on the trial balance', async () => {
    const cash = await account('A000001', 'Cash on Hand');
    const capital = await account('E000001', 'Share Capital');

    const entry = await withScope(scope(), (tx) =>
      journal.createDraft(tx, admin, {
        branchCode: BRANCH,
        documentDate: ON,
        postingDate: ON,
        description: 'Opening capital',
      }),
    );
    for (const line of [
      { accountId: cash, debit: '5000000.00' },
      { accountId: capital, credit: '5000000.00' },
    ]) {
      await withScope(scope(), (tx) =>
        journal.addLine(tx, admin, entry.id, { ...line, dimensions: { department: 'FIN' } }),
      );
    }
    await withScope(scope(), (tx) => journal.submit(tx, admin, entry.id));

    const { rows } = await ownerPool.query<{ status: string }>(
      `select status from journal_entry where id = $1`,
      [entry.id],
    );
    expect(rows[0]!.status).toBe('posted');

    // And the report reflects it, which is the whole point of posting.
    const tb = await withScope(scope(), (tx) =>
      trialBalance.trialBalance(tx, { from: FROM, to: TO, branchCode: BRANCH }),
    );
    const line = (name: string) => tb.find((r) => r.accountName === name);
    expect(Number(line('Cash on Hand')?.debit)).toBe(5_000_000);
    expect(Number(line('Share Capital')?.credit)).toBe(5_000_000);

    const totals = trialBalance.totalsOf(tb);
    expect(totals.balances).toBe(true);
  });
});
