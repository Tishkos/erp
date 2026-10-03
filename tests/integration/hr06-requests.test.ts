/**
 * REQ-HR-001 Stage HR-6 — employee requests, documents and the HR reports,
 * against the database.
 *
 *   H11  a claim is asked by the person, wants its receipt, is decided by the
 *        manager — never by the asker or the person — and reimbursed by
 *        Finance through `hr.expense_claim`; its lines are frozen once sent;
 *        an approved trip opens its advance, and the claim that names the
 *        trip settles what the advance owes before paying the rest; a letter
 *        is approved, issued by HR with its text and printed as issued
 *   H12  a document is filed, renewed by a new row and withdrawn with a
 *        reason — never deleted; HR and the person read it, nobody else; the
 *        sweep raises its expiry once
 *   H13  the HR reports and the HR dashboard count from the facts
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { fundBank } from './hr-funds';
import { ownerPool, rejection } from './setup';
import { BAGHDAD, buildTradingWorld, type TradingWorld } from './trading-fixture';
import { withScope } from '@/server/db/client';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { businessToday } from '@/server/domain/business-date';
import * as hrPrint from '@/server/print/hr-reports';
import { messagesFor } from '@/server/print/i18n';
import * as attachments from '@/server/services/attachments';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as advances from '@/server/services/employee-advances';
import * as documents from '@/server/services/employee-documents';
import * as requests from '@/server/services/employee-requests';
import * as hrReports from '@/server/services/hr-reports';
import * as hrSweep from '@/server/services/hr-sweep';
import type { ActorContext } from '@/server/services/chart-of-accounts';

let world: TradingWorld;
let finance: ActorContext;
let hr: ActorContext;
let hrOfficer: ActorContext;
let karim: ActorContext;
let boss: ActorContext;
let outsider: ActorContext;
let karimId = '';
const accounts: Record<string, string> = {};

async function userWith(roles: string[], name: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, name]);
  for (const role of roles) await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code, is_default) values ($1,$2,true)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN') on conflict do nothing`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}

const as = <T>(ctx: ActorContext, fn: (tx: Parameters<Parameters<typeof withScope>[1]>[0]) => Promise<T>) => withScope({ userId: ctx.principal.userId, branchCode: BAGHDAD }, fn);

const balance = async (role: string) =>
  (
    await ownerPool.query(
      `select coalesce(sum(l.debit_iqd - l.credit_iqd), 0)::text as b from journal_line l join journal_entry e on e.id = l.journal_entry_id where e.status in ('posted', 'reversed') and l.account_id = $1`,
      [accounts[role]],
    )
  ).rows[0].b as string;
const notificationsOf = async (userId: string, eventType: string) =>
  (await ownerPool.query(`select subject from notification where recipient_user_id = $1 and event_type = $2`, [userId, eventType])).rows.map((r) => r.subject as string);
const today = businessToday();

beforeEach(async () => {
  world = await buildTradingWorld();
  finance = world.manager;
  hr = await userWith(['hr_manager'], 'HR Manager');
  hrOfficer = await userWith(['hr_officer'], 'HR Officer');
  karim = await userWith([], 'Karim Saleh');
  boss = await userWith([], 'Boss');
  outsider = await userWith([], 'Outsider');
  let serial = 0;
  for (const [role, parent, name] of [
    ['employee_expense', 'X000001', 'Staff Expenses'],
    ['employee_advance', 'A000001', 'Employee Advances and Loans'],
  ] as const) {
    const { rows: parents } = await ownerPool.query(`select id, account_type from chart_of_account where code = $1`, [parent]);
    const { rows } = await ownerPool.query(
      `insert into chart_of_account (code, name, account_type, parent_id, is_group, is_active, approval_status, level, currency_restriction)
       values ($1,$2,$3,$4,false,true,'approved',1,'IQD') returning id`,
      [`${parent.slice(0, 1)}7${String((serial += 1)).padStart(5, '0')}`, name, parents[0].account_type, parents[0].id],
    );
    accounts[role] = rows[0].id;
    await as(finance, (tx) => coa.setRequiredDimensions(tx, finance, rows[0].id, []));
  }
  accounts.bank = world.accounts.bank!;
  await fundBank(world, '10000000.0000');
  for (const [event, role] of [
    ['hr.expense_claim', 'employee_expense'],
    ['hr.expense_claim', 'employee_advance'],
    ['hr.employee_advance', 'employee_advance'],
  ] as const) {
    await ownerPool.query(`insert into posting_rule (event_type, line_role, account_id, is_active, created_by) values ($1,$2,$3,true,$4)`, [event, role, accounts[role], finance.principal.userId]);
  }
  const { rows: bossRow } = await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, created_by) values ('E-0009','Boss',$1,'FIN','2020-01-01',$2,$3) returning id`,
    [BAGHDAD, boss.principal.userId, finance.principal.userId],
  );
  const { rows: karimRow } = await ownerPool.query(
    `insert into employee (employee_no, full_name_en, branch_code, department_code, hire_date, app_user_id, manager_employee_id, created_by) values ('E-0001','Karim Saleh',$1,'FIN','2025-01-01',$2,$3,$4) returning id`,
    [BAGHDAD, karim.principal.userId, bossRow[0].id, finance.principal.userId],
  );
  karimId = karimRow[0].id;
  registerAttachmentRuntime();
  const files = new Map<string, Buffer>();
  attachments.registerStorage({ put: async (key, content) => void files.set(key, content), get: async (key) => files.get(key) ?? null });
  attachments.registerScanner(() => ({ status: 'clean' }));
});

const claimLines = (amount = '45000') => [
  { spentOn: '2026-09-20', categoryCode: 'other', description: 'Taxi to the customs office', amount },
  { spentOn: '2026-09-21', categoryCode: 'government_fees', description: 'Stamp duty', amount: '5000' },
];

describe('H11 · employee requests', () => {
  it('a claim is asked by the person, wants its receipt, is decided by the manager and reimbursed by Finance', async () => {
    const made = await as(karim, (tx) => requests.create(tx, karim, { employeeId: karimId, kind: 'expense_claim', subject: 'Customs trip', lines: claimLines() }));
    expect(made.requestNo).toMatch(/^ECLM-BGW-\d{4}-00001$/);
    // The taxi's category wants its receipt.
    expect(await rejection(as(karim, (tx) => requests.submit(tx, karim, made.requestNo)))).toMatch(/Other wants its receipt/);
    // HR files the receipt the person handed in (attaching asks the attachment grant, which HR holds).
    await as(hrOfficer, (tx) => attachments.upload(tx, hrOfficer, { objectType: requests.PERMISSION_OBJECT, objectId: made.id, fileName: 'receipt.pdf', content: Buffer.from('%PDF-1.4 receipt') }));
    await as(karim, (tx) => requests.submit(tx, karim, made.requestNo));
    expect(await notificationsOf(boss.principal.userId, 'hr.request_submitted')).toHaveLength(1);
    // Sent, the lines are what was sent.
    expect(await rejection(ownerPool.query(`update employee_request_line set amount_iqd = 1 where request_id = $1`, [made.id]))).toMatch(/lines change only while it is a draft/);

    expect(await rejection(as(karim, (tx) => requests.approve(tx, karim, made.requestNo)))).toMatch(/somebody else decides it/);
    expect(await rejection(as(outsider, (tx) => requests.approve(tx, outsider, made.requestNo)))).toMatch(/No request 'ECLM-/);
    expect(await rejection(as(finance, (tx) => requests.pay(tx, finance, made.requestNo, { bankCashAccountId: world.bankAccountId, on: today })))).toMatch(/cannot become paid/);
    await as(boss, (tx) => requests.approve(tx, boss, made.requestNo, 'Fine'));
    expect(await notificationsOf(finance.principal.userId, 'hr.request_to_pay')).toHaveLength(1);
    // The person never decides their own — the trigger holds it too.
    expect(await rejection(ownerPool.query(`update employee_request set decided_by = $2 where id = $1`, [made.id, karim.principal.userId]))).toMatch(/does not decide or pay their own request/);

    expect(await rejection(as(finance, (tx) => requests.pay(tx, finance, made.requestNo, { on: today })))).toMatch(/choose the bank or cash account/);
    const paid = await as(finance, (tx) => requests.pay(tx, finance, made.requestNo, { bankCashAccountId: world.bankAccountId, on: today, reference: 'CHQ-1' }));
    expect(paid).toMatchObject({ offsetIqd: '0.0000', paidIqd: '50000.0000' });
    expect(await balance('employee_expense')).toBe('50000.0000');
    expect(await notificationsOf(karim.principal.userId, 'hr.request_paid')).toEqual([`${made.requestNo} is reimbursed`]);
    const detail = (await as(karim, (tx) => requests.byNo(tx, made.requestNo)))!;
    expect([detail.row.status, detail.entryNo !== null, detail.lines.length]).toEqual(['paid', true, 2]);
    expect(await rejection(as(karim, (tx) => requests.cancel(tx, karim, made.requestNo, 'Changed my mind')))).toMatch(/cannot become cancelled/);
  });

  it('an approved trip opens its advance, and the claim that names the trip settles what the advance owes before paying the rest', async () => {
    const trip = await as(hrOfficer, (tx) =>
      requests.create(tx, hrOfficer, { employeeId: karimId, kind: 'travel', subject: 'Basra port visit', destination: 'Basra', travelFrom: '2026-09-10', travelTo: '2026-09-15', estimated: '250000.5' }),
    );
    expect(trip.requestNo).toMatch(/^TRV-BGW-/);
    await as(hrOfficer, (tx) => requests.submit(tx, hrOfficer, trip.requestNo));
    expect(await rejection(as(hr, (tx) => requests.openTravelAdvance(tx, hr, trip.requestNo)))).toMatch(/an advance is opened for an approved trip/);
    await as(boss, (tx) => requests.approve(tx, boss, trip.requestNo));
    const { advanceNo } = await as(hr, (tx) => requests.openTravelAdvance(tx, hr, trip.requestNo));
    expect(await rejection(as(hr, (tx) => requests.openTravelAdvance(tx, hr, trip.requestNo)))).toMatch(/already has its advance/);
    const { rows: advance } = await ownerPool.query(`select amount_iqd::text as amount, first_recovery_month::text as first, reason, status from employee_advance where advance_no = $1`, [advanceNo]);
    // Whole dinars, rounded up; recovered from pay from the second month after the trip unless a claim settles it.
    expect(advance[0]).toEqual({ amount: '250001.0000', first: '2026-11-01', reason: `Travel ${trip.requestNo}: Basra`, status: 'draft' });
    // The advance goes through its own approvals.
    await as(hr, (tx) => advances.submit(tx, hr, advanceNo));
    await as(boss, (tx) => advances.endorse(tx, boss, advanceNo));
    await as(finance, (tx) => advances.approve(tx, finance, advanceNo));
    await as(finance, (tx) => advances.pay(tx, finance, advanceNo, { bankCashAccountId: world.bankAccountId, on: '2026-09-08' }));
    expect(await rejection(as(karim, (tx) => requests.cancel(tx, karim, trip.requestNo, 'x')))).toMatch(/cannot become cancelled|cancel the advance first/);

    const claim = await as(karim, (tx) =>
      requests.create(tx, karim, {
        employeeId: karimId,
        kind: 'expense_claim',
        subject: 'Basra trip',
        travelRequestNo: trip.requestNo,
        lines: [
          { spentOn: '2026-09-12', categoryCode: 'government_fees', description: 'Port pass', amount: '100000' },
          { spentOn: '2026-09-13', categoryCode: 'bank_charges', description: 'Transfer fee', amount: '200000' },
        ],
      }),
    );
    await as(karim, (tx) => requests.submit(tx, karim, claim.requestNo));
    await as(hr, (tx) => requests.approve(tx, hr, claim.requestNo));
    const paid = await as(finance, (tx) => requests.pay(tx, finance, claim.requestNo, { bankCashAccountId: world.bankAccountId, on: today }));
    expect(paid).toMatchObject({ offsetIqd: '250001.0000', paidIqd: '49999.0000' });
    expect(await balance('employee_advance')).toBe('0.0000');
    expect(await balance('employee_expense')).toBe('300000.0000');
    const { rows: recovery } = await ownerPool.query(`select r.source, r.amount_iqd::text as amount, r.reference from employee_advance_recovery r join employee_advance a on a.id = r.advance_id where a.advance_no = $1`, [advanceNo]);
    expect(recovery).toEqual([{ source: 'claim', amount: '250001.0000', reference: claim.requestNo }]);
    expect((await ownerPool.query(`select status from employee_advance where advance_no = $1`, [advanceNo])).rows[0].status).toBe('settled');
    // The trip lists the claim that settled it.
    expect((await as(hr, (tx) => requests.byNo(tx, trip.requestNo)))!.claims.map((c) => [c.requestNo, c.status])).toEqual([[claim.requestNo, 'paid']]);
  });

  it('a letter is approved, issued by HR with its text, and printed exactly as issued — by the person too', async () => {
    const asked = await as(karim, (tx) => requests.create(tx, karim, { employeeId: karimId, kind: 'letter', subject: 'For the bank', letterType: 'employment', addressedTo: 'Rafidain Bank' }));
    expect(asked.requestNo).toMatch(/^LTR-BGW-/);
    await as(karim, (tx) => requests.submit(tx, karim, asked.requestNo));
    expect(await rejection(as(hr, (tx) => requests.refuse(tx, hr, asked.requestNo, ' ')))).toMatch(/Say why/);
    await as(hr, (tx) => requests.approve(tx, hr, asked.requestNo));
    const row = (await as(hr, (tx) => requests.byNo(tx, asked.requestNo)))!.row;
    const draft = await as(hrOfficer, (tx) => requests.draftLetter(tx, row));
    expect(draft).toMatch(/^Rafidain Bank,\n\nThis is to certify that Karim Saleh \(E-0001\) has been employed by .+ since 2025-01-01/);
    expect(await rejection(as(finance, (tx) => requests.issue(tx, finance, asked.requestNo, draft)))).toMatch(/'edit_draft' on 'employee_request'/);
    await as(hrOfficer, (tx) => requests.issue(tx, hrOfficer, asked.requestNo, `${draft}\n\nSigned, HR`));
    expect(await notificationsOf(karim.principal.userId, 'hr.request_issued')).toHaveLength(1);
    // Printed from what was kept — by the person, whom row security lets read it.
    const built = await as(karim, (tx) => hrPrint.letter({ tx, principal: karim.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, asked.requestNo));
    expect(built!.model.number).toBe(asked.requestNo);
    expect(built!.model.tables[0]!.rows.at(-1)!.cells.text).toBe('Signed, HR');
    // Somebody in the branch without the grant does not find it: row security asks for the grant, the person or their manager.
    expect(await as(outsider, (tx) => requests.byNo(tx, asked.requestNo))).toBeNull();
    expect(await as(boss, (tx) => requests.byNo(tx, asked.requestNo))).not.toBeNull();
  });
});

describe('H12 · employee documents', () => {
  it('is filed, renewed by a new row and withdrawn with a reason; read by HR and the person; its expiry raised once', async () => {
    const soon = new Date(Date.parse(`${today}T00:00:00Z`) + 20 * 86_400_000).toISOString().slice(0, 10);
    const filed = await as(hrOfficer, (tx) => documents.create(tx, hrOfficer, { employeeId: karimId, docType: 'passport', referenceNo: 'A1234567', issuedOn: '2021-01-01', expiresOn: soon }));
    expect(filed.documentNo).toMatch(/^EDOC-BGW-\d{5}$/);
    expect(await rejection(as(karim, (tx) => documents.create(tx, karim, { employeeId: karimId, docType: 'passport' })))).toMatch(/'create' on 'employee_document'/);
    // The person reads their own; their manager and the rest of the branch do not.
    expect((await as(karim, (tx) => documents.byNo(tx, filed.documentNo)))?.expiry).toBe('expiring');
    expect(await as(boss, (tx) => documents.byNo(tx, filed.documentNo))).toBeNull();
    expect(await as(outsider, (tx) => documents.byNo(tx, filed.documentNo))).toBeNull();

    const first = await as(hr, (tx) => hrSweep.run(tx, hr.principal, today));
    expect(first.documentsExpiring).toBe(1);
    expect(await notificationsOf(hr.principal.userId, 'hr.document_expiring')).toHaveLength(1);
    expect(await notificationsOf(karim.principal.userId, 'hr.document_expiring')).toEqual([`Your passport expires on ${soon}`]);
    await as(hr, (tx) => hrSweep.run(tx, hr.principal, today));
    expect(await notificationsOf(karim.principal.userId, 'hr.document_expiring')).toHaveLength(1);

    const renewed = await as(hrOfficer, (tx) => documents.renew(tx, hrOfficer, filed.documentNo, { referenceNo: 'B7654321', issuedOn: today, expiresOn: '2036-01-01' }));
    const old = (await as(hr, (tx) => documents.byNo(tx, filed.documentNo)))!;
    const fresh = (await as(hr, (tx) => documents.byNo(tx, renewed.documentNo)))!;
    expect([old.row.status, old.replacedByNo, fresh.row.status, fresh.replacesNo, fresh.chain.length]).toEqual(['superseded', renewed.documentNo, 'valid', filed.documentNo, 2]);
    expect(await rejection(as(hrOfficer, (tx) => documents.renew(tx, hrOfficer, filed.documentNo, {})))).toMatch(/only a valid document is renewed/);
    expect(await rejection(as(hrOfficer, (tx) => documents.withdraw(tx, hrOfficer, renewed.documentNo, '  ')))).toMatch(/reason/);
    await as(hrOfficer, (tx) => documents.withdraw(tx, hrOfficer, renewed.documentNo, 'Filed for the wrong person'));
    expect((await as(hr, (tx) => documents.ofEmployee(tx, karimId))).map((d) => d.status).sort()).toEqual(['superseded', 'withdrawn']);
    expect(await rejection(ownerPool.query(`update employee_document set status = 'withdrawn' where document_no = $1`, [filed.documentNo]))).toMatch(/employee_document_withdrawn/);
  });
});

describe('H13 · the HR reports and dashboard', () => {
  it('count from the facts the reader may see', async () => {
    const counts = await as(hr, (tx) => hrReports.headcount(tx, '2025-01-01', today));
    expect(counts.reduce((sum, r) => sum + r.headcount, 0)).toBe(2);
    expect(counts.reduce((sum, r) => sum + r.joiners, 0)).toBe(1);
    const balances = await as(hr, (tx) => hrReports.leaveBalances(tx, 2026, 1000));
    expect(new Set(balances.map((b) => b.employeeNo))).toEqual(new Set(['E-0001', 'E-0009']));
    expect(await as(finance, (tx) => hrReports.payrollRegister(tx, '2026-09', 100))).toEqual([]);
    // The HR officer reads no pay (D-HR-7): the payroll cost is not there for them.
    const board = await as(hrOfficer, (tx) => hrReports.dashboard(tx, hrOfficer));
    expect([board.headcount, board.joinersThisMonth, board.payrollCost, board.advancesOwedIqd]).toEqual([2, 0, null, '0']);
    const financeBoard = await as(finance, (tx) => hrReports.dashboard(tx, finance));
    expect([financeBoard.payrollCost, financeBoard.advancesOwedIqd]).toEqual([[], '0']);
    const built = await as(hr, (tx) => hrPrint.headcount({ tx, principal: hr.principal, branchCode: BAGHDAD, locale: 'en', m: messagesFor('en') }, new URLSearchParams({ from: '2025-01-01', to: today })));
    expect(built!.model.tables[0]!.totals!.cells.headcount).toBe('2');
  });
});
