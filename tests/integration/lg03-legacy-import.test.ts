/**
 * REQ-LEGACY-001 — the import, end to end (LG3–LG6).
 *
 * A small set of the old books, built the way the accountant's export is
 * shaped, through the whole service: the dry run writes nothing but its
 * report and says what stops an apply; the apply creates the partners,
 * items and warehouses once, posts the opening position so that every
 * partner's sub-ledger balance is the old balance and the equity side
 * balances, raises one submitted Opening Stock per warehouse at the latest
 * cost with the in-transit and negative quantities left out, keeps every
 * old line as history on its partner; and a second apply adds nothing.
 */
import { randomUUID } from 'node:crypto';
import writeXlsxFile from 'write-excel-file/node';
import { beforeAll, describe, expect, it } from 'vitest';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as legacy from '@/server/services/legacy-import';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { mappedLines } from '@/server/domain/posting-map';

const BRANCH = 'BGW';
const CUT_OVER = '2026-04-15';
let manager: ActorContext;
let clerk: ActorContext;

async function createUser(branch: string, ...roles: string[]): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, `User ${roles.join('+')}`]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, branch]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: branch }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: branch };
}

const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: ctx.branchCode });

async function book(sheets: { sheet: string; rows: unknown[][] }[]): Promise<Buffer> {
  const data = sheets.map(({ sheet, rows }) => ({ sheet, data: rows.map((row) => row.map((value) => (value === null ? null : { value }))) }));
  return (await writeXlsxFile(data as never).toBuffer()) as Buffer;
}

/** The old books, small: three customers (one in credit, one in dollars), one supplier, three items, three warehouses. */
async function files(options: { renamed?: boolean } = {}): Promise<legacy.LegacyFile[]> {
  const partnersHeader = ['اسم الحساب', 'رقم الحساب', 'الرصيد بالدينار', 'الرصيد بالدولار', 'رقم الهاتف'];
  const balancesHeader = ['الحساب', 'رقم الحساب', 'الرصيد', 'اخر حركة', 'اخر تسديد'];
  const voltName = options.renamed ? 'VOLT GUIDE RENAMED' : 'VOLT GUIDE';
  return [
    {
      fileName: 'Clients-الزبائن.xlsx',
      content: await book([{ sheet: 'Sheet1', rows: [partnersHeader, [voltName, '1000', '24,634,400  مدين / لنا', '0  ', '07842221177'], ['شركة زحل', '1038', '-24,469,200  دائن / علينا', '-100  دائن / علينا', ''], ['زبون صفر', '1050', '0  ', '0  ', '']] }]),
    },
    {
      fileName: 'Suppliers-الموردين.xlsx',
      content: await book([{ sheet: 'Sheet1', rows: [partnersHeader, ['كاك بابان', '1023', '-8,979,309,500  دائن / علينا', '0  ', '']] }]),
    },
    {
      fileName: 'Account_balances.xlsx',
      content: await book([
        { sheet: 'IQD', rows: [balancesHeader, [voltName, '1000', '24,634,400  مدين / لنا', '9/21/2026', '9/15/2026'], ['شركة زحل', '1038', '-24,469,200  دائن / علينا', '9/21/2026', '---'], ['زبون صفر', '1050', '0  ', '1/1/2025', '---']] },
        { sheet: 'USD', rows: [balancesHeader, ['شركة زحل', '1038', '-100  دائن / علينا', '2/26/2026', '2/7/2026']] },
      ]),
    },
    {
      fileName: 'warehouses.xlsx',
      content: await book([{ sheet: 'ورقة1', rows: [
        ['اسم المادة', 'رمز المادة', 'المخزن', 'العدد', 'المحجوز', 'موجود المخزن'],
        ['CABLE 1*6 200M', '', 'مخزن بغداد ', '86', '0', '86'],
        ['CABLE 1*6 200M', '', 'مخزن قيد الشحن', '-5', '0', '-5'],
        ['645W HIMOX10', '', 'مخزن بغداد ', '0', '0', '0'],
        ['645W HIMOX10', '', 'مخزن QS', '-3', '0', '-3'],
        ['Gsl 16 Kw', '', 'مخزن QS', '2', '0', '2'],
        ['Gsl 16 Kw', '', 'مخزن بغداد ', '1', '0', '1'],
      ] }]),
    },
    {
      fileName: 'Sales.xlsx',
      content: await book([{ sheet: 'Sheet1', rows: [
        ['رقم القائمة', 'اسم الزبون', 'المادة', 'سعر الشراء', 'سعر البيع', 'العدد', 'المجموع'],
        ['3', voltName, 'CABLE 1*6 200M', '190,000 د.ع', '215,000 د.ع', '10 متر', '2,150,000 د.ع'],
        ['3', voltName, 'Gsl 16 Kw', '1,500,000 د.ع', '1,900,000 د.ع', '1 قطعة', '1,900,000 د.ع'],
        ['4', 'زبون نقدي', 'CABLE 1*6 200M', '0', '220,000 د.ع', '2 متر', '440,000 د.ع'],
      ] }]),
    },
    {
      fileName: 'Purchases.xlsx',
      content: await book([{ sheet: 'Sheet1', rows: [
        ['رقم القائمة', 'اسم الزبون', 'المادة', 'سعر البيع', 'العدد', 'المجموع', 'التاريخ'],
        ['510510', 'كاك بابان', 'CABLE 1*6 200M', '205,000 د.ع', '14 قطعة', '2,870,000 د.ع', '4/23/2025 5:36:06 PM'],
      ] }]),
    },
    {
      fileName: 'Receipt_Vouchers.xlsx',
      content: await book([{ sheet: 'ورقة1', rows: [
        ['رقم السند', 'نوع العملية', 'المبلغ', 'العملة', 'الاسم', 'رقم الحساب', 'التاريخ'],
        ['1', ' قبض', '30,000,000', 'دينار', voltName, '1000', '11/2/2024'],
        ['2', ' قبض', '500', 'دولار', 'شركة زحل', '1038', '11/3/2024'],
        ['3', ' قبض', '1,000', 'دينار', 'مجهول', '9999', '11/4/2024'],
      ] }]),
    },
    {
      fileName: 'Payment_vouchers.xlsx',
      content: await book([{ sheet: 'ورقة1', rows: [
        ['التاريخ', 'رقم الحساب', 'الاسم', 'العملة', 'المبلغ', 'نوع العملية', 'رقم السند'],
        ['11/7/2024', '1023', 'كاك بابان', 'دينار', '12,000,000', ' دفع', '1'],
      ] }]),
    },
    {
      fileName: 'the_accounts.xlsx',
      content: await book([{ sheet: 'ورقة1', rows: [
        ['الفقرة', 'الرصيد بالدينار', 'الرصيد بالدولار', 'الرصيد النهائي'],
        ['مخزون البضائع بغرض البيع', '20,000,000', '0', '20,000,000'],
        ['حسابات الزبائن', '165,200', '-100', '18,200'],
        ['حسابات مجهزين', '-8,979,309,500', '0', '-8,979,309,500'],
      ] }]),
    },
  ];
}

beforeAll(async () => {
  await resetTestData();
  await seedBranch(BRANCH, 'Baghdad');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  manager = await createUser(BRANCH, 'accounting_manager');
  clerk = await createUser(BRANCH, 'accounting_officer');

  // The accounts the opening journal and the stock need, mapped for every event that names them.
  const accounts: Record<string, string> = {};
  let serial = 0;
  for (const [role, parent, name, control] of [
    ['customer_receivable', 'A000001', 'Trade Receivables', 'customer'],
    ['supplier_payable', 'L000001', 'Trade Payables', 'supplier'],
    ['opening_balance', 'E000001', 'Opening Balance Equity', null],
    ['inventory', 'A000001', 'Inventory', null],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    serial += 1;
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction, control_account)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD',$5) returning id`,
      [`${parent.slice(0, 1)}7${String(serial).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id, control],
    );
    accounts[role] = rows[0].id;
    await withScope(scope(manager), (tx) => coa.setRequiredDimensions(tx, manager, rows[0].id, []));
  }
  for (const mapped of mappedLines()) {
    if (!accounts[mapped.role]) continue;
    await ownerPool.query(
      `insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4) on conflict do nothing`,
      [mapped.event, mapped.role, accounts[mapped.role], manager.principal.userId],
    );
  }
  await ownerPool.query(`insert into fiscal_year (code, name, starts_on, ends_on, status) values ('FY2026','2026','2026-01-01','2026-12-31','open') on conflict do nothing`);
  const { rows: years } = await ownerPool.query(`select id from fiscal_year where code='FY2026'`);
  await ownerPool.query(
    `insert into fiscal_period (fiscal_year_id, period_no, name, starts_on, ends_on) values ($1,4,'April 2026','2026-04-01','2026-04-30') on conflict do nothing`,
    [years[0].id],
  );
  await ownerPool.query(
    `insert into exchange_rate (currency_code, rate_type, iqd_per_unit, effective_from, entered_by) values ('USD','accounting',1310.00000000,'2026-01-01',$1) on conflict do nothing`,
    [manager.principal.userId],
  );
});

const run = (ctx: ActorContext, mode: 'dry_run' | 'apply', set: legacy.LegacyFile[], cutOverDate = CUT_OVER) =>
  withScope(scope(ctx), (tx) => (mode === 'apply' ? legacy.apply(tx, ctx, { files: set, cutOverDate }) : legacy.dryRun(tx, ctx, { files: set, cutOverDate })));

describe('LG3 · the dry run', () => {
  it('needs the import grant', async () => {
    expect(await rejection(run(clerk, 'dry_run', await files()))).toMatch(/Permission denied/);
  });

  it('refuses an apply before a dry run of the same files', async () => {
    expect(await rejection(run(manager, 'apply', await files()))).toMatch(/not been dry-run/);
  });

  it('reads every workbook, decides everything and writes nothing but its report', async () => {
    const before = await ownerPool.query(`select (select count(*) from business_partner) p, (select count(*) from item) i, (select count(*) from journal_entry) j`);
    const report = await run(manager, 'dry_run', await files());
    expect(report.mode).toBe('dry_run');
    expect(report.problems).toEqual([]);
    expect(report.stops).toEqual([]);
    expect(report.missing).toEqual(['materials']);
    expect(report.files.map((f) => f.sheets.map((s) => s.kind)).flat().sort()).toEqual(['accounts', 'balances', 'balances', 'customers', 'payments', 'purchases', 'receipts', 'sales', 'suppliers', 'warehouses']);
    expect(report.partners.create.map((p) => `${p.code}:${p.kind}`)).toEqual(['1000:customer', '1038:customer', '1050:customer', '1023:supplier']);
    expect(report.partners.matched).toEqual([]);
    expect(report.balances.totals).toEqual({ customerIqd: '165200.0000', customerUsd: '-100.0000', supplierIqd: '-8979309500.0000', supplierUsd: '0.0000' });
    expect(report.balances.agrees).toBe(true);
    expect(report.rate).toEqual({ implied: '1470.0000', erp: '1310.00000000' });
    expect(report.balances.journals).toEqual([
      { currency: 'IQD', entryNo: null, lines: 4, equity: '-8979144300.0000' },
      { currency: 'USD', entryNo: null, lines: 2, equity: '-147000.0000' },
    ]);
    // The in-transit warehouse is not opened and not created; the empty positions are nothing.
    expect([...report.warehouses.create].sort()).toEqual(['مخزن QS', 'مخزن بغداد']);
    // Every item of the old catalogue, whether or not it is in stock today.
    expect(report.items.create.map((i) => `${i.name}:${i.uom}`).sort()).toEqual(['645W HIMOX10:EA', 'CABLE 1*6 200M:M', 'Gsl 16 Kw:EA']);
    expect(report.stock.documents.map((d) => [d.warehouse, d.lines, d.units, d.costIqd, d.documentNo])).toEqual([
      ['مخزن بغداد', 2, '87', '19130000.0000', null],
      ['مخزن QS', 1, '2', '3000000.0000', null],
    ]);
    expect(report.stock.inTransit.map((n) => `${n.item}@${n.warehouse}=${n.quantity}`)).toEqual(['CABLE 1*6 200M@مخزن قيد الشحن=-5', '645W HIMOX10@مخزن QS=-3']);
    expect(report.stock.noCost).toEqual([]);
    expect(report.stock.proposedValueIqd).toBe('22130000.0000');
    expect(report.stock.tbValueIqd).toBe('20000000.0000');
    expect(report.archive).toMatchObject({ sales: 3, purchases: 1, receipts: 3, payments: 1, unmatchedNames: ['زبون نقدي'], unmatchedCodes: ['9999'], written: null });
    const after = await ownerPool.query(`select (select count(*) from business_partner) p, (select count(*) from item) i, (select count(*) from journal_entry) j`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    const runs = await withScope(scope(manager), (tx) => legacy.runs(tx));
    expect(runs[0]?.mode).toBe('dry_run');
  });

  it('stops on a partner whose name disagrees with the ERP, and on a closed day', async () => {
    const stopped = await run(manager, 'dry_run', await files(), '2026-05-10');
    expect(stopped.stops.some((s) => s.includes('2026-05-10'))).toBe(true);
  });
});

describe('LG4 · the apply', () => {
  it('creates, posts, raises and keeps — once', async () => {
    const report = await run(manager, 'apply', await files());
    expect(report.mode).toBe('apply');
    expect(report.balances.journals.map((j) => j.entryNo)).toEqual([expect.stringMatching(/^JE-/), expect.stringMatching(/^JE-/)]);
    expect(report.stock.documents.map((d) => d.documentNo)).toEqual([expect.stringMatching(/^OPN-/), expect.stringMatching(/^OPN-/)]);
    expect(report.archive.written).toBe(8);

    // The partners, by their old account numbers, with the phone.
    const partners = await ownerPool.query(`select code, legal_name, is_customer, is_supplier, phone from business_partner where code in ('1000','1038','1050','1023') order by code`);
    expect(partners.rows).toEqual([
      { code: '1000', legal_name: 'VOLT GUIDE', is_customer: true, is_supplier: false, phone: '07842221177' },
      { code: '1023', legal_name: 'كاك بابان', is_customer: false, is_supplier: true, phone: null },
      { code: '1038', legal_name: 'شركة زحل', is_customer: true, is_supplier: false, phone: null },
      { code: '1050', legal_name: 'زبون صفر', is_customer: true, is_supplier: false, phone: null },
    ]);

    // The opening position: every partner's sub-ledger is the old balance, dollars at 1,470.
    const balances = await ownerPool.query(
      `select party_code, subledger_type, sum(debit_iqd) - sum(credit_iqd) as net from subledger_entry
        where journal_entry_id in (select id from journal_entry where source_module = 'legacy') group by 1, 2 order by 1`,
    );
    expect(balances.rows.map((r) => [r.party_code, r.subledger_type, String(r.net)])).toEqual([
      ['1000', 'customer', '24634400.0000'],
      ['1023', 'supplier', '-8979309500.0000'],
      ['1038', 'customer', String(-24_469_200 - 147_000) + '.0000'],
    ]);
    const journals = await ownerPool.query(`select entry_no, status, posting_date::text as posting_date, total_debit_iqd, total_credit_iqd from journal_entry where source_module = 'legacy' order by entry_no`);
    expect(journals.rows).toHaveLength(2);
    for (const row of journals.rows) {
      expect(row.status).toBe('posted');
      expect(row.posting_date).toBe(CUT_OVER);
      expect(String(row.total_debit_iqd)).toBe(String(row.total_credit_iqd));
    }

    // The stock: submitted, not posted; the in-transit quantities nowhere.
    const stock = await ownerPool.query(`select o.document_no, o.status, w.name as warehouse, (select count(*) from opening_stock_line l where l.opening_stock_id = o.id)::int as lines from opening_stock o join warehouse w on w.code = o.warehouse_code where o.description like 'Legacy books%' order by w.name`);
    expect(stock.rows.map((r) => [r.warehouse, r.status, r.lines])).toEqual([
      ['مخزن QS', 'submitted', 1],
      ['مخزن بغداد', 'submitted', 2],
    ]);
    const movements = await ownerPool.query(`select count(*)::int as n from inventory_movement`);
    expect(movements.rows[0].n).toBe(0);
    const transit = await ownerPool.query(`select count(*)::int as n from warehouse where name like '%قيد الشحن%'`);
    expect(transit.rows[0].n).toBe(0);

    // The history, on its partner.
    const history = await ownerPool.query(`select kind, legacy_no, legacy_account_no, (partner_id is not null) as linked from legacy_document order by kind, legacy_no, line_no`);
    expect(history.rows.map((r) => `${r.kind}:${r.legacy_no}:${r.legacy_account_no ?? '-'}:${r.linked ? 'y' : 'n'}`)).toEqual([
      'payment:1:1023:y',
      'purchase:510510:1023:y',
      'receipt:1:1000:y',
      'receipt:2:1038:y',
      'receipt:3:9999:n',
      'sale:3:1000:y',
      'sale:3:1000:y',
      'sale:4:-:n',
    ]);
    const { rows: volt } = await ownerPool.query(`select id from business_partner where code = '1000'`);
    const mine = await withScope(scope(manager), (tx) => legacy.historyOf(tx, volt[0].id));
    expect(mine.map((d) => `${d.kind}:${d.legacyNo}`)).toEqual(['sale:3', 'sale:3', 'receipt:1']);
  });

  it('adds nothing on a second apply of the same files', async () => {
    const again = await run(manager, 'apply', await files());
    expect(again.archive.written).toBe(0);
    expect(again.partners.create).toEqual([]);
    expect(again.partners.matched).toHaveLength(4);
    expect(again.items.create).toEqual([]);
    expect(again.warehouses.create).toEqual([]);
    const journals = await ownerPool.query(`select count(*)::int as n from journal_entry where source_module = 'legacy'`);
    expect(journals.rows[0].n).toBe(2);
    const stock = await ownerPool.query(`select count(*)::int as n from opening_stock where description like 'Legacy books%'`);
    expect(stock.rows[0].n).toBe(2);
    const partners = await ownerPool.query(`select count(*)::int as n from business_partner where code in ('1000','1038','1050','1023')`);
    expect(partners.rows[0].n).toBe(4);
  });

  it('stops when the old books name a partner the ERP knows by another name', async () => {
    const report = await run(manager, 'dry_run', await files({ renamed: true }));
    expect(report.partners.conflicts).toEqual([{ code: '1000', legacyName: 'VOLT GUIDE RENAMED', erpName: 'VOLT GUIDE' }]);
    expect(report.stops.some((s) => s.includes('1000'))).toBe(true);
    // Dry-run it was; applied it cannot be.
    expect(await rejection(run(manager, 'apply', await files({ renamed: true })))).toMatch(/cannot be applied yet/);
  });
});
