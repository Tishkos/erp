/**
 * Recurring Journals — REQ-ACC-001 Part D-7, migration 0291.
 *
 *   - A template raises ordinary draft journals through `journal.ts` — the
 *     journal's own number, rate, dimensions and approval — and never posts.
 *   - Agreed by somebody other than its writer; it must balance first.
 *   - One journal per due date, however often "raise" is pressed; the next
 *     due date moves on, counted from the start (31 Jan, 28 Feb, 31 Mar).
 *   - Its lines are fixed once it leaves draft (by the database too); ended
 *     with a reason, never deleted; paused raises nothing.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as coa from '@/server/services/chart-of-accounts';
import * as journal from '@/server/services/journal';
import * as periods from '@/server/services/periods';
import * as recurring from '@/server/services/recurring-journals';
import * as rates from '@/server/services/exchange-rates';
import * as attachments from '@/server/services/attachments';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { runExport } from '@/server/print/export';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
let officer: ActorContext;
let manager: ActorContext;
let rentId: string;
let accrualsId: string;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, role]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  await ownerPool.query(`insert into user_department_scope (user_id, department_code) values ($1,'FIN')`, [id]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });

async function approvedAccount(parentCode: string, name: string): Promise<string> {
  const { rows } = await ownerPool.query(`select id from chart_of_account where code = $1`, [parentCode]);
  const account = await withScope(scope(officer), (tx) => coa.createAccount(tx, officer, { currencyRestriction: 'IQD', name, parentId: rows[0].id }));
  await withScope(scope(officer), (tx) => coa.submitForApproval(tx, officer, account.id));
  await withScope(scope(manager), (tx) => coa.approve(tx, manager, account.id));
  return account.id;
}

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  await ownerPool.query(`insert into department (code, name, is_finance) values ('FIN','Finance',true) on conflict do nothing`);
  officer = await createUser('accounting_officer');
  manager = await createUser('accounting_manager');
  await withScope(scope(manager), (tx) => periods.createFiscalYear(tx, manager, { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }));
  await withScope(scope(manager), (tx) =>
    rates.publishRate(tx, manager, { currency: 'USD', iqdPerUnit: '1310.00000000', effectiveFrom: '2026-01-01', source: 'Central Bank of Iraq' }),
  );
  await ownerPool.query(
    `insert into document_type_dimension (document_type_code, dimension, requirement) values ('journal_entry', 'business_line', 'optional')
     on conflict (document_type_code, dimension) do update set requirement = 'optional'`,
  );
  rentId = await approvedAccount('X000001', 'Office Rent');
  accrualsId = await approvedAccount('L000001', 'Accrued Rent');
});

async function rentTemplate(by: ActorContext = officer) {
  const made = await withScope(scope(by), (tx) =>
    recurring.create(tx, by, { name: 'Office rent', frequency: 'monthly', startsOn: '2026-01-31', endsOn: '2026-06-30' }),
  );
  await withScope(scope(by), (tx) => recurring.addLine(tx, by, made.id, { accountId: rentId, debit: '2500000', departmentCode: 'FIN' }));
  await withScope(scope(by), (tx) => recurring.addLine(tx, by, made.id, { accountId: accrualsId, credit: '2500000' }));
  return made;
}

describe('Recurring Journals', () => {
  it('raises one ordinary draft journal per due date, through the journal engine, and never posts', async () => {
    const made = await rentTemplate();
    expect(made.templateNo).toBe('RJ-00001');

    // The officer who wrote it may not agree to it (no grant), and neither may
    // a manager who wrote one; somebody else does.
    expect(await rejection(withScope(scope(officer), (tx) => recurring.activate(tx, officer, made.id)))).toMatch(/approve/);
    const own = await rentTemplate(manager);
    expect(await rejection(withScope(scope(manager), (tx) => recurring.activate(tx, manager, own.id)))).toMatch(/written by you/);
    // The database holds the same rule.
    expect(
      await rejection(ownerPool.query(`update recurring_journal set status = 'active', activated_by = created_by, activated_at = now() where id = $1`, [own.id])),
    ).toMatch(/recurring_journal_activator_not_creator/);
    await withScope(scope(manager), (tx) => recurring.activate(tx, manager, made.id));

    const raised = await withScope(scope(officer), (tx) => recurring.raiseDue(tx, officer, made.id, '2026-03-31'));
    expect(raised.map((r) => r.dueOn)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    // Pressing again raises nothing new.
    expect(await withScope(scope(officer), (tx) => recurring.raiseDue(tx, officer, made.id, '2026-03-31'))).toEqual([]);

    const first = await withScope(scope(officer), (tx) => journal.detail(tx, raised[0]!.entryNo));
    expect(first.header).toMatchObject({ status: 'draft', postingDate: '2026-01-31', source: 'manual' });
    expect(first.lines.map((l) => [l.accountId, l.debitIqd, l.creditIqd, l.departmentCode])).toEqual([
      [rentId, '2500000.0000', '0.0000', 'FIN'],
      [accrualsId, '0.0000', '2500000.0000', null],
    ]);
    const { rows: posted } = await ownerPool.query(`select count(*)::int as n from journal_entry where status = 'posted'`);
    expect(posted[0].n).toBe(0);

    const view = await withScope(scope(officer), (tx) => recurring.view(tx, officer, made.templateNo));
    expect(view.template.nextDueOn).toBe('2026-04-30');
    expect(view.runs.map((r) => r.entryNo)).toEqual(raised.map((r) => r.entryNo).reverse());
    expect(await withScope(scope(officer), (tx) => recurring.templateOfJournal(tx, first.header.id))).toEqual({
      templateNo: made.templateNo,
      dueOn: '2026-01-31',
    });

    // Up to its end date and no further.
    const rest = await withScope(scope(officer), (tx) => recurring.raiseDue(tx, officer, made.id, '2026-12-31'));
    expect(rest.map((r) => r.dueOn)).toEqual(['2026-04-30', '2026-05-31', '2026-06-30']);
    expect((await withScope(scope(officer), (tx) => recurring.view(tx, officer, made.templateNo))).template.nextDueOn).toBeNull();
  });

  it('refuses to start unbalanced, fixes its lines once agreed, and pauses and ends with a reason', async () => {
    const made = await withScope(scope(officer), (tx) => recurring.create(tx, officer, { name: 'Subscription', frequency: 'quarterly', startsOn: '2026-01-15' }));
    await withScope(scope(officer), (tx) => recurring.addLine(tx, officer, made.id, { accountId: rentId, debit: '100', departmentCode: 'FIN' }));
    await withScope(scope(officer), (tx) => recurring.addLine(tx, officer, made.id, { accountId: accrualsId, credit: '90' }));
    expect(await rejection(withScope(scope(manager), (tx) => recurring.activate(tx, manager, made.id)))).toMatch(/does not balance/);
    await withScope(scope(officer), (tx) => recurring.addLine(tx, officer, made.id, { accountId: accrualsId, credit: '10' }));
    await withScope(scope(manager), (tx) => recurring.activate(tx, manager, made.id));

    expect(
      await rejection(withScope(scope(officer), (tx) => recurring.addLine(tx, officer, made.id, { accountId: rentId, debit: '1', departmentCode: 'FIN' }))),
    ).toMatch(/lines are fixed/);
    expect(await rejection(ownerPool.query(`delete from recurring_journal_line where recurring_journal_id = $1`, [made.id]))).toMatch(
      /change only while it is a draft/,
    );

    await withScope(scope(manager), (tx) => recurring.pause(tx, manager, made.id, 'Contract under review'));
    expect(await rejection(withScope(scope(officer), (tx) => recurring.raiseDue(tx, officer, made.id, '2026-12-31')))).toMatch(/is paused/);
    await withScope(scope(manager), (tx) => recurring.activate(tx, manager, made.id));
    const raised = await withScope(scope(officer), (tx) => recurring.raiseDue(tx, officer, made.id, '2026-07-31'));
    expect(raised.map((r) => r.dueOn)).toEqual(['2026-01-15', '2026-04-15', '2026-07-15']);

    expect(await rejection(withScope(scope(manager), (tx) => recurring.end(tx, manager, made.id, '')))).toMatch(/why it ends/);
    await withScope(scope(manager), (tx) => recurring.end(tx, manager, made.id, 'Cancelled'));
    expect(await rejection(ownerPool.query(`delete from recurring_journal where id = $1`, [made.id]))).toMatch(/never deleted/);

    const { rows: events } = await ownerPool.query(
      `select action from audit_event where object_type = 'recurring_journal' and object_id = $1 and outcome = 'success' order by occurred_at`,
      [made.id],
    );
    expect(events.map((e) => e.action)).toEqual([
      'recurring_journal.created',
      'recurring_journal.line_added',
      'recurring_journal.line_added',
      'recurring_journal.line_added',
      'recurring_journal.activated',
      'recurring_journal.paused',
      'recurring_journal.resumed',
      'recurring_journal.raised',
      'recurring_journal.raised',
      'recurring_journal.raised',
      'recurring_journal.ended',
    ]);
  });

  it('raises every active template due, and lists them with their stage', async () => {
    const rent = await rentTemplate();
    await withScope(scope(manager), (tx) => recurring.activate(tx, manager, rent.id));
    await withScope(scope(officer), (tx) => recurring.create(tx, officer, { name: 'Draft only', frequency: 'yearly', startsOn: '2026-12-31' }));

    const all = await withScope(scope(officer), (tx) => recurring.raiseAllDue(tx, officer, '2026-02-28'));
    expect(all.map((r) => [r.templateNo, r.dueOn])).toEqual([
      ['RJ-00001', '2026-01-31'],
      ['RJ-00001', '2026-02-28'],
    ]);
    const list = (view: recurring.RecurringView | null) =>
      withScope(scope(officer), (tx) => recurring.listForScreen(tx, officer, { view, asOf: '2026-03-31' }));
    expect((await list(null)).total).toBe(2);
    expect((await list('draft')).rows.map((r) => r.name)).toEqual(['Draft only']);
    expect((await list('due')).rows.map((r) => [r.templateNo, r.runs, r.totalIqd])).toEqual([['RJ-00001', 2, '2500000.0000']]);
  });

  it('prints with its lines and journals, and files the lease on it', async () => {
    registerAttachmentRuntime();
    const rent = await rentTemplate();
    await withScope(scope(manager), (tx) => recurring.activate(tx, manager, rent.id));
    await withScope(scope(officer), (tx) => recurring.raiseDue(tx, officer, rent.id, '2026-01-31'));
    const copy = await withScope(scope(officer), (tx) =>
      runExport(tx, officer, { key: 'recurring_journal', format: 'pdf', locale: 'en', at: '2026-02-01T09:00:00.000Z', input: { id: rent.templateNo, query: new URLSearchParams() } }),
    );
    expect(copy.status).toBe(200);
    if (copy.status === 200) {
      expect(copy.model.tables[0]!.rows).toHaveLength(2);
      expect(copy.model.tables[1]!.rows).toHaveLength(1);
    }
    const filed = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { objectType: recurring.DOCUMENT_TYPE, objectId: rent.id, fileName: 'lease.pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n') }),
    );
    expect(filed.quarantined).toBe(false);
  });
});
