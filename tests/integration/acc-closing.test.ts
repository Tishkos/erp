/**
 * Period / Year-End Closing — REQ-ACC-001 Part D-6.
 *
 * The screen adds no lock and no posting of its own: it closes through
 * `periods.setPeriodStatus` (which asks the checklist again) and reads the
 * history of every close from the trail that writes. No retained-earnings
 * roll (decided by default, owner to confirm): closing the year posts
 * nothing, so the protected statements read exactly as before.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ownerPool, rejection, resetTestData, seedBranch } from './setup';
import { withScope } from '@/server/db/client';
import * as authz from '@/server/services/authorization';
import * as periods from '@/server/services/periods';
import * as attachments from '@/server/services/attachments';
import * as recordNotes from '@/server/services/record-notes';
import { registerAttachmentRuntime } from '@/server/attachments-runtime';
import { runExport } from '@/server/print/export';
import { mayExport } from '@/server/print/access';
import type { ActorContext } from '@/server/services/chart-of-accounts';

const BAGHDAD = 'BGW';
let manager: ActorContext;
let officer: ActorContext;

async function createUser(role: string): Promise<ActorContext> {
  const id = randomUUID();
  await ownerPool.query(`insert into app_user (id, email, display_name) values ($1,$2,$3)`, [id, `${id}@example.com`, role]);
  await ownerPool.query(`insert into user_role (user_id, role_code) values ($1,$2)`, [id, role]);
  await ownerPool.query(`insert into user_branch_scope (user_id, branch_code) values ($1,$2)`, [id, BAGHDAD]);
  const principal = await withScope({ userId: id, branchCode: BAGHDAD }, (tx) => authz.loadPrincipal(tx, id));
  return { principal, branchCode: BAGHDAD };
}
const scope = (ctx: ActorContext) => ({ userId: ctx.principal.userId, branchCode: BAGHDAD });
const periodNamed = async (name: string) => (await ownerPool.query(`select id from fiscal_period where name = $1`, [name])).rows[0].id as string;

beforeEach(async () => {
  await resetTestData();
  await seedBranch(BAGHDAD, 'Baghdad');
  manager = await createUser('accounting_manager');
  officer = await createUser('accounting_officer');
  await withScope(scope(manager), (tx) => periods.createFiscalYear(tx, manager, { code: 'FY2026', startsOn: '2026-01-01', endsOn: '2026-12-31' }));
});

describe('Period / Year-End Closing', () => {
  it('keeps every close and reopening, newest first, with who, why and what it was closed over', async () => {
    const january = await periodNamed('January 2026');
    const february = await periodNamed('February 2026');
    await withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, january, 'soft_closed', 'Month-end review'));
    await withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, january, 'open', 'Late invoice'));
    await withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, january, 'closed', 'January agreed'));

    // In sequence: February cannot close before January — and January has.
    await withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, february, 'closed', 'February agreed'));

    const history = await withScope(scope(officer), (tx) => periods.closeHistory(tx, officer));
    expect(history.map((row) => [row.periodName, row.fromStatus, row.toStatus, row.reason])).toEqual([
      ['February 2026', 'open', 'closed', 'February agreed'],
      ['January 2026', 'open', 'closed', 'January agreed'],
      ['January 2026', 'soft_closed', 'open', 'Late invoice'],
      ['January 2026', 'open', 'soft_closed', 'Month-end review'],
    ]);
    // A hard close carries the warnings it was taken over (no bank reconciled, no rate…).
    expect(history[0]!.warnings.length).toBeGreaterThan(0);
    expect(history[0]!.actorName).toBe('accounting_manager');
  });

  it('closes nothing a reason or the lock refuses, and posts no journal of its own', async () => {
    const march = await periodNamed('March 2026');
    expect(await rejection(withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, march, 'closed', 'Skip ahead')))).toMatch(
      /sequence|earlier|January/i,
    );
    expect(await rejection(withScope(scope(officer), (tx) => periods.setPeriodStatus(tx, officer, march, 'soft_closed', 'x')))).toMatch(
      /permission|denied|not permitted/i,
    );
    const { rows } = await ownerPool.query(`select count(*)::int as n from journal_entry`);
    expect(rows[0].n).toBe(0);
  });

  it('the period is a record: its checklist prints, its papers and notes are filed on it, its history is the trail’s', async () => {
    registerAttachmentRuntime();
    const january = await periodNamed('January 2026');
    await withScope(scope(manager), (tx) => periods.setPeriodStatus(tx, manager, january, 'closed', 'January agreed'));

    // Printer — the checklist and this period's closes, for whoever reads the trial balance.
    expect(mayExport(officer.principal, 'period_close', 'pdf')).toBe(true);
    const copy = await withScope(scope(officer), (tx) =>
      runExport(tx, officer, { key: 'period_close', format: 'pdf', locale: 'en', at: '2026-02-01T09:00:00.000Z', input: { id: january, query: new URLSearchParams() } }),
    );
    expect(copy.status).toBe(200);
    if (copy.status === 200) {
      expect(copy.model.number).toBe('January 2026 · FY2026');
      expect(copy.model.tables[0]!.rows.length).toBeGreaterThan(5);
      expect(copy.model.tables[1]!.rows.map((row) => row.cells.change)).toEqual(['Open → Closed']);
    }
    const missing = await withScope(scope(officer), (tx) =>
      runExport(tx, officer, { key: 'period_close', format: 'pdf', locale: 'en', at: '2026-02-01T09:00:00.000Z', input: { id: randomUUID(), query: new URLSearchParams() } }),
    );
    expect(missing.status).toBe(404);

    // Paperclip — the sign-off, on the period itself, for whoever reads periods.
    const filed = await withScope(scope(officer), (tx) =>
      attachments.upload(tx, officer, { objectType: 'fiscal_period', objectId: january, fileName: 'signoff.pdf', content: Buffer.from('%PDF-1.4\n%%EOF\n') }),
    );
    expect(filed.quarantined).toBe(false);

    // Notes — by whoever may close periods; read by whoever may see them.
    await withScope(scope(manager), (tx) => recordNotes.addNote(tx, manager, { object: 'fiscal_period', recordId: january, body: 'Closed over the bank warning; statement due Monday' }));
    expect(recordNotes.mayAddNote(officer.principal, 'fiscal_period')).toBe(false);
    const read = await withScope(scope(officer), (tx) => recordNotes.listNotes(tx, { object: 'fiscal_period', recordId: january }));
    expect(read.map((n) => n.body)).toEqual(['Closed over the bank warning; statement due Monday']);
  });
});
