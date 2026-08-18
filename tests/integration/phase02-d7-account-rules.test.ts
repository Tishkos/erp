/**
 * D7, decided 2026-08-17 — the two account rules the Business Process Owner
 * settled last, and neither is a list of accounts:
 *
 *   "Dimension rules are configured primarily at the account-group level. Child
 *    accounts automatically inherit the group's rules … Finance may override a
 *    rule for a specific account when necessary."
 *
 *   "The Accounting Officer may propose that an account is a control account
 *    when creating it, but the Accounting Manager must approve the designation
 *    before the account becomes active. … Once a control account has
 *    transactions, changing or removing its control-account status should
 *    require Accounting Manager approval and should not be allowed if doing so
 *    would break existing accounting mappings."
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import type { AccountTreeNode } from '@domain/chart-of-accounts';

const BAGHDAD = 'BGW';

let officer: coa.ActorContext;
let manager: coa.ActorContext;
let assetsRootId: string;
let expenseRootId: string;

async function createUser(roleCode: string): Promise<coa.ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    roleCode,
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, roleCode]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);

  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');

  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');

  const { rows } = await ownerPool.query(
    `select id, code from chart_of_account where is_system order by code`,
  );
  assetsRootId = rows.find((r) => r.code === 'A000001').id;
  expenseRootId = rows.find((r) => r.code === 'X000001').id;
});

const asOfficer = <T>(fn: Parameters<typeof withScope<T>>[1]) =>
  withScope<T>({ userId: officer.principal.userId, branchCode: BAGHDAD }, fn);
const asManager = <T>(fn: Parameters<typeof withScope<T>>[1]) =>
  withScope<T>({ userId: manager.principal.userId, branchCode: BAGHDAD }, fn);

/**
 * A group, raised and approved.
 *
 * Accounts cannot hang below a group that is not yet active — the tree refuses
 * to grow under an account nobody has approved — so every fixture here goes
 * through the maker-checker route rather than around it.
 */
async function approvedGroup(
  name: string,
  parentId: string,
  requiredDimensions?: readonly ('branch' | 'department' | 'project')[],
) {
  const group = await asOfficer((tx) =>
    coa.createAccount(tx, officer, {
      name,
      parentId,
      isGroup: true,
      ...(requiredDimensions ? { requiredDimensions } : {}),
    }),
  );
  await asOfficer((tx) => coa.submitForApproval(tx, officer, group.id));
  await asManager((tx) => coa.approve(tx, manager, group.id));
  return group;
}

// ---------------------------------------------------------------------------

describe('D7 · dimension rules are set at the group and inherited', () => {
  it('applies a group’s rules to an account created beneath it', async () => {
    // The owner's own example: Operating Expenses requires Branch and Cost
    // Centre, and everything below inherits both.
    const group = await approvedGroup('Operating Expenses', expenseRootId, [
      'branch',
      'department',
    ]);

    const salaries = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Salaries',
        parentId: group.id,
        currencyRestriction: 'IQD',
      }),
    );

    const effective = await asOfficer((tx) => coa.effectiveDimensions(tx, salaries.id));
    expect([...effective.dimensions].sort()).toEqual(['branch', 'department']);
    expect(effective.inheritedFrom).toBe(group.code);
    expect(effective.ownRules).toBe(false);
  });

  it('reaches through a group that declares nothing', async () => {
    const top = await approvedGroup('Operating Expenses', expenseRootId, ['branch']);
    const middle = await approvedGroup('Staff Costs', top.id);
    const leaf = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Overtime',
        parentId: middle.id,
        currencyRestriction: 'IQD',
      }),
    );

    const effective = await asOfficer((tx) => coa.effectiveDimensions(tx, leaf.id));
    expect(effective.dimensions).toEqual(['branch']);
    expect(effective.inheritedFrom).toBe(top.code);
  });

  it('lets Finance override one account without touching its siblings', async () => {
    const group = await approvedGroup('Operating Expenses', expenseRootId, [
      'branch',
      'department',
    ]);
    const sibling = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Rent',
        parentId: group.id,
        currencyRestriction: 'IQD',
      }),
    );
    const overridden = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Bank Charges',
        parentId: group.id,
        currencyRestriction: 'IQD',
      }),
    );

    await asManager((tx) => coa.setRequiredDimensions(tx, manager, overridden.id, ['project']));

    const one = await asOfficer((tx) => coa.effectiveDimensions(tx, overridden.id));
    const other = await asOfficer((tx) => coa.effectiveDimensions(tx, sibling.id));

    // An override replaces, it does not merge. Merging would make it impossible
    // to *remove* a requirement, and the decision says Finance may override.
    expect(one.dimensions).toEqual(['project']);
    expect(one.ownRules).toBe(true);
    expect([...other.dimensions].sort()).toEqual(['branch', 'department']);
  });

  it('lets an account require nothing against a group that requires something', async () => {
    const group = await approvedGroup('Operating Expenses', expenseRootId, ['branch']);
    const exception = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Rounding',
        parentId: group.id,
        currencyRestriction: 'IQD',
      }),
    );

    await asManager((tx) => coa.setRequiredDimensions(tx, manager, exception.id, []));

    const effective = await asOfficer((tx) => coa.effectiveDimensions(tx, exception.id));
    // An empty declaration is how "not for this account" is said, and it is a
    // different fact from having said nothing at all.
    expect(effective.dimensions).toEqual([]);
    expect(effective.ownRules).toBe(true);
  });

  it('hands an account back to the group’s rules', async () => {
    const group = await approvedGroup('Operating Expenses', expenseRootId, ['branch']);
    const account = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Travel',
        parentId: group.id,
        currencyRestriction: 'IQD',
        requiredDimensions: ['project'],
      }),
    );

    await asManager((tx) => coa.inheritDimensions(tx, manager, account.id));

    const effective = await asOfficer((tx) => coa.effectiveDimensions(tx, account.id));
    expect(effective.dimensions).toEqual(['branch']);
    expect(effective.ownRules).toBe(false);
  });

  it('changes every account below a group by changing the group', async () => {
    const group = await approvedGroup('Operating Expenses', expenseRootId, ['branch']);

    const children = [];
    for (const name of ['Salaries', 'Rent', 'Utilities']) {
      children.push(
        await asOfficer((tx) =>
          coa.createAccount(tx, officer, {
            name,
            parentId: group.id,
            currencyRestriction: 'IQD',
          }),
        ),
      );
    }

    await asManager((tx) =>
      coa.setRequiredDimensions(tx, manager, group.id, ['branch', 'department', 'project']),
    );

    // This is the whole point of the decision: "keeps the Chart of Accounts
    // manageable as hundreds or thousands of accounts are added."
    for (const child of children) {
      const effective = await asOfficer((tx) => coa.effectiveDimensions(tx, child.id));
      expect([...effective.dimensions].sort()).toEqual(['branch', 'department', 'project']);
    }
  });

  it('shows the inherited rules on the tree, not the empty declaration', async () => {
    const group = await approvedGroup('Operating Expenses', expenseRootId, ['branch']);
    const leaf = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Salaries',
        parentId: group.id,
        currencyRestriction: 'IQD',
      }),
    );

    const tree = await asOfficer((tx) => coa.tree(tx, { includeInactive: true }));
    const find = (nodes: AccountTreeNode[], id: string): AccountTreeNode | undefined => {
      for (const node of nodes) {
        if (node.id === id) return node;
        const hit = find(node.children, id);
        if (hit) return hit;
      }
      return undefined;
    };

    expect(find(tree, leaf.id)?.requiredDimensions).toEqual(['branch']);
  });

  it('refuses a rule written straight onto an inheriting account', async () => {
    const account = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Sundries',
        parentId: expenseRootId,
        currencyRestriction: 'IQD',
      }),
    );

    // A row on an account that inherits would sit there invisibly while the
    // account went on taking the group's rules.
    await expect(
      ownerPool.query(
        `insert into account_required_dimension (account_id, dimension) values ($1, 'branch')`,
        [account.id],
      ),
    ).rejects.toThrow(/inherits its dimension rules/);
  });
});

// ---------------------------------------------------------------------------

describe('D7 · a control account is protected once it is in use', () => {
  async function receivables() {
    const account = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Trade Receivables',
        parentId: assetsRootId,
        currencyRestriction: 'IQD',
        controlAccount: 'customer',
      }),
    );
    await asOfficer((tx) => coa.submitForApproval(tx, officer, account.id));
    await asManager((tx) => coa.approve(tx, manager, account.id));
    return account;
  }

  it('lets the Officer propose the designation and the Manager approve it', async () => {
    const account = await receivables();
    const reloaded = await asOfficer((tx) => coa.loadAccount(tx, account.id));

    // The account carries the designation from the moment it is raised and
    // accepts nothing until the Manager approves it — which is what makes
    // approving the account approve the designation.
    expect(reloaded.controlAccount).toBe('customer');
    expect(reloaded.isActive).toBe(true);
    expect(reloaded.approvalStatus).toBe('approved');
  });

  it('lets the Manager change it while nothing depends on it', async () => {
    const account = await receivables();
    await asManager((tx) => coa.setControlAccount(tx, manager, account.id, 'supplier'));

    const reloaded = await asOfficer((tx) => coa.loadAccount(tx, account.id));
    expect(reloaded.controlAccount).toBe('supplier');
  });

  it('refuses an Officer the change — it is the Manager’s call', async () => {
    const account = await receivables();

    await expect(
      asOfficer((tx) => coa.setControlAccount(tx, officer, account.id, null)),
    ).rejects.toThrow(/Permission denied: 'approve' on 'chart_of_account'/);
  });

  it('refuses to remove the designation while an accounting mapping depends on it', async () => {
    const account = await receivables();
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by)
       values ('sales.invoice', 'receivable', $1, true, $2)`,
      [account.id, manager.principal.userId],
    );

    // No approval makes this safe: the mapping would go on posting to an
    // account §14.3 no longer protects.
    // The helper walks the cause chain: the driver wraps the database message
    // in a 'Failed query' of its own, and the sentence that matters is inside.
    expect(await rejection(asManager((tx) => coa.setControlAccount(tx, manager, account.id, null))))
      .toMatch(/Repoint the mappings first/);
  });

  it('refuses a hand-written change once the account carries postings', async () => {
    const account = await receivables();

    await ownerPool.query(
      `insert into fiscal_year (code, name, starts_on, ends_on, status)
       values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`,
    );
    const { rows: years } = await ownerPool.query(
      `select id from fiscal_year where code = 'FY2026'`,
    );
    await ownerPool.query(
      `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on)
       values ($1,2,'February 2026','2026-02-01','2026-02-28') on conflict do nothing`,
      [years[0].id],
    );
    const { rows: periods } = await ownerPool.query(
      `select id from fiscal_period where period_no = 2`,
    );

    await ownerPool.query(
      `insert into journal_entry
         (entry_no, document_date, posting_date, fiscal_period_id, branch_code, status, created_by)
       values ('JE-CTRL','2026-02-01','2026-02-01',$1,$2,'draft',$3)`,
      [periods[0].id, BAGHDAD, manager.principal.userId],
    );
    const { rows: entry } = await ownerPool.query(
      `select id from journal_entry where entry_no = 'JE-CTRL'`,
    );
    await ownerPool.query(
      `insert into journal_line
         (journal_entry_id, line_no, account_id, currency,
          debit_txn, credit_txn, debit_iqd, credit_iqd, branch_code)
       values ($1, 1, $2, 'IQD', 100, 0, 100, 0, $3)`,
      [entry[0].id, account.id, BAGHDAD],
    );

    await expect(
      ownerPool.query(`update chart_of_account set control_account = null where id = $1`, [
        account.id,
      ]),
    ).rejects.toThrow(/not changed casually/);
  });

  it('refuses to make a group a control account', async () => {
    const group = await asOfficer((tx) =>
      coa.createAccount(tx, officer, {
        name: 'Receivables',
        parentId: assetsRootId,
        isGroup: true,
      }),
    );

    await expect(
      asManager((tx) => coa.setControlAccount(tx, manager, group.id, 'customer')),
    ).rejects.toThrow(/no balance of its own/);
  });
});
