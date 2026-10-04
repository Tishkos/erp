/**
 * Global search (platform phase, Agent 5) — against a real database, as the
 * people who would use it.
 *
 *   • results are grouped by record type, masters before documents
 *   • a document number is found whole, by its serial, by its short prefix and
 *     in Arabic digits; a type registered tomorrow is found the same way
 *     (TASK-100 below is a table this file creates and registers)
 *   • a person finds what their grants and their branch let them see, and
 *     nothing else — not by number, not by name, not by a file's name
 *   • money appears only where the asker may see money for that object;
 *     an employee's pay never appears
 *   • the screens the search offers are the screens the shell shows
 *   • the search writes nothing
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as globalSearch from '@/server/services/global-search';
import { registerAllRecords } from '@/server/records';
import { registerSearchType, unregisterSearchType, searchTypes } from '@/server/search/registry';
import { BUILT_IN } from '@/server/search/entities';
import { foldText } from '@/server/domain/search';
import { visibleMenu } from '@/server/domain/menu';
import { routeFor, screenRoutes } from '@/server/domain/screens';
import { visibleRoute } from '@/server/delivered';
import type { Principal } from '@/server/domain/permissions';
import type { SearchCustomType, SearchTableType } from '@/server/search/types';

const BGW = 'BGW';
const EBL = 'EBL';

interface Actor {
  readonly principal: Principal;
  readonly scope: { userId: string; branchCode: string; isSuperUser: boolean };
}

/** Everything a person who works with purchases, partners and files would be given — and not the price lists. */
const DOCUMENT_OBJECTS = [
  'business_partner',
  'ap_invoice',
  'journal_entry',
  'item',
  'employee',
  'attachment',
  'warehouse',
  'bank_account',
  'chart_of_account',
  'project',
  'payable',
  'bill_of_lading',
  'shipment_container',
  'customs_pd',
];

let admin: Actor;
let officer: Actor;
let pricer: Actor;
let erbil: Actor;
let outsider: Actor;
let invoiceOnly: Actor;
let filesOnly: Actor;

const ids: Record<string, string> = {};

async function makeActor(
  name: string,
  options: { branches: readonly string[]; objects: readonly string[]; superUser?: boolean },
): Promise<Actor> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name, is_super_user) values ($1,$2,$3,$4)`, [
    id,
    `${name}-${id}@example.com`,
    name,
    options.superUser ?? false,
  ]);
  if (options.objects.length > 0) {
    const role = `gs_${name}`;
    await ownerPool.query(`insert into role (code, name) values ($1,$2)`, [role, `Search test ${name}`]);
    for (const object of options.objects) {
      await ownerPool.query(`insert into role_grant (role_code, object, verb) values ($1,$2,'view')`, [role, object]);
    }
    await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  }
  for (const branch of options.branches) {
    await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  }
  const branchCode = options.branches[0] ?? '';
  const isSuperUser = options.superUser ?? false;
  const principal = await withScope({ userId: id, branchCode, isSuperUser }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, scope: { userId: id, branchCode, isSuperUser } };
}

const run = (actor: Actor, query: string, extra: Partial<globalSearch.SearchInput> = {}) =>
  globalSearch.searchAs(actor.scope, actor.principal, { query, ...extra });

const keys = (outcome: globalSearch.SearchOutcome) => outcome.groups.map((group) => group.key);
const numbersOf = (outcome: globalSearch.SearchOutcome, key: string) =>
  outcome.groups.find((group) => group.key === key)?.rows.map((row) => row.number) ?? [];

async function one(query: string, values: unknown[]): Promise<string> {
  const { rows } = await ownerPool.query(query, values);
  return rows[0].id as string;
}

async function allocate(key: string, scopeKey: string, serial: number, documentNo: string): Promise<void> {
  await ownerPool.query(
    `insert into doc_number_allocation (sequence_key, scope_key, serial, document_no) values ($1,$2,$3,$4)`,
    [key, scopeKey, serial, documentNo],
  );
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BGW, 'Baghdad');
  await seedBranch(EBL, 'Erbil');
  await ownerPool.query(`insert into department (code, name) values ('FIN','Finance') on conflict do nothing`);

  admin = await makeActor('admin', { branches: [], objects: [], superUser: true });
  officer = await makeActor('officer', { branches: [BGW], objects: DOCUMENT_OBJECTS });
  pricer = await makeActor('pricer', { branches: [BGW], objects: [...DOCUMENT_OBJECTS, 'price_list'] });
  erbil = await makeActor('erbil', { branches: [EBL], objects: DOCUMENT_OBJECTS });
  outsider = await makeActor('outsider', { branches: [BGW], objects: [] });
  invoiceOnly = await makeActor('invoiceonly', { branches: [BGW], objects: ['ap_invoice'] });
  filesOnly = await makeActor('filesonly', { branches: [BGW], objects: ['attachment'] });
  registerAllRecords();

  const by = admin.principal.userId;

  // --- Partners: company-wide master data -----------------------------------
  ids.customer = await one(
    `insert into business_partner (code, legal_name, trade_name, is_customer) values ('CUS-910001','Zanzibar Retail Group','Zanzibar Retail', true) returning id`,
    [],
  );
  ids.supplier = await one(
    `insert into business_partner (code, legal_name, is_supplier) values ('SUP-910002','Zanzibar Freight Ltd', true) returning id`,
    [],
  );
  ids.quartz = await one(
    `insert into business_partner (code, legal_name, is_supplier) values ('SUP-910003','Quartz Trading Company', true) returning id`,
    [],
  );
  ids.arabic = await one(
    `insert into business_partner (code, legal_name, is_customer) values ('CUS-910004','شركة الفرات للتجارة', true) returning id`,
    [],
  );
  for (let i = 1; i <= 12; i++) {
    await ownerPool.query(
      `insert into business_partner (code, legal_name, is_customer) values ($1,$2,true)`,
      [`CUS-92${String(i).padStart(4, '0')}`, `Pagetest Customer ${String(i).padStart(2, '0')}`],
    );
  }

  // --- AP invoices: branch-scoped documents ---------------------------------
  ids.invoiceBgw = await one(
    `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
     values ('API-BGW-2026-910001','QZ-INV-77',$1,$2,'2026-09-01','2026-10-01', 1250000, $3, true) returning id`,
    [ids.quartz, BGW, by],
  );
  ids.invoiceEbl = await one(
    `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
     values ('API-EBL-2026-910002','QZ-INV-88',$1,$2,'2026-09-02','2026-10-02', 480000, $3, true) returning id`,
    [ids.quartz, EBL, by],
  );
  await allocate('AP_INVOICE', 'BGW:2026', 910001, 'API-BGW-2026-910001');
  await allocate('AP_INVOICE', 'EBL:2026', 910002, 'API-EBL-2026-910002');

  // --- Employee, with pay that must never appear ----------------------------
  ids.employee = await one(
    `insert into employee (employee_no, full_name_en, full_name_ar, branch_code, department_code, hire_date, created_by)
     values ('EMP-BGW-9001','Zanzibar Hassan','زنجبار حسن',$1,'FIN','2025-01-01',$2) returning id`,
    [BGW, by],
  );
  await ownerPool.query(
    `insert into employee_compensation (employee_id, branch_code, effective_from, base_salary_iqd, recorded_by)
     values ($1,$2,'2025-01-01', 4321000, $3)`,
    [ids.employee, BGW, by],
  );

  // --- Items, projects, journals --------------------------------------------
  {
    const client = await ownerPool.connect();
    try {
      // The item and its base unit are one fact: a deferred trigger asks for both at commit.
      await client.query('begin');
      const { rows } = await client.query(
        `insert into item (code, name, base_uom_code, selling_price_iqd, is_stock, tracking) values ('ITM-910001','Zanzibar Widget','EA', 12500, true, 'batch') returning id`,
      );
      await client.query(`insert into item_uom (item_id, uom_code, conversion_numerator, conversion_denominator) values ($1,'EA',1,1)`, [rows[0].id]);
      await client.query('commit');
    } finally {
      client.release();
    }
  }
  await ownerPool.query(`insert into project (code, name, branch_code, contract_value_iqd) values ('PRJ-BGW-2026-910001','Zanzibar Tower',$1, 99000000)`, [BGW]);
  const year = await one(
    `insert into fiscal_year (code, name, starts_on, ends_on) values ('FY2026','Financial Year 2026','2026-01-01','2026-12-31') returning id`,
    [],
  );
  const period = await one(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on) values ($1,9,'September 2026','2026-09-01','2026-09-30') returning id`,
    [year],
  );
  ids.journalBgw = await one(
    `insert into journal_entry (entry_no, document_date, posting_date, fiscal_period_id, branch_code, description, status, created_by)
     values ('JE-2026-910001','2026-09-05','2026-09-05',$1,$2,'Zanzibar accrual','draft',$3) returning id`,
    [period, BGW, by],
  );
  await allocate('JOURNAL_ENTRY', 'BGW:2026', 910001, 'JE-2026-910001');

  // --- Imports and shipping --------------------------------------------------
  ids.payable = await one(
    `insert into payable (payable_no, payable_type_code, supplier_reference, supplier_reference_key, supplier_id, branch_code, currency, document_date, description, stage_code, created_by)
     values ('IMP-BGW-2026-910001','import','PO-ZAN-5','POZAN5',$1,$2,'USD','2026-09-03','Zanzibar steel coils','order_confirmed',$3) returning id`,
    [ids.supplier, BGW, by],
  );
  ids.bl = await one(
    `insert into bill_of_lading (payable_id, branch_code, bl_no, bl_date, vessel, created_by) values ($1,$2,'MAEU-ZAN-9001','2026-09-04','Zanzibar Star',$3) returning id`,
    [ids.payable, BGW, by],
  );
  ids.container = await one(
    `insert into shipment_container (bl_id, payable_id, branch_code, container_no, seal_no, created_by) values ($1,$2,$3,'MSKU9100010','SEAL-ZAN-1',$4) returning id`,
    [ids.bl, ids.payable, BGW, by],
  );
  await ownerPool.query(
    `insert into customs_pd (pd_no, branch_code, registration_date, expiry_date, status_date, created_by) values ('PD-910001',$1,'2026-09-06','2027-03-06','2026-09-06',$2)`,
    [BGW, by],
  );

  // --- Files -----------------------------------------------------------------
  const file = (objectType: string, objectId: string, name: string, branch: string | null) =>
    ownerPool.query(
      `insert into attachment (object_type, object_id, file_name, content_type, size_bytes, sha256, storage_key, uploaded_by, scan_status, scanned_at, branch_code)
       values ($1,$2,$3,'application/pdf',1000,$4,$5,$6,'clean', now(), $7)`,
      [objectType, objectId, name, (randomUUID() + randomUUID()).replace(/-/g, ''), randomUUID(), by, branch],
    );
  await file('ap_invoice', ids.invoiceBgw, 'zanzibar-contract.pdf', BGW);
  await file('ap_invoice', ids.invoiceEbl, 'zanzibar-erbil-contract.pdf', EBL);
});

afterAll(async () => {
  unregisterSearchType('gs_task');
  unregisterSearchType('gs_writer');
  await ownerPool.query('drop table if exists gs_task');
  // The numbering rows of the TASK stand-in are append-only; the reset is what removes them.
  await resetTestData();
});

describe('grouping and ranking', () => {
  it('groups by record type, master records before documents, and no query fails', async () => {
    const outcome = await run(officer, 'zanzibar');
    expect(outcome.failed).toEqual([]);
    const order = keys(outcome);
    for (const key of ['customer', 'supplier', 'employee', 'item', 'project', 'journal_entry', 'payable', 'attachment']) {
      expect(order, key).toContain(key);
    }
    expect(order.indexOf('customer')).toBeLessThan(order.indexOf('supplier'));
    expect(order.indexOf('supplier')).toBeLessThan(order.indexOf('journal_entry'));
    expect(order.indexOf('project')).toBeLessThan(order.indexOf('payable'));
    expect(order.indexOf('payable')).toBeLessThan(order.indexOf('attachment'));
    // One group per type.
    expect(new Set(order).size).toBe(order.length);
  });

  it('puts the record named like the phrase before the documents that merely name its party', async () => {
    const outcome = await run(officer, 'quartz');
    const order = keys(outcome);
    expect(order[0]).toBe('supplier');
    expect(order).toContain('ap_invoice');
    // The invoices come in by their supplier's name — the lowest tier.
    expect(outcome.groups.find((g) => g.key === 'ap_invoice')!.best).toBe(4);
    expect(numbersOf(outcome, 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
  });

  it('ranks the matching whole before the matching part of a name', async () => {
    const outcome = await run(officer, 'Zanzibar Retail Group');
    expect(outcome.groups[0]!.key).toBe('customer');
    expect(outcome.groups[0]!.rows[0]!.tier).toBe(0);
  });

  it('does not search for fewer than two characters', async () => {
    expect((await run(officer, 'z')).groups).toEqual([]);
    expect((await run(officer, '   ')).groups).toEqual([]);
  });

  it('pages inside a group: a limit, then the rest', async () => {
    const first = await run(officer, 'pagetest', { limit: 5 });
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0]!.rows).toHaveLength(5);
    expect(first.groups[0]!.more).toBe(true);
    const last = await run(officer, 'pagetest', { limit: 5, offset: 10 });
    expect(last.groups[0]!.rows).toHaveLength(2);
    expect(last.groups[0]!.more).toBe(false);
    const all = [...first.groups[0]!.rows, ...(await run(officer, 'pagetest', { limit: 5, offset: 5 })).groups[0]!.rows, ...last.groups[0]!.rows];
    expect(new Set(all.map((row) => row.number)).size).toBe(12);
  });
});

describe('exact match first', () => {
  it('finds a document by its whole number, first and alone', async () => {
    const outcome = await run(officer, 'API-BGW-2026-910001');
    expect(keys(outcome)[0]).toBe('ap_invoice');
    expect(outcome.groups[0]!.rows[0]).toMatchObject({ number: 'API-BGW-2026-910001', tier: 0 });
  });

  it('reads the number as it is typed: case, spaces, underscores, Arabic digits', async () => {
    for (const phrase of ['api-bgw-2026-910001', 'api bgw 2026 910001', 'API_BGW_2026_910001', 'API-BGW-٢٠٢٦-٩١٠٠٠١']) {
      const outcome = await run(officer, phrase);
      expect(numbersOf(outcome, 'ap_invoice'), phrase).toEqual(['API-BGW-2026-910001']);
    }
  });

  it('finds a document by prefix and serial — the series is read from the numbering config', async () => {
    const outcome = await run(officer, 'API-910001');
    expect(outcome.groups[0]!.rows[0]).toMatchObject({ number: 'API-BGW-2026-910001', tier: 1 });
    // The year and the branch narrow it.
    expect(numbersOf(await run(officer, 'API-2026-910001'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(officer, 'API-BGW-910001'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(officer, 'API-EBL-910001'), 'ap_invoice')).toEqual([]);
  });

  it('finds it by the start of its prefix, one rank lower', async () => {
    const outcome = await run(officer, 'AP-910001');
    expect(outcome.groups[0]!.rows[0]).toMatchObject({ number: 'API-BGW-2026-910001', tier: 2 });
  });

  it('finds a document by its bare serial, and a master record by its code or its serial', async () => {
    expect(numbersOf(await run(officer, '910001'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(officer, 'CUS-910001'), 'customer')).toEqual(['CUS-910001']);
    // SUP-910002 was written by hand with no allocation: its serial is still met, padded as the series would pad it.
    expect(numbersOf(await run(officer, 'SUP-910002'), 'supplier')).toEqual(['SUP-910002']);
  });

  it('finds a container, a B/L and a PD by their own numbers, in either case', async () => {
    expect(numbersOf(await run(officer, 'MSKU9100010'), 'shipment_container')).toEqual(['MSKU9100010']);
    expect(numbersOf(await run(officer, 'msku9100010'), 'shipment_container')).toEqual(['MSKU9100010']);
    expect(numbersOf(await run(officer, 'maeu-zan-9001'), 'bill_of_lading')).toEqual(['MAEU-ZAN-9001']);
    expect(numbersOf(await run(officer, 'PD-910001'), 'customs_pd')).toEqual(['PD-910001']);
  });

  it('finds a document by the other side\'s reference (the supplier\'s invoice number)', async () => {
    const outcome = await run(officer, 'QZ-INV-77');
    expect(numbersOf(outcome, 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
  });

  it('reads Arabic: marks, alef variants and the ta marbuta do not get in the way', async () => {
    expect(numbersOf(await run(officer, 'الفرات'), 'customer')).toEqual(['CUS-910004']);
    expect(numbersOf(await run(officer, 'شَرِكَة الفُرَات'), 'customer')).toEqual(['CUS-910004']);
    expect(numbersOf(await run(officer, 'شركه الفرات'), 'customer')).toEqual(['CUS-910004']);
    expect(numbersOf(await run(officer, 'زنجبار'), 'employee')).toEqual(['EMP-BGW-9001']);
  });

  it('search_fold in the database and foldText in the code agree', async () => {
    const samples = ['ABC Trading', 'شَرِكَة الفُرَات', 'أحمد إبراهيم آل', 'مدرسة ى', '٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹', 'ـــ', 'Zanzibar'];
    for (const sample of samples) {
      const { rows } = await ownerPool.query('select search_fold($1) as folded', [sample]);
      expect(rows[0].folded, sample).toBe(foldText(sample));
    }
  });
});

describe('a type registered tomorrow is found the same way (TASK-100)', () => {
  it('finds TASK-100 by its number, its serial and its prefix the moment it registers', async () => {
    await ownerPool.query(`create table if not exists gs_task (id uuid primary key default gen_random_uuid(), task_no text not null unique, title text not null, due date)`);
    await ownerPool.query(`grant select on gs_task to erp_app`);
    await ownerPool.query(`insert into doc_sequence (key, prefix, pattern, padding) values ('GS_TASK','TASK','{PREFIX}-{SERIAL}',4) on conflict do nothing`);
    await ownerPool.query(`insert into gs_task (task_no, title, due) values ('TASK-0100','Reconcile the Zanzibar statement','2026-10-15')`);
    await allocate('GS_TASK', 'all', 100, 'TASK-0100');

    // Before it registers, nothing finds it.
    expect(keys(await run(admin, 'TASK-100'))).not.toContain('gs_task');

    const task: SearchTableType = {
      kind: 'table',
      key: 'gs_task',
      priority: 50,
      grant: { object: 'task' },
      table: 'gs_task',
      id: sql`t.id`,
      series: ['GS_TASK'],
      number: sql`t.task_no`,
      text: [sql`t.title`],
      title: sql`t.title`,
      date: sql`t.due`,
      recent: sql`t.due`,
      href: (row) => `/tasks/${row.number}`,
    };
    registerSearchType(task);

    for (const phrase of ['TASK-100', 'task 100', 'TASK-0100', 'TA-100', 'reconcile the zanzibar']) {
      const outcome = await run(admin, phrase);
      expect(numbersOf(outcome, 'gs_task'), phrase).toEqual(['TASK-0100']);
      expect(outcome.failed).toEqual([]);
    }
    expect((await run(admin, 'TASK-100')).groups[0]!.rows[0]).toMatchObject({ tier: 1, href: '/tasks/TASK-0100' });
    // Its grant is the registration's: the officer holds no `task` view.
    expect(keys(await run(officer, 'TASK-100'))).not.toContain('gs_task');
  });
});

describe('permissions and branches: only what the asker may see', () => {
  it('shows a person with no grants nothing, whatever they type', async () => {
    for (const phrase of ['zanzibar', 'API-BGW-2026-910001', 'quartz', '910001', 'CUS-910001']) {
      const outcome = await run(outsider, phrase);
      expect(outcome.groups, phrase).toEqual([]);
      expect(outcome.failed).toEqual([]);
    }
  });

  it('searches only the types the asker holds a view grant for', async () => {
    // Holds `ap_invoice` alone: the invoice by its number, never the customer, the supplier or the employee.
    expect(keys(await run(invoiceOnly, 'zanzibar'))).toEqual([]);
    expect(numbersOf(await run(invoiceOnly, 'API-BGW-2026-910001'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    // The party's name still finds the invoice (it is shown on the invoice), not the party.
    const byParty = await run(invoiceOnly, 'quartz');
    expect(keys(byParty)).toEqual(['ap_invoice']);
  });

  it('keeps a branch\'s documents to the people in that branch', async () => {
    const own = await run(officer, 'API-EBL-2026-910002');
    expect(own.groups).toEqual([]);
    for (const phrase of ['910002', 'QZ-INV-88', 'API-910002']) {
      expect(numbersOf(await run(officer, phrase), 'ap_invoice'), phrase).toEqual([]);
    }
    expect(numbersOf(await run(erbil, 'API-EBL-2026-910002'), 'ap_invoice')).toEqual(['API-EBL-2026-910002']);
    expect(numbersOf(await run(erbil, 'API-BGW-2026-910001'), 'ap_invoice')).toEqual([]);
    // The party search shows each their own.
    expect(numbersOf(await run(officer, 'quartz'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(erbil, 'quartz'), 'ap_invoice')).toEqual(['API-EBL-2026-910002']);
    // A super user sees both.
    expect(numbersOf(await run(admin, 'quartz'), 'ap_invoice').sort()).toEqual(['API-BGW-2026-910001', 'API-EBL-2026-910002']);
  });

  it('keeps a warehouse to its branch (the table has no row policy; the search applies the rule)', async () => {
    expect(numbersOf(await run(officer, 'Baghdad Main'), 'warehouse')).toEqual(['WH-BGW']);
    expect(numbersOf(await run(officer, 'Erbil Main'), 'warehouse')).toEqual([]);
    expect(numbersOf(await run(erbil, 'Erbil Main'), 'warehouse')).toEqual(['WH-EBL']);
  });

  it('does not tell a branch\'s imports from their absence: another branch\'s B/L, container and PD are not found', async () => {
    for (const phrase of ['MSKU9100010', 'MAEU-ZAN-9001', 'PD-910001', 'SEAL-ZAN-1']) {
      const found = await run(erbil, phrase);
      expect(found.groups, phrase).toEqual([]);
    }
  });

  it('never carries a row the asker could not open: every hit has an address', async () => {
    const outcome = await run(admin, 'zanzibar');
    for (const group of outcome.groups) for (const row of group.rows) expect(row.href, `${group.key} ${row.number}`).toBeTruthy();
  });
});

describe('files are found by name only where their record could be opened', () => {
  it('finds a file of a record in the asker\'s branch and opens the record it hangs on', async () => {
    const outcome = await run(officer, 'zanzibar-contract');
    const files = outcome.groups.find((group) => group.key === 'attachment')!;
    expect(files.rows).toHaveLength(1);
    expect(files.rows[0]).toMatchObject({ number: 'zanzibar-contract.pdf', title: 'API-BGW-2026-910001', relatedType: 'ap_invoice' });
    expect(files.rows[0]!.href).toContain('/payables/invoices/API-BGW-2026-910001');
  });

  it('does not find the other branch\'s file, nor a file whose record the asker may not view', async () => {
    expect(keys(await run(officer, 'zanzibar-erbil-contract'))).not.toContain('attachment');
    expect(numbersOf(await run(erbil, 'zanzibar-erbil-contract'), 'attachment')).toEqual(['zanzibar-erbil-contract.pdf']);
    // Holds `attachment` but not `ap_invoice`: the parent check refuses it.
    expect(keys(await run(filesOnly, 'zanzibar-contract'))).toEqual([]);
  });
});

describe('money', () => {
  it('shows a document\'s amount to whoever may view the document', async () => {
    const row = (await run(officer, 'API-BGW-2026-910001')).groups[0]!.rows[0]!;
    expect(row.amount).toEqual({ value: '1250000.0000', currency: 'IQD' });
  });

  it('shows an item\'s price only to whoever may see price lists', async () => {
    const without = (await run(officer, 'Zanzibar Widget')).groups.find((g) => g.key === 'item')!.rows[0]!;
    expect(without.amount).toBeNull();
    const withGrant = (await run(pricer, 'Zanzibar Widget')).groups.find((g) => g.key === 'item')!.rows[0]!;
    expect(withGrant.amount).toEqual({ value: '12500.0000', currency: 'IQD' });
  });

  it('never carries pay: an employee is a number, a name and a status — even for a super user', async () => {
    for (const actor of [officer, admin, pricer]) {
      const outcome = await run(actor, 'Zanzibar Hassan');
      const employee = outcome.groups.find((g) => g.key === 'employee')!.rows[0]!;
      expect(employee.amount).toBeNull();
      expect(JSON.stringify(outcome)).not.toMatch(/4321000|4,321,000/);
    }
  });
});

describe('screens follow the shell', () => {
  it('lists, for a person, exactly the screens the application shell would put in their menu', () => {
    for (const actor of [admin, officer, outsider, invoiceOnly]) {
      const expected = new Set<string>();
      for (const section of visibleMenu(actor.principal)) {
        for (const item of section.items) {
          // app-shell.tsx: the audit trail once, and only screens that are served.
          if (item.key !== 'document_audit' && visibleRoute(routeFor(item, section.key))) expected.add(routeFor(item, section.key));
        }
      }
      expect(new Set(globalSearch.visibleScreens(actor.principal).map((screen) => screen.href))).toEqual(expected);
    }
  });

  it('offers a person with no grants no screen, and the officer none whose object they lack', () => {
    expect(globalSearch.visibleScreens(outsider.principal)).toEqual([]);
    const hrefs = globalSearch.visibleScreens(invoiceOnly.principal).map((screen) => screen.href);
    expect(hrefs).toContain('/payables/invoices');
    expect(hrefs).not.toContain('/sales/customers');
    expect(hrefs).not.toContain('/hr/employees');
  });

  it('is held to the shell by its source: the rule in app-shell.tsx is the one visibleScreens states', () => {
    const shell = readFileSync('src/components/app-shell.tsx', 'utf8');
    expect(shell).toContain("item.key !== 'document_audit' && visibleRoute(routeFor(item, section.key))");
    expect(shell).toContain('visibleMenu(principal)');
    const service = readFileSync('src/server/services/global-search.ts', 'utf8');
    expect(service).toContain("item.key === 'document_audit'");
    expect(service).toContain('visibleRoute(href)');
  });
});

describe('the declarations are consistent with the screens they stand for', () => {
  it('every table type is searched under the object its list screen is gated by', () => {
    for (const type of BUILT_IN) {
      if (!type.route) continue;
      const screen = screenRoutes().get(type.route);
      expect(screen, `${type.key} → ${type.route}`).toBeDefined();
      expect(type.grant.object, type.key).toBe(screen!.item.object);
      expect(type.grant.verb ?? 'view', type.key).toBe(screen!.item.verb ?? 'view');
    }
  });

  it('every type has a priority of its own', () => {
    const priorities = searchTypes().map((type) => type.priority);
    expect(new Set(priorities).size).toBe(priorities.length);
  });
});

describe('the search writes nothing', () => {
  it('runs in a transaction the database holds read-only: a type that tries to write is refused, named, and the rest still answer', async () => {
    const writer: SearchCustomType = {
      kind: 'custom',
      key: 'gs_writer',
      priority: 5,
      grant: { object: 'business_partner' },
      async run(tx) {
        await tx.execute(sql`insert into branch (code, name) values ('ZZZ','Written by a search')`);
        return { rows: [], more: false };
      },
    };
    registerSearchType(writer);
    const outcome = await run(officer, 'zanzibar');
    expect(outcome.failed).toEqual(['gs_writer']);
    expect(keys(outcome)).toContain('customer');
    const { rows } = await ownerPool.query(`select 1 from branch where code = 'ZZZ'`);
    expect(rows).toHaveLength(0);
    unregisterSearchType('gs_writer');
  });

  it('leaves no audit row behind, and no record of what was asked', async () => {
    const before = await ownerPool.query('select count(*)::int as n from audit_event');
    await run(officer, 'zanzibar');
    await run(admin, 'API-BGW-2026-910001');
    const after = await ownerPool.query('select count(*)::int as n from audit_event');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('statuses are never shown as codes', () => {
  it('every status the database can hold has a chip and a translation in both languages', async () => {
    const { chipOf, STATUS_CODES } = await import('@/server/domain/search');
    const { rows } = await ownerPool.query(
      `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname in ('document_status','partner_status','project_status')
       union select code from container_status union select code from pd_status union select code from payable_stage`,
    );
    const known = new Set(STATUS_CODES);
    for (const row of rows as { enumlabel: string }[]) expect(known.has(row.enumlabel), row.enumlabel).toBe(true);
    for (const code of STATUS_CODES) expect(chipOf(code)).toMatch(/^[a-z_]+$/);
  });
});

describe('tables under a row policy: references by comparison, names inside the newest rows', () => {
  it('knows which tables have a row policy (the masters have none, the documents all do)', async () => {
    const { rowSecurityTables, forgetRowSecurityTables } = await import('@/server/search/table-query');
    forgetRowSecurityTables();
    const policed = await globalSearch.searchAs(officer.scope, officer.principal, { query: 'zz' }).then(async () =>
      withScope(officer.scope, (tx) => rowSecurityTables(tx)),
    );
    for (const table of ['ap_invoice', 'journal_entry', 'payable', 'bill_of_lading', 'shipment_container', 'customs_pd', 'attachment', 'employee']) {
      expect(policed.has(table), table).toBe(true);
    }
    for (const table of ['business_partner', 'item', 'warehouse', 'chart_of_account', 'bank_cash_account']) {
      expect(policed.has(table), table).toBe(false);
    }
  });

  it('finds a reference stored in capitals however it is typed: whole, by its beginning, by its middle', async () => {
    expect(numbersOf(await run(officer, 'qz-inv-77'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(officer, 'Qz-Inv'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(officer, 'inv-77'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
    expect(numbersOf(await run(officer, 'QZ INV 77'), 'ap_invoice')).toEqual(['API-BGW-2026-910001']);
  });

  it('applies the branch rule inside the window as it does everywhere else', async () => {
    expect(numbersOf(await run(officer, 'inv-88'), 'ap_invoice')).toEqual([]);
    expect(numbersOf(await run(erbil, 'inv-88'), 'ap_invoice')).toEqual(['API-EBL-2026-910002']);
    expect(numbersOf(await run(erbil, 'inv-77'), 'ap_invoice')).toEqual([]);
    expect(keys(await run(outsider, 'inv-77'))).toEqual([]);
  });

  it('finds a file by its name as stored, in either case, and by a part of it', async () => {
    expect(numbersOf(await run(officer, 'ZANZIBAR-CONTRACT.PDF'), 'attachment')).toEqual(['zanzibar-contract.pdf']);
    expect(numbersOf(await run(officer, 'zanzibar-con'), 'attachment')).toEqual(['zanzibar-contract.pdf']);
    expect(numbersOf(await run(officer, 'contract.pdf'), 'attachment')).toEqual(['zanzibar-contract.pdf']);
  });

  it('reads a reference across the whole table, and a name only inside the newest rows', async () => {
    const { CONTAINS_WINDOW } = await import('@/server/search/table-query');
    // One old invoice, then more newer ones than the window holds.
    const old = await one(
      `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
       values ('API-BGW-2026-910003','OLDREF-NEEDLE-1',$1,$2,'2020-01-01','2020-02-01', 1, $3, true) returning id`,
      [ids.quartz, BGW, admin.principal.userId],
    );
    expect(old).toBeTruthy();
    await ownerPool.query(
      `insert into ap_invoice (invoice_no, supplier_invoice_no, supplier_id, branch_code, invoice_date, due_date, total_iqd, created_by, receives_own_stock)
       select 'API-BGW-2027-' || lpad(g::text, 6, '0'), 'GSFILL-' || g, $1, $2, date '2027-01-01' + (g % 300), date '2028-01-01', 1, $3, true
         from generate_series(1, $4::int) g`,
      [ids.quartz, BGW, admin.principal.userId, CONTAINS_WINDOW + 10],
    );
    await ownerPool.query('analyze ap_invoice');

    // Whole, or by its beginning: found, however old.
    expect(numbersOf(await run(officer, 'OLDREF-NEEDLE-1'), 'ap_invoice')).toEqual(['API-BGW-2026-910003']);
    expect(numbersOf(await run(officer, 'oldref-needle'), 'ap_invoice')).toEqual(['API-BGW-2026-910003']);
    // By its middle: only while it is among the newest rows. (The documented limit of a name search on a large table.)
    expect(numbersOf(await run(officer, 'needle-1'), 'ap_invoice')).toEqual([]);
    // …and the newest rows are still matched by their middle.
    expect(numbersOf(await run(officer, 'gsfill-10'), 'ap_invoice').length).toBeGreaterThan(0);
  });
});
