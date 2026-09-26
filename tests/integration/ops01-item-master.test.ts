/**
 * Operations build, block 1 — Items Master Data (2026-09-12).
 *
 * The sponsor's list of fields:
 *
 *   Item Code; Item Full Name; Related Supplier(s); Inventory Account;
 *   Sales Account; COGS Account.
 *
 * Code, name, the supplier link and the sales account were already here. The
 * two this block adds are the pair a stock movement needs and nothing else
 * can answer for: where the stock is held, and what it costs when it leaves.
 *
 * They sit on the item because two items on one invoice can belong to
 * different stock and cost accounts, and the journal has to know which for
 * each line.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as items from '@/server/services/items';
import { AdminValidationError } from '@/server/services/administration';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';

let manager: ActorContext;
let approver: ActorContext;
let inventoryAccountId: string;
let cogsAccountId: string;
let salesAccountId: string;

async function createManager(): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Accounting Manager',
  ]);
  await ownerPool.query(
    `insert into user_role (user_id, role_code) values ($1,'accounting_manager')`,
    [id],
  );
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function approvedAccount(rootCode: string, name: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [
    rootCode,
  ]);
  const account = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { name, parentId: rows[0].id, currencyRestriction: 'IQD' }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, account.id));
  await withScope(scope(approver), (tx) => coa.approve(tx, approver, account.id));
  return account.id;
}

const create = (input: Partial<items.ItemInput> = {}) =>
  withScope(scope(manager), (tx) =>
    items.create(tx, manager, {
      name: 'Solar Panel 550W',
      isStock: true,
      baseUomCode: 'EA',
      tracking: 'batch',
      ...input,
    } as items.ItemInput),
  );

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createManager();
  approver = await createManager();
  inventoryAccountId = await approvedAccount('A000001', 'Inventory');
  cogsAccountId = await approvedAccount('X000001', 'Cost of Goods Sold');
  salesAccountId = await approvedAccount('R000001', 'Product Sales');
});

// ---------------------------------------------------------------------------
describe('ops 1 · an item carries the accounts its movements post to', () => {
  it('holds an inventory account and a COGS account beside the sales account', async () => {
    const made = await create({ inventoryAccountId, cogsAccountId, salesAccountId });

    const row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.inventoryAccountId).toBe(inventoryAccountId);
    expect(row.cogsAccountId).toBe(cogsAccountId);
    expect(row.salesAccountId).toBe(salesAccountId);
    expect(row.inventoryAccount).toBe('A000002 · Inventory');
    expect(row.cogsAccount).toBe('X000002 · Cost of Goods Sold');
  });

  it('leaves both empty when Finance has not decided yet', async () => {
    const made = await create();
    const row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.inventoryAccountId).toBeNull();
    expect(row.cogsAccountId).toBeNull();
    expect(row.inventoryAccount).toBeNull();
  });

  it('refuses an inventory account that is not an asset', async () => {
    await expect(create({ inventoryAccountId: cogsAccountId })).rejects.toThrow(
      AdminValidationError,
    );
    await expect(create({ inventoryAccountId: cogsAccountId })).rejects.toThrow(/asset account/);
  });

  it('refuses a COGS account that is not an expense', async () => {
    await expect(create({ cogsAccountId: salesAccountId })).rejects.toThrow(/expense account/);
  });

  it('refuses a header account for either', async () => {
    const { rows } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
    await expect(create({ inventoryAccountId: rows[0].id })).rejects.toThrow(
      /header, not a posting account/,
    );
  });

  it('changes them without touching anything else on the item', async () => {
    const made = await create({ inventoryAccountId, cogsAccountId });
    const second = await approvedAccount('A000001', 'Inventory — Bonded');

    await withScope(scope(manager), (tx) =>
      items.update(tx, manager, made.code, {
        name: 'Solar Panel 550W',
        isStock: true,
        baseUomCode: 'EA',
        tracking: 'batch',
        inventoryAccountId: second,
        cogsAccountId,
      } as items.ItemInput),
    );

    const row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.inventoryAccountId).toBe(second);
    expect(row.cogsAccountId).toBe(cogsAccountId);
    expect(row.name).toBe('Solar Panel 550W');
  });
});

// ---------------------------------------------------------------------------
describe('ops 1 · the same item can belong to more than one supplier', () => {
  async function supplier(code: string, name: string): Promise<string> {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_supplier, status)
       values ($1, $2, true, 'active') returning id`,
      [code, name],
    );
    return rows[0].id;
  }

  it('links two suppliers to one item, and lists both', async () => {
    const made = await create({ inventoryAccountId, cogsAccountId });
    const first = await supplier('SUP-A', 'Jinko Solar');
    const second = await supplier('SUP-B', 'Longi Green');

    for (const id of [first, second]) {
      await ownerPool.query(
        `insert into item_supplier (item_id, supplier_id) values ($1, $2)`,
        [made.id, id],
      );
    }

    const row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.suppliers.map((s) => s.supplierName).sort()).toEqual(['Jinko Solar', 'Longi Green']);
    expect(row.suppliers.map((s) => s.supplierCode).sort()).toEqual(['SUP-A', 'SUP-B']);
  });

  it('keeps one supplier from being linked to the same item twice', async () => {
    const made = await create();
    const only = await supplier('SUP-C', 'Trina Solar');
    await ownerPool.query(`insert into item_supplier (item_id, supplier_id) values ($1,$2)`, [
      made.id,
      only,
    ]);

    await expect(
      ownerPool.query(`insert into item_supplier (item_id, supplier_id) values ($1,$2)`, [
        made.id,
        only,
      ]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('ops 1 · invoice price defaults are maintained on the item', () => {
  async function supplier(code: string, name: string): Promise<string> {
    const { rows } = await ownerPool.query(
      `insert into business_partner (code, legal_name, is_supplier, status, active)
       values ($1, $2, true, 'active', true) returning id`,
      [code, name],
    );
    return rows[0].id;
  }

  it('persists selling and per-supplier buying prices, including zero and blank', async () => {
    const made = await create({ inventoryAccountId, cogsAccountId });
    const first = await supplier('SUP-80', 'Jinko Solar');
    const second = await supplier('SUP-90', 'Longi Green');

    await withScope(scope(manager), (tx) =>
      items.linkSupplier(tx, manager, made.code, { supplierId: first, makeDefault: true }),
    );
    await withScope(scope(manager), (tx) =>
      items.linkSupplier(tx, manager, made.code, { supplierId: second, makeDefault: false }),
    );
    await withScope(scope(manager), (tx) =>
      items.setSellingPrice(tx, manager, made.code, '150'),
    );
    await withScope(scope(manager), (tx) =>
      items.setSupplierPrice(tx, manager, made.code, first, '80'),
    );
    await withScope(scope(manager), (tx) =>
      items.setSupplierPrice(tx, manager, made.code, second, '90'),
    );

    let row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.sellingPriceIqd).toBe('150.0000');
    expect(row.suppliers.find((link) => link.supplierId === first)?.purchasePriceIqd).toBe(
      '80.0000',
    );
    expect(row.suppliers.find((link) => link.supplierId === second)?.purchasePriceIqd).toBe(
      '90.0000',
    );

    await withScope(scope(manager), (tx) =>
      items.setSupplierPrice(tx, manager, made.code, first, '0'),
    );
    await withScope(scope(manager), (tx) =>
      items.setSupplierPrice(tx, manager, made.code, second, ''),
    );
    row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.suppliers.find((link) => link.supplierId === first)?.purchasePriceIqd).toBe(
      '0.0000',
    );
    expect(row.suppliers.find((link) => link.supplierId === second)?.purchasePriceIqd).toBeNull();
  });

  it('rejects a negative price and keeps price changes behind configure', async () => {
    const made = await create();
    const linked = await supplier('SUP-NEG', 'Negative Supplier');
    await withScope(scope(manager), (tx) =>
      items.linkSupplier(tx, manager, made.code, { supplierId: linked, makeDefault: true }),
    );

    await expect(
      withScope(scope(manager), (tx) => items.setSellingPrice(tx, manager, made.code, '-1')),
    ).rejects.toThrow(/must not be negative/);
    await expect(
      withScope(scope(manager), (tx) =>
        items.setSupplierPrice(tx, manager, made.code, linked, '-1'),
      ),
    ).rejects.toThrow(/must not be negative/);

    const denied: ActorContext = {
      ...manager,
      principal: {
        ...manager.principal,
        grants: manager.principal.grants.filter(
          (grant) => !(grant.object === items.PERMISSION_OBJECT && grant.verb === 'configure'),
        ),
      },
    };
    await expect(
      withScope(scope(denied), (tx) => items.setSellingPrice(tx, denied, made.code, '10')),
    ).rejects.toThrow();
    await expect(
      withScope(scope(denied), (tx) =>
        items.setSupplierPrice(tx, denied, made.code, linked, '10'),
      ),
    ).rejects.toThrow();
  });

  it('keeps a supplier price when the default changes and batches invoice choices', async () => {
    const made = await create({ inventoryAccountId, cogsAccountId });
    const first = await supplier('SUP-FIRST', 'First Supplier');
    const second = await supplier('SUP-SECOND', 'Second Supplier');
    await withScope(scope(manager), (tx) =>
      items.linkSupplier(tx, manager, made.code, { supplierId: first, makeDefault: true }),
    );
    await withScope(scope(manager), (tx) =>
      items.setSupplierPrice(tx, manager, made.code, first, '80'),
    );
    await withScope(scope(manager), (tx) =>
      items.linkSupplier(tx, manager, made.code, { supplierId: second, makeDefault: true }),
    );
    await withScope(scope(manager), (tx) =>
      items.linkSupplier(tx, manager, made.code, { supplierId: first, makeDefault: true }),
    );
    await withScope(scope(manager), (tx) =>
      items.setSellingPrice(tx, manager, made.code, '150'),
    );

    const row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.suppliers.find((link) => link.supplierId === first)?.purchasePriceIqd).toBe(
      '80.0000',
    );

    const purchase = await withScope(scope(manager), (tx) =>
      items.invoiceChoices(tx, 'purchase'),
    );
    const purchaseChoice = purchase.find((choice) => choice.code === made.code)!;
    expect(purchaseChoice.defaultUnitPriceIqd).toBeNull();
    expect(purchaseChoice.suppliers.find((link) => link.id === first)?.purchasePriceIqd).toBe(
      '80.0000',
    );

    const sale = await withScope(scope(manager), (tx) => items.invoiceChoices(tx, 'sale'));
    const saleChoice = sale.find((choice) => choice.code === made.code)!;
    expect(saleChoice.defaultUnitPriceIqd).toBe('150.0000');
    expect('purchasePriceIqd' in (saleChoice.suppliers[0] ?? {})).toBe(false);
  });
});

/**
 * The Item Code is the system's to give — by direction, 2026-09-26.
 *
 * *"All Item Codes must be automatically generated by the system. There should
 * be no manual input field or manual editing for the Item Code, because we
 * need to completely avoid duplicate codes, incorrect entries, and human
 * errors."*
 *
 * What it replaced was a slug of the name: two people entering the same panel
 * on the same day produced SOLAR and SOLAR_2, which is two codes for one
 * thing — the duplicate §3.1 exists to prevent. So the assertions here are
 * about the shape of the code and about two items of the same name, because
 * that is the case that used to go wrong.
 */
describe('ops 1 · the item code is minted, never typed', () => {
  it('gives a new item a code from the sequence', async () => {
    const made = await create();
    expect(made.code).toMatch(/^ITM-\d{6}$/);

    const row = await withScope(scope(manager), (tx) => items.detail(tx, made.code));
    expect(row.code).toBe(made.code);
  });

  it('gives two items of the same name two codes, in order', async () => {
    const first = await create({ name: 'Solar Panel 550W' });
    const second = await create({ name: 'Solar Panel 550W' });

    expect(first.code).not.toBe(second.code);
    // Consecutive, so the counter is the sequence's and not a retry loop's.
    const serial = (code: string) => Number(code.slice(4));
    expect(serial(second.code)).toBe(serial(first.code) + 1);
  });

  it('takes no code from the caller, whatever it is asked to', async () => {
    // The signature has no `code`, so this is what a request that had been
    // altered would reach the service as. It must be ignored, not honoured.
    const made = await withScope(scope(manager), (tx) =>
      items.create(tx, manager, {
        name: 'Hand Coded',
        isStock: true,
        baseUomCode: 'EA',
        tracking: 'batch',
        code: 'TYPED-BY-HAND',
      } as unknown as items.ItemInput),
    );
    expect(made.code).toMatch(/^ITM-\d{6}$/);
    expect(made.code).not.toBe('TYPED-BY-HAND');
  });
});
