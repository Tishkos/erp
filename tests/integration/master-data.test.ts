/**
 * Phase 03.1, 03.2 and 03.4 — master data, against a real PostgreSQL instance.
 *
 * §27 Release 2 acceptance is "Master-data validation and change controls
 * pass", and the two controls that carry it are §4.4's duplicate search and the
 * §15 approval on bank details.
 *
 * These masters are also what the Phase 02 dimensions were waiting for: Business
 * Line, Business Partner, Warehouse and Project were registered with no source
 * and were therefore unusable. This file proves they now work end to end.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as dimensions from '@/server/services/dimensions';
import * as journal from '@/server/services/journal';
import * as partners from '@/server/services/business-partner';
import * as periods from '@/server/services/periods';
import * as rates from '@/server/services/exchange-rates';
import * as subledger from '@/server/services/subledger';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { DuplicatePartnerError } from '@domain/business-partner';
import { SelfApprovalError } from '@domain/workflow';

const BAGHDAD = 'BGW';
const POSTING_DATE = '2026-08-16';

let officer: ActorContext;
let manager: ActorContext;

async function createUser(roleCode: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [
    id,
    `${id}@example.com`,
    'Test User',
  ]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [
    id,
    roleCode,
  ]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [
    id,
    BAGHDAD,
  ]);
  await ownerPool.query(
    `insert into user_department_scope (user_id, department_code) values ($1,'FIN')`,
    [id],
  );
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) =>
    authz.loadPrincipal(tx, id),
  );
  return { principal, branchCode: BAGHDAD };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(
    `insert into department (code, name, is_finance) values ('FIN','Finance',true)`,
  );
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
});

const partnerInput = (overrides: Partial<partners.CreatePartnerInput> = {}) => ({
  code: 'BP-0001',
  legalName: 'Al-Rafidain Trading Co.',
  isCustomer: true,
  email: 'sales@rafidain.iq',
  phone: '+964 770 123 4567',
  registrationNo: 'REG-9911',
  ...overrides,
});

// ---------------------------------------------------------------------------
describe('03.1 gate · an organisation record is deactivated, never deleted', () => {
  it('refuses to delete a branch', async () => {
    // §1.1 — every posted line carries a branch as a dimension. Removing one
    // leaves a reporting hierarchy that no longer explains the figures beneath
    // it, which is worse than a broken reference because nothing complains.
    expect(await rejection(ownerPool.query(`delete from branch where code = $1`, [BAGHDAD]))).toMatch(
      /cannot be deleted.*Deactivate it instead/s,
    );
  });

  it('refuses to delete a department', async () => {
    await ownerPool.query(
      `insert into department (code, name) values ('OPS','Operations')
       on conflict (code) do nothing`,
    );

    expect(
      await rejection(ownerPool.query(`delete from department where code = 'OPS'`)),
    ).toMatch(/cannot be deleted/);
  });

  it('refuses to delete a cost centre', async () => {
    await ownerPool.query(
      `insert into cost_centre (code, name) values ('CC-DEL','Temporary')
       on conflict (code) do nothing`,
    );

    expect(
      await rejection(ownerPool.query(`delete from cost_centre where code = 'CC-DEL'`)),
    ).toMatch(/cannot be deleted/);
  });

  it('permits deactivating one instead', async () => {
    await ownerPool.query(
      `insert into cost_centre (code, name) values ('CC-OFF','Closed unit')
       on conflict (code) do nothing`,
    );
    await ownerPool.query(`update cost_centre set active = false where code = 'CC-OFF'`);

    const { rows } = await ownerPool.query(
      `select active from cost_centre where code = 'CC-OFF'`,
    );
    expect(rows[0].active).toBe(false);
  });

  it('withholds DELETE on all three from the application role', async () => {
    const { rows } = await ownerPool.query(
      `select table_name from information_schema.role_table_grants
        where grantee = 'erp_app' and privilege_type = 'DELETE'
          and table_name in ('branch','department','cost_centre')`,
    );
    expect(rows).toEqual([]);
  });
});

describe('03.1 · organisation hierarchy (§4.1, §2.1, §2.2)', () => {
  it('seeds the six business lines §2.2 names', async () => {
    const { rows } = await ownerPool.query(`select code from business_line order by code`);
    expect(rows.map((r) => r.code)).toEqual([
      'CONTRACTING',
      'INVESTMENTS',
      'LOGISTICS',
      'MONEY_TRANSFER',
      'PRODUCT_SALES',
      'PROJECTS',
    ]);
  });

  it('has no Legal Department — §2.1 is explicit that there is none', async () => {
    const { rows } = await ownerPool.query(
      `select count(*)::int as n from department where lower(name) like '%legal%'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('allows exactly one legal entity (§2.1)', async () => {
    await ownerPool.query(
      `insert into company (code, legal_name) values ('QS','Quality Solutions')`,
    );

    const message = await rejection(
      ownerPool.query(`insert into company (code, legal_name) values ('QS2','Second Entity')`),
    );
    expect(message).toMatch(/company_singleton/);
  });

  it('supports a department hierarchy and refuses a cycle', async () => {
    await ownerPool.query(
      `insert into department (code, name) values ('OPS','Operations'), ('LOG','Logistics')`,
    );
    await ownerPool.query(`update department set parent_code = 'OPS' where code = 'LOG'`);

    const { rows } = await ownerPool.query(
      `select parent_code from department where code = 'LOG'`,
    );
    expect(rows[0].parent_code).toBe('OPS');

    expect(
      await rejection(
        ownerPool.query(`update department set parent_code = 'LOG' where code = 'OPS'`),
      ),
    ).toMatch(/hierarchy would loop/);

    expect(
      await rejection(
        ownerPool.query(`update department set parent_code = 'FIN' where code = 'FIN'`),
      ),
    ).toMatch(/cannot be its own parent/);
  });

  it('keeps cost centres independent of departments (§2.1)', async () => {
    // A cost centre that is structurally a department cannot be reported
    // separately, which is what §2.1 asks for.
    await ownerPool.query(
      `insert into cost_centre (code, name, branch_code) values ('CC-100','Head Office',$1)`,
      [BAGHDAD],
    );

    const { rows } = await ownerPool.query(
      `select column_name from information_schema.columns
        where table_name = 'cost_centre' and column_name like '%department%'`,
    );
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('03.4 · warehouses (§9.1, §9.2)', () => {
  it('supports all six §9.1 types', async () => {
    for (const [code, type] of [
      ['WH-MAIN', 'main'],
      ['WH-BR', 'branch'],
      ['WH-TR', 'transit'],
      ['WH-QU', 'quarantine'],
      ['WH-DM', 'damaged_goods'],
      ['WH-RT', 'returns'],
    ] as const) {
      await ownerPool.query(
        `insert into warehouse (code, name, branch_code, warehouse_type, is_transit)
         values ($1,$1,$2,$3,$4)`,
        [code, BAGHDAD, type, type === 'transit'],
      );
    }

    const { rows } = await ownerPool.query(
      `select count(distinct warehouse_type)::int as types from warehouse`,
    );
    expect(rows[0].types).toBe(6);
  });

  it('flags transit warehouses, and only transit ones', async () => {
    // §9.1 — transit stock is owned but not available for sale. If the flag and
    // the type could disagree, availability would be a matter of opinion.
    const message = await rejection(
      ownerPool.query(
        `insert into warehouse (code, name, branch_code, warehouse_type, is_transit)
         values ('WH-BAD','Bad',$1,'main',true)`,
        [BAGHDAD],
      ),
    );
    expect(message).toMatch(/warehouse_transit_consistent/);
  });

  it('cannot be configured to allow negative stock (§9.2)', async () => {
    // "Negative inventory is prohibited without exception." A policy that can
    // be switched off in a screen is not a prohibition.
    const message = await rejection(
      ownerPool.query(
        `insert into warehouse (code, name, branch_code, warehouse_type, allow_negative_stock)
         values ('WH-NEG','Negative',$1,'main',true)`,
        [BAGHDAD],
      ),
    );
    expect(message).toMatch(/warehouse_no_negative_stock/);
  });

  it('belongs to exactly one branch', async () => {
    const { rows } = await ownerPool.query(
      `select is_nullable from information_schema.columns
        where table_name = 'warehouse' and column_name = 'branch_code'`,
    );
    expect(rows[0].is_nullable).toBe('NO');
  });

  it('is deactivated, never deleted', async () => {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type)
       values ('WH-1','Main',$1,'main')`,
      [BAGHDAD],
    );

    expect(await rejection(ownerPool.query(`delete from warehouse where code = 'WH-1'`))).toMatch(
      /deactivated, never deleted/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('03.2 · Business Partner (§6, §4.4)', () => {
  it('creates a partner with a role', async () => {
    const created = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput()),
    );
    expect(created.code).toBe('BP-0001');

    const partner = await withScope(scope(officer), (tx) =>
      partners.loadPartner(tx, created.id),
    );
    expect(partner.isCustomer).toBe(true);
    expect(partner.status).toBe('prospect');
  });

  it('carries both roles on one record (§3.1, §6)', async () => {
    // One legal person, one record — otherwise there are two credit positions
    // and two sets of bank details for the same company.
    const created = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput({ isCustomer: true, isSupplier: true })),
    );

    const partner = await withScope(scope(officer), (tx) =>
      partners.loadPartner(tx, created.id),
    );
    expect(partner.isCustomer).toBe(true);
    expect(partner.isSupplier).toBe(true);
  });

  it('refuses a record with no role, at the database as well', async () => {
    const message = await rejection(
      ownerPool.query(
        `insert into business_partner (code, legal_name, is_customer, is_supplier)
         values ('BP-X','No Role',false,false)`,
      ),
    );
    expect(message).toMatch(/business_partner_has_role/);
  });

  it('runs the duplicate search before saving and refuses a match (§4.4)', async () => {
    await withScope(scope(officer), (tx) => partners.createPartner(tx, officer, partnerInput()));

    await expect(
      withScope(scope(officer), (tx) =>
        partners.createPartner(
          tx,
          officer,
          partnerInput({ code: 'BP-0002', legalName: 'al rafidain trading co' }),
        ),
      ),
    ).rejects.toThrow(DuplicatePartnerError);
  });

  it('matches on registration number, email and phone as well as name', async () => {
    await withScope(scope(officer), (tx) => partners.createPartner(tx, officer, partnerInput()));

    const matches = await withScope(scope(officer), (tx) =>
      partners.findDuplicates(tx, {
        legalName: 'Something Else Entirely',
        registrationNo: 'REG-9911',
        phone: '07701234567',
        email: 'SALES@RAFIDAIN.IQ',
      }),
    );

    expect(matches).toHaveLength(1);
    expect([...matches[0]!.matchedOn].sort()).toEqual(['email', 'phone', 'registration number']);
  });

  it('saves once the duplicate is confirmed to be a different party, and audits the override', async () => {
    await withScope(scope(officer), (tx) => partners.createPartner(tx, officer, partnerInput()));

    const created = await withScope(scope(officer), (tx) =>
      partners.createPartner(
        tx,
        officer,
        partnerInput({
          code: 'BP-0002',
          legalName: 'Al-Rafidain Trading Co.',
          confirmedNotDuplicate: true,
        }),
      ),
    );

    const { rows } = await ownerPool.query(
      `select after_value from audit_event where object_id = $1`,
      [created.id],
    );
    expect(rows[0].after_value.duplicatesOverridden).toEqual(['BP-0001']);
  });

  it('records before and after values on a sensitive change (§4.4)', async () => {
    const created = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput({ creditLimitIqd: '1000000.0000' })),
    );

    await withScope(scope(manager), (tx) =>
      partners.updatePartner(
        tx,
        manager,
        created.id,
        { creditLimitIqd: '5000000.0000', status: 'active' },
        'Credit committee approval CC-14',
      ),
    );

    const { rows } = await ownerPool.query(
      `select before_value, after_value, reason from audit_event
        where action = 'business_partner.updated'`,
    );
    expect(rows[0].before_value).toMatchObject({
      creditLimitIqd: '1000000.0000',
      status: 'prospect',
    });
    expect(rows[0].after_value).toMatchObject({
      creditLimitIqd: '5000000.0000',
      status: 'active',
    });
    expect(rows[0].reason).toBe('Credit committee approval CC-14');
  });

  it('refuses an Officer changing a credit limit — that is an approval act', async () => {
    const created = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput()),
    );

    await expect(
      withScope(scope(officer), (tx) =>
        partners.updatePartner(tx, officer, created.id, { creditLimitIqd: '9999.0000' }),
      ),
    ).rejects.toThrow(/Permission denied/);
  });

  it('enforces role-specific mandatory fields once configured', async () => {
    await ownerPool.query(
      `insert into partner_role_required_field (role, field_name) values ('customer','creditLimitIqd')`,
    );

    await expect(
      withScope(scope(officer), (tx) => partners.createPartner(tx, officer, partnerInput())),
    ).rejects.toThrow(/must carry creditLimitIqd/);

    await expect(
      withScope(scope(officer), (tx) =>
        partners.createPartner(tx, officer, partnerInput({ creditLimitIqd: '1000.0000' })),
      ),
    ).resolves.toBeDefined();
  });

  it('is deactivated, never deleted', async () => {
    const created = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput()),
    );

    expect(
      await rejection(ownerPool.query(`delete from business_partner where id = $1`, [created.id])),
    ).toMatch(/deactivated, never deleted/);
  });
});

// ---------------------------------------------------------------------------
describe('03.2 · bank details require independent approval (§4.4, §15)', () => {
  async function partnerWithDraftBank() {
    const partner = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput({ isSupplier: true })),
    );
    const bank = await withScope(scope(officer), (tx) =>
      partners.addBankAccount(tx, officer, partner.id, {
        bankName: 'Al Rafidain Bank',
        accountNumber: '1234567890',
        currency: 'IQD',
      }),
    );
    return { partner, bank };
  }

  it('does not take effect until approved', async () => {
    const { partner, bank } = await partnerWithDraftBank();

    const payableBefore = await withScope(scope(officer), (tx) =>
      partners.payableBankAccount(tx, partner.id),
    );
    expect(payableBefore).toBeNull();

    await withScope(scope(officer), (tx) => partners.submitBankAccount(tx, officer, bank.id));
    await withScope(scope(manager), (tx) => partners.approveBankAccount(tx, manager, bank.id));

    const payableAfter = await withScope(scope(officer), (tx) =>
      partners.payableBankAccount(tx, partner.id),
    );
    expect(payableAfter?.accountNumber).toBe('1234567890');
  });

  it('requires the verification to be independent (§15)', async () => {
    // The person who entered the details cannot be the person who approves
    // them — the seeded route refuses self-approval.
    const partner = await withScope(scope(manager), (tx) =>
      partners.createPartner(tx, manager, partnerInput({ isSupplier: true })),
    );
    const bank = await withScope(scope(manager), (tx) =>
      partners.addBankAccount(tx, manager, partner.id, {
        bankName: 'Al Rafidain Bank',
        accountNumber: '999',
      }),
    );
    await withScope(scope(manager), (tx) => partners.submitBankAccount(tx, manager, bank.id));

    await expect(
      withScope(scope(manager), (tx) => partners.approveBankAccount(tx, manager, bank.id)),
    ).rejects.toThrow(SelfApprovalError);
  });

  it('retires the previous details, keeping them as history', async () => {
    const { partner, bank } = await partnerWithDraftBank();
    await withScope(scope(officer), (tx) => partners.submitBankAccount(tx, officer, bank.id));
    await withScope(scope(manager), (tx) => partners.approveBankAccount(tx, manager, bank.id));

    const second = await withScope(scope(officer), (tx) =>
      partners.addBankAccount(tx, officer, partner.id, {
        bankName: 'Trade Bank of Iraq',
        accountNumber: '5555555555',
      }),
    );
    await withScope(scope(officer), (tx) => partners.submitBankAccount(tx, officer, second.id));
    await withScope(scope(manager), (tx) => partners.approveBankAccount(tx, manager, second.id));

    const payable = await withScope(scope(officer), (tx) =>
      partners.payableBankAccount(tx, partner.id),
    );
    expect(payable?.accountNumber).toBe('5555555555');

    // Both sets are still on the record; only one is payable.
    const { rows } = await ownerPool.query(
      `select account_number, is_active from partner_bank_account order by created_at`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.is_active)).toHaveLength(1);
  });

  it('refuses to edit approved details — a change is a new set (§15)', async () => {
    const { bank } = await partnerWithDraftBank();
    await withScope(scope(officer), (tx) => partners.submitBankAccount(tx, officer, bank.id));
    await withScope(scope(manager), (tx) => partners.approveBankAccount(tx, manager, bank.id));

    expect(
      await rejection(
        ownerPool.query(`update partner_bank_account set account_number = '0000' where id = $1`, [
          bank.id,
        ]),
      ),
    ).toMatch(/Approved bank details cannot be edited/);
  });

  it('runs a duplicate search on the account number (§4.4)', async () => {
    const { bank } = await partnerWithDraftBank();
    void bank;

    const other = await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput({ code: 'BP-0002', legalName: 'Other Co', confirmedNotDuplicate: true })),
    );

    await expect(
      withScope(scope(officer), (tx) =>
        partners.addBankAccount(tx, officer, other.id, {
          bankName: 'Al Rafidain Bank',
          accountNumber: '1234567890',
        }),
      ),
    ).rejects.toThrow(/bank account number/);
  });

  it('cannot be made payable without approval, at the database', async () => {
    const { bank } = await partnerWithDraftBank();

    expect(
      await rejection(
        ownerPool.query(`update partner_bank_account set is_active = true where id = $1`, [
          bank.id,
        ]),
      ),
    ).toMatch(/partner_bank_active_requires_approval/);
  });
});

// ---------------------------------------------------------------------------
describe('the Phase 02 dimensions these masters unlock', () => {
  it('makes Business Line, Business Partner, Warehouse and Project usable', async () => {
    const registry = await withScope(scope(manager), (tx) => dimensions.definitions(tx));
    const available = registry.filter((d) => d.sourceTable !== null).map((d) => d.dimension);

    expect(available.sort()).toEqual([
      'branch',
      'business_line',
      'business_partner',
      'department',
      'project',
      'warehouse',
    ]);

    // Employee is Phase 15 and stays unregistered.
    expect(registry.find((d) => d.dimension === 'employee')!.sourceTable).toBeNull();
  });

  it('validates a business partner code against the new master', async () => {
    const { rows } = await ownerPool.query(
      `select id from chart_of_account where code = 'A000001'`,
    );
    const account = await withScope(scope(manager), (tx) =>
      coa.createAccount(tx, manager, { name: 'Cash', parentId: rows[0].id, currencyRestriction: 'IQD' }),
    );

    await expect(
      withScope(scope(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, account, 'journal_entry', {
          branch: BAGHDAD,
          business_partner: 'BP-NOPE',
        }),
      ),
    ).rejects.toThrow(/'BP-NOPE' is not an active Customer \/ Supplier/);

    await withScope(scope(officer), (tx) => partners.createPartner(tx, officer, partnerInput()));

    await expect(
      withScope(scope(officer), (tx) =>
        dimensions.assertDimensionsValid(tx, account, 'journal_entry', {
          branch: BAGHDAD,
          business_partner: 'BP-0001',
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it('posts to a customer control account and reconciles the subledger', async () => {
    // This is what Phase 02.9 could not prove: the customer subledger, with a
    // real customer, reconciling to its control account.
    const second = await createUser('accounting_manager');

    await withScope(scope(manager), (tx) =>
      periods.createFiscalYear(tx, manager, {
        code: 'FY2026',
        startsOn: '2026-01-01',
        endsOn: '2026-12-31',
      }),
    );
    await withScope(scope(manager), (tx) =>
      rates.publishRate(tx, manager, {
        currency: 'USD',
        iqdPerUnit: '1310.00000000',
        effectiveFrom: '2026-01-01',
      }),
    );
    await ownerPool.query(
      `insert into document_type_dimension (document_type_code, dimension, requirement)
       values ('journal_entry','business_line','optional')
       on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
    );

    const roots = await ownerPool.query(
      `select code, id from chart_of_account where is_system`,
    );
    const assetRoot = roots.rows.find((r) => r.code === 'A000001').id;
    const revenueRoot = roots.rows.find((r) => r.code === 'R000001').id;

    const receivables = await withScope(scope(manager), (tx) =>
      coa.createAccount(tx, manager, {
        name: 'Trade Receivables',
        parentId: assetRoot,
        controlAccount: 'customer',
        currencyRestriction: 'IQD',
      }),
    );
    await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, receivables.id));
    await withScope(scope(second), (tx) => coa.approve(tx, second, receivables.id));

    const revenue = await withScope(scope(manager), (tx) =>
      coa.createAccount(tx, manager, { name: 'Trading Revenue', parentId: revenueRoot, currencyRestriction: 'IQD' }),
    );
    await withScope(scope(manager), (tx) => coa.submitForApproval(tx, manager, revenue.id));
    await withScope(scope(second), (tx) => coa.approve(tx, second, revenue.id));

    await withScope(scope(officer), (tx) =>
      partners.createPartner(tx, officer, partnerInput({ status: 'active' })),
    );

    const entry = await withScope(scope(manager), (tx) =>
      journal.createDraft(tx, manager, {
        branchCode: BAGHDAD,
        documentDate: POSTING_DATE,
        postingDate: POSTING_DATE,
        description: 'Sale to BP-0001',
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, {
        accountId: receivables.id,
        debit: '5000.0000',
        dimensions: { business_partner: 'BP-0001' },
      }),
    );
    await withScope(scope(manager), (tx) =>
      journal.addLine(tx, manager, entry.id, { accountId: revenue.id, credit: '5000.0000' }),
    );
    await withScope(scope(manager), (tx) => journal.submit(tx, manager, entry.id));

    const statement = await withScope(scope(manager), (tx) =>
      subledger.statementFor(tx, 'customer', 'BP-0001'),
    );
    expect(statement).toHaveLength(1);
    expect(statement[0]!.debitIqd).toBe('5000.0000');

    const report = await withScope(scope(manager), (tx) => subledger.reconciliation(tx));
    const customer = report.find((r) => r.subledgerType === 'customer')!;
    expect(customer.subledgerBalance).toBe('5000.0000');
    expect(Number(customer.difference)).toBe(0);
  });
});
