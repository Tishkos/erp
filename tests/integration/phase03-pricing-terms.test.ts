/**
 * Phase 03.6, 03.7 and the 03.1 branch-defaults gate, against a real
 * PostgreSQL instance.
 *
 * §4.4: "Effective dates are used for exchange rates, prices, tax rates and
 * approval roles." The rule these masters share is that a value is resolved by
 * the **document's** date, never by today's — so a price list updated in June
 * cannot change what an invoice raised in March was priced at.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { priceOn, taxRateOn, type PriceEntry } from '@domain/payment-terms';

const BAGHDAD = 'BGW';

let manager: ActorContext;
let secondManager: ActorContext;
let itemId: string;

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

async function approvedAccount(name: string): Promise<string> {
  const { rows } = await ownerPool.query(
    `select id from chart_of_account where code = 'A000001'`,
  );
  const account = await withScope(scope(manager), (tx) =>
    coa.createAccount(tx, manager, { name, parentId: rows[0].id, currencyRestriction: 'IQD' }),
  );
  await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, account.id));
  await withScope(scope(secondManager), (tx) => coa.approve(tx, secondManager, account.id));
  return account.id;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createManager();
  secondManager = await createManager();

  const client = await ownerPool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      `insert into item (code, name, base_uom_code, tracking) values ('ITEM-1','Widget','EA','batch')
       returning id`,
    );
    itemId = rows[0].id;
    await client.query(
      `insert into item_uom (item_id, uom_code, conversion_numerator) values ($1,'EA',1), ($1,'BOX',12)`,
      [itemId],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
describe('03.6 · price lists (§7.3, §4.4)', () => {
  async function seedPriceList() {
    await ownerPool.query(`insert into price_list (code, name) values ('RETAIL','Retail')`);
    await ownerPool.query(
      `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
       values ('RETAIL',$1,'EA','1000.0000','2026-01-01'),
              ('RETAIL',$1,'EA','1200.0000','2026-06-01'),
              ('RETAIL',$1,'BOX','11000.0000','2026-01-01')`,
      [itemId],
    );
  }

  it('resolves the price by the document date', async () => {
    await seedPriceList();

    const { rows } = await ownerPool.query(
      `select item_id as "itemId", uom_code as "uomCode", unit_price as "unitPrice",
              effective_from as "effectiveFrom"
         from price_list_item where price_list_code = 'RETAIL'`,
    );
    const prices = rows as PriceEntry[];

    expect(priceOn(prices, itemId, 'EA', '2026-03-15').unitPrice).toBe('1000.0000');
    expect(priceOn(prices, itemId, 'EA', '2026-08-16').unitPrice).toBe('1200.0000');
    expect(priceOn(prices, itemId, 'BOX', '2026-08-16').unitPrice).toBe('11000.0000');
  });

  it('refuses two prices starting the same day', async () => {
    // Otherwise "the price on this date" is a matter of which row was read first.
    await seedPriceList();

    const message = await rejection(
      ownerPool.query(
        `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
         values ('RETAIL',$1,'EA','1500.0000','2026-06-01')`,
        [itemId],
      ),
    );
    expect(message).toMatch(/price_list_item_effective_uniq/);
  });

  it('refuses a price in a unit the item is not sold in', async () => {
    await ownerPool.query(`insert into price_list (code, name) values ('RETAIL','Retail')`);

    const message = await rejection(
      ownerPool.query(
        `insert into price_list_item (price_list_code, item_id, uom_code, unit_price, effective_from)
         values ('RETAIL',$1,'KG','500.0000','2026-01-01')`,
        [itemId],
      ),
    );
    expect(message).toMatch(/not sold in KG/);
  });

  it('links a partner to exactly one price list (§7.3)', async () => {
    await ownerPool.query(`insert into price_list (code, name) values ('RETAIL','Retail')`);
    await ownerPool.query(`insert into price_list (code, name) values ('TRADE','Trade')`);
    await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer, price_list_code)
       values ('BP-1','Customer One',true,'RETAIL')`,
    );

    const { rows } = await ownerPool.query(
      `select price_list_code from business_partner where code = 'BP-1'`,
    );
    expect(rows[0].price_list_code).toBe('RETAIL');

    // One column, so there is no way to record a second.
    const columns = await ownerPool.query(
      `select count(*)::int as n from information_schema.columns
        where table_name = 'business_partner' and column_name like '%price_list%'`,
    );
    expect(columns.rows[0].n).toBe(1);
  });

  it('is deactivated, never deleted', async () => {
    await ownerPool.query(`insert into price_list (code, name) values ('RETAIL','Retail')`);
    expect(
      await rejection(ownerPool.query(`delete from price_list where code = 'RETAIL'`)),
    ).toMatch(/deactivated, never deleted/);
  });
});

// ---------------------------------------------------------------------------
describe('03.7 · tax codes (§4.3)', () => {
  it('resolves an effective-dated rate by the document date', async () => {
    const accountId = await approvedAccount('Input VAT Recoverable');
    await ownerPool.query(
      `insert into tax_code (code, name, is_recoverable, account_id) values ('VAT','VAT 15%',true,$1)`,
      [accountId],
    );
    await ownerPool.query(
      `insert into tax_rate (tax_code, rate_percent, effective_from)
       values ('VAT','15.000000','2026-01-01'), ('VAT','18.000000','2026-07-01')`,
    );

    const { rows } = await ownerPool.query(
      `select tax_code as "taxCode", rate_percent as "ratePercent",
              effective_from as "effectiveFrom" from tax_rate`,
    );

    expect(taxRateOn(rows as never, 'VAT', '2026-05-01').ratePercent).toBe('15.000000');
    expect(taxRateOn(rows as never, 'VAT', '2026-08-16').ratePercent).toBe('18.000000');
  });

  it('refuses recoverable and non-recoverable codes sharing an account', async () => {
    // Recoverable tax is an asset that is reclaimed; non-recoverable tax is a
    // cost. One account serving both makes the reclaimable balance unknowable.
    const accountId = await approvedAccount('Input VAT');
    await ownerPool.query(
      `insert into tax_code (code, name, is_recoverable, account_id) values ('VAT-R','Recoverable',true,$1)`,
      [accountId],
    );

    const message = await rejection(
      ownerPool.query(
        `insert into tax_code (code, name, is_recoverable, account_id)
         values ('VAT-N','Non-recoverable',false,$1)`,
        [accountId],
      ),
    );
    expect(message).toMatch(/one account cannot be both/);
  });

  it('permits two codes of the same kind sharing an account', async () => {
    const accountId = await approvedAccount('Input VAT');
    await ownerPool.query(
      `insert into tax_code (code, name, is_recoverable, account_id)
       values ('VAT-R1','Recoverable 15',true,$1)`,
      [accountId],
    );

    await expect(
      ownerPool.query(
        `insert into tax_code (code, name, is_recoverable, account_id)
         values ('VAT-R2','Recoverable 18',true,$1)`,
        [accountId],
      ),
    ).resolves.toBeDefined();
  });

  it('refuses two rates for the same code starting the same day', async () => {
    const accountId = await approvedAccount('Input VAT');
    await ownerPool.query(
      `insert into tax_code (code, name, is_recoverable, account_id) values ('VAT','VAT',true,$1)`,
      [accountId],
    );
    await ownerPool.query(
      `insert into tax_rate (tax_code, rate_percent, effective_from) values ('VAT','15','2026-01-01')`,
    );

    expect(
      await rejection(
        ownerPool.query(
          `insert into tax_rate (tax_code, rate_percent, effective_from) values ('VAT','18','2026-01-01')`,
        ),
      ),
    ).toMatch(/tax_rate_effective_uniq/);
  });
});

// ---------------------------------------------------------------------------
describe('03.7 · payment terms (§16)', () => {
  it('accepts a single-payment term', async () => {
    await expect(
      ownerPool.query(
        `insert into payment_terms (code, name, due_days) values ('NET30','Net 30',30)`,
      ),
    ).resolves.toBeDefined();
  });

  it('accepts instalments totalling 100 per cent', async () => {
    const client = await ownerPool.connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into payment_terms (code, name) values ('THIRDS','Three instalments')`,
      );
      await client.query(
        `insert into payment_term_instalment (terms_code, sequence, days_after, percentage)
         values ('THIRDS',1,0,33.33), ('THIRDS',2,30,33.33), ('THIRDS',3,60,33.34)`,
      );
      await client.query('commit');
    } finally {
      client.release();
    }

    const { rows } = await ownerPool.query(
      `select sum(percentage)::text as total from payment_term_instalment where terms_code = 'THIRDS'`,
    );
    expect(Number(rows[0].total)).toBe(100);
  });

  it('refuses instalments that do not total the whole invoice', async () => {
    // Deferred: the rows arrive one at a time and only the finished set can be
    // judged. Without it, part of an invoice would never fall due.
    const message = await rejection(
      (async () => {
        const client = await ownerPool.connect();
        try {
          await client.query('begin');
          await client.query(`insert into payment_terms (code, name) values ('HALF','Half')`);
          await client.query(
            `insert into payment_term_instalment (terms_code, sequence, days_after, percentage)
             values ('HALF',1,0,50)`,
          );
          await client.query('commit');
        } finally {
          client.release();
        }
      })(),
    );
    expect(message).toMatch(/totalling 50.00%, not 100%|not 100%/);
  });

  it('refuses a percentage outside 0–100', async () => {
    await ownerPool.query(`insert into payment_terms (code, name) values ('BAD','Bad')`);
    expect(
      await rejection(
        ownerPool.query(
          `insert into payment_term_instalment (terms_code, sequence, days_after, percentage)
           values ('BAD',1,0,150)`,
        ),
      ),
    ).toMatch(/payment_term_instalment_percentage_range/);
  });

  it('refuses a payment method with a fee and nowhere to post it', async () => {
    expect(
      await rejection(
        ownerPool.query(
          `insert into payment_method (code, name, kind, fee_percent) values ('CARD','Card','bank',2.5)`,
        ),
      ),
    ).toMatch(/payment_method_fee_needs_account/);
  });

  it('accepts a payment method with no fee', async () => {
    await expect(
      ownerPool.query(
        `insert into payment_method (code, name, kind) values ('TRANSFER','Bank transfer','transfer')`,
      ),
    ).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
describe('03.1 · a branch cannot exist without its default warehouse (§4.1)', () => {
  it('refuses a branch with no default warehouse', async () => {
    // The rule is DEFERRED, so this fails at COMMIT rather than at INSERT —
    // which is exactly what lets the legitimate case work.
    const message = await rejection(
      ownerPool.query(`insert into branch (code, name) values ('BSR','Basra')`),
    );
    expect(message).toMatch(/has no default warehouse/);
  });

  it('accepts a branch created together with its warehouse and no cash account assignment', async () => {
    // A warehouse belongs to a branch and a branch has a default warehouse, so
    // neither can exist first. They are created in one transaction and judged
    // at COMMIT.
    await expect(seedBranch('BSR', 'Basra')).resolves.toBeUndefined();

    const { rows } = await ownerPool.query(
      `select default_warehouse_code from branch where code = 'BSR'`,
    );
    expect(rows[0].default_warehouse_code).toBe('WH-BSR');
  });

  it('refuses to clear a branch’s defaults afterwards', async () => {
    expect(
      await rejection(
        ownerPool.query(`update branch set default_warehouse_code = null where code = $1`, [
          BAGHDAD,
        ]),
      ),
    ).toMatch(/has no default warehouse/);
  });
});
