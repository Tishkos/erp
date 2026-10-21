/**
 * Item category accounts (0423, 2026-10-21, by direction: "the system asks me
 * to select a COGS account for the item … assign the appropriate COGS account
 * to each item, or configure a default account for the item group, so
 * invoices can be posted").
 *
 * A default is never a second answer: setting it fills the stock items that
 * name no account, a new item takes it as it is made, and the posting keeps
 * reading the item alone (the end-to-end sale is in ops05 › "posts once its
 * category default fills …").
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as items from '@/server/services/items';
import { PermissionDeniedError } from '@/server/domain/permissions';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';

let manager: ActorContext;
let approver: ActorContext;
let officer: ActorContext;
let inventoryA: string;
let inventoryB: string;
let cogsA: string;
let cogsB: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, 'Test User']);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function approvedAccount(rootCode: string, name: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [rootCode]);
  const account = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { name, parentId: rows[0].id, currencyRestriction: 'IQD' }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, account.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, account.id));
  return account.id;
}

const create = (input: Partial<items.ItemInput> = {}) =>
  withScope(scope(manager), (tx) =>
    items.create(tx, manager, { name: 'Solar Panel 550W', isStock: true, baseUomCode: 'EA', tracking: 'batch', ...input } as items.ItemInput),
  );

const accountsOf = async (code: string) => {
  const { rows } = await ownerPool.query(`select inventory_account_id, cogs_account_id from item where code = $1`, [code]);
  return { inventory: rows[0].inventory_account_id as string | null, cogs: rows[0].cogs_account_id as string | null };
};

const setDefault = (category: string | null, inventoryAccountId: string | null, cogsAccountId: string | null, as = manager) =>
  withScope(scope(as), (tx) => items.setCategoryAccounts(tx, as, { category, inventoryAccountId, cogsAccountId }));

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createUser('accounting_manager');
  approver = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');
  inventoryA = await approvedAccount('A000001', 'Inventory Panels');
  inventoryB = await approvedAccount('A000001', 'Inventory General');
  cogsA = await approvedAccount('X000001', 'COGS Panels');
  cogsB = await approvedAccount('X000001', 'COGS General');
});

describe('0423 · item category accounts', () => {
  it('fills the items of the category that name no account, and never replaces one an item names', async () => {
    const bare = await create({ category: 'Panels' });
    const half = await create({ category: 'Panels', cogsAccountId: cogsB });
    const other = await create({ category: 'Inverters' });

    const { filled } = await setDefault('Panels', inventoryA, cogsA);
    expect(filled).toBe(2);
    expect(await accountsOf(bare.code)).toEqual({ inventory: inventoryA, cogs: cogsA });
    expect(await accountsOf(half.code)).toEqual({ inventory: inventoryA, cogs: cogsB });
    expect(await accountsOf(other.code)).toEqual({ inventory: null, cogs: null });

    const { rows } = await ownerPool.query(
      `select object_id from audit_event where action = 'item.stock_accounts_defaulted' order by object_id`,
    );
    expect(rows.map((row) => row.object_id)).toEqual([bare.code, half.code].sort());
  });

  it('the company default answers for every category without its own, account by account', async () => {
    await setDefault('Panels', null, cogsA);
    const panel = await create({ category: 'Panels' });
    const loose = await create();

    const { filled } = await setDefault(null, inventoryB, cogsB);
    expect(filled).toBe(2);
    // The category's own COGS wins; its missing inventory account is the company's.
    expect(await accountsOf(panel.code)).toEqual({ inventory: inventoryB, cogs: cogsA });
    expect(await accountsOf(loose.code)).toEqual({ inventory: inventoryB, cogs: cogsB });
  });

  it('a new item takes the defaults the form left empty; an edit that changes the category takes the new one', async () => {
    await setDefault('Panels', inventoryA, cogsA);
    await setDefault('Inverters', inventoryB, cogsB);
    const made = await create({ category: 'Panels' });
    expect(await accountsOf(made.code)).toEqual({ inventory: inventoryA, cogs: cogsA });

    const service = await create({ category: 'Panels', isStock: false, tracking: null });
    expect(await accountsOf(service.code)).toEqual({ inventory: null, cogs: null });

    const moved = await create({ category: 'Panels', inventoryAccountId: inventoryB });
    expect(await accountsOf(moved.code)).toEqual({ inventory: inventoryB, cogs: cogsA });

    await ownerPool.query(`update item set inventory_account_id = null, cogs_account_id = null where code = $1`, [made.code]);
    await withScope(scope(manager), (tx) =>
      items.update(tx, manager, made.code, { name: 'Solar Panel 550W', category: 'Inverters', isStock: true, baseUomCode: 'EA', tracking: 'batch' }),
    );
    expect(await accountsOf(made.code)).toEqual({ inventory: inventoryB, cogs: cogsB });
  });

  it('changes a default in place, audited, and the table refuses a delete', async () => {
    await setDefault('Panels', inventoryA, cogsA);
    await setDefault('Panels', inventoryB, cogsB);
    const { rows } = await ownerPool.query(`select inventory_account_id, cogs_account_id from item_category_account where category = 'Panels'`);
    expect(rows).toEqual([{ inventory_account_id: inventoryB, cogs_account_id: cogsB }]);
    const { rows: trail } = await ownerPool.query(
      `select before_value from audit_event where action = 'item.category_accounts_set' and object_id = 'Panels' order by id`,
    );
    expect(trail).toHaveLength(2);
    expect(trail[1].before_value).toEqual({ inventoryAccountId: inventoryA, cogsAccountId: cogsA });
    await expect(ownerPool.query(`delete from item_category_account where category = 'Panels'`)).rejects.toThrow();
  });

  it('refuses accounts of the wrong type, an empty default, and a person without configure', async () => {
    await expect(setDefault('Panels', cogsA, null)).rejects.toThrow(/asset account/);
    await expect(setDefault('Panels', null, inventoryA)).rejects.toThrow(/expense account/);
    await expect(setDefault('Panels', null, null)).rejects.toThrow(/inventory account, a COGS account or both/);
    await expect(setDefault('Panels', inventoryA, cogsA, officer)).rejects.toThrow(PermissionDeniedError);
  });

  it('says which items still lack accounts, by category', async () => {
    await create({ category: 'Panels' });
    await create({ category: 'Panels' });
    await create();
    const before = await withScope(scope(manager), (tx) => items.categoryAccounts(tx));
    expect(before.lackingTotal).toBe(3);
    expect(before.lacking).toEqual({ Panels: 2, '': 1 });
    expect(before.unset).toEqual(['Panels']);

    await setDefault('Panels', inventoryA, cogsA);
    const after = await withScope(scope(manager), (tx) => items.categoryAccounts(tx));
    expect(after.lackingTotal).toBe(1);
    expect(after.unset).toEqual([]);
  });
});
