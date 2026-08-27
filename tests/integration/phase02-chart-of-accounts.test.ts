/**
 * Phase 02.1 — Chart of Accounts, against a real PostgreSQL instance.
 *
 * The five groups received from the Business Process Owner are seeded by
 * migration 0003. Everything below them is added the way the business will add
 * it: an Accounting Officer raises the account, the Accounting Manager approves
 * it, and only then does it accept postings.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as coa from '@/server/services/chart-of-accounts';
import * as authz from '@/server/services/authorization';
import * as workflow from '@/server/services/workflow';
import { PermissionDeniedError } from '@domain/permissions';
import { InvalidTransitionError } from '@domain/statuses';
import { assertPostable, type AccountNode } from '@domain/chart-of-accounts';
import { normalBalanceForCode } from '@domain/accounts';

const BAGHDAD = 'BGW';

let assetsRootId: string;
let expenseRootId: string;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  const { rows } = await ownerPool.query(
    `select id, code from chart_of_account where is_system order by code`,
  );
  assetsRootId = rows.find((r) => r.code === 'A000001').id;
  expenseRootId = rows.find((r) => r.code === 'X000001').id;
});

/** A user holding one of the two seeded accounting roles. */
async function createUser(roleCode: string | null): Promise<string> {
  const id = randomUUID();
  await ownerPool.query(
    `insert into app_user (id, email, display_name) values ($1, $2, $3)`,
    [id, `${id}@example.com`, 'Test User'],
  );
  if (roleCode) {
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1, $2)`, [
      id,
      roleCode,
    ]);
  }
  await ownerPool.query(
    `insert into user_branch_scope (user_id, branch_code) values ($1, $2)`,
    [id, BAGHDAD],
  );
  return id;
}

async function contextFor(userId: string): Promise<coa.ActorContext> {
  const principal = await withScope({ userId, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, userId),
  );
  return { principal, branchCode: BAGHDAD };
}

/** Officer raises, manager approves — the whole route in one call. */
async function approvedAccount(
  officer: coa.ActorContext,
  manager: coa.ActorContext,
  input: coa.CreateAccountInput,
): Promise<AccountNode> {
  const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.createAccount(tx, officer, {
      // D7: a posting account needs a currency. Tests that care pass their own.
      currencyRestriction: input.isGroup ? null : 'IQD',
      ...input,
    }),
  );
  await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.submitForApproval(tx, officer, account.id),
  );
  await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.approve(tx, manager, account.id),
  );
  return withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
    coa.loadAccount(tx, account.id),
  );
}

// ---------------------------------------------------------------------------
describe('the five groups received from the Business Process Owner', () => {
  it('are seeded as approved, active group accounts at the root', async () => {
    const { rows } = await ownerPool.query(
      `select code, name, account_type, is_group, is_active, approval_status, level, is_system
         from chart_of_account where parent_id is null order by code`,
    );

    expect(rows.map((r) => r.code)).toEqual([
      'A000001',
      'E000001',
      'L000001',
      'R000001',
      'X000001',
    ]);
    for (const row of rows) {
      expect(row.is_group, row.code).toBe(true);
      expect(row.is_active, row.code).toBe(true);
      expect(row.approval_status, row.code).toBe('approved');
      expect(row.level, row.code).toBe(0);
      expect(row.is_system, row.code).toBe(true);
    }
  });

  it('gives Expense a debit normal balance, whatever the extract said', async () => {
    // The received file showed X000001 as credit-normal. It is seeded as an
    // expense account and the normal balance is derived from that.
    const { rows } = await ownerPool.query(
      `select account_type from chart_of_account where code = 'X000001'`,
    );
    expect(rows[0].account_type).toBe('expense');
    expect(normalBalanceForCode('X000001')).toBe('debit');
  });

  it('refuses to delete a root, however it is attempted', async () => {
    await expect(
      ownerPool.query(`delete from chart_of_account where code = 'A000001'`),
    ).rejects.toThrow(/one of the five type roots and cannot be deleted/);
  });

  it('nothing can post to a root, because a group is not a posting account', async () => {
    const root = await withScope({ userId: randomUUID(), branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, assetsRootId),
    );
    expect(() => assertPostable(root, { source: 'system' })).toThrow(/it is a group account/);
  });
});

// ---------------------------------------------------------------------------
describe('an Accounting Officer raises an account, the Manager approves it', () => {
  it('allocates the next code automatically and starts it as a draft', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));

    const account = await withScope(
      { userId: officer.principal.userId, branchCode: BAGHDAD },
      (tx) => coa.createAccount(tx, officer, { name: 'Current Assets', parentId: assetsRootId, isGroup: true }),
    );

    // A000001 is the root, so the first account raised under it is A000002.
    expect(account.code).toBe('A000002');
    expect(account.accountType).toBe('asset');
    expect(account.approvalStatus).toBe('draft');
    expect(account.isActive).toBe(false);
  });

  it('numbers each type from its own counter', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));

    const asset = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    const expense = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Salaries', parentId: expenseRootId, currencyRestriction: 'IQD' }),
    );

    expect(asset.code).toBe('A000002');
    expect(expense.code).toBe('X000002');
    expect(expense.accountType).toBe('expense');
  });

  it('does not let a draft account be posted to', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));
    const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash on Hand', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );

    expect(() => assertPostable(account, { source: 'system' })).toThrow(
      /only once the Accounting Manager has approved it/,
    );
  });

  it('activates the account on approval, and not before', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));
    const manager = await contextFor(await createUser('accounting_manager'));

    const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash on Hand', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );

    await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.submitForApproval(tx, officer, account.id),
    );

    const submitted = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, account.id),
    );
    expect(submitted.approvalStatus).toBe('submitted');
    expect(submitted.isActive).toBe(false);

    await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.approve(tx, manager, account.id),
    );

    const approved = await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, account.id),
    );
    expect(approved.approvalStatus).toBe('approved');
    expect(approved.isActive).toBe(true);
    expect(() => assertPostable(approved, { source: 'system' })).not.toThrow();
  });

  it('refuses to let the Officer approve their own account', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));

    const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash on Hand', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.submitForApproval(tx, officer, account.id),
    );

    // Denied on the verb: an Officer holds no 'approve' grant at all.
    await expect(
      withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.approve(tx, officer, account.id),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('lets a Manager approve an account they raised themselves', async () => {
    // 0168 — the route was seeded with allow_self_approval false, which meant a
    // company with one accountant could never get an account approved at all.
    // `journal_entry`, which moves money, has allowed this since 0006; an
    // account is a label a journal points at, so holding it to the stricter
    // standard was backwards. Flip the flag in 0168 to restore maker-checker.
    const manager = await contextFor(await createUser('accounting_manager'));

    const account = await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, manager, { name: 'Cash on Hand', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.submitForApproval(tx, manager, account.id),
    );

    await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.approve(tx, manager, account.id),
    );

    // Approval is what makes an account usable, so the effect is what matters,
    // not that the call returned.
    const approved = await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, account.id),
    );
    expect(approved.approvalStatus).toBe('approved');
    expect(approved.isActive).toBe(true);
  });

  it('refuses a user with no accounting role entirely', async () => {
    const nobody = await contextFor(await createUser(null));

    await expect(
      withScope({ userId: nobody.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.createAccount(tx, nobody, { name: 'Slush Fund', parentId: assetsRootId, currencyRestriction: 'IQD' }),
      ),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it('cannot skip the Manager by jumping a draft straight to approved', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));
    const manager = await contextFor(await createUser('accounting_manager'));

    const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash on Hand', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );

    // Never submitted, so 'draft' → 'approved' is not on the allow-list.
    await expect(
      withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.approve(tx, manager, account.id),
      ),
    ).rejects.toThrow(InvalidTransitionError);
  });

  it('records a rejection with its reason and keeps the decision history', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));
    const manager = await contextFor(await createUser('accounting_manager'));

    const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Miscellaneous', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.submitForApproval(tx, officer, account.id),
    );
    await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.reject(tx, manager, account.id, 'Too vague — name the actual asset'),
    );

    const rejected = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, account.id),
    );
    expect(rejected.approvalStatus).toBe('rejected');
    expect(rejected.isActive).toBe(false);

    const history = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      workflow.historyFor(tx, coa.DOCUMENT_TYPE, account.id),
    );
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      decision: 'rejected',
      reason: 'Too vague — name the actual asset',
      actorUserId: manager.principal.userId,
    });
  });

  it('keeps the earlier decisions when a corrected account is resubmitted', async () => {
    // 01.7 gate: the full decision history survives across revisions.
    const officer = await contextFor(await createUser('accounting_officer'));
    const manager = await contextFor(await createUser('accounting_manager'));

    const account = await withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.createAccount(tx, officer, { name: 'Miscellaneous', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    const officerScope = { userId: officer.principal.userId, branchCode: BAGHDAD };
    const managerScope = { userId: manager.principal.userId, branchCode: BAGHDAD };

    await withScope(officerScope, (tx) => coa.submitForApproval(tx, officer, account.id));
    await withScope(managerScope, (tx) => coa.reject(tx, manager, account.id, 'Name it properly'));
    await withScope(officerScope, (tx) => coa.returnToDraft(tx, officer, account.id));
    await withScope(officerScope, (tx) => coa.submitForApproval(tx, officer, account.id));
    await withScope(managerScope, (tx) => coa.approve(tx, manager, account.id));

    const history = await withScope(officerScope, (tx) =>
      workflow.historyFor(tx, coa.DOCUMENT_TYPE, account.id),
    );

    expect(history.map((h) => h.decision)).toEqual(['rejected', 'approved']);
    expect(history[0]!.revision).toBe(1);
    expect(history[1]!.revision).toBe(2);

    const approved = await withScope(managerScope, (tx) => coa.loadAccount(tx, account.id));
    expect(approved.isActive).toBe(true);
  });

  it('audits every step of the route', async () => {
    const officer = await contextFor(await createUser('accounting_officer'));
    const manager = await contextFor(await createUser('accounting_manager'));

    const account = await approvedAccount(officer, manager, {
      name: 'Cash on Hand',
      parentId: assetsRootId,
    });

    const { rows } = await ownerPool.query(
      `select action, actor_user_id from audit_event where object_id = $1 order by id`,
      [account.id],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'chart_of_account.created',
      'chart_of_account.submitted',
      'chart_of_account.approved',
    ]);
    expect(rows[2].actor_user_id).toBe(manager.principal.userId);
  });
});

// ---------------------------------------------------------------------------
describe('the tree holds its shape (§1.2)', () => {
  let officer: coa.ActorContext;
  let manager: coa.ActorContext;

  beforeEach(async () => {
    officer = await contextFor(await createUser('accounting_officer'));
    manager = await contextFor(await createUser('accounting_manager'));
  });

  it('nests groups inside groups, to any depth', async () => {
    const current = await approvedAccount(officer, manager, {
      name: 'Current Assets',
      parentId: assetsRootId,
      isGroup: true,
    });
    const cashAndBank = await approvedAccount(officer, manager, {
      name: 'Cash and Bank',
      parentId: current.id,
      isGroup: true,
    });
    const petty = await approvedAccount(officer, manager, {
      name: 'Petty Cash',
      parentId: cashAndBank.id,
    });

    expect([current.level, cashAndBank.level, petty.level]).toEqual([1, 2, 3]);

    const tree = await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.tree(tx),
    );
    const assets = tree.find((n) => n.code === 'A000001')!;
    expect(assets.children[0]!.name).toBe('Current Assets');
    expect(assets.children[0]!.children[0]!.name).toBe('Cash and Bank');
    expect(assets.children[0]!.children[0]!.children[0]!.name).toBe('Petty Cash');
  });

  it('refuses to hang an account under a posting account', async () => {
    const cash = await approvedAccount(officer, manager, {
      name: 'Cash on Hand',
      parentId: assetsRootId,
    });

    await expect(
      withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.createAccount(tx, officer, { name: 'Petty Cash', parentId: cash.id, currencyRestriction: 'IQD' }),
      ),
    ).rejects.toThrow(/posting account, so it cannot hold children/);
  });

  it('inherits the type from the parent, so an expense cannot live under Assets', async () => {
    const officerScope = { userId: officer.principal.userId, branchCode: BAGHDAD };

    const underAssets = await withScope(officerScope, (tx) =>
      coa.createAccount(tx, officer, { name: 'Rent', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    expect(underAssets.accountType).toBe('asset');
    expect(underAssets.code.startsWith('A')).toBe(true);

    // And the database refuses a hand-written contradiction outright.
    await expect(
      ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id)
         values ('X999999', 'Smuggled Expense', 'expense', $1)`,
        [assetsRootId],
      ),
    ).rejects.toThrow(/inherits its parent's type/);
  });

  it('refuses a code whose letter contradicts its type', async () => {
    // The letter carries the type. A code that follows the convention and then
    // disagrees with it would make every chart listing lie.
    await expect(
      ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id)
         values ('X999998', 'Mislabelled', 'asset', $1)`,
        [assetsRootId],
      ),
    ).rejects.toThrow(/begins with 'X', which means expense, but the account is typed asset/);
  });

  it('accepts a code outside the convention, since the chart is configurable', async () => {
    // §1.2 — a company that later adopts 4-digit or dotted codes must not need
    // a code change. The convention is held to when used, not imposed.
    await expect(
      ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, currency_restriction)
         values ('1100.10', 'Imported Legacy Account', 'asset', $1, 'IQD')`,
        [assetsRootId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses to move an account beneath its own descendant', async () => {
    const parent = await approvedAccount(officer, manager, {
      name: 'Current Assets',
      parentId: assetsRootId,
      isGroup: true,
    });
    const child = await approvedAccount(officer, manager, {
      name: 'Cash and Bank',
      parentId: parent.id,
      isGroup: true,
    });

    await expect(
      ownerPool.query(`update chart_of_account set parent_id = $1 where id = $2`, [
        child.id,
        parent.id,
      ]),
    ).rejects.toThrow(/beneath itself or one of its own descendants/);
  });

  it('restacks the depth of a whole subtree when it is moved', async () => {
    const current = await approvedAccount(officer, manager, {
      name: 'Current Assets',
      parentId: assetsRootId,
      isGroup: true,
    });
    const cashAndBank = await approvedAccount(officer, manager, {
      name: 'Cash and Bank',
      parentId: current.id,
      isGroup: true,
    });
    const petty = await approvedAccount(officer, manager, {
      name: 'Petty Cash',
      parentId: cashAndBank.id,
    });

    // Move 'Cash and Bank' up to sit directly under Assets.
    await ownerPool.query(`update chart_of_account set parent_id = $1 where id = $2`, [
      assetsRootId,
      cashAndBank.id,
    ]);

    const { rows } = await ownerPool.query(
      `select code, level from chart_of_account where id = any($1::uuid[]) order by level`,
      [[cashAndBank.id, petty.id]],
    );
    expect(rows.map((r) => r.level)).toEqual([1, 2]);
  });

  it('refuses to turn a group with children into a posting account', async () => {
    const current = await approvedAccount(officer, manager, {
      name: 'Current Assets',
      parentId: assetsRootId,
      isGroup: true,
    });
    await approvedAccount(officer, manager, { name: 'Cash', parentId: current.id, currencyRestriction: 'IQD' });

    await expect(
      ownerPool.query(`update chart_of_account set is_group = false where id = $1`, [current.id]),
    ).rejects.toThrow(/child account\(s\) and cannot become a posting account/);
  });

  it('refuses to add an account under an inactive group', async () => {
    const retired = await approvedAccount(officer, manager, {
      name: 'Retired Group',
      parentId: assetsRootId,
      isGroup: true,
    });
    await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.deactivate(tx, manager, retired.id, 'Restructuring the chart'),
    );

    await expect(
      withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.createAccount(tx, officer, { name: 'Orphan', parentId: retired.id, currencyRestriction: 'IQD' }),
      ),
    ).rejects.toThrow(/Reactivate it before adding accounts beneath it/);
  });

  it('refuses to deactivate a group that still has active children', async () => {
    const current = await approvedAccount(officer, manager, {
      name: 'Current Assets',
      parentId: assetsRootId,
      isGroup: true,
    });
    await approvedAccount(officer, manager, { name: 'Cash', parentId: current.id, currencyRestriction: 'IQD' });

    await expect(
      withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.deactivate(tx, manager, current.id, 'Tidying up'),
      ),
    ).rejects.toThrow(/active child account/);
  });
});

// ---------------------------------------------------------------------------
describe('account settings that govern posting', () => {
  let officer: coa.ActorContext;
  let manager: coa.ActorContext;

  beforeEach(async () => {
    officer = await contextFor(await createUser('accounting_officer'));
    manager = await contextFor(await createUser('accounting_manager'));
  });

  it('protects a control account from a manual journal (§14.3)', async () => {
    const receivables = await approvedAccount(officer, manager, {
      name: 'Trade Receivables',
      parentId: assetsRootId,
      controlAccount: 'customer',
    });

    expect(receivables.controlAccount).toBe('customer');
    expect(() => assertPostable(receivables, { source: 'manual' })).toThrow(
      /requires Finance Manager approval/,
    );
    expect(() =>
      assertPostable(receivables, { source: 'manual', actorIsFinanceManager: true }),
    ).not.toThrow();
    expect(() => assertPostable(receivables, { source: 'system' })).not.toThrow();
  });

  it('refuses to make a group a control account', async () => {
    // A group has no balance of its own to reconcile a subledger against.
    await expect(
      ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, is_group, control_account)
         values ('A999999', 'Group Control', 'asset', $1, true, 'customer')`,
        [assetsRootId],
      ),
    ).rejects.toThrow(/chart_of_account_group_not_control/);
  });

  it('carries the currency restriction and the required dimensions', async () => {
    const salaries = await approvedAccount(officer, manager, {
      name: 'Salaries',
      parentId: expenseRootId,
      currencyRestriction: 'IQD',
      requiredDimensions: ['department', 'branch'],
    });

    const reloaded = await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, salaries.id),
    );
    expect(reloaded.currencyRestriction).toBe('IQD');
    expect([...reloaded.requiredDimensions].sort()).toEqual(['branch', 'department']);
  });

  it('refuses to activate an account that has not been approved', async () => {
    // The maker-checker rule, held by the database rather than by the service.
    const officerScope = { userId: officer.principal.userId, branchCode: BAGHDAD };
    const draft = await withScope(officerScope, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );

    await expect(
      ownerPool.query(`update chart_of_account set is_active = true where id = $1`, [draft.id]),
    ).rejects.toThrow(/chart_of_account_active_requires_approval/);
  });

  it('refuses to change the code or type once submitted', async () => {
    const officerScope = { userId: officer.principal.userId, branchCode: BAGHDAD };
    const account = await withScope(officerScope, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );
    await withScope(officerScope, (tx) => coa.submitForApproval(tx, officer, account.id));

    await expect(
      ownerPool.query(`update chart_of_account set code = 'A555555' where id = $1`, [account.id]),
    ).rejects.toThrow(/code of account .* cannot be changed/);

    await expect(
      ownerPool.query(`update chart_of_account set account_type = 'expense' where id = $1`, [
        account.id,
      ]),
    ).rejects.toThrow(/type of account .* cannot be changed/);
  });

  it('refuses to delete an approved account — it is deactivated instead', async () => {
    const account = await approvedAccount(officer, manager, {
      name: 'Cash on Hand',
      parentId: assetsRootId,
    });

    await expect(
      ownerPool.query(`delete from chart_of_account where id = $1`, [account.id]),
    ).rejects.toThrow(/has been approved and cannot be deleted/);

    await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.deactivate(tx, manager, account.id, 'Bank account closed'),
    );

    const retired = await withScope({ userId: manager.principal.userId, branchCode: BAGHDAD }, (tx) =>
      coa.loadAccount(tx, account.id),
    );
    expect(retired.isActive).toBe(false);
    expect(() => assertPostable(retired, { source: 'system' })).toThrow(/the account is inactive/);
  });

  it('lists only approved, active, non-group accounts as postable', async () => {
    const officerScope = { userId: officer.principal.userId, branchCode: BAGHDAD };

    const group = await approvedAccount(officer, manager, {
      name: 'Current Assets',
      parentId: assetsRootId,
      isGroup: true,
    });
    const cash = await approvedAccount(officer, manager, { name: 'Cash', parentId: group.id, currencyRestriction: 'IQD' });
    await withScope(officerScope, (tx) =>
      coa.createAccount(tx, officer, { name: 'Unapproved', parentId: group.id, currencyRestriction: 'IQD' }),
    );

    const postable = await withScope(officerScope, (tx) => coa.postableAccounts(tx));
    const codes = postable.map((a) => a.code);

    // The approved leaf is postable; the group above it and the unapproved
    // sibling are not. (The branch fixture's own cash account is postable too,
    // which is why this asserts membership rather than the whole list.)
    expect(codes).toContain(cash.code);
    expect(codes).not.toContain(group.code);
    expect(postable.every((a) => !a.isGroup && a.isActive)).toBe(true);
    expect(postable).toHaveLength(codes.filter((c) => c !== group.code).length);
  });

  it('never lets the same account code be issued twice', async () => {
    const officerScope = { userId: officer.principal.userId, branchCode: BAGHDAD };
    const first = await withScope(officerScope, (tx) =>
      coa.createAccount(tx, officer, { name: 'Cash', parentId: assetsRootId, currencyRestriction: 'IQD' }),
    );

    await expect(
      ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, currency_restriction)
         values ($1,'Clone','asset',$2,'IQD')`,
        [first.code, assetsRootId],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

// ---------------------------------------------------------------------------
// D7, decided 2026-08-17: "Each Chart of Accounts account is limited to one
// currency only … the currency should not be assumed automatically."
// ---------------------------------------------------------------------------
describe('D7 · one currency per account', () => {
  let officer: coa.ActorContext;
  let assetsRootId: string;

  beforeEach(async () => {
    officer = await contextFor(await createUser('accounting_officer'));
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    assetsRootId = rows[0].id;
  });

  it('refuses a posting account with no currency rather than assuming IQD', async () => {
    await expect(
      withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.createAccount(tx, officer, { name: 'Cash', parentId: assetsRootId }),
      ),
    ).rejects.toBeInstanceOf(coa.AccountCurrencyRequiredError);
  });

  it('says what to do about the same account in a second currency', async () => {
    const error = await withScope(
      { userId: officer.principal.userId, branchCode: BAGHDAD },
      (tx) => coa.createAccount(tx, officer, { name: 'Cash', parentId: assetsRootId }),
    ).catch((e: Error) => e);

    // §25 — the field, the reason, the corrective action.
    expect((error as Error).message).toMatch(/create a separate account/i);
  });

  it('refuses a currency on a group, which holds no balance', async () => {
    await expect(
      withScope({ userId: officer.principal.userId, branchCode: BAGHDAD }, (tx) =>
        coa.createAccount(tx, officer, {
          name: 'Current Assets',
          parentId: assetsRootId,
          isGroup: true,
          currencyRestriction: 'IQD',
        }),
      ),
    ).rejects.toBeInstanceOf(coa.GroupAccountCurrencyError);
  });

  it('stores the currency it was given, normalised', async () => {
    const account = await withScope(
      { userId: officer.principal.userId, branchCode: BAGHDAD },
      (tx) =>
        coa.createAccount(tx, officer, {
          name: 'Cash — US Dollar',
          parentId: assetsRootId,
          currencyRestriction: ' usd ',
        }),
    );
    expect(account.currencyRestriction).toBe('USD');
  });

  it('refuses at the database too, bypassing the service', async () => {
    await expect(
      ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, is_group, level)
         values ('A900001', 'Currencyless', 'asset', $1, false, 1)`,
        [assetsRootId],
      ),
    ).rejects.toThrow(/chart_of_account_posting_needs_currency/);
  });

  it('lets the same kind of account exist once per currency', async () => {
    const scope = { userId: officer.principal.userId, branchCode: BAGHDAD };
    const iqd = await withScope(scope, (tx) =>
      coa.createAccount(tx, officer, {
        name: 'Cash — IQD',
        parentId: assetsRootId,
        currencyRestriction: 'IQD',
      }),
    );
    const usd = await withScope(scope, (tx) =>
      coa.createAccount(tx, officer, {
        name: 'Cash — USD',
        parentId: assetsRootId,
        currencyRestriction: 'USD',
      }),
    );

    // Siblings, not one account with two balances — which is what makes the
    // currency of any balance unambiguous.
    expect(iqd.code).not.toBe(usd.code);
    expect(iqd.parentId).toBe(usd.parentId);
  });
});
