/**
 * REQ-AP-001 Stage 8 — migration & go-live (§24.3, §24.4).
 *
 *   A20  The sheet import is dry-run first and the dry run changes nothing; it
 *        lists the unmatched suppliers (never created), the PDs with no import
 *        (a holding list), the SWIFT dates to verify and the legacy-cleared
 *        differences; apply creates what is missing — once, however often it
 *        runs — and Applied / Paid / Remaining in the ERP match the sheet for
 *        every matched import; the accountant who did not apply it signs off.
 *   §24.4 A four-stage shipment becomes an import application with one B/L and
 *        one container MIGRATED-<invoice no>, which a container receipt then
 *        takes out of transit as any other.
 *
 * The workbook here is built in the test, in the sheet's own shape (headers
 * by name, title rows above them, serial dates). Set QS_DASHBOARD_XLSX to the
 * real file to also check the A20 totals on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import writeXlsxFile from 'write-excel-file/node';
import { ownerPool, rejection } from './setup';
import { withScope } from '@/server/db/client';
import * as ap from '@/server/services/ap-invoice';
import * as authz from '@/server/services/authorization';
import * as customs from '@/server/services/customs-pd';
import * as applications from '@/server/services/payment-applications';
import * as payables from '@/server/services/payables';
import * as migration from '@/server/services/payables-migration';
import * as shipments from '@/server/services/shipments';
import type { ActorContext } from '@/server/services/chart-of-accounts';
import { parseDecimal } from '@/server/domain/money';
import { parseQuantity } from '@/server/domain/uom';
import { BAGHDAD, PANEL, WAREHOUSE, buildTradingWorld, scope, type TradingWorld } from './trading-fixture';

let world: TradingWorld;
let second: ActorContext;
const IN_PROCESS = 'WH-AP08-INPROC';

/** An Excel serial date, as the sheet stores one. */
const serial = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000) + 25569;

async function workbook(): Promise<Buffer> {
  const rows = (data: unknown[][]) => data.map((row) => row.map((value) => (value === null ? null : { value })));
  const sheets = [
    {
      sheet: 'dashboard',
      data: rows([
        ['CHINA NATIONAL BUILDING MATERIAL GROUP FZE'],
        ['PO no./ INV.', 'INV. Date', 'Supplier', 'INV. Amount', 'INV. Qty', 'Pmt Terms', 'Products', 'PD. No.', 'Registration Date', 'Expire Date', 'PD. Status', 'Paid Amount (SWIFT)', 'Pmt Remaining', 'Applied Amount', 'BL No.', 'Inbounded Qty', 'Clear?'],
        [null],
        ['AIK-001', serial('2026-03-01'), 'AIKO ENERGY SINGAPORE PTE.LTD.', 100000, 1000, 'CFR', 'panel', 1001, null, null, 'Totally written off', 100000, null, 100000, 'MEDUAIK00001', 1000, 'cleared'],
        [' AIK-002 ', serial('2026-04-01'), 'AIKO ENERGY  SINGAPORE PTE.LTD.', 50000, 500, 'TT 40% / 60%', 'battery', 1002, null, null, 'Totally written off', 20000, 30000, 50000, 'MEDUAIK00002', null, null],
        ['GH-001', serial('2026-05-01'), 'GHOST TRADING LLC', 30000, 100, 'CFR', 'cable', null, null, null, null, 0, 30000, 5000, null, null, null],
      ]),
    },
    {
      sheet: 'PMT',
      data: rows([
        ['PO/INV. no.', 'Supplier', 'INV. Date', 'Bank', 'Application AMT.', 'Application date', 'Swift date', 'Payment Status'],
        [null],
        ['AIK-001', 'AIKO', null, 'MANSOUR', 100000, serial('2026-03-05'), serial('2026-03-10'), 'PAID'],
        ['AIK-002', 'AIKO', null, 'MANSOUR', 20000, serial('2026-04-05'), serial('2026-04-08'), 'PAID'],
        ['AIK-002', 'AIKO', null, 'MANSOUR', 30000, serial('2026-05-01'), null, 'NOT PAID'],
        ['ZZZ-404', 'NOBODY', null, 'MANSOUR', 1000, serial('2026-05-01'), null, 'NOT PAID'],
        ['GH-001', 'GHOST', null, 'ARAB', 5000, serial('2026-05-02'), null, 'NOT PAID'],
      ]),
    },
    {
      sheet: 'PD',
      data: rows([
        ['PD SETTLEMENT'],
        ['Source: ASYCUDA Document List'],
        ['Total PD', 4],
        ['Totally written off', 2],
        ['PO no./ INV.', 'INV. Date', 'Supplier', 'PD No.', 'Registration Date', 'Expire Date', 'Status', 'Bank Code', 'SWIFT', 'Dashboard PD No.', 'Dashboard PD Status', 'Check', 'Notes'],
        ['AIK-001', null, null, 1001, serial('2026-03-02'), serial('2026-09-01'), 'Totally written off', 32, 'MBIVIQBAXXX', 1001, null, 'MATCH', 'settled with customs'],
        ['AIK-002', null, null, 1002, serial('2026-04-02'), serial('2026-10-01'), 'Totally written off', 32, 'MBIVIQBAXXX', 1002, null, 'MATCH', null],
        [null, null, null, 1003, serial('2026-04-03'), serial('2026-10-02'), 'Validated', 32, null, null, null, null, null],
        ['GH-001', null, null, 1004, serial('2026-05-03'), serial('2026-11-03'), 'Submited', null, null, null, null, null, null],
      ]),
    },
    {
      sheet: 'Pending',
      data: rows([[null], ['PD No.', 'Invoice / PO', 'Status', 'Notes'], [1001, 'AIK-001', 'Totally written off', 'all file at the bank']]),
    },
    {
      sheet: 'BL',
      data: rows([
        ['Po/INV. NO.', 'Supplier', 'INV. Date', 'PD. No.', 'PD. Status', 'BL No.', 'Product Category', 'POD', 'BL Total Qty', 'ETA', 'Shipping Status ', 'Inbounded Qty', 'PORT File Sent?', 'BL Date', 'CTN No.', 'Product Detail', 'Detail Qty Check'],
        [null],
        ['AIK-001', null, null, 1001, null, 'MEDUAIK00001', 'panel', 'UMM', 1000, serial('2026-05-01'), 'Inbounded', 1000, null, serial('2026-04-01'), 'MSCU1234565\nTGHU7654321', null, null],
        ['AIK-002', null, null, 1002, null, 'MEDUAIK00002', 'battery', 'AQABA', 500, serial('2026-10-20'), 'On the sea', null, null, serial('2026-09-01'), 'CAIU2345678\nWHSL6245060', null, null],
      ]),
    },
    {
      sheet: 'BL Product Detail',
      data: rows([
        ['BL PRODUCT DETAIL'],
        ['One row = one BL × model × warehouse allocation.'],
        ['White = manual input'],
        ['BL No.', 'PO/INV No.', 'Supplier', 'PD No.', 'BL Date', 'CTN No.', 'Product Category', 'Brand', 'Model', 'Specification', 'Planned Inbound Qty', 'Unit', 'Warehouse', 'Inbound Date', 'SKU Inbound Qty'],
        ['MEDUAIK00002', 'AIK-002', null, 1002, null, 'CAIU2345678', 'battery', 'LV', 'BAT-48V', 'LFP', 500, 'PCS', 'W01', null, null],
      ]),
    },
    {
      sheet: 'Pending Order',
      data: rows([
        ['PENDING ORDER / PRE-SALE'],
        ['For pre-sale management'],
        ['Pending SKU Lines', 1],
        ['PO/INV No.', 'Supplier', 'INV Date', 'Product Category', 'Brand', 'Model / SKU', 'Specification', 'Order Qty', 'Pre-sold Qty', 'Available Presale Qty', 'Expected Ship Date', 'Expected Arrival Date', 'Days to Arrival', 'Order Ship Progress', 'Presale Status', 'Remarks'],
        ['AIK-002', null, null, 'battery', 'LV', 'BAT-48V', 'LFP 48V', 500, null, null, null, null, null, null, null, 'PI line 1'],
      ]),
    },
    { sheet: 'Warehouse Master', data: rows([['Warehouse'], ['W01']]) },
  ];
  return (await writeXlsxFile(sheets as never).toBuffer()) as Buffer;
}

const count = async (table: string, where = 'true') =>
  (await ownerPool.query(`select count(*)::int as n from ${table} where ${where}`)).rows[0].n as number;
const dryRun = (content: Buffer, by = world.manager) =>
  withScope(scope(by), (tx) => migration.dryRun(tx, by, { fileName: 'QS_DASHBOARD.xlsx', content }));
const apply = (content: Buffer, by = world.manager) =>
  withScope(scope(by), (tx) => migration.apply(tx, by, { fileName: 'QS_DASHBOARD.xlsx', content, runDate: '2026-09-30' }));

beforeEach(async () => {
  world = await buildTradingWorld();
  await ownerPool.query(
    `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
     values ('SUP-AIKO','Aiko Energy Singapore Pte. Ltd.',false,true,'active',true)`,
  );
  // A USD account at Mansour Bank, where the sheet's SWIFTs left from.
  const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
  const { rows: gl } = await ownerPool.query(
    `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
     values ('A980001','Mansour USD','asset',$1,false,true,'approved',1,'USD') returning id`,
    [parent[0].id],
  );
  await ownerPool.query(
    `insert into bank_cash_account (code, name, account_type, currency, gl_account_id, bank_code, bank_name, account_number)
     values ('BNK-MAN-USD','Mansour USD','bank','USD',$1,'BNK-0001','Mansour Bank','MB-USD-1')`,
    [gl[0].id],
  );
  await ownerPool.query(`insert into payment_method (code, name, kind, confirmation_kind) values ('PM-T001','SWIFT transfer','bank','swift')`);
  // A second accounting manager, to sign off what the first applied.
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,'Second Manager')`, [id, `${id}@example.com`]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,'accounting_manager')`, [id]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  second = { principal: await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id)), branchCode: BAGHDAD };
});

describe('A20 · the sheet, dry run first', () => {
  it('the dry run writes nothing but its report, and the report says what the accountant must decide', async () => {
    const file = await workbook();
    const { report } = await dryRun(file);
    expect(report.counts).toMatchObject({ imports: 3, payments: 5, pds: 4, bls: 2, containers: 3, details: 1, orderLines: 1, notes: 1 });
    expect(report.suppliers.unmatched).toEqual([{ name: 'GHOST TRADING LLC', references: ['GH-001'] }]);
    expect(report.suppliers.matched.map((s) => s.code)).toEqual(['SUP-AIKO']);
    expect(report.banks).toEqual(
      expect.arrayContaining([
        { sheet: 'MANSOUR', bankCode: 'BNK-0001', bankName: 'Mansour Bank', accountCode: 'BNK-MAN-USD' },
        expect.objectContaining({ sheet: 'ARAB', bankCode: 'BNK-0002', accountCode: null }),
      ]),
    );
    expect(report.skippedPayments.map((p) => [p.reference, p.code, p.name, p.reason])).toEqual([
      ['ZZZ-404', 'no_dashboard_row', null, 'No dashboard row has this PO / invoice number.'],
      ['GH-001', 'supplier_unmatched', 'GHOST TRADING LLC', 'Supplier "GHOST TRADING LLC" is not matched.'],
    ]);
    expect(report.pdHolding.map((p) => p.pdNo)).toEqual(['1003', '1004']);
    expect(report.verifySwift.map((p) => [p.reference, p.amount])).toEqual([['AIK-002', '30000']]);
    expect(report.cleared).toMatchObject({ ruleCleared: 1, legacyCleared: 1, pdWrittenOffNotMarked: ['AIK-002'], markedNotPdWrittenOff: [], differences: [] });
    expect(report.containers.invalid).toEqual([{ blNo: 'MEDUAIK00002', numbers: ['WHSL6245060'] }]);
    expect(report.ports).toEqual(expect.arrayContaining([{ sheet: 'UMM', portCode: 'PRT-0001' }, { sheet: 'AQABA', portCode: 'PRT-0002' }]));
    expect(report.fixes.map((f) => [f.field, f.original, f.used])).toEqual(
      expect.arrayContaining([
        ['PO no./ INV.', ' AIK-002 ', 'AIK-002'],
        ['Supplier', 'AIKO ENERGY  SINGAPORE PTE.LTD.', 'AIKO ENERGY SINGAPORE PTE.LTD.'],
      ]),
    );
    expect(report.totals.sheet).toEqual({ invoiced: '180000.0000', paid: '120000.0000', applied: '155000.0000' });
    expect(await count('payable')).toBe(0);
    expect(await count('payment_application')).toBe(0);
    expect(await count('customs_pd')).toBe(0);
  });

  it('applies only a file that was dry-run; creates once; the ERP agrees with the sheet; clears what the rule clears', async () => {
    const file = await workbook();
    expect(await rejection(apply(file))).toMatch(/Run the dry run of this file first/);
    await dryRun(file);
    const { id: runId, report } = await apply(file);

    expect(report.created).toMatchObject({ payables: 2, orderLines: 2, applications: 3, pds: 4, bls: 2, containers: 3, containerLines: 3 });
    // A20 — for every matched import the ERP holds what the sheet says.
    expect(report.totals.erp).toEqual({ invoiced: '150000.0000', paid: '120000.0000', applied: '150000.0000' });

    const { rows: imports } = await ownerPool.query(
      `select supplier_reference, currency, amount_txn::text as amount, stage_code, closed_at is not null as cleared, legacy_cleared, source
         from payable where source = 'sheet_import' order by supplier_reference`,
    );
    expect(imports).toEqual([
      { supplier_reference: 'AIK-001', currency: 'USD', amount: '100000.0000', stage_code: 'cleared', cleared: true, legacy_cleared: true, source: 'sheet_import' },
      { supplier_reference: 'AIK-002', currency: 'USD', amount: '50000.0000', stage_code: 'shipped', cleared: false, legacy_cleared: false, source: 'sheet_import' },
    ]);
    const { rows: apps } = await ownerPool.query(
      `select a.status, a.amount_txn::text as amount, a.confirmed_on::text as confirmed, a.note
         from payment_application a order by a.amount_txn desc`,
    );
    expect(apps.map((a) => [a.status, a.amount, a.confirmed])).toEqual([
      ['confirmed', '100000.0000', '2026-03-10'],
      ['sent', '30000.0000', null],
      ['confirmed', '20000.0000', '2026-04-08'],
    ]);
    expect(apps[1].note).toMatch(/Verify the SWIFT date/);
    // The PDs with no import wait in the holding list for the customs officer.
    expect(await count('customs_pd', 'payable_id is null')).toBe(2);
    expect((await ownerPool.query(`select last_note from customs_pd where pd_no = '1001'`)).rows[0].last_note).toBe(
      'settled with customs · all file at the bank',
    );
    // The detail line, and the B/L total spread (estimated) where there is none.
    const { rows: lines } = await ownerPool.query(
      `select c.container_no, c.status_code, c.lines_estimated, l.description, l.planned_qty::text as planned, l.received_qty::text as received
         from shipment_container c join shipment_container_line l on l.container_id = c.id order by c.container_no`,
    );
    expect(lines).toEqual([
      { container_no: 'CAIU2345678', status_code: 'on_sea', lines_estimated: false, description: 'BAT-48V', planned: '500.000000', received: null },
      { container_no: 'MSCU1234565', status_code: 'received', lines_estimated: true, description: 'panel', planned: '500.000000', received: '500.000000' },
      { container_no: 'TGHU7654321', status_code: 'received', lines_estimated: true, description: 'panel', planned: '500.000000', received: '500.000000' },
    ]);
    const { rows: told } = await ownerPool.query(
      `select e.event_code from payable_event e join payable p on p.id = e.payable_id
        where p.supplier_reference = 'AIK-001' order by e.recorded_at, e.id`,
    );
    expect(told.map((e) => e.event_code)).toEqual(expect.arrayContaining(['PAYABLE_OPENED', 'SWIFT_CONFIRMED', 'PD_SUBMITTED', 'PD_NOTE', 'BL_ISSUED', 'CONTAINER_ADDED', 'CLEARED']));
    // The unmatched supplier was not created.
    expect(await count('business_partner', `legal_name ilike '%ghost%'`)).toBe(0);

    // Re-run: nothing twice.
    await dryRun(file);
    const again = await apply(file);
    expect(again.report.created).toMatchObject({ payables: 0, applications: 0, pds: 0, bls: 0, containers: 0 });
    expect(await count('payable', `source = 'sheet_import'`)).toBe(2);

    // §20.1 — the comparison is signed off by an accountant who did not apply it.
    expect(await rejection(withScope(scope(world.manager), (tx) => migration.signOff(tx, world.manager, runId, null)))).toMatch(
      /does not sign off/,
    );
    await withScope(scope(second), (tx) => migration.signOff(tx, second, runId, 'Compared with the sheet; AIK-002 waits for its SWIFT.'));
    const { rows: run } = await ownerPool.query(`select signed_off_by from payables_migration_run where id = $1`, [runId]);
    expect(run[0].signed_off_by).toBe(second.principal.userId);

    // §24.3 — the customs officer links a holding-list PD to its import, once.
    const pdId = async (pdNo: string) =>
      (await ownerPool.query(`select id from customs_pd where pd_no = $1`, [pdNo])).rows[0].id as string;
    const aik2 = (await ownerPool.query(`select id from payable where supplier_reference = 'AIK-002'`)).rows[0].id as string;
    const aik1 = (await ownerPool.query(`select id from payable where supplier_reference = 'AIK-001'`)).rows[0].id as string;
    const link = (pdNo: string, payableId: string) =>
      withScope(scope(world.manager), async (tx) => customs.linkToImport(tx, world.manager, await pdId(pdNo), payableId));
    expect(await rejection(link('1003', aik1))).toMatch(/is closed/);
    await link('1003', aik2);
    expect(await rejection(link('1003', aik2))).toMatch(/already linked/);
    expect(await count('customs_pd', 'payable_id is null')).toBe(1);
    const { rows: linked } = await ownerPool.query(
      `select e.summary from payable_event e where e.payable_id = $1 and e.event_code = 'PD_LINKED'`,
      [aik2],
    );
    expect(linked[0].summary).toMatch(/PD 1003 .* linked from the holding list — Validated/);
    const holding = await withScope(scope(world.manager), (tx) => customs.list(tx, { view: 'holding' }));
    expect(holding.map((row) => row.pdNo)).toEqual(['1004']);

    // D37 — the "verify the SWIFT date" row: the bank's copy shows it left
    // before the cut-over, so it is recorded, not posted a second time.
    const { rows: sent } = await ownerPool.query(`select id from payment_application where status = 'sent'`);
    const journals = await count('journal_entry');
    const confirmOld = (on: string) =>
      withScope(scope(world.manager), (tx) =>
        applications.confirmBeforeCutOver(tx, world.manager, sent[0].id, { confirmedOn: on, reference: 'MT103-AIK2' }),
      );
    expect(await rejection(confirmOld('2099-01-01'))).toMatch(/was migrated on .* confirmed with the bank’s copy as any payment is/);
    expect(await rejection(confirmOld('2026-04-30'))).toMatch(/before the file went to the bank on 2026-05-01/);
    await confirmOld('2026-05-10');
    const { rows: done } = await ownerPool.query(
      `select status, confirmed_on::text as on, confirmation_reference as ref, supplier_payment_id, supplier_advance_id
         from payment_application where id = $1`,
      [sent[0].id],
    );
    expect(done[0]).toEqual({ status: 'confirmed', on: '2026-05-10', ref: 'MT103-AIK2', supplier_payment_id: null, supplier_advance_id: null });
    expect(await count('journal_entry')).toBe(journals);
    const { rows: paid } = await ownerPool.query(
      `select e.event_code from payable_event e where e.payable_id = $1 and e.event_code in ('SWIFT_CONFIRMED','FULLY_PAID') order by e.recorded_at, e.id`,
      [aik2],
    );
    expect(paid.map((e) => e.event_code)).toEqual(['SWIFT_CONFIRMED', 'SWIFT_CONFIRMED', 'FULLY_PAID']);

    // The supplier's invoice entered after the cut-over joins the migrated
    // import instead of opening a second one.
    const choices = await withScope(scope(world.clerk), (tx) => payables.openImportsForInvoice(tx));
    expect(choices.map((row) => row.reference)).toContain('AIK-002');
    const aiko = (await ownerPool.query(`select id from business_partner where code = 'SUP-AIKO'`)).rows[0].id as string;
    const invoice = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: aiko,
        supplierInvoiceNo: 'AIK-002-INV',
        branchCode: BAGHDAD,
        invoiceDate: '2026-10-01',
        dueDate: '2026-10-31',
        isImport: true,
        payableId: aik2,
        lines: [
          {
            itemCode: PANEL,
            description: 'Battery 48V',
            quantity: parseQuantity('500'),
            unitPriceIqd: parseDecimal('1000', 4n),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: WAREHOUSE,
          },
        ],
      }),
    );
    const { rows: joined } = await ownerPool.query(`select payable_id, is_import from ap_invoice where id = $1`, [invoice.id]);
    expect(joined[0]).toEqual({ payable_id: aik2, is_import: true });
    expect(await count('payable', `payable_type_code = 'import'`)).toBe(2);
  });

  it('A20 on the real sheet (QS_DASHBOARD_XLSX)', async (context) => {
    const path = process.env.QS_DASHBOARD_XLSX;
    if (!path || !existsSync(path)) return context.skip();
    const { report } = await dryRun(readFileSync(path));
    expect(report.counts).toMatchObject({ imports: 58, payments: 80, pds: 88, bls: 46 });
    expect(report.totals.sheet).toEqual({ invoiced: '35309347.8100', paid: '15617285.4000', applied: '23872694.4000' });
    expect(report.verifySwift).toHaveLength(11);
    expect(report.pdHolding.length).toBeGreaterThanOrEqual(31);
    expect(report.cleared.markedNotPdWrittenOff).toHaveLength(6);
    expect(report.cleared.pdWrittenOffNotMarked).toHaveLength(9);

    // The accountant matches every supplier and opens the three USD accounts;
    // then the import is applied and the ERP is read back.
    let serialNo = 0;
    for (const supplier of report.suppliers.unmatched) {
      await ownerPool.query(
        `insert into business_partner (code, legal_name, is_customer, is_supplier, status, active)
         values ($1,$2,false,true,'active',true)`,
        [`SUP-REAL-${(serialNo += 1)}`, supplier.name],
      );
    }
    const { rows: parent } = await ownerPool.query(`select id from chart_of_account where code = 'A000001'`);
    for (const [code, bankCode] of [['BNK-ARB-USD', 'BNK-0002'], ['BNK-NBI-USD', 'BNK-0003']] as const) {
      const { rows: gl } = await ownerPool.query(
        `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
         values ($1,$2,'asset',$3,false,true,'approved',1,'USD') returning id`,
        [`A98${code.slice(4, 7) === 'ARB' ? '0002' : '0003'}`, code, parent[0].id],
      );
      await ownerPool.query(
        `insert into bank_cash_account (code, name, account_type, currency, gl_account_id, bank_code, bank_name, account_number)
         values ($1,$1,'bank','USD',$2,$3,$1,$1)`,
        [code, gl[0].id, bankCode],
      );
    }
    const content = readFileSync(path);
    const ready = await dryRun(content);
    expect(ready.report.suppliers.unmatched).toEqual([]);
    expect(ready.report.skippedPayments.map((p) => [p.reference, p.amount])).toEqual(
      expect.arrayContaining([
        ['INV-LSCFDF32609004', expect.any(String)],
        ['OCV2026-0B30-0001', expect.any(String)],
        // No bank named: the treasury names the account, then the row is re-run.
        ['SA2026030101A', '460900'],
      ]),
    );
    expect(ready.report.skippedPayments).toHaveLength(3);
    const applied = await apply(content);
    // A20 — the 58 imports: invoiced and paid exactly; applied less the one
    // application the sheet never gave a bank (listed above).
    expect(applied.report.totals.erp).toEqual({ invoiced: '35309347.8100', paid: '15617285.4000', applied: '23411794.4000' });
    expect(await count('payable', `source = 'sheet_import'`)).toBe(58);
  });
});

describe('§24.4 · a four-stage shipment becomes a container', () => {
  it('one application, one B/L and one container MIGRATED-<invoice no>; a receipt then takes the goods out of transit', async () => {
    await ownerPool.query(
      `insert into warehouse (code, name, branch_code, warehouse_type, is_transit, shipment_stage)
       values ($1,'In Process',$2,'transit',true,'in_process')`,
      [IN_PROCESS, BAGHDAD],
    );
    const made = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'LOC-1001',
        branchCode: BAGHDAD,
        invoiceDate: '2026-09-01',
        dueDate: '2026-11-01',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: parseQuantity('20'),
            unitPriceIqd: parseDecimal('10000', 4n),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: IN_PROCESS,
          },
        ],
      }),
    );
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, made.id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, made.id));
    expect(await count('supplier_shipment')).toBe(1);

    const result = await withScope(scope(world.manager), (tx) => migration.migrateShipments(tx, world.manager));
    expect([result.migrated, result.created, result.linked]).toEqual([1, 1, 0]);
    const { rows } = await ownerPool.query(
      `select i.invoice_no, i.is_import, p.source, c.container_no, c.status_code, b.bl_no, l.planned_qty::text as planned
         from ap_invoice i join payable p on p.id = i.payable_id
         join shipment_container c on c.payable_id = p.id join bill_of_lading b on b.id = c.bl_id
         join shipment_container_line l on l.container_id = c.id where i.id = $1`,
      [made.id],
    );
    const invoiceNo = rows[0].invoice_no as string;
    expect(rows).toEqual([
      {
        invoice_no: invoiceNo,
        is_import: true,
        source: 'shipment_migration',
        container_no: `MIGRATED-${invoiceNo}`,
        status_code: 'not_loaded',
        bl_no: `MIGRATED-${invoiceNo}`,
        planned: '20.000000',
      },
    ]);
    // Twice is once.
    expect((await withScope(scope(world.manager), (tx) => migration.migrateShipments(tx, world.manager))).migrated).toBe(0);

    // The goods still in the In Process warehouse come out by a container receipt.
    const { rows: container } = await ownerPool.query(`select id from shipment_container where container_no = $1`, [`MIGRATED-${invoiceNo}`]);
    const { rows: lines } = await ownerPool.query(`select id from shipment_container_line where container_id = $1`, [container[0].id]);
    await withScope(scope(world.clerk), (tx) =>
      shipments.receive(tx, world.clerk, {
        documentId: randomUUID(),
        containerId: container[0].id,
        warehouseCode: WAREHOUSE,
        receiptDate: '2026-09-20',
        lines: [{ containerLineId: lines[0].id, receivedQty: parseQuantity('20'), damagedQty: 0n, shortQty: 0n }],
        varianceReason: null,
      }),
    );
    const { rows: stock } = await ownerPool.query(
      `select warehouse_code, sum(quantity)::text as qty from inventory_movement where item_code = $1 group by warehouse_code order by 1`,
      [PANEL],
    );
    expect(stock).toEqual([
      { warehouse_code: IN_PROCESS, qty: '0.000000' },
      { warehouse_code: WAREHOUSE, qty: '20.000000' },
    ]);

    // D38 — a non-import invoice raised after the cut-over keeps its
    // four-stage shipment when the import is re-run.
    const cutOver = (await ownerPool.query(`select now() as at`)).rows[0].at as Date;
    const later = await withScope(scope(world.clerk), (tx) =>
      ap.create(tx, world.clerk, {
        supplierId: world.supplierId,
        supplierInvoiceNo: 'LOC-1002',
        branchCode: BAGHDAD,
        invoiceDate: '2026-10-01',
        dueDate: '2026-11-01',
        lines: [
          {
            itemCode: PANEL,
            description: 'Solar Panel 550W',
            quantity: parseQuantity('5'),
            unitPriceIqd: parseDecimal('10000', 4n),
            uomCode: 'EA',
            isInventory: true,
            warehouseCode: IN_PROCESS,
          },
        ],
      }),
    );
    await withScope(scope(world.clerk), (tx) => ap.submit(tx, world.clerk, later.id));
    await withScope(scope(world.manager), (tx) => ap.post(tx, world.manager, later.id));
    expect(await count('supplier_shipment')).toBe(2);
    expect((await withScope(scope(world.manager), (tx) => migration.migrateShipments(tx, world.manager, cutOver))).migrated).toBe(0);
    const { rows: kept } = await ownerPool.query(`select payable_id, is_import from ap_invoice where id = $1`, [later.id]);
    expect(kept[0]).toEqual({ payable_id: null, is_import: false });
  });
});
